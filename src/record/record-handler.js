const Record = require('./record')
const Listener = require('../utils/listener')
const C = require('../constants/constants')
const { Observable } = require('rxjs/Observable')
const LRU = require('lru-cache')
const invariant = require('invariant')

const RecordHandler = function (options, connection, client) {
  this._options = options
  this._connection = connection
  this._client = client
  this._records = new Map()
  this._listeners = new Map()
  this._cache = new LRU({ max: options.cacheSize || 512 })
  this._prune = new Map()

  setInterval(() => {
    let now = Date.now()

    for (const [ record, timestamp ] of this._prune) {
      if (
        record.usages === 0 &&
        record.isReady &&
        now - timestamp > 2000
      ) {
        this._prune.delete(record)
        this._records.delete(record.name)
        record._$destroy()
      }
    }
  }, 2000)
}

RecordHandler.prototype.getRecord = function (name) {
  invariant(typeof name === 'string' && name.length > 0 && !name.includes('[object Object]'), `invalid name ${name}`)

  let record = this._records.get(name)

  if (!record) {
    record = new Record(
      name,
      this._connection,
      this._client,
      this._cache,
      this._prune
    )
    this._records.set(name, record)
  }

  record.acquire()

  return record
}

RecordHandler.prototype.provide = function (pattern, callback, recursive = false) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('invalid argument pattern')
  }
  if (typeof callback !== 'function') {
    throw new Error('invalid argument callback')
  }

  if (this._listeners.has(pattern)) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.LISTENER_EXISTS, pattern)
    return
  }

  const listener = new Listener(
    C.TOPIC.RECORD,
    pattern,
    callback,
    this._options,
    this._client,
    this._connection,
    this,
    recursive
  )

  this._listeners.set(pattern, listener)
  return () => {
    listener._$destroy()
    this._listeners.delete(pattern)
  }
}

RecordHandler.prototype.get = function (name, pathOrNil) {
  const record = this.getRecord(name)
  return record
    .whenReady()
    .then(() => record.get(pathOrNil))
    .then(val => {
      record.discard()
      return val
    })
    .catch(err => {
      record.discard()
      throw err
    })
}

RecordHandler.prototype.set = function (name, pathOrData, dataOrNil) {
  const record = this.getRecord(name)
  const promise = arguments.length === 2
    ? record.set(pathOrData)
    : record.set(pathOrData, dataOrNil)
  record.discard()
  return promise
}

RecordHandler.prototype.update = function (name, pathOrUpdater, updaterOrNil) {
  const path = arguments.length === 2 ? undefined : pathOrUpdater
  const updater = arguments.length === 2 ? pathOrUpdater : updaterOrNil

  const record = this.getRecord(name)
  return record
    .whenReady()
    .then(() => updater(record.get(path)))
    .then(val => {
      if (path) {
        record.set(path, val)
      } else {
        record.set(val)
      }
      record.discard()
      return val
    })
    .catch(err => {
      record.discard()
      throw err
    })
}

RecordHandler.prototype.observe = function (name) {
  return Observable
    .create(o => {
      try {
        const record = this.getRecord(name)
        const onValue = value => o.next(value)
        record.subscribe(onValue, true)
        return () => {
          record.unsubscribe(onValue)
          record.discard()
        }
      } catch (err) {
        o.error(err)
      }
    })
}

RecordHandler.prototype.isReady = function (name) {
  return Observable
    .create(o => {
      try {
        const record = this.getRecord(name)
        const onReady = value => o.next(value)
        record.on('ready', onReady)
        onReady(record.isReady)
        return () => {
          record.off('ready', onReady)
          record.discard()
        }
      } catch (err) {
        o.error(err)
      }
    })
}

RecordHandler.prototype.hasProvider = function (name) {
  return Observable
    .create(o => {
      try {
        const record = this.getRecord(name)
        const onValue = value => o.next(value)
        record.on('hasProviderChanged', onValue)
        onValue(record.hasProvider)
        return () => {
          record.off('hasProviderChanged', onValue)
          record.discard()
        }
      } catch (err) {
        o.error(err)
      }
    })
}

RecordHandler.prototype._$handle = function (message) {
  let name
  if (message.action === C.ACTIONS.ERROR) {
    name = message.data[1]
  } else {
    name = message.data[0]
  }

  const record = this._records.get(name)
  if (record) {
    record._$onMessage(message)
  }

  const listener = this._listeners.get(name)
  if (listener) {
    listener._$onMessage(message)
  }
}

module.exports = RecordHandler
