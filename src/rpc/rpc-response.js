import * as C from '../constants/constants.js'
import * as messageBuilder from '../message/message-builder.js'

function RpcResponse(connection, name, id) {
  this._connection = connection
  this._name = name
  this._id = id
  this.completed = false
}

RpcResponse.prototype.reject = function () {
  if (this.completed) {
    throw new Error(`Rpc ${this._name} already completed`)
  }
  this.completed = true

  this._connection.sendMsg(C.TOPIC.RPC, C.ACTIONS.REJECTION, [this._name, this._id])
}

RpcResponse.prototype.error = function (error) {
  if (this.completed) {
    throw new Error(`Rpc ${this._name} already completed`)
  }

  let message
  try {
    const value = error?.message ?? error
    message = typeof value === 'string' ? value : String(value)
  } catch {
    message = 'unknown error'
  }

  this._connection.sendMsg(C.TOPIC.RPC, C.ACTIONS.RESPONSE, [
    this._name,
    this._id,
    message,
    messageBuilder.typed(true),
  ])
  this.completed = true
}

RpcResponse.prototype.send = function (data) {
  if (this.completed) {
    throw new Error(`Rpc ${this._name} already completed`)
  }

  const typedData = messageBuilder.typed(data)

  this._connection.sendMsg(C.TOPIC.RPC, C.ACTIONS.RESPONSE, [this._name, this._id, typedData])
  this.completed = true
}

export default RpcResponse
