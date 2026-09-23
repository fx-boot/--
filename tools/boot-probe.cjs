/**
 * 隔离启动探针（验收入口）
 *
 * 为什么需要它：
 *   - `--user-data-dir` 对本体无效：main.jsc 会自己调用 app.setPath 指定
 *     userData(%APPDATA%\DoubaoAccountManager)，必须拦截 setPath 才能真正隔离；
 *   - 应用存在单实例锁，直接启动第二个 GUI 实例会被转发后退出。
 *
 * 因此本探针以 Electron 入口方式运行，加载真实的 src/main 与 main.jsc，
 * 但把 userData / sessionData 全部重定向到 runtime 下的临时目录，
 * 不读写任何真实账号数据。
 *
 * 由 tools/pack-app.cjs --entry-file 注入到包根，报告写到 exe 同目录。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, webContents } = require("electron");

const root = path.dirname(process.execPath);
const reportPath = path.join(root, "boot-probe-report.json");
const isolated = path.join(root, "boot-probe-data", `run-${Date.now()}`);
const redirected = [];

const report = {
  startedAt: new Date().toISOString(),
  isolated,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  redirected,
  checks: [],
  diagnostics: [],
  api: {},
  capabilities: null,
  error: null,
  ok: false,
};

function writeAndExit(code) {
  report.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch {}
  app.exit(code);
}

process.on("uncaughtException", (err) => {
  report.error = err && err.stack ? err.stack : String(err);
  writeAndExit(1);
});
process.on("unhandledRejection", (err) => {
  report.error = err && err.stack ? err.stack : String(err);
  writeAndExit(1);
});

// ---- 数据目录重定向（关键）----
const setPath = app.setPath.bind(app);
fs.mkdirSync(path.join(isolated, "DoubaoAccountManager"), { recursive: true });
setPath("appData", isolated);
app.setPath = (name, value) => {
  if (["userData", "sessionData"].includes(name)) {
    redirected.push({ name, requested: String(value) });
    return setPath(name, path.join(isolated, "DoubaoAccountManager"));
  }
  return setPath(name, value);
};
app.setPath("userData", isolated);

// ---- 诊断采集 ----
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_e, preloadPath, error) =>
    report.diagnostics.push({ kind: "preload-error", preloadPath, error: error.message })
  );
  contents.on("did-fail-load", (_e, code, desc, url) =>
    report.diagnostics.push({ kind: "did-fail-load", code, desc, url })
  );
});
app.on("browser-window-created", (_event, win) => {
  win.show = () => {}; // 无头运行，避免抢焦点
});

// ---- 加载真实主进程（main.js 校验 main.jsc 哈希后加载字节码）----
report.mainLoaded = false;
require("./src/main");
report.mainLoaded = true;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, tries = 300, step = 100) {
  for (let i = 0; i < tries; i++) {
    let value;
    try {
      value = await fn();
    } catch (error) {
      report.diagnostics.push({ kind: "waitFor-throw", label, error: error.message });
      value = null;
    }
    if (value) return value;
    await delay(step);
  }
  throw new Error(`等待超时：${label}`);
}

function check(name, condition, detail) {
  report.checks.push({ name, pass: Boolean(condition), detail: detail === undefined ? null : detail });
  return Boolean(condition);
}

(async () => {
  await app.whenReady();
  report.ready = true;

  const win = await waitFor(
    () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/renderer/index.html")),
    "主窗口 renderer/index.html"
  );
  check("主窗口已加载 renderer/index.html", true, win.webContents.getURL());

  const js = (code) => win.webContents.executeJavaScript(code);

  await waitFor(
    () => js("Boolean(window.managerAPI && window.managerAPI.accounts && window.managerAPI.runtime)"),
    "preload 暴露 managerAPI"
  );
  check("preload 暴露 managerAPI", true);

  report.api.exposedKeys = await js("Object.keys(window.managerAPI)");

  // 账号接口（隔离环境下应为空数组，用于验证接口可用而非数据可用）
  const accounts = await js("window.managerAPI.accounts.list()");
  report.api.accounts = Array.isArray(accounts) ? accounts : accounts;
  check("accounts:list 可调用", Array.isArray(accounts), `返回 ${Array.isArray(accounts) ? accounts.length : "非数组"} 项`);

  const platforms = await js("window.managerAPI.platforms.list()");
  report.api.platforms = platforms;
  check("platforms:list 可调用", Boolean(platforms));

  const license = await js("window.managerAPI.license.status()");
  report.api.license = { active: license && license.active, plan: license && license.license && license.license.plan };
  check("license:status 可调用", license !== undefined);

  const caps = await js("window.managerAPI.runtime.capabilities()");
  report.capabilities = caps;
  check("runtime:capabilities 可调用", Boolean(caps));

  // 与包内静态能力表交叉核对，确认“平台真实能力”来源唯一
  let staticCaps = null;
  try {
    staticCaps = require("./src/video-capabilities").VIDEO_CAPABILITIES;
  } catch (error) {
    report.diagnostics.push({ kind: "capabilities-require", error: error.message });
  }
  report.staticCapabilities = staticCaps;
  check(
    "能力表与静态定义一致",
    Boolean(staticCaps) && JSON.stringify(caps) === JSON.stringify(staticCaps),
    "若不一致说明 IPC 返回了另一套能力来源"
  );

  // webview 能力：工作台后续依赖独立会话 webview
  const webviewPreload = await js("window.managerAPI.runtime.webviewPreloadUrl");
  report.api.webviewPreloadUrl = webviewPreload;
  check("webview preload URL 可用", typeof webviewPreload === "string" && webviewPreload.startsWith("file:"), webviewPreload);

  check("隔离数据目录已建立", fs.existsSync(isolated));
  report.isolatedTop = fs.existsSync(isolated) ? fs.readdirSync(isolated).sort() : null;

  report.ok = report.checks.every((c) => c.pass);
  writeAndExit(report.ok ? 0 : 1);
})().catch((error) => {
  report.error = error && error.stack ? error.stack : String(error);
  writeAndExit(1);
});