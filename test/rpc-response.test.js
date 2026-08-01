import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/constants/constants.js'
import RpcResponse from '../src/rpc/rpc-response.js'

function createResponse() {
  const messages = []
  const connection = {
    sendMsg(topic, action, data) {
      messages.push({ topic, action, data })
      return true
    },
  }
  return { response: new RpcResponse(connection, 'rpc/test', 'request-id'), messages }
}

describe('RPC response serialization', () => {
  it('remains open when response serialization fails', () => {
    const { response, messages } = createResponse()

    assert.throws(() => response.send(1n), /Can't serialize type/)
    assert.equal(response.completed, false)
    assert.equal(messages.length, 0)

    response.error(new Error('invalid response'))
    assert.equal(response.completed, true)
    assert.deepEqual(messages, [
      {
        topic: C.TOPIC.RPC,
        action: C.ACTIONS.RESPONSE,
        data: ['rpc/test', 'request-id', 'invalid response', 'T'],
      },
    ])
  })

  it('normalizes non-error rejection values', () => {
    const { response, messages } = createResponse()

    response.error(null)

    assert.equal(response.completed, true)
    assert.equal(messages[0].data[2], 'null')
  })

  it('normalizes non-string message properties', () => {
    const { response, messages } = createResponse()

    response.error({ message: { code: 'INVALID' } })

    assert.equal(response.completed, true)
    assert.equal(messages[0].data[2], '[object Object]')
  })

  it('falls back when an error cannot be converted to a string', () => {
    const { response, messages } = createResponse()

    response.error(Object.create(null))

    assert.equal(response.completed, true)
    assert.equal(messages[0].data[2], 'unknown error')
  })
})
