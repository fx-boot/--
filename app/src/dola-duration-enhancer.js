"use strict";

function installDola30SecondEnhancer() {
  "use strict";

  if (window.__DBM_DOLA_30_SECOND_ENHANCER__) return true;

  const host = (() => {
    try { return location.hostname.replace(/^www\./i, "").toLowerCase(); }
    catch { return ""; }
  })();
  const supportedHost = host === "dola.com" || host.endsWith(".dola.com") ||
    host === "doubao.com" || host.endsWith(".doubao.com");
  if (!supportedHost) return false;

  window.__DBM_DOLA_30_SECOND_ENHANCER__ = true;

  const STORAGE_KEY = "dbm_dola_enable_30s_v1";
  const SECONDS_KEY = "dbm_dola_duration_seconds_v2";
  const MENU_MARK = "data-dbm-dola-duration-option";
  const REQUEST_PATCH_MARK = "__dbmDola30SecondRequestPatch__";
  const MODEL_CONTROL = '[data-input-engine-actionbar-control-key="video-model"], [data-input-engine-actionbar-control-key="model"]';
  const DURATION_CONTROL = '[data-input-engine-actionbar-control-key="video-duration"], [data-input-engine-actionbar-control-key="duration"]';
  const MENU_SELECTOR = '[role="menu"], [role="listbox"], [data-slot*="dropdown-menu"], [class*="popover"], [class*="dropdown"]';
  let cachedMenu = null;
  let lastModelWasSeedance25 = false;
  let toolbarRevision = 0;

  const textOf = (element) => String(
    element?.textContent || element?.getAttribute?.("aria-label") || element?.getAttribute?.("title") || ""
  ).replace(/\s+/g, " ").trim();

  function visible(element) {
    try {
      const rect = element?.getBoundingClientRect?.();
      const style = element && getComputedStyle(element);
      return Boolean(element?.isConnected && rect?.width > 1 && rect?.height > 1 &&
        style?.display !== "none" && style?.visibility !== "hidden" && Number(style?.opacity || 1) > 0.01);
    } catch { return false; }
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, "").replace(/[\u2713\u2714\u221a]/g, "").trim();
  }

  function selectedModelText() {
    const control = document.querySelector?.(
      '[data-input-engine-actionbar-control-key="video-model"], [data-input-engine-actionbar-control-key="model"]'
    );
    return compactText(textOf(control));
  }

  function modelSupports30Seconds() {
    const model = selectedModelText();
    if (model) lastModelWasSeedance25 = /2\.5|seedance[^\d]*2[^\d]*5/i.test(model);
    return lastModelWasSeedance25;
  }

  function enabled() {
    try { return modelSupports30Seconds() && localStorage.getItem(STORAGE_KEY) === "1"; }
    catch { return false; }
  }

  function selectedSeconds() {
    try {
      const value = Number(localStorage.getItem(SECONDS_KEY));
      return Number.isInteger(value) && value >= 16 && value <= 30 ? value : 30;
    } catch { return 30; }
  }

  function saveEnabled(value) {
    try { localStorage.setItem(STORAGE_KEY, value ? "1" : "0"); } catch {}
  }

  function getRequestUrl(input) {
    return typeof input === "string" ? input : (input && (input.url || input.href)) || String(input || "");
  }

  function supportedRequestUrl(input) {
    try {
      const requestHost = new URL(getRequestUrl(input), location.href).hostname.replace(/^www\./i, "").toLowerCase();
      return requestHost === "dola.com" || requestHost.endsWith(".dola.com") ||
        requestHost === "doubao.com" || requestHost.endsWith(".doubao.com");
    } catch { return true; }
  }

  function likelyGenerationRequest(input) {
    const url = getRequestUrl(input);
    if (!supportedRequestUrl(url || location.href)) return false;
    if (/(upload|material|attachment|storage|bytevcloud|vod|tos)(?:[/?#_.-]|$)/i.test(url)) return false;
    return true;
  }

  function patchAbilityParam(raw, target) {
    if (typeof raw === "string") {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return raw; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
      parsed.duration = target;
      return JSON.stringify(parsed);
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      raw.duration = target;
    }
    return raw;
  }

  function patchVideoAbilities(payload, target, depth = 0) {
    if (!payload || typeof payload !== "object" || depth > 10) return false;
    let changed = false;
    if (Number(payload.ability_type) === 17 && Object.prototype.hasOwnProperty.call(payload, "ability_param")) {
      const next = patchAbilityParam(payload.ability_param, target);
      if (next !== payload.ability_param) payload.ability_param = next;
      changed = true;
    }
    if (Array.isArray(payload)) {
      for (const item of payload) if (patchVideoAbilities(item, target, depth + 1)) changed = true;
    } else for (const key of ['chat_ability', 'abilities']) {
      const value = payload[key]; let parsed = value;
      if (typeof value === 'string') {try { parsed = JSON.parse(value); } catch { continue; }}
      if (parsed && typeof parsed === 'object' && patchVideoAbilities(parsed, target, depth + 1)) {
        if (typeof value === 'string') payload[key] = JSON.stringify(parsed);
        changed = true;
      }
    }
    return changed;
  }

  function patchBody(body, requestUrl = "", method = "POST") {
    if (!enabled() || typeof body !== "string" || !body.trim()) return body;
    if (!/^(POST|PUT|PATCH)$/i.test(String(method || "POST"))) return body;
    if (!likelyGenerationRequest(requestUrl || location.href)) return body;
    let payload;
    try { payload = JSON.parse(body); } catch { return body; }
    return patchVideoAbilities(payload, selectedSeconds()) ? JSON.stringify(payload) : body;
  }

  function installRequestPatch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function" && originalFetch[REQUEST_PATCH_MARK] !== true) {
      const patchedFetch = async function dbmDola30SecondFetch(input, init = {}) {
        const requestUrl = getRequestUrl(input);
        if (init && typeof init.body === "string") {
          const method = init.method || (input && input.method) || "POST";
          const body = patchBody(init.body, requestUrl, method);
          if (body !== init.body) init = { ...init, body };
        } else if (typeof Request === "function" && input instanceof Request && !input.bodyUsed) {
          try {
            const originalBody = await input.clone().text();
            const body = patchBody(originalBody, requestUrl, input.method);
            if (body !== originalBody) input = new Request(input, { body });
          } catch {}
        }
        return await originalFetch.call(this, input, init);
      };
      try { Object.defineProperty(patchedFetch, REQUEST_PATCH_MARK, { value: true }); } catch {}
      window.fetch = patchedFetch;
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    if (typeof originalOpen === "function" && originalOpen[REQUEST_PATCH_MARK] !== true) {
      const patchedOpen = function dbmDola30SecondOpen(method, url) {
        this.__dbmDolaDurationRequestUrl = String(url || "");
        this.__dbmDolaDurationRequestMethod = String(method || "GET");
        return originalOpen.apply(this, arguments);
      };
      try { Object.defineProperty(patchedOpen, REQUEST_PATCH_MARK, { value: true }); } catch {}
      XMLHttpRequest.prototype.open = patchedOpen;
    }
    if (typeof originalSend === "function" && originalSend[REQUEST_PATCH_MARK] !== true) {
      const patchedSend = function dbmDola30SecondSend(body) {
        return originalSend.call(this, patchBody(
          body,
          this.__dbmDolaDurationRequestUrl || location.href,
          this.__dbmDolaDurationRequestMethod || "POST",
        ));
      };
      try { Object.defineProperty(patchedSend, REQUEST_PATCH_MARK, { value: true }); } catch {}
      XMLHttpRequest.prototype.send = patchedSend;
    }
  }

  function exactDuration(element) {
    const match = compactText(textOf(element)).match(/^(5|10|1[5-9]|2\d|30)(s|\u79d2)$/i);
    return match ? Number(match[1]) : 0;
  }

  function durationMenu() {
    if (visible(cachedMenu)) return cachedMenu;
    const candidates = Array.from(document.querySelectorAll?.(MENU_SELECTOR) || []).filter((element) => visible(element)).filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 70 || rect.width > 520 || rect.height < 40 || rect.height > 520) return false;
      const menuText = compactText(textOf(element));
      const hasNativeDurations = /5(s|\u79d2)/i.test(menuText) && /10(s|\u79d2)/i.test(menuText);
      const wholeToolbar = /Seedance|\u6bd4\u4f8b|\u53c2\u8003\u56fe|\u6a21\u578b|Model|Fast/i.test(menuText) && rect.width > 360;
      return hasNativeDurations && !wholeToolbar;
    }).sort((left, right) => {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return (a.width * a.height) - (b.width * b.height);
    });
    cachedMenu = candidates[0] || null;
    return cachedMenu;
  }

  function menuOptions(root) {
    return Array.from(root?.querySelectorAll?.('[role="menuitem"], [role="option"], li, button, div') || [])
      .filter((element) => element !== root && visible(element) && exactDuration(element) > 0);
  }

  function replaceDurationLabel(element, seconds) {
    const replace = (value) => String(value || "").replace(/(?:5|10|1[5-9]|2\d|30)(s|\u79d2)/ig, `${seconds}s`);
    try {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let changed = false;
      while (walker.nextNode()) {
        const next = replace(walker.currentNode.nodeValue);
        if (next !== walker.currentNode.nodeValue) {
          walker.currentNode.nodeValue = next;
          changed = true;
        }
      }
      if (changed) return;
    } catch {}
    element.textContent = `${seconds}s`;
  }

  function checkMarks(element) {
    return Array.from(element?.querySelectorAll?.("svg") || []);
  }

  function setSelected(element, selected) {
    element?.setAttribute?.("aria-selected", selected ? "true" : "false");
    if (selected) element?.setAttribute?.("data-state", "checked");
    else element?.removeAttribute?.("data-state");
    for (const mark of checkMarks(element)) mark.style.visibility = selected ? "visible" : "hidden";
  }

  function syncSelection(root) {
    const custom = enabled(), selected = selectedSeconds();
    for (const option of menuOptions(root)) {
      const value = exactDuration(option);
      if (option.hasAttribute(MENU_MARK)) setSelected(option, custom && value === selected);
      else if (custom) setSelected(option, false);
      if (option.hasAttribute(MENU_MARK)) {
        option.style.background = custom && value === selected ? '#3b82f633' : 'transparent';
        option.style.borderColor = custom && value === selected ? '#3b82f6' : '#8886';
      }
    }
  }

  function updateToolbar(seconds) {
    let control = document.querySelector(DURATION_CONTROL);
    if (!control) {
      const bar = document.querySelector(MODEL_CONTROL)?.closest('[data-input-engine-actionbar], [class*="actionbar"], [class*="action-bar"]');
      control = [...bar?.querySelectorAll('button,[role="button"]') || []].find(x => exactDuration(x) && !x.closest(MENU_SELECTOR));
    }
    if (!visible(control) || control.closest(MENU_SELECTOR)) return;
    try {
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!/^\s*(5|10|1[5-9]|2\d|30)s\s*$/i.test(node.nodeValue || "")) continue;
        if (node.nodeValue !== `${seconds}s`) node.nodeValue = `${seconds}s`;
      }
    } catch {}
  }

  function holdToolbar(seconds) {
    const revision = ++toolbarRevision;
    for (const delay of [0, 50, 120, 300, 800, 1500, 3000]) {
      setTimeout(() => { if (revision === toolbarRevision && modelSupports30Seconds()) updateToolbar(seconds); }, delay);
    }
  }

  function enhanceMenu() {
    const root = durationMenu();
    if (!root) return false;
    const supports30 = modelSupports30Seconds();
    if (!supports30) root.querySelector('[data-dbm-duration-grid]')?.remove();
    if (!supports30) return false;

    let options = menuOptions(root);
    if (!root.querySelector('[data-dbm-duration-grid]')) {
      const template = options.find((option) => exactDuration(option) === 10) || options[0];
      if (!template?.parentElement) return false;
      const panel = document.createElement('div');
      panel.setAttribute('data-dbm-duration-grid', 'true');
      panel.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:8px 4px;min-width:180px;';
      for (let seconds = 16; seconds <= 30; seconds++) {
      const option = document.createElement('button');
      option.type = 'button'; option.textContent = `${seconds}s`;
      option.setAttribute('role', 'menuitem');
      option.setAttribute('aria-label', `${seconds} 秒`);
      option.title = `请求生成 ${seconds} 秒视频`;
      option.style.cssText = 'min-width:0;min-height:32px;padding:4px 8px;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer;';
      option.setAttribute(MENU_MARK, String(seconds));
      option.setAttribute("aria-selected", "false");
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        try { localStorage.setItem(SECONDS_KEY, String(seconds)); } catch {}
        saveEnabled(true);
        syncSelection(root);
        holdToolbar(seconds);
        setTimeout(() => {
          try {
            const keyboard = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
            document.activeElement?.dispatchEvent?.(new KeyboardEvent("keydown", keyboard));
            document.dispatchEvent?.(new KeyboardEvent("keydown", keyboard));
            document.dispatchEvent?.(new KeyboardEvent("keyup", keyboard));
          } catch { document.body?.click?.(); }
        }, 60);
      }, true);
      option.addEventListener('keydown', event => {
        const keys = {ArrowRight:1, ArrowLeft:-1, ArrowDown:3, ArrowUp:-3};
        if (event.key in keys) {event.preventDefault();event.stopPropagation();panel.children[(seconds - 16 + keys[event.key] + 15) % 15]?.focus();}
      });
      panel.appendChild(option);
      }
      template.parentElement.appendChild(panel);
    }

    options = menuOptions(root);
    for (const option of options) {
      const value = exactDuration(option);
      if ((value === 5 || value === 10 || value === 15) && !option.hasAttribute("data-dbm-native-duration")) {
        option.setAttribute("data-dbm-native-duration", String(value));
        option.addEventListener("click", () => {
          saveEnabled(false);
          syncSelection(root);
          holdToolbar(value);
        }, true);
      }
    }
    syncSelection(root);
    return true;
  }

  function tick() {
    installRequestPatch();
    enhanceMenu();
    if (enabled()) updateToolbar(selectedSeconds());
  }

  let pendingTick = null;
  const schedule = () => {if (!pendingTick) pendingTick = setTimeout(() => {pendingTick = null; tick();}, 80);};
  function startUI() {
    tick();
    const relevant = MODEL_CONTROL + ',' + DURATION_CONTROL + ',' + MENU_SELECTOR;
    const observer = new MutationObserver(records => {
      if (records.some(r => {
        const element = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (element?.closest?.('[data-dbm-duration-grid]')) return false;
        if (element?.closest?.(relevant)) return true;
        return [...r.addedNodes].some(n => n.nodeType === 1 && (n.matches(relevant) || n.querySelector(relevant)));
      })) schedule();
    });
    const observe = () => observer.observe(document.documentElement, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['aria-expanded','hidden','data-state','style','class']});
    observe();
    document.addEventListener('click', event => {if (event.target.closest?.(DURATION_CONTROL + ',' + MODEL_CONTROL)) {cachedMenu = null; schedule();}}, true);
    document.addEventListener('visibilitychange', () => {if (!document.hidden) schedule();});
    window.addEventListener('pagehide', () => {observer.disconnect(); clearTimeout(pendingTick);pendingTick=null;});
    window.addEventListener('pageshow', event => {if(event.persisted){observe();schedule();}});
  }
  installRequestPatch();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startUI, { once: true });
  else startUI();
  return true;
}

module.exports = { installDola30SecondEnhancer };
