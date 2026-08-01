import { bench, run } from 'mitata'
import Emitter from 'component-emitter2'
import * as C from '../src/constants/constants.js'
import RecordHandler from '../src/record/record-handler.js'

const connection = {
  connected: true,
  sendMsg() {
    return true
  },
}
const client = {}
Emitter(client)
client.user = null
client.getConnectionState = () => C.CONNECTION_STATE.OPEN
client._$onError = (topic, event, error, data) => {
  throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
    topic,
    event,
    data,
  })
}

const records = new RecordHandler({}, connection, client)
const record = records.getRecord('benchmark/record')
record._$onMessage({
  action: C.ACTIONS.UPDATE,
  data: [record.name, '1-benchmark', '{"value":{"nested":42}}'],
})

bench('record.get', () => {
  record.get('value.nested')
})

bench('record ref/unref', () => {
  record.ref().unref()
})

bench('record.observe subscribe/unsubscribe', () => {
  records.observe(record.name).subscribe().unsubscribe()
})

await run()
