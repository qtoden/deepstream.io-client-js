import * as C from '../constants/constants.js'

const actions = {}

for (const action of Object.values(C.ACTIONS)) {
  actions[action] = true
}

export function convertTyped(value, client) {
  const type = value.charAt(0)

  if (type === C.TYPES.STRING) {
    return value.slice(1)
  }

  if (type === C.TYPES.OBJECT) {
    try {
      return JSON.parse(value.slice(1))
    } catch (err) {
      client._$onError(C.TOPIC.ERROR, C.EVENT.MESSAGE_PARSE_ERROR, err)
      return undefined
    }
  }

  if (type === C.TYPES.NUMBER) {
    return Number.parseFloat(value.slice(1))
  }

  if (type === C.TYPES.NULL) {
    return null
  }

  if (type === C.TYPES.TRUE) {
    return true
  }

  if (type === C.TYPES.FALSE) {
    return false
  }

  if (type === C.TYPES.UNDEFINED) {
    return undefined
  }

  client._$onError(C.TOPIC.ERROR, C.EVENT.MESSAGE_PARSE_ERROR, new Error(`UNKNOWN_TYPE (${value})`))

  return undefined
}

export function parseMessage(message, client, result) {
  const topicEnd = message.indexOf(C.MESSAGE_PART_SEPERATOR)

  if (topicEnd === -1) {
    client._$onError(
      C.TOPIC.ERROR,
      C.EVENT.MESSAGE_PARSE_ERROR,
      new Error('Insufficient message parts'),
    )
    return null
  }

  const actionEnd = message.indexOf(C.MESSAGE_PART_SEPERATOR, topicEnd + 1)
  const topic = message.slice(0, topicEnd)
  const action =
    actionEnd === -1 ? message.slice(topicEnd + 1) : message.slice(topicEnd + 1, actionEnd)

  if (topic === C.TOPIC.ERROR) {
    client._$onError(C.TOPIC.ERROR, action, new Error('Message error'), message)
    return null
  }

  if (actions[action] !== true) {
    client._$onError(
      C.TOPIC.ERROR,
      C.EVENT.MESSAGE_PARSE_ERROR,
      new Error('Unknown action'),
      message,
    )
    return null
  }

  result.raw = message
  result.topic = topic
  result.action = action
  result.data = actionEnd === -1 ? [] : message.slice(actionEnd + 1).split(C.MESSAGE_PART_SEPERATOR)
  result.processedError = false
  return true
}
