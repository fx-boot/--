"use strict";const{contextBridge:t,ipcRenderer:e}=require("electron"),{installBrowserFingerprint:n}=({installBrowserFingerprint:function t(t){if(!t||"object"!=typeof t)return!1;const e=new WeakMap,r=Function.prototype.toString,n=(t,n)=>{try{e.set(t,r.call(n))}catch{}return t},a=(t,e,r)=>{if(!t)return;const a=Object.getOwnPropertyDescriptor(t,e)?.get,o=n(function(){return r},a||function(){});try{Object.defineProperty(t,e,{configurable:!0,enumerable:!a||Object.getOwnPropertyDescriptor(t,e)?.enumerable,get:o})}catch{}},o=(t,e,r)=>{const a=t?.[e];if("function"!=typeof a)return null;const o=n(r(a),a);try{return Object.defineProperty(t,e,{configurable:!0,enumerable:!1,writable:!0,value:o}),a}catch{return null}},i=n(function(){return e.has(this)?e.get(this):r.call(this)},r);try{Object.defineProperty(Function.prototype,"toString",{configurable:!0,writable:!0,value:i})}catch{}const l=t.navigator||{},c=globalThis.Navigator?.prototype;a(c,"userAgent",t.userAgent),a(c,"appVersion",t.appVersion),a(c,"platform",l.platform),a(c,"vendor",l.vendor),a(c,"language",t.languages?.[0]||"zh-CN"),a(c,"languages",Object.freeze([...t.languages||["zh-CN"]])),a(c,"hardwareConcurrency",l.hardwareConcurrency),a(c,"deviceMemory",l.deviceMemory),a(c,"maxTouchPoints",l.maxTouchPoints),a(c,"webdriver",Boolean(l.webdriver));const s=t.userAgentData||{},u=Object.freeze((s.brands||[]).map(t=>Object.freeze({...t}))),p=Object.freeze((s.fullVersionList||[]).map(t=>Object.freeze({...t}))),h={brands:u,mobile:Boolean(s.mobile),platform:s.platform||"Windows",async getHighEntropyValues(t){const e={architecture:s.architecture,bitness:s.bitness,brands:u,fullVersionList:p,mobile:Boolean(s.mobile),model:s.model,platform:s.platform,platformVersion:s.platformVersion,uaFullVersion:s.uaFullVersion,wow64:Boolean(s.wow64)};return Object.fromEntries(["brands","mobile","platform",...Array.from(t||[])].filter((t,r,n)=>n.indexOf(t)===r&&t in e).map(t=>[t,e[t]]))},toJSON(){return{brands:this.brands,mobile:this.mobile,platform:this.platform}}};a(c,"userAgentData",Object.freeze(h));const b=t.screen||{},f=globalThis.Screen?.prototype;for(const t of["width","height","availWidth","availHeight","availLeft","availTop","colorDepth","pixelDepth"])a(f,t,b[t]);a(globalThis,"devicePixelRatio",b.devicePixelRatio);const g=t.webgl||{},m=t=>{o(t,"getParameter",t=>function(e){return 37445===e?g.vendor:37446===e?g.renderer:t.apply(this,arguments)})};m(globalThis.WebGLRenderingContext?.prototype),m(globalThis.WebGL2RenderingContext?.prototype);const d=t.canvas||{},y=(t,e,r)=>{if(!t?.data?.length||e<=0||r<=0)return t;const n=Number(d.xSalt||0)%e,a=Number(d.ySalt||0)%r,o=Number(d.channel||0)%3,i=Math.min(t.data.length-4,4*(a*e+n)),l=i+o,c=t.data[l],s=Number(d.delta||1)>=0?1:2;return t.data[l]=c^s,t.data[i+3]=1^t.data[i+3],t},w=globalThis.CanvasRenderingContext2D?.prototype,v=w?.getImageData,O=w?.putImageData;o(w,"getImageData",t=>function(e,r,n,a){const o=t.apply(this,arguments);return y(o,Number(n),Number(a))});const x=globalThis.HTMLCanvasElement?.prototype,D=t=>{if(!t?.width||!t?.height||!globalThis.document)return null;const e=document.createElement("canvas");e.width=t.width,e.height=t.height;const r=e.getContext("2d");if(!r||"function"!=typeof v||"function"!=typeof O)return null;r.drawImage(t,0,0);const n=e.width,a=e.height,o=Number(d.xSalt||0)%n,i=Number(d.ySalt||0)%a,l=v.call(r,o,i,1,1);return y(l,1,1),O.call(r,l,o,i),e};o(x,"toDataURL",t=>function(){try{const e=D(this);if(e)return t.apply(e,arguments)}catch{}return t.apply(this,arguments)}),o(x,"toBlob",t=>function(){try{const e=D(this);if(e)return t.apply(e,arguments)}catch{}return t.apply(this,arguments)});const N=t.audio||{},T=(t,e)=>{if(!t?.length)return t;const r=Number(N.indexSalt||0)%t.length;return"byte"===e?t[r]=Math.max(0,Math.min(255,t[r]+(N.delta>=0?1:-1))):t[r]+=Number(N.delta||0),t},j=globalThis.AnalyserNode?.prototype;return o(j,"getFloatFrequencyData",t=>function(e){const r=t.apply(this,arguments);return T(e,"float"),r}),o(j,"getFloatTimeDomainData",t=>function(e){const r=t.apply(this,arguments);return T(e,"float"),r}),o(j,"getByteFrequencyData",t=>function(e){const r=t.apply(this,arguments);return T(e,"byte"),r}),!0}});try{const o=e.sendSync("browser-fingerprint:get");o&&t.executeInMainWorld({func:n,args:[o]})}catch{}const o=new Set;let r=[],i=null,a=[];const d="dbm-dola-no-watermark-style",s="dbm-dola-no-watermark-download",c="data-dbm-dola-download-host";function l(t){try{const e=new URL(String(t||""),location.href);return["http:","https:"].includes(e.protocol)?e.toString():""}catch{return""}}function u(t,e=""){const n=`${t} ${e}`.toLowerCase();return/video\/(mp4|webm|quicktime)|\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(n)?"video":/image\/(jpeg|png|webp|gif)|\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(n)?"image":""}function m(t){const n=l(t.url),d=t.type||u(n,t.mime);n&&d&&!o.has(n)&&!/avatar|emoji|icon|logo|favicon/i.test(n)&&(o.add(n),"video"===d&&(a=[n,...a.filter(t=>t!==n)].slice(0,20)),r.push({...t,url:n,type:d}),r.length>100&&(r=r.slice(-100)),clearTimeout(i),i=setTimeout(()=>{r.length&&e.sendToHost("manager:resources",r.splice(0))},350))}function p(t){if(!(t instanceof Element))return;const e=t.matches("img,video,source")?[t]:[...t.querySelectorAll("img,video,source")];for(const t of e){const e=t.currentSrc||t.src||t.getAttribute("src");if(!e)continue;const n=t.getBoundingClientRect();"IMG"===t.tagName&&n.width>0&&n.height>0&&(n.width<160||n.height<120)||m({url:e,type:"VIDEO"===t.tagName||"SOURCE"===t.tagName?"video":"image",preview:"VIDEO"===t.tagName?t.poster:e,name:t.getAttribute("alt")||t.getAttribute("title")||""})}}function g(){return/(^|\.)dola\.com$/i.test(location.hostname)||"dola"===document.documentElement?.dataset?.dbmPlatform}function f(){if(document.getElementById(d))return;const t=document.createElement("style");t.id=d,t.textContent=`\n    .${s} {\n      position: absolute !important;\n      right: 12px !important;\n      bottom: 12px !important;\n      z-index: 2147483646 !important;\n      min-width: 104px !important;\n      height: 34px !important;\n      padding: 0 13px !important;\n      border: 1px solid rgba(255,255,255,.34) !important;\n      border-radius: 999px !important;\n      background: rgba(12,18,28,.88) !important;\n      color: #8ff0ce !important;\n      box-shadow: 0 6px 18px rgba(0,0,0,.28) !important;\n      backdrop-filter: blur(8px) !important;\n      font: 600 13px/32px "Microsoft YaHei UI",sans-serif !important;\n      cursor: pointer !important;\n      white-space: nowrap !important;\n    }\n    .${s}:hover { background: rgba(24,78,63,.94) !important; }\n    .${s}:disabled { cursor: wait !important; opacity: .78 !important; }\n  `,document.documentElement.appendChild(t)}function h(t){if(!(t instanceof HTMLVideoElement&&t.isConnected))return!1;const e=t.getBoundingClientRect(),n=getComputedStyle(t);return e.width>=180&&e.height>=100&&"none"!==n.display&&"hidden"!==n.visibility}function b(t){if(!(t instanceof Element&&t.isConnected))return!1;const e=t.getBoundingClientRect(),n=getComputedStyle(t);return e.width>=180&&e.height>=100&&"none"!==n.display&&"hidden"!==n.visibility}function w(t){const e=t.getBoundingClientRect();let n=t.parentElement,o=n;for(let t=0;n&&n!==document.body&&t<6;t+=1){const t=n.getBoundingClientRect();if(t.width>=.9*e.width&&t.height>=.9*e.height&&(o=n,t.width<=e.width+80&&t.height<=e.height+100&&n.querySelectorAll('video,[class*="block-video"]').length<=1))return n;n=n.parentElement}return o}function y(t){return[t.currentSrc,t.src,t.querySelector("source")?.src,t.getAttribute("data-src"),...a].map(l).find(Boolean)||""}function v(){return`Dola_\u65e0\u6c34\u5370\u89c6\u9891_${(new Date).toISOString().replace(/[-:T.Z]/g,"").slice(0,14)}.mp4`}function S(t=document){if(!g())return;f();const n=[],o=[],r=[];t instanceof HTMLVideoElement&&o.push(t),t instanceof Element&&/(?:^|\s)block-video(?:-|\s|$)/i.test(t.className||"")&&r.push(t),t?.querySelectorAll&&(o.push(...t.querySelectorAll("video")),r.push(...t.querySelectorAll('[class*="block-video"]')));for(const t of o){if(!h(t))continue;const e=w(t);e&&n.push(e)}for(const t of r)b(t)&&n.push(t);for(const t of Array.from(new Set(n))){if(!t||t.querySelector(`:scope > .${s}`))continue;t.style.setProperty("position","relative","important"),t.setAttribute(c,"true");const n=document.createElement("button");n.type="button",n.className=s,n.textContent="\u65e0\u6c34\u5370\u4e0b\u8f7d",n.title="\u89e3\u6790\u5e76\u4e0b\u8f7d Dola \u5b98\u65b9\u65e0\u6c34\u5370\u539f\u7247",n.addEventListener("click",o=>{if(o.preventDefault(),o.stopPropagation(),o.stopImmediatePropagation?.(),n.disabled)return;const r=t.querySelector("video"),i=r?y(r):"",a=String(t.closest("[data-message-id]")?.getAttribute("data-message-id")||"");if(!i&&!a)return n.textContent="\u672a\u627e\u5230\u89c6\u9891",void setTimeout(()=>{n.textContent="\u65e0\u6c34\u5370\u4e0b\u8f7d"},2400);const d=`dola-${Date.now()}-${Math.random().toString(16).slice(2)}`;n.dataset.requestId=d,n.disabled=!0,n.textContent="\u4e0b\u8f7d\u4e2d\u2026",e.sendToHost("manager:dola-no-watermark-download",{requestId:d,url:i,messageId:a,filename:v(),type:"video"})},!0),t.appendChild(n)}}window.addEventListener("DOMContentLoaded",()=>{p(document.body),S(document);let t=0;new MutationObserver(e=>{for(const t of e)for(const e of t.addedNodes)p(e);clearTimeout(t),t=setTimeout(()=>S(document),180)}).observe(document.documentElement,{childList:!0,subtree:!0,attributes:!0}),setInterval(()=>S(document),1200)}),window.addEventListener("message",t=>{if(t.source!==window)return;if("dbm:dola-no-watermark-progress"===t.data?.type){const e=String(t.data.requestId||""),n=Array.from(document.querySelectorAll(`.${s}`)).find(t=>t.dataset.requestId===e);if(!n)return;return n.textContent=String(t.data.label||"\u5904\u7406\u4e2d\u2026"),void(t.data.done&&setTimeout(()=>{n.disabled=!1,n.textContent="\u65e0\u6c34\u5370\u4e0b\u8f7d",delete n.dataset.requestId},t.data.ok?1800:3e3))}if("electronDownload"!==t.data?.type)return;const n=t.data?.data||{},o=l(n.url),r=l(n.backupUrl);o&&"video"===n.type&&n.confirmedNoWatermark&&e.sendToHost("manager:no-watermark-download",{url:o,backupUrl:r,filename:String(n.filename||`\u8c46\u5305\u5b98\u65b9\u65e0\u6c34\u5370_${Date.now()}.mp4`),type:"video"})});try{new PerformanceObserver(t=>{for(const e of t.getEntries()){const t=u(e.name,e.initiatorType);t&&m({url:e.name,type:t})}}).observe({type:"resource",buffered:!0})}catch{}
const { contextBridge: durationContextBridge } = require("electron");
const { installDola30SecondEnhancer } = ({installDola30SecondEnhancer:function installDola30SecondEnhancer() {
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
}});
try {
  durationContextBridge.executeInMainWorld({ func: installDola30SecondEnhancer, args: [] });
} catch {}

// HD ORIGINAL OBSERVER
(()=>{const {contextBridge,ipcRenderer}=require('electron');try{contextBridge.executeInMainWorld({func:()=>{(function installObserver(createParser){
 if(window.__DBM_HD_OBSERVER__)return;const parser=createParser(),limit=4*1024*1024,cache=new Map();let active=0;
 function publish(groups){for(const g of groups){cache.set(g.id,{group:g,at:Date.now()});}while(cache.size>60)cache.delete(cache.keys().next().value);if(groups.length)window.postMessage({source:'dbm-hd-observer',groups},'*');}
 async function capture(response){
  if(active>=8)return;const type=response.headers.get('content-type')||'',stream=/event-stream/i.test(type);
  if(!/json|event-stream/i.test(type)||Number(response.headers.get('content-length'))>limit)return;
  const reader=response.clone().body?.getReader();if(!reader)return;active++;const chunks=[],decoder=new TextDecoder();let size=0,pending='';
  function events(final=false){let end;while((end=pending.search(/\r?\n\r?\n/))>=0){const event=pending.slice(0,end);pending=pending.slice(end).replace(/^\r?\n\r?\n/,'');const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');try{publish(parser.parse(JSON.parse(data)));}catch{}}if(final&&pending){pending+='\n\n';events();}}
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){void reader.cancel().catch(()=>{});return;}if(stream){pending+=decoder.decode(part.value,{stream:true});events();}else chunks.push(part.value);}if(stream){pending+=decoder.decode();events(true);}else{const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}publish(parser.parse(JSON.parse(decoder.decode(bytes))));}}catch{}finally{active--;}
 }
 const fetch=window.fetch;window.fetch=async function(){const response=await fetch.apply(this,arguments);void capture(response).catch(()=>{});return response;};
 const send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){this.addEventListener('load',()=>{try{if(this.responseType==='json')publish(parser.parse(this.response));else if((!this.responseType||this.responseType==='text')&&this.responseText.length<=limit&&/json/i.test(this.getResponseHeader('content-type')||''))publish(parser.parse(JSON.parse(this.responseText)));}catch{}},{once:true});return send.apply(this,arguments);};
 function scan(){const groups=[...cache.values()].filter(v=>Date.now()-v.at<30*60*1000).map(v=>v.group);for(const video of [...document.querySelectorAll('video')].slice(0,30)){const url=parser.url(video.currentSrc||video.src||video.querySelector('source')?.src);if(url&&!groups.some(g=>g.variants.some(v=>v.url===url)))groups.push({id:url,title:'页面视频',variants:[{url,width:video.videoWidth,height:video.videoHeight}]});}if(groups.length)window.postMessage({source:'dbm-hd-observer',groups:groups.slice(0,60)},'*');return groups.length;}
 window.__DBM_HD_OBSERVER__={scan};window.addEventListener('DOMContentLoaded',scan,{once:true});
})(function createParser() {
 const number=x=>Number.isFinite(Number(x))&&Number(x)>0?Number(x):0;
 function fallback(value){if(typeof value!=='string'||value.length>16000)return '';try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/(^|\.)byteintlapi\.com$/i.test(u.hostname)&&/^\/video\/fplay(?:\/|$)/i.test(u.pathname)?u.href:'';}catch{return '';}}
 function url(value){if(typeof value!=='string'||value.length>16000)return '';let text=value.trim();if(!/^https?:\/\//i.test(text)){try{text=atob(text.replace(/-/g,'+').replace(/_/g,'/'));}catch{return '';}}try{const u=new URL(text);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/\.(m3u8|mpd|jpe?g|png|webp|gif|svg)(?:$|\/)/i.test(u.pathname)?text:'';}catch{return '';}}
 function variant(item,parent={}){
  if(!item||typeof item!=='object')return [];
  const meta={width:number(item.vwidth||item.width||parent.width),height:number(item.vheight||item.height||parent.height),bitrate:number(item.real_bitrate||item.bit_rate||item.bitrate||parent.bitrate),size:number(item.size||item.file_size||parent.size),codec:String(item.codec_type||item.codec||parent.codec||'').slice(0,40),definition:String(item.definition||item.quality||parent.definition||'').slice(0,40)};
  const values=[];
  for(const key of ['main_url','backup_url','backup_url_1','play_url','download_url','original_url','origin_url','url']){const parsed=url(item[key]);if(parsed)values.push({...meta,...(key==='download_url'&&item.video_model?{width:0,height:0}:{}),url:parsed});}
  for(const list of [item.url_list,item.backup_urls])if(Array.isArray(list))for(const value of list.slice(0,5)){const parsed=url(value);if(parsed)values.push({...meta,url:parsed});}
  for(const key of ['play_addr','download_addr','play_addr_h264','play_addr_265','original_video_info','original_media_info'])if(item[key]&&item[key]!==item)values.push(...variantLeaf(item[key],meta));
  return values;
 }
 function variantLeaf(item,parent){const leaf={...item};for(const key of ['play_addr','download_addr','play_addr_h264','play_addr_265','original_video_info','original_media_info'])delete leaf[key];return variant(leaf,parent);}
 function parse(payload){const groups=[],seen=new Set();let visited=0;
  function walk(node,at,depth){if(!node||typeof node!=='object'||depth>14||++visited>6000||groups.length>=60||seen.has(node))return;seen.add(node);
   if(Array.isArray(node)){node.slice(0,300).forEach((value,i)=>walk(value,at+'['+i+']',depth+1));return;}
   const entries=[];
   let model=node.video_model;if(typeof model==='string'&&model.length<1048576){try{model=JSON.parse(model);}catch{model=null;}}
   if(model&&typeof model==='object'&&(!node.vid||!model.video_id||node.vid===model.video_id)){
    const versions=model.video_list;if(versions&&typeof versions==='object')for(const value of Object.values(versions).slice(0,30))if(value&&typeof value==='object')entries.push(value);
   }
   for(const key of ['bit_rate','bitrate_versions','video_versions'])if(Array.isArray(node[key]))entries.push(...node[key].slice(0,30));
   if(node.video_list&&!Array.isArray(node.video_list)&&typeof node.video_list==='object')for(const [name,value] of Object.entries(node.video_list).slice(0,30))if(/^(video_\d+|\d+p|hd|sd|fhd|uhd|original)$/i.test(name)&&value&&typeof value==='object')entries.push({...value,definition:value.definition||name});
   const isVideo=entries.length||node.video_id||node.vid||node.play_addr||/(?:^|\.)(video|video_info|original_video_info|original_media_info)$/.test(at);
   let variants=isVideo?[...variant(node),...entries.flatMap(value=>variant(value,node))]:[];
   const unique=new Map();for(const v of variants)if(!unique.has(v.url))unique.set(v.url,v);variants=[...unique.values()].slice(0,30);
   const matchingModel=model&&typeof model==='object'&&(!node.vid||!model.video_id||node.vid===model.video_id)?model:null;
   const fallbackApi=fallback(matchingModel?.fallback_api||node.fallback_api);
   if(variants.length||fallbackApi){groups.push({id:String(node.video_id||node.vid||matchingModel?.video_id||fallbackApi||variants[0].url).slice(0,16000),title:String(node.title||node.desc||'视频原片').slice(0,100),...(fallbackApi?{fallbackApi}:{}),variants});return;}
   for(const [key,value] of Object.entries(node).slice(0,150)){if(value&&typeof value==='object')walk(value,at?at+'.'+key:key,depth+1);else if(typeof value==='string'&&value.length<1048576&&/^[\s]*[\[{]/.test(value)){try{walk(JSON.parse(value),key,depth+1);}catch{}}}
  }
  walk(payload,'',0);return groups;
 }
 return {parse,url,fallback};
});},args:[]});}catch{}window.addEventListener('message',event=>{if(event.source===window&&event.data?.source==='dbm-hd-observer')ipcRenderer.send('hd:observe',event.data.groups);});})();

// PROMPT DURATION CLEANER
try { require('electron').contextBridge.executeInMainWorld({func:function anonymous(
) {
(function installPromptDurationButton(clean) {
  if(!/(^|\.)(dola\.com|doubao\.com)$/.test(location.hostname))return;
  if(window.__DBM_PROMPT_DURATION_CLEANER__)return;window.__DBM_PROMPT_DURATION_CLEANER__=true;
  const controls='[data-input-engine-actionbar-control-key="video-duration"],[data-input-engine-actionbar-control-key="duration"]',editors='textarea,[contenteditable="true"],[contenteditable="plaintext-only"]';
  let pending;
  const visible=e=>{const r=e?.getBoundingClientRect();return !!(e?.isConnected&&r?.width&&r?.height&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none');};
  function candidates(root){return [...root.querySelectorAll(editors)].filter(e=>visible(e)&&!e.disabled&&!e.readOnly&&!e.parentElement?.closest(editors));}
  function findEditor(control) {
    const active=document.activeElement?.closest?.(editors);if(active&&visible(active)&&!active.disabled&&!active.readOnly)return active;
    for(let root=control.parentElement,i=0;root&&i<5;root=root.parentElement,i++){const list=candidates(root);if(list.length===1)return list[0];if(list.length>1)break;}
    const list=candidates(document);return list.length===1?list[0]:null;
  }
  function textMap(editor) {
    if(editor.tagName==='TEXTAREA')return {text:editor.value};
    let text='',nodes=[];
    const line=()=>{if(text&&!text.endsWith('\n'))text+='\n';};
    function walk(node) {
      if(node.nodeType===Node.TEXT_NODE){nodes.push({node,start:text.length,end:text.length+node.nodeValue.length});text+=node.nodeValue;return;}
      if(node.nodeType!==Node.ELEMENT_NODE)return;
      if(node.getAttribute('contenteditable')==='false'){text+='\uFFFC';return;}
      if(node.tagName==='BR'){text+='\n';return;}
      const block=node!==editor&&/^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(node.tagName);
      if(block)line();for(const child of node.childNodes)walk(child);if(block)line();
    }
    walk(editor);
    return {text,nodes};
  }
  function replace(editor,edit) {
    const map=textMap(editor),point=(offset,end)=>{const item=map.nodes.find(n=>end?offset>n.start&&offset<=n.end:offset>=n.start&&offset<n.end)||(end?[...map.nodes].reverse().find(n=>n.end<=offset):map.nodes.find(n=>n.start>=offset));return item?{node:item.node,offset:Math.max(0,Math.min(item.node.nodeValue.length,offset-item.start))}:null;};
    const from=point(edit.start,false),to=point(edit.end,true);if(!from||!to)throw Error('输入框内容变化，请重试');
    const range=document.createRange();range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    // Use browser editing commands so editor frameworks receive their usual input events.
    if(!document.execCommand('insertText',false,edit.text)) {range.deleteContents();if(edit.text)range.insertNode(document.createTextNode(edit.text));editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));}
  }
  function install() {
    pending=null;
    const control=document.querySelector(controls);if(!control||!control.parentElement)return;
    if(control.parentElement.querySelector('[data-dbm-clean-duration]'))return;
    const button=document.createElement('button');button.type='button';button.setAttribute('data-dbm-clean-duration','true');button.textContent='清除提示词时长';
    button.title='删除当前提示词的视频时长、分镜时间轴和时长标注，保留画面描述';
    button.style.cssText='margin-left:6px;padding:5px 8px;border:1px solid #8886;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap';
    button.addEventListener('mousedown',e=>e.preventDefault());
    button.addEventListener('click',event=>{
      event.preventDefault();event.stopPropagation();const editor=findEditor(control);
      const result=editor?clean(textMap(editor).text):null;
      if(!editor)button.textContent='请先点击提示词输入框';
      else if(!result.changed)button.textContent='没有明确的视频时长';
      else try {
        editor.focus();
        if(editor.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,result.text);editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:result.text}));}
        else for(const edit of result.edits)replace(editor,edit);
        button.textContent=clean(textMap(editor).text).changed?'处理未完成，请检查输入框':'已清除提示词时长';
      }catch{button.textContent='处理未完成，请检查输入框';}
      setTimeout(()=>{if(button.isConnected)button.textContent='清除提示词时长';},2500);
    });
    control.parentElement.append(button);
  }
  const schedule=()=>{if(!pending)pending=setTimeout(install,100);};
  const observer=new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches(controls)||n.querySelector(controls)))))schedule();});
  const start=()=>{install();observer.observe(document.documentElement,{childList:true,subtree:true});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  window.addEventListener('pagehide',()=>{observer.disconnect();clearTimeout(pending);pending=null;});window.addEventListener('pageshow',e=>{if(e.persisted)start();});
})(function cleanPromptDuration(input) {
  let text=String(input || ''); const edits=[];
  const number='(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const value=number+'(?:\\s*(?:[-–—~～至到])\\s*'+number+')?\\s*(?:秒钟|秒|分钟|seconds?|secs?|s|minutes?|mins?)(?![a-z])';
  const label='(?:(?:视频|影片|短片|成片|动画|全片|整体|总)\\s*)?(?:时长|长度)\\s*(?:要求|设置|设定)?\\s*(?:控制在|不超过|设为|约为|为|是|约|[:：=])?\\s*'+value+'(?:\\s*(?:左右|以内))?';
  function apply(pattern,replacement='') {
    const stage=[];
    text=text.replace(pattern,(...args)=>{const old=args[0],start=args.at(-2),next=typeof replacement==='function'?replacement(...args):replacement;if(next!==old)stage.push({start,end:start+old.length,text:next});return next;});
    edits.push(...stage.sort((a,b)=>b.start-a.start));
  }
  const clock='(?:\\d{1,2}[:：])?\\d{1,2}[:：]\\d{2}(?:[.,]\\d+)?';
  const timeline=clock+'\\s*(?:[-–—~～至到→➜]+|->)\\s*'+clock+'(?:[ \\t]*[|｜/·，,][ \\t]*(?:时长[：:]?\\s*)?'+value+')?';
  apply(new RegExp('[【（(\\[]\\s*'+timeline+'\\s*[】）)\\]][。.;；]?','gi'));
  apply(new RegExp('([|｜][ \\t]*)?'+timeline+'[。.;；]?','gi'),(_all,separator)=>separator||'');
  apply(new RegExp('[【（(\\[]\\s*'+value+'\\s*[】）)\\]]','gi'));
  apply(new RegExp('[|｜][ \\t]*'+value+'[。.;；]?','gi'));
  apply(new RegExp('[（(]\\s*'+label+'\\s*[）)]','gi'));
  // Remove timing annotations, while preserving the shot description and aspect ratio.
  apply(new RegExp(label,'gi'));
  apply(new RegExp('((?:生成|制作|创作|拍摄|输出)(?:\\s|一段|一个|一条|一部|约|大约)*)'+value+'(?:的)?(?=\\s*(?:视频|影片|短片|动画|成片))','gi'),(_all,prefix)=>prefix);
  apply(new RegExp('\\b((?:generate|create|make|produce)\\s+(?:(?:a|an)\\s+)?)'+number+'\\s*[- ]\\s*(?:second|seconds|sec|minute|minutes)\\s+(?=video|clip|film|animation)','gi'),(_all,prefix)=>prefix);
  apply(new RegExp('\\b(?:video|clip|film|animation)\\s+(?:duration|length)\\s*(?::|=|is)?\\s*'+value,'gi'));
  // Single shot timestamps can directly touch Chinese prose; do not require a word boundary.
  apply(new RegExp('[【（(\\[][ \\t]*'+clock+'[ \\t]*[】）)\\]][。.;；]?','g'));
  apply(new RegExp('(^[ \\t]*|[|｜][ \\t]*)'+clock+'(?![\\d:：])[ \\t]*(?:[|｜。.;；][ \\t]*)?','gm'),(_all,prefix)=>prefix);
  apply(new RegExp('^[ \\t]*'+value+'[ \\t]*[。.;；]?[ \\t]*$','gim'));
  // The button removes explicit duration units throughout the current prompt.
  apply(new RegExp('(?<![a-z\\d_.])'+value,'gi'));
  if(edits.length)apply(/((?:生成|制作|创作|拍摄|输出)(?:一段|一个|一条|一部))的(?=视频|影片|短片|动画|成片)/g,(_all,prefix)=>prefix);
  return {text,edits,changed:edits.length>0};
});
},args:[]}); } catch {}
