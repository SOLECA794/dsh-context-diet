# dsh-context-diet

Context diet for [dsh](https://github.com/deepseek-ai/deepseek-harness) sessions: reshape tool
results *before* they land, slim old history *only when the cache it would destroy is idle*, and
audit the three ledgers that disagree about your hit rate.

Tested: 135 unit tests, 29 `apply()` smoke checks against a mock context.

## The problem this solves that "shrink the tool result" does not

Almost every token-saving plugin answers one question: *how do I make this tool result smaller?*
That is half the problem. The other half is that rewriting content the model has already been
billed for **can cost more than it saves**, because it invalidates the prefix the provider was
serving from cache. A plugin that only counts bytes saved will happily report a win while your
invoice goes up.

So this plugin is three layers with a deliberate gate between them:

| Layer | Hook | What it does | Cost |
|---|---|---|---|
| **L1** reshape | `tools/post-execute` | Rewrites a tool result *before* it is materialised into the session log | Free — the bytes are written once, so nothing is ever invalidated |
| **L2** slim | `agent/pre-step` | Replaces the *content* of old tool results in place | Costs a prefix rebuild, so a gate decides whether to run |
| **L3** audit | `ctx_audit` / `ctx_stats` / `ctx_restore` | Makes every claim falsifiable and every reduction reversible | Free |

L1 is on by default. L2 is off by default — turn it on after you have run `ctx_audit` once and
seen what your provider actually does.

## Install

```sh
dsh plugin --profile <name> add dsh-context-diet
```

Restart DSH afterwards. No config is required; every knob in `cordis.patch.yml` is optional and
the file only spells out the defaults.

## What L1 does

`routeText` detects what kind of output arrived and applies the cheapest reducer that wins by at
least `minSavingRatio`:

| Detected | Reducer | Measured on real output |
|---|---|---|
| Rust/C compiler output | `log-fold` | 26,637 → 3,511 chars (**86.8%**), every `error[E0308]` and `--> file:line:col` kept |
| `grep` / `glob` results | `search-fold` | 28,759 → 18,085 chars (**37.1%**), grouped per file, matching lines byte-identical |
| JSON | `json-pivot` | 35,105 → 3,132 chars (**91.1%**), still valid JSON (`_keys` / `_rows` / `_omittedRows`) |
| Test output | `test-summary` | keeps the failure lines and the counts |
| Tabular text | `tabular-fold` | head + tail rows, per-cell cap |
| Long prose | `text-head/tail` | head + tail only |
| Source code | `code-skeleton` | 1,474 → 352 lines (**79.1%**) on a real kernel file |

Two things are never touched:

- **`read` results.** They are a byte contract — `edit` and `str_replace_editor` compare against
  them. Same for `write`, `apply_patch`, and this plugin's own tools.
- **Source paths matched by `noFoldForPatterns`** (`*.rs`, `*.c`, `*.h`, `*.json`, …).

### The document-dump guard, and why it is the most important line here

Under the PTC preset every tool call arrives as `run_code`, so the tool *name* says nothing about
the bytes — the program chose what to print. Replaying a real PTC kernel session through an earlier
build produced a 76.6% "saving" that was almost entirely damage:

```
40 of 45 reductions were line-numbered file content a program had printed
480,730 of 535,523 reduced chars were that shape
text-head/tail cut a 35,536-char signal.rs dump to 2,425 chars — the head of the file, nothing else
```

The model had asked to read those files. Cutting them to their first 2,425 characters is not
compression, it is losing the answer. Three guards now stand in the way:

1. **`isDocumentDump`** — line-numbered content (≥20 numbered lines, ≥30% of non-blank lines,
   numbering mostly ascending) outranks every heuristic. Default action is a structural fold;
   if no fold is possible the block stays **byte-identical**. Never head/tail.
2. **`run_code` withholds the blind reducers** — `text-head/tail` and `shell-summary` are not
   offered to it at all. A 700-path listing a program printed on purpose survives intact.
3. **`log-fold` and `tabular-fold` must prove their shape** — a log needs ≥2 signal lines before
   its middle may be dropped, and a table needs a consistent delimiter count. Without this,
   `log-fold` degenerates into exactly the head/tail cut guard 1 exists to prevent.

Same session, same 174 results, three policies:

| `codeSkeleton.documentDumps` | reduced | chars saved | what happens to a source dump |
|---|---|---|---|
| `protect` | 1 / 47 | 6,906 (**1.3%**) | left intact |
| `fold` (default) | 33 / 47 | 278,188 (**50.6%**) | structure kept, bodies elided, reversible |
| `off` | 27 / 47 | 255,044 (46.4%) | truncated by `log-fold` — cheap, lossy |

`fold` saves *more* than `off` and loses less. That is the whole argument for structure over
truncation.

### The code skeleton is the part nothing else has

Both reference implementations stop at a hard error here: `headroom`'s `compressCode` is disabled
with the comment *"AST support is required"*, and Tianshu supports only ts/js/py/json/md. This
plugin folds **Rust, C, C++, make and toml** with no parser — regex anchors plus brace-depth
tracking — because that is the language mix of a kernel project.

The elision markers are **line-number aligned**:

```
use crate::mm::{Frame, PhysAddr};

/// Maps a page, returning the previous mapping.
pub fn map_page(addr: PhysAddr) -> Result<(), MemoryError> {
… [elided 120-133]

pub fn unmap_page(addr: PhysAddr) -> Result<(), MemoryError> {
… [elided 147-193]
}
```

The marker carries the original line numbers, so the model can still write
`src/kernel/mm/memory_set.rs:120` and be right. That is the whole point: the fold must not cost
the model its aim.

### Two guards that exist because a real session broke them

Both were found by replaying 1,300 recorded tool results through the reducer, not by reasoning
about it. Both are the difference between "saves tokens" and "saves the wrong tokens".

**A `pwsh` result is usually a printed file, not a shell log.** Two thirds of tool bytes come from
`pwsh`, and a large share of that is the agent printing source (`head -70 src/klib/lock.rs`, a
`grep -n` over a module). `shell-summary` is a head+tail cut, so it deleted exactly the functions
the model had asked to see. Now: if the block sniffs as a source language and reads like code, the
skeleton gets first refusal, and if the skeleton cannot be built the block stays **byte-identical**
— the same rule the document-dump guard above already follows. Cutting the middle out of something
the model explicitly requested is a bug even when it saves 60%.

**A boot log's verdict is not noise.** A kernel smoke run is thirty lines of
`[blk] stat req=…` progress whose entire point is one line: `VFS_BACKENDS_PASS`. A head+tail
summary kept the banner and the last twelve progress lines and dropped the verdict. `shell-summary`
now quotes every line that reads as a verdict (`PASS`, `FAIL`, `OK`, `DONE`, `panicked`,
`assert`, `=== … ===`) verbatim, with its original line number.

Cost of the two guards, measured on the same session: 205,000 fewer characters saved than the
unguarded version. Worth it — the unguarded number was inflated by deleting the content the model
had asked for.

### Where the ceiling is

With the floor at 1000, a real 1,300-request session goes from 404,929 characters saved to
**620,999** (274 of 385 candidate blocks, 55.5% of the foldable bytes they hold), restore
round-trip still exact. That is 31% of *all* tool bytes.

It is not 31% of the bill. Tool output is resident in the prompt for a while and then compressed
away, so the share that actually gets billed repeatedly is smaller: measured over the same session,
foldable tool output accounts for **7.3% of billed prompt tokens**. Halving it removes roughly 3–4%
of the bill. Anyone quoting the 31% as a bill saving is quoting the wrong denominator.

### What still passes through, and why that is the floor

Of the 385 blocks above the floor, 111 (185,000 characters, 9% of tool bytes) are still left
byte-identical. Every one of them was checked, and they fall into three families that no reducer
should touch:

- **Curated excerpts** (13 blocks, 35,000 chars) — `=== syscall dispatch 180-265 ===` followed by
  exactly those numbered lines. The model already asked for a *filtered* view; there is nothing
  left to elide, so a structural fold saves under 8% and is discarded.
- **`grep -n` over one file** (48 blocks, 76,000 chars) — every line is a match, so every line is
  an anchor and the skeleton elides nothing. Cutting the middle would drop half the matches the
  model asked for.
- **Everything else** (50 blocks, 73,000 chars) — logs shorter than a reducer's own minimum, tables
  whose separator counts disagree, prose with no structure. Each reducer refuses on purpose.

## What L2 does, and why it is gated

L2 classifies old tool results into three kinds (ported from Tianshu's `agent-diet`):

- **`redundant`** — a later `read` of the same path covers this one, so it is superseded
- **`expired`** — the file was edited or rewritten afterwards, so the snapshot is stale
- **`useless`** — the call failed and a retry two steps later succeeded

plus three content rules: junk directory listings (`node_modules`, `__pycache__`, `.git/`…),
all-passing test output, and duplicate searches.

The invariant that keeps it safe:

> **Pruning replaces message *content* in place — it never splices messages out.** Splicing shifts
> every subsequent message index and destroys the exact-prefix cache.

Whether to run at all is decided by

```
protection = hitRate × (1 − pressure)      pressure = estimatedTokens / contextWindow
```

High hit rate + low pressure → rewriting history destroys a cache that is actively paying, so it
waits. Low hit rate → nothing is cached anyway, so it prunes freely. There is also a cold-session
shortcut: if the provider's cache has already aged out, the rewrite is free and it runs.

The three cache profiles (`cache-preserving` / `balanced` / `aggressive`) scale the
watch/compact/reactive thresholds, clamped under a **precision ceiling** (0.7 of the window at
512K, 0.55 at 200K) that no profile may exceed.

`cacheType: auto` reads your provider's behaviour instead of trusting it:

| `cached_tokens` over N requests | Verdict | Strategy chosen |
|---|---|---|
| ≤2 distinct values across ≥8 requests | `template` — the field is filled in, not measured | `aggressive` (nothing to protect) |
| one value ≥90% of requests | `stuck` | `aggressive` |
| many distinct values | `live` | `cache-preserving` |

## L3: the ledger that can go negative

Every lossy reduction is written to a content-addressed store (`diet:<sha256 prefix>`) and the
marker in the transcript says how to get it back:

```
[diet: log-fold 26637→3511 chars; ctx_restore(id="diet:4f2a9c1e8b7d6a05")]
```

`ctx_restore` returns the original **byte for byte**, paged at 200 lines by default, up to 2,000.

Its returned value has to be *lossless JSON*, because the harness snapshots every tool value and
rejects the whole result otherwise (`value is not lossless JSON`) — an `undefined` field is enough.
Two bugs came out of exactly that, both invisible to unit tests that only inspect the object:
the store record did not carry its own `id`, so every successful restore shipped `id: undefined`;
and the miss branch tested `entry === undefined` while `get()` answers `null`, so a restore of an
expired id threw `Cannot read properties of null (reading 'id')` instead of reporting the miss.
`scripts/verify-apply.mjs` now walks every tool value with the harness's own rules before asserting
on it, so this class of failure is caught without a DSH install.

The savings ledger books a **negative** when it turns out the claim was wrong: if the model later
reads those exact bytes in full, `observePassthrough` recognises the hash and charges
`regretChars`, so `netChars = savedChars − regretChars` may go below zero.

> A plugin that cannot report a negative saving is not measuring anything.

## `ctx_audit` — the three-ledger problem

`ctx_audit` reports both hit-rate definitions side by side, because they answer different
questions and the gap between them is the signal:

- **main** — only rows from the conversation's own requests
- **billed** — every token that reached the API, including side traffic (compression summaries,
  speculation, retries)

When side traffic grows, `billed` falls while `main` stays flat. One number cannot show that; two
can. It also reports:

- `cacheSignal` — is `cached_tokens` a measurement or a template (see the table above)?
- `monotonicity` — in an append-only session, `cacheReadTokens` should never decrease. A drop
  means the prefix stopped matching in the *middle*, which is a different failure from idle
  expiry and has a different fix. One cause is not a failure at all: when history is compressed
  the prompt itself shrinks, so the reusable prefix shrinks with it. Those are reported as
  `compression`, separately from the `prefix break`s where the prompt did not shrink and the
  provider really did drop the prefix. On a real 1,059-request session that split was 20 drops /
  332K tokens (compression) against 347 drops / 9.95M tokens (genuine breaks) — the two want
  opposite fixes, so they are never added together.
- `costUsd` / `peakCostUsd` — priced per million tokens, split by DeepSeek's peak/off-peak
  schedule (Beijing time, weekdays 09–12 and 14–18 are peak)
- `reconcile` — pass the provider ledger's numbers and it names whose numbers to bill against

### Where the usage numbers come from

Not from the message list. In harness 0.2.x an `assistant/message` event is
`{ turn, step, message, usage, stream }` — `usage` is a **sibling** of `message`, and `message`
carries only `{ role, content, source, id }`. A plugin that scans `agent/pre-step`'s
`payload.messages` for `message.usage` finds nothing, ever: this plugin did exactly that and
reported `Requests analysed: 0` in a live session that had 47 reductions booked in it.

The samples are read from the session log instead — `agent.session.snapshotEvents(from)`, the same
`usageOf()` source the harness's own token meter uses. The read is incremental: a cursor per
session means each step only pays for the events appended since the last one.

Two consequences worth knowing:

- `ctx_audit` says `Requests analysed: 0 (usage from none)` and `no usage samples yet` rather than
  `0.0%`. An empty denominator is not a measured zero.
- A retried attempt re-settles the same step, so an exact repeat of the previous sample is dropped
  instead of double-counting the denominator.

## Configuration

Everything is optional. The knobs that matter:

```yaml
enabled: true
# 1000, not 4000: measured on a real session, 4000 reshaped 16.5% of tool bytes
# and 1000 reshapes 31% — most tool results are 1–3 KB shell output, not 10 KB
# build logs. Below ~600 the curve is flat.
minChars: 1000
minSavingRatio: 0.08        # a candidate must beat this fraction or is discarded
minSavedChars: 400          # …and save at least this many characters outright
codeSkeleton:
  enabled: true
  minLines: 60
  maxLines: 1200
  documentDumps: fold        # fold | protect | off — see the dump guard above
noFoldForTools: [read, write, edit, str_replace_editor, apply_patch, ctx_restore]
noFoldForPatterns: ['*.rs', '*.c', '*.h', '*.cpp', '*.js', '*.ts', '*.json', '*.toml']
ccr: { enabled: true, persist: true, ttlMs: 86400000, maxEntries: 2000 }
history:
  enabled: false            # L2 off by default
  strategy: auto            # cache-preserving | balanced | aggressive | auto
  cacheType: auto           # exact-prefix | none | auto
  protectionFloor: 0.45
  protectRecentMessages: 6
  protectHeadMessages: 2
audit:
  contextWindow: 512000     # must match the provider's REAL window
  window: 40
  prices: { inputPerM: 1, cachedInputPerM: 0.02, outputPerM: 4 }
```

> `audit.contextWindow` matters more than it looks: the precision ceiling and every threshold are
> derived from it. Set it to the window your provider actually enforces, not the advertised one.

## Coexistence with billion-context

`billion-context` operates at the wire layer, *after* the request is built — it folds already-sent
context on the proxy side. This plugin operates inside the harness, *before* the result is
recorded. They target different stages and can be installed together, but:

- They keep **separate** savings ledgers, so do not add them up.
- Both will disable the native `compaction-basic` / `command-compact` / `tool-result-pruner` rows
  for different reasons. That is expected, not a conflict.
- If you enable L2, `billion-context`'s cache ledger will show the resulting prompt rewrite as
  its own miss. That is honest reporting, not a fault.
- **Every result that comes back from `billion-context` is treated as a byte contract.**
  `decompress`, `acp_retrieve`, `acp_read_original_image`, `acp_status`, `acp_cache` and
  `absorb` are all in `TOOL_HINTS` with a `null` marker, so L1 never folds them. A retrieval's
  whole purpose is to hand back exact bytes; folding it would delete the thing the model just
  asked to be restored, and the status panels are only worth reading verbatim.
- **The `[exit code: N]` marker survives a fold.** Measured on a 771-result session: zero shell
  results carried `value.exitCode`, zero carried `isError: true`, and 53 carried the marker in
  text. That literal is the only failure signal a shell result has here, and downstream tools
  parse it — a fold that moved it into a `exit 1` header line made a failed run read as a pass.

One more seam worth knowing about: `billion-context`'s `compress.absorb` is **opt-in and, as of
0.1.202, image-only by default** (`mediaOnly: true`). Turning on `absorb.enabled` alone does
nothing for text results — `mediaOnly` has to be set to `false` as well. Check before counting on
it.

## Verify it yourself

```sh
node --test tests/*.test.js     # 135 unit tests, pure functions only
node scripts/verify-apply.mjs   # 25 checks: registers, folds, restores, byte contracts

# Replay a real session through L1 and see what it would have done.
node scripts/replay-session.mjs <session.v4.jsonl.zstd> --dumps fold
node scripts/show-fold.mjs <session.v4.jsonl.zstd> 3   # one reduction, by eye
```

The verify script installs a resolve hook that swaps in `tests/stubs/dsh-tools.mjs` for
`@deepseek-ai/dsh-tools` (which only exists inside a DSH install), so `apply()` is testable on a
plain Node machine.

## Credits and license

Apache-2.0. Derived from the design of two projects, with no code copied verbatim — see `NOTICE`
for the per-file attribution:

- [Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness) — the protection gate, cache
  profiles, precision ceiling, warmth tracker, pricing phase, in-place pruning rules, dual hit
  rate, cache-signal diagnosis
- [dsh-headroom](https://github.com/giter00/dsh-headroom) — the post-execute listener shape, the
  content-addressed store, the content-routing reducer table
