/**
 * dsh-context-diet — L3: the audit that tells you whether any of this worked.
 *
 * Three parties report a cache hit rate for the same session and they routinely
 * disagree by an order of magnitude. All three can be right:
 *
 *   1. **DSH** counts `cacheReadTokens / (uncachedInputTokens + cacheReadTokens)`
 *      over the main request stream only, and treats a missing `usage` or a
 *      `cached_tokens: 0` as a plain miss.
 *   2. **billion-context** counts the wire, including its own compression
 *      round-trips and speculative traffic.
 *   3. **The provider's own ledger** (`/v1/usage`) counts what it actually
 *      billed, and is the only one that cannot lie about money.
 *
 * So this module never asserts "the hit rate is X". It reports the *shape* of
 * the evidence: whether `cacheReadTokens` is a real measurement or a constant,
 * whether it ever decreases (impossible in an append-only session unless the
 * prefix was rewritten), and where the money actually went.
 */

import { estimateAsciiTokens } from './core.js'
import { pricingPhase } from './policy.js'

/**
 * @typedef {{
 *   inputTokens?: number,
 *   cacheReadTokens?: number,
 *   cacheWriteTokens?: number,
 *   outputTokens?: number,
 *   main?: boolean,
 *   at?: number
 * }} UsageRow
 */

function num(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Hit rate over the whole observed stream.
 *
 * The `billed` variant is the one to trust when comparing against a provider
 * invoice: every token that reached the API is in the denominator.
 */
export function computeHitRate(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : []
  const onlyMain = options.mainOnly === true
  let uncached = 0
  let cached = 0
  let output = 0
  let requests = 0
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue
    if (onlyMain && row.main !== true) continue
    uncached += num(row.inputTokens)
    cached += num(row.cacheReadTokens)
    output += num(row.outputTokens)
    requests += 1
  }
  const total = uncached + cached
  return {
    requests,
    uncachedInputTokens: uncached,
    cacheReadTokens: cached,
    outputTokens: output,
    totalInputTokens: total,
    hitRate: total > 0 ? cached / total : 0
  }
}

/**
 * Both口径 at once, plus the gap between them.
 *
 * A widening gap means side traffic (compression summaries, speculation, retries)
 * is growing while the headline hit rate stays flat — a silent regression that
 * a single number cannot show.
 */
export function dualHitRate(rows) {
  const billed = computeHitRate(rows)
  const main = computeHitRate(rows, { mainOnly: true })
  return {
    billed,
    main,
    /** Percentage points by which the main stream beats the whole stream. */
    gapPoints: (main.hitRate - billed.hitRate) * 100,
    /** True when no row is flagged `main`, so the split is meaningless. */
    mainUnflagged: main.requests === 0
  }
}

/**
 * Is `cacheReadTokens` a measurement or a provider template?
 *
 * A relay that always answers `cached_tokens: 4332` regardless of prompt size
 * is not caching anything; it is filling a required field. Two distinct values
 * across many requests is the tell.
 */
export function cacheSignalQuality(rows, options = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && typeof row === 'object')
  const minSamples = Number.isSafeInteger(options.minSamples) ? options.minSamples : 8
  const values = new Map()
  for (const row of list) {
    const value = num(row.cacheReadTokens)
    values.set(value, (values.get(value) ?? 0) + 1)
  }
  const distinct = [...values.entries()].sort((a, b) => b[1] - a[1])
  const samples = list.length
  const topCount = distinct.length > 0 ? distinct[0][1] : 0
  const dominantShare = samples > 0 ? topCount / samples : 0

  let verdict = 'unknown'
  let reason = 'not enough samples to judge'
  if (samples >= minSamples) {
    if (distinct.length <= 2) {
      // A live cache produces a distinct value per request: prompt sizes vary,
      // so the cached prefix varies with them. Two values (or one) across many
      // requests cannot be a measurement — the split between them does not
      // matter, which is why no dominant-share guard applies here. Relays in
      // the wild emit exactly this: one constant below some size, another above.
      verdict = 'template'
      reason = `only ${distinct.length} distinct cached_tokens value(s) across ${samples} requests, ${(dominantShare * 100).toFixed(0)}% identical — this field is being filled in, not measured`
    } else if (dominantShare >= 0.9) {
      verdict = 'stuck'
      reason = `${(dominantShare * 100).toFixed(0)}% of requests report the same cached_tokens — cache is not tracking prompt growth`
    } else {
      verdict = 'live'
      reason = `${distinct.length} distinct values across ${samples} requests`
    }
  }

  return {
    verdict,
    reason,
    samples,
    distinctValues: distinct.slice(0, 6).map(([value, count]) => ({ value, count })),
    dominantShare
  }
}

/**
 * In an append-only session `cacheReadTokens` should be non-decreasing. A drop
 * means the prefix stopped matching somewhere in the middle — either the client
 * rewrote history or the provider re-rendered it. That is a different failure
 * from "the cache expired because I went to lunch", and the fix is different.
 */
export function cacheMonotonicity(rows, options = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && typeof row === 'object')
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : 0
  const drops = []
  let previous = undefined
  let previousIndex = -1
  for (let index = 0; index < list.length; index += 1) {
    const value = num(list[index].cacheReadTokens)
    if (previous !== undefined && value < previous - tolerance) {
      drops.push({
        index,
        previous,
        current: value,
        lostTokens: previous - value,
        previousIndex
      })
    }
    previous = value
    previousIndex = index
  }
  const lost = drops.reduce((sum, drop) => sum + drop.lostTokens, 0)
  return {
    monotonic: drops.length === 0,
    drops,
    lostTokens: lost,
    /** Fewer than a handful of drops is ordinary (idle expiry); many is a bug. */
    verdict: drops.length === 0 ? 'clean' : drops.length <= 2 ? 'occasional' : 'systematic'
  }
}

/**
 * Detect a constant additive offset between the prompt we sent and the
 * `prompt_tokens` the provider reported.
 *
 * Relays sometimes pad every request with a fixed system preamble and bill for
 * it. If the offset is stable across wildly different prompt sizes, it is not
 * tokenisation — it is a fixed charge.
 *
 * @param {Array<{ sentChars?: number, sentTokens?: number, promptTokens: number }>} samples
 */
export function detectFixedFill(samples) {
  const list = (Array.isArray(samples) ? samples : [])
    .filter((sample) => sample !== null && typeof sample === 'object' && Number.isFinite(sample.promptTokens))
    .map((sample) => {
      const sent = Number.isFinite(sample.sentTokens)
        ? sample.sentTokens
        : Number.isFinite(sample.sentChars)
          ? estimateAsciiTokens(sample.sentChars)
          : undefined
      return sent === undefined ? undefined : { sent, promptTokens: sample.promptTokens }
    })
    .filter((sample) => sample !== undefined)
  if (list.length < 3) {
    return { detected: false, offset: 0, spread: 0, samples: list.length, reason: 'need at least 3 samples' }
  }
  const offsets = list.map((sample) => sample.promptTokens - sample.sent)
  const min = Math.min(...offsets)
  const max = Math.max(...offsets)
  const mean = offsets.reduce((sum, value) => sum + value, 0) / offsets.length
  const spread = max - min
  // A real tokeniser drifts with content; a fixed charge does not.
  const detected = spread <= Math.max(64, Math.abs(mean) * 0.1) && mean > 0
  return {
    detected,
    offset: Math.round(mean),
    spread: Math.round(spread),
    samples: list.length,
    reason: detected
      ? `every request carries ≈${Math.round(mean)} extra prompt tokens (±${Math.round(spread / 2)}) regardless of size — a fixed charge, not tokenisation`
      : `offset varies by ${Math.round(spread)} tokens across ${list.length} samples — consistent with normal tokenisation`
  }
}

/**
 * Cost of a run of usage rows, split by phase.
 *
 * Prices are per million tokens. Defaults are the DeepSeek list prices that the
 * relay's ledger uses, so the numbers are comparable to an invoice.
 */
export const DEFAULT_PRICES = Object.freeze({
  inputPerM: 1,
  cachedInputPerM: 0.02,
  outputPerM: 4
})

export function estimateCost(rows, prices = DEFAULT_PRICES, options = {}) {
  const list = Array.isArray(rows) ? rows : []
  const split = options.splitPhases === true
  const at = typeof options.now === 'function' ? options.now : () => Date.now()
  let uncached = 0
  let cached = 0
  let output = 0
  let peakUncached = 0
  let peakCached = 0
  let peakOutput = 0
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue
    const input = num(row.inputTokens)
    const cacheRead = num(row.cacheReadTokens)
    const out = num(row.outputTokens)
    uncached += input
    cached += cacheRead
    output += out
    if (split && pricingPhase(row.at ?? at()) === 'peak') {
      peakUncached += input
      peakCached += cacheRead
      peakOutput += out
    }
  }
  const cost = (uncached / 1e6) * prices.inputPerM
    + (cached / 1e6) * prices.cachedInputPerM
    + (output / 1e6) * prices.outputPerM
  const result = {
    uncachedInputTokens: uncached,
    cacheReadTokens: cached,
    outputTokens: output,
    cost,
    currency: 'USD'
  }
  if (split) {
    const peakCost = (peakUncached / 1e6) * prices.inputPerM
      + (peakCached / 1e6) * prices.cachedInputPerM
      + (peakOutput / 1e6) * prices.outputPerM
    result.peak = { uncachedInputTokens: peakUncached, cacheReadTokens: peakCached, outputTokens: peakOutput, cost: peakCost }
    result.offpeak = {
      uncachedInputTokens: uncached - peakUncached,
      cacheReadTokens: cached - peakCached,
      outputTokens: output - peakOutput,
      cost: cost - peakCost
    }
  }
  return result
}

/**
 * Put three ledgers side by side without pretending they must agree.
 *
 * @param {{
 *   dsh?: { uncachedInputTokens?: number, cacheReadTokens?: number, outputTokens?: number },
 *   bili?: { uncachedInputTokens?: number, cacheReadTokens?: number, outputTokens?: number },
 *   provider?: { uncachedInputTokens?: number, cacheReadTokens?: number, outputTokens?: number }
 * }} input
 */
export function reconcile(input = {}) {
  const ledgers = []
  for (const [name, value] of [['dsh', input.dsh], ['bili', input.bili], ['provider', input.provider]]) {
    if (value === null || typeof value !== 'object') continue
    const uncached = num(value.uncachedInputTokens)
    const cached = num(value.cacheReadTokens)
    const total = uncached + cached
    ledgers.push({
      ledger: name,
      uncachedInputTokens: uncached,
      cacheReadTokens: cached,
      outputTokens: num(value.outputTokens),
      totalInputTokens: total,
      hitRate: total > 0 ? cached / total : 0
    })
  }
  if (ledgers.length < 2) {
    return { ledgers, consistent: false, reason: 'need at least two ledgers to compare' }
  }
  const rates = ledgers.map((entry) => entry.hitRate)
  const spreadPoints = (Math.max(...rates) - Math.min(...rates)) * 100
  const authoritative = ledgers.find((entry) => entry.ledger === 'provider') ?? ledgers[ledgers.length - 1]
  return {
    ledgers,
    spreadPoints,
    authoritative: authoritative.ledger,
    /**
     * A spread under 5 points is measurement noise between definitions. Above
     * that, at least one party is counting a different set of requests.
     */
    consistent: spreadPoints <= 5,
    reason: spreadPoints <= 5
      ? 'the three ledgers agree within measurement noise'
      : `${spreadPoints.toFixed(1)} point spread — the ledgers are counting different request sets; bill against the provider ledger`
  }
}
