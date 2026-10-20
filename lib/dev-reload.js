/**
 * Development hot reload for this plugin's own source.
 *
 * Why this exists: editing `lib/fold.js` used to cost a full DSH restart, which
 * interrupts every live session and throws away the provider's prefix cache for
 * all of them. That is far too expensive for a threshold tweak.
 *
 * The reason a restart was required is not the loader — it is Node's ESM cache.
 * Importing the same file URL twice returns the FIRST module object, byte for
 * byte, even after the file on disk changed. Measured on the bundled runtime
 * (Node 24.21 / Electron 44): `import(url)` twice around a rewrite returns the
 * old value; `import(url + '?v=' + n)` returns the new one.
 *
 * So this module installs a resolve hook (`module.registerHooks`, Node >=22.15,
 * synchronous and in-thread) that stamps every module resolved INSIDE one
 * `lib/` directory with `?v=<generation>`. Bumping the generation makes the next
 * import of that directory's entry re-read the entry AND every relative import
 * it makes, because the query is part of each module's own URL rather than
 * something inherited from the entry.
 *
 * It is armed only when the package root contains a `.dev-reload` marker file,
 * so an installed copy (no marker) behaves exactly as before: one load, no
 * watcher, no hook. Create the marker to arm it; the marker is read at apply
 * time, so removing it takes effect on the next start.
 *
 * Scope of the hook: `file:` URLs under the given `lib/` only. Resolving
 * `@deepseek-ai/dsh-tools` or any other package passes through untouched.
 */
import { existsSync, watch } from 'node:fs'
import * as nodeModule from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * `registerHooks` landed in Node 22.15. Reached as a namespace member rather
 * than a named import: a named import of a missing export is a SyntaxError at
 * module load, which would take the whole plugin down on an older runtime
 * instead of merely disabling the reloader.
 */
const registerHooks = nodeModule.registerHooks

/** Marker file that arms the reloader; read from the package root. */
export const DEV_RELOAD_MARKER = '.dev-reload'

/** Debounce: one editor save is not one filesystem event. */
export const RELOAD_DEBOUNCE_MS = 250

/** This module's own directory — the default thing to watch and bust. */
const OWN_LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** Bumped on every reload; part of the URL of every module under the watched dir. */
let generation = 0
let hooksInstalled = false

/**
 * Install the cache-busting resolve hook, once per process.
 *
 * The hook is process-global and cannot be removed, so it must be narrow: only
 * `file:` URLs under `libDir`, and never a URL already carrying a generation.
 *
 * @param {{ warn: Function }} logger
 * @param {string} libDir directory whose modules should carry a generation
 * @returns whether the runtime supports it (a dead reloader must say so, not lie)
 */
export function installCacheBuster(logger, libDir = OWN_LIB_DIR) {
  if (hooksInstalled) return true
  if (typeof registerHooks !== 'function') {
    logger.warn(
      'dsh-context-diet: hot reload unavailable — this runtime has no module.registerHooks; '
      + 'edits still need a restart'
    )
    return false
  }
  // Trailing separator so `lib2/` cannot match a prefix for `lib/`.
  const prefix = pathToFileURL(libDir.endsWith(sep) ? libDir : `${libDir}${sep}`).href
  try {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context)
        const url = resolved?.url
        if (typeof url === 'string' && url.startsWith(prefix) && !url.includes('?v=')) {
          return { ...resolved, url: `${url}?v=${generation}` }
        }
        return resolved
      }
    })
  } catch (error) {
    logger.warn(`dsh-context-diet: hot reload unavailable — ${error?.message ?? String(error)}`)
    return false
  }
  hooksInstalled = true
  return true
}

/** Bump the generation the hook stamps. Exported so a test can drive it. */
export function nextGeneration() {
  generation += 1
  return generation
}

/** Current generation, for logging and tests. */
export function currentGeneration() {
  return generation
}

/**
 * Arm the reloader when the marker exists.
 *
 * `holder.current` is the live plugin instance; the reloader swaps it. The
 * caller's `ctx.effect` disposer must dispose `holder.current`, so a reload is
 * invisible to the host — the fiber keeps owning whatever is current, and the
 * plugin's own shutdown path stays correct across any number of reloads.
 *
 * @param {object} options
 * @param {object} options.ctx cordis context, passed through to `startPlugin`
 * @param {object} options.rawConfig the config `apply` was called with
 * @param {{ current: null | { dispose?: () => void } }} options.holder
 * @param {{ warn: Function }} options.logger
 * @param {string} [options.libDir] source directory to watch and bust
 * @param {string} [options.entry] module basename to re-import, default index.js
 * @param {number} [options.debounceMs]
 * @returns {null | { dispose: () => void }} the watcher, or null when disarmed
 */
export function installDevReload({
  ctx,
  rawConfig,
  holder,
  logger,
  libDir = OWN_LIB_DIR,
  entry = 'index.js',
  debounceMs = RELOAD_DEBOUNCE_MS
}) {
  const marker = join(dirname(libDir), DEV_RELOAD_MARKER)
  if (!existsSync(marker)) return null
  if (!installCacheBuster(logger, libDir)) return null

  const entryUrl = pathToFileURL(join(libDir, entry)).href
  let timer = null
  let running = false
  let queued = false
  let closed = false

  const reload = async () => {
    if (closed) return
    if (running) {
      queued = true
      return
    }
    running = true
    const started = Date.now()
    try {
      // Import BEFORE disposing: a syntax error in the edited file must leave
      // the running instance alone, not take the plugin down until the next edit.
      nextGeneration()
      let fresh
      try {
        fresh = await import(entryUrl)
      } catch (error) {
        logger.warn(`dsh-context-diet: reload skipped, the edit does not import — ${error?.message ?? String(error)}`)
        return
      }
      if (typeof fresh?.startPlugin !== 'function') {
        logger.warn('dsh-context-diet: reload skipped, the edited build exports no startPlugin')
        return
      }
      // Tools are name-keyed, so the old instance has to be gone before the new
      // one registers or the registration is a duplicate.
      const previous = holder.current
      holder.current = null
      try {
        previous?.dispose?.()
      } catch (error) {
        logger.warn(`dsh-context-diet: old instance failed to dispose — ${error?.message ?? String(error)}`)
      }
      try {
        holder.current = await fresh.startPlugin(ctx, rawConfig)
      } catch (error) {
        logger.warn(`dsh-context-diet: reload failed while starting — ${error?.message ?? String(error)}`)
        return
      }
      logger.warn(
        `dsh-context-diet: reloaded from source in ${Date.now() - started}ms `
        + `(generation ${currentGeneration()})`
      )
    } finally {
      running = false
      if (queued && !closed) {
        queued = false
        schedule()
      }
    }
  }

  const schedule = () => {
    if (closed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      reload().catch(() => {})
    }, debounceMs)
    // A pending dev reload must not be a reason for the process to stay alive.
    if (typeof timer.unref === 'function') timer.unref()
  }

  let watcher
  try {
    watcher = watch(libDir, { persistent: false }, (_event, filename) => {
      if (typeof filename === 'string' && filename.endsWith('.js')) schedule()
    })
  } catch (error) {
    logger.warn(`dsh-context-diet: hot reload unavailable, cannot watch ${libDir} — ${error?.message ?? String(error)}`)
    return null
  }
  watcher.on('error', () => {})

  logger.warn(
    `dsh-context-diet: hot reload armed — edits under ${libDir} are picked up without a restart `
    + `(delete ${DEV_RELOAD_MARKER} to disarm)`
  )

  return {
    dispose() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      try {
        watcher.close()
      } catch { /* already closed */ }
    }
  }
}
