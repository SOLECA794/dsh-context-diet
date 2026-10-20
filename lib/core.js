/**
 * dsh-context-diet — shared primitives.
 *
 * Deliberately dependency-free (no `node:*` imports) so every reducer can be
 * unit-tested in isolation, and so the same code runs inside the plugin body
 * and inside the tools this plugin registers.
 */

/**
 * Token estimate tuned for mixed CJK/ASCII payloads.
 *
 * The harness-wide convention is `ceil(len / 4)`, which underestimates CJK by
 * roughly 3x. Splitting the two scripts fixes the common case (Chinese prose
 * mixed with English identifiers) without a tokenizer dependency.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (
      (cp >= 0x3400 && cp <= 0x4dbf)
      || (cp >= 0x4e00 && cp <= 0x9fff)
      || (cp >= 0x3040 && cp <= 0x30ff)
      || (cp >= 0xac00 && cp <= 0xd7af)
      || (cp >= 0x20000 && cp <= 0x2a6df)
    ) {
      wide += 1
    } else {
      ascii += 1
    }
  }
  return Math.ceil(ascii / 4) + Math.ceil(wide / 1.2)
}

/**
 * Token estimate for a string known to be pure ASCII, without materialising it.
 *
 * Used by the fixed-fill detector, which compares a reported `prompt_tokens`
 * against a 130 KB prompt — walking 130 K code points to learn `len / 4` is
 * pointless work.
 */
export function estimateAsciiTokens(charCount) {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0
  return Math.ceil(charCount / 4)
}

/** Compile a `*` wildcard pattern, treating every other regexp character literally. */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

export function isGlobMatch(name, patterns) {
  if (typeof name !== 'string' || name.length === 0) return false
  return patterns.some((pattern) => globToRegExp(pattern).test(name))
}

/** Keep the head and tail of a long string, with an explicit length marker. */
export function truncateMiddle(text, maxChars) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxChars) return text
  const head = Math.max(0, Math.floor(maxChars * 0.6))
  const tail = Math.max(0, maxChars - head)
  return `${text.slice(0, head)}…[len ${text.length}]${text.slice(-tail)}`
}

/**
 * Line count, ignoring one trailing newline.
 *
 * `'a\nb\n'.split('\n')` has three entries but the file has two lines, and every
 * line-oriented tool (`wc -l`, editors, `sed -n`) agrees with two. Folding
 * thresholds are compared against this, so the trailing empty segment must not
 * count as content.
 */
export function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let count = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  if (text.charCodeAt(text.length - 1) === 10) count -= 1
  return count
}

/**
 * Split a tool-result line into its line-number decoration and its body.
 *
 * File readers in the harness decorate every line (`  12: body`, `12→body`,
 * `12| body`, or `12\tbody`). Reducers must preserve the decoration verbatim so
 * that a model can still address the file by line number after folding.
 *
 * `lineNo` is `null` (not `undefined`) when the line carries no decoration, so
 * `??` fallbacks stay explicit at the call site.
 */
export function splitLinePrefix(line) {
  const match = /^(\s*)(\d+)(:\s?|\|\s?|→\s?|\t\s?)/.exec(line)
  if (match === null) return { prefix: '', body: line, lineNo: null }
  return {
    prefix: match[1] + match[2] + match[3],
    body: line.slice(match[0].length),
    lineNo: Number(match[2])
  }
}

/**
 * Net brace balance of one line, aware of string literals and comments.
 *
 * Depth tracking is what makes elided ranges land on the right lines, so a `}`
 * inside a string or a `// }` comment must not move the depth. Block comments
 * span lines, so the caller threads a `state` object through consecutive calls:
 *
 * ```js
 * const state = {}
 * for (const line of lines) depth += netBraces(line, state)
 * ```
 *
 * @param {string} body
 * @param {{ blockComment?: boolean, hashComments?: boolean }} [state] mutated in place
 */
export function netBraces(body, state = {}) {
  if (typeof body !== 'string' || body.length === 0) return 0
  let net = 0
  let quote = null
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index]
    if (state.blockComment === true) {
      if (ch === '*' && body[index + 1] === '/') {
        state.blockComment = false
        index += 1
      }
      continue
    }
    if (quote !== null) {
      if (ch === '\\') { index += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && body[index + 1] === '/') return net
    if (ch === '/' && body[index + 1] === '*') {
      state.blockComment = true
      index += 1
      continue
    }
    if (ch === '#' && state.hashComments === true) return net
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') net += 1
    else if (ch === '}') net -= 1
  }
  return net
}

/** Stable short hash for retrieval ids and dedupe keys (djb2, 64-bit folded). */
export function hashShort(text) {
  let h1 = 5381
  let h2 = 52711
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = ((h1 << 5) + h1 + code) >>> 0
    h2 = ((h2 << 5) + h2 + (code ^ 0x9e37)) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16)
}

/** Byte length of a string in UTF-8, without allocating a Buffer per call site. */
export function utf8Bytes(text) {
  if (typeof text !== 'string') return 0
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp < 0x80) bytes += 1
    else if (cp < 0x800) bytes += 2
    else if (cp < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** Percentage saved, rounded to one decimal, guarding the zero case. */
export function savedPct(originalChars, compressedChars) {
  if (!(originalChars > 0)) return 0
  return Math.round(((originalChars - compressedChars) / originalChars) * 1000) / 10
}
