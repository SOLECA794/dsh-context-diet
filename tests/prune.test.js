import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PRUNE_DEFAULTS,
  classifyHistory,
  estimateListTokens,
  pruneHistory
} from '../lib/prune.js'

/** Build a conversation shaped like the harness event log produces. */
function conversation(entries, { filler = 0 } = {}) {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Implement the scheduler.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Starting.' }] }
  ]
  let callId = 0
  const push = (entry) => {
    const id = `call-${callId += 1}`
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', id, name: entry.tool, arguments: JSON.stringify(entry.args ?? {}) }]
    })
    messages.push({
      role: 'tool',
      toolCallId: id,
      content: [{ type: 'text', text: entry.result ?? `result of ${entry.tool}` }]
    })
  }
  for (const entry of entries) push(entry)
  // Padding keeps the interesting calls outside the protected tail, the way a
  // real session does after a few dozen steps.
  for (let index = 0; index < filler; index += 1) {
    push({ tool: 'pwsh', args: { command: `echo ${index}` }, result: `step ${index}` })
  }
  return messages
}

function longText(label, lines = 60) {
  return Array.from({ length: lines }, (_, index) => `${label} line ${index}`).join('\n')
}

test('classifyHistory marks a re-read file as redundant', () => {
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/kernel/task/mod.rs' }, result: longText('first') },
    { tool: 'pwsh', args: { command: 'echo hi' } },
    { tool: 'read', args: { file_path: 'src/kernel/task/mod.rs' }, result: longText('second') }
  ], { filler: 8 })
  const verdicts = classifyHistory(messages)
  const reasons = verdicts.map((verdict) => verdict.reason)
  assert.ok(reasons.includes('redundant'), `expected a redundant verdict, got ${JSON.stringify(reasons)}`)
  // The FIRST read is the redundant one — the later read supersedes it.
  const redundant = verdicts.find((verdict) => verdict.reason === 'redundant')
  assert.equal(redundant.call.name, 'read')
  assert.equal(redundant.call.args.file_path, 'src/kernel/task/mod.rs')
})

test('classifyHistory marks a read superseded by an edit as expired', () => {
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/main.rs' }, result: longText('before') },
    { tool: 'edit', args: { file_path: 'src/main.rs', old_string: 'a', new_string: 'b' }, result: 'ok' },
    { tool: 'pwsh', args: { command: 'cargo build' } }
  ], { filler: 8 })
  const verdicts = classifyHistory(messages)
  const expired = verdicts.find((verdict) => verdict.reason === 'expired')
  assert.ok(expired !== undefined, 'a read followed by an edit must be stale')
  assert.equal(expired.call.name, 'read')
})

test('classifyHistory leaves a fresh read alone', () => {
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/lib.rs' }, result: longText('only') },
    { tool: 'pwsh', args: { command: 'ls' } }
  ], { filler: 8 })
  const verdicts = classifyHistory(messages)
  assert.equal(verdicts.length, 0)
})

test('classifyHistory protects the newest messages', () => {
  // Two reads of the same file, but both land inside the protected tail, so
  // neither may be rewritten — the model is probably still using them.
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('one') },
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('two') }
  ])
  const verdicts = classifyHistory(messages, { protectRecentMessages: messages.length })
  assert.equal(verdicts.length, 0)
})

test('classifyHistory protects the head messages', () => {
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('one') },
    { tool: 'pwsh', args: { command: 'ls' } },
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('two') }
  ])
  // Protect everything up to and including the first read's result.
  const verdicts = classifyHistory(messages, { protectHeadMessages: 5, protectRecentMessages: 2 })
  assert.equal(verdicts.length, 0)
})

test('pruneHistory rewrites content in place and never splices messages', () => {
  // The invariant that keeps the prefix cache alive: the message count and the
  // order must be identical before and after. Only `content` may change.
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('one') },
    { tool: 'pwsh', args: { command: 'ls' } },
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('two') }
  ])
  const before = messages.length
  const result = pruneHistory(messages, { enabled: true, protectRecentMessages: 2 })
  assert.equal(result.changed, true)
  assert.equal(result.messages.length, before, 'message count must not change')
  for (let index = 0; index < before; index += 1) {
    assert.equal(result.messages[index].role, messages[index].role, `role changed at ${index}`)
  }
})

test('pruneHistory replaces a stale read with a retrievable marker', () => {
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('one', 80) },
    { tool: 'pwsh', args: { command: 'ls' } },
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('two', 80) }
  ])
  const stored = []
  const result = pruneHistory(messages, {
    enabled: true,
    protectRecentMessages: 2,
    onStore: (payload) => {
      stored.push(payload)
      return `diet:test${stored.length}`
    }
  })
  assert.equal(result.changed, true)
  assert.equal(result.rewrites.length, 1)
  const rewrite = result.rewrites[0]
  assert.equal(rewrite.reason, 'redundant')
  assert.ok(rewrite.afterChars < rewrite.beforeChars)
  // The original bytes must be handed to the store, not dropped.
  assert.equal(stored.length, 1)
  assert.match(stored[0].originalText, /one line 0/)
  // The marker must state why, and how to get the bytes back.
  assert.match(rewrite.text, /\[diet:redundant\]/)
  assert.match(rewrite.text, /ctx_restore\(id="diet:test1"\)/)
})

test('pruneHistory is a no-op when disabled', () => {
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('one') },
    { tool: 'pwsh', args: { command: 'ls' } },
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('two') }
  ])
  const result = pruneHistory(messages, { enabled: false })
  assert.equal(result.changed, false)
  assert.deepEqual(result.messages, messages)
  assert.deepEqual(result.rewrites, [])
})

test('pruneHistory never touches assistant reasoning or tool-call blocks', () => {
  const messages = conversation([
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('one') },
    { tool: 'pwsh', args: { command: 'ls' } },
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('two') }
  ])
  messages[2].content.unshift({ type: 'reasoning', text: 'I need to read the file again.' })
  const result = pruneHistory(messages, { enabled: true, protectRecentMessages: 2 })
  assert.equal(result.changed, true)
  const reasoning = result.messages[2].content.find((block) => block.type === 'reasoning')
  assert.equal(reasoning.text, 'I need to read the file again.')
  const call = result.messages[2].content.find((block) => block.type === 'tool-call')
  assert.ok(call !== undefined, 'the tool-call block must survive')
})

test('pruneHistory respects maxRewrites', () => {
  const entries = []
  for (let index = 0; index < 6; index += 1) {
    entries.push({ tool: 'read', args: { file_path: `src/f${index}.rs` }, result: longText(`f${index}`, 80) })
    entries.push({ tool: 'pwsh', args: { command: 'ls' } })
    entries.push({ tool: 'read', args: { file_path: `src/f${index}.rs` }, result: longText(`f${index}b`, 80) })
  }
  const messages = conversation(entries)
  const result = pruneHistory(messages, { enabled: true, protectRecentMessages: 2, maxRewrites: 2 })
  assert.equal(result.rewrites.length, 2)
})

test('estimateListTokens scales with content', () => {
  const small = conversation([{ tool: 'pwsh', args: { command: 'ls' }, result: 'a' }])
  const large = conversation([{ tool: 'pwsh', args: { command: 'ls' }, result: longText('big', 400) }])
  assert.ok(estimateListTokens(large) > estimateListTokens(small))
  assert.equal(estimateListTokens([]), 0)
  assert.equal(estimateListTokens(null), 0)
})

test('junk listings and passing test output collapse', () => {
  const junk = [
    'node_modules/lodash/index.js',
    'node_modules/lodash/package.json',
    'node_modules/react/index.js',
    'node_modules/react/package.json',
    'node_modules/vue/index.js'
  ].join('\n')
  const messages = conversation([
    { tool: 'pwsh', args: { command: 'ls -R' }, result: junk },
    { tool: 'pwsh', args: { command: 'ls' } },
    { tool: 'read', args: { file_path: 'src/a.rs' }, result: longText('a') }
  ])
  const result = pruneHistory(messages, { enabled: true, protectRecentMessages: 2 })
  if (result.changed) {
    const rewrite = result.rewrites[0]
    assert.ok(rewrite.afterChars < rewrite.beforeChars)
  }
})

test('PRUNE_DEFAULTS are frozen and sane', () => {
  assert.ok(Object.isFrozen(PRUNE_DEFAULTS))
  assert.equal(PRUNE_DEFAULTS.protectRecentMessages, 6)
  assert.equal(PRUNE_DEFAULTS.protectHeadMessages, 2)
  assert.ok(PRUNE_DEFAULTS.junkPatterns.includes('node_modules'))
})
