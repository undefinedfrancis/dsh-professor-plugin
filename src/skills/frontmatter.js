/**
 * Frontmatter parsing for bundled skills.
 *
 * The Harness parses skill frontmatter with a full YAML parser; this plugin has no dependencies
 * of its own, so it reads only the subset the skill contract needs — `name`, `description`,
 * `whenToUse`-style strings and the two invocation booleans — while accepting the block scalars
 * (`>` / `|`) that real skills use.
 *
 * @module dsh-professor-spike/src/skills/frontmatter
 */

/** Locate the closing `---` fence of a frontmatter block (mirrors the Harness scan). */
export function findClosingFrontmatter(raw, start) {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

function dedent(lines) {
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^\s*/)[0].length)
  const cut = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(cut))
}

/** Fold a YAML `>` block scalar: wrapped lines join with a space, a blank line starts a new line. */
function foldBlock(lines) {
  const blocks = []
  let current = []
  for (const line of dedent(lines)) {
    const text = line.trim()
    if (text.length === 0) {
      if (current.length > 0) {
        blocks.push(current.join(' '))
        current = []
      }
      continue
    }
    current.push(text)
  }
  if (current.length > 0) blocks.push(current.join(' '))
  return blocks.join('\n').trim()
}

/** Parse the frontmatter subset these skills use. */
export function parseFrontmatterSubset(text) {
  const data = {}
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) continue // owned by the parent key
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const rest = match[2].trim()
    if (/^[>|][+-]?$/.test(rest)) {
      const block = []
      let cursor = index + 1
      while (cursor < lines.length && (lines[cursor].trim().length === 0 || /^\s/.test(lines[cursor]))) {
        block.push(lines[cursor])
        cursor += 1
      }
      index = cursor - 1
      const content = dedent(block)
      data[key] = rest.startsWith('>')
        ? foldBlock(block)
        : content.map((entry) => entry.replace(/\s+$/, '')).join('\n').trim()
      continue
    }
    data[key] = unquote(rest)
  }
  return data
}

/**
 * Split a SKILL.md into frontmatter data and body.
 *
 * @returns `{ data, body }`, or undefined when the file has no frontmatter block.
 */
export function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  return { data: parseFrontmatterSubset(raw.slice(start, closing.start)), body: raw.slice(closing.bodyStart) }
}

/** Mirror of the Harness `frontmatterBoolean`: booleans, 1/0, and the usual word forms. */
export function frontmatterBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
      default: return undefined
    }
  }
  return undefined
}

/** Canonical invocation keys, with the same defaults the Harness applies when they are absent. */
export function invocationPolicy(data) {
  const disableModelInvocation = frontmatterBoolean(data['disable-model-invocation'])
  const userInvocable = frontmatterBoolean(data['user-invocable'])
  return { modelInvocable: disableModelInvocation !== true, userInvocable: userInvocable !== false }
}

/** Non-empty trimmed string field, or undefined. */
export function stringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
