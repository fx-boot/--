"use strict";

// 账号代理池批量管理（编排层）
// - 一键同步 accounts.json 中的全部账号到批量方案
// - JSON 批量分配每账号节点（host:port:user:pass 或 socks5://user:pass@host:port）
// - failClosed 熔断：任一节点预检失败则整批不应用，杜绝真实 IP 直连
// - 统一批量应用 / 全部停止，底层复用 account-proxy.js 的持久化与会话注入
//
// 方案文件：userData/account-proxy-pool.json（批量方案）
// 生效落盘：userData/account-proxies.json（单账号存储，由 account-proxy 管理）

const fs = require("node:fs");
const path = require("node:path");
const { parseProxyLine, maskProxyLine } = require("./proxy-chain");
const accountProxy = require("./account-proxy");

const STORE_FILE = "account-proxy-pool.json";
const PROBE_CONCURRENCY = 3;

const pool = {
  registered: false,
  lastResults: new Map(), // accountId -> { ok, exitIp, latencyMs, message, checkedAt }
};

function debug(message) {
  if (process.env.DBM_COMPAT_DEBUG === "1") process.stderr.write(`[account-proxy-pool] ${message}\n`);
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function validAccountId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(text(value));
}

function userDataDir() {
  const { app } = require("electron");
  return app.getPath("userData");
}

function planPath() {
  return path.join(userDataDir(), STORE_FILE);
}

function defaultPlan() {
  return {
    version: 1,
    failClosed: true,
    defaultParentProxy: accountProxy.DEFAULT_PARENT_PROXY,
    updatedAt: "",
    accounts: [],
  };
}

function readAccounts() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir(), "accounts.json"), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => item && validAccountId(item.id))
      .map((item) => ({ id: text(item.id), name: text(item.name) || text(item.id), platform: text(item.platform) }));
  } catch {
    return [];
  }
}

function loadPlan() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(planPath(), "utf8")); } catch {}
  const plan = defaultPlan();
  if (saved && typeof saved === "object") {
    if (typeof saved.failClosed === "boolean") plan.failClosed = saved.failClosed;
    const dp = text(saved.defaultParentProxy);
    if (dp) plan.defaultParentProxy = dp;
    plan.updatedAt = text(saved.updatedAt);
    if (Array.isArray(saved.accounts)) {
      for (const row of saved.accounts) {
        if (!row || !validAccountId(row.id)) continue;
        plan.accounts.push({
          id: text(row.id),
          enabled: Boolean(row.enabled),
          proxyLine: text(row.proxyLine),
          parentProxy: text(row.parentProxy),
        });
      }
    }
  }
  return plan;
}

function savePlan(plan) {
  const file = planPath();
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(plan, null, 2), "utf8");
  fs.renameSync(temp, file);
}

// 严格校验方案（保存/应用前）。parentProxy 留空表示用默认。
function validatePlan(input) {
  if (!input || typeof input !== "object") throw new Error("方案必须是 JSON 对象");
  const plan = defaultPlan();
  if (typeof input.failClosed === "boolean") plan.failClosed = input.failClosed;
  plan.defaultParentProxy = accountProxy.normalizeParentProxy(text(input.defaultParentProxy) || accountProxy.DEFAULT_PARENT_PROXY);
  const rowsInput = input.accounts;
  if (!Array.isArray(rowsInput)) throw new Error("accounts 必须是数组");

  const seen = new Set();
  for (const row of rowsInput) {
    if (!row || typeof row !== "object") throw new Error("accounts 中存在非法条目");
    const id = text(row.id);
    if (!validAccountId(id)) throw new Error(`账号标识无效：${id || "(空)"}`);
    if (seen.has(id)) throw new Error(`账号重复：${id}`);
    seen.add(id);
    const proxyLine = text(row.proxyLine);
    const enabled = Boolean(row.enabled);
    const parentProxy = text(row.parentProxy);
    if (parentProxy) accountProxy.normalizeParentProxy(parentProxy);
    if (enabled && !parseProxyLine(proxyLine)) {
      throw new Error(`账号 ${id} 已启用但节点格式无效（应为 host:port:user:pass）`);
    }
    plan.accounts.push({ id, enabled, proxyLine, parentProxy });
  }
  return plan;
}

function effectiveParent(row, plan) {
  return text(row.parentProxy) || plan.defaultParentProxy;
}

// 以账号真实列表为基准合并方案：保留已填节点，补新账号，剔除已删除账号
function syncPlan(clientPlan) {
  const base = clientPlan ? validatePlan(clientPlan) : loadPlan();
  const accounts = readAccounts();
  const previous = new Map(base.accounts.map((row) => [row.id, row]));
  const merged = accounts.map((account) => {
    const old = previous.get(account.id);
    return old
      ? { id: account.id, enabled: old.enabled, proxyLine: old.proxyLine, parentProxy: old.parentProxy }
      : { id: account.id, enabled: false, proxyLine: "", parentProxy: "" };
  });
  const plan = {
    ...base,
    accounts: merged,
    updatedAt: new Date().toISOString(),
  };
  savePlan(plan);
  return plan;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function accountNameMap() {
  return new Map(readAccounts().map((account) => [account.id, account.name]));
}

// 合并方案 + 单账号实时状态，供 UI 展示
function getStatus() {
  const plan = loadPlan();
  const names = accountNameMap();
  const live = new Map(accountProxy.listProxyStates().map((item) => [item.accountId, item]));
  const rows = plan.accounts.map((row) => {
    const state = live.get(row.id);
    const last = pool.lastResults.get(row.id) || null;
    return {
      ...row,
      name: names.get(row.id) || row.id,
      exists: names.has(row.id),
      proxyMasked: row.proxyLine ? maskProxyLine(row.proxyLine) : "",
      state: state?.state || (row.enabled ? "configured" : "direct"),
      exitIp: text(state?.exitIp) || text(last?.exitIp),
      message: text(state?.message) || text(last?.message),
      lastCheck: last ? { ok: Boolean(last.ok), exitIp: text(last.exitIp), latencyMs: Number(last.latencyMs) || 0, message: text(last.message), checkedAt: last.checkedAt } : null,
    };
  });
  return { ...plan, accounts: rows, accountCount: names.size };
}

// 测试方案中全部启用的节点（不改任何生效配置）
async function testAll() {
  const plan = loadPlan();
  const names = accountNameMap();
  const targets = plan.accounts.filter((row) => row.enabled && parseProxyLine(row.proxyLine));
  const results = await mapLimit(targets, PROBE_CONCURRENCY, async (row) => {
    const startedAt = Date.now();
    const base = {
      id: row.id,
      name: names.get(row.id) || row.id,
      proxyMasked: maskProxyLine(row.proxyLine),
      parentProxy: effectiveParent(row, plan),
    };
    try {
      const result = await accountProxy.testProxy({
        enabled: true,
        proxyLine: row.proxyLine,
        parentProxy: effectiveParent(row, plan),
      });
      const item = {
        ...base,
        ok: true,
        exitIp: text(result.exitIp),
        latencyMs: Number(result.latencyMs) || (Date.now() - startedAt),
        message: result.exitIp ? `出口 ${result.exitIp}` : "节点可用",
        checkedAt: new Date().toISOString(),
      };
      pool.lastResults.set(row.id, item);
      return item;
    } catch (error) {
      const item = {
        ...base,
        ok: false,
        exitIp: "",
        latencyMs: Date.now() - startedAt,
        message: error.message || String(error),
        checkedAt: new Date().toISOString(),
      };
      pool.lastResults.set(row.id, item);
      return item;
    }
  });
  return {
    ok: results.every((item) => item.ok),
    total: targets.length,
    passed: results.filter((item) => item.ok).length,
    results,
  };
}

// 批量应用：先全量预检；failClosed 时一败全停（不做任何变更）
async function applyPlan() {
  const plan = loadPlan();
  const names = accountNameMap();
  const targets = plan.accounts.filter((row) => row.enabled && parseProxyLine(row.proxyLine));
  const cuts = plan.accounts.filter((row) => !(row.enabled && parseProxyLine(row.proxyLine)));

  // 1) 全量预检
  const probes = await mapLimit(targets, PROBE_CONCURRENCY, async (row) => {
    const startedAt = Date.now();
    const base = { id: row.id, name: names.get(row.id) || row.id, proxyMasked: maskProxyLine(row.proxyLine) };
    try {
      const result = await accountProxy.testProxy({
        enabled: true,
        proxyLine: row.proxyLine,
        parentProxy: effectiveParent(row, plan),
      });
      const item = { ...base, ok: true, exitIp: text(result.exitIp), latencyMs: Number(result.latencyMs) || (Date.now() - startedAt), message: result.exitIp ? `出口 ${result.exitIp}` : "节点可用", checkedAt: new Date().toISOString() };
      pool.lastResults.set(row.id, item);
      return item;
    } catch (error) {
      const item = { ...base, ok: false, exitIp: "", latencyMs: Date.now() - startedAt, message: error.message || String(error), checkedAt: new Date().toISOString() };
      pool.lastResults.set(row.id, item);
      return item;
    }
  });
  const failed = probes.filter((item) => !item.ok);
  const passed = probes.filter((item) => item.ok);

  // 2) failClosed：任何节点失败 → 整批中止，不改动任何代理
  if (failed.length && plan.failClosed) {
    return {
      ok: false,
      aborted: true,
      failClosed: true,
      total: targets.length,
      passed: passed.length,
      results: probes,
      message: `${failed.length} 个节点预检失败，已触发熔断，本批未做任何变更`,
    };
  }

  // 3) 非熔断模式：失败节点切回直连（绕过），成功节点逐个落盘并注入会话
  const bypassed = [];
  for (const item of failed) {
    try {
      await accountProxy.disableAccountProxy(item.id, { reload: false });
      bypassed.push(item.id);
    } catch (error) {
      debug(`bypass disable failed for ${item.id}: ${error.message}`);
    }
  }

  const applied = [];
  const applyErrors = [];
  for (const row of targets) {
    if (failed.some((item) => item.id === row.id)) continue;
    try {
      await accountProxy.saveAccountProxy(row.id, {
        enabled: true,
        proxyLine: row.proxyLine,
        parentProxy: effectiveParent(row, plan),
      });
      applied.push(row.id);
    } catch (error) {
      applyErrors.push({ id: row.id, name: names.get(row.id) || row.id, message: error.message || String(error) });
    }
  }

  // 4) 方案中停用/清空的账号切回直连
  const disabled = [];
  for (const row of cuts) {
    try {
      await accountProxy.disableAccountProxy(row.id, { reload: false });
      disabled.push(row.id);
    } catch (error) {
      debug(`cut disable failed for ${row.id}: ${error.message}`);
    }
  }

  return {
    ok: applyErrors.length === 0,
    aborted: false,
    failClosed: plan.failClosed,
    total: targets.length,
    passed: passed.length,
    results: probes,
    applied,
    bypassed,
    disabled,
    applyErrors,
    message: applyErrors.length
      ? `${applied.length} 个已应用，${applyErrors.length} 个应用失败`
      : `已应用 ${applied.length} 个账号代理` + (bypassed.length ? `，${bypassed.length} 个故障节点已切直连` : ""),
  };
}

// 全部停止：方案内所有账号切回直连
async function stopAll() {
  const plan = loadPlan();
  const stopped = [];
  const errors = [];
  for (const row of plan.accounts) {
    try {
      await accountProxy.disableAccountProxy(row.id, { reload: false });
      stopped.push(row.id);
    } catch (error) {
      errors.push({ id: row.id, message: error.message || String(error) });
    }
  }
  return { ok: errors.length === 0, stopped, errors };
}

function registerAccountProxyPool() {
  if (pool.registered) return;
  const { ipcMain } = require("electron");
  pool.registered = true;
  const handlers = {
    "account-proxy-pool:get": () => getStatus(),
    "account-proxy-pool:sync": (_event, input) => {
      syncPlan(input || null);
      return getStatus();
    },
    "account-proxy-pool:save": (_event, input) => {
      const plan = validatePlan(input || {});
      plan.updatedAt = new Date().toISOString();
      savePlan(plan);
      return getStatus();
    },
    "account-proxy-pool:test": () => testAll(),
    "account-proxy-pool:apply": () => applyPlan(),
    "account-proxy-pool:stop": () => stopAll(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, async (event, payload) => {
      try {
        return { ok: true, data: await handler(event, payload) };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    });
  }
  debug("registered");
}

module.exports = { registerAccountProxyPool };
