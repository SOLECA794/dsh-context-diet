# dsh-context-diet

给 [dsh](https://github.com/deepseek-ai/deepseek-harness) 会话做「上下文节食」：在工具结果**落地之前**整形，在**它要摧毁的缓存已经空闲时**才瘦身历史，并把三个互相矛盾的账本摊开对账。

已测：126 个单测 + 20 项 `apply()` 冒烟检查（mock context）。

## 它解决的问题，是「把工具结果压小」解决不了的那一半

几乎所有省 token 的插件只回答一个问题：*怎么让这条工具结果变小？* 这只是问题的一半。另一半是：改写模型**已经付过钱**的内容，可能比省下来的还贵 —— 因为它会让上游正在服务的 prefix cache 失效。只数「省了多少字节」的插件，会一边报捷一边让你的账单变高。

所以这个插件是三层，中间夹一道**故意的闸门**：

| 层 | 钩子 | 做什么 | 代价 |
|---|---|---|---|
| **L1** 整形 | `tools/post-execute` | 在工具结果**写入会话日志之前**改写 | 免费 —— 字节只写一次，不存在失效 |
| **L2** 瘦身 | `agent/pre-step` | 原地替换**旧**工具结果的 content | 要重建前缀，所以有闸门决定跑不跑 |
| **L3** 对账 | `ctx_audit` / `ctx_stats` / `ctx_restore` | 让每个结论可证伪、每次压缩可逆 | 免费 |

L1 默认开。**L2 默认关** —— 先跑一次 `ctx_audit` 看清你的上游到底什么行为，再决定要不要开。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-context-diet
```

装完重启 DSH。不需要任何配置；`cordis.patch.yml` 里的每一项都是可选的，写出来只是让读者不必翻源码。

## L1 做了什么

`routeText` 先判断输出是什么，再选**最便宜且至少省 `minSavingRatio`** 的 reducer：

| 识别为 | Reducer | 真实输出实测 |
|---|---|---|
| Rust/C 编译输出 | `log-fold` | 26,637 → 3,511 字符（**86.8%**），每条 `error[E0308]` 和 `--> 文件:行:列` 都保住 |
| `grep` / `glob` 结果 | `search-fold` | 28,759 → 18,085 字符（**37.1%**），按文件分组，匹配行逐字节不变 |
| JSON | `json-pivot` | 35,105 → 3,132 字符（**91.1%**），仍是合法 JSON（`_keys` / `_rows` / `_omittedRows`） |
| 测试输出 | `test-summary` | 保留失败行和计数 |
| 表格文本 | `tabular-fold` | 首尾行 + 单格上限 |
| 长散文 | `text-head/tail` | 只留头尾 |
| 源码 | `code-skeleton` | 真实内核文件 1,474 → 352 行（**79.1%**） |

两类东西**永不触碰**：

- **`read` 的结果。** 它是字节契约 —— `edit` 和 `str_replace_editor` 要拿它比对。`write`、`apply_patch` 和本插件自己的工具同理。
- **被 `noFoldForPatterns` 命中的源码路径**（`*.rs`、`*.c`、`*.h`、`*.json` …）。

### 文档转储守卫 —— 这是全文件最重要的一处

PTC preset 下**所有**工具调用都叫 `run_code`，工具名对内容一无所知：打什么出来是程序决定的。拿真实 PTC 内核会话回放早期版本，得到 76.6% 的"节省"，几乎全是破坏：

```
45 次削减里 40 次是程序打印出来的带行号文件内容
535,523 个被削减字符里 480,730 是这个形状
text-head/tail 把 35,536 字符的 signal.rs 转储砍成 2,425 字符 —— 只剩文件开头
```

那些文件是模型主动要读的。把它砍到前 2,425 个字符不是压缩，是把答案弄丢。现在三道闸门挡着：

1. **`isDocumentDump`** —— 带行号内容（≥20 个编号行、≥30% 非空行、编号基本递增）的优先级高于一切启发式。默认动作是结构性折叠；折不了就**原样保留**，绝不 head/tail。
2. **`run_code` 不给盲切 reducer** —— `text-head/tail` 和 `shell-summary` 根本不在它的候选里。程序特意打印的 700 行清单可以完整活下来。
3. **`log-fold` 和 `tabular-fold` 必须先自证形状** —— 日志要 ≥2 条信号行才允许丢中段，表格要分隔符数量一致才允许丢行。否则 `log-fold` 会退化成第 1 条守卫要防的那种头尾截断。

同一会话、同样 174 条结果，三种策略：

| `codeSkeleton.documentDumps` | 削减 | 省字符 | 源码转储的遭遇 |
|---|---|---|---|
| `protect` | 1 / 47 | 6,906（**1.3%**） | 完整保留 |
| `fold`（默认） | 33 / 47 | 278,188（**50.6%**） | 结构保留、函数体省略、可逆 |
| `off` | 27 / 47 | 255,044（46.4%） | 被 `log-fold` 截断 —— 省了，但丢了 |

`fold` 比 `off` 省得**更多**，丢得**更少**。这就是"结构优先于截断"的全部论据。

### 代码骨架是别人都没有的那块

两个参考实现在这里都硬停了：`headroom` 的 `compressCode` 被关掉，注释写着 *"AST support is required"*；Tianshu 只支持 ts/js/py/json/md。本插件**不用解析器**就能折 **Rust / C / C++ / make / toml** —— 靠正则锚点 + 花括号深度 —— 因为内核项目就是这个语言组合。

省略标记是**行号对齐**的：

```
use crate::mm::{Frame, PhysAddr};

/// Maps a page, returning the previous mapping.
pub fn map_page(addr: PhysAddr) -> Result<(), MemoryError> {
… [elided 120-133]

pub fn unmap_page(addr: PhysAddr) -> Result<(), MemoryError> {
… [elided 147-193]
}
```

标记里带着**原文件的行号**，所以模型照样能写 `src/kernel/mm/memory_set.rs:120` 并且是对的。这是全部重点：折叠不能把模型的准头折掉。

## L2 做了什么，为什么要设闸门

L2 把旧工具结果分三类（移植自 Tianshu 的 `agent-diet`）：

- **`redundant`** —— 同一路径后面又被 `read` 且覆盖了本段，已被取代
- **`expired`** —— 文件之后被 edit/write 改过，这份快照是旧的
- **`useless`** —— 这次失败了，两步后重试成功

外加三条内容规则：垃圾目录列表（`node_modules`、`__pycache__`、`.git/`…）、全部通过的测试输出、重复的搜索。

保证安全的铁律：

> **瘦身只原地替换消息的 *content*，绝不把消息摘掉。** 摘消息会让后面每条消息的下标前移，精确前缀缓存直接作废。

跑不跑的判据是

```
protection = hitRate × (1 − pressure)      pressure = estimatedTokens / contextWindow
```

高命中率 + 低压力 → 改写历史等于摧毁一个正在赚钱的缓存，等。低命中率 → 反正没缓存，随便压。另有一条冷会话捷径：上游缓存已经过期的话，改写是免费的，直接跑。

三档缓存策略（`cache-preserving` / `balanced` / `aggressive`）缩放 watch/compact/reactive 三个阈值，且全部夹在**精度上限**之下（512K 窗口取 0.7，200K 取 0.55），任何档位都不许越线。

`cacheType: auto` 不信任上游，而是读它的行为：

| N 次请求里 `cached_tokens` 的表现 | 判定 | 选用的策略 |
|---|---|---|
| ≥8 次请求里只有 ≤2 个不同值 | `template` —— 这个字段是被填的，不是被量的 | `aggressive`（没什么可保护） |
| 同一个值占 ≥90% | `stuck` | `aggressive` |
| 很多不同值 | `live` | `cache-preserving` |

## L3：一个允许为负的账本

每一次有损压缩都写进内容寻址存储（`diet:<sha256 前16位>`），会话里的标记写明怎么取回：

```
[diet: log-fold 26637→3511 chars; ctx_restore(id="diet:4f2a9c1e8b7d6a05")]
```

`ctx_restore` **逐字节**还原原文，默认按 200 行分页，上限 2,000 行。

当「省了」这个说法被证伪时，账本记**负数**：如果模型后来又把那段原文完整读了一遍，`observePassthrough` 会认出哈希并记入 `regretChars`，于是 `netChars = savedChars − regretChars` 可以是负的。

> 报不出负数节省的插件，说明它根本没在量。

## `ctx_audit` —— 三个账本的问题

`ctx_audit` 把两种命中率口径并排报出来，因为它们回答的是不同问题，而**两者的差**才是信号：

- **main** —— 只算对话自身的请求
- **billed** —— 到达 API 的每一个 token，含旁路流量（压缩摘要、推测、重试）

旁路流量涨起来时，`billed` 掉而 `main` 不动。一个数字看不出这件事，两个可以。它同时报：

- `cacheSignal` —— `cached_tokens` 是测量值还是模板（见上表）
- `monotonicity` —— append-only 会话里 `cacheReadTokens` 不该下降。下降说明前缀在**中段**失配，这和「空闲过期」是两种不同的故障、也有不同的修法
- `costUsd` / `peakCostUsd` —— 按百万 token 计价，并按 DeepSeek 的峰谷时段拆分（北京时间，工作日 09–12 / 14–18 为峰时）
- `reconcile` —— 把上游账本的数字传进来，它告诉你该按谁的账结

## 配置

全部可选。真正要看的几个：

```yaml
enabled: true
minChars: 4000              # 小于这个长度不做任何压缩
minSavingRatio: 0.08        # 候选方案省不到这个比例就丢弃
codeSkeleton:
  enabled: true
  minLines: 60
  maxLines: 1200
  documentDumps: fold        # fold | protect | off —— 见上面的转储守卫
noFoldForTools: [read, write, edit, str_replace_editor, apply_patch, ctx_restore]
noFoldForPatterns: ['*.rs', '*.c', '*.h', '*.cpp', '*.js', '*.ts', '*.json', '*.toml']
ccr: { enabled: true, persist: true, ttlMs: 86400000, maxEntries: 2000 }
history:
  enabled: false            # L2 默认关
  strategy: auto            # cache-preserving | balanced | aggressive | auto
  cacheType: auto           # exact-prefix | none | auto
  protectionFloor: 0.45
  protectRecentMessages: 6
  protectHeadMessages: 2
audit:
  contextWindow: 512000     # 必须等于上游真实窗口
  window: 40
  prices: { inputPerM: 1, cachedInputPerM: 0.02, outputPerM: 4 }
```

> `audit.contextWindow` 比看上去重要：精度上限和每一个阈值都是从它推出来的。填上游**真正执行**的窗口，不是广告上那个。

## 与 billion-context 共存

`billion-context` 在 wire 层工作，位于请求构造**之后** —— 在代理侧折叠已经发出去的上下文。本插件在 harness 内部工作，位于结果**被记录之前**。两者目标阶段不同，可以同装，但：

- 各自维护**独立的**节省账本，不要相加。
- 两者都会以各自理由禁用原生 `compaction-basic` / `command-compact` / `tool-result-pruner`。这是预期行为，不是冲突。
- 如果开了 L2，`billion-context` 的缓存账本会把由此产生的 prompt 重写记成它自己的 miss。这是诚实报告，不是故障。

## 自己验一遍

```sh
node --test tests/*.test.js     # 126 个单测，纯函数
node scripts/verify-apply.mjs   # 20 项：注册、折叠、还原、字节契约
```

verify 脚本装了一个 resolve hook，把 `@deepseek-ai/dsh-tools`（只存在于 DSH 安装内）换成 `tests/stubs/dsh-tools.mjs`，所以普通 Node 机器上也能测 `apply()`。

## 来源与许可

Apache-2.0。设计上衍生自两个项目，**没有逐字拷贝任何代码** —— 逐文件归属见 `NOTICE`：

- [Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness) —— protection 闸门、缓存档位、精度上限、warmth 追踪、峰谷定价、原地瘦身规则、双口径命中率、缓存信号诊断
- [dsh-headroom](https://github.com/giter00/dsh-headroom) —— post-execute 监听器形状、内容寻址存储、内容路由 reducer 表
