const jsonPath = require('./json-path')
const utils = require('../utils/utils')
const EventEmitter = require('component-emitter2')
const C = require('../constants/constants')
const messageParser = require('../message/message-parser')
const xuid = require('xuid')
const invariant = require('invariant')

class Record extends EventEmitter {
  static STATE = C.RECORD_STATE

  constructor(name, handler) {
    super()

    this._handler = handler
    this._prune = handler._prune
    this._client = handler._client
    this._connection = handler._connection

    this._pending = handler._pending
    this._updating = null

    this._name = name
    this._version = ''
    this._data = jsonPath.EMPTY
    this._state = Record.STATE.VOID
    this._usages = 1
    this._subscribed = false

    this._patches = null

    this._subscribe()
  }

  get name() {
    return this._name
  }

  get version() {
    return this._version || null
  }

  get data() {
    return this._data
  }

  get state() {
    return this._state
  }

  get(path) {
    invariant(this._usages > 0, this._name + ' missing refs')

    return jsonPath.get(this._data, path)
  }

  set(pathOrData, dataOrNil) {
    invariant(this._usages > 0, this._name + ' missing refs')

    if (this._version.charAt(0) === 'I' || this._name.startsWith('_')) {
      this._error(C.EVENT.USER_ERROR, 'cannot set')
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

    const prevData = this._data
    const prevVersion = this._version
    const prevState = this._state

    if (this._state < Record.STATE.SERVER) {
      this._patches = this._patches && path ? this._patches : []
      this._patches.push(path, jsonPath.jsonClone(data))
      this._pending.add(this)

      this._version = this._makeVersion(this._version ? parseInt(this._version) + 1 : 1)
      this._data = jsonPath.set(this._data, path, data, true)
      this._state = this._data === jsonPath.EMPTY ? Record.STATE.EMPTY : Record.STATE.CLIENT
    } else {
      this._update(path, data)
    }

    if (this._data !== prevData || this._version !== prevVersion || this._state !== prevState) {
      this.emit('update', this)
    }
  }

  when(stateOrNull) {
    invariant(this._usages > 0, this._name + ' missing refs')

    const state = stateOrNull == null ? Record.STATE.SERVER : stateOrNull

    if (!Number.isFinite(state) || state < 0) {
      throw new Error('invalid argument: state')
    }

    return new Promise((resolve, reject) => {
      if (this._state >= state) {
        resolve(null)
        return
      }

      const onUpdate = () => {
        if (this._state < state) {
          return
        }

        // clearTimeout(timeout)

        this.off('update', onUpdate)
        this.unref()

        resolve(null)
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

  update(pathOrUpdater, updaterOrNil) {
    invariant(this._usages > 0, this._name + ' missing refs')

    if (this._version.charAt(0) === 'I') {
      this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot update', [
        this._name,
        this._version,
        this._state,
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
        const next = updater(prev, this._version)
        this.set(path, next)
      })
      .finally(() => {
        this.unref()
      })
  }

  ref() {
    this._usages += 1
    if (this._usages === 1) {
      this._prune.delete(this)
      this._subscribe()
    }
  }

  unref() {
    invariant(this._usages > 0, this._name + ' missing refs')

    this._usages -= 1
    if (this._usages === 0) {
      this._prune.set(this, this._handler._now)
    }
  }

  _$onMessage(message) {
    invariant(this._connection.connected, this._name + ' must be connected')

    if (message.action === C.ACTIONS.UPDATE) {
      this._onUpdate(message.data)
    } else if (message.action === C.ACTIONS.SUBSCRIPTION_HAS_PROVIDER) {
      this._onSubscriptionHasProvider(message.data)
    } else {
      return false
    }

    return true
  }

  _$onConnectionStateChange() {
    if (this._connection.connected) {
      if (this._usages > 0) {
        this._subscribe()
      }

      if (this._updating) {
        for (const update of this._updating.values()) {
          this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, update)
        }
      }
    } else {
      this._subscribed = false
    }

    if (this._state >= Record.STATE.SERVER) {
      this._state = this._data === jsonPath.EMPTY ? Record.STATE.EMPTY : Record.STATE.CLIENT
    }

    this.emit('update', this)
  }

  _$destroy() {
    invariant(!this._usages, this._name + ' must not have refs')
    invariant(!this._patches, this._name + ' must not have patch queue')

    if (this._subscribed && this._connection.connected) {
      this._connection.sendMsg1(C.TOPIC.RECORD, C.ACTIONS.UNSUBSCRIBE, this._name)
      this._subscribed = false
    }

    if (this._state >= Record.STATE.SERVER) {
      this._state = this._data === jsonPath.EMPTY ? Record.STATE.EMPTY : Record.STATE.CLIENT
    }

    return this
  }

  _subscribe() {
    invariant(this._usages, this._name + ' missing refs')

    if (!this._subscribed && this._connection.connected) {
      if (this._patches) {
        this._connection.sendMsg1(C.TOPIC.RECORD, C.ACTIONS.SUBSCRIBE, this._name)
      } else {
        this._connection.sendMsg2(C.TOPIC.RECORD, C.ACTIONS.SUBSCRIBE, this._name, this._version)
      }
      this._subscribed = true
    }
  }

  _update(path, data) {
    invariant(this._version, this._name + ' missing version')
    invariant(this._data, this._name + ' missing data')

    const prevData = this._data
    const nextData = jsonPath.set(prevData, path, data, true)

    if (nextData !== prevData) {
      const prevVersion = this._version
      const nextVersion = this._makeVersion(parseInt(prevVersion) + 1)

      const update = [this._name, nextVersion, JSON.stringify(nextData), prevVersion]

      this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, update)

      this._updating ??= new Map()
      this._updating.set(nextVersion, update)
    }
  }

  _onUpdate(message) {
    const [, version, data] = message

    try {
      if (!version) {
        throw new Error('missing version')
      }

      const prevData = this._data
      const prevVersion = this._version

      if (this._updating?.delete(version) && this._updating.size === 0) {
        this._updating = null
      }

      if (
        this._state < Record.STATE.SERVER ||
        version.charAt(0) === 'I' ||
        utils.compareRev(version, this._version) > 0
      ) {
        if (data === '{}') {
          this._data = jsonPath.EMPTY_OBJ
        } else if (data === '[]') {
          this._data = jsonPath.EMPTY_ARR
        } else {
          this._data = jsonPath.set(this._data, null, JSON.parse(data), true)
        }
        this._version = version
      }

      invariant(this._version, this._name + ' missing version')
      invariant(this._data, this._name + ' missing data')

      if (this._patches) {
        if (this._version.charAt(0) !== 'I') {
          for (let i = 0; i < this._patches.length; i += 2) {
            this._update(this._patches[i + 0], this._patches[i + 1])
          }
        } else if (this._patches.length) {
          this._error(C.EVENT.USER_ERROR, 'cannot patch provided value')
        }

        this._patches = null
        this._pending.delete(this)
      }

      if (this._state < Record.STATE.SERVER) {
        this._state = this._version.charAt(0) === 'I' ? Record.STATE.STALE : Record.STATE.SERVER
        this.emit('ready')
      }

      if (this._version !== prevVersion || this._data !== prevData) {
        this.emit('update', this)
      }
    } catch (err) {
      this._error(C.EVENT.UPDATE_ERROR, err, message)
    }
  }

  _onSubscriptionHasProvider(message) {
    invariant(this._version, this._name + ' missing version')
    invariant(this._data, this._name + ' missing data')

    const provided = Boolean(message[1] && messageParser.convertTyped(message[1], this._client))
    const state = provided
      ? Record.STATE.PROVIDER
      : this._version.charAt(0) === 'I'
      ? Record.STATE.STALE
      : Record.STATE.SERVER

    if (this._state !== state) {
      this._state = state
      this.emit('update', this)
    }
  }

  _error(event, msgOrError, data) {
    this._client._$onError(C.TOPIC.RECORD, event, msgOrError, [
      ...(Array.isArray(data) ? data : []),
      this._name,
      this._version,
      this._state,
    ])
  }

  _makeVersion(start) {
    let revid = `${xuid()}-${this._client.user || ''}`
    if (revid.length === 32 || revid.length === 16) {
      // HACK: https://github.com/apache/couchdb/issues/2015
      revid += '-'
    }
    return `${start}-${revid}`
  }
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
    return this._state >= Record.STATE.SERVER
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
    return this._state >= Record.STATE.SERVER
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'hasProvider', {
  get: function hasProvider() {
    return this.state >= C.RECORD_STATE.PROVIDER
  },
})

module.exports = Record
