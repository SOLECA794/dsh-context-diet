/**
 * dsh-context-diet — when to prune history, and how hard.
 *
 * Ported from Tianshu-harness (`src/cache/advisor.ts`, `src/compact/constants.ts`,
 * `src/cache/session-warmth.ts`) because those three files together answer the
 * question this plugin exists to answer: *rewriting history is only worth it if
 * the prefix you destroy was not being served from cache.*
 *
 * The reasoning, verbatim from the original:
 *
 *   "Compressing invalidates the whole prefix → the miss cost is proportional
 *    to hitRate (the fraction of input that was cached), while the benefit of
 *    compressing rises with window pressure (near the threshold, the headroom
 *    is worth more than cache protection)."
 *
 *   protection = hitRate × (1 − pressure)
 *
 * Everything here is a pure function of numbers and the clock, so it is
 * trivially testable and free to call on every step.
 */

/* ------------------------------------------------------------------ *
 * Pressure and protection
 * ------------------------------------------------------------------ */

/** Fraction of the window currently occupied, clamped to [0, 1]. */
export function computePressure(estimatedTokens, contextWindow) {
  if (!(contextWindow > 0)) return 0
  return Math.min(1, Math.max(0, estimatedTokens / contextWindow))
}

/** Tier names, in the order they escalate. */
export const TIERS = Object.freeze(['watch', 'compact', 'reactive', 'ceiling'])

/**
 * Threshold ratios per provider cache behaviour.
 *
 * `cache-preserving` is for providers with an exact-prefix cache that survives
 * long idle gaps; prune later so the prefix keeps getting hits. `aggressive` is
 * for providers with no usable prefix cache (a relay that reports a constant
 * `cached_tokens`, for instance) — there is nothing to preserve, so prune early
 * and often.
 */
export const POLICY_RATIOS = Object.freeze({
  'cache-preserving': Object.freeze({ watch: 0.72, compact: 0.86, reactive: 0.92, ceiling: 0.95 }),
  balanced: Object.freeze({ watch: 0.60, compact: 0.78, reactive: 0.88, ceiling: 0.95 }),
  aggressive: Object.freeze({ watch: 0.50, compact: 0.70, reactive: 0.84, ceiling: 0.95 })
})

/**
 * Pick a ratio profile from the observed provider behaviour.
 *
 * @param {'exact-prefix'|'none'|'unknown'|string} cacheType
 * @param {boolean} [persistent] whether the cache survives long idle gaps
 */
export function strategyForCacheType(cacheType, persistent = false) {
  if (cacheType === 'exact-prefix' && persistent) return 'cache-preserving'
  if (cacheType === 'none') return 'aggressive'
  return 'balanced'
}

/** Ratios nudged by the recently observed hit rate. */
export function adaptiveRatios(strategy, recentHitRate) {
  const base = POLICY_RATIOS[strategy] ?? POLICY_RATIOS.balanced
  if (!Number.isFinite(recentHitRate)) return { ...base }
  if (recentHitRate >= 0.85) {
    return {
      watch: Math.min(base.watch + 0.05, 0.9),
      compact: Math.min(base.compact + 0.03, 0.93),
      reactive: Math.min(base.reactive + 0.02, 0.95),
      ceiling: base.ceiling
    }
  }
  if (recentHitRate < 0.3) {
    return {
      watch: Math.max(base.watch - 0.1, 0.4),
      compact: Math.max(base.compact - 0.08, 0.6),
      reactive: Math.max(base.reactive - 0.05, 0.75),
      ceiling: base.ceiling
    }
  }
  return { ...base }
}

/**
 * Hard upper bound on how much of the advertised window is "precise working
 * room", regardless of caching.
 *
 * The original comment is the argument: an advertised context window is a
 * capacity, not a precision guarantee — needle-in-haystack recall degrades well
 * before the nominal limit, so pushing compression to 0.86 leaves the model
 * working in its degraded range for most of a long session.
 */
export function precisionCeilingRatio(contextWindow, override) {
  if (Number.isFinite(override) && override > 0) return Math.min(1, override)
  if (contextWindow >= 500_000) return 0.7
  if (contextWindow >= 200_000) return 0.55
  return 1
}

/** Absolute token thresholds derived from the ratios (used for logging/UI). */
export function thresholdsFor({ contextWindow, strategy = 'balanced', recentHitRate }) {
  const ratios = adaptiveRatios(strategy, recentHitRate)
  const ceiling = precisionCeilingRatio(contextWindow)

  // The precision ceiling is a hard cap on how much of the window we are willing
  // to fill. Clamping each ratio independently would collapse the whole ladder
  // onto the ceiling value (a 512K window caps at 0.7, which is below every
  // profile's `reactive` ratio, so watch == compact == reactive and the tier
  // distinction disappears). Scale the ladder instead so its shape survives.
  const highest = Math.max(ratios.watch, ratios.compact, ratios.reactive, ratios.ceiling)
  const scale = highest > ceiling ? ceiling / highest : 1

  const out = {}
  for (const tier of TIERS) {
    const ratio = Math.min(ratios[tier] * scale, ceiling)
    out[tier] = Math.floor(contextWindow * ratio)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Session warmth (Tianshu `SessionWarmthTracker`)
 * ------------------------------------------------------------------ */

export const WARMTH_HOT_MS = 60_000
export const WARMTH_TTL_MS = 60 * 60 * 1000

export function createWarmthTracker(config = {}) {
  const now = typeof config.now === 'function' ? config.now : () => Date.now()
  const hotMs = Number.isFinite(config.hotMs) ? config.hotMs : WARMTH_HOT_MS
  const ttlMs = Number.isFinite(config.ttlMs) ? config.ttlMs : WARMTH_TTL_MS
  let lastCall = 0

  return {
    /**
     * `cold` means the upstream prefix cache is almost certainly gone, so a
     * rewrite costs nothing extra — that is the free moment to prune.
     */
    predict() {
      if (lastCall === 0) return 'cold'
      const age = now() - lastCall
      if (age < hotMs) return 'hot'
      if (age < ttlMs) return 'warm'
      return 'cold'
    },
    shouldPruneOpportunistically() {
      return this.predict() === 'cold'
    },
    recordCall() {
      lastCall = now()
    },
    reset() {
      lastCall = 0
    },
    get lastCallAt() {
      return lastCall
    }
  }
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/**
 * Decide whether a history rewrite should be deferred.
 *
 * @param {{
 *   tier: 0|1|2|3,
 *   recentHitRate?: number,
 *   estimatedTokens?: number,
 *   contextWindow?: number,
 *   warmth?: 'cold'|'warm'|'hot',
 *   protectionFloor?: number
 * }} input
 * @returns {{ delay: boolean, reason: string, protection: number, pressure: number }}
 */
export function decidePruneDelay(input) {
  const tier = Number.isFinite(input.tier) ? Math.max(0, Math.min(3, Math.trunc(input.tier))) : 0
  const empty = { delay: false, reason: 'allow', protection: 0, pressure: 0 }
  if (!Number.isFinite(input.recentHitRate)) {
    return { ...empty, reason: 'no-hit-rate' }
  }
  const needsWindow = Number.isFinite(input.contextWindow) && input.contextWindow > 0
    && Number.isFinite(input.estimatedTokens)
  const pressure = needsWindow ? computePressure(input.estimatedTokens, input.contextWindow) : 0
  const protection = input.recentHitRate * (1 - pressure)

  // Reactive and ceiling tiers never wait: the window is the binding constraint,
  // and an out-of-window request costs more than any cache rebuild.
  if (tier >= 2) return { delay: false, reason: 'reactive-tier', protection, pressure }

  const floor = Number.isFinite(input.protectionFloor) ? input.protectionFloor : 0.45

  // A cold session means the upstream prefix cache has already aged out, so a
  // rewrite costs nothing extra — and the `recentHitRate` on hand is stale by
  // definition (it describes the last burst, not right now). Waiting here would
  // protect a cache that is no longer there.
  if (input.warmth === 'cold' && tier <= 1) {
    return { delay: false, reason: 'warmth-cold', protection, pressure }
  }

  if (protection >= floor) return { delay: true, reason: 'protection', protection, pressure }

  if (input.warmth === 'hot' && tier <= 1 && pressure < 0.5) {
    return { delay: true, reason: 'warmth-hot', protection, pressure }
  }

  return { delay: false, reason: 'allow', protection, pressure }
}

/** Which tier a given token pressure falls into, using the same ratios. */
export function tierForTokens(tokens, contextWindow, strategy = 'balanced', recentHitRate) {
  const t = thresholdsFor({ contextWindow, strategy, recentHitRate })
  if (tokens >= t.reactive) return 3
  if (tokens >= t.compact) return 2
  if (tokens >= t.watch) return 1
  return 0
}

/* ------------------------------------------------------------------ *
 * Peak / off-peak pricing (DeepSeek, Tianshu `src/utils/pricing-phase.ts`)
 * ------------------------------------------------------------------ */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/** Minutes-of-day, half-open: 09:00–12:00 and 14:00–18:00 Beijing time. */
const PEAK_WINDOWS = [[540, 720], [840, 1080]]

/**
 * `peak` on weekday mornings/afternoons in Beijing, `offpeak` otherwise.
 *
 * Computed from UTC fields plus a fixed offset so the answer does not depend on
 * the host time zone (the box may be anywhere; the price is Chinese).
 */
export function pricingPhase(nowMs = Date.now()) {
  const shifted = new Date(nowMs + BEIJING_OFFSET_MS)
  const weekday = shifted.getUTCDay()
  if (weekday === 0 || weekday === 6) return 'offpeak'
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  for (const [start, end] of PEAK_WINDOWS) {
    if (minutes >= start && minutes < end) return 'peak'
  }
  return 'offpeak'
}

/** Milliseconds until the next phase boundary (scanning a fortnight ahead). */
export function nextPricingTransition(nowMs = Date.now()) {
  const current = pricingPhase(nowMs)
  const startOfMinute = Math.floor(nowMs / 60_000) * 60_000
  for (let minute = 1; minute <= 14 * 24 * 60; minute += 1) {
    const probe = startOfMinute + minute * 60_000
    if (pricingPhase(probe) !== current) {
      return { to: pricingPhase(probe), inMs: probe - nowMs }
    }
  }
  return { to: current, inMs: HOUR_MS }
}
