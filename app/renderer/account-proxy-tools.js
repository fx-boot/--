"use strict";

(() => {
  if (window.__DBM_ACCOUNT_PROXY_TOOLS__) return;
  window.__DBM_ACCOUNT_PROXY_TOOLS__ = true;

  const api = window.managerProxyAPI;
  const accountList = document.getElementById("accountList");
  if (!api || !accountList) return;

  const proxyStates = new Map();
  let activeAccountId = "";
  let activeAccountName = "";
  let busy = false;
  let returnFocus = null;

  const modal = document.createElement("div");
  modal.id = "accountProxyModal";
  modal.className = "overlay hidden";
  modal.innerHTML = `
    <form class="modal account-proxy-modal" id="accountProxyForm" role="dialog" aria-modal="true" aria-labelledby="accountProxyTitle" aria-describedby="accountProxyAccount">
      <div class="modal-title">
        <div><span class="eyebrow">ACCOUNT NETWORK</span><h2 id="accountProxyTitle">账号代理</h2><p id="accountProxyAccount"></p></div>
        <button type="button" class="modal-close" id="accountProxyClose" title="关闭" aria-label="关闭">&times;</button>
      </div>
      <div class="modal-body">
        <label class="account-proxy-enable">
          <span><strong>启用独立 SOCKS5</strong><small id="accountProxyModeText">直连</small></span>
          <input type="checkbox" id="accountProxyEnabled">
        </label>
        <div class="field account-proxy-field">
          <span class="account-proxy-field-title"><b id="accountProxyLineLabel">SOCKS5 代理</b><label><input type="checkbox" id="accountProxyReveal"> 显示</label></span>
          <input id="accountProxyLine" type="password" autocomplete="off" spellcheck="false" aria-labelledby="accountProxyLineLabel" placeholder="host:port:username:password">
        </div>
        <label class="field account-proxy-field">
          <span>本机规则代理</span>
          <input id="accountProxyParent" type="text" autocomplete="off" spellcheck="false" value="http://127.0.0.1:7897">
        </label>
        <div class="account-proxy-result" id="accountProxyResult" data-state="direct">
          <span class="account-proxy-result-dot"></span><strong>直连</strong><small></small>
        </div>
      </div>
      <div class="modal-actions account-proxy-actions">
        <button type="button" class="secondary-action account-proxy-disable hidden" id="accountProxyDisable">停用代理</button>
        <span class="account-proxy-action-spacer"></span>
        <button type="button" class="secondary-action" id="accountProxyCancel">取消</button>
        <button type="button" class="secondary-action" id="accountProxyTest">测试连接</button>
        <button type="submit" class="primary-action" id="accountProxySave">保存并应用</button>
      </div>
    </form>
  `;
  document.body.appendChild(modal);

  const form = document.getElementById("accountProxyForm");
  const accountLabel = document.getElementById("accountProxyAccount");
  const enabledInput = document.getElementById("accountProxyEnabled");
  const modeText = document.getElementById("accountProxyModeText");
  const proxyLineInput = document.getElementById("accountProxyLine");
  const parentInput = document.getElementById("accountProxyParent");
  const revealInput = document.getElementById("accountProxyReveal");
  const resultBox = document.getElementById("accountProxyResult");
  const disableButton = document.getElementById("accountProxyDisable");
  const testButton = document.getElementById("accountProxyTest");
  const saveButton = document.getElementById("accountProxySave");

  function showToast(message, type = "ok") {
    const region = document.getElementById("toastRegion");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = `toast account-proxy-toast ${type}`;
    toast.textContent = message;
    region.appendChild(toast);
    setTimeout(() => toast.remove(), 3600);
  }

  function setBusy(value) {
    busy = Boolean(value);
    for (const control of [enabledInput, proxyLineInput, parentInput, revealInput, disableButton, testButton, saveButton]) {
      control.disabled = busy;
    }
    document.getElementById("accountProxyCancel").disabled = busy;
    document.getElementById("accountProxyClose").disabled = busy;
  }

  function setResult(state, title, detail = "") {
    resultBox.dataset.state = state;
    resultBox.querySelector("strong").textContent = title;
    resultBox.querySelector("small").textContent = detail;
  }

  function resultFromProxy(proxy) {
    if (!proxy?.enabled) return setResult("direct", "直连");
    if (proxy.state === "error") return setResult("error", "代理异常", proxy.message || proxy.proxyMasked);
    if (proxy.state === "testing") return setResult("testing", "正在测试", proxy.proxyMasked);
    if (proxy.state === "starting") return setResult("testing", "正在应用", proxy.proxyMasked);
    if (proxy.exitIp) return setResult("active", `出口 IP ${proxy.exitIp}`, proxy.proxyMasked);
    return setResult("active", "独立代理已启用", proxy.proxyMasked);
  }

  function badgeText(proxy) {
    if (!proxy?.enabled) return "";
    if (proxy.state === "error") return "SOCKS 异常";
    if (proxy.state === "testing") return "SOCKS 测试中";
    if (proxy.state === "starting") return "SOCKS 应用中";
    return proxy.exitIp ? `SOCKS · ${proxy.exitIp}` : "SOCKS 已启用";
  }

  function decorateCards() {
    for (const card of accountList.querySelectorAll(".account-card[data-id]")) {
      const accountId = card.dataset.id;
      const info = card.querySelector(".account-info");
      if (!info) continue;
      const proxy = proxyStates.get(accountId);
      let badge = info.querySelector(".account-proxy-badge");
      const label = badgeText(proxy);
      if (!label) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "account-proxy-badge";
        info.appendChild(badge);
      }
      badge.dataset.state = proxy.state || "configured";
      if (badge.textContent !== label) badge.textContent = label;
      const title = [proxy.proxyMasked, proxy.parentProxy, proxy.message].filter(Boolean).join("\n");
      if (badge.title !== title) badge.title = title;
    }
  }

  function addProxyMenuCommands() {
    for (const popover of accountList.querySelectorAll(".account-popover")) {
      if (popover.querySelector(".account-proxy-command")) continue;
      const card = popover.closest(".account-card[data-id]");
      if (!card) continue;
      const command = document.createElement("button");
      command.type = "button";
      command.className = "account-proxy-command";
      command.textContent = "代理设置";
      command.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openProxyModal(card.dataset.id, command);
      });
      const danger = popover.querySelector("button.danger");
      popover.insertBefore(command, danger || null);
    }
  }

  async function refreshProxyStates(payload = null) {
    const proxies = Array.isArray(payload?.proxies) ? payload.proxies : await api.list();
    proxyStates.clear();
    for (const proxy of proxies || []) proxyStates.set(proxy.accountId, proxy);
    decorateCards();
    if (activeAccountId && !modal.classList.contains("hidden")) {
      const current = proxyStates.get(activeAccountId);
      if (current) resultFromProxy(current);
    }
  }

  async function openProxyModal(accountId, source) {
    if (!accountId || busy) return;
    activeAccountId = accountId;
    returnFocus = source || document.activeElement;
    activeAccountName = accountList.querySelector(`.account-card[data-id="${CSS.escape(accountId)}"] .account-info strong`)
      ?.textContent?.trim() || accountId;
    setBusy(true);
    try {
      const proxy = await api.get(accountId);
      accountLabel.textContent = activeAccountName;
      enabledInput.checked = Boolean(proxy.enabled);
      modeText.textContent = proxy.enabled ? "SOCKS5" : "直连";
      proxyLineInput.value = proxy.proxyLine || "";
      parentInput.value = proxy.parentProxy || "http://127.0.0.1:7897";
      revealInput.checked = false;
      proxyLineInput.type = "password";
      disableButton.classList.toggle("hidden", !proxy.configured && !proxy.enabled);
      resultFromProxy(proxy);
      modal.classList.remove("hidden");
      proxyLineInput.focus();
    } catch (error) {
      showToast(error.message || "无法读取代理配置", "error");
      activeAccountId = "";
    } finally {
      setBusy(false);
    }
  }

  function closeProxyModal() {
    if (busy) return;
    modal.classList.add("hidden");
    activeAccountId = "";
    activeAccountName = "";
    returnFocus?.focus?.();
    returnFocus = null;
  }

  function proxyInput() {
    return {
      accountId: activeAccountId,
      enabled: enabledInput.checked,
      proxyLine: proxyLineInput.value.trim(),
      parentProxy: parentInput.value.trim() || "http://127.0.0.1:7897",
    };
  }

  async function testCurrentProxy() {
    const input = proxyInput();
    if (!input.proxyLine) return setResult("error", "代理格式无效");
    setBusy(true);
    testButton.textContent = "测试中...";
    setResult("testing", "正在测试链路", input.parentProxy);
    try {
      const saved = await api.get(activeAccountId);
      const useSaved = saved.enabled && saved.proxyLine === input.proxyLine && saved.parentProxy === input.parentProxy;
      const result = await api.test(useSaved ? { accountId: activeAccountId } : {
        proxyLine: input.proxyLine,
        parentProxy: input.parentProxy,
      });
      setResult("active", result.exitIp ? `出口 IP ${result.exitIp}` : "链路可用", `${result.latencyMs} ms`);
      showToast(result.exitIp ? `代理可用，出口 ${result.exitIp}` : "代理链路可用");
      await refreshProxyStates();
    } catch (error) {
      setResult("error", "连接失败", error.message || "代理链路不可用");
      showToast(error.message || "代理连接失败", "error");
    } finally {
      testButton.textContent = "测试连接";
      setBusy(false);
    }
  }

  async function saveCurrentProxy(event) {
    event.preventDefault();
    const input = proxyInput();
    let shouldClose = false;
    setBusy(true);
    saveButton.textContent = "应用中...";
    try {
      if (input.enabled) await api.save(input);
      else await api.disable(activeAccountId);
      await refreshProxyStates();
      showToast(input.enabled ? `${activeAccountName} 已启用独立代理` : `${activeAccountName} 已切换直连`);
      shouldClose = true;
    } catch (error) {
      setResult("error", "应用失败", error.message || "代理配置无效");
      showToast(error.message || "代理应用失败", "error");
    } finally {
      saveButton.textContent = "保存并应用";
      setBusy(false);
      if (shouldClose) closeProxyModal();
    }
  }

  async function disableCurrentProxy() {
    if (!activeAccountId) return;
    setBusy(true);
    try {
      await api.disable(activeAccountId);
      enabledInput.checked = false;
      modeText.textContent = "直连";
      disableButton.classList.add("hidden");
      setResult("direct", "直连");
      await refreshProxyStates();
      showToast(`${activeAccountName} 已切换直连`);
    } catch (error) {
      setResult("error", "停用失败", error.message || "无法切换直连");
      showToast(error.message || "无法停用代理", "error");
    } finally {
      setBusy(false);
    }
  }

  enabledInput.addEventListener("change", () => {
    modeText.textContent = enabledInput.checked ? "SOCKS5" : "直连";
  });
  revealInput.addEventListener("change", () => {
    proxyLineInput.type = revealInput.checked ? "text" : "password";
  });
  form.addEventListener("submit", saveCurrentProxy);
  testButton.addEventListener("click", testCurrentProxy);
  disableButton.addEventListener("click", disableCurrentProxy);
  document.getElementById("accountProxyCancel").addEventListener("click", closeProxyModal);
  document.getElementById("accountProxyClose").addEventListener("click", closeProxyModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeProxyModal();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeProxyModal();
    }
  });

  let decorateQueued = false;
  new MutationObserver(() => {
    if (decorateQueued) return;
    decorateQueued = true;
    queueMicrotask(() => {
      decorateQueued = false;
      decorateCards();
      addProxyMenuCommands();
    });
  }).observe(accountList, { childList: true, subtree: true });

  api.onChanged((payload) => refreshProxyStates(payload).catch(() => {}));
  refreshProxyStates().catch((error) => showToast(error.message || "代理状态读取失败", "error"));
})();
