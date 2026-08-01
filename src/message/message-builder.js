import * as C from '../constants/constants.js'
import varint from 'varint'

const SEP = C.MESSAGE_PART_SEPERATOR

let poolBuf
let poolPos = 0
let poolLen = 2 * 1024 * 1024

export function getMsg(topic, action, data, binary) {
  if (data && !(data instanceof Array)) {
    throw new Error('data must be an array')
  }

  if (binary) {
    let headerSize = 0
    let estimatedSize = topic.length + action.length + 1

    // Estimate headerSize
    if (data) {
      headerSize = 1
      for (let n = 0; n < data.length; n++) {
        if (typeof data[n] !== 'string') {
          throw new Error(`invalid data[${n}]`)
        }
        estimatedSize += data[n].length + 1 // +1 for the separator
        headerSize += varint.encodingLength(data[n].length)
      }
      // Allow extra space for some multi chars here and there...
      headerSize += 2

      estimatedSize += headerSize + 1
    }

    // Give the common one-byte payload 50% headroom. Wider UTF-8 values retry
    // below instead of making every message reserve the worst case.
    const estimatedCapacity = Math.ceil((estimatedSize * 3) / 2)
    if (!poolBuf || poolBuf.byteLength - poolPos < estimatedCapacity) {
      poolLen = Math.max(poolLen, estimatedCapacity)
      poolBuf = Buffer.allocUnsafeSlow(poolLen)
      poolPos = 0
    }

    let msgPos = poolPos

    for (let i = 0; i < headerSize; i++) {
      poolBuf[poolPos + i] = 0
    }

    let headerPos = poolPos
    poolBuf[headerPos++] = 128 + headerSize

    const dataStart = poolPos + headerSize

    let dataPos = dataStart
    if (topic.length === 1) {
      poolBuf[dataPos++] = topic.charCodeAt(0)
    } else {
      throw new Error('invalid topic: ' + topic)
    }

    if (action.length === 1) {
      poolBuf[dataPos++] = 31
      poolBuf[dataPos++] = action.charCodeAt(0)
    } else if (action.length === 2) {
      poolBuf[dataPos++] = 31
      poolBuf[dataPos++] = action.charCodeAt(0)
      poolBuf[dataPos++] = action.charCodeAt(1)
    } else if (action.length === 3) {
      poolBuf[dataPos++] = 31
      poolBuf[dataPos++] = action.charCodeAt(0)
      poolBuf[dataPos++] = action.charCodeAt(1)
      poolBuf[dataPos++] = action.charCodeAt(2)
    } else {
      throw new Error('invalid action: ' + action)
    }

    if (data) {
      for (let i = 0; i < data.length; i++) {
        poolBuf[dataPos++] = 31
        const len = poolBuf.write(data[i], dataPos)
        dataPos += len

        // Buffer.write() stops before a partial UTF-8 sequence, leaving at
        // most three bytes unused when the destination is too small. Only pay
        // for an exact byte-length scan on that rare boundary case.
        if (
          poolBuf.byteLength - dataPos < 4 &&
          (i + 1 < data.length || len !== Buffer.byteLength(data[i]))
        ) {
          poolLen *= poolPos === 0 ? 2 : 1
          poolBuf = null
          poolPos = 0
          return getMsg(topic, action, data, binary)
        }

        if (headerSize > 0) {
          const encodingLength = varint.encodingLength(len + 1)
          if (headerPos + encodingLength > dataStart) {
            // Overflow. Discard the header and fallback to only separators.
            msgPos = dataStart
            headerSize = 0
          } else {
            varint.encode(len + 1, poolBuf, headerPos)
            headerPos += varint.encode.bytes
          }
        }
      }
    }

    poolPos = dataPos
    return poolBuf.subarray(msgPos, dataPos)
  } else {
    const sendData = [topic, action]
    if (data) {
      for (let i = 0; i < data.length; i++) {
        if (typeof data[i] === 'object') {
          sendData.push(JSON.stringify(data[i]))
        } else {
          sendData.push(data[i])
        }
      }
    }
    return sendData.join(SEP)
  }
}

export function typed(value) {
  const type = typeof value

  if (type === 'string') {
    return C.TYPES.STRING + value
  }

  if (value === null) {
    return C.TYPES.NULL
  }

  if (type === 'object') {
    return C.TYPES.OBJECT + JSON.stringify(value)
  }

  if (type === 'number') {
    return C.TYPES.NUMBER + value.toString()
  }

  if (value === true) {
    return C.TYPES.TRUE
  }

  if (value === false) {
    return C.TYPES.FALSE
  }

  if (value === undefined) {
    return C.TYPES.UNDEFINED
  }

  throw new Error(`Can't serialize type ${value}`)
}
