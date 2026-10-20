/**
 * Replay a real session log through dsh-context-diet's L1 path and report what it
 * would actually have done.
 *
 * This is the verification the goal asked for: not a synthetic benchmark, but the
 * tool results a real kernel session produced. It answers three questions the unit
 * tests cannot:
 *
 *   1. What fraction of real tool-result bytes would L1 have reduced?
 *   2. Did it ever touch a byte-contract result (`read`) or a source path?
 *   3. Can every reduction be restored byte for byte?
 *
 * Usage: node scripts/replay-session.mjs <session.v4.jsonl.zstd> [--limit N]
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--'))
if (file === undefined) {
  console.error('usage: node scripts/replay-session.mjs <session.v4.jsonl.zstd> [--limit N]')
  process.exit(2)
}
const limitIndex = args.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity
/** documentDumps mode for the run: fold (default) | protect | off. */
const dumpsIndex = args.indexOf('--dumps')
const dumpMode = dumpsIndex >= 0 ? String(args[dumpsIndex + 1]) : 'fold'

/* ------------------------------------------------------------------ *
 * Multi-frame zstd. A dsh session log is a sequence of independent frames;
 * zstdDecompressSync on the whole file stops after the first one.
 * ------------------------------------------------------------------ */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function readFrames(path) {
  const buf = readFileSync(path)
  const offsets = []
  for (let at = buf.indexOf(MAGIC, 0); at >= 0; at = buf.indexOf(MAGIC, at + 4)) offsets.push(at)
  const parts = []
  let failed = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      failed += 1
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, failed }
}

const { text, frames, failed } = readFrames(file)
const lines = text.split('\n').filter((line) => line.length > 0)
console.log(`frames ${frames} (${failed} unreadable) · ${lines.length} events`)

/* ------------------------------------------------------------------ *
 * Collect tool results with the call that produced them.
 * ------------------------------------------------------------------ */
const calls = new Map()
const results = []
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const data = event?.data
  if (event?.type === 'tool/call') {
    // The persisted shape is { turn, step, callId, name, arguments } — `callId`, not `id`.
    const call = data?.call ?? data
    const id = call?.callId ?? call?.id
    if (id !== undefined) calls.set(id, call)
    continue
  }
  if (event?.type !== 'tool/result') continue
  const message = data?.message
  if (message === null || typeof message !== 'object') continue
  const blocks = Array.isArray(message.content) ? message.content : []
  const body = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
  if (body.length === 0) continue
  const call = calls.get(message.toolCallId) ?? {}
  results.push({
    toolName: String(call.name ?? data?.name ?? 'unknown'),
    args: parseArgs(call.arguments ?? data?.arguments),
    text: body
  })
}

function parseArgs(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

console.log(`tool results with text: ${results.length}`)

const byTool = new Map()
for (const result of results) byTool.set(result.toolName, (byTool.get(result.toolName) ?? 0) + 1)
console.log('by tool:', [...byTool.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}:${count}`).join(' '))

// The denominator that matters for cost: every byte of tool output the model saw,
// not just the blocks big enough to be worth folding.
const totalContextChars = results.reduce((sum, result) => sum + result.text.length, 0)
console.log(`tool output seen by the model: ${totalContextChars} chars`)

/* ------------------------------------------------------------------ *
 * Replay through the real L1 code path.
 * ------------------------------------------------------------------ */
const scratch = mkdtempSync(join(tmpdir(), 'diet-replay-'))
process.env.DSH_HOME = scratch

const { resolveLimits, routeText, applyReduction } = await import(new URL('../lib/fold.js', import.meta.url).href)
const { createStore } = await import(new URL('../lib/ccr.js', import.meta.url).href)

const store = createStore({ enabled: true, persist: false })
await store.init()

const limits = resolveLimits({ documentDumps: dumpMode })
const PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'file', 'filename'])

function pathHintOf(args) {
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === 'string' && value.length > 0 && PATH_KEYS.has(key)) return value
  }
  return ''
}

function globMatch(value, patterns) {
  const normalized = String(value).replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return patterns.some((pattern) => {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    const regex = new RegExp(`^${source}$`, 'i')
    return regex.test(normalized) || (base !== normalized && regex.test(base))
  })
}

const stats = {
  considered: 0,
  skippedProtectedTool: 0,
  skippedProtectedPath: 0,
  skippedTooSmall: 0,
  unchanged: 0,
  reduced: 0,
  originalChars: 0,
  keptChars: 0,
  restoreChecked: 0,
  restoreFailed: 0
}
const perTool = new Map()
const perReducer = new Map()
const biggest = []

let seen = 0
for (const result of results) {
  if (seen >= limit) break
  seen += 1
  const chars = result.text.length
  if (limits.noFoldForTools.includes(result.toolName)) {
    stats.skippedProtectedTool += 1
    continue
  }
  const hint = pathHintOf(result.args)
  if (hint !== '' && globMatch(hint, limits.noFoldForPatterns)) {
    stats.skippedProtectedPath += 1
    continue
  }
  if (chars < limits.minChars) {
    stats.skippedTooSmall += 1
    continue
  }
  stats.considered += 1
  stats.originalChars += chars

  const outcome = routeText(result.text, {
    toolName: result.toolName,
    limits,
    foldCode: true,
    pathHint: hint === '' ? undefined : hint
  })
  if (!outcome.changed) {
    stats.unchanged += 1
    stats.keptChars += chars
    continue
  }
  stats.reduced += 1
  stats.keptChars += outcome.compressedChars
  perTool.set(result.toolName, (perTool.get(result.toolName) ?? 0) + (chars - outcome.compressedChars))
  perReducer.set(outcome.reducer, (perReducer.get(outcome.reducer) ?? 0) + 1)
  biggest.push({ toolName: result.toolName, reducer: outcome.reducer, before: chars, after: outcome.compressedChars })

  // The claim has to survive a round trip on the real bytes, not on a fixture.
  const id = store.put({
    toolName: result.toolName,
    callId: '',
    reducer: outcome.reducer,
    originalText: result.text,
    compressedChars: outcome.compressedChars
  })
  const entry = store.get(id)
  stats.restoreChecked += 1
  if (entry === null || entry.originalText !== result.text) stats.restoreFailed += 1
}

const saved = stats.originalChars - stats.keptChars
const pct = stats.originalChars > 0 ? (saved / stats.originalChars) * 100 : 0

console.log('\n--- L1 replay ---')
console.log(`results replayed        ${seen}`)
console.log(`skipped: byte contract  ${stats.skippedProtectedTool}  (read/write/edit/...)`)
console.log(`skipped: source path    ${stats.skippedProtectedPath}  (noFoldForPatterns)`)
console.log(`skipped: under minChars ${stats.skippedTooSmall}`)
console.log(`above minChars          ${stats.considered}`)
console.log(`  reduced               ${stats.reduced}`)
console.log(`  left unchanged        ${stats.unchanged}`)
console.log(`chars ${stats.originalChars} → ${stats.keptChars}  saved ${saved} (${pct.toFixed(1)}%)`)
console.log(`restore round-trip      ${stats.restoreChecked - stats.restoreFailed}/${stats.restoreChecked} exact`)

if (perReducer.size > 0) {
  console.log('\nby reducer:', [...perReducer.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`).join(' '))
}
if (perTool.size > 0) {
  console.log('chars saved by tool:')
  for (const [name, savedChars] of [...perTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${name.padEnd(14)} ${String(savedChars).padStart(9)}`)
  }
}
if (biggest.length > 0) {
  console.log('\nlargest reductions:')
  for (const entry of biggest.sort((a, b) => b.before - a.before).slice(0, 8)) {
    console.log(`  ${entry.toolName.padEnd(12)} ${entry.reducer.padEnd(16)} ${String(entry.before).padStart(8)} → ${String(entry.after).padStart(7)}`)
  }
}

assert.equal(stats.restoreFailed, 0, 'every reduction must restore byte for byte')
rmSync(scratch, { recursive: true, force: true })
