import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FOLD_DEFAULTS,
  applyReduction,
  detectKind,
  extractExitCode,
  internals,
  resolveLimits,
  routeText
} from '../lib/fold.js'

function buildLog() {
  const lines = []
  for (let index = 0; index < 200; index += 1) lines.push('   Compiling klib v0.1.0 (/mnt/d/kernel-project/src/klib)')
  lines.push('error[E0308]: mismatched types')
  lines.push('  --> src/kernel/mm/memory_set.rs:131:24')
  lines.push('131|         self.map_into(page_table)')
  lines.push('   |              ^^^^^^^^^^^^^^^^^^ expected `()`, found `Result<(), MemoryError>`')
  for (let index = 0; index < 40; index += 1) lines.push(`   Finished dev target(s) in ${index}.0s`)
  return lines.join('\n')
}

function grepOutput() {
  const lines = []
  for (let file = 0; file < 10; file += 1) {
    for (let index = 0; index < 50; index += 1) {
      lines.push(`src/kernel/task/mod${file}.rs:${index + 10}:    fn schedule_${index}() { todo!() }`)
    }
  }
  return lines.join('\n')
}

function jsonPayload() {
  const items = Array.from({ length: 200 }, (_, index) => ({
    id: index,
    name: `task_${index}`,
    state: 'ready',
    path: `/src/kernel/mm/${index}.rs`
  }))
  return JSON.stringify({ items, total: 200 }, null, 2)
}

test('detectKind classifies the shapes this plugin routes', () => {
  assert.equal(detectKind('{"a":1}'), 'json')
  assert.equal(detectKind(grepOutput()), 'search')
  assert.equal(detectKind(buildLog(), 'shell'), 'shell')
  assert.equal(detectKind(buildLog()), 'log')
  assert.equal(detectKind('a,b,c,d\n1,2,3,4\n5,6,7,8\n9,10,11,12\n13,14,15,16\n17,18,19,20'), 'tabular')
  assert.equal(detectKind('just a sentence'), 'text')
  assert.equal(detectKind(''), 'text')
})

test('detectKind honours an explicit shell hint', () => {
  // A shell result must stay a shell result even when it contains log words,
  // otherwise the shell summary (which states the exit code) never runs.
  const text = 'error: something failed\n'
  assert.equal(detectKind(text, 'shell'), 'shell')
})

test('extractExitCode reads the three harness exit shapes', () => {
  assert.equal(extractExitCode('ok\n\nexit code: 0'), 0)
  assert.equal(extractExitCode('boom\n\n[exit code: 2]'), 2)
  assert.equal(extractExitCode('*** exit 127'), 127)
  assert.equal(extractExitCode('no marker here'), null)
})

test('routeText keeps build errors and drops the compile noise', () => {
  const log = buildLog()
  const result = routeText(log, { toolName: 'pwsh' })
  assert.equal(result.changed, true)
  assert.equal(result.reducer, 'log-fold')
  assert.ok(result.compressedChars < result.originalChars)

  // The lines that matter survive verbatim.
  assert.match(result.text, /error\[E0308\]: mismatched types/)
  assert.match(result.text, /--> src\/kernel\/mm\/memory_set\.rs:131:24/)
  assert.match(result.text, /expected `\(\)`, found `Result<\(\), MemoryError>`/)
  // The repeated compile lines collapse into a counted marker.
  assert.match(result.text, /\[repeated \d+x\]/)
  assert.ok(result.text.length < log.length / 2)
})

test('routeText pivots JSON instead of truncating it', () => {
  const json = jsonPayload()
  const result = routeText(json, { toolName: 'pwsh' })
  assert.equal(result.changed, true)
  // Regression: the kind→reducer table used to miss `json`, so JSON fell
  // through to the shell summary and lost all structure.
  assert.equal(result.reducer, 'json-pivot')
  assert.match(result.text, /_keys/)
  assert.match(result.text, /_rows/)
  // Constant fields are hoisted out of the row array.
  assert.match(result.text, /_common/)
  assert.match(result.text, /ready/)
  // Row count is capped, and the omission is stated.
  assert.match(result.text, /_omittedRows/)
  // The pivot must remain parseable JSON.
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.total, 200)
})

test('routeText folds grep output by file and keeps match lines usable', () => {
  const grep = grepOutput()
  const result = routeText(grep, { toolName: 'grep' })
  assert.equal(result.changed, true)
  assert.equal(result.reducer, 'search-fold')
  // The path is hoisted into a per-file header (that is where the saving comes
  // from) and the header states how many matches that file contributed.
  assert.match(result.text, /src\/kernel\/task\/mod0\.rs \(\d+ matches\)/)
  // Every surviving line keeps its line number and its body, so the model can
  // still re-read the exact region with `read` + offset.
  assert.match(result.text, /^\d+:     fn schedule_0\(\) \{ todo!\(\) \}$/mu)
  // Omitted matches are stated per file rather than silently dropped.
  assert.match(result.text, /\(\d+ matches\)/)
})

test('routeText leaves small results alone', () => {
  const small = 'short output\n'
  const result = routeText(small, { toolName: 'pwsh' })
  assert.equal(result.changed, false)
  assert.equal(result.text, small)
})

test('routeText never touches a protected tool', () => {
  // `read`/`write`/`edit` output is a byte contract: the model may patch against
  // it, and a truncated file read is a silent correctness bug. The `null` marker
  // in TOOL_HINTS must survive lookup — a `??` there once turned it into
  // `undefined`, which made these tools reduce like any unknown tool.
  for (const toolName of ['read', 'write', 'edit', 'str_replace_editor', 'ctx_restore', 'diet_restore']) {
    const result = routeText(buildLog(), { toolName })
    assert.equal(result.changed, false, `${toolName} must never be reduced`)
    assert.equal(result.reducer, 'none')
  }
})

test('routeText reduces an unknown tool by kind, and only after the floor', () => {
  // An unlisted tool is not protected — custom tools that print JSON or logs
  // still benefit. Protection is an explicit opt-in, not the default.
  const result = routeText(jsonPayload(), { toolName: 'some_custom_tool' })
  assert.equal(result.changed, true)
  assert.equal(result.reducer, 'json-pivot')
})

test('routeText rejects a fold that saves less than the floor', () => {
  // 4,500 chars of prose with no structure: text-head/tail would save only a
  // little, which is not worth the loss of detail.
  const prose = Array.from({ length: 300 }, (_, index) => `line ${index} of ordinary prose`).join('\n')
  const result = routeText(prose, { toolName: 'web_fetch', limits: { ...FOLD_DEFAULTS, minSavingRatio: 0.9 } })
  assert.equal(result.changed, false)
})

test('routeText prefers the code skeleton over byte shaving', () => {
  const rust = [
    'use alloc::vec::Vec;',
    '',
    'impl Foo {',
    ...Array.from({ length: 300 }, (_, index) => `    let a${index} = ${index};`),
    '    pub fn keep(&self) -> u32 { 1 }',
    '}'
  ].join('\n')
  const result = routeText(rust, { toolName: 'pwsh', hint: 'code', pathHint: 'foo.rs' })
  assert.equal(result.changed, true)
  assert.equal(result.reducer, 'code-skeleton')
  assert.match(result.text, /pub fn keep\(&self\) -> u32/)
})

test('a printed source excerpt is skeletonised, not shell-summarised', () => {
  // Measured regression: `pwsh` prints a file (`grep -n`, `head -70`) far more
  // often than it prints a build log, and `shell-summary` cut the middle out of
  // exactly those blocks — the functions the model had asked to see. The text
  // below is that shape: no line numbers, so nothing marks it as a document
  // dump, and `pwsh`'s reducer list would otherwise try `shell-summary` first.
  const lines = [
    '//! 不依赖调度器的早期自旋锁，以及 SMP 数据结构接口预留。',
    'use core::cell::UnsafeCell;',
    'use core::hint::spin_loop;',
    'pub struct SpinLock<T> {',
    '    locked: AtomicBool,',
    '    data: UnsafeCell<T>,',
    '}'
  ]
  for (let index = 0; index < 60; index += 1) lines.push(`    let guard_${index} = self.acquire();`)
  lines.push('impl<T> SpinLock<T> {', '    pub fn lock(&self) -> SpinLockGuard<\'_, T> {', '        self.acquire()', '    }', '}')

  const result = routeText(lines.join('\n'), { toolName: 'pwsh', pathHint: 'src/klib/sync.rs' })
  assert.equal(result.changed, true)
  assert.equal(result.reducer, 'code-skeleton')
  assert.match(result.text, /pub fn lock/)
})

test('a boot log keeps the lines that state the verdict', () => {
  // The whole point of a kernel smoke run is `VFS_BACKENDS_PASS` and
  // `M1 paging/trap foundation OK`. A plain head+tail summary kept the RUN=
  // banner and twelve `[blk] stat` progress lines — i.e. it threw away the two
  // lines the run existed to produce.
  const lines = [
    'RUN=/mnt/d/OS-learning/kernel-project/artifacts/runs/ext2-write-3e9684',
    'TOTAL=99',
    '[virtio-blk] slot6 base=0x10007000 magic=0x74726976 version=1 device_id=0',
    '[virtio-blk] ready base=0x10008000 queue=64 capacity=20480 sectors (10 MiB)'
  ]
  for (let index = 0; index < 30; index += 1) lines.push(`[blk] stat req=${index * 250} elapsed_ticks=2412 iters=1 used=${index * 250 + 1}`)
  lines.splice(6, 0, '[ext2] mounted /disk blocks=10240 groups=2 block_size=1024', 'VFS_BACKENDS_PASS', 'M1 paging/trap foundation OK')

  const result = routeText(lines.join('\n'), { toolName: 'pwsh' })
  assert.equal(result.changed, true)
  assert.match(result.text, /VFS_BACKENDS_PASS/)
  assert.match(result.text, /M1 paging\/trap foundation OK/)
})

test('looksLikeCode does not mistake a build log for source', () => {
  assert.equal(internals.looksLikeCode(buildLog()), false)
  assert.equal(internals.looksLikeCode('VFS_BACKENDS_PASS\nM1 paging/trap foundation OK\n[blk] stat req=0'), false)
  assert.equal(internals.looksLikeCode(['use core::mem;', 'use core::sync;', 'fn a() {', '    let x = 1;', '    if x > 0 {', '        return;', '    }', '    let y = 2;', '}'].join('\n')), true)
  // A handful of lines is a pasted snippet, not a region of a file; the floor
  // keeps `shell-summary` in charge of short command output.
  assert.equal(internals.looksLikeCode('use core::mem;\nuse core::sync;\nfn a() {}'), false)
})

test('applyReduction appends a retrievable marker', () => {
  const outcome = { changed: true, reducer: 'log-fold', text: 'x', originalChars: 1000, compressedChars: 100 }
  const full = applyReduction(outcome, 'diet:abc')
  assert.match(full, /diet: log-fold 1000→100 chars/)
  assert.match(full, /ctx_restore\(id="diet:abc"\)/)

  const compact = applyReduction(outcome, 'diet:abc', 'compact')
  assert.equal(compact, 'x\n\n[diet: id="diet:abc"]')

  // An unchanged outcome must not gain a marker.
  const unchanged = { changed: false, text: 'y' }
  assert.equal(applyReduction(unchanged, 'diet:abc'), 'y')
})

test('resolveLimits merges over defaults without mutating them', () => {
  const merged = resolveLimits({ minChars: 10 })
  assert.equal(merged.minChars, 10)
  assert.equal(merged.maxRows, FOLD_DEFAULTS.maxRows)
  // The floor is a measured constant, not a taste. On `session-c1ca1479` the
  // 4000-char floor was what capped the whole plugin at 20.6% of tool bytes:
  // 678 foldable blocks (783,347 chars) sat under it and were never routed.
  // Sweeping the real reducers put the knee at ~1000 (4000 → 20.6%, 1500 → 37.5%,
  // 1000 → 40.1%, 600 → 40.9%). Changing this number without re-running that
  // sweep is how the plugin goes back to doing nothing on pwsh output.
  assert.equal(FOLD_DEFAULTS.minChars, 1000)
  assert.equal(FOLD_DEFAULTS.minSavedChars, 400)
})

test('a reduction must pay for its own marker in absolute chars', () => {
  // The ratio test alone lets a 9% win on a small block through, which is ~90
  // chars — less than the `[diet: … ctx_restore(id="…")]` marker it appends, and
  // less than the cost of the restore the model may then have to make.
  const text = `prose ${'lorem ipsum '.repeat(300)}`
  const permissive = routeText(text, {
    toolName: 'web_fetch',
    limits: resolveLimits({ minChars: 100, minSavedChars: 0 })
  })
  assert.equal(permissive.changed, true)
  assert.ok(permissive.originalChars - permissive.compressedChars < 100000)

  // Same block, same ratio, but the absolute floor is set above what it saves.
  const strict = routeText(text, {
    toolName: 'web_fetch',
    limits: resolveLimits({ minChars: 100, minSavedChars: permissive.originalChars })
  })
  assert.equal(strict.changed, false)
  assert.equal(strict.reducer, 'none')
  assert.equal(strict.text, text)
})

test('every accepted reduction saves at least minSavedChars', () => {
  // Property, not example: whatever the reducer, a claimed win must clear the
  // absolute floor. A reducer that returns a 30-char saving on a 1200-char block
  // is a regression even though it clears minSavingRatio in spirit.
  const samples = [
    { toolName: 'pwsh', text: buildLog() },
    { toolName: 'grep', text: grepOutput() },
    { toolName: 'pwsh', text: jsonPayload() },
    { toolName: 'web_fetch', text: `x ${'y'.repeat(5000)}` }
  ]
  for (const sample of samples) {
    const outcome = routeText(sample.text, { toolName: sample.toolName })
    if (!outcome.changed) continue
    const saved = outcome.originalChars - outcome.compressedChars
    assert.ok(
      saved >= FOLD_DEFAULTS.minSavedChars,
      `${sample.toolName}/${outcome.reducer} saved only ${saved} chars`
    )
  }
})

test('internals.reduceLog keeps error lines even when includeErrors is off', () => {
  // `includeErrors` gates whole error results upstream; the log reducer's own
  // keep-list must still protect the lines inside an accepted result.
  const text = buildLog()
  const kept = internals.reduceLog(text, FOLD_DEFAULTS)
  assert.ok(kept.includes('error[E0308]'))
})

test('dedupeRuns collapses runs into counted markers', () => {
  const out = internals.dedupeRuns(['a', 'a', 'a', 'b', 'c', 'c'])
  assert.ok(Array.isArray(out))
  // The run's first line must not survive alongside its marker — a doubled line
  // makes the marker disagree with what the log actually contained.
  assert.deepEqual(out, ['a [repeated 3x]', 'b', 'c [repeated 2x]'])
  // A lone line is left alone.
  assert.deepEqual(internals.dedupeRuns(['x', 'y']), ['x', 'y'])
})
