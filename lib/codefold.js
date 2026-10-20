/**
 * dsh-context-diet — code-skeleton folding.
 *
 * This is the piece neither parent project has:
 *
 *   - headroom never touches source code at all (its `noFoldForTools` default
 *     excludes read/edit/write, and `compressCode` is hard-off with the note
 *     "AST support is required").
 *   - Tianshu folds TS/JS/Py/JSON/Markdown only. A Rust/C kernel project gets
 *     nothing from it.
 *
 * The design constraint that makes folding safe here is *line-number parity*:
 * every line we drop is replaced by an explicit `… [elided a-b]` marker that
 * preserves the surrounding line numbers. A model that later edits by line
 * number still sees the exact boundaries, and the untouched original lives in
 * the CCR store behind `diet_restore`.
 *
 * Elision is meaning-preserving in the only sense that matters for navigation:
 * what survives is the import/use surface, the type/struct/enum/impl
 * declarations, every function signature, every structural closing brace at
 * file scope, and every doc comment.
 */

import { countLines, netBraces, splitLinePrefix } from './core.js'

export const CODE_FOLD_DEFAULTS = Object.freeze({
  /** Below this many lines nothing is folded (short files are already cheap). */
  minLines: 60,
  /** Never fold more aggressively than this, even for a huge file. */
  maxLines: 1200,
  /** Keep at least this many leading lines verbatim. */
  keepHeadLines: 6,
  /** Keep at least this many trailing lines verbatim. */
  keepTailLines: 6,
  /** A run of dropped lines must be at least this long to become a marker. */
  minElideRun: 3,
  /** Reject a fold that does not save at least this fraction of characters. */
  minSavingRatio: 0.25
})

const EXTENSION_LANGUAGE = {
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.mk': 'make',
  '.mak': 'make',
  '.toml': 'toml',
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'python',
  '.pyi': 'python',
  '.md': 'markdown',
  '.mdx': 'markdown'
}

const FILENAME_LANGUAGE = {
  makefile: 'make',
  'gnumakefile': 'make',
  'kconfig': 'conf',
  'cargo.toml': 'toml',
  'cmakelists.txt': 'make',
  'kbuild': 'make'
}

/** Derive a language from a path-like hint (`src/kernel/task/mod.rs`). */
export function languageFromPath(hint) {
  if (typeof hint !== 'string' || hint.length === 0) return null
  const cleaned = hint.replace(/\\/g, '/').trim().toLowerCase()
  const base = cleaned.slice(cleaned.lastIndexOf('/') + 1)
  if (Object.hasOwn(FILENAME_LANGUAGE, base)) return FILENAME_LANGUAGE[base]
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return EXTENSION_LANGUAGE[base.slice(dot)] ?? null
}

const RUST_ANCHOR_RE = new RegExp(
  String.raw`^(?:`
  + String.raw`#!?\[`                                            // attribute
  + String.raw`|//[/!]`                                           // doc comment
  + String.raw`|(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(?:fn|struct|enum|union|trait|impl|mod|use|type|static|macro_rules!)\b`
  + String.raw`)`
)

const C_ANCHOR_RE = new RegExp(
  String.raw`^(?:`
  + String.raw`#\s*(?:include|define|undef|ifndef|ifdef|endif|pragma|error)`
  + String.raw`|//[/!]`
  + String.raw`|(?:typedef|struct|enum|union|namespace|class|template|extern|static)\b`
  + String.raw`)`
)

const C_FUNCTION_LIKE_RE = /^[A-Za-z_][\w\s*]*\b\w+\s*\([^;{]*$/u

const TS_ANCHOR_RE = new RegExp(
  String.raw`^(?:`
  + String.raw`import\b|export\b`
  + String.raw`|(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|namespace)\b`
  + String.raw`|//`
  + String.raw`)`
)

const PYTHON_ANCHOR_RE = /^(?:import\b|from\b|@|class\b|def\b|async\s+def\b|#)/u
const MAKE_ANCHOR_RE = /^(?:\.PHONY\b|[A-Za-z_][\w./%$(){} -]*\s*:(?!=)|[A-Za-z_][A-Za-z0-9_]*\s*[:?+]?=|ifeq\b|ifneq\b|ifdef\b|ifndef\b|else\b|endif\b|include\b|export\b)/u
const TOML_ANCHOR_RE = /^(?:\[|[\w.-]+\s*=)/u
const MARKDOWN_ANCHOR_RE = /^(?:#{1,6}\s|```|---\s*$)/u

/** Content-based language sniff, used when no path hint was available. */
export function detectLanguage(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  const sample = text.slice(0, 20000)
  if (/(?:^|\n)\s*(?:fn\s+\w+|use\s+\w+::|impl\s+\w+|#\[derive\()/u.test(sample)) return 'rust'
  if (/(?:^|\n)\s*#\s*include\s*[<"]/u.test(sample)) return 'c'
  if (/(?:^|\n)\s*(?:package\s+main|func\s+\w+\()/u.test(sample)) return null
  if (/(?:^|\n)\s*(?:def\s+\w+\(|from\s+\w+\s+import\s)/u.test(sample)) return 'python'
  if (/(?:^|\n)\s*(?:export\s+(?:default\s+)?|import\s+.+from\s+['"])/u.test(sample)) return 'ts'
  if (/(?:^|\n)all:\s*(?:\n|\r)/u.test(sample) || /(?:^|\n)\.PHONY:/u.test(sample)) return 'make'
  if (/(?:^|\n)\s*\[[A-Za-z0-9_.-]+\]\s*(?:\n|\r)/u.test(sample)) return 'toml'
  return null
}

function trimBody(body) {
  return body.replace(/^\s+/, '').replace(/\s+$/, '')
}

/**
 * Language-specific anchor test.
 *
 * `depthBefore` / `depthAfter` are brace depths around the line, which is how
 * a structural closing brace at file scope is told apart from an inner one.
 */
function isAnchor(body, language, depthBefore) {
  const trimmed = trimBody(body)
  if (trimmed.length === 0) return false
  switch (language) {
    case 'rust':
      if (RUST_ANCHOR_RE.test(trimmed)) return true
      if (trimmed === '}' && depthBefore <= 1) return true
      // multi-line signature continuation (`-> Result<()> {`)
      if (depthBefore <= 2 && /^(?:\)\s*->.*|\s*->\s*.*|\{)$/u.test(trimmed) === false
          && /\bfn\b/u.test(trimmed) && trimmed.includes('(')) return true
      return false
    case 'c':
    case 'cpp':
      if (C_ANCHOR_RE.test(trimmed)) return true
      if (trimmed === '}' && depthBefore <= 1) return true
      if (depthBefore <= 1 && C_FUNCTION_LIKE_RE.test(trimmed)) return true
      return false
    case 'ts':
    case 'js':
      if (TS_ANCHOR_RE.test(trimmed)) return true
      if (trimmed === '}' && depthBefore <= 1) return true
      return false
    case 'python':
      return PYTHON_ANCHOR_RE.test(trimmed)
    case 'make':
      if (/^\t/u.test(body)) return false
      if (/^\t+@?/u.test(body)) return false
      return MAKE_ANCHOR_RE.test(trimmed)
    case 'toml':
    case 'conf':
      return TOML_ANCHOR_RE.test(trimmed)
    case 'markdown':
      return MARKDOWN_ANCHOR_RE.test(trimmed)
    default:
      return false
  }
}

function elideMarker(prefix, firstLineNo, lastLineNo) {
  const indent = prefix === '' ? '' : prefix.replace(/\d+/u, (digits) => ' '.repeat(digits.length))
  const range = firstLineNo === null ? '' : `${firstLineNo}-${lastLineNo}`
  return range === '' ? `${indent}… [elided]` : `${indent}… [elided ${range}]`
}

/**
 * Fold a code block down to its skeleton.
 *
 * @param {string} text
 * @param {{ hint?: string, language?: string } & Partial<typeof CODE_FOLD_DEFAULTS>} [options]
 * @returns {{
 *   changed: boolean,
 *   text: string,
 *   language: string|null,
 *   originalLines: number,
 *   keptLines: number,
 *   elidedLines: number,
 *   ranges: Array<{ from: number, to: number }>
 * }}
 */
export function foldCode(text, options = {}) {
  const limits = { ...CODE_FOLD_DEFAULTS, ...options }
  const originalLines = countLines(text)
  const noop = { changed: false, text, language: null, originalLines, keptLines: originalLines, elidedLines: 0, ranges: [] }
  if (typeof text !== 'string' || text.length === 0) return noop
  if (originalLines < limits.minLines) return noop

  const language = options.language ?? languageFromPath(options.hint) ?? detectLanguage(text)
  if (language === null) return noop

  const rawLines = text.split(/\r?\n/u)
  const parsed = rawLines.map((line) => splitLinePrefix(line))
  const keep = new Array(parsed.length).fill(false)

  let depth = 0
  // Block comments and `#` comments span or terminate lines differently per
  // language, so the depth tracker carries state across lines.
  const braceState = { hashComments: language === 'python' || language === 'make' || language === 'toml' }
  for (let index = 0; index < parsed.length; index += 1) {
    const body = parsed[index].body
    const depthBefore = depth
    depth += netBraces(body, braceState)
    if (index < limits.keepHeadLines || index >= parsed.length - limits.keepTailLines) {
      keep[index] = true
      continue
    }
    keep[index] = isAnchor(body, language, depthBefore)
  }

  const out = []
  const ranges = []
  let elidedLines = 0
  let index = 0
  while (index < parsed.length) {
    if (keep[index]) {
      out.push(rawLines[index])
      index += 1
      continue
    }
    let end = index
    while (end + 1 < parsed.length && !keep[end + 1]) end += 1
    const runLength = end - index + 1
    if (runLength < limits.minElideRun) {
      for (let cursor = index; cursor <= end; cursor += 1) out.push(rawLines[cursor])
      index = end + 1
      continue
    }
    // Line numbers come from the tool's own decoration when it has one, and
    // from the array position otherwise, so an elision marker always carries a
    // usable range instead of a bare "… [elided]".
    const firstNo = parsed[index].lineNo ?? index + 1
    const lastNo = parsed[end].lineNo ?? end + 1
    out.push(elideMarker(parsed[index].prefix, firstNo, lastNo))
    ranges.push({ from: firstNo, to: lastNo })
    elidedLines += runLength
    index = end + 1
  }

  const folded = out.join('\n')
  const keptLines = out.length
  if (keptLines > limits.maxLines) {
    // Even the skeleton is too large: fall back to head/tail around the cap.
    const headCount = Math.floor(limits.maxLines * 0.7)
    const tailCount = limits.maxLines - headCount
    const capped = [
      ...out.slice(0, headCount),
      `… [elided ${out.length - limits.maxLines} skeleton lines]`,
      ...out.slice(out.length - tailCount)
    ].join('\n')
    const savingRatio = 1 - capped.length / text.length
    if (savingRatio < limits.minSavingRatio) return noop
    return {
      changed: true,
      text: capped,
      language,
      originalLines,
      keptLines: headCount + tailCount + 1,
      elidedLines: originalLines - (headCount + tailCount),
      ranges
    }
  }

  const savingRatio = 1 - folded.length / text.length
  if (savingRatio < limits.minSavingRatio) return noop

  return { changed: true, text: folded, language, originalLines, keptLines, elidedLines, ranges }
}

/** Human-readable one-line description of a fold, used in the result marker. */
export function describeFold(result) {
  if (!result.changed) return ''
  return `code-skeleton ${result.language} ${result.originalLines}→${result.keptLines} lines (${result.elidedLines} elided)`
}
