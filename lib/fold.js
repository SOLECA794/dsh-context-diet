/**
 * dsh-context-diet — the append-time content router.
 *
 * One entry point, `routeText()`, picks the cheapest reversible reduction for a
 * tool-result text block and applies it. The routing table is deliberately
 * conservative: a reducer that cannot prove a win returns `null` and the block
 * is left byte-identical.
 *
 * Reducer inventory (and where each came from):
 *
 *   json-pivot      headroom SmartCrusher lineage — arrays of objects become
 *                   `_keys`/`_rows`/`_common` so repeated key names vanish
 *   search-fold     headroom lineage, plus exit-aware "no matches" collapse
 *   log-fold        headroom lineage, plus Rust/cargo/compiler diagnostics
 *                   (`error[E0308]`, `warning:`, `test result:`) and dedupe
 *   tabular-fold    headroom lineage — keep header, first N, last M
 *   code-skeleton   NEW: Rust / C / C++ / make / toml / ts / py skeletons with
 *                   line-number-preserving elision markers
 *   shell-summary   Tianshu `context-collapse` lineage — one line: exit code,
 *                   failing assertions, tail
 *   test-summary    Tianshu lineage — `42/85 passed · 43 failed · exit 1`
 *   text-head/tail  last resort for prose
 *
 * Everything lossy is reversible through the CCR store; the caller supplies the
 * retrieval id and the marker is appended by `applyReduction()`.
 */

import { countLines, estimateTokens, truncateMiddle } from './core.js'
import { detectLanguage, foldCode } from './codefold.js'

/** @typedef {'json'|'search'|'log'|'tabular'|'code'|'shell'|'test'|'text'} ContentKind */

export const FOLD_DEFAULTS = Object.freeze({
  /**
   * Never touch a block smaller than this many chars.
   *
   * Was 4000. Measured on a real kernel session (`session-c1ca1479`): only 70 of
   * 1322 tool results cleared 4000, so 678 foldable blocks carrying 783,347 chars
   * — 40% of all tool output — flowed through untouched, and the ceiling on the
   * whole session was 20.6% of tool bytes. Sweeping the floor with the real
   * reducers showed the curve is not flat: 4000 → 20.6%, 1500 → 37.5%,
   * 1000 → 40.1%, 600 → 40.9%. The floor was a guess and it was the binding
   * constraint, not the reducers.
   */
  minChars: 1000,
  /** A reduction must save at least this fraction or it is discarded. */
  minSavingRatio: 0.08,
  /**
   * Absolute floor on bytes saved, not just the ratio.
   *
   * A ratio alone is the wrong test once small blocks are eligible: an 8% win on
   * a 1000-char block is 80 chars, which does not pay for the `[diet: …]`
   * retrieval marker (~60 chars), the `ctx_restore` round trip if the model needs
   * the bytes back, or the chance it never needs them and the saving is noise.
   * Savings must be worth claiming before they are claimed.
   */
  minSavedChars: 400,
  /** JSON: rows kept before offload, and per-cell truncation. */
  maxRows: 80,
  maxCellChars: 200,
  /** Search: matches kept per file. */
  maxSearchMatchesPerFile: 60,
  /** Log: lines kept around the head/tail/errors. */
  maxLogLines: 80,
  /** Tabular: lines kept. */
  maxTabularLines: 80,
  /** Prose head/tail budget, in chars. */
  maxTextChars: 2400,
  /** Shell summary: tail lines quoted verbatim. */
  shellTailLines: 12,
  /** Shell summary: failing-assertion lines quoted verbatim. */
  shellFailLines: 20,
  /** Shell summary: verdict lines (`*_PASS`, `OK`, `done`) quoted verbatim. */
  shellVerdictLines: 20,
  /** Code folding knobs (see codefold.js). */
  codeMinLines: 60,
  codeMaxLines: 1200,
  /**
   * Document-dump guard. A "document dump" is line-numbered file content that a
   * program printed (what `tools.read` returns, echoed through `console.log`).
   * Blind truncation of one is always wrong: the model asked for that document.
   *
   *   'fold'    (default) fold it structurally — line numbers preserved, bodies
   *             elided, reversible; fall back to leaving it intact
   *   'protect' leave it byte-identical
   *   'off'     old behaviour: let the generic reducers truncate it
   */
  documentDumps: 'fold',
  documentDumpMinLines: 20,
  documentDumpRatio: 0.3,
  /** Tool names whose results must never be reduced (byte contracts). */
  noFoldForTools: ['read', 'write', 'edit', 'str_replace_editor', 'apply_patch', 'diet_restore'],
  /** Path globs that protect a result even when the tool name is generic. */
  noFoldForPatterns: ['*.rs', '*.c', '*.h', '*.cpp', '*.hpp', '*.js', '*.ts', '*.json', '*.yml', '*.yaml', '*.toml'],
  /** Marker verbosity: 'full' explains the reducer, 'compact' prints only the id. */
  markerStyle: 'full'
})

export function resolveLimits(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object') return FOLD_DEFAULTS
  return Object.freeze({ ...FOLD_DEFAULTS, ...overrides })
}

/* ------------------------------------------------------------------ *
 * Tool hints
 * ------------------------------------------------------------------ */

/**
 * Tool name → preferred reducers, most specific first.
 *
 * `null` means "protected": the result is a byte contract another tool reads
 * back (a file body), so folding it would desynchronise read → edit.
 */
const TOOL_HINTS = new Map([
  ['read', null],
  ['write', null],
  ['edit', null],
  ['str_replace_editor', null],
  ['diet_restore', null],
  ['grep', ['search-fold', 'text-head/tail']],
  ['glob', ['search-fold', 'text-head/tail']],
  ['pwsh', ['shell-summary', 'code-skeleton', 'log-fold', 'json-pivot', 'tabular-fold', 'text-head/tail']],
  ['bash', ['shell-summary', 'code-skeleton', 'log-fold', 'json-pivot', 'tabular-fold', 'text-head/tail']],
  ['job_output', ['log-fold', 'shell-summary', 'json-pivot', 'text-head/tail']],
  /**
   * Under the PTC preset every call arrives as `run_code`, so the tool name says
   * nothing about the bytes: the program chose what to print. The blind reducers
   * (`text-head/tail`, `shell-summary`) are therefore withheld — a program that
   * printed a 700-path listing did so on purpose, and cutting its middle destroys
   * the answer. Only reducers that preserve the information survive here.
   */
  ['run_code', ['log-fold', 'test-summary', 'json-pivot', 'search-fold', 'tabular-fold']],
  ['web_fetch', ['text-head/tail']],
  ['web_search', ['text-head/tail']],
  ['ctx_audit', null],
  ['ctx_stats', null],
  ['ctx_restore', null],
  /**
   * Another plugin's retrieval and status surfaces.
   *
   * billion-context keeps its own content store and hands text back through
   * `decompress` / `acp_retrieve`; folding that result destroys the very bytes
   * the model asked to get back, and it is invisible to a replay because those
   * results are usually short. The status panels (`acp_status`, `acp_cache`) are
   * the same class: their entire value is the exact lines they print. These are
   * byte contracts in everything but name, so they are listed as such.
   */
  ['decompress', null],
  ['acp_retrieve', null],
  ['acp_read_original_image', null],
  ['acp_status', null],
  ['acp_cache', null],
  ['compress', null],
  ['absorb', null]
])

/**
 * Resolve a tool's reducer preference.
 *
 * Three outcomes, and the difference between the last two is load-bearing:
 *   - an array  → try these reducers, in this order
 *   - `null`    → this tool's output is a byte contract, never touch it
 *   - `undefined` → unknown tool; fall back to kind detection
 *
 * `??` must not be used to normalise the lookup: it would collapse the `null`
 * sentinel into `undefined` and silently start truncating file reads.
 */
function hintFor(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined
  const key = toolName.replace(/^.*[/.]/u, '').toLowerCase()
  return TOOL_HINTS.has(key) ? TOOL_HINTS.get(key) : undefined
}

/* ------------------------------------------------------------------ *
 * Document-dump detection
 * ------------------------------------------------------------------ */

/**
 * One line of line-numbered content: `  12\tbody`, `12: body`, `12| body`.
 *
 * Grep output is deliberately excluded — it is `path:line:body`, so the digits
 * are never at the start of the line and `SEARCH_LINE_RE` claims it first.
 */
const NUMBERED_LINE_RE = /^\s*(\d+)(?:\t|\s*[:|]\s+)(.*)$/u

/**
 * Is this block a document dump — line-numbered content a program printed?
 *
 * Measured on a real PTC kernel session: 40 of 45 reductions were this shape, and
 * every one of them was a source file or a Markdown document the model had asked
 * to read. `text-head/tail` cut a 35,536-char `signal.rs` dump to 2,425 chars,
 * which is the head of the file and nothing else. The reducer was "working".
 *
 * A document dump must never be blind-truncated. It may be folded structurally
 * (line numbers preserved, bodies elided, reversible) when the operator opts in.
 */
export function isDocumentDump(text, limits = FOLD_DEFAULTS) {
  if (typeof text !== 'string' || text.length === 0) return false
  const lines = text.split(/\r?\n/u)
  let nonEmpty = 0
  let numbered = 0
  let lastNumber = -1
  let ordered = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    nonEmpty += 1
    const match = NUMBERED_LINE_RE.exec(line)
    if (match === null) continue
    numbered += 1
    const number = Number(match[1])
    // Numbering that mostly ascends is a dump; scattered integers are prose.
    if (number > lastNumber) ordered += 1
    lastNumber = number
  }
  if (numbered < (limits.documentDumpMinLines ?? 20)) return false
  if (numbered / Math.max(1, nonEmpty) < (limits.documentDumpRatio ?? 0.3)) return false
  return ordered / numbered >= 0.7
}

/* ------------------------------------------------------------------ *
 * Kind detection
 * ------------------------------------------------------------------ */

const SEARCH_LINE_RE = /^([^\s:][^:]*?):(\d+)(?::(\d+))?:(.*)$/u
const LOG_SIGNAL_RE = /\b(?:error|errors|failed|failure|fatal|panic|exception|traceback|assert|assertion|warning)\b/iu
const RUST_ERROR_RE = /^(?:error(?:\[[A-Z]\d+\])?|warning)(?::|\s)/u
const TEST_RESULT_RE = /^(?:test result:|Tests?:\s|ok\s+\d+\s+passed|FAILED\b|PASSED\b|\d+\s+passed)/mu
const EXIT_LINE_RE = /^(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*(-?\d+)|\[exit code:\s*(-?\d+)\]|\*\*\*\s*exit\s+(-?\d+))/imu
/**
 * Lines that only appear in build output.
 *
 * A single-failure build log can be 240 lines of `Compiling …` around one
 * `error[E0308]`. Counting log *signals* alone classifies that as plain text, and
 * the plain-text reducer then head/tail-truncates the one line that matters.
 */
const BUILD_NOISE_RE = /^(?:\s*(?:Compiling|Finished|Building|Downloading|Installing|Blocking|Checking|Documenting|Fresh|running \d+ tests?)\b|--> )/u

/** Detect the structural kind of a text block. `hint` biases the answer. */
export function detectKind(text, hint) {
  if (typeof text !== 'string' || text.trim().length === 0) return 'text'

  if (hint === 'shell' || hint === 'test') return hint

  if (hint !== 'text') {
    const trimmed = text.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') return 'json'
      } catch { /* not json */ }
    }
  }

  const lines = text.split(/\r?\n/u)
  let nonEmpty = 0
  let searchMatches = 0
  let logSignals = 0
  let rustErrors = 0
  let buildNoise = 0
  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue
    nonEmpty += 1
    if (SEARCH_LINE_RE.test(rawLine)) searchMatches += 1
    if (LOG_SIGNAL_RE.test(rawLine)) logSignals += 1
    if (RUST_ERROR_RE.test(rawLine.trim())) rustErrors += 1
    if (BUILD_NOISE_RE.test(rawLine)) buildNoise += 1
  }

  if (searchMatches >= 3 && searchMatches / Math.max(1, nonEmpty) >= 0.6) return 'search'
  if (TEST_RESULT_RE.test(text) && logSignals >= 2) return 'test'

  // One error wrapped in compiler chatter is still a build log.
  if (buildNoise >= 3 && (rustErrors >= 1 || logSignals >= 1)) return 'log'
  if (hint !== 'text' && (rustErrors >= 1 || logSignals >= 4)) return 'log'

  if (nonEmpty >= 6) {
    const first = lines.find((line) => line.trim() !== '') ?? ''
    const commas = (first.match(/,/gu) ?? []).length
    const tabs = (first.match(/\t/gu) ?? []).length
    const pipes = (first.match(/\|/gu) ?? []).length
    if (commas >= 3 || tabs >= 2 || (pipes >= 2 && lines.some((line) => /^\s*\|?\s*:?-{2,}/u.test(line)))) {
      return 'tabular'
    }
  }

  return hint === 'shell' ? 'shell' : 'text'
}

/* ------------------------------------------------------------------ *
 * JSON pivot
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.toString.call(value) === '[object Object]'
}

function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    return ak.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

function safeStringify(value) {
  try { return JSON.stringify(value) } catch { return null }
}

function cell(value, maxCellChars) {
  if (typeof value === 'string') return truncateMiddle(value, maxCellChars)
  return value
}

function pivotRows(rows, limits) {
  const keyOrder = []
  const seen = new Set()
  for (const row of rows.slice(0, 200)) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue
      seen.add(key)
      keyOrder.push(key)
      if (keyOrder.length >= 80) break
    }
    if (keyOrder.length >= 80) break
  }

  const common = {}
  for (const key of keyOrder) {
    const first = rows[0][key]
    if (rows.every((row) => deepEqual(row[key], first))) common[key] = cell(first, limits.maxCellChars)
  }

  const pivotKeys = keyOrder.filter((key) => !Object.hasOwn(common, key))
  const kept = rows.slice(0, limits.maxRows)
  const out = {
    _keys: pivotKeys,
    _rows: kept.map((row) => pivotKeys.map((key) => cell(row[key], limits.maxCellChars))),
    _count: rows.length
  }
  if (Object.keys(common).length > 0) out._common = common
  if (rows.length > kept.length) out._omittedRows = rows.length - kept.length
  return out
}

function crushValue(value, limits) {
  if (Array.isArray(value)) {
    if (value.length === 0) return value
    if (value.length > 1 && value.every(isPlainObject)) return pivotRows(value, limits)
    const seen = new Set()
    const unique = []
    let duplicates = 0
    for (const item of value) {
      const key = safeStringify(item) ?? String(item)
      if (seen.has(key)) { duplicates += 1; continue }
      seen.add(key)
      unique.push(crushValue(item, limits))
    }
    const kept = unique.slice(0, limits.maxRows)
    const out = [...kept]
    if (duplicates > 0) out.push({ _diet: `duplicates: ${duplicates}` })
    if (unique.length > kept.length) out.push({ _diet: `omitted: ${unique.length - kept.length}` })
    return out
  }
  if (isPlainObject(value)) {
    let changed = false
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        const next = truncateMiddle(child, limits.maxCellChars)
        if (next !== child) changed = true
        out[key] = next
      } else if (child !== null && typeof child === 'object') {
        const next = crushValue(child, limits)
        if (next !== child) changed = true
        out[key] = next
      } else {
        out[key] = child
      }
    }
    return changed ? out : value
  }
  return value
}

function reduceJson(text, limits) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  if (parsed === null || typeof parsed !== 'object') return null
  const crushed = crushValue(parsed, limits)
  if (crushed === parsed) return null
  const rendered = safeStringify(crushed)
  if (rendered === null || rendered.length >= text.length) return null
  return rendered
}

/* ------------------------------------------------------------------ *
 * Search fold
 * ------------------------------------------------------------------ */

function reduceSearch(text, limits) {
  const lines = text.split(/\r?\n/u)
  const groups = new Map()
  let nonEmpty = 0
  let matched = 0
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue
    nonEmpty += 1
    const match = SEARCH_LINE_RE.exec(line)
    if (match === null) continue
    matched += 1
    const file = match[1]
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push({ lineNo: match[2], col: match[3], rest: match[4] ?? '' })
  }
  if (matched < 3 || matched / Math.max(1, nonEmpty) < 0.5) return null

  const out = []
  let omitted = 0
  for (const [file, matches] of groups) {
    out.push(`${file} (${matches.length} match${matches.length === 1 ? '' : 'es'})`)
    for (const match of matches.slice(0, limits.maxSearchMatchesPerFile)) {
      const col = match.col === undefined ? '' : `:${match.col}`
      // Kept match lines stay byte-identical: the whole point of a search
      // result is that the model can locate and verify without re-grepping.
      out.push(`${match.lineNo}${col}: ${match.rest}`)
    }
    omitted += Math.max(0, matches.length - limits.maxSearchMatchesPerFile)
  }
  if (omitted > 0) out.push(`… [${omitted} matches omitted]`)
  const result = out.join('\n')
  return result.length < text.length ? result : null
}

/* ------------------------------------------------------------------ *
 * Log fold
 * ------------------------------------------------------------------ */

const KEEP_LINE_RE = new RegExp(
  String.raw`(?:\b(?:error|failed|failure|fatal|panic|exception|traceback|assert|assertion)`
  + String.raw`|^\s*error(?:\[[A-Z]\d+\])?`
  + String.raw`|^\s*warning`
  + String.raw`|^test result:`
  + String.raw`|^\s*(?:\d+\s+passed|FAILED|failures?:)`
  + String.raw`|^\s*---\s+FAILED`
  + String.raw`|^\s*thread\s+'[^']*'\s+panicked`
  + String.raw`|^\s*note:\s)`,
  'iu'
)

function dedupeRuns(lines) {
  const out = []
  let previous = null
  let run = 0
  const flush = () => {
    if (run <= 0) return
    // The run's first line was already emitted. Replace it in place instead of
    // appending a second copy, or every collapsed run doubles its own first line
    // and the marker stops matching what the log actually contained.
    out.pop()
    out.push(`${previous} [repeated ${run + 1}x]`)
  }
  for (const line of lines) {
    if (line === previous) { run += 1; continue }
    flush()
    out.push(line)
    previous = line
    run = 0
  }
  flush()
  return out
}

/**
 * Evidence that a block is a *log* and not merely long.
 *
 * `reduceLog` keeps the head, the tail, and the signal lines. On a genuine log
 * that is the right trade. On a 700-path listing it degenerates into exactly the
 * blind head/tail cut the document-dump guard exists to prevent — every signal
 * line is absent, so the middle simply vanishes. A log must therefore show at
 * least two signal lines before it is treated as one.
 */
const LOG_EVIDENCE_RE = /(?:\b(?:error|warn|failed|failure|fatal|panic|exception|traceback|assert)|\bCompiling\b|\bFinished\b|\bBuilding\b|\bChecking\b|test result:|running \d+ tests?|---\s+FAILED|thread '[^']*' panicked)/iu

function reduceLog(text, limits) {
  const rawLines = text.split(/\r?\n/u)
  if (rawLines.length < 20) return null
  let evidence = 0
  for (const line of rawLines) {
    if (LOG_EVIDENCE_RE.test(line)) evidence += 1
    if (evidence >= 2) break
  }
  if (evidence < 2) return null
  const collapsed = dedupeRuns(rawLines)
  const total = collapsed.length
  const kept = new Set()
  for (let index = 0; index < total; index += 1) {
    if (KEEP_LINE_RE.test(collapsed[index])) {
      kept.add(index)
      kept.add(Math.max(0, index - 1))
      kept.add(Math.min(total - 1, index + 1))
    }
  }
  const headLines = Math.max(0, Math.floor(limits.maxLogLines / 2))
  const tailLines = Math.max(0, limits.maxLogLines - headLines)
  const out = []
  let omitted = 0
  let open = false
  for (let index = 0; index < total; index += 1) {
    const isEdge = index < headLines || index >= total - tailLines
    if (isEdge || kept.has(index)) {
      if (open) {
        out.push(`… [${omitted} lines omitted]`)
        open = false
        omitted = 0
      }
      out.push(collapsed[index])
    } else if (open) {
      omitted += 1
    } else {
      open = true
      omitted = 1
    }
  }
  if (open) out.push(`… [${omitted} lines omitted]`)
  const result = out.join('\n')
  return result.length < text.length ? result : null
}

/* ------------------------------------------------------------------ *
 * Tabular fold
 * ------------------------------------------------------------------ */

/**
 * Does this block actually have a table shape?
 *
 * `reduceTabular` keeps the head and the tail, so on a non-tabular block it is a
 * plain head/tail cut in disguise — a 700-path listing would lose its middle
 * silently. A real table repeats the same delimiter count on every row, which is
 * what this checks before any row is dropped.
 */
function looksTabular(lines) {
  const sample = lines.slice(0, 20).filter((line) => line.trim() !== '')
  if (sample.length < 5) return false
  const rules = [
    { delimiter: '\t', floor: 1 },
    { delimiter: ',', floor: 2 },
    { delimiter: '|', floor: 2 }
  ]
  for (const { delimiter, floor } of rules) {
    const counts = sample.map((line) => line.split(delimiter).length - 1)
    const min = Math.min(...counts)
    const max = Math.max(...counts)
    if (min >= floor && max - min <= 1) return true
  }
  return false
}

function reduceTabular(text, limits) {
  const lines = text.split(/\r?\n/u)
  if (lines.length < 6) return null
  if (!looksTabular(lines)) return null
  const keepHead = Math.max(1, Math.floor(limits.maxTabularLines / 2))
  const keepTail = Math.max(1, limits.maxTabularLines - keepHead)
  const omitStart = keepHead
  const omitEnd = lines.length - keepTail
  if (omitEnd <= omitStart) return null
  const out = [
    ...lines.slice(0, omitStart),
    `… [${omitEnd - omitStart} rows omitted]`,
    ...lines.slice(omitEnd)
  ]
  const result = out.join('\n')
  return result.length < text.length ? result : null
}

/* ------------------------------------------------------------------ *
 * Shell summary (Tianshu context-collapse lineage)
 * ------------------------------------------------------------------ */

const FAIL_LINE_RE = /(?:\bFAIL(?:ED|URE)?\b|\bError\b|error:|panicked|assert(?:ion)?\s+(?:failed|failure)|\bnot ok\b)/u
/**
 * Lines that state a verdict rather than report progress.
 *
 * A kernel boot smoke run is 32 lines of `[blk] stat req=…` whose entire point
 * is stated twice: `VFS_BACKENDS_PASS` and `M1 paging/trap foundation OK`. A
 * plain head+tail summary keeps the head line and the last twelve `[blk]` noise
 * lines, i.e. it throws away exactly the two lines the run existed to produce.
 * Anything that reads as a verdict is therefore quoted in full, whatever it
 * looks like.
 */
const VERDICT_LINE_RE = /(?:PASS(?:ED)?\b|FAIL(?:ED|URE)?\b|\bOK\b|\bDONE\b|\bpanicked\b|\bassert(?:ion)?\b|^\s*={2,}.*={2,}\s*$|^\s*---\s+\S+\s+---\s*$)/u
const PASS_SUMMARY_RE = /(?:test result:\s*ok\.|(\d+)\s+passed|all\s+tests?\s+passed|PASSED)/iu
const FAIL_SUMMARY_RE = /(?:test result:\s*FAILED\.|\b(\d+)\s+failed\b|\bFAILED\b)/iu

/** Pull an exit code out of the trailing part of a shell result, if present. */
export function extractExitCode(text) {
  const match = EXIT_LINE_RE.exec(text)
  if (match === null) return null
  const raw = match[1] ?? match[2] ?? match[3]
  const code = Number(raw)
  return Number.isFinite(code) ? code : null
}

function reduceShell(text, limits) {
  const lines = text.split(/\r?\n/u)
  if (lines.length < 12) return null
  const exitCode = extractExitCode(text)
  const failing = []
  const verdicts = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (FAIL_LINE_RE.test(line)) {
      if (failing.length < limits.shellFailLines) failing.push({ index, line })
      continue
    }
    if (VERDICT_LINE_RE.test(line) && verdicts.length < limits.shellVerdictLines) {
      verdicts.push({ index, line })
    }
  }
  const tail = lines.slice(-limits.shellTailLines)
  const first = lines.find((line) => line.trim() !== '') ?? ''

  const parts = [`[collapsed shell: ${countLines(text)} lines`]
  if (exitCode !== null) parts.push(`exit ${exitCode}`)
  parts.push(`≈${estimateTokens(text)} tok]`)
  const header = parts.join(', ').replace(', ≈', ' · ≈')

  const out = [header]
  /**
   * The harness's own failure marker, re-emitted verbatim.
   *
   * `[exit code: N]` is not decoration: it is the only failure signal a shell
   * result carries in this harness (measured on a 771-result session: zero
   * results had `value.exitCode`, zero had `isError: true`, 53 carried the
   * marker in text). Other plugins parse that literal — a verification ledger
   * that cannot see it records a failed check as a pass. The header's `exit N`
   * is for humans; this line is the contract.
   */
  if (exitCode !== null) out.push(`[exit code: ${exitCode}]`)
  if (failing.length > 0) {
    out.push(`fails (${failing.length}):`)
    for (const entry of failing) out.push(`  L${entry.index + 1}: ${truncateMiddle(entry.line.trim(), 220)}`)
  }
  if (verdicts.length > 0) {
    out.push(`verdicts (${verdicts.length}):`)
    for (const entry of verdicts) out.push(`  L${entry.index + 1}: ${truncateMiddle(entry.line.trim(), 220)}`)
  }
  out.push(`head: ${truncateMiddle(first.trim(), 220)}`)
  out.push('tail:')
  for (const line of tail) out.push(`  ${truncateMiddle(line, 220)}`)
  const result = out.join('\n')
  return result.length < text.length ? result : null
}

/* ------------------------------------------------------------------ *
 * Test summary (Tianshu lineage)
 * ------------------------------------------------------------------ */

function reduceTest(text, limits) {
  const lines = text.split(/\r?\n/u)
  if (lines.length < 8) return null
  let passed = 0
  let failed = 0
  const failures = []
  for (const line of lines) {
    const passMatch = /(\d+)\s+passed/iu.exec(line)
    if (passMatch !== null) passed = Math.max(passed, Number(passMatch[1]))
    const failMatch = /(\d+)\s+failed/iu.exec(line)
    if (failMatch !== null) failed = Math.max(failed, Number(failMatch[1]))
    if (/^\s*---\s+FAILED|^\s*failures:\s*$/u.test(line)) {
      // following `  name` lines carry the failing case names
      continue
    }
    if (/^\s{2,}\S+::\S+$|^\s+[a-z_]+::[a-z_]+/u.test(line) && failures.length < limits.shellFailLines) {
      failures.push(line.trim())
    }
  }
  if (passed === 0 && failed === 0) return null
  const exitCode = extractExitCode(text)
  const out = [`[collapsed tests: ${passed + failed || '?'} tests · ${failed} failed · ${passed} passed${exitCode === null ? '' : ` · exit ${exitCode}`}]`]
  if (failures.length > 0) {
    out.push(`failures (${failures.length}):`)
    for (const name of failures) out.push(`  ${name}`)
  }
  for (const line of lines.slice(-Math.min(6, limits.shellTailLines))) out.push(`  ${truncateMiddle(line, 200)}`)
  const result = out.join('\n')
  return result.length < text.length ? result : null
}

/* ------------------------------------------------------------------ *
 * Prose head/tail
 * ------------------------------------------------------------------ */

function reduceText(text, limits) {
  if (text.length <= limits.maxTextChars) return null
  const head = Math.floor(limits.maxTextChars * 0.65)
  const tail = limits.maxTextChars - head
  return `${text.slice(0, head)}\n… [${text.length - head - tail} chars omitted]\n${text.slice(-tail)}`
}

/* ------------------------------------------------------------------ *
 * Dispatcher
 * ------------------------------------------------------------------ */

const REDUCERS = {
  'json-pivot': reduceJson,
  'search-fold': reduceSearch,
  'log-fold': reduceLog,
  'tabular-fold': reduceTabular,
  'shell-summary': reduceShell,
  'test-summary': reduceTest,
  'text-head/tail': reduceText
}

/**
 * The reducer a kind should try first.
 *
 * This is a table rather than `${kind}-fold` string building because the names
 * genuinely differ (`json` → `json-pivot`, `test` → `test-summary`,
 * `text` → `text-head/tail`). Building the name by concatenation silently
 * produced keys that are not in `REDUCERS`, so JSON results fell through to the
 * shell summary — which truncates instead of pivoting.
 */
const KIND_REDUCER = {
  json: 'json-pivot',
  search: 'search-fold',
  log: 'log-fold',
  tabular: 'tabular-fold',
  shell: 'shell-summary',
  test: 'test-summary',
  text: 'text-head/tail',
  code: 'text-head/tail'
}

/**
 * Kinds confident enough to outrank a tool's own preference order.
 *
 * `text` is deliberately absent: it is the fallback when nothing was recognised,
 * and its reducer (`text-head/tail`) is the bluntest one available. Promoting it
 * to the front would make every unrecognised `pwsh` result get head/tail-cut
 * before `log-fold` or `json-pivot` ever ran.
 */
const CONFIDENT_KINDS = new Set(['json', 'search', 'log', 'tabular', 'test'])

function reducersFor(toolName, kind) {
  const natural = KIND_REDUCER[kind]
  const hinted = hintFor(toolName)
  if (hinted === null) return []
  if (Array.isArray(hinted)) {
    // Put a confidently-detected kind's reducer first, but keep the tool's own
    // preference order for everything else (a pwsh result may still be JSON).
    const ordered = CONFIDENT_KINDS.has(kind) && natural !== undefined
      ? [natural, ...hinted]
      : [...hinted]
    return [...new Set(ordered)].filter((name) => REDUCERS[name] !== undefined)
  }
  return natural === undefined ? [] : [natural]
}

/**
 * Does this block read as source code that was *printed*, rather than as output?
 *
 * `pwsh`/`bash` results are the largest foldable share of a real session (62% of
 * tool bytes), but a big slice of them is not shell output at all — it is the
 * agent printing a file (`head -70 src/klib/lock.rs`, a `grep -n` over a module).
 * Measured on session-c1ca1479: `shell-summary` cut the *middle* out of exactly
 * those blocks, deleting the functions the model had asked to see, because the
 * tool's reducer list put a byte-shaving reducer first. A skeleton is the right
 * answer for them, and it is only reachable if the block is recognised as code
 * before the tool's list gets a turn.
 *
 * Deliberately not applied to structured tools (`run_code`): there the program
 * already decided what to print, and second-guessing it is how you lose answers.
 */
const CODE_LINE_RE = /^\s*(?:(?:pub(?:\([^)]*\))?|async|unsafe|extern|static|default|const)\s+)*fn\s|^\s*(?:impl|struct|enum|trait|mod|use|let|match|type|return|else|loop|while|for|if)\b|^\s*[})\]]|^\s*(?:#!?\[|\/\/|\/\*|\*)|^\s*(?:def|class|import|from|package|func|export)\b|;\s*$|^\s*@[\w.]+/u

export function looksLikeCode(text, threshold = 0.3) {
  if (typeof text !== 'string') return false
  // The language sniffer is the authority on "is this source at all"; the
  // density check only guards against a log that happens to contain a `fn`.
  // Both are needed: `detectLanguage` alone accepts one `impl` line in 5,000
  // chars of QEMU output, and density alone accepts a `cargo build` log whose
  // indented error notes look like anchored statements.
  if (detectLanguage(text) === null) return false
  let checked = 0
  let code = 0
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    checked += 1
    if (CODE_LINE_RE.test(line)) code += 1
    if (checked >= 400) break
  }
  // Eight lines is where a fragment stops being a line the model pasted and
  // starts being a region of a file; below that, `head`/`tail` is harmless.
  return checked >= 8 && code / checked >= threshold
}

/**
 * Is a candidate reduction worth claiming?
 *
 * Both tests must pass, and they are not redundant. `minSavingRatio` says the
 * reduction is meaningful *relative to the block*; `minSavedChars` says it is
 * meaningful in absolute terms, which is what pays for the retrieval marker and
 * the restore risk. A tiny block cut in half clears neither by accident, and a
 * large block barely dented clears the ratio but not the absolute floor.
 */
function savesEnough(candidateChars, originalChars, limits) {
  const saved = originalChars - candidateChars
  if (saved < (limits.minSavedChars ?? 0)) return false
  return 1 - candidateChars / originalChars >= limits.minSavingRatio
}

/**
 * Reduce one text block.
 *
 * @param {string} text
 * @param {{ toolName?: string, hint?: string, limits?: object, foldCode?: boolean }} [options]
 * @returns {{
 *   text: string, changed: boolean, reducer: string,
 *   originalChars: number, compressedChars: number
 * }}
 */
export function routeText(text, options = {}) {
  const limits = options.limits ?? FOLD_DEFAULTS
  const originalChars = typeof text === 'string' ? text.length : 0
  const noop = { text, changed: false, reducer: 'none', originalChars, compressedChars: originalChars }
  if (typeof text !== 'string' || originalChars === 0) return noop
  if (originalChars < limits.minChars) return noop

  const toolName = options.toolName ?? ''
  const hinted = hintFor(toolName)
  if (hinted === null) return noop

  // A document dump outranks every heuristic below. The model asked for this
  // content, so the only defensible reduction is a structural, line-preserving
  // fold — and if that is impossible the block stays byte-identical rather than
  // being head/tail-cut.
  //
  // Checked against the real session: 28 dumps, 14 of which `foldCode` refuses
  // (36,405 chars). Sampling them showed *why* they refuse, and it is the
  // argument for leaving the fallback alone: they are already-curated excerpts
  // (`=== syscall dispatch 180-265 ===` followed by exactly those numbered
  // lines, or a run of `pub fn` declarations with the bodies already dropped).
  // There is nothing left to elide, so the fold saves <8%, so the branch returns
  // the block untouched — correctly. Falling back to `shell-summary` here would
  // cut the middle out of the one thing the model asked to see, which is the
  // exact regression this guard was built to prevent.
  if (limits.documentDumps !== 'off' && isDocumentDump(text, limits)) {
    if (limits.documentDumps === 'fold' && options.foldCode !== false) {
      const folded = foldCode(text, {
        hint: options.pathHint,
        minLines: limits.codeMinLines,
        maxLines: limits.codeMaxLines
      })
      if (folded.changed && savesEnough(folded.text.length, originalChars, limits)) {
        return {
          text: folded.text,
          changed: true,
          reducer: 'code-skeleton',
          originalChars,
          compressedChars: folded.text.length
        }
      }
    }
    return noop
  }

  const kind = detectKind(text, options.hint)

  // Code skeletons get first refusal: they preserve structure and line numbers,
  // so they beat every byte-shaving reducer on information per token. Shell
  // tools are included when the block itself reads as code, because for them the
  // reducer list would otherwise win with a middle-cutting summary.
  const shellShaped = Array.isArray(hinted) && hinted.includes('shell-summary')
  const printedCode = shellShaped && looksLikeCode(text)
  const codeShaped = kind === 'code' || options.hint === 'code' || printedCode
  if (options.foldCode !== false && codeShaped) {
    const folded = foldCode(text, {
      hint: options.pathHint,
      minLines: limits.codeMinLines,
      maxLines: limits.codeMaxLines
    })
    if (folded.changed && savesEnough(folded.text.length, originalChars, limits)) {
      return {
        text: folded.text,
        changed: true,
        reducer: 'code-skeleton',
        originalChars,
        compressedChars: folded.text.length
      }
    }
    // A printed code region that cannot be skeletonised stays byte-identical.
    // The model ran `head -70 src/…` to *see* those lines; a summary that keeps
    // the first and last twelve and drops the middle deletes exactly what was
    // asked for. Same rule the document-dump branch above already follows.
    if (printedCode) return noop
  }

  for (const name of reducersFor(toolName, kind)) {
    const reducer = REDUCERS[name]
    if (reducer === undefined) continue
    const candidate = reducer(text, limits)
    if (candidate === null) continue
    if (!savesEnough(candidate.length, originalChars, limits)) continue
    return { text: candidate, changed: true, reducer: name, originalChars, compressedChars: candidate.length }
  }

  return noop
}

/** Append the retrieval marker that makes a reduction reversible. */
export function applyReduction(outcome, retrievalId, style = 'full') {
  if (!outcome.changed) return outcome.text
  if (style === 'compact') return `${outcome.text}\n\n[diet: id="${retrievalId}"]`
  return `${outcome.text}\n\n[diet: ${outcome.reducer} ${outcome.originalChars}→${outcome.compressedChars} chars; ctx_restore(id="${retrievalId}")]`
}

export const internals = {
  reduceJson,
  reduceSearch,
  reduceLog,
  reduceTabular,
  reduceShell,
  reduceTest,
  reduceText,
  looksLikeCode,
  pivotRows,
  dedupeRuns,
  reducersFor,
  hintFor,
  isDocumentDump
}
