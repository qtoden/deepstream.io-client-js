const Record = require('./record')
const Listener = require('../utils/listener')
const utils = require('../utils/utils')
const C = require('../constants/constants')
const EventEmitter = require('component-emitter')
const Rx = require('rxjs')
const LRU = require('lru-cache')

const RecordHandler = function (options, connection, client) {
  this._options = options
  this._connection = connection
  this._client = client
  this._records = {}
  this._listener = {}
  this._destroyEventEmitter = new EventEmitter()
  this._cache = LRU({
    maxAge: options.recordTTL,
    dispose (recordName, record) {
      record.discard()
    }
  })
  this._prune()
}

RecordHandler.prototype._prune = function () {
  utils.requestIdleCallback(() => {
    this._cache.prune()
    setTimeout(this._prune.bind(this), this._options.recordTTL)
  })
}

RecordHandler.prototype.getRecord = function (recordName, recordOptions) {
  let record = this._records[recordName]
  if (!record) {
    record = new Record(recordName, recordOptions || {}, this._connection, this._options, this._client)
    record.on('error', error => {
      this._client._$onError(C.TOPIC.RECORD, error, recordName)
    })
    record.on('destroy', () => {
      delete this._records[recordName]
    })
    this._records[recordName] = record
  }

  if (!this._cache.get(recordName)) {
    record.usages++
    this._cache.set(recordName, record)
  }

  record.usages++
  return record
}

RecordHandler.prototype.listen = function (pattern, callback) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('invalid argument pattern')
  }
  if (typeof callback !== 'function') {
    throw new Error('invalid argument callback')
  }

  if (this._listener[pattern] && !this._listener[pattern].destroyPending) {
    return this._client._$onError(C.TOPIC.RECORD, C.EVENT.LISTENER_EXISTS, pattern)
  }

  if (this._listener[pattern]) {
    this._listener[pattern].destroy()
  }
  this._listener[pattern] = new Listener(C.TOPIC.RECORD, pattern, callback, this._options, this._client, this._connection)
}

RecordHandler.prototype.unlisten = function (pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('invalid argument pattern')
  }

  const listener = this._listener[pattern]
  if (listener && !listener.destroyPending) {
    listener.sendDestroy()
  } else if (this._listener[pattern]) {
    this._listener[pattern].destroy()
    delete this._listener[pattern]
  } else {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.NOT_LISTENING, pattern)
  }
}

RecordHandler.prototype.get = function (recordName, pathOrNil) {
  if (typeof recordName !== 'string' || recordName.length === 0) {
    throw new Error('invalid argument recordName')
  }

  const record = this.getRecord(recordName)
  return record
    .whenReady()
    .then(() => record.get(pathOrNil))
    .then(val => {
      this._cache.get(recordName)
      record.discard()
      return val
    })
    .catch(err => {
      this._cache.get(recordName)
      record.discard()
      throw err
    })
}

RecordHandler.prototype.set = function (recordName, pathOrData, dataOrNil) {
  if (typeof recordName !== 'string' || recordName.length === 0) {
    throw new Error('invalid argument recordName')
  }

  const record = this.getRecord(recordName)

  if (arguments.length === 2) {
    record.set(pathOrData)
  } else {
    record.set(pathOrData, dataOrNil)
  }

  this._cache.get(recordName)
  record.discard()

  return record.whenReady()
}

RecordHandler.prototype.update = function (recordName, pathOrUpdater, updaterOrNil) {
  if (typeof recordName !== 'string' || recordName.length === 0) {
    throw new Error('invalid argument recordName')
  }

  const path = arguments.length === 2 ? undefined : pathOrUpdater
  const updater = arguments.length === 2 ? pathOrUpdater : updaterOrNil

  const record = this.getRecord(recordName)
  return record
    .whenReady()
    .then(() => updater(record.get(path)))
    .then(val => {
      if (arguments.length === 2) {
        record.set(val)
      } else {
        record.set(path, val)
      }
      this._cache.get(recordName)
      record.discard()
      return val
    })
    .catch(err => {
      this._cache.get(recordName)
      record.discard()
      throw err
    })
}

RecordHandler.prototype.observe = function (recordName) {
  return Rx.Observable
    .create((o) => {
      if (typeof recordName !== 'string' || recordName.length === 0) {
        o.error(new Error('invalid argument recordName'))
      } else {
        const record = this.getRecord(recordName)
        const onValue = function (value) { o.next(value) }
        const onError = function (error) { o.error(error) }
        record.subscribe(onValue, true)
        record.on('error', onError)
        return () => {
          this._cache.get(recordName)
          record.unsubscribe(onValue)
          record.off('error', onError)
          record.discard()
        }
      }
    })
}

RecordHandler.prototype._$handle = function (message) {
  if (message.action === C.ACTIONS.ERROR && message.data[0] !== C.EVENT.MESSAGE_DENIED) {
    message.processedError = true
    this._client._$onError(C.TOPIC.RECORD, message.data[0], message.data[1])
    return
  }

  let recordName
  if (message.action === C.ACTIONS.ACK || message.action === C.ACTIONS.ERROR) {
    recordName = message.data[1]
  } else {
    recordName = message.data[0]
  }

  let processed = false

  if (this._records[recordName]) {
    processed = true
    this._records[recordName]._$onMessage(message)
  }

  if (message.action === C.ACTIONS.ACK && message.data[0] === C.ACTIONS.UNLISTEN &&
    this._listener[recordName] && this._listener[recordName].destroyPending
  ) {
    processed = true
    this._listener[recordName].destroy()
    delete this._listener[recordName]
  } else if (this._listener[recordName]) {
    processed = true
    this._listener[recordName]._$onMessage(message)
  } else if (message.action === C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_REMOVED) {
    // An unlisten ACK was received before an PATTERN_REMOVED which is a valid case
    processed = true
  } else if (message.action === C.ACTIONS.SUBSCRIPTION_HAS_PROVIDER) {
    // record can receive a HAS_PROVIDER after discarding the record
    processed = true
  }

  if (!processed) {
    message.processedError = true
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UNSOLICITED_MESSAGE, recordName)
  }
}

module.exports = RecordHandler
