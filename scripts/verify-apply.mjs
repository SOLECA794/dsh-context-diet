#!/usr/bin/env node
/**
 * Smoke-test `apply()` without a DSH install.
 *
 * `lib/index.js` imports `@deepseek-ai/dsh-tools`, which only exists inside the
 * harness. This script installs a resolve hook that swaps in `tests/stubs/dsh-tools.mjs`,
 * then drives the plugin the way the harness would: register it, hand its
 * `tools/post-execute` listener a real tool result, and follow the `[diet: …]`
 * marker back through `ctx_restore` to prove the bytes survived.
 *
 * Run it with `pnpm verify` (or `node scripts/verify-apply.mjs`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stubUrl = new URL('../tests/stubs/dsh-tools.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: stubUrl, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})

// Keep the run hermetic: the CCR store would otherwise land in the real ~/.dsh.
const scratch = mkdtempSync(join(tmpdir(), 'diet-verify-'))
process.env.DSH_HOME = scratch

const checks = []
function check(label, fn) {
  try {
    fn()
    checks.push({ label, ok: true })
  } catch (error) {
    checks.push({ label, ok: false, error })
  }
}

function mockContext() {
  const listeners = new Map()
  const tools = []
  const effects = []
  const warnings = []
  return {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      debug: () => {},
      error: (message) => warnings.push(String(message))
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    effect(setup) {
      effects.push(setup)
      return () => {}
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      }
    },
    // Test-side handles. Note: 	ools above is the harness surface, so the
    // recorded registrations need a different name.
    listeners,
    registeredTools: tools,
    effects,
    warnings
  }
}

const BUILD_LOG = [
  '   Compiling kernel v0.1.0 (/home/dev/kernel-project)',
  ...Array.from({ length: 240 }, (_, index) => `   Compiling dep-${index} v0.${index}.0`),
  'error[E0308]: mismatched types',
  '   --> src/kernel/mm/memory_set.rs:131:24',
  '    |',
  '131 |     let _ = map_page(addr);',
  '    |             ^^^^^^^^^^^^^ expected `()`, found `Result<(), MemoryError>`',
  '    |',
  'note: expected unit type `()`',
  'error: could not compile `kernel` (bin "kernel") due to 1 previous error'
].join('\n')

const SMALL_OUTPUT = 'ok'

async function main() {
  const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

  const ctx = mockContext()
  await apply(ctx, { minChars: 200 })
  const dispose = ctx.effects[ctx.effects.length - 1]
  const registered = ctx.registeredTools
  const listener = ctx.listeners.get('tools/post-execute')?.[0]
  const preStep = ctx.listeners.get('agent/pre-step')?.[0]

  check('apply registers both listeners', () => {
    assert.equal(typeof listener, 'function', 'tools/post-execute must be subscribed')
    assert.equal(typeof preStep, 'function', 'agent/pre-step must be subscribed')
  })

  check('apply registers the three L3 tools', () => {
    const names = registered.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['ctx_audit', 'ctx_restore', 'ctx_stats'])
  })

  check('apply installs exactly one disposer effect', () => {
    assert.equal(ctx.effects.length, 1)
    assert.equal(typeof dispose, 'function')
  })

  check('apply logs an active summary', () => {
    assert.ok(ctx.warnings.length >= 1, 'expected a warn line')
    assert.match(ctx.warnings[0], /dsh-context-diet: active/)
  })

  // ---- L1: a noisy build log gets collapsed, and stays recoverable ----------
  const original = BUILD_LOG
  let captured
  if (typeof listener === 'function') {
    const result = { isError: false, content: [{ type: 'text', text: original }] }
    const decision = await listener(
      { name: 'pwsh', arguments: { command: 'cargo build' } },
      result,
      async () => ({ kind: 'accept', content: [{ type: 'text', text: original }] })
    )
    captured = decision
  }

  check('L1 collapses a build log', () => {
    assert.ok(captured !== undefined, 'listener produced no decision')
    assert.equal(captured.kind, 'accept')
    const text = captured.content[0].text
    assert.ok(text.length < original.length / 2, `expected a big reduction, got ${text.length} of ${original.length}`)
    assert.match(text, /error\[E0308\]/, 'the error must survive')
    assert.match(text, /memory_set\.rs:131:24/, 'the source location must survive')
  })

  check('L1 leaves a [diet: …] marker with a retrieval id', () => {
    const text = captured.content[0].text
    const match = /ctx_restore\(id="([^"]+)"\)/.exec(text)
    assert.ok(match !== null, `no retrieval id in: ${text.slice(-120)}`)
    assert.match(match[1], /^diet:/)
  })

  // ---- L3: ctx_restore returns the exact original bytes ---------------------
  const markerText = captured?.content?.[0]?.text ?? ''
  const idMatch = /ctx_restore\(id="([^"]+)"\)/.exec(markerText)
  const id = idMatch?.[1]


  if (typeof id === 'string') {
    const restore = registered.find((tool) => tool.name === 'ctx_restore')
    const value = await restore.execute({ id })
    check('ctx_restore finds the entry', () => {
      assert.equal(value.found, true)
      assert.equal(value.originalChars, original.length)
      assert.equal(value.totalLines, original.split('\n').length)
    })
    // The default page is 200 lines, so a 250-line original needs a second call.
    check('ctx_restore pages a long original by default', () => {
      assert.equal(value.returnedLines, 200)
      assert.equal(value.more, true)
    })
    const whole = await restore.execute({ id, max_lines: 2000 })
    check('ctx_restore reproduces the original byte for byte', () => {
      assert.equal(whole.content, original)
      assert.equal(whole.more, false)
    })
    const page = await restore.execute({ id, start_line: 1, max_lines: 5 })
    check('ctx_restore honours start_line and max_lines', () => {
      assert.equal(page.returnedLines, 5)
      assert.equal(page.startLine, 1)
      assert.equal(page.more, true)
      assert.ok(original.startsWith(page.content))
    })
    const tail = await restore.execute({ id, start_line: value.totalLines, max_lines: 10 })
    check('ctx_restore clamps start_line past the end', () => {
      assert.equal(tail.startLine, value.totalLines)
      assert.equal(tail.more, false)
    })
  } else {
    check('ctx_restore round-trip (skipped: no marker)', () => {
      throw new Error('L1 did not emit a marker, so the round-trip could not run')
    })
  }

  {
    const stats = registered.find((tool) => tool.name === 'ctx_stats')
    const value = await stats.execute({})
    check('ctx_stats reports a positive net saving', () => {
      assert.ok(value.reductions >= 1, `reductions=${value.reductions}`)
      assert.ok(value.savedChars > 0, `savedChars=${value.savedChars}`)
      assert.equal(typeof value.storePath, 'string')
      assert.ok(value.storePath.includes('diet-verify-'), 'the store must be the scratch one')
    })
  }

  {
    const audit = registered.find((tool) => tool.name === 'ctx_audit')
    const value = await audit.execute({})
    check('ctx_audit reports a verdict for an empty stream', () => {
      assert.equal(typeof value.cacheSignal, 'string')
      assert.equal(value.requests, 0)
      assert.equal(typeof value.pricingPhase, 'string')
      assert.ok(Number.isFinite(value.costUsd))
    })
  }

  // ---- Byte contracts: file reads and own tools are never reshaped ---------
  {
    const result = { isError: false, content: [{ type: 'text', text: BUILD_LOG }] }
    let decision
    if (typeof listener === 'function') {
      decision = await listener(
        { name: 'read', arguments: { file_path: 'src/kernel/mm/memory_set.rs' } },
        result,
        async () => ({ kind: 'accept', content: [{ type: 'text', text: BUILD_LOG }] })
      )
    }
    check('L1 never reshapes a `read` result', () => {
      assert.equal(decision.content[0].text, BUILD_LOG)
    })
  }

  {
    // A `.rs` path must be protected by the default noFoldForPatterns, even when
    // the same text would have been collapsed as a shell result.
    const result = { isError: false, content: [{ type: 'text', text: BUILD_LOG }] }
    let decision
    if (typeof listener === 'function') {
      decision = await listener(
        { name: 'pwsh', arguments: { command: 'cat src/main.rs', path: 'src/main.rs' } },
        result,
        async () => ({ kind: 'accept', content: [{ type: 'text', text: BUILD_LOG }] })
      )
    }
    check('L1 respects noFoldForPatterns for source paths', () => {
      assert.equal(decision.content[0].text, BUILD_LOG)
    })
  }

  {
    const result = { isError: false, content: [{ type: 'text', text: BUILD_LOG }] }
    let decision
    if (typeof listener === 'function') {
      decision = await listener(
        { name: 'pwsh', arguments: { command: 'cargo build' } },
        result,
        async () => ({ kind: 'accept', content: [{ type: 'text', text: SMALL_OUTPUT }] })
      )
    }
    check('L1 leaves output under minChars alone', () => {
      assert.equal(decision.content[0].text, SMALL_OUTPUT)
    })
  }

  {
    const result = { isError: true, content: [{ type: 'text', text: BUILD_LOG }] }
    let decision
    if (typeof listener === 'function') {
      decision = await listener(
        { name: 'pwsh', arguments: { command: 'cargo build' } },
        result,
        async () => ({ kind: 'accept', content: [{ type: 'text', text: BUILD_LOG }] })
      )
    }
    check('L1 leaves failed results alone by default', () => {
      assert.equal(decision.content[0].text, BUILD_LOG)
    })
  }

  {
    let decision
    if (typeof listener === 'function') {
      decision = await listener(
        { name: 'pwsh', arguments: { command: 'cargo build' } },
        { isError: false, content: [] },
        async () => ({ kind: 'accept', value: { ok: true } })
      )
    }
    check('L1 passes a structured value decision straight through', () => {
      assert.deepEqual(decision.value, { ok: true })
    })
  }

  // ---- L2 is off by default and must not touch messages --------------------
  {
    const { pruneHistory } = await import(new URL('../lib/prune.js', import.meta.url).href)
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{"file_path":"x.rs"}' }] },
      { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'x'.repeat(500) }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'b', name: 'pwsh', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'b', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{"file_path":"x.rs"}' }] },
      { role: 'tool', toolCallId: 'c', content: [{ type: 'text', text: 'y'.repeat(500) }] }
    ]
    const frozen = JSON.stringify(messages)
    if (typeof preStep === 'function') {
      await preStep(
        { agent: { id: 'verify' }, messages, step: 1, signal: undefined },
        async () => ({ messages, startsRequestSeries: true })
      )
    }
    check('L2 (disabled by default) does not rewrite history', () => {
      assert.equal(JSON.stringify(messages), frozen)
    })
  }

  // ---- Teardown must not throw --------------------------------------------
  check('the disposer runs cleanly', () => {
    if (typeof dispose === 'function') dispose()
  })

  // ---- Packaging: the peer declaration is load-bearing ---------------------
  // Measured, not assumed: with the resolve hook above swapped out for nothing,
  // `dsh --profile <p> --dump-config` happily prints this bundle, but booting
  // that profile prints `failed to import: ERR_MODULE_NOT_FOUND: Cannot find
  // package '@deepseek-ai/dsh-tools'` and the entry never activates. Adding the
  // declaration below is what makes the harness resolve the specifier. Drop it
  // and the plugin goes silent with no error anywhere in the UI.
  check('package.json declares the @deepseek-ai/dsh-tools peer dependency', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const range = manifest.peerDependencies?.['@deepseek-ai/dsh-tools']
    assert.equal(typeof range, 'string', 'peerDependencies must declare @deepseek-ai/dsh-tools')
    assert.ok(range.trim().length > 0, 'the peer range must not be empty')
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  })

  // ---- Report --------------------------------------------------------------
  let failed = 0
  for (const entry of checks) {
    if (entry.ok) {
      console.log(`  ok   ${entry.label}`)
    } else {
      failed += 1
      console.log(`  FAIL ${entry.label}`)
      console.log(`       ${entry.error?.message ?? entry.error}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
  return failed
}

main()
  .then((failed) => {
    rmSync(scratch, { recursive: true, force: true })
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch((error) => {
    rmSync(scratch, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
  })
