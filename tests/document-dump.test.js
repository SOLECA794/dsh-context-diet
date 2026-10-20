import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { stripLineNumbers } from '../lib/core.js'
import { detectLanguage, foldCode } from '../lib/codefold.js'
import { FOLD_DEFAULTS, isDocumentDump, resolveLimits, routeText } from '../lib/fold.js'

/** A line-numbered dump of `count` Rust lines, the shape a PTC program prints. */
function rustDump(count) {
  const lines = ['===== signal.rs =====']
  for (let index = 0; index < count; index += 1) {
    const body = index % 12 === 0
      ? `pub fn handler_${index}(signo: usize) -> usize {`
      : index % 12 === 11
        ? '}'
        : `    let bit = 1usize << ${index};`
    lines.push(`${index + 1}\t${body}`)
  }
  return lines.join('\n')
}

describe('stripLineNumbers', () => {
  it('removes every decoration form', () => {
    const text = '1\talpha\n2: beta\n3| gamma\n4→ delta'
    assert.equal(stripLineNumbers(text), 'alpha\nbeta\ngamma\ndelta')
  })

  it('leaves undecorated lines alone', () => {
    assert.equal(stripLineNumbers('plain\nlines'), 'plain\nlines')
  })

  it('returns an empty string for non-text', () => {
    assert.equal(stripLineNumbers(null), '')
    assert.equal(stripLineNumbers(undefined), '')
  })
})

describe('detectLanguage on line-numbered dumps', () => {
  it('recognises a Rust dump that every decoration hides', () => {
    // Without stripping, `12\tpub fn` never matches a `^`-anchored pattern and the
    // dump silently comes back unfolded.
    assert.equal(detectLanguage(rustDump(120)), 'rust')
  })

  it('recognises a bare `pub fn` with no `use` or attribute to lean on', () => {
    assert.equal(detectLanguage('pub fn only(x: usize) -> usize {\n    x\n}'), 'rust')
  })

  it('still refuses a non-code dump', () => {
    assert.equal(detectLanguage('1\talpha\n2\tbeta\n3\tgamma'), null)
  })
})

describe('isDocumentDump', () => {
  it('accepts line-numbered content', () => {
    assert.equal(isDocumentDump(rustDump(60)), true)
  })

  it('rejects a grep result, whose digits are never at line start', () => {
    const grep = Array.from({ length: 40 }, (_, index) => `src/kernel/mm.rs:${index + 1}:    let x = ${index};`).join('\n')
    assert.equal(isDocumentDump(grep), false)
  })

  it('rejects prose that merely contains numbers', () => {
    const prose = Array.from({ length: 40 }, (_, index) => `step ${index} finished at ${index * 3}ms`).join('\n')
    assert.equal(isDocumentDump(prose), false)
  })

  it('rejects a short dump below the line floor', () => {
    assert.equal(isDocumentDump(rustDump(8)), false)
  })

  it('rejects numbering that does not ascend', () => {
    const lines = Array.from({ length: 60 }, (_, index) => `${60 - index}\tbody ${index}`)
    assert.equal(isDocumentDump(lines.join('\n')), false)
  })

  it('honours the configured floor and ratio', () => {
    const dump = rustDump(30)
    assert.equal(isDocumentDump(dump, { documentDumpMinLines: 40, documentDumpRatio: 0.3 }), false)
    assert.equal(isDocumentDump(dump, { documentDumpMinLines: 20, documentDumpRatio: 0.3 }), true)
  })
})

describe('routeText on document dumps', () => {
  const dump = rustDump(400)

  it('folds structurally by default and keeps the line numbers addressable', () => {
    const outcome = routeText(dump, { toolName: 'run_code' })
    assert.equal(outcome.reducer, 'code-skeleton')
    assert.ok(outcome.compressedChars < outcome.originalChars)
    // The decoration is what lets the model cite `signal.rs:37` after folding.
    assert.match(outcome.text, /^\d+\t/mu)
    assert.match(outcome.text, /… \[elided \d+-\d+\]/u)
  })

  it('never head/tail-truncates a dump under the default policy', () => {
    // The default reducer list for run_code withholds text-head/tail entirely, so
    // even a dump that cannot be folded must come back byte-identical.
    const unfolded = routeText('1\talpha\n2\tbeta', { toolName: 'run_code' })
    assert.equal(unfolded.changed, false)
    assert.equal(unfolded.text, '1\talpha\n2\tbeta')
  })

  it("leaves a dump intact under documentDumps: 'protect'", () => {
    const limits = resolveLimits({ documentDumps: 'protect' })
    const outcome = routeText(dump, { toolName: 'run_code', limits })
    assert.equal(outcome.changed, false)
    assert.equal(outcome.text, dump)
  })

  it("restores the old destructive behaviour only under documentDumps: 'off'", () => {
    const limits = resolveLimits({ documentDumps: 'off' })
    // `pwsh` still lists text-head/tail, so this is where the old path lives.
    const outcome = routeText(dump, { toolName: 'pwsh', limits, foldCode: false })
    assert.equal(outcome.changed, true)
    assert.notEqual(outcome.reducer, 'code-skeleton')
  })

  it('stays inert for run_code even with the guard off, because its reducers are safe', () => {
    const limits = resolveLimits({ documentDumps: 'off' })
    const outcome = routeText(dump, { toolName: 'run_code', limits, foldCode: false })
    // Nothing destructive is offered to run_code, so turning the guard off cannot
    // resurrect the head/tail cut that mangled source dumps.
    assert.equal(outcome.changed, false)
  })

  it('refuses to fold when folding is disabled, rather than falling through', () => {
    const outcome = routeText(dump, { toolName: 'run_code', foldCode: false })
    assert.equal(outcome.changed, false)
  })
})

describe('run_code reducer policy', () => {
  it('withholds the blind reducers for run_code', () => {
    const listing = Array.from({ length: 700 }, (_, index) => `.rivet/artifacts/file-${index}.raw`).join('\n')
    // A program printed this listing on purpose; cutting its middle loses the answer.
    const outcome = routeText(listing, { toolName: 'run_code' })
    assert.equal(outcome.changed, false)
  })

  it('still folds a run_code log', () => {
    const log = ['Compiling kernel v0.1.0', 'error[E0308]: mismatched types', '  --> src/mm.rs:131:24']
    for (let index = 0; index < 200; index += 1) log.push(`   Compiling crate_${index} v0.1.0`)
    log.push('error: could not compile `kernel`')
    const outcome = routeText(log.join('\n'), { toolName: 'run_code' })
    assert.equal(outcome.reducer, 'log-fold')
    assert.match(outcome.text, /E0308/u)
  })

  it('still pivots run_code JSON', () => {
    const rows = Array.from({ length: 400 }, (_, index) => ({ id: index, path: `/src/file-${index}.rs`, size: index * 7 }))
    const outcome = routeText(JSON.stringify(rows), { toolName: 'run_code' })
    assert.equal(outcome.reducer, 'json-pivot')
  })
})

describe('foldCode on a decorated dump', () => {
  it('preserves the original line numbers in the elision markers', () => {
    const folded = foldCode(rustDump(300), {})
    assert.equal(folded.changed, true)
    assert.equal(folded.language, 'rust')
    const markers = [...folded.text.matchAll(/… \[elided (\d+)-(\d+)\]/gu)]
    assert.ok(markers.length > 0)
    for (const marker of markers) {
      const from = Number(marker[1])
      const to = Number(marker[2])
      assert.ok(from >= 1 && to <= 301, `range ${from}-${to} must lie inside the dump`)
      assert.ok(from <= to)
    }
  })
})

describe('FOLD_DEFAULTS document-dump knobs', () => {
  it('are frozen and default to folding', () => {
    assert.equal(Object.isFrozen(FOLD_DEFAULTS), true)
    assert.equal(FOLD_DEFAULTS.documentDumps, 'fold')
    assert.equal(FOLD_DEFAULTS.documentDumpMinLines, 20)
    assert.equal(FOLD_DEFAULTS.documentDumpRatio, 0.3)
  })
})
