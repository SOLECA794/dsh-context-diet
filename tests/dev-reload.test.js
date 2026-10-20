/**
 * Tests for the development hot reloader.
 *
 * The property under test is not "the watcher fires" — it is **"the new bytes
 * are what runs"**. Node's ESM cache returns the first module object forever for
 * a given URL, so a reload that re-imports without changing the URL looks
 * perfectly successful and runs the old code. That is the failure this whole
 * module exists to avoid, so it is the failure the test has to be able to see.
 *
 * The proof therefore runs in a CHILD process with a throwaway fixture
 * directory: the resolve hook is process-global and cannot be uninstalled, so
 * installing it inside the test runner would leak into every later test file.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const RELOADER = join(HERE, '..', 'lib', 'dev-reload.js')

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * A fake plugin laid out like this one: `lib/index.js` importing `lib/dep.js`,
 * plus a `startPlugin` that reports which version of `dep.js` it saw.
 */
function fixture({ marker = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'diet-reload-'))
  roots.push(root)
  const lib = join(root, 'lib')
  mkdirSync(lib, { recursive: true })
  if (marker) writeFileSync(join(root, '.dev-reload'), '')
  writeFileSync(join(lib, 'dep.js'), "export const VALUE = 'one'\n")
  writeFileSync(
    join(lib, 'index.js'),
    [
      "import { VALUE } from './dep.js'",
      'export async function startPlugin() {',
      '  return { value: VALUE, dispose() {} }',
      '}',
      ''
    ].join('\n')
  )
  return { root, lib }
}

/** Run the reloader against a fixture in a child process and return its output. */
function runChild(lib, script) {
  const runner = join(dirname(lib), 'runner.mjs')
  writeFileSync(runner, script)
  const result = spawnSync(process.execPath, [runner, lib, RELOADER], { encoding: 'utf8', timeout: 30_000 })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('dev-reload', () => {
  it('is disarmed when the marker file is absent', async () => {
    const { lib } = fixture({ marker: false })
    const { installDevReload } = await import('../lib/dev-reload.js')
    const holder = { current: { dispose() {} } }
    const warnings = []
    const handle = installDevReload({
      ctx: {},
      rawConfig: {},
      holder,
      logger: { warn: (message) => warnings.push(message) },
      libDir: lib,
      debounceMs: 20
    })
    assert.equal(handle, null, 'no marker must mean no watcher and no hook')
    // Silence is the point: an installed copy should not even log about this.
    assert.deepEqual(warnings, [])
  })

  it('runs the edited bytes, not the cached module', () => {
    const { lib } = fixture()
    const { status, out } = runChild(
      lib,
      [
        "import { writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "import { pathToFileURL } from 'node:url'",
        'const [libDir, reloader] = process.argv.slice(2)',
        'const entry = join(libDir, "index.js")',
        'const { installDevReload } = await import(pathToFileURL(reloader).href)',
        'const first = await import(pathToFileURL(entry).href)',
        'const holder = { current: await first.startPlugin() }',
        'console.log("initial:" + holder.current.value)',
        'const logs = []',
        'const handle = installDevReload({',
        '  ctx: {}, rawConfig: {}, holder,',
        '  logger: { warn: (m) => logs.push(m) },',
        '  libDir, debounceMs: 30',
        '})',
        'if (handle === null) { console.log("not armed"); process.exit(2) }',
        'writeFileSync(join(libDir, "dep.js"), "export const VALUE = \'two\'\\n")',
        'const deadline = Date.now() + 8000',
        'while (Date.now() < deadline && holder.current?.value !== "two") {',
        '  await new Promise((r) => setTimeout(r, 50))',
        '}',
        'console.log("after:" + (holder.current?.value ?? "none"))',
        'console.log("reloaded:" + logs.some((m) => m.includes("reloaded from source")))',
        'handle.dispose()',
        ''
      ].join('\n')
    )
    assert.equal(status, 0, `child failed:\n${out}`)
    assert.match(out, /initial:one/, 'the fixture starts on the original bytes')
    assert.match(
      out,
      /after:two/,
      `the reloaded instance must see the edited dependency — ESM cache was not busted:\n${out}`
    )
    assert.match(out, /reloaded:true/, 'the reloader must report success, not merely stay quiet')
  })

  it('keeps the old instance alive when the edit does not import', () => {
    const { lib } = fixture()
    const { status, out } = runChild(
      lib,
      [
        "import { writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "import { pathToFileURL } from 'node:url'",
        'const [libDir, reloader] = process.argv.slice(2)',
        'const { installDevReload } = await import(pathToFileURL(reloader).href)',
        'const first = await import(pathToFileURL(join(libDir, "index.js")).href)',
        'const holder = { current: await first.startPlugin() }',
        'const logs = []',
        'const handle = installDevReload({',
        '  ctx: {}, rawConfig: {}, holder,',
        '  logger: { warn: (m) => logs.push(m) },',
        '  libDir, debounceMs: 30',
        '})',
        'writeFileSync(join(libDir, "index.js"), "export const oops = (\\n")',
        'const deadline = Date.now() + 6000',
        'while (Date.now() < deadline && !logs.some((m) => m.includes("does not import"))) {',
        '  await new Promise((r) => setTimeout(r, 50))',
        '}',
        'console.log("alive:" + (holder.current?.value ?? "none"))',
        'console.log("warned:" + logs.some((m) => m.includes("does not import")))',
        'handle.dispose()',
        ''
      ].join('\n')
    )
    assert.equal(status, 0, `child failed:\n${out}`)
    assert.match(
      out,
      /alive:one/,
      `a broken edit must not take the running instance down:\n${out}`
    )
    assert.match(out, /warned:true/, 'a skipped reload has to say so')
  })
})
