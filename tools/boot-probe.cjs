/**
 * 隔离启动探针（验收入口）
 *
 * 为什么需要两层隔离：
 *   1. Chromium 会在应用 JS 执行之前就按默认路径初始化 profile（曾观察到
 *      %APPDATA%\doubao-account-manager\Local State 被写入）。这一层只能用
 *      命令行开关 --user-data-dir 解决，改 JS 已经来不及。
 *   2. main.jsc 会自己调用 app.setPath 重新指定 userData。这一层只能靠
 *      拦截 app.setPath 解决，命令行开关盖不住。
 *   因此真正的隔离 = --user-data-dir（由控制器传入）+ 本探针的 setPath 拦截。
 *
 * 本探针只做启动与只读检查，不提交任何生成任务，不消耗任何账号额度。
 * 隔离根目录由控制器通过 DBM_ISOLATED_ROOT 传入，默认退回到 exe 同目录。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const exeDir = path.dirname(process.execPath);
const isolatedRoot = path.resolve(
  process.env.DBM_ISOLATED_ROOT || path.join(exeDir, "boot-probe-data", `run-${Date.now()}`)
);
const appDataDir = path.join(isolatedRoot, "DoubaoAccountManager");
const reportPath = path.join(exeDir, "boot-probe-report.json");

const report = {
  startedAt: new Date().toISOString(),
  isolatedRoot,
  appDataDir,
  exeDir,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  argv: process.argv.slice(1),
  // 每一次数据目录请求（名称 + 应用请求的路径 + 实际落点）
  pathRequests: [],
  checks: [],
  diagnostics: [],
  api: {},
  capabilities: null,
  isolatedTree: [],
  error: null,
  ok: false,
};

function writeAndExit(code) {
  report.finishedAt = new Date().toISOString();
  try {
    report.isolatedTree = listTree(isolatedRoot);
  } catch {}
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch {}
  app.exit(code);
}

function listTree(root, limit = 400) {
  const out = [];
  (function walk(dir, prefix = "") {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= limit) return;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        out.push(`${rel}/`);
        walk(full, rel);
      } else {
        out.push(`${rel} (${stat.size}B)`);
      }
    }
  })(root);
  return out;
}

process.on("uncaughtException", (err) => {
  report.error = err?.stack || String(err);
  writeAndExit(1);
});
process.on("unhandledRejection", (err) => {
  report.error = err?.stack || String(err);
  writeAndExit(1);
});

// ── 第二层：拦截 app.setPath（记录每一次请求，并把 userData/sessionData/appData 改道）──
fs.mkdirSync(appDataDir, { recursive: true });
const nativeSetPath = app.setPath.bind(app);
const recordPath = (name, requested, applied) => {
  report.pathRequests.push({ name, requested: String(requested ?? ""), applied: String(applied ?? "") });
  return applied;
};

report.initialUserData = app.getPath("userData");
nativeSetPath("appData", isolatedRoot);
app.setPath = (name, value) => {
  if (["userData", "sessionData", "appData"].includes(name)) {
    const applied = name === "appData" ? isolatedRoot : appDataDir;
    recordPath(name, value, applied);
    return nativeSetPath(name, applied);
  }
  return nativeSetPath(name, value);
};
// 主动再设一次，确保即使 main.jsc 不调用 setPath，也落在隔离目录
app.setPath("userData", appDataDir);
report.userDataAfterRedirect = app.getPath("userData");
report.sessionDataAfterRedirect = app.getPath("sessionData");

// ── 诊断采集 ──
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_e, preloadPath, error) =>
    report.diagnostics.push({ kind: "preload-error", preloadPath, error: error.message })
  );
  contents.on("did-fail-load", (_e, code, desc, url) =>
    report.diagnostics.push({ kind: "did-fail-load", code, desc, url })
  );
});
app.on("browser-window-created", (_event, win) => {
  win.show = () => {}; // 无头运行，不抢焦点
});

// ── 加载真实主进程（main.js 校验 main.jsc 哈希后加载字节码）──
report.mainLoaded = false;
try {
  require("./src/main");
  report.mainLoaded = true;
} catch (error) {
  // 单独记录，避免被外层 catch 覆盖（这条信息决定了启动失败到底卡在哪个模块）
  report.requireError = error?.stack || String(error);
  report.requireErrorModule = (() => {
    const frame = /at .*?\(?([^():]+\.js):\d+/.exec(String(error?.stack || ""));
    return frame ? frame[1] : "";
  })();
}

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
  report.checks.push({
    name,
    pass: Boolean(condition),
    detail: detail === undefined ? null : detail,
  });
  return Boolean(condition);
}

(async () => {
  await app.whenReady();
  report.ready = true;

  const win = await waitFor(
    () =>
      BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/renderer/index.html")
      ),
    "主窗口 renderer/index.html"
  );
  check("主窗口已加载 renderer/index.html", true, win.webContents.getURL());

  const js = (code) => win.webContents.executeJavaScript(code);
  await waitFor(
    () => js("Boolean(window.managerAPI && window.managerAPI.accounts && window.managerAPI.runtime)"),
    "preload 暴露 managerAPI"
  );
  report.api.exposedKeys = await js("Object.keys(window.managerAPI)");

  const accounts = await js("window.managerAPI.accounts.list()");
  report.api.accounts = accounts;
  check("accounts:list 可调用", Array.isArray(accounts), `返回 ${Array.isArray(accounts) ? accounts.length : "非数组"} 项`);

  const platforms = await js("window.managerAPI.platforms.list()");
  report.api.platforms = platforms;
  check("platforms:list 可调用", Boolean(platforms));

  const license = await js("window.managerAPI.license.status()");
  report.api.license = { active: license?.active, plan: license?.license?.plan };
  check("license:status 可调用", license !== undefined);

  const caps = await js("window.managerAPI.runtime.capabilities()");
  report.capabilities = caps;
  check("runtime:capabilities 可调用", Boolean(caps));

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
    "不一致说明 IPC 返回了另一套能力来源"
  );

  // 工作台通道是否已注册（阶段1/2 的接线在真机上是否生效）
  const workbenchOk = await js(
    "Boolean(window.managerWorkbenchAPI && window.managerWorkbenchAPI.task && window.managerWorkbenchAPI.account)"
  );
  check("工作台 preload 已暴露", workbenchOk);
  if (workbenchOk) {
    const snapshot = await js("window.managerWorkbenchAPI.snapshot()");
    report.workbench = {
      storageRoot: snapshot?.storage?.root,
      storageOk: snapshot?.storage?.ok,
      accounts: Array.isArray(snapshot?.accounts) ? snapshot.accounts.length : null,
      tasks: Array.isArray(snapshot?.tasks) ? snapshot.tasks.length : null,
      hasStatusLabels: Boolean(snapshot?.statusLabels && snapshot?.downloadLabels),
      capabilitiesTargets: Object.keys(snapshot?.capabilities?.targets || {}),
    };
    check("工作台 snapshot 可读取", Boolean(snapshot));
    check("工作台数据目录在隔离范围内", String(snapshot?.storage?.root || "").startsWith(isolatedRoot), snapshot?.storage?.root);
    check("工作台状态文案随快照下发", Boolean(snapshot?.statusLabels && snapshot?.downloadLabels));
  }

  // 落定一下，让可能的迟发写入落到明面上
  await delay(Number(process.env.DBM_SETTLE_MS || 2500));

  check("隔离根目录已建立", fs.existsSync(isolatedRoot));
  check("隔离内 userData 已建立", fs.existsSync(appDataDir));
  report.isolatedTop = (() => {
    try {
      return fs.readdirSync(isolatedRoot).sort();
    } catch {
      return null;
    }
  })();

  report.ok = report.checks.every((c) => c.pass);
  writeAndExit(report.ok ? 0 : 1);
})().catch((error) => {
  report.error = error?.stack ? error.stack : String(error);
  writeAndExit(1);
});