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
 *
 * ⚠ 上一轮失败的真正原因（隔离版任务日志 att_1bea070d7ef0，2026-09-23 12:29:56 → 12:30:09）：
 *   openPage / setPrompt 成功，但 chooseModel / chooseDuration / chooseRatio / send 全部失败，
 *   页面地址是 https://www.dola.com/chat/ —— 也就是「聊天模式」。
 *   实测结论：聊天模式下 data-input-engine-actionbar 与三个控件计数均为 0，
 *   提示词被写进了聊天输入框，模型/时长/比例控件根本不存在，发送按钮也不是 #flow-end-msg-send。
 *   因此进入视频生成模式是提交前的必要前置步骤，不能靠「页面上恰好是什么模式」。
 *   早前两次失败（12:15 / 12:20）则是「页面还没加载完就去操作」，现在改为等主进程的就绪事件。
 *
 * 实测得到的页面事实（2026-09-23，DevTools 直连真实 webview）：
 *   - 页面就绪后脚本通道 1ms 返回；readyState=complete
 *   - 「视频生成」入口：button[data-skill-id="skill_bar_button_17"]
 *   - 视频模式控件：[data-input-engine-actionbar-control-key="video-model"|"video-duration"|"video-ratio"]
 *     三者都是 radix trigger（aria-haspopup=menu / data-state=closed / data-slot=dropdown-menu-trigger）
 *   - radix 只监听真实指针事件：element.click() 打不开菜单（三轮实测确认）
 *   - 编辑器是 div.tiptap.ProseMirror[contenteditable=true]，不是 textarea
 *   - 发送按钮 #flow-end-msg-send，编辑器为空时 disabled + aria-disabled=true
 *
 * 设计约束：
 * - 只借用账号已有的登录会话（persist:doubao-manager-<accountId>），不新建登录。
 * - 绝不销毁账号页面：那是应用自己的 webview，驱动层只是借用其调试通道。
 * - 账号页面归属必须可证明：webContents 来自本进程 getAllWebContents()，
 *   且 contents.session 必须与 persist:doubao-manager-<accountId> 是同一个会话对象；
 *   能读到会话存储路径时一并回报。证明不了就不操作该页面。
 * - 参数（模型/时长/比例）必须设置成功并回读一致才继续；任何一项无法生效都阻断提交，
 *   绝不用平台默认值继续生成。
 * - 拿不到平台任务 ID 时返回 outcome:"unknown"，由编排层标记「提交结果待确认」，
 *   绝不在本层重复提交。
 * - 不做任何进度百分比的编造：页面没有明确信号时返回 unknown。
 */

const { webContents, session } = require("electron");
const { DOLA_SELECTORS, buildSegments, classifyAcceptance, classifyPlatformReply, toPlatformText } = require("./workbench-platform");

const PARTITION_PREFIX = "persist:doubao-manager-";
// 提交请求通常很快就能在响应里看到任务 ID；超时给太长会让用户以为「点了没反应」
const SEND_TIMEOUT_MS = 45 * 1000;
// 每个环节都必须有上限：页面没就绪或脚本挂起时，绝不能把整个提交无限期卡住
const EVAL_TIMEOUT_MS = 15 * 1000;
const IMAGE_TIMEOUT_MS = 20 * 1000;
// 选页前先做一次极轻量的脚本探测：同一个账号分区下可能有多个 webview，
// 必须挑出脚本通道真正可用的那个，否则后面每步都会白白超时。
const PROBE_TIMEOUT_MS = 5 * 1000;
// 等页面就绪：完全由主进程事件与 is-loading 事实判定，不靠脚本探测
const READY_TIMEOUT_MS = 25 * 1000;
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

/** 文件名（平台附件卡的 img.alt 回落到上传时的原文件名，用它做跨会话的归属判定） */
const baseNameOf = (filePath) => String(filePath || "").split(/[\\/]/).pop() || "";

const readSafe = (fn) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

/**
 * 页面事实：全部来自主进程 API，不依赖脚本通道，因此永远不会挂起。
 * 用于在「脚本超时」时给出可判断的信息，而不是只留一句超时。
 */
function describeView(contents) {
  const facts = { webContentsId: contents?.id };
  facts.url = readSafe(() => contents.getURL()) || "";
  facts.type = readSafe(() => contents.getType());
  facts.loading = Boolean(readSafe(() => contents.isLoading()));
  facts.crashed = Boolean(readSafe(() => contents.isCrashed()));
  facts.rendererPid = readSafe(() => contents.getOSProcessId());
  return facts;
}

/**
 * 归属证据：证明这个页面确实属于「本开发进程 + 该账号的隔离会话」。
 *   - 进程归属：getAllWebContents() 只返回本进程创建的 webContents，findAccountWebview 已按此过滤；
 *   - 会话归属：contents.session 必须与 session.fromPartition('persist:doubao-manager-<accountId>')
 *     是同一个会话对象（Electron 的 Session 不暴露 getPartition，因此用对象同一性来证明）；
 *   - 存储归属：能读到会话存储路径时，核实它落在本进程的 userData 目录下（读不到就如实标未知）。
 */
function sessionEvidence(contents, accountId) {
  const expectedPartition = `${PARTITION_PREFIX}${accountId}`;
  let expected = null;
  try {
    expected = session.fromPartition(expectedPartition);
  } catch {}
  const sessionMatched = Boolean(expected) && contents?.session === expected;
  const storagePath =
    readSafe(() => contents?.session?.getStoragePath?.()) ||
    String(readSafe(() => contents?.session?.storagePath) || "");
  let userData = "";
  try {
    userData = require("electron").app.getPath("userData");
  } catch {}
  return {
    expectedPartition,
    sessionMatched,
    partitionMatches: sessionMatched, // 会话对象同一性 = 分区归属成立
    storagePath,
    userData,
    // null 表示读不到，不当作失败；false 表示读到了但不在本实例数据目录下（必须停手）
    storageUnderUserData: storagePath && userData ? storagePath.startsWith(userData) : null,
    processOwned: true,
  };
}

/**
 * 找到账号「真实」的 webview 候选。
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
  // 分区必须是本应用自己的账号分区：只取「会话对象完全一致」的 webview，
// 前缀不符时 session.fromPartition 拿到的就是另一个会话对象，天然不会误选别人的页面。
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
  const onDola = views.filter((contents) => isDolaUrl(contents.getURL()));
  if (!onDola.length) {
    return {
      ok: false,
      reason: `账号 ${accountId} 的页面当前不在 dola 上，未擅自跳转。实际地址：${views
        .map((contents) => contents.getURL() || "(空白)")
        .join(" | ")}`,
    };
  }
  return {
    ok: true,
    candidates: onDola,
    all: views.map(describeView),
    evidence: onDola.map((contents) => ({ ...describeView(contents), ...sessionEvidence(contents, accountId) })),
  };
}

/**
 * 把「非当前账号」的隐藏页拉回可驱动的状态。
 * 实测（2026-09-24）：三个账号的页面 document.hidden 均为 true，隐藏页会被 Chromium
 * 降级/冻结，脚本调用表现为 15 秒无响应（正是 att_4c080b957c39 等的失败点）。
 * 处理：借调试通道声明页面生命周期为 active 并开启焦点模拟；失败或读不到就如实回报，
 * 不影响归属判定与后续步骤（写脚本通道仍然可用）。
 */
async function ensurePageActive(contents) {
  const dbg = contents.debugger;
  const owned = !dbg.isAttached();
  const result = { lifecycle: "", focusEmulated: false, errors: [] };
  try {
    if (owned) dbg.attach("1.3");
    try {
      await dbg.sendCommand("Page.enable", {});
      await dbg.sendCommand("Page.setWebLifecycleState", { state: "active" });
      result.lifecycle = "active";
    } catch (error) {
      result.errors.push(`生命周期：${error?.message || error}`);
    }
    try {
      await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      result.focusEmulated = true;
    } catch (error) {
      result.errors.push(`焦点模拟：${error?.message || error}`);
    }
  } catch (error) {
    result.errors.push(String(error?.message || error));
  } finally {
    if (owned && dbg.isAttached()) {
      try {
        dbg.detach();
      } catch {}
    }
  }
  return result;
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
    videoModeButton: DOLA_SELECTORS.videoModeButton,
    model: DOLA_SELECTORS.modelControl,
    duration: DOLA_SELECTORS.durationControl,
    ratio: DOLA_SELECTORS.ratioControl,
    actionbar: DOLA_SELECTORS.actionbar,
    sendButton: DOLA_SELECTORS.sendButton,
    menu: DOLA_SELECTORS.menu,
    menuItem: DOLA_SELECTORS.menuItem,
    option: DOLA_SELECTORS.option,
    fileInput: DOLA_SELECTORS.fileInput,
    atomicMark: DOLA_SELECTORS.atomicMark,
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
  const attr = (el, name) => { try { return String(el?.getAttribute?.(name) || ''); } catch { return ''; } };
  const norm = (s) => String(s || '').toLowerCase().replace(/[\\s_\\-]/g, '');
  const compact = (s) => String(s || '').replace(/\\s+/g, '').replace(/[\\u2713\\u2714\\u221a]/g, '');
  const controlFor = (key) => document.querySelector('[data-input-engine-actionbar-control-key="' + key + '"]');
  const controlText = (key) => textOf(controlFor(key));
  const editors = () => [...document.querySelectorAll(SEL.editor)].filter(e => visible(e) && !e.disabled && !e.readOnly);

  // radix 只监听真实指针事件：element.click() 打不开菜单（实测）。
  // 依次派发 pointerdown / pointerup / click，并带上真实坐标。
  const pointerClick = (el) => {
    if (!el) return false;
    try { el.scrollIntoView?.({ block: 'nearest' }); } catch {}
    let x = 0, y = 0;
    try {
      const rect = el.getBoundingClientRect();
      x = rect.left + Math.max(1, rect.width) / 2;
      y = rect.top + Math.max(1, rect.height) / 2;
    } catch {}
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
      try { el.click(); } catch {}
      return true;
    } catch {
      try { el.click(); return true; } catch { return false; }
    }
  };

  // radix 菜单容器只认 role：触发器是 button[data-slot="dropdown-menu-trigger"]，
// 它自身也带 data-slot*="dropdown-menu"，若按属性匹配会把触发器当成菜单（实测踩过）。
  const menuRoots = () => [...document.querySelectorAll(SEL.menu)].filter(visible);
  const isOpenMenu = (el) => attr(el, 'data-state') === 'open' || attr(el, 'data-slot') === 'dropdown-menu-content';
  // 选项优先取 role=menuitem/option：菜单项内部还有嵌套 div，用泛化选择器会重复计数
  const menuOptions = (root) => {
    const items = [...root.querySelectorAll(SEL.menuItem)].filter(el => visible(el) && textOf(el));
    if (items.length) return items;
    return [...root.querySelectorAll(SEL.option)].filter(el => el !== root && visible(el) && textOf(el));
  };
  const menuTexts = () => menuRoots().map(r => textOf(r).slice(0, 80)).slice(0, 3);
  // 打开后挑出真正的菜单内容：优先 data-state=open，其次点击后新出现的，最后取最内层
  const pickMenu = (beforeSet) => {
    const all = menuRoots();
    const rank = (list) => {
      const good = list.filter(el => menuOptions(el).length >= 1);
      const inner = good.filter(el => !good.some(o => o !== el && el.contains(o)));
      return inner.sort((a, b) => menuOptions(a).length - menuOptions(b).length)[0] || null;
    };
    return rank(all.filter(isOpenMenu)) || rank(all.filter(el => beforeSet && !beforeSet.has(el))) || rank(all) || null;
  };
  // 触发器文本就是当前值，用它做回读（模型只显示「2.5 / 2.0 Fast」这类短名）
  const triggerState = (key) => {
    const control = controlFor(key);
    return control ? { text: textOf(control), open: attr(control, 'data-state') === 'open' } : { text: '', open: false };
  };
  // 失败时把「页面在哪、页面上写着什么」一并回报，便于判断是不是撞了登录墙
  const pageInfo = () => {
    try {
      return { pageUrl: String(location.href), pageExcerpt: String(document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) };
    } catch { return { pageUrl: '', pageExcerpt: '' }; }
  };
  const toolbarState = () => ({
    inVideoMode: Boolean(controlFor('video-model') && controlFor('video-duration')),
    model: controlText('video-model'),
    duration: controlText('video-duration'),
    ratio: controlText('video-ratio'),
    editorCount: editors().length,
    sendDisabled: (() => { const b = document.querySelector(SEL.sendButton); return b ? Boolean(b.disabled) || attr(b,'aria-disabled') === 'true' : null; })(),
  });
`;

async function evaluate(contents, source) {
  const result = await withTimeout(
    contents
      .executeJavaScript(pageScript(`${HELPERS}\n${source}`), true)
      .catch((error) => ({ ok: false, reason: `页面脚本执行失败：${error?.message || error}` })),
    EVAL_TIMEOUT_MS,
    {
      ok: false,
      reason: `页面脚本执行超时（${EVAL_TIMEOUT_MS / 1000} 秒无响应）`,
      // 超时时补上主进程侧的页面事实，否则只剩一句「超时」无法判断
      ...describeView(contents),
    }
  );
  return result;
}

/** 极轻量的脚本通道探测：用来在多个候选 webview 里挑出真正可用的那个 */
async function probeView(contents) {
  const result = await withTimeout(
    contents.executeJavaScript("1+1", true).then(
      (value) => ({ ok: value === 2 }),
      (error) => ({ ok: false, reason: error?.message || String(error) })
    ),
    PROBE_TIMEOUT_MS,
    { ok: false, reason: `脚本通道 ${PROBE_TIMEOUT_MS / 1000} 秒无响应` }
  );
  return result;
}

/**
 * 幂等写入（提示词）专用：脚本通道偶发超时。
 * 实测（2026-09-23 真实提交 att_4c080b957c39 / att_ac50acc770cb）：上传完成后写入提示词时
 * 出现「页面脚本执行超时（15 秒无响应）」，两账号同时命中；此时页面并没有崩溃（事后 1ms 可响应）。
 * 处理：先等到页面不在导航中，再用 1+1 探测通道可用性，然后重试同一段幂等写入；
 * 重试过程落到证据里；两次都不行才判失败，绝不静默继续。
 */
async function evaluateIdempotent(contents, source) {
  const first = await evaluate(contents, source);
  if (first?.ok) return { ...first, retried: false };
  const reason = String(first?.reason || "");
  if (!/超时|无响应/.test(reason)) return { ...first, retried: false };
  const waitUntil = Date.now() + 5000;
  while (readSafe(() => contents.isLoading()) && Date.now() < waitUntil) await sleep(300);
  const probe = await probeView(contents);
  if (!probe.ok) return { ...first, retried: true, retryProbe: probe.reason || "脚本通道仍无响应" };
  const second = await evaluate(contents, source);
  return { ...second, retried: true, firstReason: reason };
}

/** 组合就绪检查：可用的编辑器 + 文件入口 + 发送按钮都在（进入视频模式后页面会重渲染） */
const STEP_COMPOSER_READY = `
  const editor = editors()[0] || null;
  const input = document.querySelector(SEL.fileInput);
  const send = document.querySelector(SEL.sendButton);
  const anyEditor = document.querySelector(SEL.editor);
  return {
    ok: Boolean(editor && input && send),
    hasEditor: Boolean(editor),
    editorCount: editors().length,
    anyEditorPresent: Boolean(anyEditor),
    hasFileInput: Boolean(input),
    hasSend: Boolean(send),
    ...pageInfo(),
  };
`;

/** 等输入区就绪：每次 4 秒上限，最多等 timeoutMs，避免一步吃掉整段预算 */
async function waitForComposer(contents, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await withTimeout(evaluate(contents, STEP_COMPOSER_READY), 4000, {
      ok: false,
      reason: "页面脚本 4 秒无响应",
    });
    if (last?.ok) return last;
    if (Date.now() >= deadline) return { ...last, reason: last?.reason || "输入区未就绪（编辑器/上传入口/发送按钮不全）" };
    await sleep(400);
  }
}

/**
 * 等页面就绪：只看主进程事实（isLoading / did-fail-load / 崩溃），不靠脚本探测，
 * 因为「脚本超时」本身就是页面没加载完的症状（实测 1ms 即可返回的前提是页面已就绪）。
 */
async function waitForPageReady(contents, timeoutMs = READY_TIMEOUT_MS) {
  const started = Date.now();
  let loadError = null;
  const onFail = (_event, code, desc, url) => {
    // -3 是主动中止，不算失败
    if (Number(code) !== -3) loadError = { code, desc, url };
  };
  const onGone = () => {
    loadError = { code: "render-process-gone", desc: "渲染进程已退出" };
  };
  try {
    contents.on("did-fail-load", onFail);
    contents.on("render-process-gone", onGone);
  } catch {}
  try {
    for (;;) {
      const facts = describeView(contents);
      if (facts.crashed) return { ok: false, reason: "渲染进程已崩溃", ...facts };
      if (loadError) {
        return { ok: false, reason: `页面加载失败：${loadError.code} ${loadError.desc}`, ...facts };
      }
      if (!facts.loading && isDolaUrl(facts.url)) return { ok: true, ...facts };
      if (Date.now() - started >= timeoutMs) {
        return { ok: false, reason: `等待页面就绪超时（${Math.round(timeoutMs / 1000)} 秒）`, ...facts };
      }
      await sleep(200);
    }
  } finally {
    try {
      contents.removeListener("did-fail-load", onFail);
      contents.removeListener("render-process-gone", onGone);
    } catch {}
  }
}

/**
 * 幂等进入视频生成模式。
 * 聊天模式下工具栏控件计数为 0，必须先点「视频生成」再操作参数控件。
 */
const STEP_ENTER_VIDEO = `
  const before = toolbarState();
  if (before.inVideoMode) return { ok: true, skipped: true, picked: '已在视频生成模式', ...before };
  let button = document.querySelector(SEL.videoModeButton);
  if (!button) {
    // 兜底：按可见文案找「视频生成」，同时把实际存在的技能入口回报出来供校准
    button = [...document.querySelectorAll('button,[role="button"]')].find(el => /视频生成|视频$/.test(textOf(el)) && visible(el));
  }
  if (!button) {
    const skills = [...document.querySelectorAll('[data-skill-id]')]
      .map(el => ({ id: attr(el, 'data-skill-id'), text: textOf(el) }))
      .slice(0, 20);
    return { ok: false, reason: '找不到「视频生成」入口，无法切换到视频模式', skills, ...pageInfo() };
  }
  pointerClick(button);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    if (toolbarState().inVideoMode) return { ok: true, picked: textOf(button) || attr(button, 'data-skill-id'), ...toolbarState() };
  }
  return { ok: false, reason: '已经点击「视频生成」，但模型/时长控件始终没有出现', ...toolbarState(), ...pageInfo() };
`;

/**
 * 打开某个 radix 下拉并选择目标项，随后回读控件文本。
 * 回读不一致即视为「参数未生效」，交由调用方阻断提交。
 */
const STEP_CHOOSE = `
  const controlSelector = __SELECTOR__;
  const wantKey = __KEY__;
  const wanted = __WANTED__;     // 菜单项里要匹配的文案
  const readback = __READBACK__; // 选完后触发器上应能看到的文本（模型只显示短名）
  const control = document.querySelector(controlSelector);
  if (!control) return { ok: false, reason: '页面上找不到该控件（可能未进入视频模式）', wanted, ...toolbarState(), ...pageInfo() };
  const before = triggerState(wantKey);
  const beforeSet = new Set(menuRoots());
  pointerClick(control);
  let root = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    root = pickMenu(beforeSet);
    if (root) break;
    await new Promise(r => setTimeout(r, 120));
  }
  if (!root) {
    return {
      ok: false,
      reason: '点击控件后没有出现菜单（radix 只认真实指针事件）',
      wanted, before: before.text, triggerOpen: triggerState(wantKey).open,
      openedMenuTexts: menuTexts(), ...pageInfo(),
    };
  }
  const options = menuOptions(root);
  const labels = [...new Set(options.map(textOf).filter(Boolean))].slice(0, 40);
  const exact = options.find(o => compact(textOf(o)) === compact(wanted));
  const target = exact || options.find(o => norm(textOf(o)).includes(norm(wanted)));
  if (!target) {
    pointerClick(control);
    return { ok: false, reason: '菜单里没有匹配项', wanted, available: labels, ...pageInfo() };
  }
  const picked = textOf(target);
  pointerClick(target);
  await new Promise(r => setTimeout(r, 600));
  const after = triggerState(wantKey);
  const applied = norm(after.text).includes(norm(readback));
  return {
    ok: applied,
    picked,
    before: before.text,
    after: after.text,
    available: labels,
    reason: applied ? undefined : '已点选菜单项，但触发器回读不一致，参数可能没有真正生效',
  };
`;

/**
 * 写入提示词：直接写入「平台可用的纯文本」（@图N 已在主进程转成参考图N）。
 * 实测：平台视频编辑器不支持内联图片节点，写入 U+FFFC 只会被当成普通文本，
 * 提交后消息里显示为方框（用户截图里的 OBJ）。因此这里不再写任何占位符。
 */
const STEP_SET_TEXT = `
  const list = editors();
  if (!list.length) return { ok: false, reason: '找不到提示词输入框（可能未登录、页面未加载完成或页面结构已变化）', ...pageInfo() };
  const editor = list[0];
  const value = __VALUE__;
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('delete');
  if (value && !document.execCommand('insertText', false, value)) {
    return { ok: false, reason: '输入框拒绝写入文本', ...pageInfo() };
  }
  await new Promise(r => setTimeout(r, 300));
  const readback = String(editor.innerText || editor.textContent || '');
  const strip = (s) => String(s || '').replace(/\\s+/g, '');
  return {
    ok: strip(readback) === strip(value),
    // 不一致时给出两边开头，便于实机校准（不是猜）
    actualText: strip(readback).slice(0, 120),
    expectedText: strip(value).slice(0, 120),
    hasAtomicMark: String(editor.textContent || '').includes(SEL.atomicMark),
    ...toolbarState(),
    ...pageInfo(),
  };
`;

/**
 * 时长增强（复用应用自带的 dola-duration-enhancer）：
 * 打开 localStorage 开关并写入秒数；增强器会在请求体里把 ability_param.duration 改写成该秒数。
 * 注意：工具栏文案与 16—30 网格依赖页面可见（元素尺寸为 0 时增强器跳过），
 * 所以「实际时长」以请求体回读为准，这里只负责把条件摆好并回报条件状态。
 */
const STEP_SET_DURATION_ENHANCEMENT = `
  const seconds = String(__SECONDS__);
  const enableKey = __ENABLE_KEY__;
  const secondsKey = __SECONDS_KEY__;
  const requiresModelLabel = __REQUIRES_MODEL__;
  const enhancerInstalled = Boolean(window.__DBM_DOLA_30_SECOND_ENHANCER__);
  const fetchPatched = Boolean(window.fetch && window.fetch.__dbmDola30SecondRequestPatch__ === true);
  const modelText = textOf(controlFor('video-model'));
  const modelOk = /2\\.5|seedance[^\\d]*2[^\\d]*5/i.test(String(modelText || '').replace(/\\s+/g, ''));
  try {
    localStorage.setItem(enableKey, '1');
    localStorage.setItem(secondsKey, seconds);
  } catch (error) {
    return { ok: false, reason: '无法写入时长增强开关：' + (error && error.message), modelText, enhancerInstalled, fetchPatched };
  }
  await new Promise(r => setTimeout(r, 400));
  const readback = { enable: localStorage.getItem(enableKey), seconds: localStorage.getItem(secondsKey) };
  return {
    ok: enhancerInstalled && fetchPatched && modelOk && readback.enable === '1' && readback.seconds === seconds,
    enhancerInstalled,
    fetchPatched,
    modelText,
    requiresModelLabel,
    modelOk,
    readback,
    reason: !enhancerInstalled
      ? '页面里没有检测到应用自带的时长增强器，无法保证 16—30 秒生效'
      : !fetchPatched
        ? '增强器的请求改写未安装（fetch 未被 patch），无法保证实际时长'
        : !modelOk
          ? '当前模型不是 ' + requiresModelLabel + '，增强器不会改写时长'
          : undefined,
  };
`;

/** 读取页面状态（含工具栏与发送按钮可用性），供提交前核实用 */
const STEP_READ_STATE = `
  const body = document.body ? document.body.innerText : '';
  return { ok: true, text: String(body).replace(/\\s+/g, ' ').slice(0, 800), url: location.href, ...toolbarState() };
`;

/**
 * 上传前把 file input 的 value 清空。
 * 实测（2026-09-23）：平台处理完上传后并不会清空 input.value，
 * 于是再次上传同一批图片时 FileList 没变化、change 事件不触发，
 * 结果是「输入框里还留着旧文件、页面上却没有缩略图」——会发出不带参考图的请求。
 */
const STEP_RESET_FILE_INPUT = `
  const input = document.querySelector(SEL.fileInput);
  if (!input) return { ok: true, found: false };
  const before = input.files ? input.files.length : 0;
  try { input.value = ''; } catch {}
  return { ok: true, found: true, clearedFrom: before, after: input.files ? input.files.length : 0 };
`;

/**
 * 参考图查询：限定在「当前会话的消息编辑器」容器内。
 * 实测（2026-09-23）：整页扫 img 会把历史消息、平台恢复的草稿附件、UI 装饰图都算进来，
 * 于是出现「本次 3 张、平台 6 张」；而这里的附件卡片类名是 image-wrapper-*（不是 thumb-card）、
 * 也没有 alt 文件名。因此容器从「文件输入 + 发送按钮的共同祖先」推导，
 * 身份用 blob URL（附件标识），顺序用 DOM 顺序。
 */
const STEP_ATTACHMENTS_STATE = `
  const input = document.querySelector(SEL.fileInput);
  const send = document.querySelector(SEL.sendButton);
  const editor = document.querySelector(SEL.editor);
  // 容器：在「编辑器/发送按钮的 guidance-input-* 祖先」里，选真正包含参考图缩略图的那一层。
  // 实测（2026-09-23）：附件缩略图不在工具栏那一行、也不一定在编辑器的直接祖先里，
  // 因此用「含 blob 图片的最内层 composer 祖先」自校准；没有任何附件时退回到最近的一层。
  const climb = (start) => {
    const list = [];
    let node = start;
    let guard = 0;
    while (node && guard < 40) {
      const cls = String(node.className || '');
      if (/guidance-input/.test(cls) && node.contains(input) && node.contains(send)) list.push(node);
      node = node.parentElement;
      guard++;
    }
    return list;
  };
  const hasBlob = (node) => [...node.querySelectorAll('img')].some(img => /^blob:/i.test(String(img.getAttribute('src') || '')));
  const candidates = climb(editor || send || input);
  const root = candidates.find(hasBlob) || candidates[0] || input;
  if (!root) return { ok: false, reason: '无法定位当前会话的输入容器', ...pageInfo() };
  // 卡片归组：实测两种真实类名——视频参考图条是 thumb-card-*（内含 delete-btn-*），
  // 会话输入区的图片附件是 image-wrapper-*；两者都按「含 blob 图的最内层卡片」归组。
  const cardOf = (img) => img.closest('[class*="thumb-card"]') || img.closest('[class*="image-wrapper"]') || img.parentElement;
  const blobs = [...root.querySelectorAll('img')].filter(img => /^blob:/i.test(String(img.getAttribute('src') || '')));
  const cards = [...new Set(blobs.map(cardOf))];
  const items = cards.map(card => {
    const img = card.querySelector('img[src^="blob:"]');
    return {
      url: String(img?.getAttribute('src') || ''),
      // alt = 上传时的原文件名（实测：asset_xxxx.png），是「跨会话可复核」的附件身份
      alt: String(img?.getAttribute('alt') || ''),
      cls: String(card.className || '').slice(0, 40),
      deletable: Boolean(card.querySelector('button[class*="delete-btn"]')),
    };
  });
  return {
    ok: true,
    rootCls: String(root.className || '').slice(0, 60),
    count: items.length,
    urls: items.map(item => item.url),
    items,
    alts: items.map(item => item.alt),
    pageUrl: String(location.href),
  };
`;

/**
 * 只移除「能确认属于本工具本次/上次尝试」的指定附件（按附件标识精确匹配）。
 * 实测（2026-09-23）：视频参考图卡片是 thumb-card-*，内含 button[class*="delete-btn"]；
 * 会话输入区的 image-wrapper-* 卡片没有删除入口，此时如实回报失败，不做别的动作。
 */
const STEP_REMOVE_CARDS = `
  const targets = __URLS__;
  const input = document.querySelector(SEL.fileInput);
  const send = document.querySelector(SEL.sendButton);
  const editorNode = document.querySelector(SEL.editor);
  const climb = (start) => {
    const list = [];
    let node = start;
    let guard = 0;
    while (node && guard < 40) {
      const cls = String(node.className || '');
      if (/guidance-input/.test(cls) && node.contains(input) && node.contains(send)) list.push(node);
      node = node.parentElement;
      guard++;
    }
    return list;
  };
  const hasBlob = (node) => [...node.querySelectorAll('img')].some(img => /^blob:/i.test(String(img.getAttribute('src') || '')));
  const candidates = climb(editorNode || send || input);
  const root = candidates.find(hasBlob) || candidates[0] || input;
  const cardOf = (img) => img.closest('[class*="thumb-card"]') || img.closest('[class*="image-wrapper"]') || img.parentElement;
  const removed = [];
  const refused = [];
  for (const url of targets) {
    const img = [...root.querySelectorAll('img[src^="blob:"]')].find(node => String(node.getAttribute('src') || '') === url);
    if (!img) { refused.push({ url: String(url).slice(0, 40), reason: '卡片已不在输入区' }); continue; }
    const card = cardOf(img);
    const btn = card.querySelector('button[class*="delete-btn"]');
    if (!btn) { refused.push({ url: String(url).slice(0, 40), reason: '该卡片没有删除入口（不能确认可移除）' }); continue; }
    btn.click();
    removed.push(String(url).slice(0, 40));
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: refused.length === 0, removed: removed.length, refused, ...pageInfo() };
`;

/**
 * 上传后核实：平台收到的附件是否就是本次的图片、顺序是否与「参考图N」一致、
 * 文本里是否写明了与附件对应的参考图编号。
 * 平台不提供内联图片节点，所以这里的「绑定正确」= 数量一致 + 顺序一致 + 文本标注一致。
 */
const STEP_VERIFY_REFS = `
  const expectedUrls = __URLS__;   // 本次上传得到的附件标识，按 参考图1..N 的顺序
  const expectedAlts = __ALTS__;   // 本次上传的文件名（平台 alt 原样回落），按同一顺序
  const labels = __LABELS__;
  const input = document.querySelector(SEL.fileInput);
  const send = document.querySelector(SEL.sendButton);
  const editorNode = document.querySelector(SEL.editor);
  const climb = (start) => {
    const list = [];
    let node = start;
    let guard = 0;
    while (node && guard < 40) {
      const cls = String(node.className || '');
      if (/guidance-input/.test(cls) && node.contains(input) && node.contains(send)) list.push(node);
      node = node.parentElement;
      guard++;
    }
    return list;
  };
  const hasBlob = (node) => [...node.querySelectorAll('img')].some(img => /^blob:/i.test(String(img.getAttribute('src') || '')));
  const candidates = climb(editorNode || send || input);
  const root = candidates.find(hasBlob) || candidates[0] || input;
  if (!root) return { ok: false, reason: '无法定位当前会话的输入容器', ...pageInfo() };
  const blobs = [...root.querySelectorAll('img')].filter(img => /^blob:/i.test(String(img.getAttribute('src') || '')));
  const cardOf = (img) => img.closest('[class*="thumb-card"]') || img.closest('[class*="image-wrapper"]') || img.parentElement;
  const cards = [...new Set(blobs.map(cardOf))];
  const urls = cards.map(card => String(card.querySelector('img[src^="blob:"]')?.getAttribute('src') || ''));
  const alts = cards.map(card => String(card.querySelector('img[src^="blob:"]')?.getAttribute('alt') || ''));
  const text = (() => { const list = editors(); return list[0] ? String(list[0].textContent || '') : ''; })();
  const countOk = urls.length === expectedUrls.length;
  const orderMatched = countOk && expectedUrls.every((u, i) => urls[i] === u);
  // 文件名序列：跨会话也适用的附件身份核对（alt = 上传时的原文件名）
  const altKnown = expectedAlts.filter(Boolean).length === expectedAlts.length && expectedAlts.length > 0;
  const altOrderMatched = altKnown && alts.length === expectedAlts.length && expectedAlts.every((a, i) => alts[i] === a);
  const missing = expectedUrls.filter(u => !urls.includes(u));
  const extra = urls.filter(u => !expectedUrls.includes(u));
  const missingLabels = labels.filter(l => !text.includes(l));
  return {
    ok: countOk && orderMatched && (!altKnown || altOrderMatched) && missingLabels.length === 0,
    expected: expectedUrls.length,
    attachmentCards: urls.length,
    orderMatched,
    altOrderMatched,
    actualAlts: alts,
    expectedAlts,
    missingCount: missing.length,
    extraCount: extra.length,
    labelsInText: labels.filter(l => text.includes(l)),
    missingLabels,
    hasAtomicMark: text.includes(SEL.atomicMark),
    editorText: text.slice(0, 200),
    reason: !countOk
      ? '输入区里的附件数量与本次不一致（本次 ' + expectedUrls.length + ' 张，输入区 ' + urls.length + ' 张，多出 ' + extra.length + ' 张、缺 ' + missing.length + ' 张）'
      : !orderMatched
        ? '输入区里附件顺序与「参考图1..N」不一致（按实际附件映射判断，不靠改编号掩盖）'
        : altKnown && !altOrderMatched
          ? '输入区里附件的文件名序列与本次不一致（平台显示 ' + alts.join('、') + '，本次 ' + expectedAlts.join('、') + '）'
          : missingLabels.length
            ? '文本里缺少参考图编号标注：' + missingLabels.join('、')
            : undefined,
  };
`;

/**
 * 点击发送后的「页面反应」观测。
 * 实测（2026-09-23 真实提交 att_5344bc651f4b / att_a3ccf555afb4）：
 * 点击确实命中了 #flow-end-msg-send，但 45 秒内既没拿到任务 ID，
 * 事后会话页也是空的（URL 变成新会话、没有任何消息）。
 * 也就是说「点了发送」不等于「平台开始生成」——必须能观察到页面真的起了反应。
 */
const STEP_SEND_REACTION = `
  const list = editors();
  const editor = list[0] || null;
  const text = editor ? String(editor.textContent || '') : '';
  const messages = document.querySelectorAll('[data-message-id]').length;
  const bodyText = String(document.body?.innerText || '');
  return {
    ok: true,
    editorEmpty: text.trim().length === 0,
    editorText: text.slice(0, 60),
    messages,
    url: location.href,
    // 页面上是否出现与生成相关的字眼（排队/生成中/失败/额度等）
    hints: (bodyText.match(/生成中|排队|生成失败|额度不足|次数不足|敏感|违规|不支持/g) || []).slice(0, 5),
  };
`;

/**
 * 读取「本次提交之后」平台新增的回复文本。
 * 关键：必须限定在本次提交产生的消息上 —— 旧会话里的受理/拒绝提示不能算到本次头上。
 * 判定方式：地址没变时按消息条数取增量；地址变了（平台新建会话）说明整页都是本次的。
 */
const STEP_READ_REPLIES = `
  const before = __BEFORE__;
  const nodes = [...document.querySelectorAll('[data-message-id]')];
  const urlChanged = String(location.href) !== String(before.url || "");
  const fresh = urlChanged ? nodes : nodes.slice(Math.max(0, Number(before.count) || 0));
  const replies = fresh.map(n => String(n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300));
  return { ok: true, count: nodes.length, newCount: fresh.length, urlChanged, newReplies: replies, url: location.href };
`;

/**
 * 读取本次生成结果（用于「生成成功」的判定与下载源解析）。
 * 匹配规则刻意保守：只在消息文本里出现「本次写入平台的提示词」时才认，避免把历史视频算到本次头上。
 * 同时回报视频地址与消息标识；地址取不到就如实返回空，由上层标成「未取得结果地址」。
 *
 * ⚠ 必须用 IIFE 隔离作用域：HELPERS 里已经声明了 norm / SEL / editors 等顶层标识符，
 *   直接写同名 const 会让整段页面脚本抛 SyntaxError（实测 2026-09-24：
 *   poll 一直报「页面脚本执行失败」，真实原因是 `Identifier 'norm' has already been declared`）。
 */
const STEP_READ_RESULT = `
  return (() => {
    const wanted = __TEXT__;
    const normText = (s) => String(s || '').replace(/\\s+/g, '');
    const key = normText(wanted).slice(0, 48);
    const nodes = [...document.querySelectorAll('[data-message-id]')];
    const items = nodes.map((node) => {
      const video = node.querySelector('video');
      return {
        messageId: String(node.getAttribute('data-message-id') || '').slice(0, 60),
        text: String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        hasVideo: Boolean(video),
        videoUrl: String(video ? (video.currentSrc || video.src || video.querySelector('source')?.src || '') : '').slice(0, 4000),
      };
    });
    // 本次提交对应的用户消息 = 最后一条包含本次提示词的消息；
    // 其后的消息就是平台对本次请求的回复（视频、拒绝说明或生成中提示）。
    let userIndex = -1;
    for (let i = 0; i < items.length; i++) {
      if (key && normText(items[i].text).includes(key)) userIndex = i;
    }
    const replies = userIndex >= 0 ? items.slice(userIndex + 1) : [];
    const scope = replies.length ? replies : items;
    const withVideo = scope.filter(it => it.hasVideo);
    const newest = withVideo.slice(-1)[0] || scope[scope.length - 1] || null;
    return {
      ok: true,
      matched: userIndex >= 0 ? 1 : 0,
      userIndex,
      replies: replies.map(it => it.text).slice(0, 6),
      hasVideo: withVideo.length > 0,
      videoUrl: withVideo.length ? withVideo[withVideo.length - 1].videoUrl : '',
      newest,
      videoCount: document.querySelectorAll('video').length,
      url: location.href,
    };
  })();
`;

/**
 * 点击发送。
 * 发送按钮 id 已实测为 #flow-end-msg-send（聊天模式下不存在，故必须先进入视频模式）。
 * 按钮不可用时明确报错，绝不盲点。
 */
const STEP_SEND = `
  const button = document.querySelector(SEL.sendButton);
  const state = toolbarState();
  if (!button) {
    const cands = [...document.querySelectorAll('button,[role="button"]')]
      .filter(el => visible(el) && /发送|生成|提交/i.test(textOf(el) + attr(el, 'aria-label')))
      .map(el => textOf(el) || attr(el, 'aria-label') || attr(el, 'id'))
      .slice(0, 12);
    return { ok: false, reason: '页面上找不到发送按钮 #flow-end-msg-send（可能未进入视频模式）', candidates: cands, ...state, ...pageInfo() };
  }
  const disabled = Boolean(button.disabled) || attr(button, 'aria-disabled') === 'true' || attr(button, 'data-disabled') === 'true';
  if (disabled) {
    return {
      ok: false,
      reason: '发送按钮处于禁用状态（提示词为空或参数未就绪），未点击',
      candidates: [attr(button, 'id')],
      ...state,
      ...pageInfo(),
    };
  }
  pointerClick(button);
  await new Promise(r => setTimeout(r, 800));
  const after = toolbarState();
  const editorsNow = editors();
  return {
    ok: true,
    clicked: attr(button, 'id') || 'flow-end-msg-send',
    candidates: [attr(button, 'id')],
    sendDisabledAfter: after.sendDisabled,
    editorText: (() => { const list = editorsNow; return list[0] ? String(list[0].textContent || '').slice(0, 120) : ''; })(),
    // 点击前的指纹：用于判断点击后页面到底有没有起反应
    beforeLength: (() => { const list = editorsNow; return list[0] ? String(list[0].textContent || '').length : 0; })(),
    beforeMessages: document.querySelectorAll('[data-message-id]').length,
    beforeUrl: String(location.href),
  };
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

/**
 * 从「视频生成请求体」里读出真正的时长（ability_type === 17 且 ability_param.duration）。
 * 只返回数字，不返回正文 —— 正文里可能有提示词等敏感内容。
 * 这是「实际提交时长」的唯一可信来源：增强器正是改写这里，而不是改平台控件文案。
 */
function collectAbilityDuration(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return "";
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 60)) {
      const found = collectAbilityDuration(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (Number(value.ability_type) === 17) {
    let param = value.ability_param;
    if (typeof param === "string") {
      try {
        param = JSON.parse(param);
      } catch {
        param = null;
      }
    }
    const seconds = Number(param?.duration);
    if (Number.isFinite(seconds) && seconds > 0) return String(seconds);
  }
  for (const item of Object.values(value).slice(0, 100)) {
    if (item && typeof item === "object") {
      const found = collectAbilityDuration(item, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

/** 单个步骤：把计划里的文本与图片依次写入编辑器 */
function createDolaDriver(options = {}) {
  const resolveContents = options.resolveContents;
  const log = options.log || (() => {});

  const state = {
    verified: false, // 实机验证前一律为 false
    pages: new Map(),
    // 每个账号页面的「激活」结果（生命周期/焦点模拟），落进步骤证据便于事后核对
    activation: new Map(),
    // 本工具在「某账号 + 某分镜」输入区上传过的附件：assetId ↔ 平台附件标识（blob URL）
    attachments: new Map(),
    // 每账号的上传/提交互斥锁：同一账号同时只跑一次，防止重复点击造成附件叠加
    locks: new Map(),
  };

  /** 同一账号的上传与提交串行化（不同账号互不阻塞） */
  async function withAccountLock(accountId, task) {
    const previous = state.locks.get(accountId) || Promise.resolve();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    state.locks.set(
      accountId,
      previous.then(() => gate)
    );
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  async function pageFor(accountId) {
    const existing = state.pages.get(accountId);
    if (existing && !existing.isDestroyed?.()) return existing;
    if (resolveContents) {
      const contents = await resolveContents(accountId);
      state.pages.set(accountId, contents);
      return contents;
    }
    // 直接借用应用自己为账号挂的 webview：已登录、带应用 preload，且不需要我们自己加载页面。
    // 实测（2026-09-23）：刚点开账号时 webContents.getURL() 会短暂为空，
    // 必须等它真正落到 dola 上再操作，否则会误判成「页面不在 dola 上」。
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastReason = "";
    for (;;) {
      const found = findAccountWebview(accountId);
      if (found.ok) {
        for (const candidate of found.candidates) {
          const remaining = Math.max(1000, deadline - Date.now());
          const ready = await waitForPageReady(candidate, Math.min(READY_TIMEOUT_MS, remaining));
          if (!ready.ok) {
            lastReason = `${ready.reason}（${ready.url || "(空白)"}）`;
            continue;
          }
          const probe = await probeView(candidate);
          if (probe.ok) {
            // 关掉后台节流：账号不是当前标签页时，页面才不会停摆
            try {
              if (typeof candidate.setBackgroundThrottling === "function") {
                candidate.setBackgroundThrottling(false);
              }
            } catch {}
            // 实测（2026-09-24 提交前校验）：非当前账号的页面 document.hidden=true，
            // 15 秒无响应的「写入提示词」正是这种隐藏页被 Chromium 冻结/降级的症状。
            // 借调试通道把页面生命周期拉回 active，并模拟焦点，避免驱动隐藏页时被卡住。
            const activation = await ensurePageActive(candidate);
            state.activation.set(accountId, activation);
            log("dola-webview-resolved", {
              accountId,
              ...describeView(candidate),
              ...sessionEvidence(candidate, accountId),
              activation,
            });
            state.pages.set(accountId, candidate);
            return candidate;
          }
          lastReason = `脚本通道无响应：${probe.reason || "无响应"}（${ready.url || "(空白)"}）`;
        }
      } else {
        lastReason = found.reason;
        log("dola-webview-not-found", { accountId, reason: found.reason });
      }
      if (Date.now() >= deadline) break;
      await sleep(500);
    }
    const evidence = (findAccountWebview(accountId).evidence || [])
      .map(
        (item) =>
          `#${item.webContentsId} ${item.url || "(空白)"}${item.loading ? " [仍在加载]" : ""}${
            item.crashed ? " [渲染进程已崩溃]" : ""
          } 分区：${item.partition || "(未知)"}${item.partitionMatches ? "(匹配)" : "(不匹配)"}`
      )
      .join("；");
    throw new Error(
      `账号 ${accountId} 的页面在 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒内没有就绪：${lastReason}${
        evidence ? `。实测状态：${evidence}` : ""
      }`
    );
  }

  /** 观察点击发送后页面有没有真的起反应（不编造，只比对前后事实） */
  async function waitForSendReaction(contents, sendStep, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      const now = await evaluate(contents, STEP_SEND_REACTION).catch(() => null);
      if (now?.ok) {
        last = now;
        const changedUrl = String(now.url || "") !== String(sendStep?.beforeUrl || "");
        const shorter = Number(sendStep?.beforeLength) > 0 && String(now.editorText || "").length < Number(sendStep.beforeLength);
        const moreMessages = Number(now.messages) > Number(sendStep?.beforeMessages || 0);
        if (now.editorEmpty || changedUrl || moreMessages || shorter || (now.hints || []).length) {
          return { ...now, started: true, changedUrl, moreMessages, editorEmptied: Boolean(now.editorEmpty) };
        }
      }
      if (Date.now() >= deadline) {
        return { ...(last || {}), started: false, reason: "页面没有反应" };
      }
      await sleep(600);
    }
  }

  async function chooseOption(contents, selector, key, wanted, readback) {
    const code = STEP_CHOOSE.replace("__SELECTOR__", JSON.stringify(selector))
      .replace("__KEY__", JSON.stringify(key))
      .replace("__WANTED__", JSON.stringify(wanted))
      .replace("__READBACK__", JSON.stringify(readback));
    return evaluate(contents, code);
  }

  /**
   * 逐张上传并建立「assetId → 平台附件标识（blob URL）」映射。
   * 归属判定（实测 2026-09-23）：平台附件卡的 img.alt = 上传时的原文件名（例如 asset_3f21....png），
   *   因此「本次要传的文件名」可以把输入区里已有的附件认成本工具自己的，跨重启也成立（blob URL 则不行）。
   * 复用优先：本次会话的 URL 映射 → 文件名匹配 → 都没有才真正上传，避免重试时重复上传。
   * 只清理「能确认属于本工具」的多余附件（按文件名确认，且卡片有删除入口）；
   *   来源不明的卡片一律不动，交由上层按冲突处理。
   */
  async function attachImages(contents, uploads, knownUrls = []) {
    const wanted = (uploads || []).filter((item) => item?.filePath);
    if (!wanted.length) return { ok: true, skipped: true, reason: "没有参考图片", mapping: [] };
    const wantedNames = new Set(wanted.map((item) => baseNameOf(item.filePath)).filter(Boolean));
    const dbg = contents.debugger;
    const owned = !dbg.isAttached();
    const mapping = [];
    const failed = [];
    const claimed = new Set();
    try {
      if (owned) dbg.attach("1.3");
      await dbg.sendCommand("DOM.enable", {});

      /** 一张一张地「复用或补传」：只补缺失/失败的，已有且属于本工具的直接复用 */
      const runPass = async () => {
        for (const item of wanted) {
          const fileName = baseNameOf(item.filePath);
          const recorded = knownUrls.find((entry) => entry.assetId === item.assetId);
          const stateNow = await evaluate(contents, STEP_ATTACHMENTS_STATE);
          const present = (stateNow.items || []).map((card) => card.url);
          if (recorded && present.includes(recorded.url) && !claimed.has(recorded.url)) {
            claimed.add(recorded.url);
            mapping.push({ ...recorded, reused: true, reusedBy: "session-url" });
            continue;
          }
          // 文件名归属：输入区里已有同名附件（本工具上次尝试留下的）→ 直接复用，不再重复上传
          const byName = (stateNow.items || []).find(
            (card) => card.alt && card.alt === fileName && !claimed.has(card.url)
          );
          if (byName) {
            claimed.add(byName.url);
            mapping.push({
              assetId: item.assetId,
              token: item.token,
              label: item.label,
              name: item.name,
              filePath: item.filePath,
              url: byName.url,
              reused: true,
              reusedBy: "file-name",
            });
            continue;
          }
          const seen = new Set([...(stateNow.urls || []), ...mapping.map((m) => m.url)]);
          await evaluate(contents, STEP_RESET_FILE_INPUT);
          const { root } = await dbg.sendCommand("DOM.getDocument", { depth: 1 });
          const { nodeId } = await dbg.sendCommand("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: DOLA_SELECTORS.fileInput,
          });
          if (!nodeId) {
            // 没有文件入口就不能上传：立刻阻断并说明，不静默跳过（否则会发出不带参考图的请求）
            return { ok: false, reason: "当前页面没有可用的文件上传入口，无法附加参考图片", mapping };
          }
          await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: [item.filePath] });
          // 等这一张真的进入输入区（最多 8 秒），拿到它的附件标识
          let url = "";
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            await sleep(300);
            const now = await evaluate(contents, STEP_ATTACHMENTS_STATE);
            const fresh = (now.urls || []).find((value) => value && !seen.has(value));
            if (fresh) {
              url = fresh;
              break;
            }
          }
          if (!url) {
            failed.push(item);
            continue;
          }
          claimed.add(url);
          mapping.push({ assetId: item.assetId, token: item.token, label: item.label, name: item.name, filePath: item.filePath, url, reused: false });
        }
        return null;
      };

      /** 只移除「按文件名确认属于本工具」的指定卡片；移除不掉就如实回报 */
      const removeCards = async (urls) => {
        const step = await evaluate(contents, STEP_REMOVE_CARDS.replace("__URLS__", JSON.stringify(urls)));
        return {
          removed: Number(step?.removed) || 0,
          refused: (step?.refused || []).map((entry) => entry?.reason || "未知原因"),
        };
      };

      /** 核对输入区：数量、顺序、以及还剩下什么（属本工具的 vs 来源不明的） */
      const audit = async () => {
        const now = await evaluate(contents, STEP_ATTACHMENTS_STATE);
        const items = now.items || [];
        const left = items.filter((card) => card.url && !claimed.has(card.url));
        return {
          items,
          ownExtras: left.filter((card) => card.alt && wantedNames.has(card.alt)),
          strangers: left.filter((card) => !card.alt || !wantedNames.has(card.alt)),
          // 顺序：输入区的第 i 张必须就是 mapping[i]（参考图i+1）
          orderOk: items.length === mapping.length && mapping.every((item, i) => items[i]?.url === item.url),
        };
      };

      const abortFirst = await runPass();
      if (abortFirst) return { ...abortFirst, failedNames: failed.map((item) => baseNameOf(item.filePath)) };
      let state = await audit();
      let removedExtras = 0;
      let rebuilt = false;

      if (state.strangers.length) {
        return {
          ok: false,
          count: mapping.length,
          expected: wanted.length,
          mapping,
          failedNames: failed.map((item) => baseNameOf(item.filePath)),
          strangers: state.strangers.map((card) => ({ alt: card.alt, cls: card.cls })),
          reason: `上传期间输入区出现了 ${state.strangers.length} 张来源不明的附件，未提交也不擅自清空`,
        };
      }

      // 本工具残留的多余附件（同名但本次用不到）：确认可删才删，删不掉就阻断
      if (state.ownExtras.length) {
        const step = await removeCards(state.ownExtras.map((card) => card.url));
        removedExtras = step.removed;
        if (step.refused.length) {
          return {
            ok: false,
            count: mapping.length,
            expected: wanted.length,
            mapping,
            failedNames: failed.map((item) => baseNameOf(item.filePath)),
            reason: `本工具上次留下的多余附件无法自动移除（${step.refused.join("；")}），未提交`,
          };
        }
        state = await audit();
      }

      // 顺序不一致（典型场景：复用了上次留下的附件，而平台顺序与参考图编号不同）：
      // 不靠改编号掩盖——把确认属于本工具的卡片全部移除后按参考图顺序重传一遍，重建确定性顺序。
      if (state.items.length && !state.orderOk) {
        const ownUrls = state.items.map((card) => card.url);
        const step = await removeCards(ownUrls);
        if (step.refused.length || step.removed !== ownUrls.length) {
          return {
            ok: false,
            count: mapping.length,
            expected: wanted.length,
            mapping,
            failedNames: failed.map((item) => baseNameOf(item.filePath)),
            reason: `输入区附件顺序与参考图编号不一致，且无法自动重建（${step.refused.join("；") || "移除未全部成功"}），未提交`,
          };
        }
        // 全部清掉后按参考图1..N 重传
        mapping.length = 0;
        failed.length = 0;
        claimed.clear();
        rebuilt = true;
        const abortRebuild = await runPass();
        if (abortRebuild) return { ...abortRebuild, rebuilt: true };
        state = await audit();
      }

      return {
        ok: failed.length === 0 && mapping.length === wanted.length && state.orderOk,
        count: mapping.length,
        expected: wanted.length,
        mapping,
        reused: mapping.filter((item) => item.reused).length,
        removedExtras,
        rebuilt,
        failedNames: failed.map((item) => baseNameOf(item.filePath)),
        reason: failed.length
          ? `有 ${failed.length} 张参考图上传后没有出现在输入区`
          : !state.orderOk
            ? "重建后输入区附件顺序仍与参考图编号不一致"
            : undefined,
      };
    } catch (error) {
      return { ok: false, reason: error?.message || String(error), mapping };
    } finally {
      if (owned && dbg.isAttached()) {
        try {
          dbg.detach();
        } catch {}
      }
    }
  }

  /**
   * 等待页面发出视频生成请求并回读其中的任务 ID（不猜字段，取不到就报 unknown）。
   * 同时记录「有没有发出生成类请求、平台回了什么状态码」——
   * 这是区分「点击没生效」和「点了但拿不到任务 ID」的关键证据（URL 只保留 host+path，丢弃查询串）。
   */
  async function watchForTaskId(contents, timeoutMs) {
    const dbg = contents.debugger;
    const owned = !dbg.isAttached();
    const seen = { taskId: "", ids: [], error: "", requests: [], submittedDuration: "" };
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const noteRequest = (method, url, status) => {
      try {
        const parsed = new URL(String(url));
        if (!/(^|\.)dola\.com$|(^|\.)doubao\.com$/i.test(parsed.hostname)) return;
        // 上传/素材类请求不算生成请求
        if (/(upload|material|attachment|storage|bytevcloud|vod|tos)([/?#_.-]|$)/i.test(parsed.pathname)) return;
        const key = `${method} ${parsed.pathname}`;
        if (seen.requests.some((item) => item.key === key)) return;
        if (seen.requests.length >= 12) return;
        seen.requests.push({ key, method, path: parsed.pathname.slice(0, 120), status: status ?? null });
      } catch {}
    };
    const onMessage = (_event, method, params) => {
      try {
        if (method === "Network.responseReceived") {
          noteRequest("RESP", params?.response?.url, params?.response?.status);
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
          return;
        }
        if (method === "Network.requestWillBeSent") {
          noteRequest(String(params?.request?.method || "GET"), params?.request?.url, null);
          // 从请求体里回读「实际提交的时长」（只留数字，不留正文）
          try {
            const post = params?.request?.postData;
            if (post && post.length < 400000 && !seen.submittedDuration) {
              const seconds = collectAbilityDuration(JSON.parse(post));
              if (seconds) seen.submittedDuration = seconds;
            }
          } catch {}
        }
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

  const api = {
    id: "dola",
    verified: state.verified,

    /** 对外入口：同一账号串行（互斥锁），不同账号可并发 */
    async submit(args) {
      return withAccountLock(args?.accountId, () => api._submit(args));
    },

    async _submit({ accountId, plan, onStep, dryRun = false }) {
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
      const fail = (message, extra = {}) => ({ outcome: "failed", message, steps, ...extra });

      let contents;
      try {
        contents = await pageFor(accountId);
      } catch (error) {
        const reason = error?.message || String(error);
        record("openPage", { ok: false, reason });
        return fail(`无法打开账号页面：${reason}`);
      }
      if (!plan?.valid) {
        return fail(`计划无效：${(plan?.errors || []).join("；")}`);
      }

      // 归属证据：只有能证明「本进程 + 该账号隔离会话」时才继续操作
      const evidence = sessionEvidence(contents, accountId);
      record("openPage", {
        ok: evidence.partitionMatches,
        ...describeView(contents),
        ...evidence,
        activation: state.activation.get(accountId) || null,
      });
      if (!evidence.partitionMatches) {
        return fail(
          `账号页面的会话归属无法核实（期望 ${evidence.expectedPartition}），已停止操作该页面`
        );
      }
      if (evidence.storageUnderUserData === false) {
        return fail(
          `账号会话的存储路径不在本实例数据目录下（会话存储：${evidence.storagePath || "未知"}），已停止操作该页面`
        );
      }

      // 1) 等页面就绪：先前「脚本执行超时」就是因为页面没加载完就操作
      const ready = await waitForPageReady(contents);
      record("waitReady", ready);
      if (!ready.ok) return fail(`页面未就绪：${ready.reason}`);

      // 2) 进入视频生成模式（聊天模式下三个参数控件根本不存在）
      const mode = await evaluate(contents, STEP_ENTER_VIDEO);
      record("enterVideoMode", mode);
      if (!mode?.ok) {
        return fail(`无法进入视频生成模式：${mode?.reason || "未知原因"}`);
      }

      // 2b) 等输入区就绪：进入视频模式后页面会重渲染，实测出现过「找不到输入框」与「脚本 15 秒无响应」
      //     （真实提交 att_47716bb2e812 / att_de77d7a10f0f），所以先等编辑器/上传入口/发送按钮齐全
      const composer = await waitForComposer(contents);
      record("waitComposer", composer);
      if (!composer?.ok) return fail(`输入区未就绪：${composer?.reason || "编辑器/上传入口/发送按钮不全"}`);

      // 3) 先读输入区已有附件：本工具传过的（本次会话的 URL 映射，或文件名对得上）会被复用；
      //    来源不明的停下报告冲突（绝不擅自清空）
      const attachKey = `${accountId}|${plan.storyboardId}`;
      const knownAttachments = state.attachments.get(attachKey) || [];
      const ourFileNames = new Set((plan.references || []).map((item) => baseNameOf(item.filePath)).filter(Boolean));
      const preAttach = await evaluate(contents, STEP_ATTACHMENTS_STATE);
      record("attachmentsPre", {
        ok: preAttach?.ok,
        count: preAttach?.count ?? 0,
        rootCls: preAttach?.rootCls,
        alts: preAttach?.alts || [],
      });
      if (!preAttach?.ok) return fail(`无法读取输入区状态：${preAttach?.reason || "未知原因"}`);
      const preItems = preAttach.items || [];
      const attributable = (card) =>
        knownAttachments.some((entry) => entry.url === card.url) || (card.alt && ourFileNames.has(card.alt));
      const foreign = preItems.filter((card) => !attributable(card));
      if (foreign.length) {
        return {
          outcome: "failed",
          errorCode: "ATTACHMENT_CONFLICT",
          accepted: false,
          retryable: false,
          needsUser: true,
          evidence: {
            kind: "attachment-conflict",
            unknown: foreign.length,
            known: preItems.length - foreign.length,
            foreignAlts: foreign.map((card) => card.alt || "(无文件名)"),
          },
          message: `输入区里已有 ${foreign.length} 张来源不明的参考图（可能是平台恢复的草稿或手工加入的），为避免发错图片，本次不提交、也不擅自清空；请在平台输入区手动清空后重试`,
          steps,
        };
      }

      // 4) 写入提示词：@图N 已在主进程转成「参考图N」，不再写入任何占位符
      const textStep = await evaluateIdempotent(contents, STEP_SET_TEXT.replace("__VALUE__", JSON.stringify(plan.platformText || "")));
      record("setPrompt", textStep);
      if (!textStep?.ok) {
        return fail(`写入提示词失败：${textStep?.reason || "编辑器回读与预期不一致"}`);
      }

      // 5) 参数必须在平台上真正生效：任何一项设不上就阻断，绝不用平台默认值继续
      const target = plan.params;
      const modelStep = await chooseOption(
        contents,
        DOLA_SELECTORS.modelControl,
        "video-model",
        target.modelLabel,
        target.modelTrigger
      );
      record("chooseModel", modelStep);
      if (!modelStep?.ok) return fail(`模型未生效：${modelStep?.reason || "选择失败"}（期望 ${target.modelLabel}）`);

      // 5b) 时长：原生档位直接设置；16—30 秒属于增强，先把平台档位设成原生基线，
      //     再由应用自带的增强器在请求体里改写成目标秒数（实际时长以请求体回读为准）
      const isEnhanced = target.durationMode === "enhanced";
      const baseDuration = isEnhanced ? "10" : target.duration;
      const durationStep = await chooseOption(
        contents,
        DOLA_SELECTORS.durationControl,
        "video-duration",
        `${baseDuration}s`,
        `${baseDuration}s`
      );
      record("chooseDuration", durationStep);
      if (!durationStep?.ok) {
        return fail(`时长未生效：${durationStep?.reason || "选择失败"}（平台档位期望 ${baseDuration}s）`);
      }

      if (isEnhanced) {
        const spec = plan.durationEnhancement || {};
        const enhanceStep = await evaluate(
          contents,
          STEP_SET_DURATION_ENHANCEMENT.replace("__SECONDS__", JSON.stringify(String(target.duration)))
            .replace("__ENABLE_KEY__", JSON.stringify("dbm_dola_enable_30s_v1"))
            .replace("__SECONDS_KEY__", JSON.stringify("dbm_dola_duration_seconds_v2"))
            .replace("__REQUIRES_MODEL__", JSON.stringify(target.modelLabel))
        );
        record("setDurationEnhancement", { ...enhanceStep, requiredSeconds: target.duration, requiresModel: spec.requiresModel });
        if (!enhanceStep?.ok) {
          // 不静默降级到 10 秒：条件不满足就阻断，并说明原因
          return fail(`时长增强未就绪：${enhanceStep?.reason || "条件不满足"}（要求 ${target.duration} 秒）`);
        }
      } else {
        record("setDurationEnhancement", { ok: true, skipped: true, reason: `使用平台原生 ${target.duration} 秒，未启用增强` });
      }

      if (target.ratio) {
        const ratioStep = await chooseOption(
          contents,
          DOLA_SELECTORS.ratioControl,
          "video-ratio",
          target.ratio,
          target.ratio
        );
        record("chooseRatio", ratioStep);
        if (!ratioStep?.ok) return fail(`比例未生效：${ratioStep?.reason || "选择失败"}（期望 ${target.ratio}）`);
      } else {
        record("chooseRatio", { ok: true, skipped: true, reason: "未设置比例，使用平台默认比例（无法回读核实）" });
      }

      // 6) 逐张上传参考图（已传过的复用，只补缺失），再按「附件标识 + 顺序 + 文本编号」三重复核
      const refList = plan.references || [];
      const refLabels = refList.map((item) => item.label).filter(Boolean);
      const uploadStep = await withTimeout(attachImages(contents, refList, knownAttachments), IMAGE_TIMEOUT_MS, {
        ok: false,
        reason: `附加参考图超时（${IMAGE_TIMEOUT_MS / 1000} 秒）`,
      });
      record("attachImages", {
        ok: uploadStep.ok,
        count: uploadStep.count,
        expected: uploadStep.expected,
        reused: (uploadStep.mapping || []).filter((item) => item.reused).length,
        reusedBy: (uploadStep.mapping || []).filter((item) => item.reused).map((item) => item.reusedBy),
        removedExtras: uploadStep.removedExtras,
        rebuilt: Boolean(uploadStep.rebuilt),
        failedNames: uploadStep.failedNames,
        reason: uploadStep.reason,
      });
      if (!uploadStep.ok) {
        return fail(`参考图上传未完成：${uploadStep.reason || "有图片没有出现在输入区"}`);
      }
      const mapping = uploadStep.mapping || [];
      state.attachments.set(attachKey, mapping);

      // 实测（2026-09-23）：平台在上传参考图的过程中可能重渲染并清空输入框里的文本，
      // 因此上传完成后重新写入一次提示词（幂等），否则后面「文本里有没有参考图N」会被误判成失败。
      const textStep2 = await evaluateIdempotent(contents, STEP_SET_TEXT.replace("__VALUE__", JSON.stringify(plan.platformText || "")));
      record("setPromptAfterUpload", { ok: textStep2?.ok, retried: textStep2?.retried, actualText: textStep2?.actualText, reason: textStep2?.reason });
      if (!textStep2?.ok) {
        return fail(`上传后重新写入提示词失败：${textStep2?.reason || "编辑器回读与预期不一致"}`);
      }

      const refsStep = await evaluate(
        contents,
        STEP_VERIFY_REFS.replace("__URLS__", JSON.stringify(mapping.map((item) => item.url)))
          .replace("__ALTS__", JSON.stringify(mapping.map((item) => baseNameOf(item.filePath) || "")))
          .replace("__LABELS__", JSON.stringify(refLabels))
      );
      record("verifyRefs", {
        ok: refsStep?.ok,
        expected: refsStep?.expected,
        attachmentCards: refsStep?.attachmentCards,
        orderMatched: refsStep?.orderMatched,
        altOrderMatched: refsStep?.altOrderMatched,
        actualAlts: refsStep?.actualAlts,
        extraCount: refsStep?.extraCount,
        missingCount: refsStep?.missingCount,
        labelsInText: refsStep?.labelsInText,
        reason: refsStep?.reason,
      });
      if (!refsStep?.ok) {
        // 引用没对上就提交，等于白白消耗额度：这里阻断并说明能力差异
        return fail(
          `参考图未核实通过：${refsStep?.reason || "附件映射不一致"}（本次 ${mapping.length} 张，输入区 ${
            refsStep?.attachmentCards ?? 0
          } 张，顺序一致：${refsStep?.orderMatched ? "是" : "否"}）`
        );
      }

      // 7) 发送前回读：三个参数 + 发送按钮可用性
      const preflight = await evaluate(contents, STEP_READ_STATE);
      record("readState", preflight);
      if (!preflight?.ok) return fail("提交前无法读取页面状态");

      // 7b) 提交前校验模式：走到「发送前」为止就返回，不点击发送、不消耗额度。
      //     用于用户要求的「上传 → 校验 → 重试」多轮验收，以及正式提交前的自查。
      if (dryRun) {
        const okCount = mapping.length;
        const detail = `编辑器文本与参数已回读；参考图 ${okCount} 张已按 参考图1..N 的顺序落到平台，未点击发送`;
        if (typeof onStep === "function") {
          try {
            onStep({ step: "precheckDone", ok: true, count: okCount, detail });
          } catch {}
        }
        return {
          outcome: "dry-run",
          accepted: false,
          retryable: false,
          needsUser: false,
          message: `提交前校验通过（未发送）：${detail}`,
          evidence: {
            kind: "precheck",
            attachments: mapping.map((item) => ({
              assetId: item.assetId,
              label: item.label,
              url: String(item.url || "").slice(0, 60),
              reused: Boolean(item.reused),
              reusedBy: item.reusedBy || "",
            })),
            attachmentCards: refsStep?.attachmentCards,
            orderMatched: refsStep?.orderMatched,
            altOrderMatched: refsStep?.altOrderMatched,
            actualAlts: refsStep?.actualAlts,
            labelsInText: refsStep?.labelsInText,
            sendDisabled: preflight?.sendDisabled,
            durationMode: plan.params?.durationMode || "native",
          },
          steps,
        };
      }

      // 发送前才挂网络监听，避免把前面的步骤耗时算进等待窗口
      const watcher = watchForTaskId(contents, SEND_TIMEOUT_MS);

      const sendStep = await evaluate(contents, STEP_SEND);
      record("send", sendStep);
      if (!sendStep?.ok) {
        return fail(
          `${sendStep?.reason || "点击发送失败"}；页面候选控件：${(sendStep?.candidates || []).join(" | ") || "无"}`
        );
      }

      // 点击成功 ≠ 平台开始生成：先确认页面真的起了反应（编辑器被清空 / 出现新消息 / 地址变化）
      const reaction = await withTimeout(waitForSendReaction(contents, sendStep), 12000, {
        ok: false,
        reason: "等待页面反应超时",
      });
      record("sendReaction", reaction);
      if (!reaction?.started) {
        // 点击没有任何反应 = 本次请求没发出去，属于可重试的临时状态（但绝不在这里自动重发）
        return {
          ...fail(
            `已点击发送按钮，但 12 秒内页面没有任何反应（编辑器内容未被消费、没有新消息、地址未变化），说明这次点击没有真正提交${
              reaction?.hints?.length ? `；页面提示：${reaction.hints.join("、")}` : ""
            }`
          ),
          accepted: false,
          retryable: true,
          evidence: { kind: "no-reaction" },
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
      const durationEvidence = {
        required: plan.params?.duration || "",
        // 实际提交的时长以请求体回读为准（增强器改写的正是这里）
        submitted: watched.submittedDuration || "",
        mode: plan.params?.durationMode || "native",
      };
      if (watched.taskId) {
        return {
          outcome: "ok",
          platformTaskId: watched.taskId,
          state: "queued",
          accepted: true,
          acceptanceEvidence: { kind: "task-id", taskId: watched.taskId },
          durationEvidence,
          message: "已点击发送，并从平台响应中取得任务 ID",
          steps,
        };
      }

      // 没有任务 ID：先看平台是不是明确说了「没有开始生成」，再看是不是已受理（费用预告/生成中）
      const replies = await evaluate(
        contents,
        STEP_READ_REPLIES.replace("__BEFORE__", JSON.stringify({ count: sendStep?.beforeMessages || 0, url: sendStep?.beforeUrl || "" }))
      ).catch(() => null);
      const replyText = (replies?.newReplies || []).join(" \n ");
      const verdict = replies?.ok ? classifyPlatformReply(replyText) : null;
      if (verdict) {
        record("platformReply", { ok: false, reason: verdict.label, excerpt: verdict.excerpt, count: replies?.count });
        // 平台明确拒绝：不可自动重试，也不换素材/换模型，交给人处理
        return {
          outcome: "failed",
          errorCode: verdict.code,
          accepted: false,
          retryable: false,
          needsUser: true,
          evidence: { kind: "platform-reject", code: verdict.code, excerpt: verdict.excerpt },
          message: `${verdict.label}；平台原文：${verdict.excerpt}`,
          steps,
        };
      }

      const acceptance = replies?.ok ? classifyAcceptance(replyText) : null;
      if (acceptance) {
        record("platformReply", { ok: true, reason: acceptance.note, excerpt: acceptance.excerpt, count: replies?.count });
        // 已受理但没拿到任务 ID：停止重复提交，转入监控（不宣告成功）
        return {
          outcome: "accepted",
          accepted: true,
          acceptanceEvidence: { kind: "platform-message", codes: acceptance.codes, strength: acceptance.strength, excerpt: acceptance.excerpt },
          durationEvidence,
          state: "queued",
          message: `${acceptance.note}；平台原文：${acceptance.excerpt}`,
          steps,
        };
      }
      if (replies?.ok) {
        record("platformReply", {
          ok: true,
          count: replies?.count,
          reason: `平台上没有出现受理/拒绝类回复（本次提交后新增消息 ${(replies.newReplies || []).length} 条）`,
        });
      }

      const observed = (watched.requests || []).map((item) => `${item.method} ${item.path}${item.status ? `→${item.status}` : ""}`);
      const rateLimited = (watched.requests || []).find((item) => Number(item.status) === 429 || Number(item.status) >= 500);
      return {
        outcome: "unknown",
        accepted: false,
        // 明确「没有受理证据」时才允许自动重试；这里先把裁决权交给编排层（见 runner 的重试策略）
        retryable: Boolean(rateLimited),
        retryAfterMs: rateLimited?.retryAfterMs || 0,
        evidence: { kind: "no-acceptance-evidence", requests: watched.requests || [] },
        durationEvidence,
        message: `${watched.error || "已点击发送，但未在超时时间内确认平台任务 ID"}，未重复提交；发送按钮命中：${
          sendStep?.clicked || "未知"
        }${observed.length ? `；观察到的网络请求：${observed.join(" | ")}` : "；超时窗口内没有观察到任何生成类网络请求"}`,
        observedIds: watched.ids,
        observedRequests: watched.requests || [],
        steps,
      };
    },

    /** 读取本次生成结果：按「本次写入平台的提示词」在消息里匹配，并带回平台对该请求的回复 */
    async readResult({ accountId, attempt }) {
      let contents;
      try {
        contents = await pageFor(accountId);
      } catch (error) {
        return { found: false, reason: `无法读取账号页面：${error?.message || error}` };
      }
      const prompt = String(attempt?.params?.prompt || "").trim();
      const text = prompt ? toPlatformText(buildSegments(prompt, attempt?.refs || [], new Map())) : "";
      const step = await evaluate(contents, STEP_READ_RESULT.replace("__TEXT__", JSON.stringify(text || ""))).catch(() => null);
      if (!step?.ok) return { found: false, reason: step?.reason || "页面状态不可读取" };
      return {
        found: Boolean(step.hasVideo && step.videoUrl),
        matched: step.matched,
        userIndex: step.userIndex,
        replies: step.replies || [],
        hasVideo: Boolean(step.hasVideo),
        videoCount: step.videoCount,
        videoUrl: String(step.videoUrl || ""),
        messageId: String(step.newest?.messageId || ""),
        tail: String(step.newest?.text || ""),
        reason: step.matched
          ? step.hasVideo
            ? "找到本次提示词对应的视频"
            : (step.replies || []).length
              ? "本次消息之后有平台回复，但没有视频"
              : "本次消息之后平台还没有回复"
          : "页面上没有找到本次提示词对应的消息",
      };
    },

    /** 页面没有明确信号时返回 unknown，不编造进度 */
    async poll({ accountId, platformTaskId, attempt }) {
      let contents;
      try {
        contents = await pageFor(accountId);
      } catch (error) {
        return { state: "unknown", message: `无法读取账号页面：${error?.message || error}` };
      }
      // 先看平台是否已经把本次结果渲染出来（匹配的是本次写入平台的提示词，不会把历史视频算进来）
      const result = await api.readResult({ accountId, attempt }).catch(() => null);
      if (result?.found) {
        return {
          state: "succeeded",
          message: "平台已完成生成：页面上出现本次提示词对应的视频",
          result: { videoUrl: result.videoUrl },
          evidence: { kind: "result-visible", messageId: result.messageId, matched: result.matched },
        };
      }
      // 平台对本次请求的明确回复优先于页面泛文本：拒绝类必须标失败并带原文，
      // 实测（2026-09-24）：平台回「今天的生成次数已经达到上限」，旧逻辑会一直停在「待确认」。
      const replyText = (result?.replies || []).join("\n");
      const replyRule = replyText ? classifyPlatformReply(replyText) : null;
      if (replyRule) {
        return {
          state: "failed",
          errorCode: replyRule.code,
          message: `${replyRule.label}；平台原文：${replyRule.excerpt}`,
          evidence: { kind: "platform-reply", code: replyRule.code, excerpt: replyRule.excerpt },
        };
      }
      if (/生成中|排队|正在生成|马上就好|请稍等/.test(replyText)) {
        return { state: "generating", message: "平台回复显示正在生成", canCancel: false };
      }
      const read = await evaluate(contents, STEP_READ_STATE).catch(() => null);
      if (!read?.ok) return { state: "unknown", message: "页面状态不可读取" };
      const pageText = String(read.text || "");
      if (/生成失败|违规|未通过/.test(pageText) && !/生成中|排队/.test(pageText)) {
        return { state: "failed", message: "页面显示生成失败", errorCode: "GENERATE_FAILED" };
      }
      return {
        state: "unknown",
        message: result?.reason || "页面未给出可判定的状态标记",
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
      state.attachments.clear();
      state.locks.clear();
    },
  };

  return api;
}

module.exports = {
  DOLA_HOST_RE,
  PARTITION_PREFIX,
  collectAbilityDuration,
  collectIds,
  createDolaDriver,
  findAccountWebview,
  isDolaUrl,
  sessionEvidence,
  waitForPageReady,
};