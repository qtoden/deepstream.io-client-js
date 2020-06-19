const jsonPath = require('./json-path')
const utils = require('../utils/utils')
const EventEmitter = require('component-emitter2')
const C = require('../constants/constants')
const messageParser = require('../message/message-parser')
const xuid = require('xuid')
const lz = require('@nxtedition/lz-string')
const invariant = require('invariant')

const Record = function (handler) {
  this._handler = handler
  this._stats = handler._stats
  this._prune = handler._prune
  this._pending = handler._pending
  this._cache = handler._cache
  this._client = handler._client
  this._connection = handler._connection

  this._reset()
}

Record.STATE = C.RECORD_STATE

EventEmitter(Record.prototype)

Record.prototype._reset = function () {
  this.name = null
  this.version = null
  this.data = jsonPath.EMPTY

  // TODO (fix): Make private
  this._$usages = 0
  this._$pruneTimestamp = null

  this._provided = null
  this._dirty = true
  this._patchQueue = []
  this.off()
}

Record.prototype._$construct = function (name) {
  if (this._$usages !== 0) {
    throw new Error('invalid operation: cannot construct referenced record')
  }

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('invalid argument: name')
  }

  this.name = name

  this._pending.add(this)

  this.ref()
  this._cache.get(this.name, (err, entry) => {
    this.unref()

    if (err && !err.notFound) {
      this._stats.misses += 1
      this._client._$onError(C.TOPIC.RECORD, C.EVENT.CACHE_ERROR, err, [ this.name, this.version, this.state ])
    } else if (entry) {
      this._stats.hits += 1

      const [ version, data ] = entry

      // TODO (fix): What if version is newer than this.version?
      if (!this.version) {
        this.data = utils.deepFreeze(Object.keys(data).length === 0 ? jsonPath.EMPTY : data)
        this._dirty = false
        this.version = version
        this.emit('update', this)
      }
    }

    if (this.connected) {
      this._connection.sendMsg2(C.TOPIC.RECORD, C.ACTIONS.READ, this.name, this.version || '')
    }
  })
  this._stats.reads += 1

  return this
}

Record.prototype._$destroy = function () {
  invariant(this.version, 'must have version to destroy')
  invariant(this.isReady, 'must be ready to destroy')

  if (this._dirty) {
    this._cache.set(this.name, this.version, this.data)
  }

  // TODO (fix): Ensure unsubscribe is acked.
  this._connection.sendMsg1(C.TOPIC.RECORD, C.ACTIONS.UNSUBSCRIBE, this.name)

  this._prune.delete(this)
  this._pending.delete(this)
  this._reset()

  return this
}

Object.defineProperty(Record.prototype, 'state', {
  enumerable: true,
  get: function state () {
    if (!this.version) {
      return Record.STATE.VOID
    }

    if (!this.connected || this._patchQueue) {
      return Record.STATE.CLIENT
    }

    if (this._provided && utils.isSameOrNewer(this.version, this._provided)) {
      return Record.STATE.PROVIDER
    }

    return Record.STATE.SERVER
  }
})

Record.prototype.get = function (path) {
  return jsonPath.get(this.data, path)
}

Record.prototype._makeVersion = function (start) {
  let revid = `${xuid()}-${this._client.user || ''}`
  if (revid.length === 32 || revid.length === 16) {
    // HACK: https://github.com/apache/couchdb/issues/2015
    revid += '-'
  }
  return `${start}-${revid}`
}

Record.prototype.set = function (pathOrData, dataOrNil) {
  if (this._$usages === 0 || this._provided) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot set record', [ this.name, this.version, this.state ])
    return Promise.resolve()
  }

  if (this.version && this.version.startsWith('INF')) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot set record', [ this.name, this.version, this.state ])
    return Promise.resolve()
  }

  if (this.name.startsWith('_')) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot set record', [ this.name, this.version, this.state ])
    return Promise.resolve()
  }

  let path = arguments.length === 1 ? undefined : pathOrData
  let data = arguments.length === 1 ? pathOrData : dataOrNil

  if (path === undefined && !utils.isPlainObject(data)) {
    throw new Error('invalid argument: data')
  }
  if (path === undefined && Object.keys(data).some(prop => prop.startsWith('_'))) {
    throw new Error('invalid argument: data')
  }
  if (path !== undefined && (typeof path !== 'string' || path.length === 0 || path.startsWith('_'))) {
    throw new Error('invalid argument: path')
  }

  // TODO (perf): Avoid clone
  const jsonData = jsonPath.jsonClone(data)

  const newData = jsonPath.set(this.data, path, jsonData, true)

  if (this._patchQueue) {
    this._patchQueue = path ? this._patchQueue : []
    this._patchQueue.push(path, jsonData)
  }

  if (newData === this.data) {
    return Promise.resolve()
  }

  this.data = utils.deepFreeze(newData)
  this._dirty = true

  if (!this._patchQueue) {
    this._sendUpdate()
  } else {
    const [ start ] = this.version ? this.version.split('-') : [ '0' ]
    this.version = this._makeVersion(start)
  }

  this._handler._syncCount += 1
  this.emit('update', this)
  this._handler._syncCount -= 1

  return this.isReady
    ? Promise.resolve()
    : new Promise(resolve => this.once('ready', resolve))
}

Record.prototype.update = function (pathOrUpdater, updaterOrNil) {
  if (this._$usages === 0 || this._provided) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot update record', [ this.name, this.version, this.state ])
    return Promise.resolve()
  }

  if (this.version && this.version.startsWith('INF')) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot update record', [ this.name, this.version, this.state ])
    return Promise.resolve()
  }

  const path = arguments.length === 1 ? undefined : pathOrUpdater
  const updater = arguments.length === 1 ? pathOrUpdater : updaterOrNil

  if (typeof updater !== 'function') {
    throw new Error('invalid argument: updater')
  }

  if (path !== undefined && (typeof path !== 'string' || path.length === 0)) {
    throw new Error('invalid argument: path')
  }

  const doUpdate = () => {
    try {
      const prev = this.get(path)
      const next = updater(prev)
      this.set(path, next)
    } catch (err) {
      this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, err, [ this.name, this.version, this.state ])
    }
    this.unref()
  }

  this.ref()
  if (this.isReady) {
    doUpdate()
  } else {
    this.once('ready', doUpdate)
  }

  return this.isReady
    ? Promise.resolve()
    : new Promise(resolve => this.once('ready', resolve))
}

Record.prototype.ref = function () {
  this._$usages += 1

  if (this._$usages === 1) {
    this._$pruneTimestamp = null
    this._prune.delete(this)
  }
}

Record.prototype.unref = function () {
  this._$usages = Math.max(0, this._$usages - 1)

  if (this._$usages === 0) {
    this._$pruneTimestamp = Date.now()
    this._prune.add(this)
  }
}

Record.prototype._$onMessage = function (message) {
  if (message.action === C.ACTIONS.UPDATE) {
    this._onUpdate(message.data)
  } else if (message.action === C.ACTIONS.SUBSCRIPTION_HAS_PROVIDER) {
    this._onSubscriptionHasProvider(message.data)
  }
}

Record.prototype._onSubscriptionHasProvider = function (data) {
  const provided = messageParser.convertTyped(data[1], this._client) || null

  if (this._provided !== provided) {
    invariant(provided && typeof provided === 'string', 'provided must be a version string')
    this._provided = provided
    this.emit('update', this)
  }
}

Record.prototype._onReady = function () {
  this._patchQueue = null
  this._pending.delete(this)
  this.emit('ready')
  this.emit('update', this)
}

Record.prototype._onUpdate = function ([name, version, data]) {
  if (!version) {
    const err = new Error('missing version')
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, err, [ this.name, this.version ])
    return
  }

  const compare = utils.compareRev(this.version, version)

  if (compare >= 0) {
    if (!this._patchQueue) {
      return
    } else if (this.version.startsWith('INF')) {
      this._onReady()
      return
    }

    if (compare === 0) {
      data = this.data
    }
  }

  if (!data) {
    // Can occur if we receive a buffered message from previous subscription?
    const err = new Error('missing data')
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, err, [ this.name, this.version ])
    return
  }

  try {
    data = typeof data === 'string' ? JSON.parse(lz.decompressFromUTF16(data)) : data
  } catch (err) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.LZ_ERROR, err, [ this.name, this.version, this.state, version, data ])
    return
  }

  const oldValue = this.data

  this.version = version
  this.data = data = jsonPath.set(this.data, null, data, true)

  if (this._patchQueue) {
    if (!this.version.startsWith('INF')) {
      for (let i = 0; i < this._patchQueue.length; i += 2) {
        this.data = jsonPath.set(this.data, this._patchQueue[i + 0], this._patchQueue[i + 1], true)
      }
      if (this.data !== data) {
        this._sendUpdate()
      }
    }

    if (this.data !== oldValue) {
      this.data = utils.deepFreeze(this.data)
      this._dirty = true
    }

    this._onReady()
  } else if (this.data !== oldValue) {
    this.data = utils.deepFreeze(this.data)
    this._dirty = true

    this.emit('update', this)
  }
}

Record.prototype._sendUpdate = function () {
  let [ start ] = this.version ? this.version.split('-') : [ '0' ]

  if (start === 'INF' || this._provided) {
    return
  }

  start = parseInt(start, 10)
  start = start >= 0 ? start : 0

  const nextVersion = this._makeVersion(start + 1)
  const prevVersion = this.version || ''

  let body
  try {
    body = lz.compressToUTF16(JSON.stringify(this.data))
  } catch (err) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.LZ_ERROR, err, [ this.name, this.version, this.state, nextVersion ])
    return
  }

  this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [
    this.name,
    nextVersion,
    body,
    prevVersion,
  ])

  this.version = nextVersion
}

Record.prototype._$handleConnectionStateChange = function () {
  this._provided = null

  if (this.connected) {
    this._connection.sendMsg2(C.TOPIC.RECORD, C.ACTIONS.READ, this.name, this.version || '')
  }

  this.emit('update', this)
}

// Compat

Record.prototype.acquire = Record.prototype.ref
Record.prototype.discard = Record.prototype.unref
Record.prototype.destroy = Record.prototype.unref

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'connected', {
  get: function connected () {
    return this._client.getConnectionState() === C.CONNECTION_STATE.OPEN
  }
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'empty', {
  get: function empty () {
    return Object.keys(this.data).length === 0
  }
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'ready', {
  get: function ready () {
    return !this._patchQueue
  }
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'provided', {
  get: function provided () {
    return this._provided && utils.isSameOrNewer(this.version, this._provided)
  }
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'usages', {
  get: function provided () {
    return this._$usages
  }
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'stale', {
  get: function ready () {
    return !this.version
  }
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'isReady', {
  get: function isReady () {
    return !this._patchQueue
  }
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'hasProvider', {
  get: function hasProvider () {
    return this.provided
  }
})

module.exports = Record
