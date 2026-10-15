/**
 * Comment- and verbatim-aware static scanning of TeX sources.
 *
 * A naive `\begin`/`\end` or keyword scan lies in exactly the cases that matter for a *pre*-compile
 * check: a commented-out environment, a literal `\begin{itemize}` inside a `lstlisting` example, a
 * `\verb|\end{x}|` — none of them are TeX structure, but a plain regex counts them and then blocks
 * or "fixes" a document that was fine.
 *
 * So everything here works on {@link maskIgnorable} output: comments and literal environments
 * (verbatim, listings, minted, comment) are blanked to spaces — newlines are preserved so line
 * structure survives — while the `\begin{...}`/`\end{...}` tokens of those literal environments are
 * kept *normalised*, so a real unbalanced literal environment is still reported.
 *
 * This is a **bounded structural check**, not a TeX parser: it catches mismatched environments,
 * escaped markup that was meant to be typeset, shell-escape requests and declared inputs. It never
 * claims to validate TeX syntax, macros, dimensions or semantics.
 *
 * @module dsh-professor-spike/src/latex/scan
 */

/** Environments whose body is literal text and must never be scanned as structure. */
export const LITERAL_ENVIRONMENTS = new Set([
  'verbatim', 'Verbatim', 'BVerbatim', 'LVerbatim', 'alltt',
  'lstlisting', 'minted', 'comment',
])

/** Longest environment name the scanner will recognise (bounds the search work). */
const MAX_ENV_NAME = 64

const LETTER = /[a-zA-Z]/

/** Blank every character except newlines, so line structure survives the mask. */
function blank(text) {
  return text.replace(/[^\n]/g, ' ')
}

/** The `\end{...}` that closes a literal environment opened at `from`, or `-1`. */
function findLiteralEnd(text, name, from) {
  const pattern = new RegExp(`\\\\end\\s*\\{${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`)
  const match = pattern.exec(text.slice(from))
  return match === null ? -1 : from + match.index + match[0].length
}

/**
 * Mask comments, inline `\verb` and literal-environment bodies.
 *
 * @param source - the TeX source.
 * @returns a scan copy in which ignorable content is spaces (newlines preserved). The *output is
 *   for scanning only*: normalised tokens mean offsets in the result are not offsets in the input.
 */
export function maskIgnorable(source) {
  const text = String(source ?? '')
  const length = text.length
  let out = ''
  let i = 0

  while (i < length) {
    const char = text[i]

    if (char === '\\') {
      // \verb<delim>...<delim> (optionally \verb*<delim>): the body is literal text.
      if (text.startsWith('\\verb', i)) {
        let cursor = i + 5
        if (text[cursor] === '*') cursor += 1
        const delimiter = text[cursor] ?? ''
        if (delimiter !== '' && !LETTER.test(delimiter)) {
          const close = text.indexOf(delimiter, cursor + 1)
          const end = close === -1 ? length : close + 1
          out += blank(text.slice(i, end))
          i = end
          continue
        }
      }

      // \begin{env} — a literal environment keeps its (normalised) tokens and blanks its body.
      if (text.startsWith('\\begin', i)) {
        let cursor = i + 6
        while (cursor < length && (text[cursor] === ' ' || text[cursor] === '\n')) cursor += 1
        if (text[cursor] === '{') {
          const close = text.indexOf('}', cursor + 1)
          const name = close === -1 ? '' : text.slice(cursor + 1, close)
          if (name.length > 0 && name.length <= MAX_ENV_NAME) {
            const afterBegin = close + 1
            // Optional argument after the name (lstlisting/minted options): consume it too, it is
            // literal content of the opening token and may itself contain braces.
            let scan = afterBegin
            if (text[scan] === '[') {
              let depth = 0
              while (scan < length) {
                if (text[scan] === '[') depth += 1
                else if (text[scan] === ']') {
                  depth -= 1
                  if (depth === 0) { scan += 1; break }
                }
                scan += 1
              }
            }
            out += `\\begin{${name}}`
            if (LITERAL_ENVIRONMENTS.has(name)) {
              const end = findLiteralEnd(text, name, scan)
              if (end === -1) {
                out += blank(text.slice(scan))
                i = length
                continue
              }
              out += `${blank(text.slice(scan, end))}\\end{${name}}`
              i = end
              continue
            }
            i = scan
            continue
          }
        }
      }

      // Any other backslash: copy the whole control sequence — a control word (letters) or a
      // control symbol (exactly one non-letter, which includes `\\` and `\%`). Consuming the
      // symbol body is what keeps `\\begin{itemize}` (linebreak + text, NOT an environment) and
      // `\%` (a literal percent, NOT a comment) from being mis-read as structure.
      out += char
      i += 1
      if (i < length && !LETTER.test(text[i])) {
        out += text[i]
        i += 1
      }
      while (i < length && LETTER.test(text[i])) {
        out += text[i]
        i += 1
      }
      continue
    }

    if (char === '%') {
      // A comment runs to end of line. Backslash parity decides `\%` (literal) vs `\\%` (comment).
      let backslashes = 0
      for (let k = i - 1; k >= 0 && text[k] === '\\'; k -= 1) backslashes += 1
      if (backslashes % 2 === 0) {
        let end = i
        while (end < length && text[end] !== '\n') end += 1
        out += blank(text.slice(i, end))
        i = end
        continue
      }
    }

    out += char
    i += 1
  }

  return out
}

/**
 * Environment balance on an already-masked source.
 *
 * @param masked - output of {@link maskIgnorable}.
 * @returns `{ unbalanced, unclosed }`: `unbalanced` names environments closed by the wrong
 *   `\end`, `unclosed` names environments never closed.
 */
export function environmentBalance(masked) {
  const text = String(masked ?? '')
  // `(?<!\\)` keeps `\\begin{itemize}` — a linebreak followed by the *text* "begin{itemize}", which
  // TeX never reads as an environment — from being counted as a real `\begin`.
  const pattern = /(?<!\\)\\(begin|end)\s*\{([^}]*)\}/g
  const stack = []
  const unbalanced = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    const [, kind, name] = match
    if (kind === 'begin') {
      stack.push(name)
      continue
    }
    const open = stack.pop()
    if (open === undefined || open !== name) unbalanced.push(`${name} (opened as ${open ?? 'nothing'})`)
  }
  return { unbalanced, unclosed: stack }
}

/** Shell escape as found in a masked source (`\write18` / `\input{|…}`). */
export const SHELL_ESCAPE = /\\write18\b|\\input\s*\{\s*\|/

/**
 * Literal escaped markup: text that *looks like* LaTeX only because it was escaped on render
 * (`\textbackslash{}\begin{tabular}` or `\{begin\{itemize\}`), i.e. a semantic environment was
 * put where the renderer escapes and it will print as text.
 *
 * @param masked - output of {@link maskIgnorable}, so comments describing this very pattern do not
 *   trip it.
 */
export const ESCAPED_MARKUP = [
  /\\textbackslash\s*\\?\{\\?\}\s*begin\s*\\?\{/,
  /\\\{begin\\\{/,
]
