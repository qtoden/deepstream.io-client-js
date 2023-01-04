const utils = require('../utils/utils')
const PARTS_REG_EXP = /([^.[\]\s]+)/g

const cache = new Map()
const EMPTY = utils.deepFreeze({})

const EMPTY_OBJ = EMPTY
const EMPTY_ARR = utils.deepFreeze([])

function get(data, path) {
  data = data || EMPTY

  if (!path) {
    return data
  }

  const tokens = tokenize(path)

  for (let i = 0; i < tokens.length; i++) {
    if (data == null || typeof data !== 'object') {
      return undefined
    }
    data = data[tokens[i]]
  }

  return data
}

function parse(value) {
  if (value === '{}') {
    return EMPTY_OBJ
  } else if (value === '[]') {
    return EMPTY_ARR
  } else {
    return JSON.parse(value)
  }
}

function set(data, path, value, isPlainJSON = false) {
  data = data || EMPTY

  if (!path) {
    return patch(data, value, isPlainJSON)
  }

  const oldValue = get(data, path)
  const newValue = patch(oldValue, value, isPlainJSON)

  if (newValue === oldValue) {
    return data
  }

  const result = data ? utils.shallowCopy(data) : {}

  const tokens = tokenize(path)

  let node = result
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (i === tokens.length - 1) {
      node[token] = newValue
    } else if (node[token] != null && typeof node[token] === 'object') {
      node = node[token] = utils.shallowCopy(node[token])
    } else if (tokens[i + 1] && !isNaN(tokens[i + 1])) {
      node = node[token] = []
    } else {
      node = node[token] = {}
    }
  }
  return result
}

function jsonClone(o) {
  if (o == null || typeof o === 'string') {
    return o
  }

  if (Array.isArray(o) && o.length === 0) {
    return EMPTY_ARR
  } else if (typeof o === 'object' && Object.keys(o).length === 0) {
    return EMPTY_OBJ
  }

  return JSON.parse(JSON.stringify(o))
}

function patch(oldValue, newValue, isPlainJSON) {
  if (oldValue === newValue) {
    return oldValue
  } else if (oldValue === null || newValue === null) {
    return isPlainJSON ? newValue : jsonClone(newValue)
  } else if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    if (newValue.length === 0) {
      return EMPTY_ARR
    }

    let arr = newValue.length === oldValue.length ? null : []
    for (let i = 0; i < newValue.length; i++) {
      const value = patch(oldValue[i], newValue[i], isPlainJSON)

      if (!arr) {
        if (value === oldValue[i]) {
          continue
        }
        arr = []
        for (let j = 0; j < i; ++j) {
          arr[j] = oldValue[j]
        }
      }
      // JSON: compat, undefined in array is null
      arr[i] = value === undefined ? null : value
    }

    return arr || oldValue
  } else if (utils.isPlainObject(oldValue, true) && utils.isPlainObject(newValue, isPlainJSON)) {
    const newKeys = Object.keys(newValue).filter((key) => newValue[key] !== undefined)
    const oldKeys = Object.keys(oldValue)

    if (newKeys.length === 0) {
      return oldKeys.length === 0 ? oldValue : EMPTY
    }

    let obj = newKeys.length === oldKeys.length ? null : {}
    for (let i = 0; i < newKeys.length; ++i) {
      const key = newKeys[i]
      const val = patch(oldValue[key], newValue[key], isPlainJSON)

      if (!obj) {
        if (val === oldValue[key] && key === oldKeys[i]) {
          continue
        }
        obj = {}
        for (let j = 0; j < i; j++) {
          obj[newKeys[j]] = oldValue[newKeys[j]]
        }
      }
      obj[key] = val
    }

    return obj || oldValue
  } else {
    return isPlainJSON ? newValue : jsonClone(newValue)
  }
}

function tokenize(path) {
  if (!path) {
    return []
  }

  if (Array.isArray(path)) {
    return path
  }

  let parts = cache.get(path)

  if (parts) {
    return parts
  }

  parts = path && String(path) !== 'undefined' ? String(path).match(PARTS_REG_EXP) : []

  if (!parts) {
    throw new Error('invalid path ' + path)
  }

  cache.set(path, parts)

  return parts
}

module.exports = {
  EMPTY,
  EMPTY_OBJ,
  EMPTY_ARR,
  parse,
  get,
  set,
  jsonClone,
}
