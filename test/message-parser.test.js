import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/constants/constants.js'
import { convertTyped, parseMessage } from '../src/message/message-parser.js'

function createClient() {
  return {
    errors: [],
    _$onError(...args) {
      this.errors.push(args)
    },
  }
}

describe('message parser', () => {
  it('parses valid messages and resets per-message error state', () => {
    const client = createClient()
    const result = { processedError: true }

    assert.equal(
      parseMessage(`R${C.MESSAGE_PART_SEPERATOR}U${C.MESSAGE_PART_SEPERATOR}name`, client, result),
      true,
    )
    assert.deepEqual(result, {
      raw: `R${C.MESSAGE_PART_SEPERATOR}U${C.MESSAGE_PART_SEPERATOR}name`,
      topic: 'R',
      action: 'U',
      data: ['name'],
      processedError: false,
    })
  })

  it('rejects inherited object property names as actions', () => {
    const client = createClient()
    const result = {}

    assert.equal(
      parseMessage(
        `R${C.MESSAGE_PART_SEPERATOR}toString${C.MESSAGE_PART_SEPERATOR}name`,
        client,
        result,
      ),
      null,
    )
    assert.equal(client.errors.length, 1)
    assert.deepEqual(result, {})
  })

  it('does not overwrite the previous result when parsing fails', () => {
    const client = createClient()
    const result = {}
    const valid = `R${C.MESSAGE_PART_SEPERATOR}U${C.MESSAGE_PART_SEPERATOR}first`

    parseMessage(valid, client, result)
    assert.equal(parseMessage(`R${C.MESSAGE_PART_SEPERATOR}UNKNOWN`, client, result), null)
    assert.equal(result.raw, valid)
    assert.deepEqual(result.data, ['first'])
  })

  it('reports an insufficient-parts parse error', () => {
    const client = createClient()

    assert.equal(parseMessage('invalid', client, {}), null)
    assert.equal(client.errors[0][2].message, 'Insufficient message parts')
  })

  it('converts typed values and reports invalid values', () => {
    const client = createClient()

    assert.equal(convertTyped('Svalue', client), 'value')
    assert.deepEqual(convertTyped('O{"value":true}', client), { value: true })
    assert.equal(convertTyped('N42.5', client), 42.5)
    assert.equal(convertTyped('L', client), null)
    assert.equal(convertTyped('T', client), true)
    assert.equal(convertTyped('F', client), false)
    assert.equal(convertTyped('U', client), undefined)
    assert.equal(convertTyped('O{', client), undefined)
    assert.equal(convertTyped('?', client), undefined)
    assert.equal(client.errors.length, 2)
  })
})
