import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeFold, foldCode, detectLanguage, languageFromPath } from '../lib/codefold.js'

/** A Rust file shaped like the kernel project this plugin was built against. */
function rustSource(lines) {
  return lines.join('\n')
}

const RUST_SAMPLE = rustSource([
  '//! 映射区与地址空间所有权。',
  '',
  'use alloc::vec::Vec;',
  '',
  '/// 映射区表容量。**必须是内联固定数组。**',
  'pub struct MemorySet {',
  '    areas: Vec<MapArea>,',
  '}',
  '',
  'impl MemorySet {',
  '    /// 新建空映射集。',
  '    pub fn new() -> Self {',
  ...Array.from({ length: 30 }, (_, index) => `        let step_${index} = ${index}; // filler`),
  '        Self { areas: Vec::new() }',
  '    }',
  '',
  '    /// 插入一个映射区。',
  '    pub fn insert(&mut self, area: MapArea) -> Result<(), MemoryError> {',
  ...Array.from({ length: 30 }, (_, index) => `        self.check_${index}();`),
  '        self.areas.push(area);',
  '        Ok(())',
  '    }',
  '',
  '    fn private_helper(&self) -> usize {',
  ...Array.from({ length: 20 }, (_, index) => `        let inner_${index} = ${index};`),
  '        0',
  '    }',
  '}',
])

test('languageFromPath recognises the languages this plugin adds', () => {
  assert.equal(languageFromPath('src/mm/memory_set.rs'), 'rust')
  assert.equal(languageFromPath('kernel/arch/riscv/trap.c'), 'c')
  assert.equal(languageFromPath('include/types.h'), 'c')
  assert.equal(languageFromPath('src/main.cpp'), 'cpp')
  assert.equal(languageFromPath('Makefile'), 'make')
  assert.equal(languageFromPath('Cargo.toml'), 'toml')
  assert.equal(languageFromPath('README.md'), 'markdown')
  assert.equal(languageFromPath('app.ts'), 'ts')
  assert.equal(languageFromPath('app.py'), 'python')
  assert.equal(languageFromPath('data.bin'), null)
  assert.equal(languageFromPath(''), null)
  assert.equal(languageFromPath(undefined), null)
})

test('detectLanguage sniffs content when the path is unknown', () => {
  assert.equal(detectLanguage('#[derive(Debug)]\npub struct X {}\nfn main() {}'), 'rust')
  assert.equal(detectLanguage('#include <stdio.h>\nint main(void) { return 0; }'), 'c')
  assert.equal(detectLanguage('def main():\n    return 0\n'), 'python')
  assert.equal(detectLanguage('export function f() {}\n'), 'ts')
  assert.equal(detectLanguage('plain prose with no code at all'), null)
})

test('foldCode elides Rust bodies but keeps signatures, docs and use lines', () => {
  const result = foldCode(RUST_SAMPLE, { hint: 'memory_set.rs' })
  assert.equal(result.changed, true)
  assert.equal(result.language, 'rust')
  assert.ok(result.elidedLines > 0)

  const out = result.text
  // Structure survives.
  assert.match(out, /use alloc::vec::Vec;/)
  assert.match(out, /pub struct MemorySet \{/)
  assert.match(out, /pub fn new\(\) -> Self \{/)
  assert.match(out, /pub fn insert\(&mut self, area: MapArea\)/)
  // Doc comments survive — they are the cheapest form of intent.
  assert.match(out, /\/\/\/ 插入一个映射区。/)
  // Bodies do not.
  assert.ok(!out.includes('let step_17 = 17'))
  assert.ok(!out.includes('self.check_23()'))
})

test('every elision marker carries an addressable line range', () => {
  const result = foldCode(RUST_SAMPLE, { hint: 'memory_set.rs' })
  const markers = result.text.split('\n').filter((line) => line.includes('elided'))
  assert.ok(markers.length > 0, 'expected at least one elision marker')
  for (const marker of markers) {
    assert.match(marker, /… \[elided \d+-\d+\]/, `marker without a range: ${marker}`)
  }
  // Ranges must be ascending and non-overlapping, or a reader cannot trust them.
  let previousTo = 0
  for (const range of result.ranges) {
    assert.ok(range.from > previousTo, `range ${range.from}-${range.to} overlaps or is unsorted`)
    assert.ok(range.to >= range.from)
    previousTo = range.to
  }
})

test('foldCode preserves the line-number decoration that read adds', () => {
  const decorated = RUST_SAMPLE.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n')
  const result = foldCode(decorated, { hint: 'memory_set.rs' })
  assert.equal(result.changed, true)
  // Markers must quote the file's own line numbers, not the array position.
  const markers = result.text.split('\n').filter((line) => line.includes('elided'))
  assert.ok(markers.length > 0)
  assert.match(markers[0], /… \[elided \d{2,4}-\d{2,4}\]/)
  assert.ok(result.ranges[0].from > 1)
})

test('foldCode leaves short files alone', () => {
  const short = rustSource(['fn main() {', '    println!("hi");', '}'])
  const result = foldCode(short, { hint: 'main.rs' })
  assert.equal(result.changed, false)
  assert.equal(result.text, short)
})

test('foldCode refuses a fold that saves too little', () => {
  // A file that is nearly all signatures: eliding a few bodies saves nothing,
  // so the fold must be rejected rather than emitted as noise.
  const signatures = Array.from({ length: 80 }, (_, index) => `pub fn f${index}(a: u32) -> u32;`).join('\n')
  const result = foldCode(signatures, { hint: 'api.rs' })
  assert.equal(result.changed, false)
})

test('foldCode is a no-op for an unknown language', () => {
  const text = 'x\n'.repeat(200)
  const result = foldCode(text, { language: null, hint: 'data.bin' })
  assert.equal(result.changed, false)
})

test('foldCode handles C with its own anchors', () => {
  const c = [
    '#include <stdint.h>',
    '',
    '#define MAX_TASKS 64',
    '',
    'struct task {',
    '    int pid;',
    '};',
    '',
    'static int helper(int x) {',
    ...Array.from({ length: 40 }, (_, index) => `    int v${index} = ${index};`),
    '    return x;',
    '}',
    '',
    'int main(void) {',
    ...Array.from({ length: 40 }, (_, index) => `    helper(${index});`),
    '    return 0;',
    '}',
  ].join('\n')
  const result = foldCode(c, { hint: 'main.c' })
  assert.equal(result.changed, true)
  assert.equal(result.language, 'c')
  assert.match(result.text, /#include <stdint.h>/)
  assert.match(result.text, /struct task \{/)
  assert.ok(!result.text.includes('int v23 = 23;'))
})

test('foldCode handles Python indentation without braces', () => {
  const py = [
    'import os',
    '',
    'def outer(x):',
    ...Array.from({ length: 40 }, (_, index) => `    v${index} = ${index}`),
    '    return x',
    '',
    'class Thing:',
    '    def method(self):',
    ...Array.from({ length: 30 }, (_, index) => `        w${index} = ${index}`),
    '        return 1',
  ].join('\n')
  const result = foldCode(py, { hint: 'app.py' })
  assert.equal(result.changed, true)
  assert.equal(result.language, 'python')
  assert.match(result.text, /def outer\(x\):/)
  assert.match(result.text, /class Thing:/)
})

test('describeFold renders a one-line summary', () => {
  const result = foldCode(RUST_SAMPLE, { hint: 'memory_set.rs' })
  const text = describeFold(result)
  assert.match(text, /rust/)
  assert.match(text, /elided/)
  assert.equal(describeFold({ changed: false }), '')
})

test('foldCode never returns text longer than the input', () => {
  for (const hint of ['a.rs', 'a.c', 'a.py', 'a.ts', 'Makefile', 'a.toml', 'a.md']) {
    const result = foldCode(RUST_SAMPLE, { hint })
    if (result.changed) assert.ok(result.text.length < RUST_SAMPLE.length, `${hint} produced a longer result`)
  }
})
