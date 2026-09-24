"use strict";
/**
 * 工作台服务（主进程）
 *
 * 由 src/main.js 在加载 main.jsc 之前 install()，与既有模块（account-proxy / video-log）同一挂接方式。
 * 只做三件事：聚合调用方、注册 IPC、把变更广播给管理窗口。
 *
 * 阶段 1 范围：项目 / 分镜 / 素材 / @图片引用 / 草稿自动保存与重启恢复。
 * 任务提交与状态监听在阶段 2 接入，本文件已预留 taskSnapshot 的落点但不伪造任何状态。
 */

const { app, ipcMain, BrowserWindow, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");

const {
  assignTokens,
  createStore,
  newId,
  normalizeDefaults,
  normalizeProject,
  normalizeStoryboard,
  splitPrompts,
  syncRefsFromPrompt,
} = require("./workbench-store");
const { createAssets, MAX_BYTES } = require("./workbench-assets");
const { createTaskService } = require("./workbench-task-service");
const { DOWNLOAD_LABEL, STATUS_LABEL } = require("./workbench-task-store");
const { VIDEO_CAPABILITIES } = require("./video-capabilities");

// 版本信息：源码内置 app/version.json；打包 app.asar 时 pack-app.cjs 会在包内副本上
// 追加 buildAt / buildChannel / gitCommit（源码文件保持干净），require 直接拿到嵌入结果。
const VERSION_INFO = require("../version.json");
function appVersion() {
  return {
    version: String(VERSION_INFO.version || "0.0.0"),
    display: `v${String(VERSION_INFO.version || "0.0.0")}`,
    channel: String(VERSION_INFO.channel || "dev"),
    releasedAt: String(VERSION_INFO.releasedAt || ""),
    notes: Array.isArray(VERSION_INFO.notes) ? VERSION_INFO.notes : [],
    history: Array.isArray(VERSION_INFO.history) ? VERSION_INFO.history : [],
    buildAt: VERSION_INFO.buildAt ? String(VERSION_INFO.buildAt) : "",
    buildChannel: VERSION_INFO.buildChannel ? String(VERSION_INFO.buildChannel) : "",
    gitCommit: VERSION_INFO.gitCommit ? String(VERSION_INFO.gitCommit) : "",
  };
}
const { describeCapabilities, ratioOptionsFor } = require("./workbench-platform");

const CHANGED = "workbench:changed";
const PROJECT_DIR_NAME = "workbench";
// 核心启动后使用的数据目录名（<appData>/DoubaoAccountManager）。
// 根因：本服务在 main.js 中先于核心字节码 install，ready 回调也注册得更早，
// 首次取 app.getPath("userData") 时核心还没改路径，拿到的是 Electron 默认的
// %APPDATA%\doubao-account-manager；store/任务服务把该路径缓存后，账号就读空了。
const CORE_DIR_NAME = "DoubaoAccountManager";
const managerUrl = pathToFileURL(path.join(__dirname, "../renderer/index.html")).href;

const state = {
  installed: false,
  registered: false,
  store: null,
  assets: null,
  tasks: null,
  // tasks 服务创建时绑定的 store，store 因路径修正被重建时需要同步重建 tasks
  tasksStore: null,
  projectId: "",
  notifyTimer: null,
  lastError: "",
};

/**
 * 解析「应用真实数据目录」（accounts.json 所在目录）。
 * 不静态缓存：核心 setPath 可能发生在本服务首次读取之后，每次调用都重新取。
 */
function realUserDataDir() {
  if (process.env.DBM_DATA_DIR) return path.resolve(process.env.DBM_DATA_DIR);
  const current = app.getPath("userData");
  // 核心规则：<appData>/DoubaoAccountManager。
  // 隔离环境下 supervised-entry 已把 appData 重定向到隔离根，这里算出的就是隔离目录。
  const coreDir = path.join(app.getPath("appData"), CORE_DIR_NAME);
  if (coreDir !== current && fs.existsSync(path.join(coreDir, "accounts.json"))) return coreDir;
  return current;
}

function dataRoot() {
  return path.join(realUserDataDir(), PROJECT_DIR_NAME);
}

function store() {
  // 路径在核心 setPath 前后可能变化：root 变了就重建，避免一直用早期缓存的默认目录
  const root = dataRoot();
  if (!state.store || state.store.rootDir !== root) state.store = createStore(root);
  return state.store;
}

function assets() {
  const svcStore = store();
  if (!state.assets || state.assetsStore !== svcStore) {
    state.assets = createAssets(svcStore);
    state.assetsStore = svcStore;
  }
  return state.assets;
}

/** 任务服务懒加载：涉及 session/分区，等 app ready 后再建更稳妥 */
function tasks() {
  const svcStore = store();
  if (state.tasks && state.tasksStore !== svcStore) {
    try {
      state.tasks.dispose();
    } catch {}
    state.tasks = null;
  }
  if (!state.tasks) {
    state.tasksStore = svcStore;
    state.tasks = createTaskService({
      store: svcStore,
      assets: assets(),
      // 传解析函数而非固定值：核心改路径后无需重建也能读到正确目录
      resolveUserDataDir: realUserDataDir,
      log: (kind, payload) => {
        if (process.env.DBM_WORKBENCH_DEBUG === "1") {
          process.stderr.write(`[workbench] ${kind} ${JSON.stringify(payload || {})}\n`);
        }
      },
      onChanged: notify,
    });
  }
  return state.tasks;
}

function storageStatus() {
  const root = dataRoot();
  let ok = true;
  let message = "";
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
  } catch (error) {
    ok = false;
    message = `数据目录不可写：${error.message}`;
  }
  return { root, ok, message: state.lastError || message };
}

function notify() {
  if (state.notifyTimer) return;
  state.notifyTimer = setTimeout(() => {
    state.notifyTimer = null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.getURL() === managerUrl) {
        win.webContents.send(CHANGED);
      }
    }
  }, 150);
}

function isManagerSender(event) {
  try {
    const url = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
    return url === managerUrl || String(url).endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}

function assertSender(event) {
  if (!isManagerSender(event)) throw new Error("该接口仅对管理窗口开放");
}

const text = (value, max = 0) => {
  const out = String(value ?? "");
  return max > 0 ? out.slice(0, max) : out;
};

async function requireProject(projectId) {
  const id = text(projectId) || state.projectId;
  if (!id) throw new Error("尚未选择项目");
  const project = await store().readProject(id);
  if (!project) throw new Error("项目不存在或已损坏");
  state.projectId = project.id;
  return project;
}

async function save(project) {
  const saved = await store().saveProject(project);
  notify();
  return saved;
}

/** 参考图引用：命中「文本里出现 @图N」的位置与顺序，重建引用表 */
function reconcileRefs(storyboard) {
  const { refs, dropped } = syncRefsFromPrompt(storyboard.prompt, storyboard.refs || []);
  storyboard.refs = refs;
  return dropped;
}

/** 影响范围：某素材被哪些分镜以哪个 token 引用 */
function usagesOf(project, assetIds) {
  const ids = new Set(assetIds || []);
  const result = {};
  for (const id of ids) result[id] = [];
  for (const storyboard of project.storyboards || []) {
    for (const ref of storyboard.refs || []) {
      if (!ids.has(ref.assetId)) continue;
      result[ref.assetId].push({
        storyboardId: storyboard.id,
        name: storyboard.name || "",
        token: ref.token,
      });
    }
  }
  return result;
}

/** 批量粘贴的拆分逻辑已下沉到 workbench-store（纯函数，可脱离 Electron 验证） */

async function snapshot() {
  const index = await store().readIndex();
  let project = null;
  if (index.currentProjectId) {
    const raw = await store().readProject(index.currentProjectId);
    if (raw) {
      project = normalizeProject(raw, raw.id);
      state.projectId = project.id;
    }
  }
  const assetList = project ? await assets().list(project.id) : [];
  const taskList = project ? await tasks().tasksFor(project.id) : [];
  const accountData = await tasks().accountStatus();
  return {
    storage: storageStatus(),
    index,
    project,
    assets: assetList,
    capabilities: VIDEO_CAPABILITIES,
    // 版本信息随快照下发：界面固定展示版本号，更新日志弹窗读取同一份数据
    appVersion: appVersion(),
    // 能力视图：模型菜单文案、实测时间、哪些项仍未核实，界面直接用它渲染，避免前端自己判断
    capabilityView: describeCapabilities(VIDEO_CAPABILITIES, "dola"),
    // 比例候选：来自实测的 platform.ratios，不再是「常见值」
    ratioOptions: ratioOptionsFor(VIDEO_CAPABILITIES, "dola"),
    limits: { maxAssetBytes: MAX_BYTES },
    accounts: accountData.accounts,
    accountsError: accountData.error,
    tasks: taskList,
    queue: tasks().status(),
    // 状态文案由主进程单一来源提供，避免前后端各写一份
    statusLabels: STATUS_LABEL,
    downloadLabels: DOWNLOAD_LABEL,
  };
}

async function addStoryboard(project, options = {}) {
  const list = project.storyboards;
  const at = options.afterId ? list.findIndex((s) => s.id === options.afterId) + 1 : list.length;
  const storyboard = normalizeStoryboard(
    { name: `分镜 ${list.length + 1}`, prompt: "" },
    at
  );
  list.splice(at, 0, storyboard);
  list.forEach((s, i) => {
    s.order = i;
  });
  return storyboard;
}

async function bindAsset(project, storyboardId, assetId, options = {}) {
  const storyboard = project.storyboards.find((s) => s.id === storyboardId);
  if (!storyboard) throw new Error("分镜不存在");
  const asset = await assets().findAsset(project.id, assetId);
  if (!asset) throw new Error("素材不存在");
  if ((storyboard.refs || []).some((r) => r.assetId === assetId)) {
    return { storyboard, added: false };
  }
  const token = assignTokens(storyboard.refs || [])();
  // token 插入到调用方给定的光标位置（缺省为末尾），保证文本与引用顺序一致
  const base = typeof options.prompt === "string" ? options.prompt : String(storyboard.prompt || "");
  const caret = Number.isInteger(options.caret)
    ? Math.max(0, Math.min(options.caret, base.length))
    : base.length;
  const lead = caret > 0 && !/\s/.test(base[caret - 1]) ? " " : "";
  const insert = `${lead}${token}`;
  storyboard.prompt = base.slice(0, caret) + insert + base.slice(caret);
  storyboard.refs = [...(storyboard.refs || []), { assetId, token }];
  reconcileRefs(storyboard);
  storyboard.updatedAt = new Date().toISOString();
  return { storyboard, added: true, token, caret: caret + insert.length };
}

function unbindAsset(project, storyboardId, assetId) {
  const storyboard = project.storyboards.find((s) => s.id === storyboardId);
  if (!storyboard) throw new Error("分镜不存在");
  const ref = (storyboard.refs || []).find((r) => r.assetId === assetId);
  if (!ref) return { storyboard, removed: false };
  // 同步从文本里移除 token，避免留下悬空标记
  storyboard.prompt = String(storyboard.prompt || "")
    .replace(new RegExp(`${ref.token}\\s?`, "g"), "")
    .replace(/\s+$/g, "");
  storyboard.refs = (storyboard.refs || []).filter((r) => r.assetId !== assetId);
  storyboard.updatedAt = new Date().toISOString();
  return { storyboard, removed: true };
}

function baseHandlers() {
  return {
    "workbench:snapshot": () => snapshot(),
    // 轻量版本通道：主窗口左下角固定展示版本号用，避免为此拉取整份 snapshot
    "workbench:version-info": () => appVersion(),

    // ── 项目 ───────────────────────────────────────────────
    "workbench:project-create": async (_e, name) => {
      const { index } = await store().createProject(text(name, 120));
      state.projectId = index.currentProjectId;
      notify();
      return { projectId: state.projectId };
    },
    "workbench:project-open": async (_e, projectId) => {
      const project = await store().openProject(projectId);
      state.projectId = project.id;
      notify();
      return { projectId: project.id };
    },
    "workbench:project-rename": async (_e, projectId, name) => {
      await store().renameProject(projectId, name);
      notify();
      return { ok: true };
    },
    "workbench:project-delete": async (_e, projectId) => {
      const index = await store().deleteProject(projectId);
      if (state.projectId === projectId) state.projectId = index.currentProjectId || "";
      notify();
      return { currentProjectId: state.projectId };
    },
    "workbench:project-defaults": async (_e, projectId, defaults) => {
      const project = await requireProject(projectId);
      project.defaults = normalizeDefaults({ ...project.defaults, ...(defaults || {}) });
      return save(project);
    },

    // ── 分镜 ───────────────────────────────────────────────
    "workbench:storyboard-add": async (_e, projectId, options) => {
      const project = await requireProject(projectId);
      const storyboard = await addStoryboard(project, options || {});
      await save(project);
      return { storyboard };
    },
    "workbench:storyboard-update": async (_e, projectId, storyboardId, patch = {}) => {
      const project = await requireProject(projectId);
      const storyboard = project.storyboards.find((s) => s.id === storyboardId);
      if (!storyboard) throw new Error("分镜不存在");
      if (patch.name !== undefined) storyboard.name = text(patch.name, 120);
      if (patch.prompt !== undefined) storyboard.prompt = text(patch.prompt);
      if (patch.overrides !== undefined) {
        storyboard.overrides = { ...storyboard.overrides, ...(patch.overrides || {}) };
      }
      if (patch.settings !== undefined) {
        storyboard.settings = { ...storyboard.settings, ...(patch.settings || {}) };
      }
      const dropped = reconcileRefs(storyboard);
      storyboard.updatedAt = new Date().toISOString();
      await save(project);
      return { storyboard, droppedTokens: dropped };
    },
    "workbench:storyboard-duplicate": async (_e, projectId, storyboardId) => {
      const project = await requireProject(projectId);
      const at = project.storyboards.findIndex((s) => s.id === storyboardId);
      if (at < 0) throw new Error("分镜不存在");
      const source = project.storyboards[at];
      const copy = normalizeStoryboard(
        {
          ...JSON.parse(JSON.stringify(source)),
          id: newId("sb"),
          name: `${source.name || "分镜"} 副本`,
          updatedAt: new Date().toISOString(),
        },
        at + 1
      );
      project.storyboards.splice(at + 1, 0, copy);
      project.storyboards.forEach((s, i) => {
        s.order = i;
      });
      await save(project);
      return { storyboard: copy };
    },
    "workbench:storyboard-delete": async (_e, projectId, storyboardId) => {
      const project = await requireProject(projectId);
      project.storyboards = project.storyboards.filter((s) => s.id !== storyboardId);
      project.storyboards.forEach((s, i) => {
        s.order = i;
      });
      await save(project);
      return { ok: true };
    },
    "workbench:storyboard-reorder": async (_e, projectId, orderedIds) => {
      const project = await requireProject(projectId);
      const byId = new Map(project.storyboards.map((s) => [s.id, s]));
      const ordered = [];
      for (const id of orderedIds || []) {
        const item = byId.get(text(id));
        if (item && !ordered.includes(item)) ordered.push(item);
      }
      for (const item of project.storyboards) if (!ordered.includes(item)) ordered.push(item);
      ordered.forEach((s, i) => {
        s.order = i;
      });
      project.storyboards = ordered;
      await save(project);
      return { order: project.storyboards.map((s) => s.id) };
    },
    "workbench:storyboard-bind": async (_e, projectId, storyboardId, assetId, options) => {
      const project = await requireProject(projectId);
      const result = await bindAsset(project, storyboardId, assetId, options || {});
      await save(project);
      return result;
    },
    "workbench:storyboard-unbind": async (_e, projectId, storyboardId, assetId) => {
      const project = await requireProject(projectId);
      const result = unbindAsset(project, storyboardId, assetId);
      await save(project);
      return result;
    },

    // ── 批量粘贴 ───────────────────────────────────────────
    "workbench:prompt-split": (_e, rawText, mode) => splitPrompts(rawText, mode),
    "workbench:prompt-import": async (_e, projectId, items, mode) => {
      const project = await requireProject(projectId);
      const list = Array.isArray(items) && items.length ? items : splitPrompts(items, mode).items;
      const created = [];
      for (const item of list) {
        const storyboard = await addStoryboard(project, {});
        storyboard.name = text(item?.name, 120) || storyboard.name;
        storyboard.prompt = text(item?.prompt);
        created.push(storyboard);
      }
      await save(project);
      return { created: created.length, ids: created.map((s) => s.id) };
    },

    // ── 素材 ───────────────────────────────────────────────
    "workbench:asset-import-dialog": async (event) => {
      const project = await requireProject();
      const win = BrowserWindow.fromWebContents(event.sender);
      const picked = await dialog.showOpenDialog(win, {
        title: "选择参考图片",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true, imported: [], reused: [], failed: [] };
      return { canceled: false, ...(await assets().importPaths(project.id, picked.filePaths)) };
    },
    "workbench:asset-import-paths": async (_e, projectId, filePaths) => {
      const project = await requireProject(projectId);
      return assets().importPaths(project.id, filePaths);
    },
    /** 粘贴导入：渲染层拿不到剪贴板图片的路径，改传 base64 */
    "workbench:asset-import-buffers": async (_e, projectId, items) => {
      const project = await requireProject(projectId);
      return assets().importBuffers(project.id, Array.isArray(items) ? items : []);
    },
    "workbench:asset-list": async (_e, projectId, options) => {
      const project = await requireProject(projectId);
      return assets().list(project.id, options || {});
    },
    "workbench:asset-rename": async (_e, projectId, assetId, name) => {
      const project = await requireProject(projectId);
      const asset = await assets().rename(project.id, assetId, name);
      notify();
      return asset;
    },
    "workbench:asset-thumb": async (_e, projectId, assetId) => {
      const project = await requireProject(projectId);
      return assets().thumbDataUrl(project.id, assetId);
    },
    "workbench:asset-preview": async (_e, projectId, assetId) => {
      const project = await requireProject(projectId);
      return assets().previewDataUrl(project.id, assetId);
    },
    "workbench:asset-usages": async (_e, projectId, assetIds) => {
      const project = await requireProject(projectId);
      return usagesOf(project, assetIds);
    },
    /**
     * 删除素材。若仍被分镜引用：
     * - resolution 未给出或为 "abort" 时只返回影响范围，不做任何修改；
     * - resolution 为 "unbind" 时才连带解除引用（并同步移除提示词里的 token）。
     */
    "workbench:asset-delete": async (_e, projectId, assetIds, resolution) => {
      const project = await requireProject(projectId);
      const usages = usagesOf(project, assetIds);
      const referenced = Object.entries(usages).filter(([, list]) => list.length);
      if (referenced.length && resolution !== "unbind") {
        return { blocked: true, usages };
      }
      let unbound = 0;
      if (referenced.length) {
        for (const storyboard of project.storyboards) {
          for (const [assetId] of referenced) {
            if (unbindAsset(project, storyboard.id, assetId).removed) unbound++;
          }
        }
        await save(project);
      }
      const removed = await assets().remove(project.id, assetIds);
      notify();
      return { blocked: false, removed, unbound, usages };
    },

    // ── 界面状态（重启恢复上下文用） ────────────────────────
    "workbench:ui-state": async (_e, projectId, patch) => {
      const project = await requireProject(projectId);
      project.ui = { ...project.ui, ...(patch || {}) };
      return save(project);
    },
  };
}

/** 基础通道 + 任务通道（账号 / 入队 / 执行 / 取消 / 重试 / 下载 / 队列） */
function handlers() {
  return { ...baseHandlers(), ...tasks().handlers };
}

function registerIpc() {
  if (state.registered) return;
  state.registered = true;
  for (const [channel, handler] of Object.entries(handlers())) {
    try {
      ipcMain.removeHandler(channel);
    } catch {}
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        assertSender(event);
        const result = await handler(event, ...args);
        // 成功即清空上次错误，避免存储状态被历史错误长期污染
        state.lastError = "";
        return result;
      } catch (error) {
        state.lastError = error?.message || String(error);
        notify();
        throw new Error(state.lastError);
      }
    });
  }
}

function install() {
  if (state.installed) return;
  state.installed = true;
  registerIpc();
  app.whenReady().then(async () => {
    try {
      store().ensure();
      const index = await store().readIndex();
      state.projectId = index.currentProjectId || "";
      // 已有项目时预热一次，尽早暴露目录权限等问题
      if (state.projectId) await store().readProject(state.projectId);
      // 重启后恢复任务追踪：活跃记录重新纳入轮询，长时间无更新则标记监控异常
      await tasks().recover();
      notify();
    } catch (error) {
      state.lastError = error?.message || String(error);
      notify();
    }
  });
  app.once("will-quit", () => {
    try {
      state.tasks?.dispose();
    } catch {}
  });
}

module.exports = {
  CHANGED,
  install,
  splitPrompts,
  storageStatus,
  usagesOf,
};