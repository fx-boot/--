"use strict";
/**
 * Dola 页面驱动层（Electron 依赖，无法离线验证）
 *
 * ⚠ 验证状态：本文件的传输步骤（真实页面交互）**尚未经过实机验证**。
 *   选择器与手法来自本项目内既有可读模块的实测代码：
 *     - src/webview-preload.js：编辑器选择器、\uFFFC 原子节点、TEXTAREA 原生 setter、
 *       contenteditable 走 execCommand('insertText')、菜单选择器 MENU_SELECTOR、
 *       工具栏控件 data-input-engine-actionbar-control-key
 *     - src/video-log-data.js：从响应中提取 task_id/video_id/status 的字段名
 *   但「真实点击发送、真实取回平台任务 ID、真实判定完成」必须通过一次单任务实机运行确认。
 *
 * 因此每个步骤都返回结构化结果；失败时把页面上实际可见的选项一并回报，
 * 便于首次实机运行时快速校准，而不是靠猜。
 *
 * 设计约束：
 * - 页面复用账号已有的登录会话（persist:doubao-manager-<accountId>），不新建登录。
 * - 拿不到平台任务 ID 时返回 outcome:"unknown"，由编排层标记「提交结果待确认」，
 *   绝不在本层重复提交。
 * - 不做任何进度百分比的编造：页面没有明确信号时返回 unknown。
 */

const { session, webContents, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DOLA_SELECTORS } = require("./workbench-platform");

const CREATE_URL = "https://www.dola.com/";
const PARTITION_PREFIX = "persist:doubao-manager-";
const SEND_TIMEOUT_MS = 90 * 1000;
const RESULT_TIMEOUT_MS = 20 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 页面内注入脚本：只做与既有模块同款的 DOM 操作 */
function pageScript(source) {
  return `(async () => { ${source} })()`;
}

const HELPERS = `
  const SEL = ${JSON.stringify({
    editor: DOLA_SELECTORS.editor,
    model: DOLA_SELECTORS.modelControl,
    duration: DOLA_SELECTORS.durationControl,
    actionbar: DOLA_SELECTORS.actionbar,
    fileInput: DOLA_SELECTORS.fileInput,
  })};
  const visible = (el) => {
    try {
      const r = el?.getBoundingClientRect?.();
      const s = el && getComputedStyle(el);
      return Boolean(el?.isConnected && r?.width > 1 && r?.height > 1 && s?.display !== 'none' && s?.visibility !== 'hidden');
    } catch { return false; }
  };
  const textOf = (el) => String(el?.textContent || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '').replace(/\\s+/g, ' ').trim();
  const editors = () => [...document.querySelectorAll(SEL.editor)].filter(e => visible(e) && !e.disabled && !e.readOnly);
`;

async function evaluate(contents, source) {
  return contents.executeJavaScript(pageScript(`${HELPERS}\n${source}`), true);
}

/** 点击某个控件并从中选择匹配项；失败时回报实际可见选项 */
const STEP_CHOOSE = `
  const controlSelector = __SELECTOR__;
  const wanted = __WANTED__;
  const control = document.querySelector(controlSelector);
  if (!control) return { ok: false, reason: '页面上找不到该控件', available: [] };
  control.click();
  await new Promise(r => setTimeout(r, 600));
  const menus = [...document.querySelectorAll('[role="menu"],[role="listbox"],[data-slot*="dropdown-menu"],[class*="popover"],[class*="dropdown"]')].filter(visible);
  const options = menus.flatMap(m => [...m.querySelectorAll('[role="menuitem"],[role="option"],li,button,div')]).filter(visible);
  const labels = [...new Set(options.map(textOf).filter(Boolean))].slice(0, 40);
  const norm = (s) => s.toLowerCase().replace(/[\\s_\\-]/g, '');
  const target = options.find(o => norm(textOf(o)).includes(norm(wanted)));
  if (!target) return { ok: false, reason: '菜单里没有匹配项', wanted, available: labels };
  target.click();
  await new Promise(r => setTimeout(r, 400));
  return { ok: true, picked: textOf(target), available: labels };
`;

const STEP_SET_TEXT = `
  const list = editors();
  if (!list.length) return { ok: false, reason: '找不到提示词输入框' };
  const editor = list[0];
  const value = __VALUE__;
  editor.focus();
  if (editor.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(editor, value);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  } else {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete');
    if (!document.execCommand('insertText', false, value)) return { ok: false, reason: '输入框拒绝写入文本' };
  }
  await new Promise(r => setTimeout(r, 200));
  const readback = editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText;
  return { ok: readback.includes(value.slice(0, Math.min(12, value.length))), readback: String(readback).slice(0, 200) };
`;

const STEP_READ_STATE = `
  const body = document.body ? document.body.innerText : '';
  return { ok: true, text: String(body).replace(/\\s+/g, ' ').slice(0, 800), url: location.href };
`;

/** 从响应体中收集任务类 ID：只认既有模块已确认的字段名，不猜 */
function collectIds(value, out = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 8 || out.length > 12) return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 60)) collectIds(item, out, depth + 1);
    return out;
  }
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/^(task_id|creation_task_id|generation_task_id|job_id|video_id|vid)$/.test(key)) {
      const id = String(item ?? "");
      if (id && id.length <= 120) out.push(id);
    } else if (item && typeof item === "object") {
      collectIds(item, out, depth + 1);
    }
  }
  return out;
}

/** 单个步骤：把计划里的文本与图片依次写入编辑器 */
function createDolaDriver(options = {}) {
  const resolveContents = options.resolveContents;
  const log = options.log || (() => {});
  const modelLabel = options.modelLabel || ((model) =>
    ({ "seedance2.5": "2.5", "seedance2.0fast": "2.0", "seedance2.0mini": "Mini" }[model] || model));

  const state = {
    verified: false, // 实机验证前一律为 false
    pages: new Map(),
  };

  async function pageFor(accountId) {
    const existing = state.pages.get(accountId);
    if (existing && !existing.isDestroyed?.()) return existing;
    if (resolveContents) {
      const contents = await resolveContents(accountId);
      state.pages.set(accountId, contents);
      return contents;
    }
    // 兜底：用账号会话分区自建一个隐藏窗口，不改动用户的可见工作区
    const partition = `${PARTITION_PREFIX}${accountId}`;
    const target = session.fromPartition(partition);
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: pathToFileURL(path.join(__dirname, "webview-preload.js")).toString(),
      },
    });
    void target;
    await win.loadURL(CREATE_URL).catch(() => {});
    state.pages.set(accountId, win.webContents);
    return win.webContents;
  }

  async function chooseOption(contents, selector, wanted) {
    const code = STEP_CHOOSE.replace("__SELECTOR__", JSON.stringify(selector)).replace("__WANTED__", JSON.stringify(wanted));
    return evaluate(contents, code);
  }

  async function attachImages(contents, uploads) {
    if (!uploads?.length) return { ok: true, skipped: true, reason: "没有参考图片" };
    const dbg = contents.debugger;
    const owned = !dbg.isAttached();
    try {
      if (owned) dbg.attach("1.3");
      await dbg.sendCommand("DOM.enable", {});
      const { root } = await dbg.sendCommand("DOM.getDocument", { depth: 1 });
      const { nodeId } = await dbg.sendCommand("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: DOLA_SELECTORS.fileInput,
      });
      if (!nodeId) {
        return {
          ok: false,
          reason: "当前页面没有可用的文件上传入口，无法附加参考图片",
          limitation: "平台未提供图片上传入口时，参考图引用无法提交",
          uploads,
        };
      }
      await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: uploads });
      await sleep(1500);
      return { ok: true, count: uploads.length };
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    } finally {
      if (owned && dbg.isAttached()) {
        try {
          dbg.detach();
        } catch {}
      }
    }
  }

  /** 等待页面发出视频生成请求并回读其中的任务 ID（不猜字段，取不到就报 unknown） */
  async function watchForTaskId(contents, timeoutMs) {
    const dbg = contents.debugger;
    const owned = !dbg.isAttached();
    const seen = { taskId: "", ids: [], error: "" };
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const onMessage = (_event, method, params) => {
      try {
        if (method !== "Network.responseReceived") return;
        const mime = params?.response?.mimeType || "";
        if (!/json/i.test(mime)) return;
        contents.debugger
          .sendCommand("Network.getResponseBody", { requestId: params.requestId })
          .then(({ body }) => {
            const parsed = (() => {
              try {
                return JSON.parse(body);
              } catch {
                return null;
              }
            })();
            if (!parsed) return;
            const found = collectIds(parsed);
            if (found.length) {
              seen.ids = [...new Set([...seen.ids, ...found])];
              if (!seen.taskId) seen.taskId = found[0];
              resolveDone();
            }
          })
          .catch(() => {});
      } catch {}
    };
    try {
      if (owned) dbg.attach("1.3");
      await dbg.sendCommand("Network.enable", {});
      dbg.on("message", onMessage);
    } catch (error) {
      return { taskId: "", ids: [], error: error?.message || String(error) };
    }

    await Promise.race([done, sleep(timeoutMs)]);
    try {
      dbg.removeListener("message", onMessage);
    } catch {}
    if (owned && dbg.isAttached()) {
      try {
        dbg.detach();
      } catch {}
    }
    return seen;
  }

  return {
    id: "dola",
    verified: state.verified,

    async submit({ accountId, plan }) {
      const steps = [];
      let contents;
      try {
        contents = await pageFor(accountId);
      } catch (error) {
        return { outcome: "failed", message: `无法打开账号页面：${error?.message || error}`, steps };
      }
      if (!plan?.valid) {
        return { outcome: "failed", message: `计划无效：${(plan?.errors || []).join("；")}`, steps };
      }

      const watcher = watchForTaskId(contents, SEND_TIMEOUT_MS);

      const textStep = await evaluate(
        contents,
        STEP_SET_TEXT.replace("__VALUE__", JSON.stringify(plan.plainText))
      );
      steps.push({ step: "setPrompt", ...textStep });
      if (!textStep?.ok) {
        return { outcome: "failed", message: `写入提示词失败：${textStep?.reason || "内容未被接受"}`, steps };
      }

      const modelStep = await chooseOption(contents, DOLA_SELECTORS.modelControl, modelLabel(plan.params.model));
      steps.push({ step: "chooseModel", ...modelStep });
      const durationStep = await chooseOption(
        contents,
        DOLA_SELECTORS.durationControl,
        String(plan.params.duration)
      );
      steps.push({ step: "chooseDuration", ...durationStep });

      const uploadStep = await attachImages(contents, plan.uploads);
      steps.push({ step: "attachImages", ...uploadStep });
      if (!uploadStep.ok) {
        return { outcome: "failed", message: uploadStep.reason, steps, limitation: uploadStep.limitation };
      }

      const stateRead = await evaluate(contents, STEP_READ_STATE);
      steps.push({ step: "readState", ...stateRead });

      const watched = await watcher;
      if (watched.taskId) {
        return {
          outcome: "ok",
          platformTaskId: watched.taskId,
          state: "queued",
          message: "已从平台响应中取得任务 ID",
          steps,
        };
      }
      // 关键：没有确认到任务 ID 就绝不当作已提交，交由编排层标记「提交结果待确认」
      return {
        outcome: "unknown",
        message: watched.error || "未能在超时时间内确认平台任务 ID，未重复提交",
        observedIds: watched.ids,
        steps,
      };
    },

    /** 页面没有明确信号时返回 unknown，不编造进度 */
    async poll({ accountId, platformTaskId }) {
      let contents;
      try {
        contents = await pageFor(accountId);
      } catch (error) {
        return { state: "unknown", message: `无法读取账号页面：${error?.message || error}` };
      }
      const read = await evaluate(contents, STEP_READ_STATE).catch(() => null);
      if (!read?.ok) return { state: "unknown", message: "页面状态不可读取" };
      const text = String(read.text || "");
      if (/生成失败|失败|违规|未通过/.test(text) && !/生成中|排队/.test(text)) {
        return { state: "failed", message: "页面显示生成失败", errorCode: "GENERATE_FAILED" };
      }
      return {
        state: "unknown",
        message: "页面未给出可判定的状态标记；阶段2首次实机运行需要据此校准判定规则",
      };
    },

    async verifySubmission() {
      return {
        found: false,
        message: "尚未建立“按平台任务 ID 反查”的可信通道，因此不臆断提交结果",
      };
    },

    async cancel() {
      return { canceled: false, reason: "平台是否支持取消生成尚未确认，未执行取消" };
    },

    dispose() {
      for (const contents of state.pages.values()) {
        try {
          const win = BrowserWindow.fromWebContents(contents);
          if (win && !win.isDestroyed()) win.destroy();
        } catch {}
      }
      state.pages.clear();
    },
  };
}

module.exports = { CREATE_URL, PARTITION_PREFIX, collectIds, createDolaDriver };