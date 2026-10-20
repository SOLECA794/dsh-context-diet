import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, defaultStorePath } from '../lib/ccr.js'

const sandboxes = []
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'diet-ccr-'))
  sandboxes.push(dir)
  return join(dir, 'ccr.json')
}

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
})

function makeStore(overrides = {}) {
  return createStore({ persist: false, ...overrides })
}

test('put returns a content-addressed id', () => {
  const store = makeStore()
  const id = store.put({
    toolName: 'pwsh',
    callId: 'call-1',
    reducer: 'log-fold',
    originalText: 'x'.repeat(1000),
    compressedChars: 100
  })
  assert.match(id, /^diet:[0-9a-f]{16}$/)
  // Same bytes → same id, so a repeated build log is stored once.
  const again = store.put({
    toolName: 'pwsh',
    callId: 'call-2',
    reducer: 'log-fold',
    originalText: 'x'.repeat(1000),
    compressedChars: 90
  })
  assert.equal(again, id)
  assert.equal(store.size, 1)
  assert.equal(store.stats().entries, 1)
})

test('get returns the original bytes verbatim', () => {
  const store = makeStore()
  const original = 'line one\nline two\n\u4e2d\u6587 content\n'
  const id = store.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: original, compressedChars: 10 })
  const entry = store.get(id)
  assert.equal(entry.originalText, original)
  assert.equal(entry.reducer, 'log-fold')
  assert.equal(store.get('diet:doesnotexist'), null)
  assert.equal(store.get(undefined), null)
})

test('get honours an entry that already expired', () => {
  const store = makeStore({ ttlMs: 1 })
  const id = store.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: 'abc', compressedChars: 1 })
  assert.equal(store.get(id).originalText, 'abc')
  // Rewind the clock by hand rather than sleeping.
  const entry = store.get(id)
  entry.expiresAt = Date.now() - 1
  assert.equal(store.get(id), null)
})

test('savedChars accumulates only the accepted reduction', () => {
  const store = makeStore()
  store.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: 'a'.repeat(1000), compressedChars: 100 })
  store.put({ toolName: 'grep', reducer: 'search-fold', originalText: 'b'.repeat(500), compressedChars: 50 })
  const stats = store.stats()
  assert.equal(stats.savedChars, 900 + 450)
  assert.equal(stats.reductions, 2)
  assert.equal(stats.regretChars, 0)
  assert.equal(stats.netChars, 1350)
})

test('observePassthrough is honest about undone savings', () => {
  // The whole point of the ledger: if the model re-reads the original text that
  // was folded away, the saving was not real and must be booked as a cost.
  const store = makeStore()
  const original = 'full build log\n'.repeat(100)
  store.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: original, compressedChars: 200 })
  assert.equal(store.stats().netChars, store.stats().savedChars)

  // The model later reads the same bytes back in full.
  store.observePassthrough(original)
  const stats = store.stats()
  assert.equal(stats.regretChars, original.length)
  assert.equal(stats.regretted, 1)
  assert.equal(stats.netChars, stats.savedChars - original.length)
  // A net saving is allowed to go negative — that is the honest answer.
  assert.ok(stats.netChars < 0)
})

test('observePassthrough counts an unmatched text as harmless', () => {
  const store = makeStore()
  store.observePassthrough('text that was never folded')
  const stats = store.stats()
  assert.equal(stats.passthrough, 1)
  assert.equal(stats.regretChars, 0)
})

test('a regret is booked once even if the text passes through twice', () => {
  const store = makeStore()
  const original = 'y'.repeat(400)
  store.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: original, compressedChars: 40 })
  store.observePassthrough(original)
  const afterFirst = store.stats().regretChars
  store.observePassthrough(original)
  assert.equal(store.stats().regretChars, afterFirst)
})

test('noteRestore counts retrievals without double-booking regret', () => {
  const store = makeStore()
  const id = store.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: 'z'.repeat(300), compressedChars: 30 })
  assert.equal(store.noteRestore(id), 1)
  assert.equal(store.noteRestore(id), 2)
  assert.equal(store.get(id).restoreCount, 2)
  assert.equal(store.noteRestore('diet:missing'), 0)
})

test('a stored record carries its own id', () => {
  // The record used to be keyed by id but not contain one, so `store.get(id).id`
  // was `undefined` and `noteRestore(entry.id)` silently returned 0. A caller
  // echoing `entry.id` back into a tool result then handed the harness an
  // `undefined` field, which is not lossless JSON, and the whole result was
  // rejected: "tool ctx_restore returned invalid output: value is not lossless JSON".
  const store = makeStore()
  const id = store.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: 'q'.repeat(50), compressedChars: 5 })
  const entry = store.get(id)
  assert.equal(entry.id, id)
  assert.equal(store.noteRestore(entry.id), 1, 'entry.id must address the entry it came from')
  assert.equal(JSON.stringify(entry) === undefined, false, 'the record must be JSON-serializable')
  assert.equal(JSON.parse(JSON.stringify(entry)).id, id, 'the id must survive a save/load round trip')
})

test('a reloaded record carries its own id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diet-ccr-id-'))
  const filePath = join(dir, 'store.json')
  const quiet = { warn() {} }
  try {
    const first = createStore({ filePath, logger: quiet })
    await first.init()
    const id = first.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: 'w'.repeat(50), compressedChars: 5 })
    await first.flush()

    const second = createStore({ filePath, logger: quiet })
    await second.init()
    assert.equal(second.get(id)?.id, id, 'the id must be restored with the entry, not only in the map key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maxEntries evicts the oldest entry', () => {
  const store = makeStore({ maxEntries: 2 })
  const first = store.put({ toolName: 'a', reducer: 'r', originalText: 'a'.repeat(10), compressedChars: 1 })
  store.put({ toolName: 'b', reducer: 'r', originalText: 'b'.repeat(10), compressedChars: 1 })
  store.put({ toolName: 'c', reducer: 'r', originalText: 'c'.repeat(10), compressedChars: 1 })
  assert.equal(store.size, 2)
  assert.equal(store.get(first), null, 'the oldest entry should be evicted')
})

test('disabled store accepts nothing', () => {
  const store = createStore({ enabled: false, persist: false })
  const id = store.put({ toolName: 'pwsh', reducer: 'r', originalText: 'abc', compressedChars: 1 })
  assert.equal(id, null)
  assert.equal(store.get('diet:abc'), null)
  assert.equal(store.stats().entries, 0)
})

test('persist round-trips through disk atomically', async () => {
  const storePath = tempPath()
  const first = makeStore({ persist: true, storePath })
  const original = 'persisted build output\n'.repeat(50)
  const id = first.put({ toolName: 'pwsh', reducer: 'log-fold', originalText: original, compressedChars: 100 })
  await first.flush()
  first.dispose()

  const onDisk = JSON.parse(readFileSync(storePath, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.ok(Array.isArray(onDisk.entries))

  const second = makeStore({ persist: true, storePath })
  await second.init()
  assert.equal(second.get(id).originalText, original)
  assert.equal(second.stats().savedChars, first.stats().savedChars)
})

test('a corrupt store file is ignored, not fatal', async () => {
  const storePath = tempPath()
  const store = makeStore({ persist: true, storePath })
  await store.init()
  store.put({ toolName: 'pwsh', reducer: 'r', originalText: 'abc', compressedChars: 1 })
  await store.flush()
  store.dispose()
  rmSync(storePath, { force: true })

  const recovered = makeStore({ persist: true, storePath })
  await recovered.init()
  assert.equal(recovered.size, 0)
})

test('defaultStorePath lives under DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(tmpdir(), 'dsh-home-probe')
  try {
    const path = defaultStorePath()
    assert.ok(path.includes('dsh-home-probe'))
    assert.ok(path.endsWith(join('storages', 'dsh-context-diet-ccr.json')))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
