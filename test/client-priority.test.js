import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import createDeepstream from '../src/client.js'
import * as C from '../src/constants/constants.js'
import Connection from '../src/message/connection.js'

function createClient(options) {
  const createEndpoint = Connection.prototype._createEndpoint
  Connection.prototype._createEndpoint = () => {}
  try {
    return createDeepstream('ws://localhost/deepstream', options)
  } finally {
    Connection.prototype._createEndpoint = createEndpoint
  }
}

describe('client priority', () => {
  it('includes the configured priority in authentication', () => {
    const connection = createClient({ priority: 7 })._connection
    let submitted
    connection._authParams = { token: 'test' }
    connection._setState = () => {}
    connection._submit = (message) => {
      submitted = message
    }

    connection._sendAuthParams()

    assert.equal(submitted.split(C.MESSAGE_PART_SEPERATOR).at(-1), '7')
  })

  it('ignores unknown keys without changing the options prototype', () => {
    const options = JSON.parse('{"priority":7,"unknown":true,"__proto__":{"polluted":true}}')
    const client = createClient(options)

    assert.equal(client._options.priority, 7)
    assert.equal(client._options.unknown, undefined)
    assert.equal(Object.getPrototypeOf(client._options), Object.prototype)
    assert.equal({}.polluted, undefined)
  })
})
