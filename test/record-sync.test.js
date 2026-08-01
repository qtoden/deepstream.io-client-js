import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/constants/constants.js'

let RecordHandler

function createSyncHandler() {
  const messages = []
  const handler = Object.create(RecordHandler.prototype)
  handler._syncQueues = new Map()
  handler._syncMap = new Map()
  handler._patching = new Map()
  handler._updating = new Map()
  handler._connection = {
    sendMsg(topic, action, data) {
      messages.push({ topic, action, data })
      return true
    },
  }
  return { handler, messages }
}

function waitForSyncBatch() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

describe('record sync batching', async () => {
  RecordHandler = (await import('../src/record/record-handler.js')).default

  it('batches requests with the same strength', async () => {
    const { handler, messages } = createSyncHandler()
    const completed = []
    handler._sync(() => completed.push('first'), 'WEAK')
    handler._sync(() => completed.push('second'), true)

    await waitForSyncBatch()

    assert.equal(messages.length, 1)
    assert.equal(messages[0].action, C.ACTIONS.SYNC)
    assert.equal(messages[0].data[1], 'WEAK')

    handler._$handle({ action: C.ACTIONS.SYNC, data: [messages[0].data[0]] })
    assert.deepEqual(completed, ['first', 'second'])
  })

  it('keeps requests with different strengths in separate batches', async () => {
    const { handler, messages } = createSyncHandler()
    handler._sync(() => {}, null)
    handler._sync(() => {}, 'STRONG')
    handler._sync(() => {}, 'WEAK')

    await waitForSyncBatch()

    assert.equal(messages.length, 3)
    assert.deepEqual(
      new Set(messages.map(({ data }) => data[1] ?? null)),
      new Set([null, 'STRONG', 'WEAK']),
    )
  })

  it('rejects invalid strengths without poisoning the next batch', async () => {
    const { handler, messages } = createSyncHandler()
    assert.throws(() => handler._sync(() => {}, 'INVALID'), /invalid sync type/)

    let completed = false
    handler._sync(() => {
      completed = true
    })
    await waitForSyncBatch()

    assert.equal(messages.length, 1)
    handler._$handle({ action: C.ACTIONS.SYNC, data: [messages[0].data[0]] })
    assert.equal(completed, true)
  })

  it('rejects immediately when sync starts with an aborted signal', async () => {
    const { handler, messages } = createSyncHandler()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)

    await assert.rejects(handler.sync({ signal: controller.signal }), reason)
    assert.equal(messages.length, 0)
  })
})
