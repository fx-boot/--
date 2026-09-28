# Git 分支与版本管理规范

> **适用仓库**：`https://github.com/fx-boot/--.git`
> **仓库结构**：`app/`（应用源码）· `docs/`（文档与测试材料）· `tools/`（打包与离线校验脚本）
> **关键约定**：打包产物 `app.asar` 内会写入当次构建的 **Git 短提交号**（`app/version.json` 的 `gitCommit`），因此**必须先提交、后打包**，保证「包 ↔ 提交」可精确对应。

---

## 一、分支模型

| 分支 | 用途 | 对应版本 | 规则 |
|---|---|---|---|
| **`main`** | **稳定发布分支**：只存放已验证、可打包的代码与文档 | v0.6.11、v0.6.12 … | 任何进入 `main` 的改动都必须：离线测试全绿 + 不触碰三条红线（只有 `pending` 才提交 / 未知状态转人工 / 下载失败不改生成）。禁止直接在别人的未合并状态上继续开发 |
| **`feature/<简述>`** | 后续 bug 修复与功能开发分支 | 计划中的下一个版本 | 从 `main` 切出；开发完成、自测与离线测试通过后**合并回 `main`**；合并后删除分支 |
| **`hotfix/<版本号>`** | 线上严重问题的紧急补丁分支（见 [`test-workflow.md`](test-workflow.md)） | v0.6.11.1 这类补丁版 | 从对应发布 tag 切出，只含最小修复；修复后合并 `main` 并打补丁 tag |

**命名示例**

```
feature/fix-b22-retry-backoff          修复自动重试退避
feature/ui-episode-filter              分集列表过滤
feature/bug-20260929-01                按缺陷单修复
hotfix/v0.6.11.1                       线上阻断问题补丁
```

**基本流程（修复/小功能）**

```bash
git checkout main
git pull --rebase origin main
git checkout -b feature/fix-b22-retry-backoff

# …改动 + 离线测试（三套全绿）…
git add <本次改动的具体文件>
git commit -m "fix(runner): 自动重试退避改为按已排定次数递增"

git checkout main
git merge --no-ff feature/fix-b22-retry-backoff
git push origin main
git branch -d feature/fix-b22-retry-backoff
```

---

## 二、提交规范（Commit Message）

**格式**

```
<type>(<scope>): <中文摘要>

<可选正文：为什么这么改、影响范围、验证方式>
```

**版本发布提交**（本仓库历史惯例，用于版本里程碑）额外允许直接以版本号开头：

```
v0.6.11 项目/分集/素材/任务全链路调研与修复 + 阶段三体验优化
```

**type 取值**

| type | 用途 |
|---|---|
| `feat` | 新增功能 |
| `fix` | 缺陷修复（含 backlog 项，摘要里带编号，如 `fix(runner): B22 退避语义修正`） |
| `docs` | 文档、测试用例、发布说明 |
| `test` | 仅测试与断言变更 |
| `build` | 打包脚本、版本号、构建配置 |
| `chore` | 其它杂项（不含业务逻辑） |
| `refactor` | 不改变行为的重构 |

**硬性要求**

1. 一次提交只做一件事：**代码与文档分开提交**（例如 v0.6.11 的代码提交 `2b1459c`、文档提交 `3c1efdc`/`55aa63c`）。
2. 摘要用中文，写「做了什么 + 为什么」；涉及 backlog 的必须带编号。
3. **禁止**跳过校验提交：不存 `--no-verify` 之类的绕过；被 hook 拦下要先修问题再重新提交（用**新提交**，不要 amend 已推送的提交）。
4. 敏感信息（账号、Cookie、`isolated-data`、视频直链、密钥）**一律不得入库**，`.gitignore` 已覆盖，提交前请用 `git status` 复核。

---

## 三、版本 Tag 规范

- **命名**：`v主.次.补丁`（与 `app/version.json` 的 `version` 完全一致），补丁版如 `v0.6.11.1`。
- **类型**：使用**注解 tag**（`-a`），message 写清「版本摘要 + 包内 gitCommit」，便于 `git show v0.6.11` 一眼看到发布内容。
- **指向**：**指向该发布包内 `app/version.json` 的 `gitCommit` 对应的那次提交** —— 这样 `git checkout v0.6.11` 后的 HEAD 与包内记录的提交号完全一致，可用 `tools/baseline-verify.cjs` 直接复核「包 = 源码」。
- **时机**：**打包校验通过后**在 `main` 上打 tag（顺序：提交 → 打包 → 静态校验 → 打 tag → 推送）。
- **推送**：tag 不会随 `git push` 自动上传，需显式推送。

```bash
# 打包与校验通过后
git tag -a v0.6.11 3c1efdc -m "v0.6.11 发布：数据安全与额度安全专项 + 工作台增删改查修复 + 交互体验优化（包内 gitCommit=3c1efdc）"
git push origin v0.6.11

# 查看/比对
git show v0.6.11 --stat
git tag -l "v0.6.*" --sort=-v:refname
git checkout v0.6.11            # 需要复核历史版本时
```

---

## 四、当前版本执行记录

| 项 | 值 |
|---|---|
| 稳定分支 | `main` |
| 远端 main 当前提交 | `55aa63c`（v0.6.11 代码 + RELEASE.md + 测试与规划文档） |
| **v0.6.11 发布 tag** | **`v0.6.11`** |
| **tag 指向提交** | **`3c1efdc`**（该提交即发布包 `app/version.json` 中记录的 `gitCommit`） |
| 关联提交链 | `2b1459c`（v0.6.11 业务代码）→ `3c1efdc`（RELEASE.md，**打包所用提交**）→ `55aa63c`（测试用例/backlog/规划/发布文案） |
| 发布产物 | `_build-v0.6.11\澜川Dola管理器-v0.6.11-便携版.zip`（含逐文件 SHA256 清单） |
| 复核方式 | `git checkout v0.6.11` → `node tools/baseline-verify.cjs <包内 resources/app.asar> app` → 应仅 `version.json` 存在构建戳差异 |

> 说明：`3c1efdc` 之后的 `55aa63c` 等提交**只含文档**（未改动 `app/`），因此发布包与 tag 的字节一致性不受影响。

---

## 五、与打包/发布的关系

1. **顺序固定**：`提交 → 打包（tools/pack-app.cjs）→ 静态校验 → 打 tag → 推送 tag`。
2. `tools/pack-app.cjs` 会自动把 `buildAt / buildChannel / gitCommit` 写入**包内副本**的 `version.json`（源码文件保持干净），因此包内提交号 = 打包时的 HEAD。
3. 发布包解压名与压缩包名统一 `澜川Dola管理器-v<版本>-便携版`；压缩包必须使用 **UTF-8 + EFS** 方式写 zip（不要用 Windows `tar.exe` 直接产 zip，中文目录会乱码）。
4. 版本号唯一来源是 `app/version.json`：升版本时改 `version` + `notes`，并把上一版 `notes` 归档进 `history`。

---

*本规范为流程文件；v0.6.11 的代码与发布产物保持原样，未做任何改动。*