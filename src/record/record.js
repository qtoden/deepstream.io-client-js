const jsonPath = require('./json-path')
const utils = require('../utils/utils')
const EventEmitter = require('component-emitter2')
const C = require('../constants/constants')
const messageParser = require('../message/message-parser')
const xuid = require('xuid')
const invariant = require('invariant')

const EMPTY_ENTRY = utils.deepFreeze([null, null])

const Record = function (name, handler) {
  this._handler = handler
  this._stats = handler._stats
  this._prune = handler._prune
  this._pendingWrite = handler._pendingWrite
  this._cache = handler._cache
  this._client = handler._client
  this._connection = handler._connection

  this.version = null
  this.data = jsonPath.EMPTY

  this._name = name
  this._subscribed = false
  this._provided = null
  this._dirty = false
  this._entry = EMPTY_ENTRY
  this._patchQueue = []
  this._patchData = null
  this._usages = 1 // Start with 1 for cache unref without subscribe.
  this._cache.get(this.name, (err, entry) => {
    this.unref()

    if (err && (err.notFound || /notfound/i.test(err))) {
      err = null
      entry = null
    }

    if (err) {
      this._client._$onError(C.TOPIC.RECORD, C.EVENT.CACHE_ERROR, err, [
        this.name,
        this.version,
        this.state,
      ])
    } else if (entry) {
      invariant(
        typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object',
        'entry must be [string, object]'
      )

      this._stats.hits += 1

      if (Object.keys(entry[1]).length === 0) {
        entry[1] = Array.isArray(entry[1]) ? jsonPath.EMPTY_ARR : jsonPath.EMPTY_OBJ
      }

      if (this._patchQueue && this._patchQueue.length && entry[0].charAt(0) === 'I') {
        this._onError(C.EVENT.USER_ERROR, 'cannot patch provided value')
        this._patchQueue = []
        this._patchData = null
      }

      this._entry = entry

      this._apply()
    } else {
      this._stats.misses += 1
    }

    this._subscribe()
  })
  this._stats.reads += 1
}

Record.STATE = C.RECORD_STATE

EventEmitter(Record.prototype)

Record.prototype._$destroy = function () {
  invariant(this._usages === 0, 'must have no refs')
  invariant(this.version, 'must have version to destroy')
  invariant(this.isReady, 'must be ready to destroy')
  invariant(!this._patchQueue, 'must not have patch queue')

  if (this._subscribed) {
    this._connection.sendMsg1(C.TOPIC.RECORD, C.ACTIONS.UNSUBSCRIBE, this.name)
    this._subscribed = false
  }

  this._provided = null
  this._patchQueue = this._patchQueue || []

  return this
}

Record.prototype._apply = function (ready) {
  let version = this._entry[0]
  let data = this._entry[1]

  if (!data) {
    data = jsonPath.EMPTY
  }

  if (this._patchQueue && this._patchQueue.length) {
    if (version.charAt(0) !== 'I') {
      const start = this.version ? parseInt(version) : 0
      version = this._makeVersion(start + this._patchQueue.length)
    }

    for (let i = 0; i < this._patchQueue.length; i += 2) {
      data = jsonPath.set(data, this._patchQueue[i + 0], this._patchQueue[i + 1], true)
    }
  }

  this.data = data
  this.version = version

  if (ready) {
    this.emit('ready')
  }

  this.emit('update', this)
}

Object.defineProperty(Record.prototype, 'name', {
  enumerable: true,
  get: function name() {
    return this._name
  },
})

Object.defineProperty(Record.prototype, 'state', {
  enumerable: true,
  get: function state() {
    if (!this.version) {
      return Record.STATE.VOID
    }

    if (this._patchQueue) {
      return this.version.charAt(0) === '0' ? Record.STATE.EMPTY : Record.STATE.CLIENT
    }

    if (this._provided) {
      return Record.STATE.PROVIDER
    }

    if (this.version.charAt(0) === 'I') {
      return Record.STATE.STALE
    }

    return Record.STATE.SERVER
  },
})

Record.prototype.get = function (path) {
  invariant(this._usages > 0, 'must have refs')

  return jsonPath.get(this.data, path)
}

Record.prototype.set = function (pathOrData, dataOrNil) {
  invariant(this._usages > 0, 'must have refs')

  if (
    this._usages === 0 ||
    this._provided ||
    (this.version && this.version.charAt(0) === 'I') ||
    this.name.startsWith('_')
  ) {
    this._onError(C.EVENT.USER_ERROR, 'cannot set')
    return
  }

  const path = arguments.length === 1 ? undefined : pathOrData
  const data = arguments.length === 1 ? pathOrData : dataOrNil

  if (path === undefined && !utils.isPlainObject(data)) {
    throw new Error('invalid argument: data')
  }
  if (path === undefined && Object.keys(data).some((prop) => prop.startsWith('_'))) {
    throw new Error('invalid argument: data')
  }
  if (
    path !== undefined &&
    (typeof path !== 'string' || path.length === 0 || path.startsWith('_')) &&
    (!Array.isArray(path) || path.length === 0 || path[0].startsWith('_'))
  ) {
    throw new Error('invalid argument: path')
  }

  // TODO (perf): Avoid clone
  const jsonData = jsonPath.jsonClone(data)

  if (this._patchQueue) {
    this._patchQueue = path ? this._patchQueue : []
    this._patchQueue.push(path, jsonData)

    if (!this._pendingWrite.has(this)) {
      this.ref()
      this._pendingWrite.add(this)
    }
  } else if (!this._update(path, jsonData, jsonData)) {
    return
  }

  this._apply()
}

Record.prototype.when = function (stateOrNull) {
  invariant(this._usages > 0, 'must have refs')

  const state = stateOrNull == null ? Record.STATE.SERVER : stateOrNull

  if (!Number.isFinite(state) || state < 0) {
    throw new Error('invalid argument: state')
  }

  return new Promise((resolve, reject) => {
    if (this.state >= state) {
      resolve()
      return
    }

    const onUpdate = () => {
      if (this.state < state) {
        return
      }

      // clearTimeout(timeout)

      this.off('update', onUpdate)
      this.unref()

      resolve()
    }

    // const timeout = setTimeout(() => {
    //   this.off('update', onUpdate)
    //   this.unref()

    //   reject(new Error('when timeout'))
    // }, 2 * 60e3)

    this.ref()
    this.on('update', onUpdate)
  })
}

Record.prototype.update = function (pathOrUpdater, updaterOrNil) {
  invariant(this._usages > 0, 'must have refs')

  if (this._usages === 0 || this._provided) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot update', [
      this.name,
      this.version,
      this.state,
    ])
    return Promise.resolve()
  }

  if (this.version && this.version.charAt(0) === 'I') {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot update', [
      this.name,
      this.version,
      this.state,
    ])
    return Promise.resolve()
  }

  const path = arguments.length === 1 ? undefined : pathOrUpdater
  const updater = arguments.length === 1 ? pathOrUpdater : updaterOrNil

  if (typeof updater !== 'function') {
    throw new Error('invalid argument: updater')
  }

  if (
    path !== undefined &&
    (typeof path !== 'string' || path.length === 0 || path.startsWith('_')) &&
    (!Array.isArray(path) || path.length === 0 || path[0].startsWith('_'))
  ) {
    throw new Error('invalid argument: path')
  }

  this.ref()
  return this.when(Record.STATE.SERVER)
    .then(() => {
      const prev = this.get(path)
      const next = updater(prev, this.version)
      this.set(path, next)
    })
    .finally(() => {
      this.unref()
    })
}

Record.prototype.ref = function () {
  this._usages += 1
  if (this._usages === 1) {
    this._prune.delete(this)
    this._subscribe()
  }
}

Record.prototype.unref = function () {
  invariant(this._usages > 0, 'must have refs')

  this._usages -= 1
  if (this._usages === 0) {
    this._prune.set(this, this._handler._now)
  }
}

Record.prototype._$onMessage = function (message) {
  if (!this.connected) {
    this._onError(C.EVENT.NOT_CONNECTED, 'received message while not connected')
    return
  }

  if (message.action === C.ACTIONS.UPDATE) {
    this._onUpdate(message.data)
  } else if (message.action === C.ACTIONS.SUBSCRIPTION_HAS_PROVIDER) {
    this._onSubscriptionHasProvider(message.data)
  } else {
    return false
  }

  return true
}

Record.prototype._onSubscriptionHasProvider = function (data) {
  invariant(this.connected, 'must be connected')

  const provided = Boolean(data[1] && messageParser.convertTyped(data[1], this._client))

  if (Boolean(this._provided) === Boolean(provided)) {
    return
  }

  this._provided = provided

  this._apply()
}

Record.prototype._update = function (path, data) {
  invariant(this._entry[0], '_update must have version')
  invariant(this._entry[1], '_update must have data')

  const prevData = this._entry[1]
  const nextData = jsonPath.set(prevData, path, data, true)

  if (nextData === prevData) {
    return false
  }

  const prevVersion = this._entry[0]
  const nextVersion = this._makeVersion(parseInt(prevVersion) + 1)

  this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [
    this.name,
    nextVersion,
    JSON.stringify(nextData),
    prevVersion,
  ])

  this._entry = [nextVersion, nextData]
  this._dirty = true

  return true
}

Record.prototype._onUpdate = function ([name, version, data]) {
  invariant(this.connected, 'must be connected')

  try {
    if (!version) {
      throw new Error('missing version')
    }

    const prevData = this.data
    const prevVersion = this.version

    if (
      version !== this._entry[0] &&
      (!this._entry[0] || this._entry[0].charAt(0) !== 'I' || version.charAt(0) === 'I')
    ) {
      // TODO (fix): state STALE

      if (data === '{}') {
        data = jsonPath.EMPTY
      } else if (this._entry) {
        data = jsonPath.set(this._entry[1], null, JSON.parse(data), true)
      } else {
        data = JSON.parse(data)
      }

      this._entry = [version, data]
      this._dirty = true
    }

    invariant(this._entry[0], 'missing version')
    invariant(this._entry[1], 'missing data')

    if (this._patchQueue) {
      if (this._entry[0].charAt(0) !== 'I') {
        for (let i = 0; i < this._patchQueue.length; i += 2) {
          this._update(this._patchQueue[i + 0], this._patchQueue[i + 1])
        }
      } else if (this._patchQueue.length) {
        this._onError(C.EVENT.USER_ERROR, 'cannot patch provided value')
      }

      this._patchQueue = null
      this._patchData = null

      if (this._pendingWrite.delete(this)) {
        this.unref()
      }

      this._apply(true)
    } else if (this.version !== prevVersion || this.data !== prevData) {
      this._apply()
    }
  } catch (err) {
    this._onError(C.EVENT.UPDATE_ERROR, err, [this.name, version, data])
  }
}

Record.prototype._subscribe = function () {
  if (!this.connected || this._subscribed || this._usages === 0) {
    return
  }

  // TODO (fix): Limit number of reads.

  if (this._entry[0]) {
    this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.READ, [this.name, this._entry[0]])
  } else {
    this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.READ, [this.name])
  }

  this._subscribed = true
}

Record.prototype._$handleConnectionStateChange = function () {
  if (this.connected) {
    this._subscribe()
  } else {
    this._subscribed = false
    this._provided = null
    this._patchQueue = this._patchQueue || []
  }

  this._apply()
}

Record.prototype._onError = function (event, msgOrError, data) {
  this._client._$onError(C.TOPIC.RECORD, event, msgOrError, [
    ...(Array.isArray(data) ? data : []),
    this.name,
    this.version,
    this.state,
  ])
}

Record.prototype._makeVersion = function (start) {
  let revid = `${xuid()}-${this._client.user || ''}`
  if (revid.length === 32 || revid.length === 16) {
    // HACK: https://github.com/apache/couchdb/issues/2015
    revid += '-'
  }
  return `${start}-${revid}`
}

// Compat

Record.prototype.acquire = Record.prototype.ref
Record.prototype.discard = Record.prototype.unref
Record.prototype.destroy = Record.prototype.unref

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'connected', {
  get: function connected() {
    return this._client.getConnectionState() === C.CONNECTION_STATE.OPEN
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'empty', {
  get: function empty() {
    return Object.keys(this.data).length === 0
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'ready', {
  get: function ready() {
    return !this._patchQueue
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'provided', {
  get: function provided() {
    return this.state >= C.RECORD_STATE.PROVIDER
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'usages', {
  get: function usages() {
    return this._usages
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'stale', {
  get: function ready() {
    return !this.version
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'isReady', {
  get: function isReady() {
    return !this._patchQueue
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'hasProvider', {
  get: function hasProvider() {
    return this.state >= C.RECORD_STATE.PROVIDER
  },
})

module.exports = Record
