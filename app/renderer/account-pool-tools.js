"use strict";

// 账号代理池批量管理面板（表单版）
// 节点库：粘贴一次 host:port:user:pass，反复选用
// 每账号一行下拉：直连 或 指定节点 → 全部测试 → 批量应用（failClosed 熔断）
(() => {
  if (window.__DBM_ACCOUNT_POOL_TOOLS__) return;
  window.__DBM_ACCOUNT_POOL_TOOLS__ = true;

  const api = window.managerProxyPoolAPI;
  if (!api) return;

  const entryWrap = document.querySelector(".account-footer > div");
  if (!entryWrap) return;
  const entry = document.createElement("button");
  entry.className = "text-button";
  entry.id = "proxyPoolEntry";
  entry.textContent = "代理池";
  entry.title = "账号代理池：节点库 / 下拉分配 / 一键应用";
  entryWrap.prepend(entry);

  const modal = document.createElement("div");
  modal.id = "accountProxyPoolModal";
  modal.className = "overlay hidden";
  modal.innerHTML = `
    <section class="modal appool-modal" role="dialog" aria-modal="true" aria-labelledby="appoolTitle">
      <div class="modal-title">
        <div><span class="eyebrow">ACCOUNT PROXY POOL</span><h2 id="appoolTitle">账号代理池</h2><p>节点粘贴一次，每个账号下拉选择，统一测试与应用</p></div>
        <button type="button" class="modal-close" id="appoolClose" title="关闭" aria-label="关闭">&times;</button>
      </div>
      <div class="modal-body">
        <div class="appool-settings">
          <div class="appool-setting">
            <span>本机规则代理</span>
            <input type="text" id="appoolParent" value="http://127.0.0.1:7897" spellcheck="false">
          </div>
          <div class="appool-setting appool-setting-toggle">
            <label class="appool-switch" title="开启后，任一节点预检失败则整批不生效，防止真实 IP 直连">
              <input type="checkbox" id="appoolFailClosed" checked>
              <i class="appool-switch-track"><i class="appool-switch-thumb"></i></i>
              节点故障时禁止绕过（熔断）
            </label>
          </div>
        </div>

        <div class="appool-card appool-nodelib">
          <div class="appool-card-head"><b>节点库</b><span class="appool-card-note">粘贴一次，多账号选用</span></div>
          <div class="appool-nodelib-body">
            <div class="appool-addrow">
              <input type="password" id="appoolNodeInput" class="appool-node-input" spellcheck="false"
                placeholder="粘贴节点  IP:端口:用户名:密码  （回车添加）" autocomplete="off">
              <label class="appool-reveal"><input type="checkbox" id="appoolNodeReveal"> 显示</label>
              <button type="button" class="secondary-action appool-add-btn" id="appoolNodeAdd">添加节点</button>
            </div>
            <div class="appool-chips" id="appoolChips"></div>
          </div>
        </div>

        <div class="appool-card">
          <div class="appool-card-head"><b>账号分配</b><span class="appool-card-note" id="appoolSummary">尚未加载</span></div>
          <div class="appool-results" id="appoolResults"></div>
        </div>

        <div class="appool-hint">
          每个账号选择一个节点或「直连（不启用）」；「全部测试」只测已分配的节点并显示出口 IP；
          熔断开启时，任一节点失败则整批不变更，不会暴露真实 IP。
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary-action" id="appoolSync">同步账号池</button>
        <button type="button" class="secondary-action" id="appoolTest">全部测试</button>
        <button type="button" class="primary-action" id="appoolApply">批量应用</button>
        <button type="button" class="secondary-action appool-stop" id="appoolStop">全部停止</button>
        <span class="appool-spacer"></span>
        <button type="button" class="secondary-action" id="appoolCancel">关闭</button>
      </div>
    </section>
  `;
  document.body.appendChild(modal);

  const NODE_STORE_KEY = "dbm_appool_node_library_v1";
  const DIRECT_VALUE = "";
  const DIRECT_LABEL = "直连（不启用）";

  const parentInput = document.getElementById("appoolParent");
  const failClosedInput = document.getElementById("appoolFailClosed");
  const summary = document.getElementById("appoolSummary");
  const resultsBox = document.getElementById("appoolResults");
  const nodeInput = document.getElementById("appoolNodeInput");
  const nodeReveal = document.getElementById("appoolNodeReveal");
  const chipsBox = document.getElementById("appoolChips");
  const actionButtons = ["appoolSync", "appoolTest", "appoolApply", "appoolStop"].map((id) => document.getElementById(id));

  // 表单状态
  let nodeLibrary = loadNodeLibrary();       // proxyLine[]
  let rows = [];                             // 最近一次后端方案中的账号行（含 name 等展示字段）
  const rowValues = new Map();               // accountId -> proxyLine（"" = 直连）
  const statusMap = new Map();               // accountId -> 后端实时状态行
  let lastPlanMeta = { failClosed: true, defaultParentProxy: "http://127.0.0.1:7897" };

  function showToast(message, type = "ok") {
    const region = document.getElementById("toastRegion");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = `toast account-proxy-toast ${type}`;
    toast.textContent = message;
    region.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function setBusy(value, label = "") {
    for (const button of actionButtons) button.disabled = Boolean(value);
    nodeInput.disabled = document.getElementById("appoolNodeAdd").disabled = Boolean(value);
    const applyBtn = document.getElementById("appoolApply");
    applyBtn.textContent = value && label ? label : "批量应用";
  }

  // ---------- 节点库（localStorage 持久化） ----------
  function loadNodeLibrary() {
    try {
      const raw = JSON.parse(localStorage.getItem(NODE_STORE_KEY) || "[]");
      return Array.isArray(raw) ? raw.map((x) => String(x || "").trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveNodeLibrary() {
    try { localStorage.setItem(NODE_STORE_KEY, JSON.stringify(nodeLibrary)); } catch {}
  }

  function parseNode(line) {
    const s = String(line || "").trim();
    if (!s) return null;
    try {
      if (s.includes("://")) {
        const u = new URL(s);
        if (!u.hostname || !u.port) return null;
        return { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username || ""), pass: decodeURIComponent(u.password || ""), raw: s };
      }
    } catch { return null; }
    const parts = s.split(":");
    if (parts.length >= 4) {
      const port = Number(parts[1]);
      if (!Number.isInteger(port) || port <= 0) return null;
      return { host: parts[0], port, user: parts[2], pass: parts.slice(3).join(":"), raw: s };
    }
    return null;
  }

  function nodeLabel(line) {
    const n = parseNode(line);
    return n ? `${n.host}:${n.port}` : String(line).slice(0, 28);
  }

  function nodeMasked(line) {
    const n = parseNode(line);
    if (!n) return line;
    return n.user ? `socks5://${n.user}:***@${n.host}:${n.port}` : `socks5://${n.host}:${n.port}`;
  }

  function addNode(line) {
    const n = parseNode(line);
    if (!n) { showToast("节点格式无效，应为 IP:端口:用户名:密码", "error"); return false; }
    if (nodeLibrary.includes(n.raw)) { showToast("该节点已在节点库中", "error"); nodeInput.select(); return false; }
    nodeLibrary.push(n.raw);
    saveNodeLibrary();
    renderChips();
    renderTable();
    nodeInput.value = "";
    nodeInput.focus();
    return true;
  }

  function removeNode(line) {
    nodeLibrary = nodeLibrary.filter((x) => x !== line);
    saveNodeLibrary();
    // 已选该节点的账号自动切回直连
    for (const [id, v] of rowValues) {
      if (v === line) rowValues.set(id, DIRECT_VALUE);
    }
    renderChips();
    renderTable();
  }

  function renderChips() {
    if (!nodeLibrary.length) {
      chipsBox.innerHTML = `<span class="appool-chips-empty">节点库为空，在上方粘贴节点后回车</span>`;
      return;
    }
    chipsBox.innerHTML = nodeLibrary.map((line) => `
      <span class="appool-chip" title="${esc(nodeMasked(line))}">
        <span class="appool-chip-ico"></span>
        <span class="appool-chip-text">${esc(nodeLabel(line))}</span>
        <button type="button" class="appool-chip-del" data-node="${esc(line)}" title="删除（选用该节点的账号将切回直连）">&times;</button>
      </span>`).join("");
  }

  // 下拉选项：节点库 + 方案中已在使用但不在库里的节点
  function allOptionLines() {
    const set = new Set(nodeLibrary);
    for (const v of rowValues.values()) {
      if (v && parseNode(v)) set.add(v);
    }
    return Array.from(set);
  }

  // ---------- 账号分配表 ----------
  function ingestPlan(plan) {
    lastPlanMeta = {
      failClosed: plan.failClosed !== false,
      defaultParentProxy: plan.defaultParentProxy || "http://127.0.0.1:7897",
    };
    failClosedInput.checked = lastPlanMeta.failClosed;
    parentInput.value = lastPlanMeta.defaultParentProxy;
    rows = Array.isArray(plan.accounts) ? plan.accounts : [];
    rowValues.clear();
    statusMap.clear();
    const autoAdded = [];
    for (const row of rows) {
      const line = row.enabled && row.proxyLine ? String(row.proxyLine) : DIRECT_VALUE;
      if (line && parseNode(line) && !nodeLibrary.includes(line)) { nodeLibrary.push(line); autoAdded.push(line); }
      rowValues.set(row.id, line);
      statusMap.set(row.id, row);
    }
    if (autoAdded.length) saveNodeLibrary();
  }

  function renderTable() {
    const options = allOptionLines();
    const enabledCount = Array.from(rowValues.values()).filter(Boolean).length;
    const errorCount = rows.filter((r) => {
      const v = rowValues.get(r.id);
      if (!v) return false;
      const st = statusMap.get(r.id);
      return st && (st.state === "error" || st.lastCheck?.ok === false);
    }).length;
    summary.textContent = `共 ${rows.length} 账号 · ${enabledCount} 已分配` + (errorCount ? ` · ${errorCount} 异常` : "");

    if (!rows.length) {
      resultsBox.innerHTML = `<div class="appool-no-rows">方案为空<br>点「同步账号池」自动载入全部账号</div>`;
      return;
    }

    const optionsHtml = `<option value="">${DIRECT_LABEL}</option>` +
      options.map((line) => `<option value="${esc(line)}">${esc(nodeLabel(line))}</option>`).join("");

    const body = rows.map((row) => {
      const selected = rowValues.get(row.id) ?? DIRECT_VALUE;
      const st = statusMap.get(row.id) || {};
      const enabled = Boolean(selected);
      const failed = enabled && (st.state === "error" || st.lastCheck?.ok === false);
      let pill;
      if (!enabled) pill = `<span class="appool-pill off"><span class="appool-dot"></span>直连</span>`;
      else if (failed) pill = `<span class="appool-pill err"><span class="appool-dot"></span>异常</span>`;
      else if (st.exitIp) pill = `<span class="appool-pill on"><span class="appool-dot"></span><span class="appool-ip">${esc(st.exitIp)}</span></span>`;
      else if (st.state === "active") pill = `<span class="appool-pill on"><span class="appool-dot"></span>已生效</span>`;
      else pill = `<span class="appool-pill on appool-pill-idle"><span class="appool-dot"></span>已分配</span>`;
      const detail = failed
        ? `<span class="appool-error">${esc(st.message || st.lastCheck?.message || "节点不可用")}</span>`
        : (enabled && st.lastCheck?.ok)
          ? `<span class="appool-latency">${esc(st.lastCheck.latencyMs)} ms</span>`
          : `<span class="appool-empty-cell">—</span>`;
      return `<tr data-id="${esc(row.id)}">
        <td><div class="appool-acct"><span class="appool-acct-name" title="${esc(row.name || row.id)}">${esc(row.name || row.id)}</span></div></td>
        <td><select class="appool-select" data-id="${esc(row.id)}" title="${esc(selected ? nodeMasked(selected) : DIRECT_LABEL)}">${optionsHtml}</select></td>
        <td>${pill}</td>
        <td>${detail}</td>
      </tr>`;
    }).join("");

    resultsBox.innerHTML = `<table class="appool-table"><thead><tr><th>账号</th><th>使用节点</th><th>状态</th><th>延迟 / 错误</th></tr></thead><tbody>${body}</tbody></table>`;

    // 恢复选中值（option value 含冒号，用 setValue 最稳妥）
    for (const select of resultsBox.querySelectorAll("select.appool-select")) {
      select.value = rowValues.get(select.dataset.id) ?? DIRECT_VALUE;
    }
    renderChips();
  }

  function collectPlan() {
    return {
      failClosed: failClosedInput.checked,
      defaultParentProxy: parentInput.value.trim() || "http://127.0.0.1:7897",
      accounts: rows.map((row) => {
        const line = rowValues.get(row.id) ?? DIRECT_VALUE;
        return { id: row.id, enabled: Boolean(line), proxyLine: line, parentProxy: "" };
      }),
    };
  }

  // ---------- 动作 ----------
  async function openPool() {
    modal.classList.remove("hidden");
    setBusy(true);
    try {
      const result = await api.get();
      if (!result.ok) throw new Error(result.error);
      ingestPlan(result.data);
      renderChips();
      renderTable();
    } catch (error) {
      showToast(error.message || "无法读取代理池方案", "error");
    } finally {
      setBusy(false);
    }
  }

  function closePool() {
    if (actionButtons.some((b) => b.disabled)) return;
    modal.classList.add("hidden");
  }

  async function syncPool() {
    setBusy(true);
    try {
      const result = await api.sync(collectPlan());
      if (!result.ok) throw new Error(result.error);
      ingestPlan(result.data);
      renderChips();
      renderTable();
      showToast("已按当前账号列表同步方案");
    } catch (error) {
      showToast(error.message || "同步失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function persistOrThrow() {
    const result = await api.save(collectPlan());
    if (!result.ok) throw new Error(result.error);
    for (const row of result.data.accounts || []) statusMap.set(row.id, row);
  }

  async function refreshStatus() {
    const result = await api.get();
    if (!result.ok) return;
    for (const row of result.data.accounts || []) statusMap.set(row.id, row);
    renderTable();
  }

  async function testAll() {
    setBusy(true, "测试中...");
    try {
      await persistOrThrow();
      const result = await api.test();
      if (!result.ok) throw new Error(result.error);
      const data = result.data;
      showToast(`测试完成：${data.passed}/${data.total} 个节点可用`, data.passed === data.total ? "ok" : "error");
      await refreshStatus();
    } catch (error) {
      showToast(error.message || "全部测试失败", "error");
      try { await refreshStatus(); } catch {}
    } finally {
      setBusy(false);
    }
  }

  async function applyAll() {
    setBusy(true, "批量应用中...");
    try {
      await persistOrThrow();
      const result = await api.apply();
      if (!result.ok) throw new Error(result.error);
      const data = result.data;
      if (data.aborted) showToast(`熔断：${data.message}`, "error");
      else showToast(data.message || "批量应用完成", data.ok ? "ok" : "error");
      await refreshStatus();
    } catch (error) {
      showToast(error.message || "批量应用失败", "error");
      try { await refreshStatus(); } catch {}
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    setBusy(true, "停止中...");
    try {
      const result = await api.stop();
      if (!result.ok) throw new Error(result.error);
      for (const id of rowValues.keys()) rowValues.set(id, DIRECT_VALUE);
      showToast(`已停止 ${result.data.stopped.length} 个账号的代理，全部切回直连`);
      await refreshStatus();
    } catch (error) {
      showToast(error.message || "全部停止失败", "error");
    } finally {
      setBusy(false);
    }
  }

  // ---------- 事件 ----------
  entry.addEventListener("click", openPool);
  document.getElementById("appoolSync").addEventListener("click", syncPool);
  document.getElementById("appoolTest").addEventListener("click", testAll);
  document.getElementById("appoolApply").addEventListener("click", applyAll);
  document.getElementById("appoolStop").addEventListener("click", stopAll);
  document.getElementById("appoolCancel").addEventListener("click", closePool);
  document.getElementById("appoolClose").addEventListener("click", closePool);
  modal.addEventListener("click", (event) => { if (event.target === modal) closePool(); });

  document.getElementById("appoolNodeAdd").addEventListener("click", () => addNode(nodeInput.value));
  nodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); addNode(nodeInput.value); }
  });
  nodeReveal.addEventListener("change", () => { nodeInput.type = nodeReveal.checked ? "text" : "password"; });

  chipsBox.addEventListener("click", (event) => {
    const btn = event.target.closest(".appool-chip-del");
    if (!btn) return;
    const line = btn.dataset.node;
    const usedBy = Array.from(rowValues.entries()).filter(([, v]) => v === line).map(([id]) => id);
    const tip = usedBy.length
      ? `删除该节点后，${usedBy.length} 个已分配账号将切回直连，确定删除？`
      : "确定从节点库删除该节点？";
    if (window.confirm(tip)) removeNode(line);
  });

  resultsBox.addEventListener("change", (event) => {
    const select = event.target.closest("select.appool-select");
    if (!select) return;
    rowValues.set(select.dataset.id, select.value);
    const line = select.value;
    select.title = line ? nodeMasked(line) : DIRECT_LABEL;
    const enabledCount = Array.from(rowValues.values()).filter(Boolean).length;
    summary.textContent = `共 ${rows.length} 账号 · ${enabledCount} 已分配`;
    // 更新当前行状态灯为"已分配/直连"的待保存态
    const st = statusMap.get(select.dataset.id);
    if (st) {
      if (!line) { st.exitIp = ""; st.lastCheck = null; st.state = "direct"; }
      else if (st.state !== "active") { st.exitIp = ""; st.lastCheck = null; }
    }
    renderTable();
  });
})();
