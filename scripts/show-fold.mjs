/**
 * Show what a folded document dump actually looks like, so the claim "line
 * numbers still address the real file" can be checked by eye instead of trusted.
 *
 * Usage: node scripts/show-fold.mjs <session.v4.jsonl.zstd> [toolResultIndex]
 */

import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const wanted = process.argv[3] === undefined ? 0 : Number(process.argv[3])
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
  } catch { /* trailing frame may be incomplete while live */ }
}
const lines = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)

const results = []
for (const line of lines) {
  let event
  try { event = JSON.parse(line) } catch { continue }
  if (event?.type !== 'tool/result') continue
  const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
  const body = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
  if (body.length > 0) results.push(body)
}

const { resolveLimits, routeText, isDocumentDump } = await import(new URL('../lib/fold.js', import.meta.url).href)
const limits = resolveLimits({})
const text = results[wanted]
if (text === undefined) {
  console.error(`no result at index ${wanted} (have ${results.length})`)
  process.exit(2)
}

console.log(`result #${wanted}: ${text.length} chars, documentDump=${isDocumentDump(text, limits)}\n`)
const outcome = routeText(text, { toolName: 'run_code', limits, foldCode: true })
console.log(`reducer=${outcome.reducer} ${outcome.originalChars} → ${outcome.compressedChars}\n--- folded ---`)
console.log(outcome.text.slice(0, 4000))
