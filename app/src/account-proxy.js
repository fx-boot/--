"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ChainedSocksServer,
  fetchExitIp,
  maskProxyLine,
  parseParent,
  parseProxyLine,
  probeRemote,
} = require("./proxy-chain");

const STORE_FILE = "account-proxies.json";
const DEFAULT_PARENT_PROXY = "http://127.0.0.1:7897";
const PARTITION_PREFIX = "persist:doubao-manager-";
const CHANGED_CHANNEL = "account-proxy:changed";

const state = {
  captureInstalled: false,
  configs: null,
  registered: false,
  runtimes: new Map(),
  servers: new Map(),
};

function debug(message) {
  if (process.env.DBM_COMPAT_DEBUG === "1") process.stderr.write(`[account-proxy] ${message}\n`);
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function validAccountId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(text(value));
}

function normalizeParentProxy(value) {
  const raw = text(value) || DEFAULT_PARENT_PROXY;
  if (raw.includes("://")) {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error("本机规则代理格式无效"); }
    if (!["http:", "socks:", "socks5:"].includes(parsed.protocol) || !parsed.hostname || !parsed.port) {
      throw new Error("本机规则代理仅支持 http://host:port 或 socks5://host:port");
    }
  } else if (!/^\[?[^\]\s:]+\]?:\d+$/.test(raw)) {
    throw new Error("本机规则代理格式应为 host:port");
  }
  const parent = parseParent(raw);
  if (!parent.host || !Number.isInteger(parent.port) || parent.port < 1 || parent.port > 65535) {
    throw new Error("本机规则代理地址无效");
  }
  return raw;
}

function normalizeProxyConfig(input = {}, previous = null) {
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : Boolean(previous?.enabled);
  const proxyLine = text(input.proxyLine !== undefined ? input.proxyLine : previous?.proxyLine);
  const parentProxy = normalizeParentProxy(
    input.parentProxy !== undefined ? input.parentProxy : previous?.parentProxy
  );
  if (enabled && !parseProxyLine(proxyLine)) {
    throw new Error("SOCKS5 代理格式应为 host:port:username:password");
  }
  return {
    enabled,
    proxyLine,
    parentProxy,
    updatedAt: new Date().toISOString(),
  };
}

function storePath() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), STORE_FILE);
}

function loadConfigs() {
  if (state.configs) return state.configs;
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(storePath(), "utf8")); } catch {}
  const source = saved && typeof saved.accounts === "object" ? saved.accounts : {};
  const accounts = {};
  for (const [accountId, input] of Object.entries(source)) {
    if (!validAccountId(accountId) || !input || typeof input !== "object") continue;
    try {
      accounts[accountId] = normalizeProxyConfig(input);
      accounts[accountId].updatedAt = text(input.updatedAt) || accounts[accountId].updatedAt;
    } catch (error) {
      accounts[accountId] = {
        enabled: false,
        proxyLine: text(input.proxyLine),
        parentProxy: DEFAULT_PARENT_PROXY,
        updatedAt: text(input.updatedAt),
        loadError: error.message,
      };
    }
  }
  state.configs = { version: 1, accounts };
  return state.configs;
}

function saveConfigs() {
  const file = storePath();
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(loadConfigs(), null, 2), "utf8");
  fs.renameSync(temp, file);
}

function accountExists(accountId) {
  try {
    const accounts = JSON.parse(fs.readFileSync(path.join(path.dirname(storePath()), "accounts.json"), "utf8"));
    return Array.isArray(accounts) && accounts.some((account) => account?.id === accountId);
  } catch {
    return false;
  }
}

function configFingerprint(config) {
  return `${config.proxyLine}\n${config.parentProxy}`;
}

function runtimeFor(accountId, fallbackState = "direct") {
  return state.runtimes.get(accountId) || {
    state: fallbackState,
    localPort: 0,
    exitIp: "",
    message: "",
  };
}

function publicProxyState(accountId) {
  const config = loadConfigs().accounts[accountId] || null;
  const runtime = runtimeFor(accountId, config?.enabled ? "configured" : "direct");
  return {
    accountId,
    configured: Boolean(config),
    enabled: Boolean(config?.enabled),
    parentProxy: config?.parentProxy || DEFAULT_PARENT_PROXY,
    proxyMasked: config?.proxyLine ? maskProxyLine(config.proxyLine) : "",
    state: runtime.state,
    localPort: Number(runtime.localPort) || 0,
    exitIp: text(runtime.exitIp),
    message: text(runtime.message),
    updatedAt: config?.updatedAt || "",
  };
}

function privateProxyState(accountId) {
  const config = loadConfigs().accounts[accountId] || {
    enabled: false,
    proxyLine: "",
    parentProxy: DEFAULT_PARENT_PROXY,
    updatedAt: "",
  };
  return { ...publicProxyState(accountId), proxyLine: config.proxyLine };
}

function listProxyStates() {
  return Object.keys(loadConfigs().accounts).map(publicProxyState);
}

function notifyChanged(accountId = "") {
  const { BrowserWindow } = require("electron");
  const payload = {
    accountId,
    proxy: accountId ? publicProxyState(accountId) : null,
    proxies: listProxyStates(),
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANGED_CHANNEL, payload);
  }
}

function openViewsForSession(targetSession) {
  const { webContents } = require("electron");
  return webContents.getAllWebContents().filter((contents) =>
    contents.getType() === "webview" &&
    contents.session === targetSession &&
    !contents.isDestroyed()
  );
}

async function closeSessionConnections(targetSession) {
  try { await targetSession.closeAllConnections(); } catch {}
}

function stopServer(accountId) {
  const current = state.servers.get(accountId);
  if (!current) return;
  state.servers.delete(accountId);
  try { current.server.stop(); } catch {}
}

async function applyEnabledProxy(accountId, config, { reload = true } = {}) {
  const { session } = require("electron");
  const remote = parseProxyLine(config.proxyLine);
  if (!remote) throw new Error("SOCKS5 代理参数无效");
  const fingerprint = configFingerprint(config);
  const existing = state.servers.get(accountId);
  let next = existing;
  if (!existing || existing.fingerprint !== fingerprint || !existing.server?.server) {
    const server = new ChainedSocksServer(remote, config.parentProxy);
    await server.start();
    next = { server, fingerprint };
  }

  const targetSession = session.fromPartition(`${PARTITION_PREFIX}${accountId}`);
  const views = openViewsForSession(targetSession);
  for (const contents of views) {
    try { contents.stop(); } catch {}
  }

  try {
    await targetSession.setProxy({
      proxyRules: `socks5://127.0.0.1:${next.server.localPort}`,
      proxyBypassRules: "<-loopback>",
    });
    await closeSessionConnections(targetSession);
  } catch (error) {
    if (next !== existing) next.server.stop();
    throw error;
  }

  if (existing && existing !== next) existing.server.stop();
  state.servers.set(accountId, next);
  state.runtimes.set(accountId, {
    state: "active",
    localPort: next.server.localPort,
    exitIp: runtimeFor(accountId).exitIp,
    message: "",
  });
  if (reload) {
    for (const contents of views) {
      try { contents.reloadIgnoringCache(); } catch {}
    }
  }
  debug(`proxy active for ${accountId} via local port ${next.server.localPort}`);
  return publicProxyState(accountId);
}

async function applyDirect(accountId, { reload = true } = {}) {
  const { session } = require("electron");
  const targetSession = session.fromPartition(`${PARTITION_PREFIX}${accountId}`);
  const views = openViewsForSession(targetSession);
  for (const contents of views) {
    try { contents.stop(); } catch {}
  }
  await targetSession.setProxy({ mode: "system" });
  await closeSessionConnections(targetSession);
  stopServer(accountId);
  state.runtimes.set(accountId, { state: "direct", localPort: 0, exitIp: "", message: "" });
  if (reload) {
    for (const contents of views) {
      try { contents.reloadIgnoringCache(); } catch {}
    }
  }
  debug(`proxy disabled for ${accountId}`);
  return publicProxyState(accountId);
}

async function applyAccountProxy(accountId, options = {}) {
  const config = loadConfigs().accounts[accountId];
  if (!config?.enabled) return applyDirect(accountId, options);
  state.runtimes.set(accountId, { state: "starting", localPort: 0, exitIp: "", message: "" });
  notifyChanged(accountId);
  try {
    return await applyEnabledProxy(accountId, config, options);
  } catch (error) {
    state.runtimes.set(accountId, {
      state: "error",
      localPort: 0,
      exitIp: "",
      message: error.message,
    });
    debug(`proxy activation failed for ${accountId}: ${error.message}`);
    throw error;
  } finally {
    notifyChanged(accountId);
  }
}

async function saveAccountProxy(accountId, input) {
  if (!validAccountId(accountId) || !accountExists(accountId)) throw new Error("账号不存在");
  const previous = loadConfigs().accounts[accountId] || null;
  const config = normalizeProxyConfig(input, previous);
  loadConfigs().accounts[accountId] = config;
  saveConfigs();
  await applyAccountProxy(accountId);
  return publicProxyState(accountId);
}

async function disableAccountProxy(accountId, { remove = false, reload = true } = {}) {
  if (!validAccountId(accountId)) throw new Error("账号标识无效");
  if (remove) delete loadConfigs().accounts[accountId];
  else {
    const previous = loadConfigs().accounts[accountId] || {};
    loadConfigs().accounts[accountId] = normalizeProxyConfig({ ...previous, enabled: false }, previous);
  }
  saveConfigs();
  const result = await applyDirect(accountId, { reload });
  notifyChanged(accountId);
  return result;
}

async function testProxy(input = {}) {
  const config = normalizeProxyConfig({ ...input, enabled: true });
  const remote = parseProxyLine(config.proxyLine);
  const startedAt = Date.now();
  await probeRemote(remote, config.parentProxy, 15000);
  const server = new ChainedSocksServer(remote, config.parentProxy);
  try {
    await server.start();
    const exitIp = await fetchExitIp(server.localPort, 18000);
    return {
      ok: true,
      exitIp,
      latencyMs: Date.now() - startedAt,
      proxyMasked: maskProxyLine(config.proxyLine),
      parentProxy: config.parentProxy,
    };
  } finally {
    server.stop();
  }
}

async function testSavedAccountProxy(accountId) {
  const config = loadConfigs().accounts[accountId];
  if (!config?.enabled) throw new Error("此账号尚未启用代理");
  state.runtimes.set(accountId, { ...runtimeFor(accountId), state: "testing", message: "" });
  notifyChanged(accountId);
  try {
    const result = await testProxy(config);
    const current = loadConfigs().accounts[accountId];
    if (current && configFingerprint(current) === configFingerprint(config)) {
      state.runtimes.set(accountId, {
        ...runtimeFor(accountId),
        state: "active",
        exitIp: result.exitIp,
        message: "",
      });
    }
    return result;
  } catch (error) {
    state.runtimes.set(accountId, { ...runtimeFor(accountId), state: "error", message: error.message });
    throw error;
  } finally {
    notifyChanged(accountId);
  }
}

async function removeAccountProxy(accountId) {
  if (!validAccountId(accountId)) return;
  try { await disableAccountProxy(accountId, { remove: true, reload: false }); }
  catch (error) { debug(`proxy cleanup failed for ${accountId}: ${error.message}`); }
  state.runtimes.delete(accountId);
}

function captureAccountLifecycle() {
  if (state.captureInstalled) return;
  const { ipcMain } = require("electron");
  state.captureInstalled = true;
  const previousHandle = ipcMain.handle;
  ipcMain.handle = function proxyLifecycleHandle(channel, listener) {
    if (channel !== "accounts:delete") return previousHandle.call(this, channel, listener);
    return previousHandle.call(this, channel, async (event, accountId, options) => {
      const result = await listener(event, accountId, options);
      if (result?.ok !== false) await removeAccountProxy(text(accountId));
      return result;
    });
  };
}

function registerIpc() {
  if (state.registered) return;
  const { ipcMain } = require("electron");
  state.registered = true;
  const handlers = {
    "account-proxy:list": () => listProxyStates(),
    "account-proxy:get": (_event, accountId) => privateProxyState(text(accountId)),
    "account-proxy:save": (_event, input = {}) => saveAccountProxy(text(input.accountId), input),
    "account-proxy:disable": (_event, accountId) => disableAccountProxy(text(accountId)),
    "account-proxy:test": (_event, input = {}) => input.accountId
      ? testSavedAccountProxy(text(input.accountId))
      : testProxy(input),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, handler);
  }
}

async function restoreEnabledProxies() {
  const accounts = new Set();
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(storePath()), "accounts.json"), "utf8"));
    for (const account of Array.isArray(saved) ? saved : []) if (validAccountId(account?.id)) accounts.add(account.id);
  } catch {}
  const tasks = [];
  for (const [accountId, config] of Object.entries(loadConfigs().accounts)) {
    if (!accounts.has(accountId) || !config.enabled) continue;
    tasks.push(applyAccountProxy(accountId, { reload: false }).catch(() => null));
  }
  await Promise.all(tasks);
  notifyChanged();
  debug(`restored ${tasks.length} account proxy configurations`);
}

function registerAccountProxy() {
  const { app } = require("electron");
  registerIpc();
  app.whenReady().then(restoreEnabledProxies).catch((error) => debug(error.stack || error.message));
  app.once("will-quit", () => {
    for (const accountId of Array.from(state.servers.keys())) stopServer(accountId);
  });
}

module.exports = {
  DEFAULT_PARENT_PROXY,
  applyAccountProxy,
  captureAccountLifecycle,
  disableAccountProxy,
  listProxyStates,
  normalizeParentProxy,
  normalizeProxyConfig,
  registerAccountProxy,
  saveAccountProxy,
  testProxy,
};
