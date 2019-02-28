const C = require('../constants/constants')
const RpcResponse = require('./rpc-response')
const messageParser = require('../message/message-parser')
const messageBuilder = require('../message/message-builder')
const utils = require('../utils/utils')
const xuid = require('xuid')

const RpcHandler = function (options, connection, client) {
  this._options = options
  this._connection = connection
  this._client = client
  this._rpcs = new Map()
  this._providers = new Map()

  this._handleConnectionStateChange = this._handleConnectionStateChange.bind(this)

  this._client.on('connectionStateChanged', this._handleConnectionStateChange)
}

Object.defineProperty(RpcHandler.prototype, 'connected', {
  get: function connected () {
    return this._client.getConnectionState() === C.CONNECTION_STATE.OPEN
  }
})

RpcHandler.prototype.provide = function (name, callback) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('invalid argument name')
  }
  if (typeof callback !== 'function') {
    throw new Error('invalid argument callback')
  }

  if (this._providers.has(name)) {
    this._client._$onError(C.TOPIC.RPC, C.EVENT.PROVIDER_EXISTS, name)
    return
  }

  this._providers.set(name, callback)

  if (this.connected) {
    this._connection.sendMsg(C.TOPIC.RPC, C.ACTIONS.SUBSCRIBE, [ name ])
  }

  return () => this.unprovide(name)
}

RpcHandler.prototype.unprovide = function (name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('invalid argument name')
  }

  if (!this._providers.has(name)) {
    this._client._$onError(C.TOPIC.RPC, C.EVENT.NOT_PROVIDING, name)
    return
  }

  this._providers.delete(name)

  if (this.connected) {
    this._connection.sendMsg(C.TOPIC.RPC, C.ACTIONS.UNSUBSCRIBE, [ name ])
  }
}

RpcHandler.prototype.make = function (name, data, callback) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('invalid argument name')
  }

  let promise
  if (callback === undefined) {
    promise = new Promise((resolve, reject) => {
      callback = (err, val) => err ? reject(err) : resolve(val)
    })
  }

  if (typeof callback !== 'function') {
    throw new Error('invalid argument callback')
  }

  const send = () => {
    const id = xuid()
    this._rpcs.set(id, {
      id,
      name,
      callback
    })
    this._connection.sendMsg(C.TOPIC.RPC, C.ACTIONS.REQUEST, [ name, id, messageBuilder.typed(data) ])
  }

  const provider = this._providers.get(name)
  if (provider) {
    class Response {
      constructor (callback, reject) {
        this._callback = callback
        this._reject = reject
        this.completed = false
      }
      reject () {
        if (this.completed) {
          throw new Error(`Rpc ${this._name} already completed`)
        }
        this.completed = true

        this._reject()
      }
      error (err) {
        if (this.completed) {
          throw new Error(`Rpc ${this._name} already completed`)
        }
        this.completed = true

        this._callback(err)
      }
      send (val) {
        if (this.completed) {
          throw new Error(`Rpc ${this._name} already completed`)
        }
        this.completed = true

        this._callback(null, val)
      }
    }

    utils.nextTick(() => provider(data, new Response(callback, send)))
  } else {
    send()
  }

  return promise
}

RpcHandler.prototype._respond = function (message) {
  const [ name, id, data ] = message.data

  const callback = this._providers.get(name)
  const response = new RpcResponse(this._connection, name, id)

  if (callback) {
    let promise
    try {
      promise = Promise.resolve(callback(messageParser.convertTyped(data, this._client), response))
    } catch (err) {
      promise = Promise.reject(err)
    }

    if (!response.completed) {
      promise
        .then(val => {
          if (!response.completed) {
            response.send(val)
          }
        })
        .catch(err => {
          if (!response.completed) {
            response.error(err)
          }
        })
    }
  } else {
    response.reject()
  }
}

RpcHandler.prototype._$handle = function (message) {
  if (message.action === C.ACTIONS.REQUEST) {
    this._respond(message)
    return
  }

  const [ , id, data, error ] = message.action !== C.ACTIONS.ERROR
    ? message.data
    : message.data.slice(1).concat(message.data.slice(0, 1))

  const rpc = this._rpcs.get(id)

  if (!rpc) {
    return
  }

  this._rpcs.delete(id)

  if (message.action === C.ACTIONS.RESPONSE) {
    if (error) {
      rpc.callback(new Error(data))
    } else {
      rpc.callback(null, messageParser.convertTyped(data, this._client))
    }
  } else if (message.action === C.ACTIONS.ERROR) {
    message.processedError = true
    rpc.callback(new Error(data))
  }
}

RpcHandler.prototype._handleConnectionStateChange = function () {
  if (this.connected) {
    for (const name of this._providers.keys()) {
      this._connection.sendMsg(C.TOPIC.RPC, C.ACTIONS.SUBSCRIBE, [ name ])
    }
  } else {
    const err = new Error('socket hang up')
    err.code = 'ECONNRESET'
    for (const [ , rpc ] of this._rpcs) {
      rpc.callback(err)
    }
    this._rpcs.clear()
  }
}

module.exports = RpcHandler
