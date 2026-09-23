# 豆包分镜工作台

在现有「豆包管理器 V2.0」基础上，增量开发**视频分镜批量生成工作台**：
上传参考图片 → 编写分镜提示词 → `@图片` 绑定 → 选择模型/时长/比例 → 选择执行账号 → 批量生成 → 查看真实状态 → 预览与下载结果。

本仓库是**独立开发副本**，不修改安装版，不复用其运行目录。

---

## 1. 最重要的前提：核心源码不可维护

发布版本的主进程与界面核心是**混淆后编译的**，没有可读源码：

| 文件 | 形态 | 可否修改 |
|---|---|---|
| `app/src/main.jsc` | V8 字节码（536KB，内含 `_0xdbmm_*` 混淆） | **禁止** |
| `app/renderer/app.js` | 混淆 JS（594KB） | **禁止** |

`app/src/main.js`（加载器）、`app/src/preload.js`、`app/renderer/index.html`、`app/renderer/styles.css` 以及团队历次新增的 `src/*.js` / `renderer/*.js` 都是**可读可改**的。

因此本项目**不做整包重建**，而是沿用团队既有的**增量挂接**方式扩展功能。

### 扩展配方（新功能一律照此办理）

1. 在 `app/src/` 新增独立模块（例如 `workbench-service.js`）；
2. 在 `app/src/main.js` 里 `require("./xxx").install()` —— 必须在 `require(main.jsc)` **之前**挂接；
3. 在 `app/src/preload.js` 用 `contextBridge.exposeInMainWorld` 暴露 API；
4. 在 `app/renderer/` 新增独立 JS/CSS，并在 `app/renderer/index.html` 末尾追加 `<script>` / `<link>`；
5. 用 `tools/pack-app.cjs` 打包。

需要「账号 + 独立登录会话」时：用既有 IPC `managerAPI.accounts.list()` 取得 `id` 与 `sessionPartition`，再用同一分区（`persist:doubao-manager-<accountId>`）创建 webview/BrowserWindow，通过 `webContents.debugger` 驱动平台页面。不要试图调用 main.jsc 内部函数。

---

## 2. 基线

基线 = `工具\_doubao-mgr-v2`，判定依据是**与已发布安装包的 `resources/app.asar` 逐文件 sha256 一致（184/184）**，不是目录名或时间戳。

复核命令：

```powershell
$node = "C:\Users\Administrator\Desktop\工具\runtime\resources\c\runtime\node.exe"
& $node tools/baseline-verify.cjs `
    "C:\Users\Administrator\Desktop\工具\豆包管理器-V2.0-完整便携版(1)\豆包管理器-V2.0-完整便携版\resources\app.asar" `
    ".\app"
```

预期输出：`一致=184 不一致=0 源树多出=0 解包缺失=0` → `结论：基线完全一致。`

`app/` 相对厂商原始包（`_豆包开发\original-app.asar`）多出的 20 个文件，即团队历次新增的高清原片、视频日志、代理池等功能。

---

## 3. 目录结构

```
豆包分镜工作台/
├─ app/                        基线源树（打包输入）
│  ├─ src/                     主进程模块（main.jsc 不可改；其余可读可改）
│  ├─ renderer/                界面（app.js 不可改；其余可读可改）
│  ├─ assets/license-public.pem
│  ├─ node_modules/            不入库，见第 6 节
│  ├─ package.json
│  └─ protection-manifest.json
├─ tools/
│  ├─ baseline-verify.cjs      基线一致性校验
│  ├─ pack-app.cjs             打包 app/ → resources/app.asar（含结构自检）
│  ├─ boot-probe.cjs           隔离启动探针（验收入口）
│  └─ run-dev.cjs              启动 dev 运行时（隔离数据目录）
├─ docs/                       审计与阶段文档
└─ runtime/                    不入库：Electron 运行时副本与 dev 数据
```

`app/src/main.jsc` 与 `app/src/runtime-resolver.bin` **必须入库**：它们无法重新生成，缺失即无法打包出可运行产物。

---

## 4. 构建与校验

本机 Node 未在 PATH 中，使用随包运行时：
`C:\Users\Administrator\Desktop\工具\runtime\resources\c\runtime\node.exe`（v24.16.0）

### 打包

```powershell
& $node tools\pack-app.cjs                                  # 普通打包
& $node tools\pack-app.cjs --entry-file tools\boot-probe.cjs # 注入外部入口（验收/探针）
& $node tools\pack-app.cjs --patch-exe                      # 额外回写 exe 完整性标记（默认不需要）
```

`pack-app.cjs` 会在落盘**之前**做结构自检：把生成的 asar 重新解析，逐条目与源字节比对；不一致直接失败，不产出坏包。

> 该自检是为一个真实缺陷加的：早期版本先用文件原始大小分配 asar 偏移，之后才改写 `package.json` 的 `main`，导致其后 53 个文件偏移错位、内容被读串。详见 `docs/阶段0-工程审计与影响核查.md` 第 6 节。

### exe 完整性标记（已实测，勿重复推导）

exe 中的标记值 = `sha256(asar 的原始 JSON 头部字节 [16, 16+jsonLength))`。已发布包中该值指向**改动前**的 `app.asar.orig`，而实际运行使用的是被替换过的 `app.asar` —— 说明**该完整性保险丝未启用**，重打包无需改 exe。

### 打包安全性

`pack-app.cjs` 拒绝写入路径中含「完整便携版」或「安装版」的目录，防止覆盖可用作回滚的安装包。

---

## 5. 运行与隔离（强制）

> **在确认隔离有效之前，不要启动任何程序。**

必须同时满足：

1. 独立程序目录：`runtime/dev`（从安装版**复制**，不写安装版）；
2. 独立 `resources/app.asar`：由 `pack-app.cjs` 生成；
3. **独立 userData**：`--user-data-dir` 对本体**无效**（`main.jsc` 会自行 `app.setPath`），必须由入口探针拦截 `app.setPath` 覆盖 `userData` / `sessionData` / `appData`，并记录每一次被请求的目标路径以供事后证明；
4. 独立浏览器会话与缓存：随 userData 隔离；
5. 启动前后对正式版 userData 做快照比对，证明零写入；
6. **单实例锁**：运行测试前需**用户主动退出正式版**（测试实例否则会被转发并立即退出，无法验证）。不要代为关闭正式版。

`tools/boot-probe.cjs` 即上述第 3 条的实现；`tools/run-dev.cjs` 提供带隔离数据目录的启动方式，并默认校验正式版 userData 未被改动。

**硬约束**：不要按进程名批量结束进程；只结束命令行中明确含本副本路径的进程。

---

## 6. 已知缺口

- `app/node_modules/` 未入库（约 79MB）。它可由发布包 `app.asar` 内的同名目录还原，但**还原脚本尚未编写**，新克隆暂时无法直接打包。→ 待补工具项。

---

## 7. 数据备份

Git 只适合版本化**代码与配置**，不能替代项目数据备份。以下内容不入库，需另行备份：

- 项目素材（上传的参考图片）
- 生成结果视频
- 工作台项目数据库/草稿文件

建议直接对工作台的项目数据目录做定期整体拷贝或压缩归档。

---

## 8. 提交约定

- 每完成一个**可运行且已验证**的阶段，提交一次；
- 稳定版本打标签；
- **不强制推送、不覆盖已有历史**；
- 提交前检查差异与敏感信息（账号数据、Cookie、Token、密钥、素材、成片一律不得入库）。