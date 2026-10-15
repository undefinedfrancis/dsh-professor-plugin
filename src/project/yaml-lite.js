/**
 * A deliberately small YAML subset: enough for `.professor/project.yaml`, nothing more.
 *
 * Why not a real YAML library: this plugin ships with no dependencies (a distribution decision),
 * and the Harness does not expose a YAML service. Rather than guessing at arbitrary YAML, this
 * module defines the exact dialect the project file uses and **refuses anything outside it** — an
 * unparseable project file is reported as an error and never overwritten, which is what the design
 * requires for a versioned, user-editable artifact.
 *
 * Supported
 * ---------
 * - nested block mappings (`key:` followed by a more-indented block);
 * - block sequences (`- item`, `- key: value` with further keys indented under the dash);
 * - scalars: plain, single/double quoted, integers, floats, `true`/`false`/`null`/`~`;
 * - inline empty collections: `[]` and `{}`;
 * - `#` comments and blank lines;
 * - JSON documents (parsed with `JSON.parse` first, since JSON is valid YAML).
 *
 * Refused (throws `YamlLiteError`)
 * --------------------------------
 * - tabs used for indentation;
 * - anchors/aliases/tags (`&`, `*`, `!`), flow collections with content (`[a, b]`, `{a: 1}`),
 *   block scalars (`|`, `>`), multi-document streams (`---`), and anything else unrecognised.
 *
 * @module dsh-professor-spike/src/project/yaml-lite
 */

export class YamlLiteError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `${message} (line ${line})`)
    this.name = 'YamlLiteError'
    this.code = 'PROFESSOR_YAML_SUBSET'
    this.line = line
  }
}

const PLAIN_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/

function parseScalar(raw, line) {
  const text = raw.trim()
  if (text.length === 0) return null
  if (text === '[]') return []
  if (text === '{}') return {}
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false

  const first = text[0]
  if (first === '"' || first === "'") {
    if (text.length < 2 || text[text.length - 1] !== first) throw new YamlLiteError('unterminated quoted scalar', line)
    const inner = text.slice(1, -1)
    if (first === '"') {
      try { return JSON.parse(text) } catch { throw new YamlLiteError('invalid double-quoted scalar', line) }
    }
    return inner.replace(/''/g, "'")
  }
  if (/^[&*!|>%@`]/.test(text)) throw new YamlLiteError(`unsupported YAML syntax starting with "${first}"`, line)
  if (/^[\[{]/.test(text) || /[\]}]$/.test(text)) {
    throw new YamlLiteError('flow collections with content are not part of this subset', line)
  }
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text)
  return text
}

function indentOf(line) {
  const match = /^( *)/.exec(line)
  return match[1].length
}

function isBlank(line) {
  const trimmed = line.trim()
  return trimmed.length === 0 || trimmed.startsWith('#')
}

/**
 * Parse `text` into a plain JavaScript value.
 *
 * @param text - the document.
 * @returns the parsed value (object, array, or scalar); `null` for an empty document.
 * @throws {YamlLiteError} when the document uses syntax outside the subset.
 */
export function parseYamlLite(text) {
  if (typeof text !== 'string') throw new YamlLiteError('document must be a string')
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed)

  const lines = text.split('\n').map((raw, index) => ({ raw, number: index + 1 }))
  for (const { raw, number } of lines) {
    if (isBlank(raw)) continue
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) throw new YamlLiteError('tabs are not allowed for indentation', number)
    if (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw)) throw new YamlLiteError('multi-document streams are not supported', number)
  }

  const significant = lines.filter(({ raw }) => !isBlank(raw))
  if (significant.length === 0) return null

  let cursor = 0
  const peek = () => significant[cursor]
  const next = () => significant[cursor++]

  function parseBlock(indent) {
    const first = peek()
    if (first === undefined) return null
    if (first.raw.slice(0, indent).trim().length > 0) return null
    const body = first.raw.slice(indent)
    return body.startsWith('- ') || body === '-' ? parseSequence(indent) : parseMapping(indent)
  }

  function parseSequence(indent) {
    const items = []
    while (true) {
      const current = peek()
      if (current === undefined) break
      const currentIndent = indentOf(current.raw)
      if (currentIndent < indent) break
      if (currentIndent > indent) throw new YamlLiteError('unexpected indentation in sequence', current.number)
      const body = current.raw.slice(indent)
      if (!(body.startsWith('- ') || body === '-')) break
      next()

      const rest = body === '-' ? '' : body.slice(2)
      if (rest.trim().length === 0) {
        items.push(parseBlock(indent + 2))
        continue
      }
      const mappingStart = /^([A-Za-z0-9_.-]+):(\s|$)/.exec(rest)
      if (mappingStart === null) {
        items.push(parseScalar(rest, current.number))
        continue
      }
      // A sequence item that begins a mapping: the remaining keys are indented under the dash.
      const itemIndent = indent + 2
      const item = {}
      const firstKey = mappingStart[1]
      const firstValue = rest.slice(mappingStart[0].length)
      if (firstValue.trim().length === 0) {
        const child = peek()
        if (child !== undefined && indentOf(child.raw) > itemIndent) item[firstKey] = parseBlock(indentOf(child.raw))
        else item[firstKey] = parseBlock(itemIndent)
      } else {
        item[firstKey] = parseScalar(firstValue, current.number)
      }
      while (true) {
        const following = peek()
        if (following === undefined || indentOf(following.raw) !== itemIndent) break
        const followBody = following.raw.slice(itemIndent)
        if (followBody.startsWith('- ')) break
        const match = /^([A-Za-z0-9_.-]+):(\s|$)/.exec(followBody)
        if (match === null) throw new YamlLiteError('expected a mapping key in sequence item', following.number)
        next()
        const inline = followBody.slice(match[0].length)
        if (inline.trim().length === 0) {
          const child = peek()
          item[match[1]] = child !== undefined && indentOf(child.raw) > itemIndent
            ? parseBlock(indentOf(child.raw))
            : null
        } else {
          item[match[1]] = parseScalar(inline, following.number)
        }
      }
      items.push(item)
    }
    return items
  }

  function parseMapping(indent) {
    const result = {}
    while (true) {
      const current = peek()
      if (current === undefined) break
      const currentIndent = indentOf(current.raw)
      if (currentIndent < indent) break
      if (currentIndent > indent) throw new YamlLiteError('unexpected indentation in mapping', current.number)
      const body = current.raw.slice(indent)
      if (body.startsWith('- ')) break
      const match = /^([A-Za-z0-9_.-]+):(\s|$)/.exec(body)
      if (match === null) throw new YamlLiteError(`unrecognised line: ${body.slice(0, 40)}`, current.number)
      next()
      const key = match[1]
      const inline = body.slice(match[0].length)
      if (inline.trim().length > 0) {
        result[key] = parseScalar(inline, current.number)
        continue
      }
      const child = peek()
      if (child === undefined || indentOf(child.raw) <= indent) {
        result[key] = null
        continue
      }
      result[key] = parseBlock(indentOf(child.raw))
    }
    return result
  }

  const value = parseBlock(indentOf(significant[0].raw))
  if (cursor < significant.length) {
    throw new YamlLiteError('trailing content after the document', significant[cursor].number)
  }
  return value
}

function needsQuoting(text) {
  return !PLAIN_SAFE.test(text) || text === 'true' || text === 'false' || text === 'null' || /^-?\d+(\.\d+)?$/.test(text)
}

function formatScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  if (text.length === 0) return "''"
  if (/[\n\r\t]/.test(text)) return JSON.stringify(text)
  return needsQuoting(text) ? `'${text.replace(/'/g, "''")}'` : text
}

function isEmptyCollection(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0
}

function inlineCollection(value) {
  return Array.isArray(value) ? '[]' : '{}'
}

function isScalar(value) {
  return value === null || typeof value !== 'object'
}

function emitMapping(object, indent, lines) {
  const pad = ' '.repeat(indent)
  for (const [key, value] of Object.entries(object)) {
    if (isScalar(value)) {
      lines.push(`${pad}${key}: ${formatScalar(value)}`)
      continue
    }
    if (isEmptyCollection(value)) {
      lines.push(`${pad}${key}: ${inlineCollection(value)}`)
      continue
    }
    lines.push(`${pad}${key}:`)
    emit(value, indent + 2, lines)
  }
}

function emitSequence(array, indent, lines) {
  const pad = ' '.repeat(indent)
  for (const item of array) {
    if (isScalar(item)) {
      lines.push(`${pad}- ${formatScalar(item)}`)
      continue
    }
    if (isEmptyCollection(item)) {
      lines.push(`${pad}- ${inlineCollection(item)}`)
      continue
    }
    if (Array.isArray(item)) {
      lines.push(`${pad}-`)
      emitSequence(item, indent + 2, lines)
      continue
    }
    const entries = Object.entries(item)
    const [firstKey, firstValue] = entries[0]
    if (isScalar(firstValue)) lines.push(`${pad}- ${firstKey}: ${formatScalar(firstValue)}`)
    else if (isEmptyCollection(firstValue)) lines.push(`${pad}- ${firstKey}: ${inlineCollection(firstValue)}`)
    else {
      lines.push(`${pad}- ${firstKey}:`)
      emit(firstValue, indent + 4, lines)
    }
    for (const [key, value] of entries.slice(1)) {
      if (isScalar(value)) lines.push(`${pad}  ${key}: ${formatScalar(value)}`)
      else if (isEmptyCollection(value)) lines.push(`${pad}  ${key}: ${inlineCollection(value)}`)
      else {
        lines.push(`${pad}  ${key}:`)
        emit(value, indent + 4, lines)
      }
    }
  }
}

function emit(value, indent, lines) {
  if (Array.isArray(value)) emitSequence(value, indent, lines)
  else emitMapping(value, indent, lines)
}

/**
 * Serialise a value to the subset dialect, with stable key order (insertion order of the object).
 *
 * @param value - the value to emit.
 * @returns the document text, ending with a newline.
 */
export function dumpYamlLite(value) {
  if (value === null || typeof value !== 'object') return `${formatScalar(value)}\n`
  const lines = []
  emit(value, 0, lines)
  return `${lines.join('\n')}\n`
}
