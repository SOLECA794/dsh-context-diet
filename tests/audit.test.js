import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_PRICES,
  cacheMonotonicity,
  cacheSignalQuality,
  computeHitRate,
  detectFixedFill,
  dualHitRate,
  estimateCost,
  reconcile
} from '../lib/audit.js'

test('computeHitRate weights by tokens, not by request count', () => {
  const rows = [
    { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
    { inputTokens: 900, cacheReadTokens: 100, outputTokens: 10 }
  ]
  const result = computeHitRate(rows)
  assert.equal(result.requests, 2)
  assert.equal(result.uncachedInputTokens, 1000)
  assert.equal(result.cacheReadTokens, 1000)
  // 1000 / 2000 — an average of per-request rates would also give 0.5 here,
  // so the next case is the one that actually proves token weighting.
  assert.equal(result.hitRate, 0.5)
})

test('computeHitRate is token-weighted, not request-weighted', () => {
  const rows = [
    { inputTokens: 10, cacheReadTokens: 90 }, // 90% hit on a tiny request
    { inputTokens: 990, cacheReadTokens: 10 } // 1% hit on a huge request
  ]
  const result = computeHitRate(rows)
  // Request-average would be ~45.5%; token-weighted is 100/1100 = 9.09%.
  assert.ok(Math.abs(result.hitRate - 100 / 1100) < 1e-9, `got ${result.hitRate}`)
})

test('computeHitRate handles empty input', () => {
  const result = computeHitRate([])
  assert.equal(result.hitRate, 0)
  assert.equal(result.requests, 0)
  assert.equal(computeHitRate(null).hitRate, 0)
})

test('dualHitRate reports the gap between main and billed streams', () => {
  const rows = [
    { inputTokens: 100, cacheReadTokens: 900, main: true },
    { inputTokens: 900, cacheReadTokens: 100, main: true },
    // Side traffic that never hits: a compression summary request.
    { inputTokens: 1000, cacheReadTokens: 0, main: false }
  ]
  const result = dualHitRate(rows)
  // Billed: 1000 cached of 3000 total input tokens.
  assert.ok(Math.abs(result.billed.hitRate - 1 / 3) < 1e-9, `got ${result.billed.hitRate}`)
  assert.equal(result.main.hitRate, 0.5)
  assert.ok(Math.abs(result.gapPoints - (0.5 - 1 / 3) * 100) < 1e-9)
  assert.equal(result.mainUnflagged, false)
})

test('dualHitRate flags an unmarked stream', () => {
  const result = dualHitRate([{ inputTokens: 10, cacheReadTokens: 90 }])
  assert.equal(result.mainUnflagged, true)
  assert.equal(result.main.requests, 0)
})

test('cacheSignalQuality calls a constant cached_tokens a template', () => {
  // The real relay behaviour: 4332 for every request regardless of prompt size.
  const rows = Array.from({ length: 12 }, () => ({ inputTokens: 100000, cacheReadTokens: 4332 }))
  const result = cacheSignalQuality(rows)
  assert.equal(result.verdict, 'template')
  assert.equal(result.samples, 12)
  assert.match(result.reason, /filled in, not measured/)
})

test('cacheSignalQuality accepts a two-value relay as a template', () => {
  // Observed in practice: 1110 below ~100K prompt, 4332 above.
  const rows = [
    ...Array.from({ length: 6 }, () => ({ cacheReadTokens: 1110 })),
    ...Array.from({ length: 6 }, () => ({ cacheReadTokens: 4332 }))
  ]
  const result = cacheSignalQuality(rows)
  assert.equal(result.verdict, 'template')
})

test('cacheSignalQuality recognises a live cache', () => {
  const rows = [
    { cacheReadTokens: 1000 },
    { cacheReadTokens: 5000 },
    { cacheReadTokens: 12000 },
    { cacheReadTokens: 30000 },
    { cacheReadTokens: 61000 },
    { cacheReadTokens: 62000 },
    { cacheReadTokens: 90000 },
    { cacheReadTokens: 91000 },
    { cacheReadTokens: 120000 }
  ]
  const result = cacheSignalQuality(rows)
  assert.equal(result.verdict, 'live')
})

test('cacheSignalQuality refuses to judge too few samples', () => {
  const result = cacheSignalQuality([{ cacheReadTokens: 4332 }, { cacheReadTokens: 4332 }])
  assert.equal(result.verdict, 'unknown')
})

test('cacheMonotonicity finds the mid-history prefix break', () => {
  const rows = [
    { cacheReadTokens: 1000 },
    { cacheReadTokens: 5000 },
    { cacheReadTokens: 30000 },
    { cacheReadTokens: 4332 }, // prefix broke
    { cacheReadTokens: 4332 },
    { cacheReadTokens: 9000 }
  ]
  const result = cacheMonotonicity(rows)
  assert.equal(result.monotonic, false)
  assert.equal(result.drops.length, 1)
  assert.equal(result.drops[0].lostTokens, 30000 - 4332)
  assert.equal(result.verdict, 'occasional')
})

test('cacheMonotonicity calls many drops systematic', () => {
  const rows = [50000, 4332, 40000, 4332, 30000, 4332, 20000, 4332].map((value) => ({ cacheReadTokens: value }))
  const result = cacheMonotonicity(rows)
  assert.equal(result.verdict, 'systematic')
  assert.ok(result.drops.length >= 3)
})

// A prompt that got smaller cannot keep the same cache: history compression
// removes tokens, so the reusable prefix shrinks with them. Counting that as a
// loss blames the cache for arithmetic. Measured on a real session, 20 of 367
// drops were this shape (332K tokens) and 347 were genuine breaks (9.95M).
test('cacheMonotonicity separates a compressed history from a broken prefix', () => {
  const rows = [
    { inputTokens: 5000, cacheReadTokens: 95000 }, // prompt 100000
    { inputTokens: 4000, cacheReadTokens: 36000 }, // prompt  40000, cache fell to fit
    { inputTokens: 4000, cacheReadTokens: 40000 }, // prompt  44000
    { inputTokens: 4000, cacheReadTokens: 43000 } // prompt  47000
  ]
  const result = cacheMonotonicity(rows)
  assert.equal(result.drops.length, 1)
  assert.equal(result.drops[0].arithmetic, true, 'the prompt shrank by more than the cache did')
  assert.equal(result.prefixBreaks.length, 0)
  assert.equal(result.verdict, 'compression')
  assert.equal(result.lostTokens, 59000)
  assert.equal(result.lostPrefixTokens, 0)
})

test('cacheMonotonicity still blames a drop the prompt did not pay for', () => {
  const rows = [
    { inputTokens: 5000, cacheReadTokens: 95000 },
    // Prompt GREW by 1000 and the cache still fell by 50000: nothing about the
    // history explains this, so it is the provider dropping the prefix.
    { inputTokens: 51000, cacheReadTokens: 45000 }
  ]
  const result = cacheMonotonicity(rows)
  assert.equal(result.drops.length, 1)
  assert.equal(result.drops[0].arithmetic, false)
  assert.equal(result.prefixBreaks.length, 1)
  assert.equal(result.verdict, 'occasional')
  assert.equal(result.lostPrefixTokens, 50000)
})

test('cacheMonotonicity does not excuse a drop just because the prompt shrank a little', () => {
  const rows = [
    { inputTokens: 5000, cacheReadTokens: 95000 },
    // Prompt fell by only 100 but the cache fell by 50000 — the shrink cannot
    // pay for the loss, so it is still a broken prefix.
    { inputTokens: 54900, cacheReadTokens: 45000 }
  ]
  const result = cacheMonotonicity(rows)
  assert.equal(result.drops[0].arithmetic, false)
  assert.equal(result.verdict, 'occasional')
})

test('cacheMonotonicity stays strict when the row does not report inputTokens', () => {
  // Silence is not evidence of innocence: without the prompt size we cannot
  // prove the drop was arithmetic, so it stays a candidate break.
  const rows = [{ cacheReadTokens: 50000 }, { cacheReadTokens: 4332 }]
  const result = cacheMonotonicity(rows)
  assert.equal(result.drops[0].arithmetic, false)
  assert.equal(result.drops[0].promptDelta, undefined)
  assert.equal(result.verdict, 'occasional')
})

test('cacheMonotonicity passes a healthy append-only stream', () => {
  const rows = [1000, 2000, 5000, 5000, 9000, 20000].map((value) => ({ cacheReadTokens: value }))
  const result = cacheMonotonicity(rows)
  assert.equal(result.monotonic, true)
  assert.equal(result.verdict, 'clean')
  assert.equal(result.lostTokens, 0)
})

test('detectFixedFill finds the relay constant', () => {
  // The measured behaviour: reported prompt_tokens = real + 17064, flat across
  // four wildly different prompt sizes.
  const samples = [
    { sentTokens: 1875, promptTokens: 1875 + 17064 },
    { sentTokens: 7500, promptTokens: 7500 + 17064 },
    { sentTokens: 15000, promptTokens: 15000 + 17064 },
    { sentTokens: 30000, promptTokens: 30000 + 17064 }
  ]
  const result = detectFixedFill(samples)
  assert.equal(result.detected, true)
  assert.equal(result.offset, 17064)
  assert.ok(result.spread <= 64, `spread ${result.spread} should be flat`)
  assert.match(result.reason, /fixed charge/)
})

test('detectFixedFill falls back to characters when tokens are absent', () => {
  const samples = [
    { sentChars: 8000, promptTokens: 2000 + 17064 },
    { sentChars: 32000, promptTokens: 8000 + 17064 },
    { sentChars: 128000, promptTokens: 32000 + 17064 }
  ]
  const result = detectFixedFill(samples)
  assert.equal(result.detected, true)
  assert.equal(result.offset, 17064)
})

test('detectFixedFill accepts normal tokenisation drift', () => {
  const samples = [
    { sentChars: 8250, promptTokens: 1875 },
    { sentChars: 33000, promptTokens: 7500 + 900 },
    { sentChars: 66000, promptTokens: 15000 - 400 },
    { sentChars: 132000, promptTokens: 30000 + 2200 }
  ]
  const result = detectFixedFill(samples)
  assert.equal(result.detected, false)
  assert.match(result.reason, /normal tokenisation/)
})

test('detectFixedFill needs at least three samples', () => {
  const result = detectFixedFill([{ sentChars: 100, promptTokens: 100 }])
  assert.equal(result.detected, false)
  assert.equal(result.samples, 1)
  assert.match(result.reason, /at least 3 samples/)
})

test('estimateCost matches the provider ledger formula', () => {
  // These are the real totals from the relay's /v1/usage response; the formula
  // reproduced its `cost` field to the cent, so this is a real regression guard.
  const rows = [{ inputTokens: 56_957_016, cacheReadTokens: 112_558_943, outputTokens: 1_500_110 }]
  const result = estimateCost(rows)
  assert.ok(Math.abs(result.cost - 65.2086) < 0.01, `got ${result.cost}`)
})

test('estimateCost splits peak and offpeak by row timestamp', () => {
  // 2026-10-19 is a Monday. 02:00Z = 10:00 Beijing (peak); 08:00Z = 16:00 Beijing (peak);
  // 20:00Z = 04:00 Beijing next day (offpeak).
  const peakA = Date.UTC(2026, 9, 19, 2, 0, 0)
  const peakB = Date.UTC(2026, 9, 19, 8, 0, 0)
  const offpeak = Date.UTC(2026, 9, 19, 20, 0, 0)
  const rows = [
    { at: peakA, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
    { at: peakB, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
    { at: offpeak, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }
  ]
  const result = estimateCost(rows, DEFAULT_PRICES, { splitPhases: true })
  assert.equal(result.peak.uncachedInputTokens, 2_000_000)
  assert.equal(result.offpeak.uncachedInputTokens, 1_000_000)
  assert.ok(Math.abs(result.peak.cost - 2) < 1e-9)
  assert.ok(Math.abs(result.offpeak.cost - 1) < 1e-9)
})

test('reconcile names the provider ledger as authoritative on disagreement', () => {
  // The real situation: DSH said 10.77%, bili said 57.7%, the relay said 65%.
  const result = reconcile({
    dsh: { uncachedInputTokens: 75_238_319, cacheReadTokens: 16_041_268, outputTokens: 433_263 },
    bili: { uncachedInputTokens: 5_140_000, cacheReadTokens: 7_010_000, outputTokens: 252_000 },
    provider: { uncachedInputTokens: 56_957_016, cacheReadTokens: 112_558_943, outputTokens: 1_500_110 }
  })
  assert.equal(result.ledgers.length, 3)
  assert.equal(result.authoritative, 'provider')
  assert.equal(result.consistent, false)
  assert.ok(result.spreadPoints > 20, `spread ${result.spreadPoints} should be large`)
  assert.match(result.reason, /bill against the provider ledger/)
})

test('reconcile accepts ledgers that agree', () => {
  const result = reconcile({
    dsh: { uncachedInputTokens: 100, cacheReadTokens: 900 },
    provider: { uncachedInputTokens: 105, cacheReadTokens: 895 }
  })
  assert.equal(result.consistent, true)
  assert.match(result.reason, /within measurement noise/)
})

test('reconcile refuses a single ledger', () => {
  const result = reconcile({ dsh: { uncachedInputTokens: 1, cacheReadTokens: 1 } })
  assert.equal(result.consistent, false)
  assert.equal(result.ledgers.length, 1)
})

test('DEFAULT_PRICES mirror the DeepSeek list prices', () => {
  assert.equal(DEFAULT_PRICES.inputPerM, 1)
  assert.equal(DEFAULT_PRICES.cachedInputPerM, 0.02)
  assert.equal(DEFAULT_PRICES.outputPerM, 4)
  assert.ok(Object.isFrozen(DEFAULT_PRICES))
})
