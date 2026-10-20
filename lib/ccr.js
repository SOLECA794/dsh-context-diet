/**
 * dsh-context-diet — reversible store + honest savings ledger.
 *
 * Two jobs, both deliberately boring:
 *
 * 1. **Reversibility.** Every lossy reduction writes the exact original here
 *    under an id derived from its own content hash, and the reduced text
 *    carries that id. `ctx_restore(id)` returns the original byte-for-byte.
 *    Content-addressing also dedupes: folding the same build log twice costs
 *    one entry.
 *
 * 2. **Honest accounting.** dsh-context-compression-improved got this right and
 *    most "we saved 90% of your tokens" plugins get it wrong: a saving is only
 *    real if the model did not later pay to read the same bytes again. So this
 *    store also hashes everything that flows *through* the router. If a
 *    reduction's original later reappears in full (the model re-read the whole
 *    file), the entry is marked `regretted` and its saving is subtracted from
 *    the reported net — the ledger is allowed to go negative.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STORE_VERSION = 1
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 2000

export function defaultStorePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-context-diet-ccr.json')
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex')
}

function usable(entry, now) {
  if (entry === null || typeof entry !== 'object') return false
  if (typeof entry.id !== 'string' || entry.id.length === 0) return false
  if (typeof entry.originalText !== 'string') return false
  if (typeof entry.storedAt !== 'number' || !Number.isFinite(entry.storedAt)) return false
  return entry.expiresAt === undefined || (Number.isFinite(entry.expiresAt) && entry.expiresAt > now)
}

/**
 * @param {{
 *   enabled?: boolean,
 *   persist?: boolean,
 *   ttlMs?: number,
 *   maxEntries?: number,
 *   storePath?: string,
 *   logger?: { warn: (message: string) => void }
 * }} [options]
 */
export function createStore(options = {}) {
  const enabled = options.enabled !== false
  const persist = enabled && options.persist !== false
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES
  const storePath = typeof options.storePath === 'string' && options.storePath.length > 0
    ? options.storePath
    : defaultStorePath()
  const logger = options.logger ?? console

  /** @type {Map<string, any>} */
  const entries = new Map()
  /** hash(originalText) → retrieval id, so a re-read can find its regret. */
  const byHash = new Map()
  /** hash(text) → { id, seenAt } for every text that passed through unmatched. */
  const passthrough = new Map()

  let saveTimer = null
  let dirty = false
  let saveChain = Promise.resolve()
  let ready = null

  const totals = {
    /** chars removed by accepted reductions */
    savedChars: 0,
    /** chars that had to be re-sent because the model re-read the original */
    regretChars: 0,
    reductions: 0,
    regretted: 0,
    passthrough: 0
  }

  function scheduleSave() {
    if (!persist || saveTimer !== null) return
    dirty = true
    saveTimer = setTimeout(() => {
      saveTimer = null
      void save()
    }, 1000)
    saveTimer?.unref?.()
  }

  async function save() {
    saveChain = saveChain.then(async () => {
      if (!persist || !dirty) return
      dirty = false
      const payload = {
        version: STORE_VERSION,
        totals,
        entries: [...entries.entries()].map(([id, entry]) => ({ id, ...entry }))
      }
      try {
        await mkdir(dirname(storePath), { recursive: true })
        const tmp = `${storePath}.tmp`
        await writeFile(tmp, JSON.stringify(payload), 'utf8')
        await rename(tmp, storePath)
      } catch (error) {
        logger.warn(`dsh-context-diet: saving the retrieval store failed: ${String(error)}`)
      }
    })
    await saveChain
  }

  function prune() {
    const now = Date.now()
    for (const [id, entry] of entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        entries.delete(id)
        byHash.delete(entry.hash)
      }
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      const entry = entries.get(oldest)
      entries.delete(oldest)
      if (entry !== undefined) byHash.delete(entry.hash)
    }
  }

  /**
   * Store an original and return its content-addressed id.
   *
   * @param {{ toolName: string, callId?: string, sessionId?: string, reducer: string,
   *           originalText: string, compressedChars: number, turn?: number }} entry
   * @returns {string|null} the retrieval id, or `null` when the store is disabled
   */
  function put(entry) {
    if (!enabled) return null
    if (entry === null || typeof entry !== 'object') return null
    if (typeof entry.originalText !== 'string' || entry.originalText.length === 0) return null
    const hash = sha(entry.originalText)
    const existing = byHash.get(hash)
    const originalChars = entry.originalText.length
    if (existing !== undefined && entries.has(existing)) {
      // Same bytes folded again: refresh the metadata, keep one copy.
      const record = entries.get(existing)
      record.toolName = entry.toolName
      record.callId = entry.callId ?? record.callId
      record.reducer = entry.reducer
      record.compressedChars = entry.compressedChars
      record.turn = entry.turn ?? record.turn
      scheduleSave()
      return existing
    }
    const id = `diet:${hash.slice(0, 16)}`
    const storedAt = Date.now()
    entries.set(id, {
      toolName: entry.toolName,
      callId: entry.callId ?? '',
      sessionId: entry.sessionId ?? '',
      reducer: entry.reducer,
      hash,
      originalChars,
      compressedChars: entry.compressedChars,
      originalText: entry.originalText,
      storedAt,
      expiresAt: storedAt + ttlMs,
      turn: entry.turn,
      regretted: false,
      restoreCount: 0
    })
    byHash.set(hash, id)
    totals.savedChars += originalChars - entry.compressedChars
    totals.reductions += 1
    prune()
    scheduleSave()
    return id
  }

  /**
   * Record a text that flowed through unreduced.
   *
   * If it matches a stored original byte-for-byte, the model paid the full price
   * for bytes we claimed to have saved — book the regret.
   *
   * @param {string} text
   * @returns {{ regretted: boolean, id?: string }}
   */
  function observePassthrough(text) {
    if (!enabled || typeof text !== 'string' || text.length === 0) return { regretted: false }
    totals.passthrough += 1
    const hash = sha(text)
    const id = byHash.get(hash)
    if (id === undefined) {
      passthrough.set(hash, { seenAt: Date.now() })
      if (passthrough.size > maxEntries) {
        const oldest = passthrough.keys().next().value
        if (oldest !== undefined) passthrough.delete(oldest)
      }
      return { regretted: false }
    }
    const record = entries.get(id)
    if (record === undefined || record.regretted) return { regretted: false }
    record.regretted = true
    totals.regretted += 1
    totals.regretChars += record.originalChars
    scheduleSave()
    return { regretted: true, id }
  }

  /**
   * @param {string} id
   * @returns {any|null} the entry, or `null` when absent/expired
   */
  function get(id) {
    if (typeof id !== 'string' || id.length === 0) return null
    const entry = entries.get(id)
    if (entry === undefined) return null
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      entries.delete(id)
      byHash.delete(entry.hash)
      scheduleSave()
      return null
    }
    return entry
  }

  /** Mark a retrieval so the ledger can tell "restored once" from "restored a lot". */
  function noteRestore(id) {
    const entry = entries.get(id)
    if (entry === undefined) return 0
    entry.restoreCount += 1
    scheduleSave()
    return entry.restoreCount
  }

  function stats() {
    let storeChars = 0
    for (const entry of entries.values()) storeChars += entry.originalChars
    const netChars = totals.savedChars - totals.regretChars
    return {
      entries: entries.size,
      storeChars,
      reductions: totals.reductions,
      savedChars: totals.savedChars,
      regretChars: totals.regretChars,
      netChars,
      regretted: totals.regretted,
      passthrough: totals.passthrough
    }
  }

  async function init() {
    if (ready !== null) return store
    ready = (async () => {
      if (!enabled) return
      try {
        const raw = await readFile(storePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || parsed.version !== STORE_VERSION) return
        if (parsed.totals !== null && typeof parsed.totals === 'object') {
          for (const key of Object.keys(totals)) {
            const value = parsed.totals[key]
            if (typeof value === 'number' && Number.isFinite(value)) totals[key] = value
          }
        }
        const now = Date.now()
        if (!Array.isArray(parsed.entries)) return
        for (const entry of parsed.entries.slice(-maxEntries)) {
          if (!usable(entry, now)) continue
          entries.set(entry.id, {
            toolName: entry.toolName ?? '',
            callId: entry.callId ?? '',
            sessionId: entry.sessionId ?? '',
            reducer: entry.reducer ?? '',
            hash: typeof entry.hash === 'string' && entry.hash.length > 0 ? entry.hash : sha(entry.originalText),
            originalChars: entry.originalChars ?? entry.originalText.length,
            compressedChars: entry.compressedChars ?? 0,
            originalText: entry.originalText,
            storedAt: entry.storedAt,
            expiresAt: entry.expiresAt,
            turn: entry.turn,
            regretted: entry.regretted === true,
            restoreCount: entry.restoreCount ?? 0
          })
          byHash.set(entries.get(entry.id).hash, entry.id)
        }
      } catch {
        /* first run, missing file, or a corrupt store: start empty */
      }
    })()
    await ready
    return store
  }

  async function flush() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await save()
  }

  function dispose() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    void save()
  }

  function reset() {
    entries.clear()
    byHash.clear()
    passthrough.clear()
    for (const key of Object.keys(totals)) totals[key] = 0
    scheduleSave()
  }

  const store = {
    init,
    put,
    get,
    noteRestore,
    observePassthrough,
    stats,
    flush,
    dispose,
    reset,
    storePath,
    get size() { return entries.size }
  }
  return store
}
