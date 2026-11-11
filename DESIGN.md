# magpie-intent-lab 设计

magpie（yetone/magpie）社区插件。用**历史会话**回测路由组的 `intent` 规则，对比「当前配置」和「草稿」的分类结果和选中的模型，调好后一键写回 magpie。

上游源码参考：`/tmp/magpie-latest`（`git clone --depth 1 https://github.com/yetone/magpie`）。下文的 `file:line` 都指这份源码，上游有改动时以源码为准。

## 范围

- v1 只做 **intent 规则**，不做 `effort=auto`。
- 分类器只支持 **System One 决策模型**（Jev，例如 `typesafe/jev-latest`）。组的 classifier 如果是普通 chat 模型或 `group/<id>`，页面直接说明不支持。
- 基线是「当前配置 vs 草稿」，两边都现场调 Jev，结果带缓存。

## 形态（magpie 插件机制，见 docs/subsystems/plugin-runtime.md P4）

- `package.json`
  - `main: index.js`
  - `magpie.page {title:"Intent Lab", titles:{zh:"意图回测"}, file:"page/index.html", icon:"page/icon.svg", service:{port:3488, option:"port"}}`
  - `magpie.options {port:3488}`
  - keywords 含 `magpie-plugin`
  - 参考模板：`internal/plugin/testdata/pageservice/`
- `index.js` 导出 `IntentLab = async (input, options) => {}`，在 `127.0.0.1:options.port` 起 `Bun.serve`。用全局变量防止重复启动；端口被占就每 200ms 重试一次，做法同模板。
- `page/index.html` 引 `_magpie/bridge.js`，ready 后把**自己的 frame 导航**到 `magpie.service || http://127.0.0.1:<port>/`。原因是 iframe 的 CSP 为 `connect-src 'none'`，不能 fetch，所以整个界面由 service 直接提供。
- service 跑在 magpie 的 Bun 宿主里，没有沙箱，能读文件、能执行命令。
  - gateway 地址取 `process.env.MAGPIE_ADDR`，默认 `127.0.0.1:3425`。走 loopback 不需要 key。
- 本地开发用 `magpie plugin add <本仓库绝对路径>`。改完代码再 add 一次，host 会重启并加载新代码。

## 数据源

1. **组和规则**：`~/.config/magpie/providers.json` 的 `groups[]`，只读。
   - 字段：`rules[]`（`use`、`intent`、`agents`、`tokens`、`images`、`effort`、`compact`、`time/days/tz`、`folders`、`exceptFolders`、`when`……）、`classifier`、`intentSure`（为空时取 0.4）。
   - 见 `internal/provider/grouprule.go`、`group.go:270`。
2. **样本：magpie 路由过的会话里的用户 turn**。
   - 从 `~/.config/magpie/routing/*.jsonl(.gz)` 拿到 `(agent, session, folder, time)`，再去 agent 自己的 transcript 取正文：
     - claude：`~/.claude/projects/*/<session>.jsonl`
     - codex：`~/.codex/sessions/**/rollout-*<session>.jsonl`
     - pi：routing 记录的 `session` 为空。按 `folder` 加时间窗去 `~/.pi/agent/sessions/**` 里匹配 cwd 和时间相符的 session 文件。
   - `conv` 是请求原始 JSON 字节的哈希，用 transcript 复算不出来，不要用它关联。
   - 每个 session 的用户 turn 按时间排列，一个 turn 对应一条 `userSaid` 非空的 user 消息。
   - 样本附带的特征：agent、folder（transcript 的 cwd）、time。关联到 routing 记录时，再附上 tokens、images、effort。
3. **Jev**：`POST http://$MAGPIE_ADDR/v1/systemone`，body 由下文的 jevBody 生成，已实测可用。gateway 会自己做脱敏。

## 逐位移植（必须和 Go 源码一致）

把下面这些函数原样移植成 TS，字符串常量逐字复制：

| Go | 位置 | 作用 |
| --- | --- | --- |
| `userWords` / `userSaid` / 注入前缀表 / `agentsFor` 正则 / `## My request:` | `internal/gateway/prompt.go:712-786` | 判断哪些文本是用户说的 |
| `lastSaid`、`cutMiddle(3000,1000)` | `classify.go:264-290` | 取最后一条用户话并截断 |
| `turnBefore`（prev user 750/250，prev reply 取末尾 1000 并加前缀 `…`） | `classify.go:296-335` | 上一轮上下文 |
| `jevBody` / `jevState` / `intentAsk` / `levelAsk` / `priorAsk` / `noIntent` | `decide.go:120-240` | 请求体 |
| `jevLevelled`（intents>1 时先探测是不是 levels，`noul>=0.5`） | `decide.go:342-385` | levels 判定 |
| `readJev` / `sureOf` / `Confidence` / `intentOf`（阈值 `IntentSure`，levels 不受阈值约束，`Sure<0.4` 时回退到上一轮 intent） | `decide.go:47-71,245-313`，`provider/decide_wire.go:89-100` | 读答案 |
| `Intents()`（大小写不敏感去重；遇到第一条无 intent 且其余条件匹配的规则就停）、`MatchRule`（第一条匹配者胜）、`Rule.Matches` | `provider/grouprule.go` | 规则求值 |

- **上一轮 intent（`prev.Intent`）**：同一 session 内按顺序回放，把上一 turn 的结果带到下一 turn。规则见 `rules.go:331-340`：只有上一轮 intent 也在本组 intents 里才带。
- **规则的非 intent 条件**：样本有对应特征就求值。拿不到特征的条件（例如 `when`，或没关联上 routing 记录时的 tokens），记为 `unknown`，在结果里标出来，并按「不匹配」处理。

## service API（JSON）

- `GET /api/groups`：返回带 intent 规则的组，以及 classifier、intentSure、规则列表、是否支持。
- `GET /api/samples?agents=&from=&to=&limit=200`：返回样本列表（不调 Jev），附带关联统计：routing 记录数、找到 transcript 的数量、各 agent 的命中率。
- `POST /api/run {group, draft:{rules, intentSure}, agents, from, to, limit}`：用 SSE 推进度，最终结果是每个样本一行：
  - `{id, agent, folder, time, text(截断后), prev, current:{intent, said, sure, rule, use}, draft:{…}, changed, unknownConds}`
  - 外加一个汇总：两边各 intent 的计数，以及 current→draft 的转移矩阵。
- `POST /api/apply {group, draft, dryRun}`：生成 `magpie group rule rm/add … at=<n>` 命令序列。`dryRun` 时只返回命令；否则逐条执行，再用 `magpie group rule <group>` 读回结果。
  - 只改 intent、use、增删规则。某条规则带有无法原样还原成 CLI 参数的字段时，拒绝写回这一条，并说明原因。
  - magpie 可执行文件：先看 `options.magpieBin`，再看 `PATH` 里的 `magpie`，最后用 `/Applications/magpie.app/Contents/MacOS/magpie`。
- **缓存**：`~/.config/magpie/intent-lab/cache.jsonl`，键为 `sha256(请求体)`，值为 Jev 答案。Jev 并发上限 4。

## 界面（service 在 `/` 提供，原生 HTML+JS，不需要构建）

- 选组：显示当前规则（只读）和草稿编辑器（intent 文本、use 下拉框只列组成员、增删、intentSure）。
- 样本条件：日期范围、agent 多选、最近 N 个 turn（默认 200）。点「回测」后显示进度条。
- 汇总：current→draft 转移矩阵、变化数。
- 结果表：时间 / agent / folder / 消息摘要 / 当前 intent·sure·模型 / 草稿 intent·sure·模型 / 变化标记 / unknown 标记。
  - 可以只看有变化的行，也可以按 intent 过滤。
  - 点一行展开：全文、上一轮上下文、两边 Jev 的原始答案。
- 写回：先预览命令，确认后执行，执行完显示读回的规则。

## 阶段 C：判定逻辑可视化 + 会话过滤（2026-11-11 与用户确认）

### C1 判定逻辑面板（全局，可折叠，放在样本条件上方）

用当前组的**实际参数**，按顺序写出 magpie 的判定链路。每一步都标出对应的 Go 源码位置，方便核对：

1. **何时判**：每个 turn 开始时（第一条有用户话语的新消息）判一次；同一 turn 里的后续请求沿用这个结果（`rules.go` turnRules）。
2. **取哪段文本**：最后一条 `userSaid` 非空的 user 消息。
   - 去掉 `<system-reminder>`，只取 `## My request:` 之后的部分。
   - 以注入前缀开头的整段不算用户话（列出当前的前缀表）。
   - 截断为前 3000 字 + `\n…\n` + 后 1000 字。
3. **上一轮上下文**：上一条用户话截成 750+250 字；上一条纯文本助手回复取末尾 1000 字。若上一轮 intent 也在本组 intents 里，就作为 `previous_message_kind` 一起发给 Jev。
4. **问 Jev**：分类器名称；选项是本组 intents（列出来）加上 `none of these`。intents 多于 1 个时，先做 levels 探测，显示这次探测的结果（levels 还是 topics）。
5. **读答案**：`sure` 的计算方式。topics 要求 `sure ≥ intentSure`（显示当前值，默认 0.4），并且答案不是 `none of these`；levels 不受阈值约束，`sure < 0.4` 时回退到上一轮 intent。
6. **选规则**：从上往下第一条所有条件都满足的规则胜出，使用它的 `use`。规则的非 intent 条件，样本有对应特征才判，否则记为 unknown 并按不匹配处理。没有命中任何规则时，按组的默认路由走。
7. **与真实路由的差异**（固定文案）：
   - 输入来自 transcript，而不是请求体；
   - 移植参照的上游源码版本（构建时写入 commit），可能和本机 magpie 版本不同；
   - 非 intent 条件会出现 unknown；
   - Jev 模型版本会变（显示答案里的 `model`，例如 jev-1.14.0）。

### C2 单行「判定过程」（展开一行结果时显示，current 和 draft 各一列）

- **最终发给 Jev 的 `message`**：截断处要标出来。另外列出被剥掉的片段，摘要即可：system-reminder 段数、`## My request:` 之前的字数、是否整段判为注入内容。
- **上一轮上下文**：`previous_user_message`、`previous_assistant_reply`、`previous_message_kind`。
- **Jev 返回结果**：返回的 model、choice、confidence、probabilities（画成条形）、算出的 `sure`、阈值、是否达标、最终 intent。如果做了 levels 探测，同时显示探测结果。是否命中缓存也要标出。
- **规则逐条判定**：每条规则对每个条件逐一给出 ✓ / ✗ / unknown 和原因，最后得出选中的规则和 use。
- 可以折叠查看原始请求体和原始答案 JSON。

为此 `/api/run` 每行要额外返回 `trace`：`{stripped, cut, prev, jevRequest, jevAnswer, levelProbe, sure, threshold, passed, intent, cached, ruleWalk:[{n, use, conds:[{name, want, got, result:"pass"|"fail"|"unknown", why}]}], chosen}`。current 和 draft 各一份。

### C3 会话过滤（只限 magpie 路由过的会话）

- 搜索条件**只用来找目标会话**。会话命中后，它在日期和 agent 范围内的**全部 user turn** 按 magpie 内置逻辑进入回测，每个 turn 都判。不做「只取命中 turn」。
- **搜索框**：纯文本，不区分大小写；提供一个可选的「正则」开关。
- **搜索范围多选**（默认只勾「首条消息」）：
  - **首条消息**：会话第一条 `userSaid` 非空的消息；
  - **全部 user 消息**：每条 `userSaid` 非空的消息；
  - **agent 回复**：助手的纯文本部分，不含 thinking；
  - **bash 命令 + 结果**：
    - claude：`tool_use` 里 `name=Bash` 的 `input.command`，以及对应的 `tool_result` 文本；
    - codex：shell / exec 类 function_call 的命令和输出；
    - pi：bash 工具的调用和结果。
    - 结果文本按每条 4000 字截断后再参与搜索。
- **会话列表**：先搜索，结果按会话列出：agent、folder、起止时间、首条消息摘要、命中次数、前 3 处命中片段（高亮）、turn 数。
  - 每个会话有复选框，默认全选命中的会话，可以手动取消。
  - 「回测」只用勾选的会话。不搜索时行为和现在一样（最近 N 个 turn）。
- **会话预览浮层**：会话列表和结果表的每一行都能打开。
  - 按时间顺序显示 user 消息、助手回复、bash 命令和结果（默认折叠，可展开）。
  - 高亮搜索命中，标出每个回测样本 turn；在结果表里打开时，定位到对应的 turn。
  - Esc 或点遮罩关闭。420px 宽时全屏显示。只读。
- **API**：
  - `GET /api/sessions?q=&regex=&scopes=first,user,reply,bash&agents=&from=&to=&limit=100`：返回会话列表和命中片段；
  - `GET /api/session?id=`：返回预览内容；
  - `POST /api/run` 增加 `sessions:[id]` 参数，传了就只回测这些会话。
- **性能**：transcript 解析结果在内存里缓存，按文件 mtime 失效。全量搜索一次应在 5 秒内完成（claude 约 528 个会话）。

## 阶段 D：分轮对齐 turnIn + 模拟会话粘性（2026-11-12 与用户确认）

### D1 分轮按 magpie 的 `turnIn` 逐位移植

- **问题**：现在把每条 `userSaid` 非空的 user 消息都算作新一轮。magpie 的 `turnIn`（`internal/gateway/affinity.go:408`）规定，下面两种情况都算本轮的继续，不调分类器：
  - 消息里带 tool_result；
  - 工具结果之后、带图片的那条文字（算图片说明）。
- **实测**：3655 个样本里有 16 个不一致，主要是 `<fork-boilerplate>` 和工具结果之后贴图的消息。
- **做法**：
  - 逐位移植 `turnIn`，以及它用到的 `saysAnything`、`withImages`。
  - 样本只取 `turnIn(messages[0..i]).within === false` 且这条消息开启了新一轮的位置。
  - parity 对拍加入 turnIn：fixtures 至少覆盖 tool_result 与文字同一条、结果之后的图片说明、只有图片的消息、fork 开场。

### D2 模拟会话粘性（每个会话按时间顺序，current 和 draft 各模拟一遍）

依据：`gateway.go` 中 `ruleOver` 的调用处（约 3201 行），以及 `rules.go:749-809`。

- **新一轮命中规则**（有 use）：规则成员排到最前，会盖过粘性。实际成员 = 规则的 use。如果和上一轮不同，这一轮记为**切换**。
- **新一轮没命中规则**：不进入规则排序逻辑，只剩粘性起作用，实际成员 = 上一轮的实际成员，不切回去。
  - 这条依赖组的 affinity 模式。先读 `affine()`（`gateway.go` / `affinity.go`），确认各模式（session / turn / none / strict 等）在这里的行为，再按模式模拟。
  - 粘不住的模式，实际成员记为「组默认路由（成员未知）」。
- **会话第一轮之前的初始成员**：取 routing 日志里该会话第一条关联记录实际服务的成员（provider/model，看 `served` 或 `tries`）；取不到时记为「未知」。
- **不模拟**：失败转移、rest、账号限额、粘性超时。在判定逻辑面板第 7 节「与真实路由的差异」里写明。
- **切换代价**：切换那一轮要在新供应商那边重新写入整段前缀。前缀 token 数优先取同会话、这一轮开始后第一条 routing 记录的 `prompt.tokens` 或 `tokens`；取不到时按 transcript 前缀字符数 / 4 估算，界面上标 `≈`。

### 界面与 API

- `/api/run` 每行的 current 和 draft 各增加 `{member, switched, from, prefixTokens, prefixEstimated, stickyWhy}`。`stickyWhy` 的取值：`rule` / `kept` / `initial` / `unknown`。
- **结果表**：
  - 新增「实际模型」列，两边各一列。切换的行加醒目标记，写成「jmds → wokey」，并附上前缀 token 数。
  - 原来的「规则 use」列继续保留。
- **单行判定过程（C2）末尾加一步「粘性」**：上一轮成员 → 本轮是否命中 → 实际成员 → 原因。
- **汇总**：两边各给出切换总次数、发生切换的会话数、切换时重写的前缀 token 总数（标出其中估算的部分），并显示 current 与 draft 的差。
- **判定逻辑面板**：在「选规则」之后插入「粘性」一步，标源码位置，写明本组的 affinity 模式和上面的规则。

## 阶段 E：以会话为单位回测 + 命中时机分析 + 精简判定逻辑（2026-11-12 与用户确认）

用户的心智模型：**先选会话，再把每个会话从第 1 轮完整跑到最后一轮**，看它在哪一轮命中、会不会因此切换模型，以此判断 intent 写得是否合理。

### E1 样本单位改为「会话」，会话过滤与样本条件合成一个面板

- **去掉「最近 N 个 turn」**，改为「最近 N 个会话」（默认 30，可调）。会话的时间按它最后一轮算。
  - 不填搜索词：取日期和 agent 范围内最近的 N 个会话。
  - 填了搜索词：取命中的会话（最多 N 个）。
- **筛选项放在同一个面板、同一列里**：日期从/到、agent 多选、搜索词、正则开关、搜索范围多选、最近 N 个会话、前 K 轮（E3 用）、「草稿命中即停」开关。
- **会话列表**：在面板内部滚动（固定最大高度，例如 360px），不要撑长整个页面。
  - 每行显示：复选框、agent、folder、时间、turn 数、首条消息摘要；有搜索词时再显示命中次数和片段。
  - 默认全选，提供全选、全不选。
  - 筛选项一变就刷新列表（加防抖）。
- **回测**：只跑勾选的会话，每个会话都从第 1 轮开始完整回放。
  - 现有的 turnIn 分轮、上一轮上下文、粘性模拟全部沿用。
  - 一个会话里的轮次必须完整，不能被截断。
- **「草稿命中即停」开关**：默认关。打开后，草稿一侧在某个会话第一次命中后，该会话后面的轮次不再问 Jev（命中后会话已粘住，不影响 E3 的统计）。这些行标「未判（已命中即停）」。当前配置一侧仍然完整跑。

### E2 判定逻辑面板精简

只保留两点，其余全部删掉，包括源码位置、前缀表和差异说明：
1. **判定时机**：每次用户发一条新消息（新的一轮）时判一次。同一轮里 agent 的后续请求（工具调用回传等）不再判。
2. **带上一轮**：判下一轮时，会把上一轮的用户消息、助手回复，以及上一轮的判定结果（如果是本组的 intent）一起发给 Jev。所以像「继续」这样的短回复通常会沿用上一轮的分类。

单行的「判定过程」（C2）保持不变。

### E3 命中时机分析（只看草稿一侧）

对每个回测会话，按草稿一侧分类：
- **开头命中**：第一次命中规则的轮次 ≤ K（K 默认 3，可调）；
- **中途命中**：第一次命中的轮次 > K；
- **未命中**：整个会话都没命中。

只有 1 轮的会话单独计数，标为「单轮」，不参与上面的比例。

**汇总**：
- 三类会话各多少个、占多少比例；
- 第一次命中所在轮次的分布（直方图：1、2、3、4–5、6–10、>10）；
- 中途命中会话的切换代价：重写的前缀 token 总数和中位数（来自 D2）。

**结果改为以会话为主视图**：
- 每个会话一行：分类标记、turn 数、第一次命中在第几轮、是否切换（from → to）、首条消息摘要，以及一条**轮次时间线**（每轮一个小格，按草稿的 命中 / 未命中 / 未判 着色，切换的那一轮加标记）。
- 可按分类过滤：只看中途命中、开头命中、未命中。
- 点会话展开它的逐轮结果（就是现有的行表格，含两侧对比和判定过程）。
- 点「预览」打开会话浮层，并定位到第一次命中的那一轮。

### API

- `GET /api/sessions` 支持不带 q：返回最近 N 个会话。
- `POST /api/run` 的参数改为 `{group, draft, sessions:[id], k, stopAfterHit}`，去掉 limit。
- 返回结果按会话分组：`sessions:[{id, agent, folder, turns, class, firstHit, switched, from, to, prefixTokens, rows:[…]}]`，另附 `summary.timing`。

## 验收

- **对拍（parity）**：`scripts/parity.sh` 在 `/tmp/magpie-latest` 的临时副本里加一个 Go 测试，对 `fixtures/*.json`（原始 messages）输出 `userSaid`、`lastSaid`、`cutMiddle`、`turnBefore`、`jevBody`。TS 对同一批输入输出同样的内容，逐字节比较，打印 `parity: N/N identical`。
- **E2E**：`bun scripts/e2e.ts` 起 service（随机端口），按下面的顺序跑，产物写到 `artifacts/e2e-<时间>.json`：
  1. `GET /api/groups` 里有 `claude-opus`。
  2. `GET /api/samples?limit=30` 至少有 1 条，并打印关联统计。
  3. `POST /api/run` 用草稿等于当前配置的方式跑 30 条：每一行的 `changed` 都应为 false。
  4. 草稿把 intent 改成 `"写代码或改代码"`，再跑：有 `changed` 行。
  5. `POST /api/apply dryRun` 返回命令序列。
  - E2E 不对真实配置执行 apply。
- **装进 magpie**：`magpie plugin add <path>` 之后 `magpie plugin list` 里有它，`curl 127.0.0.1:3488/` 返回界面。
