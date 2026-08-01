import { bench, run } from 'mitata'
import * as C from '../src/constants/constants.js'
import { parseMessage } from '../src/message/message-parser.js'

const client = {
  _$onError() {},
}
const result = {}
const message = [
  C.TOPIC.RECORD,
  C.ACTIONS.UPDATE,
  `record/${'a'.repeat(24)}`,
  `42-${'b'.repeat(28)}`,
  `{"value":"${'c'.repeat(480)}"}`,
].join(C.MESSAGE_PART_SEPERATOR)

bench('parse record update', () => {
  parseMessage(message, client, result)
})

await run()
