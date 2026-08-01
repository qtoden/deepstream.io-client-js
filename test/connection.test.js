import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/constants/constants.js'
import Connection from '../src/message/connection.js'
import FixedQueue from '../src/utils/fixed-queue.js'

function createReceiver(messages) {
  const received = []
  const emitted = []
  const errors = []
  const connection = Object.create(Connection.prototype)

  connection._recvQueue = new FixedQueue()
  connection._processingRecv = true
  connection._batchSize = 1024
  connection._schedule = () => assert.fail('queue should drain in one batch')
  connection._logger = null
  connection._message = { raw: null, topic: null, action: null, data: null }
  connection._client = {
    _$onError(...args) {
      errors.push(args)
    },
    _$onMessage(message) {
      received.push({ ...message, data: [...message.data] })
    },
  }
  connection.emit = (event, message) => {
    emitted.push({ event, message: { ...message, data: [...message.data] } })
  }

  for (const message of messages) {
    connection._recvQueue.push(message)
  }

  return { connection, received, emitted, errors }
}

describe('connection receive queue', () => {
  it('drops malformed messages instead of replaying the previous parsed message', () => {
    const separator = C.MESSAGE_PART_SEPERATOR
    const { connection, received, emitted, errors } = createReceiver([
      `R${separator}U${separator}first`,
      `R${separator}UNKNOWN${separator}malformed`,
      `R${separator}U${separator}second`,
    ])

    connection._recvMessages()

    assert.deepEqual(
      received.map((message) => message.data[0]),
      ['first', 'second'],
    )
    assert.equal(emitted.length, 2)
    assert.equal(errors.length, 1)
    assert.equal(connection._processingRecv, false)
  })
})
