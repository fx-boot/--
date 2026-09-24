"use strict";
/**
 * 任务服务：把编排层、驱动层、下载与账号信息接到 IPC 上
 *
 * 账号来源沿用既有约定：读取 <userData>/accounts.json（account-proxy.js 已是同一做法），
 * 只读、不改写。会话分区按既有规则推导：persist:doubao-manager-<accountId>。
 *
 * 状态口径：可核实的只有「本工作台的任务数」与「账号异常信息」；
 * 平台额度与登录状态本层无法核实，一律返回 unknown，界面显示「未知」。
 */

const fs = require("node:fs");
const path = require("node:path");

const { createTaskStore, isActive } = require("./workbench-task-store");
const { createRunner, stepDetail } = require("./workbench-runner");
const { createDownloader } = require("./workbench-download");
const { createDolaDriver, PARTITION_PREFIX } = require("./workbench-dola-driver");
const { createMediaProbe } = require("./media-probe");
const { assignStoryboards } = require("./workbench-platform");
const { VIDEO_CAPABILITIES } = require("./video-capabilities");

const ACCOUNTS_FILE = "accounts.json";

// 账号读取的最近一次错误（诊断用，旧实现在 catch 里直接 return [] 把真实原因吞了，
// 界面只看到「没有可执行账号」，无法区分「真的没账号」还是「读文件失败/JSON 损坏」）。
let accountsReadError = Object.freeze({ message: "", at: "", dir: "" });

function readAccounts(userDataDir) {
  try {
    const file = path.join(userDataDir, ACCOUNTS_FILE);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
    accountsReadError = Object.freeze({ message: "", at: "", dir: "" });
    return list
      .filter((a) => a && typeof a.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(a.id))
      .map((a) => ({
        id: a.id,
        name: String(a.name || a.remark || a.id).slice(0, 120),
        platform: String(a.platform || ""),
        group: String(a.group || ""),
        remark: String(a.remark || ""),
        sessionPartition: `${PARTITION_PREFIX}${a.id}`,
      }));
  } catch (error) {
    accountsReadError = Object.freeze({
      message: error?.message || String(error),
      at: new Date().toISOString(),
      dir: String(userDataDir || ""),
    });
    return [];
  }
}

function createTaskService({ store, assets, resolveUserDataDir, log = () => {}, onChanged = () => {} }) {
  const taskStore = createTaskStore((projectId) => store.attachmentsDir(projectId));
  const capabilities = VIDEO_CAPABILITIES;

  async function resolveAssets(projectId, refs) {
    const map = new Map();
    const catalog = await assets.list(projectId);
    const byId = new Map(catalog.map((a) => [a.id, a]));
    const dir = store.assetsDir(projectId);
    for (const ref of refs || []) {
      const asset = byId.get(ref.assetId);
      if (!asset) continue;
      map.set(ref.assetId, {
        name: asset.name,
        filePath: path.join(dir, asset.fileName),
        sha256: asset.sha256,
        width: asset.width,
        height: asset.height,
      });
    }
    return map;
  }

  async function listProjectIds() {
    const index = await store.readIndex();
    return index.projects.map((p) => p.id);
  }

  const target = "dola";
  const driver = createDolaDriver({ log });
  const runner = createRunner({
    taskStore,
    driver,
    capabilities,
    target,
    resolveAssets,
    listProjectIds,
    onChanged,
    log,
    // 生成成功后的自动下载钩子：是否开始下载由项目设置决定（默认关），下载失败不回改生成状态
    onResultReady: async ({ projectId, attemptId }) => {
      const enabled = await autoDownloadEnabled(projectId);
      if (!enabled) return;
      await startDownload({ projectId, attemptId, auto: true });
    },
  });

  // 下载链路：会话来自账号分区（与既有高清原片下载同一套），来源分组复用 HD 观察器
  const { session } = require("electron");
  const hdService = require("./hd-original-service");
  const parser = require("./hd-candidates").createParser();
  const probe = createMediaProbe({ executable: path.join(process.resourcesPath, "media-tools/ffprobe.exe") });
  const downloader = createDownloader({
    taskStore,
    outputDirFor: async (projectId) => path.join(store.attachmentsDir(projectId), "downloads"),
    sessionFor: (accountId) => session.fromPartition(`${PARTITION_PREFIX}${accountId}`),
    groupsForAccount: (accountId) => hdService.groupsForAccount(accountId),
    scanAccount: (accountId) => hdService.scanAccount(accountId),
    probe,
    parser,
    onProgress: (payload) => pushDownloadProgress(payload),
  });

  /** 下载进度实时推送（界面用它显示速度/剩余时间；写库另有节流） */
  function pushDownloadProgress(payload) {
    for (const win of require("electron").BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send("workbench:download-progress", payload);
      } catch {}
    }
  }

  /** 项目设置里的「生成成功后自动下载」开关（默认关，不强制自动） */
  async function autoDownloadEnabled(projectId) {
    try {
      const project = await store.readProject(projectId);
      return project?.settings?.autoDownload === true;
    } catch {
      return false;
    }
  }

  /** 统一的下载入口：解析来源 → 下载（同源优先，可回退） → 校验 → 落盘 */
  async function startDownload({ projectId, attemptId, sourceId = "", resume = false, auto = false }) {
    const tasks = await taskStore.list(projectId);
    const record = tasks.find((t) => t.id === attemptId);
    if (!record) throw new Error("任务记录不存在");
    if (record.status !== "succeeded" || !record.result?.videoUrl) {
      throw new Error("只有生成成功且有结果地址的任务才能下载");
    }
    const project = await store.readProject(projectId);
    const boards = (project?.storyboards || []).map((s) => s.id);
    const storyboardIndex = Math.max(1, boards.indexOf(record.storyboardId) + 1);
    const account = readAccounts(resolveUserDataDir()).find((a) => a.id === record.accountId);
    return downloader.download({
      projectId,
      attemptId,
      projectName: project?.name || "项目",
      storyboardIndex,
      accountName: account?.name || "",
      sourceId,
      resume,
      // 自动下载时只认默认来源（同源优先），失败按同一套回退规则处理
      allowFallback: true,
      auto,
    });
  }

  async function accountStatus() {
    const accounts = readAccounts(resolveUserDataDir());
    const blocked = new Map(runner.status().blockedAccounts.map((b) => [b.accountId, b]));
    const counts = new Map();
    const index = await store.readIndex();
    for (const project of index.projects) {
      for (const task of await taskStore.list(project.id)) {
        if (!isActive(task.status)) continue;
        counts.set(task.accountId, (counts.get(task.accountId) || 0) + 1);
      }
    }
    const decorated = accounts.map((account) => ({
      ...account,
      activeTasks: counts.get(account.id) || 0,
      blocked: blocked.get(account.id) || null,
      // 本层无法核实平台额度与登录状态：明确返回未知，不编造
      quota: { known: false, label: "未知" },
      loginState: { known: false, label: "未知" },
    }));
    return {
      accounts: decorated,
      // 读取失败时必须带具体原因，界面据此显示错误与「重试」，而不是静默空白
      error: accountsReadError.message
        ? { message: accountsReadError.message, at: accountsReadError.at, dir: accountsReadError.dir }
        : null,
      loadedAt: new Date().toISOString(),
    };
  }

  async function accountView() {
    return (await accountStatus()).accounts;
  }

  async function tasksFor(projectId) {
    const tasks = await taskStore.list(projectId);
    // 新到旧排列，便于界面直接展示
    return tasks.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** 入队前先把「校验结果与限制」返回给界面，避免用户盲提交 */
  async function previewPlan(projectId, storyboardId, accountId) {
    const context = await planContext(projectId, storyboardId);
    const { plan, params, snapshotRefs } = context;
    return {
      accountId,
      params,
      // 快照用引用：带名称与内容哈希，入队时直接落库
      refs: snapshotRefs.map((ref) => ({
        assetId: ref.assetId,
        token: ref.token,
        name: ref.name,
        sha256: ref.sha256,
      })),
      valid: plan.valid,
      errors: plan.errors,
      warnings: plan.warnings,
      limitations: plan.limitations,
      uploads: plan.uploads,
      references: plan.references,
      durationMode: plan.params.durationMode,
      // 真正会写进平台编辑器的文本（@图N → 参考图N，不含占位符）
      promptPreview: plan.platformText,
    };
  }

  /**
   * 生成计划上下文：入队预览、提交前校验共用同一口径，避免两处漂移。
   * 只做本地计算（参数/引用/文件名），不接触平台。
   */
  async function planContext(projectId, storyboardId) {
    const { normalizeProject } = require("./workbench-store");
    const raw = await store.readProject(projectId);
    if (!raw) throw new Error("项目不存在");
    const project = normalizeProject(raw, raw.id);
    const storyboard = project.storyboards.find((s) => s.id === storyboardId);
    if (!storyboard) throw new Error("分镜不存在");
    const defaults = project.defaults || {};
    const params = {
      model: storyboard.overrides?.model || defaults.model,
      duration: storyboard.overrides?.duration || defaults.duration,
      ratio: storyboard.overrides?.ratio || defaults.ratio,
      removeWatermark: defaults.removeWatermark !== false,
      prompt: storyboard.prompt,
    };
    const { buildPlan } = require("./workbench-platform");
    const assetsById = await resolveAssets(projectId, storyboard.refs);
    const snapshotRefs = (storyboard.refs || []).map((ref) => ({
      assetId: ref.assetId,
      token: ref.token,
      name: assetsById.get(ref.assetId)?.name || "",
      sha256: assetsById.get(ref.assetId)?.sha256 || "",
      filePath: assetsById.get(ref.assetId)?.filePath || "",
    }));
    const plan = buildPlan({
      target,
      // attempt 形态与runner 执行时一致：storyboardId 供驱动层按「账号+分镜」记账附件
      attempt: { storyboardId, params, refs: snapshotRefs },
      assetsById,
      capabilities,
    });
    plan.storyboardId = storyboardId;
    return { project, storyboard, params, snapshotRefs, plan };
  }

  /**
   * 提交前校验：真实走一遍驱动（进入视频模式 → 写提示词 → 设参数 → 上传参考图 → 核实），
   * 在「点击发送」前停下；不消耗生成额度，也不落任务记录。
   */
  async function precheck(projectId, storyboardId, accountId) {
    const { plan } = await planContext(projectId, storyboardId);
    if (!plan.valid) {
      return {
        ok: false,
        accountId,
        outcome: "invalid",
        message: `参数/引用不满足提交条件：${plan.errors.join("；")}`,
        steps: [],
      };
    }
    const started = Date.now();
    let result;
    try {
      result = await driver.submit({ accountId, plan, dryRun: true });
    } catch (error) {
      return { ok: false, accountId, outcome: "failed", message: `提交前校验失败：${error?.message || error}`, steps: [] };
    }
    const steps = (result?.steps || []).map((s) => ({
      step: String(s?.step || ""),
      ok: s?.ok !== false,
      // 与任务卡片同一套摘要（复用/清理张数在这里也要看得到）
      detail: String(stepDetail(s)).slice(0, 200),
    }));
    return {
      ok: result?.outcome === "dry-run",
      accountId,
      outcome: String(result?.outcome || "unknown"),
      message: String(result?.message || "").slice(0, 500),
      evidence: result?.evidence || null,
      elapsedMs: Date.now() - started,
      steps,
    };
  }

  function handlers() {
    return {
      "workbench:accounts": () => accountView(),
      // 账号刷新：重新读取并带上错误原因（渲染层「刷新账号」按钮使用）
      "workbench:account-status": () => accountStatus(),

      "workbench:task-preview": (_e, projectId, storyboardId, accountId) =>
        previewPlan(projectId, storyboardId, accountId),

      /** 提交前校验：走到「发送前」为止（上传 + 核实），不点发送、不消耗额度、不落任务记录 */
      "workbench:task-precheck": (_e, projectId, storyboardId, accountId) =>
        precheck(projectId, storyboardId, accountId),

      /** 单条入队：参数与素材引用在此刻拍成快照，之后分镜再改也不影响本记录 */
      "workbench:task-enqueue": async (_e, projectId, storyboardId, accountId) => {
        const preview = await previewPlan(projectId, storyboardId, accountId);
        const { normalizeProject } = require("./workbench-store");
        const raw = await store.readProject(projectId);
        const project = normalizeProject(raw, raw.id);
        const storyboard = project.storyboards.find((s) => s.id === storyboardId);
        const record = await runner.enqueue({
          projectId,
          storyboardId,
          storyboardName: storyboard.name,
          accountId,
          params: preview.params,
          refs: preview.refs,
        });
        return { attempt: record, preview };
      },

      "workbench:tasks": (_e, projectId) => tasksFor(projectId),
      /** 分镜 × 账号的分配计划（纯逻辑，纯函数在 workbench-platform 里） */
      "workbench:task-assignments": (_e, storyboardIds, accountIds, mode) =>
        assignStoryboards({
          storyboardIds: Array.isArray(storyboardIds) ? storyboardIds : [],
          accountIds: Array.isArray(accountIds) ? accountIds : [],
          mode: String(mode || "distribute"),
        }),
      "workbench:task-execute": async (_e, projectId, attemptId) => {
        await runner.execute(projectId, attemptId);
        return { ok: true };
      },
      "workbench:task-cancel": (_e, projectId, attemptId) => runner.cancel(projectId, attemptId),
      "workbench:task-auto-retry-stop": (_e, projectId, attemptId) => runner.stopAutoRetry(projectId, attemptId),
      "workbench:task-retry": (_e, projectId, attemptId) => runner.retry(projectId, attemptId),
      "workbench:task-download": async (_e, projectId, attemptId, options = {}) => {
        return startDownload({
          projectId,
          attemptId,
          sourceId: String(options?.sourceId || ""),
          resume: options?.resume === true,
        });
      },
      /** 解析下载源（不下载）：澜川同源是否可用、不可用的原因、回退来源 */
      "workbench:task-sources": async (_e, projectId, attemptId, options = {}) => {
        const resolved = await downloader.resolveSources({ projectId, attemptId, refresh: options?.refresh !== false });
        const resumable = await downloader.resumable(projectId, attemptId);
        return { ...resolved, ...resumable, running: downloader.running.has(attemptId) };
      },
      /** 暂停下载（保留分片，可续传） */
      "workbench:task-download-pause": async (_e, projectId, attemptId) => downloader.pause(projectId, attemptId),
      /** 取消下载（删除分片） */
      "workbench:task-download-cancel": async (_e, projectId, attemptId) => downloader.cancel(projectId, attemptId),
      /** 打开文件所在目录 */
      "workbench:task-reveal": async (_e, projectId, attemptId) => {
        const tasks = await taskStore.list(projectId);
        const record = tasks.find((t) => t.id === attemptId);
        const filePath = record?.download?.filePath || record?.result?.filePath || "";
        if (!filePath) throw new Error("该任务还没有已下载的文件");
        if (!fs.existsSync(filePath)) throw new Error(`文件已不在原位置：${filePath}`);
        require("electron").shell.showItemInFolder(filePath);
        return { ok: true, filePath };
      },
      /** 用系统播放器打开本地文件（本地预览） */
      "workbench:task-open-file": async (_e, projectId, attemptId) => {
        const tasks = await taskStore.list(projectId);
        const record = tasks.find((t) => t.id === attemptId);
        const filePath = record?.download?.filePath || record?.result?.filePath || "";
        if (!filePath) throw new Error("该任务还没有已下载的文件");
        if (!fs.existsSync(filePath)) throw new Error(`文件已不在原位置：${filePath}`);
        const error = await require("electron").shell.openPath(filePath);
        if (error) throw new Error(`无法打开文件：${error}`);
        return { ok: true, filePath };
      },
      /** 项目设置：生成成功后是否自动下载（默认关） */
      "workbench:auto-download": async (_e, projectId, enabled) => {
        const raw = await store.readProject(projectId);
        if (!raw) throw new Error("项目不存在");
        const saved = await store.saveProject({
          ...raw,
          settings: { ...(raw.settings || {}), autoDownload: enabled === true },
        });
        onChanged();
        return { ok: true, enabled: saved.settings?.autoDownload === true };
      },
      "workbench:queue-status": () => runner.status(),
      /** 交给队列按并发上限调度（多账号并行生成走这里，避免逐个 await 串行执行） */
      "workbench:queue-run": async () => {
        const result = await runner.tick();
        return { ok: true, started: result?.started || [] };
      },
      "workbench:queue-pause": () => runner.pause(),
      "workbench:queue-resume": () => runner.resume(),
      "workbench:account-clear-block": (_e, accountId) => runner.clearAccountBlock(String(accountId)),
    };
  }

  return {
    handlers: handlers(),
    runner,
    driver,
    taskStore,
    accountView,
    accountStatus,
    dispose: () => {
      try {
        driver.dispose();
      } catch {}
    },
    recover: () => runner.recover(),
    status: () => runner.status(),
    tasksFor,
    previewPlan,
  };
}

module.exports = { ACCOUNTS_FILE, createTaskService, readAccounts };