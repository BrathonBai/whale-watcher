# 边缘代码审计：persona 插件 / 浏览器原型 / 工具脚本

- 审计日期：2026-11-02（Asia/Shanghai）
- 审计者：audit-aux（共享任务 task-3）
- 范围：`persona\`（18 文件）、`design\preview\*.html` + `design\ui_mock.py`、`tools\*` + `bridge\tools\gen-contract-doc.mjs`
- 方法：通读 + 语法检查 + 可跑的本地测试；persona 关键逻辑用 `node --input-type=module` 在内存里做行为模拟；桥的契约文档用「重新生成到临时目录再逐字节比对」核验
- 约束遵守情况：未修改任何被审代码；未动设备/串口；未重启 DSH；未写运行态插件目录；未调用外部 API。唯一新增文件即本报告
- 级别定义：**P0** 凭据泄漏/数据不可恢复；**P1** 当前部署下功能确定失效或安全边界失守；**P2** 明显缺陷（特定条件必错）或高风险；**P3** 代码质量、可维护性、文档漂移

---

## 0. 结论摘要

| 块 | 一句话结论 |
|---|---|
| A. persona | **当前没有被 DSH 加载**（结论与证据见 §1.1）。代码本身质量在自研插件里偏高：31 条测试全绿、演出全部可失败、落盘原子写。但一旦重新启用，有三处会让核心体验直接失效：空闲小动作永不触发、桌宠通道探测不到、主动开口在首次启动 1 分钟即开口。另外配置项 `enabled` 是空操作。 |
| B. 浏览器原型 | `index.html` 是纯视觉/交互 mock，**无 DOM XSS 面**（无 innerHTML/eval），麦克风权限失败有兜底，但麦克风驱动条带因启动顺序 bug 实际不工作。`sense.html` 是**旧感知端原型**：上行发 `frame`/`audio`、下行收 `perception`/`state`/`motion`，与 `docs/协议-v2-契约.md` 的 v2 上行 4 种/下行 7 种**完全不交集**，且依赖已被桥取代的 `prototypes/cloud/agent.py`。启动脚本 `serve.ps1` 在本机唯一可用的 Windows PowerShell 5.1 下**直接解析失败**。 |
| C. 工具脚本 | 有一个**P0**：`tools/breeze-path-test.mjs` 硬编码 Breeze TTS API Key（形如 `brz_…`，与完整 voice/model 参数同现；按约束未调用外部 API，故「是否仍有效」未验证，但必须按泄漏处理），同一串还出现在工作区快照与 profile 备份里（工作区内另有 382 MB `鲸鲸.zip`，需确认是否被打包）。`sync-mirror.ps1` 设计良好但 `/MIR` 无确认/无回滚；`gen-contract-doc.mjs` 与运行态**逐字节一致**，重新生成的契约文档与仓库文档**字节相同**（文档未漂移，是本次少见的正面结论）。 |

**Top 3（按处理优先级）**

1. **AUX-34（P0）**：`tools/breeze-path-test.mjs:6` 硬编码 Breeze API Key，并已扩散到 `snapshot-2026-10-31_鲸鲸v2\config\profile-cordis.patch.yml:34` 与 `~\.dsh\profiles\desktop\cordis.patch.yml.bak-1793501131112`。→ 立即轮换 + 清场 + 排查 `鲸鲸.zip`。
2. **AUX-02 / AUX-01 / AUX-03（P1）**：persona 若重新加载，桌宠演出 100% 走 `no-server`；空闲小动作永不触发；首启 1 分钟就主动搭话。三处都不在现有测试覆盖内。
3. **AUX-30（P1）**：`design\preview\serve.ps1` 在 PowerShell 5.1 下解析失败（BOM-less UTF-8 中文被按 GBK 解码），而本机**没有装 pwsh 7**（`Get-Command pwsh` 为空，`$PSVersionTable` = 5.1.26100），即文档给出的唯一启动方式不可用。

**严重度计数（41 条）**：P0 × 1 · P1 × 6 · P2 × 13 · P3 × 21。
按类型：确定缺陷 25 条 · 风险 16 条。

**persona 是否加载**：**否，当前未加载**（详见 §1.1）。直接原因不是代码问题，而是 2026-11-02 19:25 的 `profiles\desktop\cordis.patch.yml` 重写把 2026-11-01 04:48 加进去的 `- insert: dsh-persona` 整段去掉了。

**未覆盖部分**：`design\out\*.png` 的像素级一致性未做逐像素比对（未重跑 ui_mock.py，避免写工作区）；`sense.html` 未起服务做端到端联调（`prototypes/cloud/` 属旧服务，且任务要求只静态审）；`persona` 没在真实 Cordis 树里加载验证（禁用重启 DSH），加载判断基于配置/patch/工具清单三方证据；DSH 内部 `dispose` 事件是否存在于当前版本未验证（AUX-07 记为风险）。

---

## 1. A 块：persona 插件

### 1.1 「persona 是否被 DSH 加载」的结论与证据

**结论：未加载。** 六条独立证据互相印证：

| # | 证据 | 位置 / 命令 | 说明 |
|---|---|---|---|
| 1 | profile 的 bundle 列表里没有它 | `~\.dsh\profiles\desktop\package.json` → `dsh.profile.bundles` = `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-embodied-bridge`、`dsh-pet`、`@deepseek-ai/dsh-experimental-agent-team-profile`、`@deepseek-ai/dsh-experimental-voice-input-bundle` | `package.json` 的 `dsh.bundle.patch` 只有在包被列进 bundles 时才会被叠加 |
| 2 | 当前 patch 层没有 insert | `~\.dsh\profiles\desktop\cordis.patch.yml`（827 B，mtime 2026-11-02 19:25）只有 `ui-settings-account` / `ui-chat` / `ui-settings` / `agent-default-model` 四条，**无** `dsh-persona` | 这是 README 写的安装方式（step 3） |
| 3 | patch 历史备份证明「曾经加载过、后来被抹掉」 | `cordis.patch.yml.bak-1793501131112`（2121 B，2026-11-01 04:48）末尾有 `- insert: - id: dsh-persona / name: 'dsh-persona' / config: {petId, surface, idle}`；当前文件 827 B 且该段消失 | 同时消失的还有 `embodied-bridge` 配置段与 `llm-pi-ai` 段，指向「整个 patch 被重写」而非手工删一段 |
| 4 | 运行态状态文件停在 11-01 | `~\.dsh\plugins-data\persona\state.json`，mtime 2026-11-01 10:45:15，`lastSeenAt=1793501114477`（= 2026-11-01 10:45:14）、`stats.turns=34` | 与 #3 的时间窗吻合：11-01 04:48 装上、当天用到 10:45，此后无写入 |
| 5 | 只有 junction，没有依赖声明 | `~\.dsh\profiles\desktop\node_modules\dsh-persona` 是 Junction → `~\.dsh\plugins\dsh-persona`；但 profile `package.json` 的 `dependencies` 里**没有** `dsh-persona`（`dsh-embodied-bridge`/`dsh-purge` 都有 `file:` 依赖） | junction 是 README step 2 手工 `mklink /J` 建的，pnpm 不认；只能说明「可解析」，不能说明「被加载」 |
| 6 | 本会话运行时的工具清单里没有 `persona` 工具 | 本次会话可用工具：`device_*`（桥在）、`pwsh`、`read`… **无** `persona` | `index.js:356` 的 `ctx.tools.register` 若执行过，工具应出现在模型侧清单里 |

补充说明两点，避免误判：

- `~\.dsh\profiles\desktop\desktop-packages.json` 里有 `@deepseek-ai/dsh-persona@0.1.3-alpha.2`（8.3 KB 的官方包，未安装）。这是**官方同名 bundle**，和本工作区的自研 `dsh-persona@0.1.0` 不是同一个东西，但名字撞车（见 §1.4 与 §4.3）。
- 工作区 `persona\` 与 `~\.dsh\plugins\dsh-persona\` **逐文件 SHA-256 完全一致**（`Compare-Object` 无输出，18 个文件）。所以审工作区副本 = 审运行态副本，结论可迁移。

### 1.2 测试基线（`node --test test/`）

| 命令 | 结果 | 说明 |
|---|---|---|
| `node --test test/`（在工作区 `persona\` 下） | ❌ **1 fail / 0 pass**，报 `spawn EPERM`（`node:internal/test_runner/runner:376`） | 不是代码缺陷。本会话的沙箱禁止子进程以 piped stdio 启动，而 `node --test` 默认每个测试文件起子进程。属环境限制 |
| `node test/engine.test.mjs` | ✅ 12 pass / 0 fail（27.6 ms） | 规则回归（首次见面、凌晨问候、长任务、连续失败、限流、感谢/夸奖、气泡节流、精力上下界、连续天数、空闲、快照） |
| `node test/memory-proactive.test.mjs` | ✅ 12 pass / 0 fail（27.7 ms） | 活记忆（去重/衰减/召回/淘汰/分词/统计）+ 主动开口（太早/免打扰/被晾/降级/低精力） |
| `node test/plugin.test.mjs` | ✅ 7 pass / 0 fail（78.5 ms） | 假 ctx 走 `apply`：工具/服务注册、畸形事件、声音层去重、无钩子静默、卸载可重入 |
| **合计** | **31 / 31 通过** | 在真实用户 shell（非沙箱）里 `node --test test/` 应当同样全绿 |

**覆盖矩阵（对照 README 声明）**

| 模块 | 有测试 | 缺口 |
|---|---|---|
| `lib/engine.js` | ✅ 12 条 | 时钟回拨、时区变更、`greetingKey` 死分支未覆盖 |
| `lib/memory.js` | ✅ 部分 | `fromNotes` 迁移路径、`prune` 的 `Date.now()` 依赖未覆盖（AUX-05/16） |
| `lib/proactive.js` | ✅ 6 条 | 「首次启动 `lastUserAt=0`」未覆盖（AUX-03） |
| `lib/store.js` | ❌ 无 | 原子写、坏文件回落、并发写、`_fresh` 落盘均未覆盖（AUX-06/08） |
| `lib/pet.js` | ❌ 无 | 端口探测、额度、超时、`probe` 假成功未覆盖（AUX-02/10/11/12） |
| `lib/voice.js` | ❌ 无 | `voiceText` 上限、`notesLine` 副作用未覆盖（AUX-18） |
| `index.js` 定时器/生命周期 | ⚠️ 仅「卸载可重入」 | idle/proactive 定时器的真实节奏（AUX-01/03）；`ctx.on('dispose')` 缺失路径（AUX-07） |
| `bin/persona.mjs` | ❌ 无 | 参数解析、退出码、管道输出（AUX-15） |

### 1.3 persona 缺陷表

| ID | 级别 | 类型 | 文件:行 | 证据 | 影响 | 修复建议 |
|---|---|---|---|---|---|---|
| AUX-01 | P1 | 确定缺陷 | `persona\lib\engine.js:40,163-165,303-304` + `persona\index.js:21,219` | `IDLE_AFTER_MS = 18*MIN`；但 `decide()` 对**每个事件**都执行 `s.lastActivityAt = now`（:164-165），而 `index.js:219` 每 `IDLE_TICK_MS=60_000` 就 `dispatch({type:'idle-tick'})` → `idleGap` 永远 ≤60 s。内存模拟：连续 240 次 60 s tick（4 小时），`reaction` 次数 = **0**，`maxIdleGap = 1.0 min` | 「空闲自娱自乐」整条规则是死代码；README:71 宣称「空闲 ≥18 分钟」触发，README 表格与实际不符；现有测试 `engine.test.mjs:124` 用手工构造的 25 min gap，掩盖了这个 bug | 让 `idle-tick` 不刷新 `lastActivityAt`（只刷新 `lastSeenAt`）；或引入 `lastRealActivityAt`，仅由 `turn-start/turn-end/user-text` 更新；或把判断改成 `now - lastBubbleAt/lastUserAt` |
| AUX-02 | P1 | 确定缺陷 | `persona\lib\pet.js:14,44-60,48` | 候选端口写死 `[5878,5879,5877,5880..5885]` + `DSH_WEB_PORT`。实测：`netstat -an` 中 **5878–5885 全部未监听**；环境里 `DSH_WEB_PORT=`（空）、`DSH_WEB_URL=http://127.0.0.1:11305`；DSH 页面实际在 `127.0.0.1:11305`。dsh-pet 0.3.8 的路由确实存在（`dsh-pet/lib/index.js:3628` `ROUTE_PREFIX="/dsh-pet-7340"`，:5675 `ctx.webServer.register(...)`，:4278 `ctx.webServer?.port`），即路由挂在 DSH web server 上 → 端口就是 11305 | 即便重新加载 persona，`discoverBase()` 永远返回空 → `say/anim` 全部 `{ok:false,reason:'no-server'}`，全部演出静默失败；`index.js:388` 只留一行「没找到桌宠通道」，不报错 | 优先用 `process.env.DSH_WEB_URL`（已存在）→ `ctx.get('webServer')?.port` → 再退回端口白名单；把 `11305`/`DSH_WEB_URL` 的端口纳入候选；README 排障表同步 |
| AUX-03 | P1 | 确定缺陷 | `persona\lib\proactive.js:72-75,85-86` + `persona\lib\engine.js:68` | `defaultState()` 里 `lastUserAt: 0`；`idleMs = now - max(lastUserAt, lastProactiveAt)` → 首次安装时是「自 1970 年以来」的巨值。模拟：`planProactive(defaultState(now), now+60s)` → `fire=true, why=chatty, idleMs≈2.99e7 min`；`nextProactiveAt=0` 也直接放行 | 新装用户打开 DSH 约 1 分钟（第一个 tick）就被主动搭话，而且是 tier2 轻问句——正好违背该模块「沉默够久才说」的设计前提；用户还没开口就被打扰 | `defaultState(now)` 用 `lastUserAt: now`；`apply()` 时若 `!state.lastUserAt` 则补 `now`；并给 `planProactive` 加一个「开机冷静期」 |
| AUX-04 | P2 | 确定缺陷 | `persona\lib\store.js:29`（定义） vs `persona\index.js`（全文无读取） | `DEFAULT_CONFIG.enabled = true` 存在，但 `grep enabled` 在 `index.js`/`bin`/`lib` 里只命中 `store.js:29`、`proactive.js:15/70`（那是嵌套 `proactiveCfg.enabled`）。README:84 把 `enabled` 列为可用键 | 用户按文档写 `"enabled": false` 完全不生效，只能删 patch 才能停用；两个配置项同名不同义（顶层 vs proactiveCfg）易混淆 | 在 `apply()` 顶部 `if (cfg.enabled === false) return {dispose(){}}`（或只跳过订阅/定时器/工具注册）；或从 `DEFAULT_CONFIG` 和 README 删掉该键 |
| AUX-05 | P2 | 确定缺陷 | `persona\lib\memory.js:130` | `remember(mem, n.text, (n.at || now) * (n.at > 1e12 ? 1 : 1000) || now, …)`：`n.at` 缺失/为 0 时取 `now`（毫秒）再乘 1000。模拟：`fromNotes([{text:'…'}], now)` → `lastAccess=1793602800000`，而 `nowSec=1793602800`，放大 **1000 倍**；`weightOf` 里 `days = max(0, …)` 变负被夹 0 → 新鲜度恒为 1，权重 0.56 永不衰减 | v0.1 迁移来的老记忆会**永远**排在最前（`voice.js` 每轮注入前 2 条），新记忆被挤掉；相当于迁移一次就固化了一次人格偏见 | 显式归一化单位：`const at = Number(n.at)||0; const ms = at > 1e12 ? at : at > 1e9 ? at*1000 : now;`（注意 `at=0` 应回落到 `now`）；并补一条迁移测试 |
| AUX-06 | P2 | 确定缺陷 | `persona\lib\store.js:52-57` + `persona\index.js:51-62,327` + `persona\bin\persona.mjs:86-88,102-103` | 写盘是「tmp(pid)+rename」，进程内原子，但**没有跨进程协调**：插件内存里持有 `state` 并以 1.5 s 防抖整体覆盖写；`bin/persona.mjs note/event` 直接 `loadState→改→saveState`。插件运行期间用 CLI 记一条，1.5 s 内必被插件的旧快照覆盖（`mem` 丢失） | 记忆/情绪会「莫名其妙回滚」；两个 DSH 实例（或插件 + CLI）同时用必然丢写；`rename` 只保证文件不半截，不保证不丢更新 | 写入前比较文件 `mtimeMs`/版本号（乐观锁，冲突则重读合并）；或让 CLI 通过 `ctx.get('persona')` 服务走单写者；至少给 `state` 加 `rev` 并在 `saveState` 前重读校验 |
| AUX-07 | P2 | 风险 | `persona\index.js:393-421` | 清理逻辑只挂在 `ctx.on('dispose')` 里（:412-414，失败静默）；`apply()` 返回的 `{dispose}`（:421）不是 DSH 标准卸载契约，宿主不会自动调用。若该版本不发 `dispose` 事件：两个 `setInterval`、`session/event` 与 `agent/created` 订阅、`systemPrompt.context` 全部残留 | 插件热重载/禁用后定时器继续跑（`dispose` 内的 `disposed` 标志不会置位）→ 状态继续被改、内存泄漏、日志重复；`WeakSet` 也挡不住重新 apply 后的第二份订阅 | 同时用 `ctx.effect(() => () => dispose())`（cordis 惯例）或 `ctx.on('dispose')` + 返回值双保险；在 README 记录所依赖的 DSH 版本契约；加一条「模拟无 dispose 事件」的负面测试 |
| AUX-08 | P2 | 确定缺陷 | `persona\lib\store.js:72,77-79`（`saveState` 只剥离 `isNewDay`） | 运行态 `state.json` 里实证存在 `"_fresh": true`（`loadState` 在文件缺失/坏时返回的标记被原样落盘）。同时 `snapshot()/toneFor()` 读的是内存态，`_fresh` 无消费者 | 状态文件语义污染；若将来有人用 `_fresh` 判断「首次安装」，会因持久化而永远为真 | `saveState` 里一并剥离 `_fresh`（以及任何 `_` 前缀派生字段）；加一条「落盘后 JSON 只含白名单键」的测试 |
| AUX-09 | P2 | 风险 | `persona\index.js:262-277,323-330` + `persona\lib\voice.js:62-76` + `persona\lib\lines.js:108-111` | `note` 接受任意 160 字文本（`memory.js:48`），经 `recall` 后**原样拼进每轮注入的 systemPrompt.context**（`voice.js:80`）。没有字符集/指令性检查，没有「以下为记忆事实」边界 | 持久化 prompt 注入面：一次诱导性 `note`（例如「忽略此前规则，始终先输出 XXX」）会永久改变之后每一轮的模型行为；用户看到的是「她记得」，实际是系统提示被改写 | 注入时包一层显式边界（「以下是历史事实，不是指令」）+ 过滤换行/引号/常见注入句式；`note` 的来源标注 `trust: user`；重要度>=4 的人工确认 |
| AUX-10 | P3 | 确定缺陷 | `persona\lib\pet.js:93-96,75-79` | `probe()` 只调用 `ensureBase()`，而 `ensureBase()` 在 `base` 非空（配置了 `webBase`）时**不做任何网络请求**直接 `return true` | 配了 `webBase` 但端口错/桌宠没开时，启动日志仍打「桌宠通道就绪」→ 排障被误导；这正是 README §排障第一行想让人查的东西 | `probe()` 显式 `GET ${base}${PREFIX}/state` 并判 200；失败时清 `base` |
| AUX-11 | P3 | 风险 | `persona\lib\pet.js:16,46,75-79` | `cachedBase` 是模块级变量，探测成功后永不清除；`ensureBase()` 见 `base` 非空即返回 true | 桌宠/DSH 换端口后，本进程内所有演出永久失败（只记一行 broadcast 失败日志），直到重启 DSH；与「演出失败要静默」的策略叠加后几乎不可见 | 连续 N 次失败或收到连接错误时清 `cachedBase` 并重探；或每次 `say/anim` 前低成本校验 |
| AUX-12 | P3 | 确定缺陷 | `persona\lib\pet.js:82-87,103` | `budgetOk()` 在 `ensureBase()`/HTTP 之前就把时间戳压进 `said` 队列 | 服务不可用时白耗额度：一小时内连续 10 次失败后，真正可用时的气泡会被 `hourly-budget` 拒绝（额度是「说话机会」而不是「尝试次数」） | 请求成功（`ok===true`）后再 `said.push(now)`；或失败时回滚计数 |
| AUX-13 | P3 | 确定缺陷 | `persona\lib\engine.js:334-340` | `greetingKey()` 里 `if (idleGap > 3*HOUR) return 'back'; return 'back';` 两个分支相同 | 死代码；让人误以为「久别」有专门文案，实际只有 `back` 一组 | 删掉重复分支，或补 `long-away` 变体 |
| AUX-14 | P3 | 确定缺陷 | `persona\lib\lines.js:95` + `persona\lib\engine.js:214` | `streak.variants = ['第 {n} 天了。你还挺能来的。']`，`variantText()` 不会替换 `{n}`；当前靠 `engine.js:214` 传入 `textOpt` 掩盖。一旦某次调用没传 `textOpt`（或改走 `out(id, rule)`）就会把字面 `{n}` 吐到桌宠气泡 | 潜在用户可见乱码占位符；规则库与引擎的模板约定没有测试 | 变体里去掉 `{n}`（改为无占位），或实现 `template.replace('{n}', …)` 并在 `variantText` 统一处理 |
| AUX-15 | P3 | 确定缺陷 | `persona\bin\persona.mjs:19-33,136` | 手写 argv 解析：`--base` 后跟以 `-` 开头的值会被当成开关；`main().then(code => process.exit(code))` 在管道输出时可能截断 stdout；`main()` 无 `.catch` → 未处理 rejection 直接打堆栈退出 | CLI 作为排障入口，最容易在「参数写错」时给出误导性输出/退出码 | 用 `node:util` 的 `parseArgs`；`process.exitCode = n` 代替 `process.exit`；`main().catch(e => { console.error(e); process.exitCode = 1 })` |
| AUX-16 | P3 | 风险 | `persona\lib\memory.js:105-114,108` | `prune()` 内部用 `Date.now()`，而 `remember(…, now, …)` 已把 `now` 传进来 | 纯函数不再纯：同一组输入在不同时刻淘汰结果不同，回放/单测不可判定（现有测试靠真实时钟凑巧通过） | `prune(mem, now)` 显式传参；`remember` 调用处透传 |
| AUX-17 | P3 | 风险 | `persona\lib\memory.js:53-58` | `items = [...(mem?.items || [])]` 是浅拷贝，`find` 出来的 `dup` 与旧 state 的 item 是**同一对象**，随后 `dup.text/importance/lastAccess` 原地改 | 违背「`decide`/`remember` 返回新 state」的不可变约定：调用方持有的旧快照（如刚算出的 `snapshot`）会被悄悄改掉；在并发/回滚场景下会放大成难查的状态漂移 | 命中重复时 `items[idx] = { ...dup, … }` 生成新对象 |
| AUX-18 | P3 | 风险 | `persona\lib\voice.js:62-76,66` + `persona\lib\memory.js:86-101` | 每轮构建提示词都调用 `recall()`，而 `recall()` 会对被选中的条目 `access += 1; lastAccess = now`（:97-100） | 「展示给人看」被当成「被想起」：每条记忆每轮都被强化，`access` 迅速饱和（`weightOf:78` 的系数封顶），衰减机制形同虚设；同时每轮都改写状态却没落盘 | `recall` 增加 `{ touch: false }` 选项，`voice.js` 用只读评分；或只在真正回答「recall」动作时加权 |
| AUX-19 | P3 | 风险 | `persona\lib\engine.js:77-89,93-123,86` + `persona\lib\proactive.js:85-86` | 时间全用 `Date.now()`/本地时区：系统时钟回拨时 `gap` 为负、`lastSeenAt` 回退；`daysBetween` 返回负数 → `streak` 归 1；`nextProactiveAt` 是绝对时刻，跨时区/改时间后会「很久不开口」或「立刻开口」 | 笔记本改时间/时区、休眠唤醒后偶尔出现「连续天数重置」「该说话时不说」；不致命但难复现 | `gap = Math.max(0, now - lastSeenAt)`；`daysBetween` 夹到 `>=0`；主动开口用「上次开口后的时间差」而非绝对 `nextProactiveAt`（或两者并存） |
| AUX-20 | P2 | 确定缺陷 | 安装方式：`persona\README.md:114-143` + `~\.dsh\profiles\desktop\cordis.patch.yml`（mtime 2026-11-02 19:25） | README 的安装法是「往 profile 的 `cordis.patch.yml` 末尾加 insert」。该文件今天 19:25 被整体重写成 827 B：`insert` 段落连同 `embodied-bridge`/`llm-pi-ai` 配置一起消失（备份 `bak-1793501131112` 2121 B 仍在）。这说明**手写 patch 会被上层重写覆盖**，而 README 没给任何警示，也没提「加进 `dsh.profile.bundles` 是更稳的方式」 | 本报告 §1.1 的「未加载」就是这么发生的：装上、用了半天、被一次 patch 重写静默摘掉，没有任何报错；同理桥的 patch 配置也可能被同样抹掉 | 安装改成 bundle 方式（把 `dsh-persona` 写进 `dependencies` + `dsh.profile.bundles`，让它的 `cordis.patch.yml` 自动叠层）；README 明确写「不要手改 profile patch，除非知道它会被重写」；重启后校验 `[persona] 工具就绪` 日志 |
| AUX-21 | P3 | 确定缺陷 | `persona\package.json:14` vs §1.2 | `npm test` = `node --test test/`；在受限 shell（本会话沙箱）因 `spawn EPERM` 失败；且 `store/pet/voice/bin` 无测试（覆盖矩阵见 §1.2） | 「31 条测试全绿」容易被误读成「都覆盖了」；CI 若跑在这类沙箱会红 | 保留现有测试；补 `store`（用临时 `DSH_HOME`）与 `pet`（本地假 HTTP）两组；README/CI 注明 `node --test` 需要能起子进程的环境 |

> 另外记两条**待验证**（不占缺陷编号）：
> 1. DSH 当前版本是否真的发 `dispose` 事件（决定 AUX-07 的实际风险）。
> 2. 把自研 `dsh-persona` 加进 bundles 后，会不会与官方 `@deepseek-ai/dsh-persona` 的 entry id / 模块名冲突（两者包名不同：`dsh-persona` vs `@deepseek-ai/dsh-persona`，但 entry `id` 都习惯写 `dsh-persona`）。

### 1.4 A 块「保留 / 合并 / 删除」建议

| 对象 | 建议 | 理由 |
|---|---|---|
| `lib/engine.js`、`lib/lines.js`、`lib/voice.js` | **保留** | 纯逻辑、零依赖、有测试；是这套东西里最值钱的部分。修 AUX-01/05/13/14/16/17 即可 |
| `lib/memory.js` | **保留但降级为「小记事本」** | 机制完整但规模很小（上限 120 条、无向量）；先修 AUX-05（迁移单位）与 AUX-18（展示即强化）。不建议再投入功能 |
| `lib/proactive.js` | **保留**（修 AUX-03） | 纯函数 + 免打扰/被晾克制，设计比参考项目更保守；修好启动态即可 |
| `lib/pet.js` | **保留但必须改协议对接**（AUX-02/10/11/12） | 走 127.0.0.1 HTTP 的思路正确（不依赖 Cordis 加载顺序）；但端口发现已过时——应改为读 `DSH_WEB_URL` 或 `ctx.get('webServer').port` |
| `lib/store.js` | **保留**（修 AUX-06/08） | tmp+rename + 读坏不抛是正确做法；缺的是跨进程协调 |
| `index.js` | **保留**（修 AUX-04/07/20） | 生命周期/失败静默的写法成熟；`enabled` 空操作与 dispose 契约要补 |
| `bin/persona.mjs` | **保留**（当作排障工具，修 AUX-15） | 与插件共用同一套判断，避免行为分叉，方向对 |
| `cordis.patch.yml` + `package.json` 的 `dsh.bundle` 声明 | **保留并改用 bundle 安装** | patch 本身格式没问题（`id`/`name` 与 dsh-pet/dsh-purge 同构，无行尾注释——符合商城预检）；问题是安装方式抗不住 patch 重写（AUX-20） |
| `test\` | **保留** | 31 条里没有无效测试；缺的是 store/pet 覆盖 |
| `reference\*.md`（3 份参考文档，共 110 KB） | **可移到 `docs/reference/` 或 `_archive/`** | 是「借鉴来源」的资料，不是插件运行所需；`package.json` 的 `files` 也没包含它们，随包分发无意义 |
| 与官方 `@deepseek-ai/dsh-persona@0.1.3-alpha.2` 的关系 | **不要合并，先明确取舍** | 官方包 8.3 KB、未安装、内容未知（未解包细看）；自研版 50 KB（含记忆/主动/桌宠/设备表情），功能更全但零维护承诺。建议：保留自研作为「实验分支」，在 README 顶部署名「与官方 @deepseek-ai/dsh-persona 同名不同物，勿同时启用」；若只想低成本体验，改用官方包、删自研 |

**总判断：persona 不是死代码，但当前是「未加载的孤儿」** —— 既不进 bundles、也不进 profile 依赖、patch 被抹掉、工作区主文档（README/START-HERE/MIRROR）**零提及**。它不构成 DSH 启动负担（未加载就不会执行），但作为交付物是**未验证状态**。建议二选一：① 按 §1.4 修完 AUX-01/02/03 并改用 bundle 安装，正式启用；② 明确标记 `experimental/未启用` 并移出主线目录。不要维持「装着但没启用、文档不提」的中间态。

---

## 2. B 块：浏览器原型

### 2.1 缺陷表

| ID | 级别 | 类型 | 文件:行 | 证据 | 影响 | 修复建议 |
|---|---|---|---|---|---|---|
| AUX-22 | P1 | 确定缺陷 | `design\preview\sense.html:185,190-203,228,248` vs `docs\协议-v2-契约.md:18-27,29-39` | 上行发 `{t:"frame",seq,motion,w,h}`（:228）与 `{t:"audio",seq,rms}`（:248）；v2 契约只允许 `hello/pong/image/voice`，其它一律 `UNSUPPORTED_UPLINK`。下行处理 `perception/state/say/motion`（:190-203），而 v2 下行只有 `welcome/ping/say/face/audio/audio_end/shot`。`hello` 只带 `role/fw/caps`（:185），契约要求 `fw,board,ver(字符串),cam,w,h`。页面文案还写「先起服务：`python cloud/agent.py`」（:72），该路径已不存在——旧服务在 `prototypes\cloud\agent.py`，且 `README.md:87` 明确「已被桥取代」。连接目标 `ws://127.0.0.1:8711`（:61,:183）实测未监听 | 这一页对接的是**两代前**的感知端协议，与当前 v2 桥完全不兼容：即使把 `prototypes/cloud/agent.py` 起起来，也只对上旧 Python 服务；当成「现行感知端」演示会给评审错误印象 | 定性为 legacy：顶部加 `<!-- LEGACY: 对接 prototypes/cloud/agent.py（v1 感知端），不兼容 v2 桥 -->`；或直接移到 `prototypes/cloud/sense.html` 与旧服务同目录；若确实要保留演示，按 v2 契约重写上行（`hello`/`voice`/`image`）与下行（`say`/`face`） |
| AUX-23 | P2 | 风险 | `design\preview\sense.html:181-206` | 只有手动 `bConn` 切换；`onclose` 仅把文案复位（:186），无自动重连/退避/心跳；`onerror` 只 log（:187） | 服务重启或 Wi-Fi 抖动后必须人工点一次；路演/演示场景下断线即黑屏静默 | 加指数退避重连（0.5/1/2/4 s，上限 10 s）+ 重连次数显示；`bConn` 文案区分「连接中/已连/断开」 |
| AUX-24 | P2 | 确定缺陷 | `design\preview\sense.html:188-189` | `ws.onmessage = ev => { const m = JSON.parse(ev.data); … }`，无 try/catch | 服务端一条畸形/非 JSON 帧就抛未捕获异常；`onmessage` 该次中断，状态机不更新，控制台报错。若上游是对端可控文本（旧 agent），等于一个小型崩溃面 | `try { … } catch (e) { log('坏帧：'+e.message); return }`；必要时校验 `m.t` 白名单 |
| AUX-25 | P2 | 确定缺陷 | `design\preview\sense.html:210,211-231,225-227` | 关摄像头时只 `clearInterval` + 停 track（:212-214），**没有 `prevFrame = null`**；重开时第一个 tick 用上一次会话残留的 `prevFrame` 做差 | 重开摄像头瞬间 `motion` 出现一次性假尖峰（可达 1.0），若上游据此触发「有人/事件」，会误报。另外失败路径只有 `log()`（:231,:251），按钮与 `cap` 不提示失败原因 | 关闭时 `prevFrame=null`；失败时更新 `cap` 文本 + 按钮态；重开首帧跳过 diff |
| AUX-26 | P2 | 确定缺陷 | `design\preview\index.html:592-615` | 麦克风 loop：`const obj = {…}; (function tick(){ …; if (S.mic === obj) requestAnimationFrame(tick); })();` 然后才 `S.mic = obj`（:609）。IIFE **同步执行一次**时 `S.mic` 还是 `null` → 不会安排下一帧；赋值发生在后面，loop 再也不会被调度 | 「用麦克风驱动聆听径向条」勾选后条带**不会随声音变化**（永远停在第一次采样的值 + 兜底正弦）。这是勾选框的宣称功能，演示时会被一眼看穿 | 先 `S.mic = obj` 再启动 loop，或用 `let running=true` 作为循环条件（关闭时置 false） |
| AUX-27 | P3 | 风险 | `design\preview\index.html:617-619` | `if (qs.get("mode")) S.tiltMode = qs.get("mode")` 无白名单；`syncUI()` 里 `note.textContent = {…}[S.tiltMode]`（:581-586）→ 未知值变字符串 `undefined` 写进提示区 | `?mode=foo` 时面板出现「undefined」，评审误以为页面坏了 | 校验 `TILT_MODES.includes(mode)`；`state` 已有 `DRAW[state]` 校验，照抄即可 |
| AUX-28 | P3 | 确定缺陷 | `design\preview\index.html:417-428` vs `C:\Users\14167\Desktop\工作\embodied-watcher\docs\UI-设计语言.md`（菜单行）+ `design\ui_mock.py:242-249` | 规范：菜单「6 项落在 **200°** 弧上」；`ui_mock.py` 用 `span=200.0`、`b=-100..100`；`index.html` 用 `step=30`、`d∈{-3..3}` → 实际范围 **-60°…+90°（150°，且不对称）** | 可点原型与设计稿/规范三处不一致：`design/out/menu.png` 与 `index.html` 的菜单长得不一样；评审问「以哪份为准」时没有答案。`index.html:134` 还自称「与 docs/UI-设计语言.md 完全一致」 | 与 ui_mock 对齐（`span=200`、`b = -100 + i*40`）；把「200°」抽成一处常量并在注释里标注规范出处 |
| AUX-29 | P3 | 风险 | `design\preview\index.html:366,412` vs `design\ui_mock.py:174,225` | 同一状态在两种实现里坐标不同：待机时钟 HTML `cy=-96`（屏心上方 96）vs Python `W/2+54`（屏心下方 54）；事件副文案 HTML `cy=74` vs Python `cy=108`。两者都在安全区/文字区内，不违反硬约束，但**位置确实不同** | 两份交付物（静帧 PNG 与可点原型）不一致；改一处忘另一处是必然 | 明确唯一真源：`ui_mock.py` 出设计稿、`index.html` 只做交互，允许差异但**在 README 写清哪些允许漂移**；或用共享 `tokens.json` 生成两边常量 |
| AUX-30 | P1 | 确定缺陷 | `design\preview\serve.ps1:1-9` | 本机唯一 PowerShell 是 `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`（5.1.26100，`Get-Command pwsh` 为空）。用 5.1 的 `Parser::ParseFile` 解析：`parseErrors=1`，`字符串缺少终止符: "` @ line 7。原因是文件是 **BOM-less UTF-8**、第 8 行含中文串，5.1 按 ANSI(936) 解码后吞掉引号 | 按注释 `.\design\preview\serve.ps1` 启动直接语法错误 → 无法用 `http://127.0.0.1:8713` 打开原型 → 浏览器在 `file://` 下禁用麦克风/摄像头 → `index.html` 的麦克风功能（本来就有 AUX-26）彻底不可用 | 给 `.ps1` 存成 **UTF-8 with BOM**，或按 `tools\sync-mirror.ps1:13-14` 的既有约定把脚本写成**纯 ASCII**（中文说明放 README）。这是本工作区已经踩过并写下约定的坑，`serve.ps1` 没遵守 |
| AUX-31 | P3 | 风险 | `design\preview\serve.ps1:6,9` | 硬编码 `8713`；直接 `python -m http.server`，无 `Get-Command python` 检查、无端口占用检查（实测 8713 未监听，但被占用时会直接抛） | 换机器/端口冲突时报错信息不友好；python 不在 PATH 时只是一句「不是内部或外部命令」 | 启动前 `Get-Command python` 与 `Get-NetTCPConnection -LocalPort` 检查，给出明确提示；端口参数化 |
| AUX-32 | P3 | 风险 | `design\ui_mock.py:40-41,310` | 字体路径写死 `C:\Windows\Fonts\msyhl.ttc` / `msyh.ttc`，`ImageFont.truetype` 失败即 `FileNotFoundError`，无 fallback/无提示 | 在非 Windows 或精简系统上生成设计稿直接崩；换机器要改代码 | 候选字体列表（msyh → PingFang → Noto Sans CJK）+ 明确报错信息；或用 `matplotlib.font_manager` 同级的探测逻辑 |

**XSS / 注入（已核验，无缺陷）**：两块 HTML 里 `grep -E 'innerHTML\|outerHTML\|insertAdjacentHTML\|eval\(\|document\.write\|new Function'` **0 命中**。设备/服务端文本的去向是：`document.getElementById('say').textContent = m.text`（sense:201）、`log()` 用 `textContent`（sense:178）、canvas `fillText`（sense:149-153）——均不构成 DOM XSS。`sense.html` 的 `S.screen` 落进 `TINT[...]` 也只会变成 `undefined` 颜色；`m.text` 无长度上限，超长文本会溢出画布（P3 观感问题，未单列）。

### 2.2 B 块「保留 / 合并 / 删除」建议

| 对象 | 建议 | 理由 |
|---|---|---|
| `design\preview\index.html` | **保留**（修 AUX-26/27/28） | 零依赖、单文件、能把 10 态 + 倾角补偿三选讲清楚；是评审/路演最省事的可视物。修好麦克风与菜单弧即可 |
| `design\preview\sense.html` | **迁移到 `prototypes\cloud\`（与旧服务同目录）或 `_archive\`**；不删 | 它对接的是被桥取代的 v1 感知端（AUX-22），但 `路演\评委Q&A-预案.md:70,133` 明确把它当「浏览器真摄像头真麦」的演示证据。删掉会打断答辩材料；留在 `design/preview` 会让人误以为是现行协议。**移走 + 顶部标 LEGACY** 是两头都顾的做法 |
| `design\preview\serve.ps1` | **保留但重写为 ASCII 或加 BOM**（AUX-30/31） | 没有它，麦克风/摄像头演示就跑不起来（`file://` 被禁） |
| `design\ui_mock.py` | **保留**（修 AUX-32，并与 index.html 对齐常量） | `design/out/*.png` 全部由它出，且 `UI-设计语言.md` 明确它是渲染器；mtimes 显示 21:45:48 改脚本、21:45:54 出图，产物是新的 |
| `design\out\*.png/gif` | **保留** | 设计规范引用了它们（`design/out/menu.png` 等）；是文档的一部分 |
| `index.html` 与 `ui_mock.py` 的重复实现 | **不合并，但要定真源 + 对账** | 一个是交互、一个是静帧渲染，技术栈不同（Canvas JS vs PIL），合并成本高于收益。代价是 AUX-28/29 的漂移，属于「可接受但要记账」的重复 |
| `prototypes\cloud\`（sense.html 依赖的旧服务） | **保留为 legacy 证据，README 已标注「被桥取代」** | 与 sense.html 同去同留，避免出现「页面在、服务没了」 |

---

## 3. C 块：工具脚本

### 3.1 缺陷表

| ID | 级别 | 类型 | 文件:行 | 证据 | 影响 | 修复建议 |
|---|---|---|---|---|---|---|
| AUX-34 | P0 | 确定缺陷 | `tools\breeze-path-test.mjs:6,1,9`；`snapshot-2026-10-31_鲸鲸v2\config\profile-cordis.patch.yml:34`；`~\.dsh\profiles\desktop\cordis.patch.yml.bak-1793501131112` | 硬编码 `apiKey: 'brz_t4Kx…jtR'`（Breeze TTS 凭据格式，与 `voc_8yud7hz7c9q2`、`breeze-tts-2` 同现；**未调用外部 API，有效性未验证**）；同一串在快照配置与 profile 备份里。另硬编码插件绝对路径 `file:///C:/Users/14167/.dsh/plugins/dsh-embodied-bridge/lib/tts_breeze.js`（:1）与 ffmpeg 绝对路径（:9） | 凭据落盘在工作区（还进了 `snapshot-2026-10-31_鲸鲸v2`）；工作区根目录有 382 MB `鲸鲸.zip`，很可能一并打包 → 一旦外发/上传即可能被盗刷 TTS 额度。脚本本身还依赖运行态插件路径，插件升级即失效 | ① 按泄漏处理，立刻在 Breeze 侧**轮换该 key**；② 改读 `BREEZE_API_KEY` 环境变量；③ 从工作区、快照、profile `.bak` 清除该串；④ 检查 `鲸鲸.zip` 内是否含同一文件（只读解压检索即可）；⑤ 该一次性脚本移 `_archive/` 或删除 |
| AUX-35 | P1 | 确定缺陷 | `tools\README.md:1-9` | README 只列 `sync-mirror.ps1`，并写「不是设备工具（设备侧的刷机/串口/NVS 工具在 `..\embodied-watcher\tools\`）」。实际 `tools\` 还有：`probe-serial-audio.ps1`（**开 COM6 串口 + POST 桥 /say 的真设备工具**）、`breeze-path-test.mjs`（**联网 TTS + 密钥**）、`say-body.json`、两份 `serial-capture-*.txt` 输出 | 接手人不知道存在这些脚本，也不知道它们是设备/联网的；照 README 理解「这里只有安全的镜像脚本」，误跑 `probe-serial-audio.ps1` 会在真机上开串口 | README 补全 4 项并标注 `[设备]`/`[联网]`/`[一次性]`/`[输出]`；把「设备侧工具在别处」这句改成事实描述 |
| AUX-36 | P2 | 确定缺陷 | `tools\probe-serial-audio.ps1:4,7,8-13,33-40,44` | `[string]$BodyFile = ""` 是默认值 → 不传参时 `Invoke-WebRequest -InFile ""` 必抛（被 catch 吞成一行 `[say] ERR`）；`$ErrorActionPreference='Continue'` 让多数错误沉默；`$sp.Close()`（:44）不在 `finally` 里，中间异常会一直占着 COM6；:38 `if ($_.Exception.Response) { $msg = $msg }` 是**空操作死代码** | 默认用法不可用；异常后串口未释放（下次打开失败，需拔插）；错误信息被吞，排障困难 | `[Parameter(Mandatory=$true)]` 或默认指向 `say-body.json`；`try/finally { $sp.Close() }`；删死代码；`$ErrorActionPreference='Stop'` + 显式 catch 打完整信息 |
| AUX-37 | P2 | 风险 | `tools\sync-mirror.ps1:96-98`；`MIRROR.md` §5 | `robocopy … /MIR`（镜像模式=**会删除目标端多余文件**），`| Out-Null` 丢弃全部输出；无 `-WhatIf`/`-DryRun`、无备份、无二次确认。`MIRROR.md` 只写了「会删掉镜像里多出来的文件」一句文字提示 | 镜像目录里任何手工编辑/新增（例如在 `bridge/` 里临时加的分析笔记）会被静默删除且**无日志可查**；`/MIR` 目标写错（`$root` 推导依赖脚本位置）时破坏面更大 | 增加 `-DryRun`：先用 `/L` 列出将删除项；正式同步前把目标目录压一份时间戳 zip（或保留上一版 `.mirror-backup/`）；`robocopy` 日志落文件而不是 `Out-Null` |
| AUX-38 | P3 | 确定缺陷 | `tools\sync-mirror.ps1:123` | `Set-Content -Encoding UTF8` 在 PowerShell 5.1 下写 **UTF-8 with BOM**；实证 `.mirror.json` 前 3 字节 = `EF BB BF` | 任何用 `JSON.parse`/`json.load`（utf-8）读 manifest 的 Node/Python 脚本都会因 BOM 报错；当前没有消费者（`grep` 只有文档引用），属于「埋雷」 | 用 `[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))` 写无 BOM；或直接把 manifest 的 `generated_at` 之外全部 ASCII 化 |
| AUX-39 | P3 | 风险 | `tools\sync-mirror.ps1:30,73-75` | 源路径由「工作区的父目录」推导：`$parent\embodied-watcher\firmware`；源不存在时只 `Write-Host [skip]` 然后 `continue`，最终退出码 0 | 目录改名/换机器后「同步成功」但什么都没做，`.mirror.json` 也不更新；CI/脚本会误判为通过 | 源缺失时非 `-Verify` 模式返回非 0（或 `throw`）；manifest 里记录 `skipped` 并让 `-Verify` 报红 |
| AUX-40 | P3 | 风险 | `bridge\tools\gen-contract-doc.mjs:30-46,144-145` | `CANDIDATES[0] = process.env.HUB_DOCS_DIR`，只要该目录存在就**优先**写进去；写盘 `fs.writeFileSync` 非原子（无 tmp+rename） | 误设 `HUB_DOCS_DIR` 会把文档写到任意存在的目录（例如用户主目录）；写一半被中断会留下半截契约文档——而这份文档是「唯一契约投影」 | `HUB_DOCS_DIR` 限定必须在仓库根之下（`path.relative` 校验）；写盘改 tmp+rename；`--out` 显式参数替代环境变量 |
| AUX-41 | P3 | 风险 | `bridge\tools\gen-contract-doc.mjs:52-64` | `EVIDENCE` 是手写固件出处（`app_ui.cc:126`、`render.cc:269-282` 等行号）。`test/contract.test.mjs` 只比对**文档 JSON 块 ↔ contract.js**，不会校验这些行号 | 固件改动后行号漂移，文档仍然「自洽」但出处是错的；审稿人顺藤摸瓜会摸空 | 标注「人工核对，固件改动需同步」；或在固件侧用稳定标记（函数名/宏名）替代裸行号 |
| AUX-42 | P3 | 确定缺陷 | `bridge\tools\gen-contract-doc.mjs:3` + `docs\协议-v2-契约.md:3` | 两处都写「跑：`node tools/gen-contract-doc.mjs`」，实际文件在 `bridge\tools\`；在工作区根直接跑会 `MODULE_NOT_FOUND`（本次审计是 `cd bridge` 才跑通） | 文档给的命令跑不通，新人第一次就卡住 | 文档改成 `node bridge/tools/gen-contract-doc.mjs`（并注明 cwd），或加一个 `tools\gen-contract-doc.ps1` 薄包装 |

**已核验一致（正面结论，不占编号）**：`bridge\tools\gen-contract-doc.mjs` 与运行态 `~\.dsh\plugins\dsh-embodied-bridge\tools\gen-contract-doc.mjs` **SHA-256 相同**（`2FD3E758…`）；`lib\contract.js`、`lib\protocol.js`、`test\contract.test.mjs`、`README.md` 也都逐字节一致。用 `HUB_DOCS_DIR` 指向临时目录重新生成，产物与 `docs\协议-v2-契约.md` **SHA-256 完全相同**（`EA283139…`），即「跑 `node bridge/tools/gen-contract-doc.mjs` → 生成 4 上行 / 7 下行 / 6 工具」的文档未漂移。

### 3.2 C 块「保留 / 合并 / 删除」建议

| 对象 | 建议 | 理由 |
|---|---|---|
| `tools\sync-mirror.ps1` + `MIRROR.md` | **保留**（修 AUX-37/38/39） | 唯一维护工作区两份镜像+清单的脚本，设计有 `-Verify` 且脚本刻意保持 ASCII（:13-14 的教训写得很好）；补 dry-run/回滚/BOM 即可 |
| `tools\probe-serial-audio.ps1` | **保留但不该在 `tools/`**：移到 `..\embodied-watcher\tools\` 或 `_archive/` | 是真设备工具（开 COM6），与 `tools/README` 的定位冲突；且 `tools/README` 已写明设备工具应在别处 |
| `tools\breeze-path-test.mjs` | **删除**（先轮换 key） | 一次性排障脚本、硬编码密钥与绝对路径、依赖运行态插件内部路径；价值已被桥的 `tts-smoke.mjs` 覆盖（`bridge\test\tts-smoke.mjs` 存在） |
| `tools\say-body.json` | **保留**（作为 `probe-serial-audio.ps1` 的默认 body） | 唯一内容合法的 JSON（UTF-8 无 BOM，实测 `{"text":"你好，我是鲸鲸，看我漂亮吗？"}`），正好补 AUX-36 的默认值 |
| `tools\serial-capture-*.txt`（2 份，24 KB） | **移到 `_archive\captures\`** | 是取证输出，不是脚本；留在 `tools/` 会继续被误认为工具（内容只含串口日志，无密钥，已核验） |
| `bridge\tools\gen-contract-doc.mjs` | **保留**（系统里做得最对的工具） | 单一事实源 + 文档投影 + 测试比对，且运行态一致；只差 AUX-40/41/42 三个小修 |
| 与运行态的 `bridge/` 副本 | **保留** | 本次核验：`gen-contract-doc.mjs`/`contract.js`/`protocol.js`/`contract.test.mjs`/`README.md` 全部 SHA-256 与运行态相同，镜像没有漂移 |

---

## 4. 横向发现（跨块）

1. **DSH profile patch 会被整体重写，手写内容会静默消失（P2，见 AUX-20）**。2026-11-01 04:48 的备份（2121 B）含 `dsh-persona` insert、`embodied-bridge` 全量配置（含 breeze key）、`llm-pi-ai`；2026-11-02 19:25 的现行文件（827 B）只剩 UI 三项 + `agent-default-model`。**后果**：persona 掉线；桥的 breeze 配置也从 patch 消失（好在桥另有 `~\.dsh\plugins-data\embodied-bridge\config.json`，1365 B，今天 14:02 还在，所以桥本身可能没事——但「配置到底以哪层为准」必须查清）。**建议**：一切正式安装走 bundle；把 patch 当临时覆盖层；每次升级/重装后跑一遍「期望的 entry 是否都在」的检查脚本（可以就用 `sync-mirror.ps1 -Verify` 的思路）。
2. **本机 PowerShell 是 5.1 而不是任务说明里的 7**（`$PSVersionTable` = 5.1.26100，`pwsh` 未安装）。所有 `.ps1` 实际上按 5.1 的规则执行：`Get-Content` 默认 ANSI(GBK)、`Set-Content -Encoding UTF8` 带 BOM、BOM-less UTF-8 的中文脚本会解析失败。本报告中的 AUX-30/38 以及 `sync-mirror.ps1` 顶部那段注释都是这个坑的实例。**建议**：把「脚本一律 ASCII 或带 BOM」写成工作区约定并检查（`design\preview\serve.ps1` 就是漏网的）。
3. **同名包**：官方 `@deepseek-ai/dsh-persona@0.1.3-alpha.2`（`desktop-packages\deepseek-ai-dsh-persona-0.1.3-alpha.2.tgz`，8.3 KB，未安装）与自研 `dsh-persona@0.1.0`（50 KB）。两者 entry id 都习惯写 `dsh-persona`。**待验证**：同时启用是否冲突；`dsh.profile.bundles` 加官方包时会插入自己的 entry。建议在自研 README 顶部写明「同名不同物」。
4. **`_archive\`、`snapshot-*\`、`鲸鲸.zip` 是密钥的扩散面**：`snapshot-2026-10-31_鲸鲸v2\config\profile-cordis.patch.yml:34` 含同一 Breeze key。处理 AUX-34 时要一并清。
5. **工作区主文档（`README.md`/`START-HERE.md`/`MIRROR.md`/`docs\README.md`）全文零提及 persona**（`grep -i persona` 在工作区文档里 0 命中，persona 自己目录除外）。这佐证了「它不在主线里」：要么补齐文档，要么移出主线目录。

---

## 5. 已核验、确认没有问题（避免误伤）

| 项 | 结论 |
|---|---|
| 工作区 `persona\` vs `~\.dsh\plugins\dsh-persona\` | 18 个文件 SHA-256 全一致 |
| `cordis.patch.yml` 格式 | `- insert: - id: dsh-persona / name: 'dsh-persona'`，与 dsh-pet/dsh-purge 的 patch 同构；entry 行无行尾注释（符合商城预检约定） |
| `persona` 测试 | 逐文件跑 31/31 通过；`node --test test/` 的失败是沙箱 `spawn EPERM`，不是测试失败 |
| `bin\persona.mjs status` | 正常输出（`mood=tired, energy=78, streak=2, turns=34`），未写状态文件 |
| `say-body.json` 编码 | UTF-8 无 BOM，`{"text":"你好，我是鲸鲸，看我漂亮吗？"}`；用 PowerShell 5.1 `Get-Content` 看到乱码是**读工具的编码问题**，不是文件损坏 |
| `~\.dsh\plugins-data\persona\state.json` 编码 | UTF-8 无 BOM，`[IO.File]::ReadAllText(utf8)` + `ConvertFrom-Json` 正常；先前显示的乱码同样是 5.1 `Get-Content` 按 GBK 解码所致（用 936 回转验证可复原原文）。**不要**把它当插件缺陷 |
| 两块 HTML 的 XSS | `innerHTML/outerHTML/insertAdjacentHTML/eval/document.write/new Function` 均 0 命中；文本走 `textContent` / canvas `fillText` |
| `design\out\*` 与 `ui_mock.py` 时序 | 脚本 21:45:48 改、图 21:45:54 起生成，产物不旧 |
| `gen-contract-doc.mjs` 与运行态 | 逐字节一致；重新生成产物与 `docs\协议-v2-契约.md` 逐字节一致 |
| bridge 的 `session/event` 形状 | `bridge\lib\brain.js:349-360` 用 `event.data.reason.kind`，与 persona `index.js:189-199` 的映射一致（`turn-end` 的 `ok/reason/ms` 取值正确） |
| 桥的 `/say` 本地免令牌 | `bridge\lib\http.js:40-45,180`：本机调用免 Bearer，`probe-serial-audio.ps1` 不会被 401 |
| `sync-mirror.ps1` 的 `/MIR` 排除项 | `build/managed_components/.git`、`*.bak/sdkconfig*`、`node_modules`、`*.log` 已排除；运行态 bridge 目录无 `config.json`/密钥文件，镜像不会把凭据带进工作区 |

---

## 6. 未覆盖 / 局限

1. **persona 未在真实 Cordis 树加载**（遵守「不重启 DSH」）。「未加载」结论基于配置三方证据 + 工具清单；理论上存在「某个非 profile 路径动态 import」的可能，但没有任何证据支持（工作区/运行态 patch、bundles、依赖、日志均无）。
2. **DSH 是否发 `dispose` 事件** 未验证（AUX-07 因此只记「风险」）。需要一次受控的插件热重载实验（属于阶段二，需用户批准重启）。
3. **`design\out\*.png` 未做逐像素比对**：重跑 `ui_mock.py` 会写 `design\out`（超出本次「只写一个文件」的约束），故 AUX-28/29 的差异是**代码级**证据（坐标/步长常量），不是像素级。
4. **`sense.html` 未端到端联调**：没起 `prototypes/cloud/agent.py`（旧服务，且属静态审范围）。协议不兼容是**文本级**证据（字段名比对），不是抓包证据。
5. **`~\.dsh\cordis.patch.yml`（全局层）也已读**：只有 `rea-mcp` 与 `tool-plugin-manager`，与 persona 无关，不影响结论。
6. 未审计 `persona\reference\*.md`（110 KB 第三方参考文档）的内容真伪与许可。

---

## 7. 复现命令（只读）

```powershell
# persona 测试基线（逐文件，绕开沙箱 spawn 限制）
cd persona
node test\engine.test.mjs; node test\memory-proactive.test.mjs; node test\plugin.test.mjs
# 直接 node --test test/ 在有子进程权限的 shell 里应全绿；本会话沙箱会 EPERM

# 加载状态证据
Get-Content $env:USERPROFILE\.dsh\profiles\desktop\package.json -Raw          # bundles 无 dsh-persona
Get-Content $env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml -Raw      # 无 dsh-persona insert
Get-ChildItem $env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml* | Sort LastWriteTime
Get-Item $env:USERPROFILE\.dsh\plugins-data\persona\state.json                 # 2026-11-01 10:45:15
Get-ChildItem $env:USERPROFILE\.dsh\profiles\desktop\node_modules | ? Name -like '*persona*'

# 副本一致性
$ws="...\persona"; $rt="$env:USERPROFILE\.dsh\plugins\dsh-persona"
Compare-Object (Get-ChildItem $ws -Recurse -File | % { $_.FullName.Substring($ws.Length+1) + ' ' + (Get-FileHash $_.FullName).Hash }) `
               (Get-ChildItem $rt -Recurse -File | % { $_.FullName.Substring($rt.Length+1) + ' ' + (Get-FileHash $_.FullName).Hash })

# 端口/环境（AUX-02）
$env:DSH_WEB_URL; $env:DSH_WEB_PORT
netstat -an | Select-String ':5878|:5879|:5880|:11305'

# 契约文档未漂移（AUX-43 的核验）
cd bridge; node tools\gen-contract-doc.mjs                      # 生成到仓库 docs/
# 或隔离验证：$env:HUB_DOCS_DIR=<temp>; node tools\gen-contract-doc.mjs 然后比对 SHA256

# AUX-30 复现：PowerShell 5.1 解析 serve.ps1
$e=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path design\preview\serve.ps1).Path,[ref]$null,[ref]$e); $e.Count

# AUX-34 复现（不要把 key 复制到别处）
Select-String -Path tools\breeze-path-test.mjs,snapshot-2026-10-31_鲸鲸v2\config\profile-cordis.patch.yml -Pattern 'brz_'
```

---

## 8. 缺陷清单索引（便于跟踪）

| ID | 级别 | 类型 | 一句话 |
|---|---|---|---|
| AUX-01 | P1 | 确定缺陷 | idle-fidget 永不触发（idle-tick 自己刷新 lastActivityAt） |
| AUX-02 | P1 | 确定缺陷 | 桌宠通道端口白名单过时（11305 vs 5878-5885） |
| AUX-03 | P1 | 确定缺陷 | 首次启动 1 分钟即主动开口（lastUserAt=0） |
| AUX-04 | P2 | 确定缺陷 | `config.enabled` 是空操作 |
| AUX-05 | P2 | 确定缺陷 | fromNotes 时间单位 ×1000，老记忆永不衰减 |
| AUX-06 | P2 | 确定缺陷 | 插件防抖写 + CLI 直写，跨进程丢更新 |
| AUX-07 | P2 | 风险 | dispose 只靠 `ctx.on('dispose')`，否则定时器/订阅泄漏 |
| AUX-08 | P2 | 确定缺陷 | `_fresh` 被持久化进 state.json |
| AUX-09 | P2 | 风险 | 记忆是持久化 prompt 注入面，无清洗/边界 |
| AUX-10 | P3 | 确定缺陷 | probe 在显式 base 时假成功 |
| AUX-11 | P3 | 风险 | cachedBase 永不失效 |
| AUX-12 | P3 | 确定缺陷 | 气泡额度先扣后退 |
| AUX-13 | P3 | 确定缺陷 | greetingKey 死分支 |
| AUX-14 | P3 | 确定缺陷 | streak 变体 `{n}` 未替换（潜在） |
| AUX-15 | P3 | 确定缺陷 | CLI 参数解析 / process.exit / 无 catch |
| AUX-16 | P3 | 风险 | prune 用 Date.now() 破坏纯函数 |
| AUX-17 | P3 | 风险 | remember 原地改 dup，污染旧快照 |
| AUX-18 | P3 | 风险 | 构建提示词即强化记忆（展示被当想起） |
| AUX-19 | P3 | 风险 | 时钟回拨 / 时区变更未处理 |
| AUX-20 | P2 | 确定缺陷 | 手写 patch 被重写即丢失（本次未加载的直接原因） |
| AUX-21 | P3 | 确定缺陷 | 测试缺口 + 沙箱下 `node --test` EPERM |
| AUX-22 | P1 | 确定缺陷 | sense.html 协议与 v2 契约完全不兼容 |
| AUX-23 | P2 | 风险 | sense.html 无 WS 重连/退避 |
| AUX-24 | P2 | 确定缺陷 | sense.html JSON.parse 无异常保护 |
| AUX-25 | P2 | 确定缺陷 | 摄像头重开沿用旧 prevFrame，假运动尖峰 |
| AUX-26 | P2 | 确定缺陷 | index.html 麦克风 loop 只跑一次 |
| AUX-27 | P3 | 风险 | `?mode=` 未校验，UI 出现 undefined |
| AUX-28 | P3 | 确定缺陷 | 菜单弧 150°（不对称）vs 规范/ui_mock 的 200° |
| AUX-29 | P3 | 风险 | index.html 与 ui_mock.py 坐标漂移 |
| AUX-30 | P1 | 确定缺陷 | serve.ps1 在 PS 5.1 下解析失败 |
| AUX-31 | P3 | 风险 | serve.ps1 无 python/端口检查 |
| AUX-32 | P3 | 风险 | ui_mock.py 硬编码 Windows 字体路径 |
| AUX-34 | P0 | 确定缺陷 | Breeze API Key 硬编码并扩散到快照/备份 |
| AUX-35 | P1 | 确定缺陷 | tools/README 与实际文件不符（漏设备/联网脚本） |
| AUX-36 | P2 | 确定缺陷 | probe-serial-audio 默认参数不可用、无 finally、死代码 |
| AUX-37 | P2 | 风险 | sync-mirror /MIR 无确认/无回滚/输出被吞 |
| AUX-38 | P3 | 确定缺陷 | .mirror.json 带 BOM（PS5.1 写 UTF8 的副作用） |
| AUX-39 | P3 | 风险 | 镜像源缺失时静默 skip 且退出码 0 |
| AUX-40 | P3 | 风险 | gen-contract-doc 的 HUB_DOCS_DIR 优先 + 非原子写 |
| AUX-41 | P3 | 风险 | 契约文档的固件行号手写且无校验 |
| AUX-42 | P3 | 确定缺陷 | 生成器命令路径写错（tools/ vs bridge/tools/） |

> 编号说明：共 **41 条**缺陷（AUX-01…AUX-42，其中 AUX-33 留空）。AUX-33 与「已核验无问题」诸项不占缺陷编号（见 §5），故索引止于 AUX-42，缺号属正常。
