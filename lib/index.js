/**
 * dsh-context-diet — context diet for dsh sessions.
 *
 * Most "save tokens" plugins answer one question: *how do I make this tool
 * result smaller?* That is only half of it. Rewriting content the model has
 * already been billed for can cost more than it saves, because it invalidates
 * the prefix the provider was serving from cache. So this plugin has three
 * layers, and the interesting one is the gate between them:
 *
 *   L1  `tools/post-execute` — reshape a tool result *before* it is materialised
 *       into the session log. Runs once; never invalidates anything.
 *   L2  `agent/pre-step`     — slim *old* history in place. Costs a prefix
 *       rebuild, so it is gated by `protection = hitRate × (1 − pressure)`:
 *       rewrite history only when the cache it would destroy is not being used.
 *   L3  `ctx_audit` / `ctx_stats` / `ctx_restore` — make the result falsifiable.
 *
 * Every lossy reduction is reversible through a content-addressed store, and
 * the savings ledger books a *negative* when the model later re-reads bytes it
 * was told were saved. A plugin that cannot report a negative saving is not
 * measuring anything.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyReduction, FOLD_DEFAULTS, resolveLimits, routeText } from './fold.js'
import { createStore } from './ccr.js'
import { estimateListTokens, PRUNE_DEFAULTS, pruneHistory } from './prune.js'
import {
  cacheMonotonicity,
  cacheSignalQuality,
  DEFAULT_PRICES,
  dualHitRate,
  estimateCost,
  reconcile
} from './audit.js'
import {
  adaptiveRatios,
  createWarmthTracker,
  decidePruneDelay,
  nextPricingTransition,
  precisionCeilingRatio,
  pricingPhase,
  strategyForCacheType,
  tierForTokens
} from './policy.js'
import { installDevReload } from './dev-reload.js'

export const name = 'dsh-context-diet'

/** Services required before this plugin activates. */
export const inject = ['tools']

const OWN_TOOL_NAMES = new Set(['ctx_restore', 'ctx_audit', 'ctx_stats'])

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

function positiveInteger(value, fallback, field) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`dsh-context-diet: ${field} must be a positive safe integer, got ${String(resolved)}`)
  }
  return resolved
}

function stringArray(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`dsh-context-diet: ${field} must be an array of strings`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.trim() !== entry) {
      throw new Error(`dsh-context-diet: ${field}[${index}] must be a non-empty string with no surrounding whitespace`)
    }
    return entry
  })
}

const STRATEGIES = new Set(['auto', 'cache-preserving', 'balanced', 'aggressive'])
const CACHE_TYPES = new Set(['auto', 'exact-prefix', 'none', 'unknown'])
const DOCUMENT_DUMP_MODES = new Set(['fold', 'protect', 'off'])

function documentDumpMode(value) {
  const mode = value ?? FOLD_DEFAULTS.documentDumps
  if (!DOCUMENT_DUMP_MODES.has(mode)) {
    throw new Error(`dsh-context-diet: codeSkeleton.documentDumps must be one of ${[...DOCUMENT_DUMP_MODES].join(', ')}, got ${String(mode)}`)
  }
  return mode
}

function normalizeConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const markerStyle = source.markerStyle ?? 'full'
  if (markerStyle !== 'full' && markerStyle !== 'compact') {
    throw new Error(`dsh-context-diet: markerStyle must be "full" or "compact", got ${String(markerStyle)}`)
  }
  const history = source.history !== null && typeof source.history === 'object' ? source.history : {}
  const strategy = history.strategy ?? 'auto'
  if (!STRATEGIES.has(strategy)) {
    throw new Error(`dsh-context-diet: history.strategy must be one of ${[...STRATEGIES].join(', ')}, got ${String(strategy)}`)
  }
  const cacheType = history.cacheType ?? 'auto'
  if (!CACHE_TYPES.has(cacheType)) {
    throw new Error(`dsh-context-diet: history.cacheType must be one of ${[...CACHE_TYPES].join(', ')}, got ${String(cacheType)}`)
  }
  const code = source.codeSkeleton !== null && typeof source.codeSkeleton === 'object' ? source.codeSkeleton : {}
  const ccr = source.ccr !== null && typeof source.ccr === 'object' ? source.ccr : {}
  const audit = source.audit !== null && typeof source.audit === 'object' ? source.audit : {}
  const contextWindow = Number.isFinite(audit.contextWindow) && audit.contextWindow > 0
    ? Math.floor(audit.contextWindow)
    : 0

  return {
    enabled: source.enabled !== false,
    minChars: positiveInteger(source.minChars, FOLD_DEFAULTS.minChars, 'minChars'),
    minSavingRatio: Number.isFinite(source.minSavingRatio) ? source.minSavingRatio : FOLD_DEFAULTS.minSavingRatio,
    /**
     * A percentage floor is not enough on its own: 8% of a 1,000-char block is
     * 80 chars, which does not pay for the retrieval marker that makes the fold
     * reversible. This is the absolute floor that does, and it is a knob because
     * the right value is a property of the marker, not of the content.
     */
    minSavedChars: positiveInteger(source.minSavedChars, FOLD_DEFAULTS.minSavedChars, 'minSavedChars'),
    markerStyle,
    includeErrors: source.includeErrors === true,
    excludeTools: stringArray(source.excludeTools, 'excludeTools'),
    noFoldForTools: source.noFoldForTools === undefined
      ? [...FOLD_DEFAULTS.noFoldForTools]
      : stringArray(source.noFoldForTools, 'noFoldForTools'),
    noFoldForPatterns: source.noFoldForPatterns === undefined
      ? [...FOLD_DEFAULTS.noFoldForPatterns]
      : stringArray(source.noFoldForPatterns, 'noFoldForPatterns'),
    codeSkeleton: {
      enabled: code.enabled !== false,
      minLines: positiveInteger(code.minLines, FOLD_DEFAULTS.codeMinLines, 'codeSkeleton.minLines'),
      maxLines: positiveInteger(code.maxLines, FOLD_DEFAULTS.codeMaxLines, 'codeSkeleton.maxLines'),
      documentDumps: documentDumpMode(code.documentDumps)
    },
    ccr: {
      enabled: ccr.enabled !== false,
      persist: ccr.persist !== false,
      ttlMs: positiveInteger(ccr.ttlMs, 24 * 60 * 60 * 1000, 'ccr.ttlMs'),
      maxEntries: positiveInteger(ccr.maxEntries, 2000, 'ccr.maxEntries')
    },
    history: {
      enabled: history.enabled === true,
      strategy,
      cacheType,
      protectionFloor: Number.isFinite(history.protectionFloor) ? history.protectionFloor : 0.45,
      protectRecentMessages: positiveInteger(
        history.protectRecentMessages,
        PRUNE_DEFAULTS.protectRecentMessages,
        'history.protectRecentMessages'
      ),
      protectHeadMessages: positiveInteger(
        history.protectHeadMessages,
        PRUNE_DEFAULTS.protectHeadMessages,
        'history.protectHeadMessages'
      ),
      maxRewrites: positiveInteger(history.maxRewrites, 200, 'history.maxRewrites')
    },
    audit: {
      contextWindow: contextWindow > 0 ? contextWindow : 512_000,
      window: positiveInteger(audit.window, 40, 'audit.window'),
      prices: {
        inputPerM: Number.isFinite(audit.prices?.inputPerM) ? audit.prices.inputPerM : DEFAULT_PRICES.inputPerM,
        cachedInputPerM: Number.isFinite(audit.prices?.cachedInputPerM)
          ? audit.prices.cachedInputPerM
          : DEFAULT_PRICES.cachedInputPerM,
        outputPerM: Number.isFinite(audit.prices?.outputPerM) ? audit.prices.outputPerM : DEFAULT_PRICES.outputPerM
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Result plumbing
 * ------------------------------------------------------------------ */

function textBlocksOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block !== null && typeof block === 'object'
    && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
}

function originalTextOf(content) {
  return textBlocksOf(content).map((block) => block.text).join('\n\n')
}

function replaceTextBlocks(content, replacement) {
  if (!Array.isArray(content)) return content
  let used = false
  return content.map((block) => {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      if (used) return { ...block, text: '' }
      used = true
      return { ...block, text: replacement }
    }
    return block
  })
}

/**
 * Unwrap the deferred-tool bridge: a bridged invocation shows up as name
 * `tool_call` with the real target inside `arguments = { name, arguments }`.
 */
function effectiveNameOf(exec) {
  if (
    exec?.name === 'tool_call'
    && exec.arguments !== null && typeof exec.arguments === 'object'
    && typeof exec.arguments.name === 'string' && exec.arguments.name.length > 0
  ) {
    return exec.arguments.name
  }
  return exec?.name ?? ''
}

function effectiveArgumentsOf(exec) {
  if (
    exec?.name === 'tool_call'
    && exec.arguments !== null && typeof exec.arguments === 'object'
    && exec.arguments.arguments !== undefined
  ) {
    return exec.arguments.arguments
  }
  return exec?.arguments
}

const PATH_KEYS = new Set([
  'path', 'file_path', 'filePath', 'file', 'filename', 'old_path', 'new_path',
  'src', 'target', 'directory', 'dir', 'root', 'cwd', 'folder'
])

function firstPathOf(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return ''
  if (seen.has(value)) return ''
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstPathOf(item, seen)
      if (found !== '') return found
    }
    return ''
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'string' || child.length === 0) continue
    if (PATH_KEYS.has(key)) return child
  }
  for (const child of Object.values(value)) {
    const found = firstPathOf(child, seen)
    if (found !== '') return found
  }
  return ''
}

function globToRegExp(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}$`, 'i')
}

function matchesAny(value, patterns) {
  if (patterns.length === 0) return false
  const normalized = String(value).replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return patterns.some((pattern) => {
    const regex = globToRegExp(pattern)
    return regex.test(normalized) || (base.length > 0 && base !== normalized && regex.test(base))
  })
}

/* ------------------------------------------------------------------ *
 * L1 — post-execute reshaping
 * ------------------------------------------------------------------ */

function makePostExecuteListener(config, store, logger) {
  const limits = resolveLimits({
    minChars: config.minChars,
    minSavingRatio: config.minSavingRatio,
    minSavedChars: config.minSavedChars,
    codeMinLines: config.codeSkeleton.minLines,
    codeMaxLines: config.codeSkeleton.maxLines,
    documentDumps: config.codeSkeleton.documentDumps,
    noFoldForTools: config.noFoldForTools,
    noFoldForPatterns: config.noFoldForPatterns
  })

  return async function postExecuteListener(exec, result, next) {
    const decision = await next()
    if (!config.enabled || !config.ccr.enabled) return decision
    if (result?.isError === true && !config.includeErrors) return decision

    const toolName = effectiveNameOf(exec)
    const args = effectiveArgumentsOf(exec)
    if (OWN_TOOL_NAMES.has(toolName)) return decision
    if (config.excludeTools.length > 0 && matchesAny(toolName, config.excludeTools)) return decision
    if (limits.noFoldForTools.length > 0 && matchesAny(toolName, limits.noFoldForTools)) return decision
    const pathHint = firstPathOf(args)
    if (pathHint !== '' && limits.noFoldForPatterns.length > 0 && matchesAny(pathHint, limits.noFoldForPatterns)) {
      return decision
    }

    if (decision === null || typeof decision !== 'object') return decision
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision

    const sourceBlocks = decision.content ?? result?.content
    const textBlocks = textBlocksOf(sourceBlocks)
    if (textBlocks.length === 0) return decision
    const totalChars = textBlocks.reduce((total, block) => total + block.text.length, 0)
    if (totalChars < config.minChars) return decision

    const original = originalTextOf(sourceBlocks)

    try {
      const outcome = routeText(original, {
        toolName,
        limits,
        foldCode: config.codeSkeleton.enabled,
        pathHint: pathHint === '' ? undefined : pathHint
      })
      if (!outcome.changed) {
        // It flowed through unreduced. If these bytes are a reduction we already
        // claimed, the claim was wrong — book it.
        store.observePassthrough(original)
        return decision
      }
      const id = store.put({
        toolName,
        callId: String(exec?.callId ?? ''),
        sessionId: String(exec?.agent?.id ?? ''),
        reducer: outcome.reducer,
        originalText: original,
        compressedChars: outcome.compressedChars
      })
      const marked = applyReduction(outcome, id, config.markerStyle)
      return { ...decision, content: replaceTextBlocks(sourceBlocks, marked) }
    } catch (error) {
      logger.warn(`dsh-context-diet: reducing "${toolName}" output failed, leaving it unchanged: ${String(error)}`)
      return decision
    }
  }
}

/* ------------------------------------------------------------------ *
 * L3 tools
 * ------------------------------------------------------------------ */

function restoreTool(store) {
  return defineTool({
    name: 'ctx_restore',
    description:
      'Retrieve the original bytes of a tool result that dsh-context-diet reduced or slimmed. '
      + 'Use it only when you need exact content a `[diet: …]` marker replaced — a line range you '
      + 'must quote, an error you must reproduce, a value you must compare. The id is in the marker. '
      + 'Large originals are paged: pass start_line to continue where the previous page ended.',
    parameters: {
      id: { type: 'string', required: true, description: 'Retrieval id from a [diet: …] marker, e.g. diet:0123456789abcdef.' },
      start_line: { type: 'integer', description: '1-based first line to return. Defaults to 1.' },
      max_lines: { type: 'integer', description: 'Lines to return in this page. Defaults to 200, capped at 2000.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          found: { type: 'boolean', required: true },
          content: { type: 'string' },
          toolName: { type: 'string' },
          reducer: { type: 'string' },
          originalChars: { type: 'integer' },
          compressedChars: { type: 'integer' },
          totalLines: { type: 'integer' },
          startLine: { type: 'integer' },
          returnedLines: { type: 'integer' },
          more: { type: 'boolean' },
          restoreCount: { type: 'integer' }
        }
      },
      render: (_args, value) => {
        if (!value.found) {
          return [{ type: 'text', text: `ctx_restore: "${value.id}" was not found or has expired.` }]
        }
        const header = value.more
          ? `lines ${value.startLine}–${value.startLine + value.returnedLines - 1} of ${value.totalLines} (${value.toolName}, ${value.reducer}); call again with start_line=${value.startLine + value.returnedLines}`
          : `lines ${value.startLine}–${value.startLine + value.returnedLines - 1} of ${value.totalLines} (${value.toolName}, ${value.reducer})`
        return [{ type: 'text', text: `${header}\n\n${value.content}` }]
      }
    },
    execute: async (args) => {
      const requestedId = String(args.id ?? '')
      const entry = store.get(requestedId)
      // `get()` answers `null` for a miss, never `undefined`: testing for
      // `undefined` let a miss through to `entry.id` and the tool threw
      // "Cannot read properties of null (reading 'id')" instead of reporting
      // the miss it had already detected.
      if (entry === null || entry === undefined) {
        return { id: requestedId, found: false, totalLines: 0, startLine: 1, returnedLines: 0, more: false }
      }
      const restoreCount = store.noteRestore(entry.id)
      const lines = entry.originalText.split('\n')
      const totalLines = lines.length
      const requestedMax = Number.isSafeInteger(args.max_lines) && args.max_lines > 0 ? args.max_lines : 200
      const maxLines = Math.min(requestedMax, 2000)
      const startLine = Number.isSafeInteger(args.start_line) && args.start_line > 0
        ? Math.min(args.start_line, totalLines)
        : 1
      const page = lines.slice(startLine - 1, startLine - 1 + maxLines)
      return {
        id: entry.id,
        found: true,
        content: page.join('\n'),
        toolName: entry.toolName,
        reducer: entry.reducer,
        originalChars: entry.originalChars,
        compressedChars: entry.compressedChars,
        totalLines,
        startLine,
        returnedLines: page.length,
        more: startLine - 1 + page.length < totalLines,
        restoreCount
      }
    }
  })
}

function statsTool(store) {
  return defineTool({
    name: 'ctx_stats',
    description:
      'Report what dsh-context-diet has actually saved in this process, including the regret column: '
      + 'bytes it claimed to save and the model then re-read. netChars may be negative — that is the '
      + 'honest answer.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'integer', required: true },
          reductions: { type: 'integer', required: true },
          savedChars: { type: 'integer', required: true },
          regretChars: { type: 'integer', required: true },
          netChars: { type: 'integer', required: true },
          regretted: { type: 'integer', required: true },
          passthrough: { type: 'integer', required: true },
          storeChars: { type: 'integer', required: true },
          storePath: { type: 'string', required: true }
        }
      },
      render: (_args, value) => {
        const net = value.netChars >= 0 ? `+${value.netChars}` : String(value.netChars)
        return [{
          type: 'text',
          text: `dsh-context-diet: ${value.reductions} reductions across ${value.passthrough} tool results. `
            + `Claimed ${value.savedChars} chars saved; regret ${value.regretChars} chars `
            + `(${value.regretted} reduction(s) the model then re-read in full). `
            + `Net ${net} chars over ${value.entries} retrievable originals (${value.storeChars} chars stored).`
        }]
      }
    },
    execute: async () => {
      const stats = store.stats()
      return { ...stats, storePath: store.storePath }
    }
  })
}

/**
 * One line for the monotonicity verdict — and it has to name the cause.
 *
 * "systematic" alone is alarming and ambiguous. A prompt that got *smaller*
 * (history compression) shrinks the reusable prefix for free; a prompt that
 * stayed the same or grew and still lost its cache is the provider dropping the
 * prefix, and no setting here can fix that.
 *
 * Measured on a real 1,059-request session: 367 drops, 20 from compression
 * (332K tokens) and 347 genuine breaks (9.95M tokens). The old line reported
 * the sum and called all of it a fault.
 */
function monotonicityLine(value) {
  if (value.compressionDrops === 0 && value.prefixBreaks === 0) {
    return 'clean — cacheReadTokens never fell'
  }
  if (value.prefixBreaks === 0) {
    return `compression — ${value.compressionDrops} drop(s) explained by a smaller prompt `
      + `(${value.lostCachedTokens} tokens); no prefix was broken`
  }
  const compression = value.compressionDrops > 0
    ? ` (plus ${value.compressionDrops} drop(s) from history compression, not a fault)`
    : ''
  return `${value.monotonicity} — ${value.prefixBreaks} prefix break(s) lost ${value.lostPrefixTokens} cached tokens `
    + `while the prompt did not shrink${compression}`
}

function auditTool(config, store, usageRows, pluginStats) {
  return defineTool({
    name: 'ctx_audit',
    description:
      'Audit cache accounting for this session. Reports both hit-rate definitions side by side, '
      + 'whether the provider\'s cached_tokens is a real measurement or a filled-in constant, whether '
      + 'the cache ever went backwards (a mid-prefix rewrite), the cost split by peak/off-peak pricing, '
      + 'and what dsh-context-diet has saved. Pass the provider ledger numbers to reconcile them.',
    parameters: {
      window: { type: 'integer', description: 'How many recent requests to analyse. Defaults to config.audit.window.' },
      provider_uncached_input: { type: 'integer', description: 'Provider ledger uncached input tokens, if you have them.' },
      provider_cache_read: { type: 'integer', description: 'Provider ledger cache-read tokens, if you have them.' },
      provider_output: { type: 'integer', description: 'Provider ledger output tokens, if you have them.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requests: { type: 'integer', required: true },
          usageSource: { type: 'string', required: true },
          mainHitRate: { type: 'number', required: true },
          billedHitRate: { type: 'number', required: true },
          gapPoints: { type: 'number', required: true },
          cacheSignal: { type: 'string', required: true },
          cacheSignalReason: { type: 'string', required: true },
          monotonicity: { type: 'string', required: true },
          lostCachedTokens: { type: 'integer', required: true },
          lostPrefixTokens: { type: 'integer', required: true },
          prefixBreaks: { type: 'integer', required: true },
          compressionDrops: { type: 'integer', required: true },
          pricingPhase: { type: 'string', required: true },
          nextTransitionMs: { type: 'integer', required: true },
          costUsd: { type: 'number', required: true },
          peakCostUsd: { type: 'number', required: true },
          savedChars: { type: 'integer', required: true },
          netChars: { type: 'integer', required: true },
          reconcile: { type: 'string', required: true }
        }
      },
      render: (_args, value) => {
        const lines = [
          `Requests analysed: ${value.requests} (usage from ${value.usageSource})`,
          `Hit rate — main stream ${(value.mainHitRate * 100).toFixed(1)}%, whole wire ${(value.billedHitRate * 100).toFixed(1)}% (gap ${value.gapPoints.toFixed(1)} pts)`,
          `cached_tokens signal: ${value.cacheSignal} — ${value.cacheSignalReason}`,
          `Monotonicity: ${monotonicityLine(value)}`,
          `Pricing phase: ${value.pricingPhase} (next transition in ${Math.round(value.nextTransitionMs / 60000)} min)`,
          `Cost: $${value.costUsd.toFixed(4)} (peak share $${value.peakCostUsd.toFixed(4)})`,
          `dsh-context-diet saved ${value.savedChars} chars, net ${value.netChars > 0 ? '+' : ''}${value.netChars}`,
          `Ledgers: ${value.reconcile}`
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    execute: async (args) => {
      const window = Number.isSafeInteger(args.window) && args.window > 0
        ? Math.min(args.window, 2000)
        : config.audit.window
      const rows = usageRows.slice(-window)
      const dual = dualHitRate(rows)
      const signal = cacheSignalQuality(rows)
      const mono = cacheMonotonicity(rows)
      const cost = estimateCost(rows, config.audit.prices, { splitPhases: true })
      const stats = store.stats()
      // Where the usage rows came from is a *plugin* fact, not a store fact —
      // reading it off `store.stats()` always answered undefined.
      const usageSource = pluginStats?.usageSource ?? 'none'
      const nowMs = Date.now()
      const transition = nextPricingTransition(nowMs)

      const provider = Number.isFinite(args.provider_uncached_input) || Number.isFinite(args.provider_cache_read)
        ? {
            uncachedInputTokens: args.provider_uncached_input,
            cacheReadTokens: args.provider_cache_read,
            outputTokens: args.provider_output
          }
        : undefined
      const dshLedger = dual.billed.requests > 0
        ? {
            uncachedInputTokens: dual.billed.uncachedInputTokens,
            cacheReadTokens: dual.billed.cacheReadTokens,
            outputTokens: dual.billed.outputTokens
          }
        : undefined
      const reconciled = reconcile({ dsh: dshLedger, provider })
      const reconcileText = reconciled.ledgers.length >= 2
        ? reconciled.ledgers.map((entry) => `${entry.ledger} ${(entry.hitRate * 100).toFixed(1)}%`).join(' vs ')
          + ` — ${reconciled.reason}`
        : 'only the dsh ledger is available; pass provider_* arguments to reconcile'
      // Zero requests is not "a 0% hit rate" — it is "no samples", and saying
      // 0.0% would read as a measured disaster instead of an empty denominator.
      const usageText = dual.billed.requests > 0
        ? undefined
        : `no usage samples yet (source: ${usageSource}); `
          + 'they are read from the session log on the next step'

      return {
        requests: dual.billed.requests,
        usageSource,
        mainHitRate: dual.main.hitRate,
        billedHitRate: dual.billed.hitRate,
        gapPoints: Number.isFinite(dual.gapPoints) ? dual.gapPoints : 0,
        cacheSignal: signal.verdict,
        cacheSignalReason: signal.reason,
        monotonicity: mono.verdict,
        lostCachedTokens: mono.lostTokens,
        lostPrefixTokens: mono.lostPrefixTokens,
        prefixBreaks: mono.prefixBreaks.length,
        compressionDrops: mono.arithmeticDrops.length,
        pricingPhase: pricingPhase(nowMs),
        nextTransitionMs: transition.inMs,
        costUsd: cost.cost,
        peakCostUsd: cost.peak?.cost ?? 0,
        savedChars: stats.savedChars,
        netChars: stats.netChars,
        reconcile: usageText === undefined ? reconcileText : `${usageText} · ${reconcileText}`
      }
    }
  })
}

/* ------------------------------------------------------------------ *
 * L2 — history slimming
 * ------------------------------------------------------------------ */

function usageRowOf(message) {
  const usage = message?.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : undefined
  const cacheReadTokens = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : undefined
  if (inputTokens === undefined && cacheReadTokens === undefined) return undefined
  return {
    inputTokens: inputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0,
    main: true
  }
}

/**
 * Append a usage row, skipping an exact repeat of the previous one.
 *
 * A retried attempt re-settles the same step, so the same numbers can arrive
 * twice; counting both would double the denominator of every hit rate.
 */
function pushUsageRow(usageRows, row) {
  const last = usageRows[usageRows.length - 1]
  if (last !== undefined && last.inputTokens === row.inputTokens
    && last.cacheReadTokens === row.cacheReadTokens
    && last.outputTokens === row.outputTokens) {
    return false
  }
  usageRows.push(row)
  const cap = 4096
  if (usageRows.length > cap) usageRows.splice(0, usageRows.length - cap)
  return true
}

/**
 * Harvest usage samples from the session log.
 *
 * Measured, not assumed: in harness 0.2.1-rc.2 an assistant message does **not**
 * carry `usage`. The durable `assistant/message` event is
 * `{ turn, step, message, usage, stream }` — `usage` is a *sibling* of
 * `message`, and `message` is only `{ role, content, source, id }`. Scanning
 * `payload.messages` therefore found nothing at all: in a live session with 47
 * reductions booked, `ctx_audit` reported "Requests analysed: 0" and the
 * cache-aware gate behind L2 ran blind.
 *
 * `agent.session.snapshotEvents(from)` is the real source. It returns the
 * events appended since `from`, so the per-step cost is proportional to the new
 * events, not to session length. The cursor lives in a `WeakMap` keyed by the
 * session object so a finished session is collectable.
 *
 * @returns {boolean} true when the session log answered (even with zero rows),
 *   false when this agent exposes no readable session.
 */
function harvestUsageFromSession(agent, cursor, usageRows) {
  try {
    return harvestUsageFromSessionUnsafe(agent, cursor, usageRows)
  } catch {
    // A plugin must never break a step over its own bookkeeping.
    return false
  }
}

function harvestUsageFromSessionUnsafe(agent, cursor, usageRows) {
  const session = agent?.session
  if (session === null || typeof session !== 'object') return false
  if (typeof session.snapshotEvents !== 'function') return false
  const state = cursor.get(session) ?? { from: 0 }
  let events
  try {
    events = session.snapshotEvents(state.from)
  } catch {
    // A malformed offset or a session still being attached: fall back rather
    // than break the step.
    return false
  }
  if (!Array.isArray(events)) return false
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const row = usageRowOf(event.data)
    if (row !== undefined) pushUsageRow(usageRows, row)
  }
  // `seq` is the exclusive upper bound of the log, i.e. exactly the next `from`.
  const next = Number.isSafeInteger(session.seq) ? session.seq : state.from + events.length
  if (Number.isSafeInteger(next) && next >= state.from) cursor.set(session, { from: next })
  return true
}

function makePreStepListener(config, store, warmth, usageRows, stats) {
  const cursor = new WeakMap()
  return async function preStepListener(payload, next) {
    const decision = await next()

    // Record usage on every step, whether or not we prune: the audit needs it
    // and the protection gate needs it even when history slimming is off.
    const fromSession = harvestUsageFromSession(payload?.agent, cursor, usageRows)
    stats.usageSource = fromSession ? 'session-events' : 'message-scan'
    if (!fromSession && Array.isArray(payload?.messages)) {
      for (const message of payload.messages) {
        if (message?.role !== 'assistant') continue
        const row = usageRowOf(message)
        if (row !== undefined) pushUsageRow(usageRows, row)
      }
    }

    if (!config.enabled || !config.history.enabled) return decision
    if (decision === null || typeof decision !== 'object') return decision
    if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision

    warmth.recordCall()

    const contextWindow = config.audit.contextWindow
    const estimatedTokens = estimateListTokens(decision.messages)
    const recent = usageRows.slice(-config.audit.window)
    const dual = dualHitRate(recent)
    const recentHitRate = dual.billed.requests >= 3 ? dual.billed.hitRate : undefined
    const signal = cacheSignalQuality(recent)
    // A provider whose cached_tokens never moves is not caching; treat it as
    // cacheType none so the aggressive profile applies and we prune freely.
    const cacheType = config.history.cacheType === 'auto'
      ? (signal.verdict === 'template' ? 'none' : signal.verdict === 'live' ? 'exact-prefix' : 'unknown')
      : config.history.cacheType
    const strategy = config.history.strategy === 'auto'
      ? strategyForCacheType(cacheType, cacheType === 'exact-prefix')
      : config.history.strategy

    const tier = tierForTokens(estimatedTokens, contextWindow, strategy, recentHitRate)
    const gate = decidePruneDelay({
      tier,
      recentHitRate,
      estimatedTokens,
      contextWindow,
      warmth: warmth.predict(),
      protectionFloor: config.history.protectionFloor
    })
    stats.lastGate = { ...gate, tier, strategy, cacheType, estimatedTokens, contextWindow }
    if (gate.delay) return decision

    const pruned = pruneHistory(decision.messages, {
      protectRecentMessages: config.history.protectRecentMessages,
      protectHeadMessages: config.history.protectHeadMessages,
      maxRewrites: config.history.maxRewrites,
      onStore: (payloadIn) => store.put({
        ...payloadIn,
        sessionId: String(payload?.agent?.id ?? '')
      })
    })
    if (!pruned.changed) return decision

    stats.rewrites += pruned.rewrites.length
    const savedChars = pruned.rewrites.reduce((total, rewrite) => total + (rewrite.beforeChars - rewrite.afterChars), 0)
    stats.rewriteChars += savedChars
    // Keep `startsRequestSeries` and every other flag the harness set.
    return { ...decision, messages: pruned.messages }
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Build one live instance of the plugin: its listeners and its tools.
 *
 * Split out of `apply` so a development reload can dispose this instance and
 * build the next one without touching the host's fiber (see `./dev-reload.js`).
 *
 * Listener registration is deliberately NOT here: `apply` registers two
 * delegating listeners once, and they call into whatever instance is current.
 * Re-registering per reload would depend on `ctx.on`'s return value being a
 * disposer, and a host that returned something else would silently stack a
 * second listener on every save — each one folding results twice.
 *
 * Every tool registered here must be released by `dispose()`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 * @returns {Promise<{
 *   config: object,
 *   logger: object,
 *   postExecute: (exec: object, result: object, next: () => Promise<object>) => Promise<object>,
 *   preStep: (payload: object, next: () => Promise<object>) => Promise<object>,
 *   dispose: () => void
 * }>}
 */
export async function startPlugin(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console
  const store = createStore({ ...config.ccr, logger })
  await store.init()

  const warmth = createWarmthTracker()
  /** @type {Array<{ inputTokens: number, cacheReadTokens: number, outputTokens: number, main: boolean }>} */
  const usageRows = []
  const stats = { rewrites: 0, rewriteChars: 0, lastGate: undefined, usageSource: 'none' }

  const disposers = []
  try {
    disposers.push(ctx.tools.register(restoreTool(store)))
    disposers.push(ctx.tools.register(statsTool(store)))
    disposers.push(ctx.tools.register(auditTool(config, store, usageRows, stats)))

    const ratios = adaptiveRatios('balanced')
    const ceiling = precisionCeilingRatio(config.audit.contextWindow)
    logger.warn(
      `dsh-context-diet: active — L1 reshape above ${config.minChars} chars, `
      + `code skeletons ${config.codeSkeleton.enabled ? 'on' : 'off'}, `
      + `document dumps ${config.codeSkeleton.documentDumps}, `
      + `history slimming ${config.history.enabled ? `on (${config.history.strategy})` : 'off'}, `
      + `window ${config.audit.contextWindow} tok, precision ceiling ${(ceiling * 100).toFixed(0)}% `
      + `(≈${Math.round(config.audit.contextWindow * ceiling / 1000)}K), watch/compact at `
      + `${Math.round(ratios.watch * 100)}%/${Math.round(ratios.compact * 100)}% of it`
    )
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* noop */ }
    }
    // The store may have opened a file or armed a flush timer; a half-built
    // instance must not keep either.
    try { store.dispose() } catch { /* noop */ }
    throw error
  }

  return {
    config,
    logger,
    postExecute: makePostExecuteListener(config, store, logger),
    preStep: makePreStepListener(config, store, warmth, usageRows, stats),
    dispose() {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* noop */ }
      }
      store.dispose()
    }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export async function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger ?? console
  // The fiber keeps owning "whatever is current", so a development reload can
  // swap the instance underneath it and the host's shutdown path stays correct.
  const holder = { current: null, reloader: null }
  holder.current = await startPlugin(ctx, rawConfig)

  // Registered ONCE. `next()` must always be called: an instance that failed to
  // build leaves `current` null, and swallowing the chain there would hang the
  // tool call rather than simply not folding it.
  ctx.on('tools/post-execute', (exec, result, next) => {
    const instance = holder.current
    if (instance === null || instance === undefined) return next()
    return instance.postExecute(exec, result, next)
  })
  ctx.on('agent/pre-step', (payload, next) => {
    const instance = holder.current
    if (instance === null || instance === undefined) return next()
    return instance.preStep(payload, next)
  })

  ctx.effect(() => () => {
    try { holder.reloader?.dispose?.() } catch { /* noop */ }
    holder.reloader = null
    try { holder.current?.dispose?.() } catch { /* noop */ }
    holder.current = null
  }, 'dsh-context-diet: result reshaping, history slimming, and cache audit')

  holder.reloader = installDevReload({ ctx, rawConfig, holder, logger })
}

export { createStore } from './ccr.js'
export { estimateTokens } from './core.js'
export { foldCode } from './codefold.js'
export { routeText, applyReduction } from './fold.js'
export { pruneHistory, classifyHistory } from './prune.js'
export {
  cacheMonotonicity,
  cacheSignalQuality,
  computeHitRate,
  detectFixedFill,
  dualHitRate,
  estimateCost,
  reconcile
} from './audit.js'
export {
  adaptiveRatios,
  computePressure,
  createWarmthTracker,
  decidePruneDelay,
  precisionCeilingRatio,
  pricingPhase,
  strategyForCacheType,
  thresholdsFor,
  tierForTokens
} from './policy.js'
