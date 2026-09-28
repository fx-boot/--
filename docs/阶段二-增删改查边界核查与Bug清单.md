# 阶段二 · 增删改查边界核查与 Bug 清单

**对象**：澜川Dola管理器 v0.6.10
**方法**：仅静态代码研读（未启动程序、未消耗额度）
**范围**：项目 / 分集（原「分镜」概念，见阶段一第 7 节）/ 素材 / 任务 的增、删、改、查与高并发边界

---

## 0. 对阶段一结论的纠正

| 阶段一编号 | 原判断 | 核查后结论 |
|---|---|---|
| **R20** | `resolveAssets` 静默 `continue`，缺素材不一定阻断提交 | **纠正**：`buildSegments` 会为未解析的 `@图N` 产出 `filePath:""` 的 image 段，`buildPlan` 把它并入 `references` 后交给 `validateParams`，后者在 `src\workbench-platform.js:379-382` 明确报错「N 张参考图缺少本地文件，无法上传」→ `plan.valid=false` → `src\workbench-runner.js:387-392` 以 `INVALID_PARAMS` 拒绝提交并转 `manual`。**该守卫存在且生效**。真正的问题见下方 **B7**（守卫依赖 `filePath` 非空，而 `filePath` 是拼接出来的、不校验文件是否真实存在）。 |

---

## 1. Bug 清单（按严重度）

### 🔴 高（必须修复）

| # | 分类 | 现象 | 代码根因 | 修复建议 |
|---|---|---|---|---|
| **B1** | 读取/任务 | 任务记录状态字段一旦损坏/未知（手改、截断、旧版写入），重启后该任务会**被当作「待执行」重新提交**，造成重复向平台提交、**重复扣费** | `src\workbench-task-store.js:134` 把任何不在 `STATUS` 里的状态**强转为 `PENDING`**；`src\workbench-runner.js:746` 的 `tick` 会把所有 `PENDING` 任务纳入准入 | 未知状态**不得**进入可执行集：改判为 `MANUAL` 并记录原值；或在 `tick` 里加「必须存在 `createdAt` 且非恢复态」的双重校验 |
| **B2** | 读取/素材 | 素材源文件被手工删除/移动、而 `assets.json` 仍在时，**「缺少本地文件」守卫永不触发**，任务照常入队，一直到驱动上传阶段才失败（错误信息不明确、已消耗一次提交尝试） | `src\workbench-task-service.js:59-76` `resolveAssets` 直接用 `path.join(dir, asset.fileName)` 拼路径，**不校验文件是否存在**；`src\workbench-platform.js:379` 只判 `!text(ref.filePath)` | 在 `resolveAssets` 里补 `fs.existsSync`（并对尺寸/哈希做可选校验），使不存在的文件真正落入「缺少本地文件」分支 |
| **B3** | 读取/项目 | `projects.json` 一旦损坏，**整个项目列表不可见**（磁盘目录其实都在），且**没有任何备份**，界面无从恢复，用户可能重新建项目导致旧数据彻底失联 | `src\workbench-store.js:218-225` `readJson` 静默返回 fallback；`:230-233` `readIndex` 得到空列表；索引无 `.corrupt` 备份（对比 `tasks.json` 有，`task-store.js:385-392`） | ①索引损坏时按 `.corrupt-<ts>` 备份；②新增「从 `projects/` 目录扫描 `project.json` 重建索引」的恢复路径；③界面提示可恢复而不是显示为空 |
| **B4** | 删除/项目 | 删除项目/分集**界面无任何入口**（主进程 handler 已存在）；且删除时**不检查是否有活跃任务或正在下载**，会直接 `rm` 整个项目目录（含 `tasks.json` 与分片），导致 runner 反复抛「任务记录不存在」、下载写盘失败 | 渲染层全仓无 `api.project.remove` 调用；`src\workbench-store.js:355-366` 仅校验子分集，未查活跃任务 | ①补删除入口 + 高危二次确认（阶段三）；②删除前检查活跃任务/下载，有则拒绝或先中断；③删除改为「先移入回收目录」再延迟清理 |
| **B5** | 并发/监控 | 遗留的 `submitting / queued / generating` 任务**无限轮询**（看门狗被关掉），永不收尾为「需人工处理」；且重启后 `pending` 任务**不会自动续跑** | `src\workbench-runner.js:180`（`pollTimeoutMs`）与 `:918`（`staleMs`）默认 `Infinity`，`createTaskService` 未传值；`install()` 只 `recover()` 不 `tick()` | 给出合理默认（如 `pollTimeoutMs = 6h`、`staleMs = 30min`），使卡死任务能落到 `manual`；`recover()` 结束后补一次 `tick()` 续跑待执行任务 |
| **B6** | 新增/草稿 | 编辑提示词后 **600ms 内关闭窗口或退出应用**，最后一次输入**永久丢失**（切项目/切分集/提交前都已 `flush`，唯独退出没有） | `src\renderer\workbench.js:1898-1910` 仅 600ms 防抖；全仓 grep 无 `beforeunload` / `pagehide` 监听 | 监听窗口关闭/页面隐藏时 `flushComposeDraft()`；并加 localStorage 兜底草稿，异常退出后可恢复 |
| **B7** | 修改/账号 | 账号勾选配置**不持久化**：重启后回到「默认勾选第一个账号」，用户「清空」的意图也不被记住 | `src\renderer\workbench.js:35,875-880` `selectedAccountIds`/`accountsTouched` 仅存渲染进程内存 | 写入 `project.ui.selectedAccountIds`（走既有 `workbench:ui-state` 通道），重启恢复 |

### 🟡 中（建议修复）

| # | 分类 | 现象 | 代码根因 | 修复建议 |
|---|---|---|---|---|
| **B8** | 新增/项目 | 快速连点「新建分集」，两次都算出「第 1 集」→ **重名分集**，下拉里难以区分 | `src\renderer\workbench.js:2066-2068` 先按现有名字算编号、再 `await create`，编号分配非原子 | 编号分配移到主进程（在 `updateProject`/`touchIndex` 事务内生成），或创建后按实际返回名做一次去重 |
| **B9** | 删除/项目 | `createProject` 顺序为「写 project.json → mkdir → touchIndex」，**无回滚**：中途失败/崩溃会留下「磁盘有目录、索引无记录」的**孤儿项目**（不可见） | `src\workbench-store.js:304-307` | 失败时回滚已创建的文件/目录；或先写索引为「草稿态」再补全 |
| **B10** | 状态机 | 任务已是 `manual` 时平台再返回 `failed`，`manual→failed` 属非法迁移 → 抛错被轮询 `catch` 吞掉，**状态与错误信息写不进去** | `src\workbench-runner.js:702` 配 `src\workbench-task-store.js:57`（`manual → [canceled, unconfirmed]`） | 轮询落库前先判断当前状态是否允许，非法则只更新 `poll` 字段并保留原状态 |
| **B11** | 调度 | 轮询出错后**无限**以 `pollMaxMs` 重排，无失败次数上限，任务可能长期空转 | `src\workbench-runner.js:623-632`（`pollErrorStreak` 只累加、不用于停止） | 达到上限后停止轮询并标记 `manual`，给出「监控异常」提示 |
| **B12** | 下载 | 传输声称成功但分片文件缺失时抛**非受控错误**；探测异常一律降级为 `null`，可能**掩盖真实损坏**；刷新来源失败静默无提示 | `src\workbench-download.js:306`（`fsp.stat` 无兜底）、`:311`（`.catch(()=>null)`）、`:133`（`.catch(()=>{})`） | 分别改为：明确错误码 `PART_MISSING`；探测失败按「无法核验」处理并提示，不得当作通过；刷新失败给出可读提示 |
| **B13** | 下载 | `content-encoding` 非 identity 或 `total=0` 时**跳过完整性比对**，可能放过被截断的文件 | `src\workbench-transfer.js:163-165` | 至少记录「未做长度校验」并写入任务备注；`total>0` 时必须比对 |
| **B14** | 数据一致性 | `bindAsset` 与素材删除之间存在竞态（bind 在项目锁内查 catalog，而删文件的 `assets.remove` 在项目事务**之外**执行）→ 可能留下指向已删素材的悬空引用 | `src\workbench-service.js:277-298,510-529` | 素材删除的文件移除也纳入同一串行域（或删除后回扫引用并自动解绑） |
| **B15** | 数据一致性 | 素材 `remove` 先 `unlink` 文件再写 catalog；写 catalog 失败会留下**索引悬空项** | `src\workbench-assets.js:285-296` | 调换顺序（先写 catalog 再删文件）或失败时回滚 |
| **B16** | 功能缺口 | **无任务删除/清理接口**，任务历史只增；`MAX_TASKS=4000` 仅是常量，未见裁剪逻辑 | `src\workbench-task-store.js:23`；全仓无 delete/clear 通道 | 新增「批量清理已完成任务」通道：只允许终态、二次确认、保留失败与未完成任务（阶段三） |
| **B17** | 交互缺口 | 批量生成**无二次确认**，直接入队；状态行仅提示「正在创建 N 条任务」 | `src\renderer\workbench.js:1420-1475` | 增加二次确认弹窗，明确「账号数 / 任务数 / 将消耗对应账号额度」（阶段三） |
| **B18** | 交互缺口 | 切换项目/分集仅静默 `flush`，**无「未保存改动」确认**；草稿状态只有「已保存」，没有「保存中 / 存在未保存改动」 | `src\renderer\workbench.js:2048-2064,708` | 增加三态草稿指示 + 切换确认（阶段三） |

### 🟢 低（记录，视情况处理）

| # | 现象 | 根因 |
|---|---|---|
| B19 | 驱动层 `verifySubmission` 恒返回 `found:false`，「按平台任务 ID 反查」通道未落地 → 结果不明时只能落 `unconfirmed` | `src\workbench-dola-driver.js:2420-2424` |
| B20 | 中途步骤写库错误被 `writeChain.catch(()=>{})` 静默吞掉，界面看不到步骤缺失 | `src\workbench-runner.js:377` |
| B21 | `cancel` 在 `pending` 竞争失败时递归自调用，可能重复处理 | `src\workbench-runner.js:799` |
| B22 | 自动重试退避用 `performed`（首次为 0），首次退避即等基准值，语义偏松 | `src\workbench-runner.js:559` |
| B23 | `library.templates` 未做字段归一化，原样透传，可被污染 | `src\workbench-store.js:97` |
| B24 | `readIndex` 过滤非法 id → 项目从索引消失但磁盘目录残留 | `src\workbench-store.js:237` |
| B25 | 统一 IPC 异常只抛 `new Error(message)`，丢失 `code`/`stack`，前端无法按错误码分流 | `src\workbench-service.js:563` |

---

## 2. 已核实「无缺陷」的项（避免误修）

| 场景 | 为什么安全（证据） |
|---|---|
| 新建项目/分集的草稿初始化 | 新建时 `storyboards:[]`（`store:303`），`snapshot()` 会对当前项目调 `ensureComposeDraft` 补建（`service:234`→`store:275-294`，与项目写共用文件队列，只建一次）；补建前 `currentStoryboard()` 为 null，输入监听直接 return 不落值（`renderer:1605-1606`），**不存在「UI 有内容而 JSON 无 storyboard」的持久化窗口** |
| 拖拽/Ctrl+V 部分失败 | 逐项成功即 push；`importPaths/importBuffers/remove/rename` 均经 `serializedMutation` 按项目串行（`assets:300-308`），成功项不丢（仅 `writeCatalog` 抛错时会留孤儿文件） |
| @图片绑定 | `bindAsset` 在串行 mutator 内先 `findAsset` 校验，失败整次回滚、提示词不被改写（`service:280`）；`assignTokens` 跳过已占用编号（`store:124-133`）；`reconcileRefs` 按出现顺序重建（`store:106-121`） |
| 参数修改落盘 | 参数 `onChange` **即时** `writeDraft`（`renderer:598-614`，无防抖），与提示词共用串行队列，无丢更新 |
| 改素材名 | 只改 catalog 展示名、不动 `assetId`（`assets:233-242`）；任务快照入队时已拷贝 `name`（`task-store:124-131`）→ 不一致属**不可变快照设计**，不是缺陷 |
| **历史任务快照污染** | `createAttempt`/`normalizeAttempt` 经 `snapshotParams`/`snapshotRefs` 由原始值**重建全新对象**（`task-store:113-131`），后续改提示词/素材名**不影响**已入队记录 |
| 切换项目/分集丢失改动 | `flushComposeDraft` 在 `api.project.open` **之前** await（`renderer:2048,2058`）；`scheduleUpdate` 调度时**捕获 ownerId**（`:1899`），A 的延时保存晚到也写 A，不会覆盖 B |
| 删除素材的依赖提示 | `usagesOf` 返回分集/分镜名与 token（`service:208-223`），前端 `showImpact` 列出（`renderer:447-476`）；`resolution==="unbind"` 时先保存解除引用再删文件（`service:510-529`），保存失败则文件不删 |
| 删除后重启 | `deleteProject` 先改索引再 `rm` 目录（`store:357-365`），读取以索引为准，**不会复活** |
| `tasks.json` 并发 | `append/update/replaceAll` 全部串行（`task-store:413-452`），读用 tmp+rename 原子替换 |
| `projects.json` 索引并发 | `touchIndex/updateIndex` 按索引文件串行（`store:198-216`），并发创建不会覆盖索引 |
| 重启下载恢复 | 残留 `downloading`→`paused` 并保留分片（`download:424-432`） |
| 排序稳定性 | 大项目按索引插入顺序；分集按名做 numeric 排序（`renderer:233`）；storyboard 以数组顺序即 `order`（`store:91`） |

---

## 3. 修复优先级（进入阶段三/四的执行顺序）

1. **B1** 未知状态强转 PENDING（**额度风险，最高**）
2. **B2** 缺素材守卫失效
3. **B3** 索引损坏无兜底与恢复
4. **B4** 删除项目/分集：补入口 + 活跃任务保护 + 二次确认
5. **B5** 监控看门狗与重启续跑
6. **B6 / B7** 退出丢输入 / 账号勾选持久化
7. **B10 / B11 / B12 / B13** 状态机与下载健壮性
8. **B16 / B17 / B18** 阶段三体验项（任务清理、生成二次确认、草稿三态与切换确认）
9. **B8 / B9 / B14 / B15** 一致性收尾

---

## 4. 阶段四：修复结果与验证（v0.6.11 迭代）

| # | 状态 | 修复要点 | 验证方式 |
|---|---|---|---|
| B1 | ✅ 已修复 | `normalizeAttempt`：未知非空状态不再强转 `pending`，判为 `manual` 并写 `UNKNOWN_STATUS` 错误与历史留痕 | 单测「任务状态未知」+ 单测「队列准入：只提交 pending」 |
| B2 | ✅ 已修复 | `resolveAssets` 补 `fs.statSync` 存在性/非空校验，缺失即跳过，交由平台校验层明确阻断 | 单测「提交前校验：缺本地文件阻断」 |
| B3 | ✅ 已修复 | 索引损坏先备份 `.corrupt-<ts>`，再从 `projects/` 扫描重建并落盘；`storage.recovery` 供界面提示；旧索引缺摘要字段时按需补全 | 单测「索引损坏重建」「旧版索引自愈」 |
| B4 | ✅ 已修复 | 新增删除分集/项目入口 + 二次确认（列出将删除的分集）；主进程删除前检查活跃任务与未完成下载并拒绝；`cascade` 支持连同分集删除，`cleanupFailed` 如实上报 | 单测「删除：默认拒绝 / cascade 级联」；渲染层静态 id 接线检查 |
| B5 | ✅ 已修复 | `pollTimeoutMs` 默认 6h、`staleMs` 默认 30min、`recover()` 末尾补 `tick()` | 单测「重启恢复：超期在途任务收尾」 |
| B6 | ✅ 已修复 | `beforeunload` / `pagehide` / `visibilitychange` 兜底保存 + localStorage 兜底草稿，重启自动恢复并提示 | 渲染层代码审阅（无法离线模拟窗口关闭） |
| B7 | ✅ 已修复 | 账号勾选写入 `project.ui.selectedAccountIds`，切换项目/重启按上次勾选恢复 | 渲染层实现 + 主进程复用既有 `ui-state` 通道（通道既有测试覆盖） |
| B8 | ✅ 已修复 | 分集编号改由主进程 `episodeNumbering` 串行分配 | 单测「并发新建分集：不重名」 |
| B9 | ✅ 已修复 | `createProject` 失败回滚已创建的目录 | 代码审阅（回滚分支依赖注入故障，未做故障注入测试） |
| B10 | ✅ 已修复 | 非法迁移不再抛错回滚：只更新 `poll.message` 并保留原状态 | 单测「状态迁移：非法迁移被拒绝 + 同状态幂等」 |
| B11 | ✅ 已修复 | `pollErrorLimit`（默认 5）达上限停止重排并转 `manual` | 代码审阅 + 单测覆盖状态机口径 |
| B12 | ✅ 已修复 | 新增 `PART_MISSING` 明确错误码；探测异常保留原因、不当作通过；来源刷新失败写入可读提示 | 语法校验 + 代码审阅（端到端下载需真实平台） |
| B13 | ✅ 已修复 | `lengthVerified` / `lengthNote`：未做长度比对时写入下载备注，不当作通过 | 语法校验 + 代码审阅 |
| B14 | ✅ 已修复 | `asset-delete` 删除文件后在同一项目事务内**回扫并解绑**新产生的悬空引用（`reswept` 上报） | 单测「素材删除：索引与文件同时消失」+ 代码审阅 |
| B15 | ✅ 已修复 | 素材 `remove` 改为「先写 catalog、再删文件」 | 单测「素材删除幂等」 |
| B16 | ✅ 已修复 | 新增 `workbench:task-clear`：只清终态且下载未在进行（下载中/暂停跳过并说明原因） | 单测「批量清理：只清成功且下载未在进行」 |
| B17 | ✅ 已修复 | 多账号生成前二次确认，明确账号数、任务数与额度消耗 | 渲染层实现 |
| B18 | ✅ 已修复 | 草稿三态（保存中/已保存/存在未保存改动）+ 切换分集/项目未保存改动确认（保存并切换/丢弃/取消） | 渲染层实现 |
| B19–B25 | 🟡 记录未修 | 属驱动层反查通道、调试日志密度、退避语义、模板归一化、索引过滤、IPC 错误码透传等低风险项；不影响当前数据安全与额度安全，留待后续迭代 | 阶段二静态结论 |

**同轮完成的功能补齐（阶段三）**：中栏可折叠分集列表（序号 / 名称 / 提示词摘要 / 素材数 / 上移下移 / 多选 / 批量复制含素材 / 批量删除）；任务面板「清理已完成任务」；失败任务默认展开完整报错；素材悬停放大预览；选中文字后「插入」用 `@图N` 替换选区；`Ctrl+Enter` 生成、`Ctrl+S` 立即保存。

**离线验证**：`tools/workbench-engine.test.cjs` 共 19 项断言全部通过（覆盖新增 / 修改 / 删除 / 重启加载 / 并发读写与上表修复项）；渲染层新增元素经静态 id 接线检查；全部改动文件通过 `node --check`。

**未验证部分（如实说明）**：真实平台提交与出片全链路、真实同源下载与断点续传、`B12/B13` 的端到端下载错误分支，均需要真实账号与额度，本迭代未执行 → 仍标记【阶段2未验收】。

---

*本文档全部结论来自静态代码阅读与离线单元测试，未启动 exe、未消耗任何平台额度。*