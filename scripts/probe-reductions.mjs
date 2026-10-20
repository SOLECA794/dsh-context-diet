/**
 * Judge the replay's reductions instead of trusting their total.
 *
 * A 76% saving means nothing until you look at what was cut. Under the PTC preset
 * every tool call is `run_code`, so the tool NAME tells us nothing about what the
 * bytes are — the program decides. This probe classifies each reduction by what it
 * actually contains, so the default policy can be set from evidence.
 */

import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = readFileSync(file)
const offsets = []
for (let at = buf.indexOf(MAGIC, 0); at >= 0; at = buf.indexOf(MAGIC, at + 4)) offsets.push(at)
const parts = []
for (let index = 0; index < offsets.length; index += 1) {
  const start = offsets[index]
  const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
  } catch {
    /* a truncated tail frame is expected while the session is live */
  }
}
const lines = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)

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
    const id = data?.callId ?? data?.id
    if (id !== undefined) calls.set(id, data)
    continue
  }
  if (event?.type !== 'tool/result') continue
  const message = data?.message
  const blocks = Array.isArray(message?.content) ? message.content : []
  const body = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
  if (body.length === 0) continue
  results.push({ call: calls.get(message.toolCallId) ?? {}, text: body })
}

const { resolveLimits, routeText } = await import(new URL('../lib/fold.js', import.meta.url).href)
const limits = resolveLimits({})

/** Shapes that mean "this blob is content the program deliberately printed". */
const LINE_NUMBERED = /^\s*\d+\t/m
const LINE_NUMBERED_COUNT = /^\s*\d+\t/gm

function classify(text) {
  const numbered = (text.match(LINE_NUMBERED_COUNT) ?? []).length
  const lines2 = text.split('\n').length
  const traits = []
  if (numbered >= 20 && numbered / lines2 > 0.3) traits.push('doc-dump')
  if (/error\[E\d{4}\]|^\s*--> /m.test(text)) traits.push('rust-diag')
  if (/^Compiling |^Finished |^\s*Running /m.test(text)) traits.push('cargo')
  if (/^\+ |^- |^@@ /m.test(text)) traits.push('diff')
  if (/test result:|^\s*\d+ passed/m.test(text)) traits.push('test-report')
  if (/^\s*at .*:\d+:\d+\)?$/m.test(text)) traits.push('stacktrace')
  if (/\{\s*"|^\s*"[^"]+"\s*:/m.test(text)) traits.push('json-ish')
  if (/^\s*[A-Za-z0-9_.-]+\s*$/m.test(text) && lines2 > 100) traits.push('listing')
  return { numbered, lines: lines2, traits }
}

const rows = []
for (const result of results) {
  if (result.text.length < limits.minChars) continue
  const outcome = routeText(result.text, { toolName: 'run_code', limits, foldCode: true })
  if (!outcome.changed) continue
  const info = classify(result.text)
  const head = result.text.slice(0, 160).replace(/\n/g, ' ⏎ ')
  rows.push({
    reducer: outcome.reducer,
    before: result.text.length,
    after: outcome.compressedChars,
    traits: info.traits.join(',') || 'none',
    docShare: info.lines > 0 ? (info.numbered / info.lines).toFixed(2) : '0',
    head
  })
}

rows.sort((a, b) => b.before - a.before)
console.log(`${rows.length} reductions\n`)
for (const row of rows) {
  const risky = row.traits.includes('doc-dump') ? ' ⚠ DOC-DUMP' : ''
  console.log(`${row.reducer.padEnd(15)} ${String(row.before).padStart(7)} → ${String(row.after).padStart(6)}  [${row.traits}] num=${row.docShare}${risky}`)
  console.log(`    ${row.head.slice(0, 150)}`)
}

const riskyCount = rows.filter((row) => row.traits.includes('doc-dump')).length
const riskyChars = rows.filter((row) => row.traits.includes('doc-dump')).reduce((sum, row) => sum + row.before, 0)
console.log(`\ndoc-dump shaped reductions: ${riskyCount} / ${rows.length}, ${riskyChars} chars of ${rows.reduce((sum, row) => sum + row.before, 0)}`)
