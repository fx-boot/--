# Hotfix 补丁修复流程与打包规范

> **适用范围**：v0.6.11 本地人工自测（以及后续正式使用中）发现的**阻断 / 高严重** Bug 的紧急修复与补丁版发布。
> **一句话流程**：**阻断/高 → 从发布 tag 切 `hotfix/` 分支 → 最小化修复 + 补断言 → 三套离线测试全绿 → 打包补丁版 → 静态校验基线全过 → 合并 main → 打注解 tag → 代理推送 → 原提单人复测关闭。**
> **上位文档**：[`test-workflow.md`](test-workflow.md)（分流与复测口径）、[`git-branch-guide.md`](git-branch-guide.md)（分支/提交/tag 总规范）；本规范是两者在「补丁打包」场景的执行细则，冲突时以本规范的补丁专属条款为准。
> **关联入口**：Bug 总台账见 [`bug-tracker.md`](bug-tracker.md)，缺陷单格式见 [`test-bug-report-template.md`](test-bug-report-template.md)。

---

## 一、Bug 修复执行流程（分流）

| 严重等级 | 执行路径 | 版本去向 |
|---|---|---|
| **阻断** | **立即停止自测**，从 tag `v0.6.11` 检出 `hotfix/v0.6.11.1`，当天修复；修复范围最小化 | 补丁版 **v0.6.11.1**（必要时 `.2`、`.3`） |
| **高** | 同 hotfix 流程，与阻断项同批修复、同批发布补丁版 | 补丁版 **v0.6.11.1**；若影响面极小且当前无批量使用，经提单人确认可降级并入 v0.6.12（须在缺陷单中写明理由） |
| **中 / 低** | **不做 hotfix**：助手录入 [`backlog-issues.md`](backlog-issues.md)（编号续 `BACKLOG-B26+`），纳入 [`v0.6.12-plan.md`](v0.6.12-plan.md) 排期 | **v0.6.12** |

**补丁版边界（硬性）**：只修「阻断/高」缺陷，**不夹带新功能、不夹带 backlog 项、不做顺手重构**，避免回归面扩大。修复不得触碰三条业务红线：

1. 只有 `pending` 状态的任务才允许提交；
2. 未知/损坏状态一律转「需人工处理」，不得重新提交；
3. 下载失败只重试下载环节，绝不重新触发视频生成、不改生成状态。

---

## 二、版本号命名规则

- 常规版本线：`vX.Y.Z`（语义化版本，**第三位 Z 为补丁号**），版本号唯一来源是 `app/version.json` 的 `version` 字段。
- **补丁版**：在被修复的发布版本后**追加第四位序号**，格式 `vX.Y.Z.N`，N 从 **1** 起、按补丁发布次数递增：
  - 首个补丁：`v0.6.11.1`；第二次补丁：`v0.6.11.2`，以此类推。
- 升补丁版本时同步修改：
  - `app/version.json`：`version` 改为 `0.6.11.1`；`notes` 改写本次补丁修复内容；**把 v0.6.11 的 notes 整体归档进 `history`**（新增一条 `{version, channel, releasedAt, notes}`）；
  - `RELEASE.md`：追加补丁版小节（要求见第六节）；
  - 界面左下角版本徽标自动读取 `version.json`，无需改 UI 代码。
- **版本号一致性**：软件内 UI 显示、`app/version.json`、打包目录名、zip 名、tag 名必须**完全一致**，不得出现版本号混用。

---

## 三、打包产物命名规范

| 产物 | 命名 | 示例（首个补丁） |
|---|---|---|
| 构建输出目录 | `_build-<版本号>\` | `_build-v0.6.11.1\` |
| 便携版程序目录 | `澜川Dola管理器-<版本号>-便携版\` | `澜川Dola管理器-v0.6.11.1-便携版\` |
| 压缩包 | `澜川Dola管理器-<版本号>-便携版.zip` | `澜川Dola管理器-v0.6.11.1-便携版.zip` |
| 打包清单 | `打包清单-<版本号>.txt` | `打包清单-v0.6.11.1.txt` |

**要求**：

1. 产物一律输出到**独立 `_build-<版本号>` 目录**，不覆盖、不替换 v0.6.11 已发布包，不替换任何运行中的程序目录（exe 运行中会导致文件占用 EPERM）。
2. zip 必须使用 **UTF-8 + EFS** 方式写入（deflate + CRC32），**禁止用 Windows 自带 `tar.exe` 直接产 zip**（按 ANSI 编码文件名且不设 EFS 位，解压后中文目录乱码）；打包后需解压复核中文目录名。
3. 打包命令（`--runtime` 必须正确传入便携版运行目录，否则 82MB 的 ffmpeg.exe 会被误打进 asar）：

```powershell
node tools/pack-app.cjs --runtime <便携版运行目录> --target <便携版运行目录> --channel release
```

4. `pack-app.cjs` 自动把 `buildAt / buildChannel / gitCommit`（打包时 HEAD 短哈希）写入**包内副本**的 `version.json`，源码文件保持干净；因此必须**先提交、后打包**。

---

## 四、单元测试强制要求

发布补丁前，以下测试**全部通过**是硬性门槛，任一失败不得打包、不得打 tag：

| 测试脚本 | 基线用例数 | 说明 |
|---|---|---|
| `tools/workbench-crud-guard.test.cjs` | 19 | 增删改查与删除保护 |
| `tools/workbench-store.test.cjs` | 41 | JSON 存储、损坏恢复与迁移 |
| `tools/workbench-engine.test.cjs` | 320 | 任务引擎、状态机、驱动与监控 |
| **合计** | **380** | v0.6.11 交付时全绿 |

**强制补充**：每个修复的缺陷必须**同时新增至少一条离线断言**覆盖该缺陷场景（修复前能复现失败、修复后通过），并入上述对应脚本；用例总数在交付报告中如实列示（380 + 新增数）。

```powershell
# Node 路径（本机无 npm，直接用绝对路径）
C:\Users\Administrator\Desktop\工具\runtime\resources\c\runtime\node.exe tools\workbench-crud-guard.test.cjs
C:\Users\Administrator\Desktop\工具\runtime\resources\c\runtime\node.exe tools\workbench-store.test.cjs
C:\Users\Administrator\Desktop\工具\runtime\resources\c\runtime\node.exe tools\workbench-engine.test.cjs
```

> 纯离线执行，不启动 exe、不访问网络、不调用平台接口、不消耗账号额度。

---

## 五、静态校验基线要求

打包完成后依次执行，全部通过才允许进入 tag 环节：

1. **asar 逐条目自检**：`pack-app.cjs` 打包时自动执行（条目数/字节数与打包源逐一核对，v0.6.11 基线为 209 条目、2,700,418 字节，补丁版以实际自检输出为准并在报告中列示）。
2. **baseline-verify 复核**：

```powershell
node tools/baseline-verify.cjs <包内 resources\app.asar> app
```

   正常结果应**仅 `app/version.json` 存在差异**，且差异只能是 `buildAt / buildChannel / gitCommit` 三个构建戳字段；任何其它条目不一致即判定失败。
3. **35 项静态校验**（沿用 v0.6.11 发布基线，逐项核对并记录结果），至少覆盖：
   - `澜川Dola管理器.exe` 存在、PE 头合法（exe 资源版本为厂商遗留信息属已知事实，真实版本以包内 `app/version.json` 为准）；
   - asar 结构完整、保护基线（`protection-manifest.json` / `license-public.pem` 等）在位；
   - `docs/` 文档（含本规范、bug-tracker、测试材料）、`tools/` 三套测试脚本全部打入包内；
   - 渲染端静态 UI 资源（HTML/CSS/JS）齐全；JSON 存储逻辑模块在包内可加载；
   - 包内**不含** `isolated-data`、不含账号数据与登录会话；
   - 版本号在 UI 读取源、version.json、目录/zip 命名中一致。
4. 全程**只做静态检查**：不运行 exe、不执行业务流程、不调用任何外部 API。

---

## 六、补丁版 RELEASE.md 要求

在根目录 `RELEASE.md` **追加补丁版小节**（保留 v0.6.11 原文不动），补丁小节必须写清：

1. 补丁版本号、基线版本（v0.6.11）、发布日期、构建渠道；
2. **修复清单**：逐条列出 `BUG 编号 | 严重等级 | 所属模块 | 现象 | 修复要点`，不得只写「若干问题修复」；
3. 影响范围说明：影响哪些功能/模块、是否涉及数据安全或额度安全、是否需要重新下载整包；
4. 验证情况：离线测试结果（含新增断言数）、静态基线校验结果；
5. **已知未验证项**：如实声明（如真实账号全链路、真实生成与下载仍未验证），不得省略；
6. 打包产物目录说明与压缩包文件名。

---

## 七、Git 分支 / 提交 / Tag 完整流程

> 远端：`https://github.com/fx-boot/--.git`，稳定分支 `main`。
> **网络要求**：访问 GitHub 必须走代理，所有 git 远程命令加 `-c http.proxy=http://127.0.0.1:7897`（直连会 reset/timeout）。

```
 tag v0.6.11（基线，指向 3c1efdc）
        │
        ▼
 ① 从 tag 切补丁分支
        │
        ▼
 ② 最小化修复 + 新增离线断言
        │
        ▼
 ③ 三套离线测试全绿（380 + 新增）
        │
        ▼
 ④ 更新 version.json（版本号/notes/history）+ RELEASE.md 补丁小节
        │
        ▼
 ⑤ 分支内提交（fix/docs/build 分开，一物一提交）
        │
        ▼
 ⑥ 合并回 main（--no-ff，保留补丁轨迹）
        │
        ▼
 ⑦ 以 main 上合并提交为 HEAD 打包 → asar 自检 + baseline-verify + 35 项静态校验
        │   （校验不过：修复后走新提交，重新打包；禁止改 tag、禁止 amend 已推送提交）
        ▼
 ⑧ 在该合并提交上打注解 tag v0.6.11.1（须与包内 gitCommit 指向同一提交）
        │
        ▼
 ⑨ 代理推送：main 分支 + 补丁 tag
        │
        ▼
 ⑩ 原提单人复测通过 → bug-tracker 置「关闭」→ 按交付模板输出补丁交付报告
```

**命令清单（PowerShell 5.1，逐条执行）**：

```powershell
# ① 切分支（从基线 tag）
git checkout -b hotfix/v0.6.11.1 v0.6.11

# ②–④ 修复代码与文档（略）

# ⑤ 提交（格式：<type>(<scope>): <中文摘要>；代码/文档分开提交）
git add app/src/<修复文件> tools/<测试文件>
git commit -m "fix(runner): BUG-20260929-01 <中文摘要>"
git add app/version.json RELEASE.md
git commit -m "build(release): v0.6.11.1 版本号与补丁发布说明"

# ⑥ 合并回 main
git checkout main
git merge --no-ff hotfix/v0.6.11.1 -m "merge: hotfix v0.6.11.1 阻断/高缺陷补丁"

# ⑦ 打包与静态校验（见第三、四、五节；包内 gitCommit 必须等于本次合并提交）

# ⑧ 打注解 tag（tag 指向 = 包内 gitCommit 的合并提交）
git tag -a v0.6.11.1 -m "v0.6.11.1 补丁发布：修复 BUG-xxxx（包内 gitCommit=<合并提交短哈希>）"

# ⑨ 代理推送分支与 tag
git -c http.proxy=http://127.0.0.1:7897 push origin main
git -c http.proxy=http://127.0.0.1:7897 push origin v0.6.11.1

# 收尾：删除已合并补丁分支
git branch -d hotfix/v0.6.11.1
```

**硬性要求**：

- tag 为**注解 tag**（`-a`），且必须指向补丁包内 `app/version.json` 的 `gitCommit` 对应的那次提交，保证「checkout tag = 包内代码」；
- 顺序固定：**提交 → 打包 → 静态校验 → 打 tag → 推送**；未过静态校验不得打 tag；
- 禁止 `--no-verify`、禁止对已推送提交做 amend、禁止 force push；
- 敏感信息（账号、Cookie、isolated-data、视频直链、密钥）一律不得入库，推送前用 `git status` 复核；
- 第二个补丁 `v0.6.11.2` 从 **tag `v0.6.11.1`** 切出，规则完全相同。

---

## 八、复测与发布收尾

1. **原提单人**按原步骤复测 + 相邻功能冒烟；涉及数据的问题需重启后再次确认（口径同 [`test-workflow.md`](test-workflow.md) 第五节）。
2. 复测通过：更新 [`bug-tracker.md`](bug-tracker.md) 对应行为「关闭」，缺陷单补「复测结论：通过（日期/复测人）」。
3. 复测未通过：回到修复步骤，不降级、不改判偶发；连续两次未通过升级为阻断。
4. 修复全部完成后，助手自动套用 [`hotfix-delivery-template.md`](hotfix-delivery-template.md) 输出补丁交付报告。

---

*本规范为流程文件，不含任何业务代码改动；在收到具体阻断/高缺陷单之前，不启动修复与打包。*
