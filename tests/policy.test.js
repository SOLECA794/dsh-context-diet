import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  POLICY_RATIOS,
  TIERS,
  WARMTH_HOT_MS,
  WARMTH_TTL_MS,
  adaptiveRatios,
  computePressure,
  createWarmthTracker,
  decidePruneDelay,
  nextPricingTransition,
  precisionCeilingRatio,
  pricingPhase,
  strategyForCacheType,
  thresholdsFor,
  tierForTokens
} from '../lib/policy.js'

test('POLICY_RATIOS are ordered, and cache-preserving is the most reluctant', () => {
  for (const [name, ratio] of Object.entries(POLICY_RATIOS)) {
    assert.ok(ratio.watch < ratio.compact, `${name}: watch must precede compact`)
    assert.ok(ratio.compact < ratio.reactive, `${name}: compact must precede reactive`)
    assert.ok(ratio.reactive <= ratio.ceiling, `${name}: reactive must not exceed the ceiling`)
    assert.ok(ratio.ceiling <= 1)
  }
  assert.ok(POLICY_RATIOS['cache-preserving'].watch > POLICY_RATIOS.aggressive.watch)
})

test('strategyForCacheType maps a provider cache to a strategy', () => {
  assert.equal(strategyForCacheType('exact-prefix', true), 'cache-preserving')
  assert.equal(strategyForCacheType('exact-prefix', false), 'balanced')
  assert.equal(strategyForCacheType('none', false), 'aggressive')
  assert.equal(strategyForCacheType(undefined, false), 'balanced')
})

test('adaptiveRatios delays compression when the cache is working', () => {
  const base = POLICY_RATIOS.balanced
  const high = adaptiveRatios('balanced', 0.95)
  assert.ok(high.watch > base.watch, 'a healthy cache should raise the watch line')
  const low = adaptiveRatios('balanced', 0.2)
  assert.ok(low.watch < base.watch, 'a dead cache should lower the watch line')
  // Neutral hit rate leaves the profile untouched.
  assert.deepEqual(adaptiveRatios('balanced', 0.6), base)
  // Ratios stay ordered and bounded.
  assert.ok(high.watch < high.compact && high.compact < high.reactive)
  assert.ok(high.reactive <= 0.95)
  assert.ok(low.watch >= 0.4)
})

test('precisionCeilingRatio caps compression by window size', () => {
  assert.equal(precisionCeilingRatio(1_000_000), 0.7)
  assert.equal(precisionCeilingRatio(512_000), 0.7)
  assert.equal(precisionCeilingRatio(200_000), 0.55)
  assert.equal(precisionCeilingRatio(128_000), 1)
  assert.equal(precisionCeilingRatio(0), 1)
  // An explicit override always wins.
  assert.equal(precisionCeilingRatio(512_000, 0.5), 0.5)
})

test('computePressure is a bounded ratio', () => {
  assert.equal(computePressure(256_000, 512_000), 0.5)
  assert.equal(computePressure(600_000, 512_000), 1)
  assert.equal(computePressure(-5, 512_000), 0)
  assert.equal(computePressure(100, 0), 0)
})

test('tierForTokens walks the ladder', () => {
  const thresholds = thresholdsFor({ contextWindow: 512_000, strategy: 'cache-preserving', recentHitRate: 0.6 })
  assert.equal(tierForTokens(0, 512_000, 'cache-preserving', 0.6), 0)
  assert.equal(tierForTokens(thresholds.watch, 512_000, 'cache-preserving', 0.6), 1)
  assert.equal(tierForTokens(thresholds.compact, 512_000, 'cache-preserving', 0.6), 2)
  // 3 is the top tier: `reactive-tier` in decidePruneDelay treats >= 2 alike.
  assert.equal(tierForTokens(thresholds.reactive, 512_000, 'cache-preserving', 0.6), 3)
  assert.equal(tierForTokens(thresholds.ceiling, 512_000, 'cache-preserving', 0.6), 3)
  assert.equal(TIERS.length, 4)
})

/**
 * The gate is the piece being transplanted from Tianshu: compressing invalidates
 * the cached prefix, so its cost is proportional to how much cache was working,
 * while its benefit is proportional to window pressure.
 */
test('decidePruneDelay protects a hot cache', () => {
  const decision = decidePruneDelay({
    tier: 0,
    recentHitRate: 0.98,
    estimatedTokens: 200_000,
    contextWindow: 512_000,
    warmth: 'warm'
  })
  assert.equal(decision.delay, true)
  assert.equal(decision.reason, 'protection')
  // protection = hitRate * (1 - pressure)
  assert.ok(Math.abs(decision.protection - 0.98 * (1 - 200_000 / 512_000)) < 1e-9)
  assert.equal(decision.pressure, 200_000 / 512_000)
})

test('decidePruneDelay compresses eagerly when the cache is dead', () => {
  const decision = decidePruneDelay({
    tier: 0,
    recentHitRate: 0.04,
    estimatedTokens: 200_000,
    contextWindow: 512_000,
    warmth: 'warm'
  })
  assert.equal(decision.delay, false)
  assert.equal(decision.reason, 'allow')
})

test('decidePruneDelay never blocks a reactive tier', () => {
  // At tier >= 2 the window is genuinely full; delay would risk an overrun.
  const decision = decidePruneDelay({
    tier: 2,
    recentHitRate: 0.99,
    estimatedTokens: 500_000,
    contextWindow: 512_000,
    warmth: 'hot'
  })
  assert.equal(decision.delay, false)
  assert.equal(decision.reason, 'reactive-tier')
})

test('decidePruneDelay compresses a cold session for free', () => {
  // A cold session has no cache to lose, and its hit rate describes a burst that
  // has already aged out — waiting would protect a cache that is no longer there.
  const decision = decidePruneDelay({
    tier: 0,
    recentHitRate: 0.9,
    estimatedTokens: 100_000,
    contextWindow: 512_000,
    warmth: 'cold'
  })
  assert.equal(decision.delay, false)
  assert.equal(decision.reason, 'warmth-cold')
})

test('dedup gate: a cold session still cannot delay a reactive tier', () => {
  const decision = decidePruneDelay({
    tier: 3,
    recentHitRate: 0.99,
    estimatedTokens: 510_000,
    contextWindow: 512_000,
    warmth: 'cold'
  })
  assert.equal(decision.delay, false)
  assert.equal(decision.reason, 'reactive-tier')
})

test('decidePruneDelay honours a custom protection floor', () => {
  const base = { tier: 0, recentHitRate: 0.7, estimatedTokens: 200_000, contextWindow: 512_000, warmth: 'warm' }
  assert.equal(decidePruneDelay(base).delay, false)
  assert.equal(decidePruneDelay({ ...base, protectionFloor: 0.1 }).delay, true)
})

test('SessionWarmthTracker classifies gaps', () => {
  let now = 1_000_000
  const tracker = createWarmthTracker({ now: () => now })
  assert.equal(tracker.predict(), 'cold', 'nothing observed yet')

  tracker.recordCall()
  assert.equal(tracker.predict(), 'hot')
  now += WARMTH_HOT_MS + 1
  assert.equal(tracker.predict(), 'warm')
  now += WARMTH_TTL_MS
  assert.equal(tracker.predict(), 'cold')

  // Opportunistic compression is only free on a cold session.
  tracker.recordCall()
  assert.equal(tracker.shouldPruneOpportunistically(), false)
  now += WARMTH_TTL_MS + 1
  assert.equal(tracker.shouldPruneOpportunistically(), true)
})

test('pricingPhase splits peak and off-peak on Beijing time', () => {
  // 2026-10-19 is a Monday. 10:00 Beijing is inside the morning peak.
  const mondayPeak = Date.UTC(2026, 9, 19, 2, 0, 0) // 02:00Z = 10:00 +08
  assert.equal(pricingPhase(mondayPeak), 'peak')
  // 13:00 Beijing is the lunch gap → off-peak.
  const mondayLunch = Date.UTC(2026, 9, 19, 5, 0, 0)
  assert.equal(pricingPhase(mondayLunch), 'offpeak')
  // 23:00 Beijing → off-peak.
  const mondayNight = Date.UTC(2026, 9, 19, 15, 0, 0)
  assert.equal(pricingPhase(mondayNight), 'offpeak')
  // Sunday is off-peak all day.
  const sundayNoon = Date.UTC(2026, 9, 18, 4, 0, 0)
  assert.equal(pricingPhase(sundayNoon), 'offpeak')
})

test('nextPricingTransition lands on the next real boundary', () => {
  const mondayMorning = Date.UTC(2026, 9, 19, 2, 0, 0) // 10:00 Beijing, peak
  const next = nextPricingTransition(mondayMorning)
  assert.equal(next.to, 'offpeak')
  // The next boundary is 12:00 Beijing, two hours away.
  assert.equal(next.inMs, 2 * 60 * 60 * 1000)

  const mondayLunch = Date.UTC(2026, 9, 19, 5, 0, 0) // 13:00 Beijing, off-peak
  const after = nextPricingTransition(mondayLunch)
  assert.equal(after.to, 'peak')
  assert.equal(after.inMs, 60 * 60 * 1000)
})
