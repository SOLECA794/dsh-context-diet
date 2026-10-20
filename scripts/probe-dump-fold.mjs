import { isDocumentDump, routeText } from '../lib/fold.js'
import { foldCode, detectLanguage } from '../lib/codefold.js'

const body = []
for (let i = 0; i < 300; i += 1) {
  const line = i % 10 === 0
    ? `pub fn f${i}(x: usize) -> usize {`
    : i % 10 === 9
      ? '}'
      : `    let y = x + ${i};`
  body.push(`${i + 1}\t${line}`)
}
const sample = ['===== signal.rs =====', ...body].join('\n')

console.log('isDocumentDump:', isDocumentDump(sample))
console.log('detectLanguage:', detectLanguage(sample))
const folded = foldCode(sample, {})
console.log('foldCode changed:', folded.changed, 'lang:', folded.language, 'lines', folded.originalLines, '->', folded.keptLines)
const outcome = routeText(sample, { toolName: 'run_code', codeSkeletonDocumentDumps: true })
console.log('routeText:', outcome.reducer, outcome.originalChars, '->', outcome.compressedChars)
