/**
 * dsh-context-diet — L2: in-place history slimming.
 *
 * The single rule this file exists to obey, lifted verbatim from Tianshu's
 * `src/compact/semantic-prune.ts`:
 *
 *   "All pruning replaces message CONTENT in place — never splices messages
 *    out. Splicing shifts all subsequent message indices, busting the
 *    exact-prefix cache."
 *
 * Everything else follows from that. We never delete a message, never reorder,
 * never touch an assistant message's reasoning or tool-call blocks (the wire
 * needs those intact), and never touch the last few messages. Only the `text`
 * payload of an old tool result is replaced, and every replacement names the id
 * that can restore the original bytes.
 *
 * Classification is Tianshu's AgentDiet (`src/compact/agent-diet.ts`):
 *
 *   - `redundant` — the same file was read again later, and the later read
 *     fully covers this one. The model has already seen these lines.
 *   - `expired`   — the file was edited or rewritten after this read. The
 *     content on screen no longer exists on disk.
 *   - `useless`   — a failed call whose retry two steps later succeeded. The
 *     error text has served its purpose.
 */

import { estimateTokens } from './core.js'

export const PRUNE_DEFAULTS = Object.freeze({
  /** Never touch the newest N messages. */
  protectRecentMessages: 6,
  /** Never touch the first N messages (task statement / initial context). */
  protectHeadMessages: 2,
  /** Tool calls that consume a path, with the argument that names it. */
  pathArgs: Object.freeze({
    read: ['file_path', 'path'],
    write: ['file_path', 'path'],
    edit: ['file_path', 'path'],
    str_replace_editor: ['path'],
    apply_patch: [],
    diet_restore: []
  }),
  /** Tool calls whose results are search/list output (safe to truncate). */
  searchTools: Object.freeze(['grep', 'glob', 'search', 'list_dir', 'list_files']),
  /** Tools that mutate a file (marking earlier reads expired). */
  mutateTools: Object.freeze(['write', 'edit', 'str_replace_editor', 'apply_patch']),
  /** Directory listings that are pure noise. */
  junkPatterns: Object.freeze([
    'node_modules',
    '__pycache__',
    '\\.git/',
    '/\\.venv/',
    '/dist/',
    '/build/',
    '/target/debug/',
    '/target/release/',
    '\\.o$',
    '\\.a$',
    '\\.d$'
  ]),
  /** Minimum lines before a junk listing / passing-test block is collapsed. */
  minJunkLines: 3,
  minPassLines: 5,
  /** Duplicate search results: keep only the newest N per query key. */
  duplicateSearchKeep: 1
})

const REDUNDANT = '[diet:redundant] re-read later in this session; exact lines available via ctx_restore'
const EXPIRED = '[diet:expired] file edited or rewritten later in this session; this snapshot is stale'
const USELESS = '[diet:useless] retried successfully two steps later; the failure text served its purpose'

function textOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

function withText(message, text) {
  const content = Array.isArray(message.content) ? message.content : []
  const next = content.filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
  if (next.length === 0) {
    return { ...message, content: [{ type: 'text', text }] }
  }
  const [first, ...rest] = next
  return {
    ...message,
    content: [
      { ...first, text },
      ...rest.map((block) => ({ ...block, text: '' }))
    ]
  }
}

function parseArgs(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Collect every tool call in order, remembering which message and result they belong to. */
function indexCalls(messages, defaults) {
  const calls = []
  /** callId → index into calls */
  const byId = new Map()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
        const record = {
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          args: parseArgs(block.arguments),
          messageIndex: index,
          resultIndex: -1,
          resultText: ''
        }
        calls.push(record)
        if (record.id !== '') byId.set(record.id, calls.length - 1)
      }
      continue
    }
    if (message.role === 'tool' && typeof message.toolCallId === 'string') {
      const slot = byId.get(message.toolCallId)
      if (slot === undefined) continue
      calls[slot].resultIndex = index
      calls[slot].resultText = textOf(message)
    }
  }
  return { calls, defaults }
}

function pathOf(call, defaults) {
  const keys = defaults.pathArgs[call.name]
  if (!Array.isArray(keys)) return ''
  for (const key of keys) {
    const value = call.args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function splitLines(text) {
  return text.split('\n')
}

/** Compare the line range a read covered, so "covers" beats a plain string compare. */
function readRange(call) {
  const offset = Number.isFinite(call.args.offset) ? call.args.offset : undefined
  const limit = Number.isFinite(call.args.limit) ? call.args.limit : undefined
  if (offset === undefined && limit === undefined) return undefined
  const start = offset ?? 1
  return { start, end: limit === undefined ? Infinity : start + limit - 1 }
}

function covers(outer, inner) {
  if (outer === undefined || inner === undefined) return outer === undefined && inner === undefined
  return outer.start <= inner.start && outer.end >= inner.end
}

/**
 * Classify prunable tool results.
 *
 * @returns {Array<{ index: number, call: any, reason: string }>}
 */
export function classifyHistory(messages, options = {}) {
  const defaults = { ...PRUNE_DEFAULTS, ...options }
  const { calls } = indexCalls(messages, defaults)
  const verdicts = []

  /** path → every read call on it, in order */
  const readsByPath = new Map()
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]
    if (call.name !== 'read' || call.resultIndex < 0) continue
    const path = pathOf(call, defaults)
    if (path === '') continue
    const list = readsByPath.get(path) ?? []
    list.push(i)
    readsByPath.set(path, list)
  }

  /** path → index of the first mutating call on it */
  const firstMutation = new Map()
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]
    if (!defaults.mutateTools.includes(call.name)) continue
    const path = pathOf(call, defaults)
    if (path === '' || firstMutation.has(path)) continue
    firstMutation.set(path, i)
  }

  const protectedIndex = messages.length - defaults.protectRecentMessages
  const isProtected = (resultIndex) =>
    resultIndex < defaults.protectHeadMessages || resultIndex >= protectedIndex

  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]
    if (call.resultIndex < 0 || call.resultText === '') continue
    if (isProtected(call.resultIndex)) continue

    // redundant: a later read of the same path covers this one
    if (call.name === 'read') {
      const path = pathOf(call, defaults)
      const list = readsByPath.get(path) ?? []
      const position = list.indexOf(i)
      if (position >= 0) {
        const mine = readRange(call)
        for (let k = position + 1; k < list.length; k += 1) {
          const later = calls[list[k]]
          if (later.resultIndex < 0) continue
          if (covers(readRange(later), mine)) {
            verdicts.push({ index: call.resultIndex, call, reason: 'redundant' })
            break
          }
        }
      }
      if (verdicts.some((v) => v.call === call)) continue
    }

    // expired: the file was changed after this read
    const path = pathOf(call, defaults)
    if (path !== '') {
      const mutatedAt = firstMutation.get(path)
      if (mutatedAt !== undefined && mutatedAt > i) {
        verdicts.push({ index: call.resultIndex, call, reason: 'expired' })
        continue
      }
    }

    // useless: this failed and the retry two steps later worked
    if (call.name === 'pwsh' || call.name === 'bash' || call.name === 'read') {
      const looksFailed = /^(Error|error:|Command failed|Exit code|exit code [1-9])/m.test(call.resultText.slice(0, 400))
        || /Process exited with code [1-9]/.test(call.resultText.slice(0, 400))
      if (!looksFailed) continue
      for (let k = i + 1; k < Math.min(i + 3, calls.length); k += 1) {
        const retry = calls[k]
        if (retry.name !== call.name || retry.resultIndex < 0) continue
        const sameTarget = pathOf(retry, defaults) === path && retry.args.command === call.args.command
        if (!sameTarget) continue
        const retryFailed = /^(Error|error:|Command failed|Exit code|exit code [1-9])/m.test(retry.resultText.slice(0, 400))
        if (!retryFailed) {
          verdicts.push({ index: call.resultIndex, call, reason: 'useless' })
        }
        break
      }
    }
  }

  return verdicts
}

/* ------------------------------------------------------------------ *
 * Semantic pruning (Tianshu `semantic-prune.ts` three rules)
 * ------------------------------------------------------------------ */

function collapseJunkListing(text, defaults) {
  const junkRe = new RegExp(defaults.junkPatterns.join('|'))
  const lines = splitLines(text)
  const keep = []
  let dropped = 0
  for (const line of lines) {
    if (junkRe.test(line)) {
      dropped += 1
      continue
    }
    keep.push(line)
  }
  if (dropped < defaults.minJunkLines) return undefined
  return {
    text: `${keep.join('\n')}\n[diet:semantic-prune] ${dropped} generated/dependency lines removed — not source, never edit these`,
    dropped
  }
}

function collapsePassingTests(text, defaults) {
  const lines = splitLines(text)
  const passRe = /^\s*(ok\s|PASS|passing|✓|test result: ok|\[  PASSED  \])/
  const keep = []
  let dropped = 0
  for (const line of lines) {
    if (passRe.test(line) && !/FAIL|error|panic/i.test(line)) {
      dropped += 1
      continue
    }
    keep.push(line)
  }
  if (dropped < defaults.minPassLines) return undefined
  return {
    text: `${keep.join('\n')}\n[diet:semantic-prune] ${dropped} passing-test lines removed — failures and the summary line are kept`,
    dropped
  }
}

/** Stable key for "the same query asked twice". */
function searchKey(call) {
  const args = call.args
  const parts = []
  for (const key of ['pattern', 'query', 'glob', 'path', 'include', 'file_path']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) parts.push(`${key}=${value}`)
  }
  return parts.length === 0 ? '' : `${call.name}(${parts.join(',')})`
}

function collapseDuplicateSearches(messages, calls, defaults) {
  const byKey = new Map()
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]
    if (call.resultIndex < 0) continue
    if (!defaults.searchTools.includes(call.name)) continue
    const key = searchKey(call)
    if (key === '') continue
    const list = byKey.get(key) ?? []
    list.push(i)
    byKey.set(key, list)
  }
  const stale = []
  for (const [key, list] of byKey) {
    if (list.length <= defaults.duplicateSearchKeep) continue
    for (let k = 0; k < list.length - defaults.duplicateSearchKeep; k += 1) {
      const call = calls[list[k]]
      stale.push({
        index: call.resultIndex,
        replacement: `[diet:semantic-prune] superseded: the same query ${key} was run again later; the newest result is authoritative`
      })
    }
  }
  return stale
}

/**
 * Produce a pruned copy of the message array.
 *
 * @param {any[]} messages
 * @param {{ enabled?: boolean, protectRecentMessages?: number, protectHeadMessages?: number,
 *           maxRewrites?: number, onStore?: (payload: { toolName: string, callId: string,
 *           reducer: string, originalText: string, compressedChars: number }) => string,
 *           now?: () => number }} [options]
 * @returns {{ changed: boolean, messages: any[], rewrites: Array<{ index: number, toolName: string,
 *              reason: string, beforeChars: number, afterChars: number, id?: string }> }}
 */
export function pruneHistory(messages, options = {}) {
  if (options.enabled === false) return { changed: false, messages, rewrites: [] }
  if (!Array.isArray(messages) || messages.length === 0) return { changed: false, messages, rewrites: [] }

  const defaults = { ...PRUNE_DEFAULTS, ...options }
  const maxRewrites = Number.isSafeInteger(options.maxRewrites) ? options.maxRewrites : 200
  const { calls } = indexCalls(messages, defaults)
  const working = messages.slice()
  const rewrites = []
  let rewritesDone = 0

  const store = typeof options.onStore === 'function' ? options.onStore : undefined

  const commit = (resultIndex, call, reason, replacementText) => {
    if (rewritesDone >= maxRewrites) return false
    const original = textOf(working[resultIndex])
    if (original === '') return false
    if (original.length <= replacementText.length) return false
    let id
    if (store !== undefined) {
      id = store({
        toolName: call.name,
        callId: call.id,
        reducer: `prune:${reason}`,
        originalText: original,
        compressedChars: replacementText.length
      })
    }
    const withId = id !== undefined ? `${replacementText}\nctx_restore(id="${id}")` : replacementText
    working[resultIndex] = withText(working[resultIndex], withId)
    rewrites.push({
      index: resultIndex,
      toolName: call.name,
      reason,
      beforeChars: original.length,
      afterChars: withId.length,
      id,
      // The bytes actually written, so callers can audit a rewrite without
      // reaching back into the message array.
      text: withId
    })
    rewritesDone += 1
    return true
  }

  // 1. AgentDiet classification
  for (const verdict of classifyHistory(messages, defaults)) {
    if (verdict.reason === 'redundant') commit(verdict.index, verdict.call, verdict.reason, REDUNDANT)
    else if (verdict.reason === 'expired') commit(verdict.index, verdict.call, verdict.reason, EXPIRED)
    else if (verdict.reason === 'useless') commit(verdict.index, verdict.call, verdict.reason, USELESS)
  }

  // 2. Duplicate search results
  for (const stale of collapseDuplicateSearches(messages, calls, defaults)) {
    const call = calls.find((candidate) => candidate.resultIndex === stale.index)
    if (call !== undefined) commit(stale.index, call, 'duplicate-search', stale.replacement)
  }

  // 3. Content-level semantic pruning on what is left
  const protectedIndex = messages.length - defaults.protectRecentMessages
  for (let index = defaults.protectHeadMessages; index < Math.min(messages.length, protectedIndex); index += 1) {
    const message = working[index]
    if (message === null || typeof message !== 'object' || message.role !== 'tool') continue
    const text = textOf(message)
    if (text === '' || text.length < 400) continue
    const junk = collapseJunkListing(text, defaults)
    const passes = collapsePassingTests(text, defaults)
    const candidate = passes !== undefined && (junk === undefined || passes.text.length < junk.text.length) ? passes : junk
    if (candidate === undefined) continue
    const call = calls.find((entry) => entry.resultIndex === index) ?? { name: 'tool', id: '' }
    commit(index, call, 'semantic-prune', candidate.text)
  }

  return { changed: rewrites.length > 0, messages: working, rewrites }
}

/** Rough token cost of the list, for before/after reporting. */
export function estimateListTokens(messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) {
    total += estimateTokens(textOf(message))
    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block?.type === 'tool-call' && typeof block.arguments === 'string') {
          total += estimateTokens(block.arguments)
        }
      }
    }
  }
  return total
}
