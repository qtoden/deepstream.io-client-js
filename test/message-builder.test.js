import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import varint from 'varint'
import * as C from '../src/constants/constants.js'
import { getMsg } from '../src/message/message-builder.js'

function decodeBinaryMessage(message) {
  const headerSize = message[0] > 128 ? message[0] - 128 : 0
  return message.subarray(headerSize).toString('utf8')
}

describe('message builder', () => {
  it('builds binary messages with byte-accurate fast headers', () => {
    const data = ['name', '€'.repeat(64), '🚀'.repeat(64)]
    const message = getMsg('R', 'U', data, true)
    const headerSize = message[0] - 128

    let headerPos = 1
    for (const value of data) {
      assert.equal(varint.decode(message, headerPos), Buffer.byteLength(value) + 1)
      headerPos += varint.decode.bytes
    }

    assert.ok(headerPos <= headerSize)
    assert.equal(decodeBinaryMessage(message), ['R', 'U', ...data].join(C.MESSAGE_PART_SEPERATOR))
  })

  it('builds binary messages without data', () => {
    assert.equal(decodeBinaryMessage(getMsg('C', 'PO', undefined, true)), 'C\x1fPO')
  })

  it('reserves space for no-data messages when the shared pool is nearly full', async () => {
    const { getMsg: getFreshMsg } = await import(
      `../src/message/message-builder.js?no-data-capacity=${Date.now()}`
    )
    for (let i = 0; i < 2_000; i++) {
      getFreshMsg('R', 'U', ['a'.repeat(1_024)], true)
    }

    let message
    for (let i = 0; i < 10_000; i++) {
      message = getFreshMsg('C', 'PO', undefined, true)
    }

    assert.equal(decodeBinaryMessage(message), 'C\x1fPO')
  })

  it('uses the shared 1.5x fast path for large one-byte messages', async () => {
    const { getMsg: getFreshMsg } = await import(
      `../src/message/message-builder.js?large-one-byte=${Date.now()}`
    )
    const value = 'a'.repeat(1_200_000)
    const message = getFreshMsg('R', 'U', [value], true)

    assert.equal(message.buffer.byteLength, 2 * 1024 * 1024)
    assert.equal(decodeBinaryMessage(message), ['R', 'U', value].join(C.MESSAGE_PART_SEPERATOR))
  })

  it('does not truncate UTF-8 data near the end of the shared buffer pool', async () => {
    const { getMsg: getFreshMsg } = await import(
      `../src/message/message-builder.js?pool-fragmentation=${Date.now()}`
    )
    const filler = 'a'.repeat(600_000)
    getFreshMsg('R', 'U', [filler], true)
    getFreshMsg('R', 'U', [filler], true)

    const value = '€'.repeat(300_000)
    const message = getFreshMsg('R', 'U', [value], true)

    assert.equal(decodeBinaryMessage(message), ['R', 'U', value].join(C.MESSAGE_PART_SEPERATOR))
  })

  it('retries when a wide field fills the pool before later data', async () => {
    const { getMsg: getFreshMsg } = await import(
      `../src/message/message-builder.js?multi-field-boundary=${Date.now()}`
    )
    const filler = 'a'.repeat(600_000)
    getFreshMsg('R', 'U', [filler], true)
    const previous = getFreshMsg('R', 'U', [filler], true)

    const remaining = previous.buffer.byteLength - previous.byteOffset - previous.byteLength
    const tail = 'tail'
    const headerSize = 1 + varint.encodingLength(300_000) + varint.encodingLength(tail.length) + 2
    const value = '€'.repeat(Math.floor((remaining - headerSize - 4) / 3))
    const message = getFreshMsg('R', 'U', [value, tail], true)

    assert.equal(
      decodeBinaryMessage(message),
      ['R', 'U', value, tail].join(C.MESSAGE_PART_SEPERATOR),
    )
  })
})
