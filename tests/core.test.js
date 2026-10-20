import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  countLines,
  estimateAsciiTokens,
  estimateTokens,
  globToRegExp,
  hashShort,
  isGlobMatch,
  netBraces,
  savedPct,
  splitLinePrefix,
  truncateMiddle,
  utf8Bytes
} from '../lib/core.js'

test('estimateTokens charges CJK by weight, not by char', () => {
  // 100 ASCII chars → 25 tokens; 100 CJK chars → 84. The harness convention of
  // len/4 would report 25 for both, under-billing Chinese by 3.4x.
  assert.equal(estimateTokens('a'.repeat(100)), 25)
  assert.equal(estimateTokens('中'.repeat(100)), 84)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(undefined), 0)
  // Mixed payloads add both halves.
  assert.equal(estimateTokens('abcd' + '中'), 1 + 1)
})

test('estimateAsciiTokens avoids materialising the string', () => {
  assert.equal(estimateAsciiTokens(0), 0)
  assert.equal(estimateAsciiTokens(-5), 0)
  assert.equal(estimateAsciiTokens(4), 1)
  assert.equal(estimateAsciiTokens(132_000), 33_000)
  // Must agree with estimateTokens for pure-ASCII input.
  assert.equal(estimateAsciiTokens(999), estimateTokens('x'.repeat(999)))
})

test('globToRegExp escapes regexp metacharacters', () => {
  assert.equal(globToRegExp('a.b').test('axb'), false)
  assert.equal(globToRegExp('a.b').test('a.b'), true)
  assert.equal(globToRegExp('*.rs').test('src/mm.rs'), true)
  assert.equal(globToRegExp('*.rs').test('src/mm.c'), false)
  assert.equal(globToRegExp('a+b').test('a+b'), true)
})

test('isGlobMatch tolerates junk input', () => {
  assert.equal(isGlobMatch('', ['*']), false)
  assert.equal(isGlobMatch('read', []), false)
  assert.equal(isGlobMatch('read', ['read', 'write']), true)
})

test('truncateMiddle keeps both ends and states the original length', () => {
  const text = 'x'.repeat(1000)
  const out = truncateMiddle(text, 100)
  assert.ok(out.length < 140)
  assert.match(out, /len 1000/)
  assert.ok(out.startsWith('x'.repeat(60)))
  assert.ok(out.endsWith('x'.repeat(40)))
  assert.equal(truncateMiddle('short', 100), 'short')
})

test('countLines ignores one trailing newline, like wc -l', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('a'), 1)
  assert.equal(countLines('a\nb'), 2)
  // A trailing newline is not an extra line — logs end with one, and folding
  // thresholds must agree with what `sed -n` would see.
  assert.equal(countLines('a\nb\n'), 2)
  assert.equal(countLines('a\n\n'), 2)
})

test('splitLinePrefix understands the four decorations read produces', () => {
  assert.deepEqual(splitLinePrefix('12: let x = 1;'), { prefix: '12: ', body: 'let x = 1;', lineNo: 12 })
  assert.deepEqual(splitLinePrefix('12| let x = 1;'), { prefix: '12| ', body: 'let x = 1;', lineNo: 12 })
  assert.deepEqual(splitLinePrefix('12→ let x = 1;'), { prefix: '12→ ', body: 'let x = 1;', lineNo: 12 })
  assert.deepEqual(splitLinePrefix('12\tlet x = 1;'), { prefix: '12\t', body: 'let x = 1;', lineNo: 12 })
  const bare = splitLinePrefix('let x = 1;')
  assert.equal(bare.lineNo, null)
  assert.equal(bare.body, 'let x = 1;')
})

test('netBraces ignores braces inside strings and comments', () => {
  assert.equal(netBraces('fn main() {'), 1)
  assert.equal(netBraces('}'), -1)
  assert.equal(netBraces('{}'), 0)
  // A brace inside a string literal must not affect depth tracking, or code
  // folding will elide the wrong line ranges.
  assert.equal(netBraces('let s = "}";'), 0)
  assert.equal(netBraces("let s = '{';"), 0)
  // A comment that mentions a brace is not a brace.
  assert.equal(netBraces('// }'), 0)
  assert.equal(netBraces('/* { */'), 0)
})

test('netBraces carries block-comment state across lines', () => {
  const state = {}
  assert.equal(netBraces('/* start', state), 0)
  assert.equal(state.blockComment, true)
  // This `}` is inside the comment and must not count.
  assert.equal(netBraces(' } still comment', state), 0)
  assert.equal(netBraces(' end */ }', state), -1)
  assert.equal(state.blockComment, false)
})

test('netBraces treats # as a comment only when the language says so', () => {
  // Python: `# }` is a comment.
  assert.equal(netBraces('# }', { hashComments: true }), 0)
  // C preprocessor: `#define X {` really does open a brace.
  assert.equal(netBraces('#define X {', { hashComments: false }), 1)
})

test('hashShort is stable and short', () => {
  const a = hashShort('hello world')
  assert.equal(a, hashShort('hello world'))
  assert.notEqual(a, hashShort('hello worle'))
  assert.equal(a.length, 16)
})

test('utf8Bytes counts bytes not code units', () => {
  assert.equal(utf8Bytes('abc'), 3)
  assert.equal(utf8Bytes('中'), 3)
  assert.equal(utf8Bytes(''), 0)
})

test('savedPct reports a percentage and never divides by zero', () => {
  assert.equal(savedPct(100, 25), 75)
  assert.equal(savedPct(0, 0), 0)
  assert.equal(savedPct(100, 100), 0)
})
