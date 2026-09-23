"use strict";
/**
 * Dola 页面驱动层（Electron 依赖，无法离线验证）
 *
 * 驱动目标：应用自己为每个账号挂的那个 <webview>，也就是用户已登录、且装了
 *   应用自身 webview-preload（含 30 秒时长增强）的那个真实页面。
 *
 * ⚠ 为什么不再自建隐藏窗口（实测结论，2026-09-23）：
 *   曾用 new BrowserWindow + persist:doubao-manager-<accountId> 自建隐藏窗口来驱动，
 *   结果在隔离环境里 20 秒页面加载超时、随后 15 秒脚本执行超时，首个步骤直接失败
 *   （任务卡片显示 02:02:25 提交 → 02:03:00 失败，恰为两个超时之和）。
 *   隐藏窗口既加载不出页面，也拿不到真实 webview 才有的 preload 能力，故改为直接驱动真实 webview。
 *   定位方式与应用内既有模块保持一致（account-proxy.js / hd-original-service.js）：
 *   webContents.getAllWebContents() + getType()==='webview' + 会话分区相同。
 *
 * 选择器与手法来自本项目内既有可读模块的实测代码：
 *   - src/webview-preload.js：编辑器选择器、\uFFFC 原子节点、TEXTAREA 原生 setter、
 *     contenteditable 走 execCommand('insertText')、菜单选择器 MENU_SELECTOR、
 *     工具栏控件 data-input-engine-actionbar-control-key
 *   - src/video-log-data.js：从响应中提取 task_id/video_id/status 的字段名
 * 但「真实点击发送、真实取回平台任务 ID、真实判定完成」仍必须通过单任务实机运行确认。
 *
 * 因此每个步骤都返回结构化结果；失败时把页面上实际可见的选项与页面地址一并回报，
 * 便于快速校准，而不是靠猜。
 *
 * 设计约束：
 * - 只借用账号已有的登录会话（persist:doubao-manager-<accountId>），不新建登录。
 * - 绝不销毁账号页面：那是应用自己的 webview，驱动层只是借用其调试通道。
 * - 拿不到平台任务 ID 时返回 outcome:"unknown"，由编排层标记「提交结果待确认」，
 *   绝不在本层重复提交。
 * - 不做任何进度百分比的编造：页面没有明确信号时返回 unknown。
 */

const { webContents, session } = require("electron");
const { DOLA_SELECTORS } = require("./workbench-platform");

const PARTITION_PREFIX = "persist:doubao-manager-";
// 提交请求通常很快就能在响应里看到任务 ID；超时给太长会让用户以为「点了没反应」
const SEND_TIMEOUT_MS = 45 * 1000;
// 每个环节都必须有上限：页面没就绪或脚本挂起时，绝不能把整个提交无限期卡住
const EVAL_TIMEOUT_MS = 15 * 1000;
const IMAGE_TIMEOUT_MS = 20 * 1000;
const DOLA_HOST_RE = /(^|\.)dola\.com$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
}

const isDolaUrl = (url) => DOLA_HOST_RE.test(hostOf(url));

/**
 * 找到账号「真实」的 webview。
 * 找不到时返回可执行的原因（而不是含糊的失败），让用户知道该先做什么。
 */
function findAccountWebview(accountId) {
  const partition = `${PARTITION_PREFIX}${accountId}`;
  let target;
  try {
    target = session.fromPartition(partition);
  } catch (error) {
    return { ok: false, reason: `账号会话分区不可用（${partition}）：${error?.message || error}` };
  }
  const views = webContents
    .getAllWebContents()
    .filter(
      (contents) =>
        !contents.isDestroyed() && contents.getType() === "webview" && contents.session === target
    );
  if (!views.length) {
    return {
      ok: false,
      reason: `账号 ${accountId} 的页面当前没有打开。请先在应用左侧选中该账号，等它的页面加载出来再提交`,
    };
  }
  const onDola = views.find((contents) => isDolaUrl(contents.getURL()));
  if (!onDola) {
    return {
      ok: false,
      reason: `账号 ${accountId} 的页面当前不在 dola 上，未擅自跳转。实际地址：${views
        .map((contents) => contents.getURL() || "(空白)")
        .join(" | ")}`,
    };
  }
  return { ok: true, contents: onDola, url: onDola.getURL() };
}

/** 给一个可能挂起的 Promise 加上上限；超时返回 timeoutValue 而不是一直等 */
function withTimeout(promise, ms, timeoutValue) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(timeoutValue), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 页面内注入脚本：只做与既有模块同款的 DOM 操作 */
function pageScript(source) {
  return `(async () => { ${source} })()`;
}

const HELPERS = `
  const SEL = ${JSON.stringify({
    editor: DOLA_SELECTORS.editor,
    model: DOLA_SELECTORS.modelControl,
    duration: DOLA_SELECTORS.durationControl,
    ratio: DOLA_SELECTORS.ratioControl,
    actionbar: DOLA_SELECTORS.actionbar,
    fileInput: DOLA_SELECTORS.fileInput,
  })};
  // 刻意不要求「有非零尺寸」：目标可能是账号非当前选中态时的 webview（被应用隐藏），
  // 那种情况下元素 rect 恒为 0×0，但 DOM 完全可用。这里只排除真正不渲染的节点。
  const visible = (el) => {
    try {
      const s = el && getComputedStyle(el);
      return Boolean(
        el?.isConnected && s?.display !== 'none' && s?.visibility !== 'hidden' && Number(s?.opacity || 1) > 0.01
      );
    } catch { return false; }
  };
  const textOf = (el) => String(el?.textContent || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '').replace(/\\s+/g, ' ').trim();
  const editors = () => [...document.querySelectorAll(SEL.editor)].filter(e => visible(e) && !e.disabled && !e.readOnly);
  const attr = (el, name) => { try { return String(el?.getAttribute?.(name) || ''); } catch { return ''; } };
  // 失败时把「页面在哪、页面上写着什么」一并回报，便于判断是不是撞了登录墙
  const pageInfo = () => {
    try {
      return { pageUrl: String(location.href), pageExcerpt: String(document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) };
    } catch { return { pageUrl: '', pageExcerpt: '' }; }
  };
`;

async function evaluate(contents, source) {
  const result = await withTimeout(
    contents
      .executeJavaScript(pageScript(`${HELPERS}\n${source}`), true)
      .catch((error) => ({ ok: false, reason: `页面脚本执行失败：${error?.message || error}` })),
    EVAL_TIMEOUT_MS,
    { ok: false, reason: `页面脚本执行超时（${EVAL_TIMEOUT_MS / 1000} 秒无响应，页面可能未加载完成）` }
  );
  return result;
}

/** 点击某个控件并从中选择匹配项；失败时回报实际可见选项 */
const STEP_CHOOSE = `
  const controlSelector = __SELECTOR__;
  const wanted = __WANTED__;
  const control = document.querySelector(controlSelector);
  if (!control) return { ok: false, reason: '页面上找不到该控件', wanted, available: [], ...pageInfo() };
  control.click();
  await new Promise(r => setTimeout(r, 600));
  const menus = [...document.querySelectorAll('[role="menu"],[role="listbox"],[data-slot*="dropdown-menu"],[class*="popover"],[class*="dropdown"]')].filter(visible);
  const options = menus.flatMap(m => [...m.querySelectorAll('[role="menuitem"],[role="option"],li,button,div')]).filter(visible);
  const labels = [...new Set(options.map(textOf).filter(Boolean))].slice(0, 40);
  const norm = (s) => s.toLowerCase().replace(/[\\s_\\-]/g, '');
  const target = options.find(o => norm(textOf(o)).includes(norm(wanted)));
  if (!target) return { ok: false, reason: '菜单里没有匹配项', wanted, available: labels, ...pageInfo() };
  target.click();
  await new Promise(r => setTimeout(r, 400));
  return { ok: true, picked: textOf(target), available: labels };
`;

const STEP_SET_TEXT = `
  const list = editors();
  if (!list.length) return { ok: false, reason: '找不到提示词输入框（可能未登录、页面未加载完成或页面结构已变化）', ...pageInfo() };
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

/**
 * 点击发送。
 * 既有可读模块里没有留下发送按钮的实测选择器，所以这里不写死，
 * 而是按「无障碍标签 → 输入区工具栏尾部」的顺序探测候选控件，
 * 无论成功失败都把候选清单回报出来，首次实机运行即可据此校准。
 */
const STEP_SEND = `
  const cands = [];
  const add = (el, why) => {
    if (!el || !visible(el)) return;
    if (cands.some((c) => c.el === el)) return;
    if (el.matches(SEL.model) || el.closest(SEL.model)) return;
    if (el.matches(SEL.duration) || el.closest(SEL.duration)) return;
    if (el.matches(SEL.ratio) || el.closest(SEL.ratio)) return;
    cands.push({ el, why });
  };
  const describe = (el) => {
    const label = [textOf(el), attr(el, 'aria-label'), attr(el, 'title'), attr(el, 'class')].filter(Boolean).join(' ');
    return String(label).replace(/\\s+/g, ' ').trim().slice(0, 60);
  };

  // 1) 按文字/无障碍标签命中「发送 / 生成 / 提交」
  const wanted = /发送|生成|提交|立即|send|generate|submit/i;
  for (const el of [...document.querySelectorAll('button,[role="button"],[tabindex="0"]')]) {
    if (wanted.test(describe(el))) add(el, 'label:' + describe(el));
  }

  // 2) 输入区工具栏里最后一个可点元素通常就是发送
  if (cands.length < 2) {
    const bar = document.querySelector(SEL.actionbar)
      || document.querySelector(SEL.model)?.parentElement
      || document.querySelector(SEL.editor)?.parentElement;
    if (bar) {
      const inside = [...bar.querySelectorAll('button,[role="button"],[tabindex="0"]')].filter(visible).reverse();
      for (const el of inside.slice(0, 6)) add(el, 'toolbar-tail:' + describe(el));
    }
  }

  const candidates = cands.slice(0, 12).map((c) => c.why);
  const target = cands[0];
  if (!target) return { ok: false, reason: '页面上找不到发送按钮，无法提交生成', candidates, ...pageInfo() };
  target.el.click();
  await new Promise((r) => setTimeout(r, 600));
  return { ok: true, clicked: target.why, candidates };
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
    // 直接借用应用自己为账号挂的 webview：已登录、带应用 preload，且不需要我们自己加载页面
    const found = findAccountWebview(accountId);
    if (!found.ok) {
      log("dola-webview-not-found", { accountId, reason: found.reason });
      throw new Error(found.reason);
    }
    log("dola-webview-resolved", { accountId, url: found.url, webContentsId: found.contents.id });
    state.pages.set(accountId, found.contents);
    return found.contents;
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

    async submit({ accountId, plan, onStep }) {
      const steps = [];
      // 每完成一步就立刻回报，界面才能显示「现在走到哪一步」，而不是等 45 秒后一次性出结果
      const record = (step, result) => {
        steps.push({ step, ...result });
        if (typeof onStep === "function") {
          try {
            onStep({ step, ...result });
          } catch {}
        }
      };
      let contents;
      try {
        contents = await pageFor(accountId);
      } catch (error) {
        const reason = error?.message || String(error);
        record("openPage", { ok: false, reason });
        return { outcome: "failed", message: `无法打开账号页面：${reason}`, steps };
      }
      if (!plan?.valid) {
        return { outcome: "failed", message: `计划无效：${(plan?.errors || []).join("；")}`, steps };
      }

      const textStep = await evaluate(
        contents,
        STEP_SET_TEXT.replace("__VALUE__", JSON.stringify(plan.plainText))
      );
      record("setPrompt", textStep);
      if (!textStep?.ok) {
        return { outcome: "failed", message: `写入提示词失败：${textStep?.reason || "内容未被接受"}`, steps };
      }

      record("chooseModel", await chooseOption(contents, DOLA_SELECTORS.modelControl, modelLabel(plan.params.model)));
      record("chooseDuration", await chooseOption(contents, DOLA_SELECTORS.durationControl, String(plan.params.duration)));
      // 比例：平台能力表里没有这一项，控件是否存在需要实测；找不到就如实记录，不阻塞提交
      record(
        "chooseRatio",
        plan.params.ratio
          ? await chooseOption(contents, DOLA_SELECTORS.ratioControl, plan.params.ratio)
          : { ok: true, skipped: true, reason: "未设置比例" }
      );

      const uploadStep = await withTimeout(
        attachImages(contents, plan.uploads),
        IMAGE_TIMEOUT_MS,
        { ok: false, reason: `附加参考图超时（${IMAGE_TIMEOUT_MS / 1000} 秒）` }
      );
      record("attachImages", uploadStep);
      if (!uploadStep.ok) {
        return { outcome: "failed", message: uploadStep.reason, steps, limitation: uploadStep.limitation };
      }

      record("readState", await evaluate(contents, STEP_READ_STATE));

      // 发送前才挂网络监听，避免把前面的步骤耗时算进等待窗口
      const watcher = watchForTaskId(contents, SEND_TIMEOUT_MS);

      // 关键补漏：此前只写入了内容却没有真正点击发送，因此永远等不到任务 ID
      const sendStep = await evaluate(contents, STEP_SEND);
      record("send", sendStep);
      if (!sendStep?.ok) {
        return {
          outcome: "failed",
          message: `${sendStep?.reason || "点击发送失败"}；页面候选控件：${(sendStep?.candidates || []).join(" | ") || "无"}`,
          steps,
        };
      }

      if (typeof onStep === "function") {
        try {
          onStep({
            step: "awaitResponse",
            ok: true,
            reason: `已点击发送，等待平台响应（最长 ${SEND_TIMEOUT_MS / 1000} 秒）`,
          });
        } catch {}
      }
      const watched = await watcher;
      if (watched.taskId) {
        return {
          outcome: "ok",
          platformTaskId: watched.taskId,
          state: "queued",
          message: "已点击发送，并从平台响应中取得任务 ID",
          steps,
        };
      }
      // 关键：没有确认到任务 ID 就绝不当作已提交，交由编排层标记「提交结果待确认」
      return {
        outcome: "unknown",
        message: `${watched.error || "已点击发送，但未在超时时间内确认平台任务 ID"}，未重复提交；发送按钮命中：${
          sendStep?.clicked || "未知"
        }`,
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
      // 只放开引用，绝不销毁：这些是应用自己的账号 webview，不是驱动层创建的窗口
      state.pages.clear();
    },
  };
}

module.exports = { DOLA_HOST_RE, PARTITION_PREFIX, collectIds, createDolaDriver, findAccountWebview, isDolaUrl };