/**
 * 视频分镜批量生成工作台 · 渲染层
 *
 * 阶段 1 范围：素材库、分镜编辑、@图片绑定、草稿自动保存与重启恢复。
 * 平台能力（模型/时长）一律取自主进程返回的 capabilities（即应用自身的能力表），
 * 未核实的项（比例、参考图数量上限）显示为「未核实」，不编造可选值。
 */
(() => {
  "use strict";

  const api = window.managerWorkbenchAPI;
  if (!api) return;
  const fileUtils = window.managerFileUtils;

  const $ = (id) => document.getElementById(id);
  const state = {
    storage: null,
    index: { projects: [], currentProjectId: "" },
    project: null,
    assets: [],
    capabilities: null,
    capabilityView: null,
    ratioOptions: [],
    limits: null,
    accounts: [],
    tasks: [],
    queue: null,
    // 执行账号可多选：一次为每个勾选账号各建一条尝试
    selectedAccountIds: [],
    run: { mode: "distribute", storyboardIds: [], accountIds: [], assignments: [], currentAttemptId: "" },
    // 单条创作区：当前分镜、繁忙状态与状态文案
    compose: { storyboardId: "", draft: "", busy: "", status: "", statusKind: "" },
    assetsCollapsed: false,
    // 用户是否手动改过账号勾选（手动清空后不再自动勾回第一个）
    accountsTouched: false,
    search: "",
    saveTimers: new Map(),
    // 正在编辑但尚未落盘的值：重渲染时优先使用，避免自动保存期间的输入被覆盖
    pendingValues: new Map(),
    lastSaved: "",
    focusedStoryboardId: "",
    mention: { storyboardId: "", prompt: "", caret: 0, search: "" },
    impact: { assetIds: [] },
    thumbCache: new Map(),
    // 下载实时进度（attemptId → {received,total,speed,remaining,phase}）与来源解析缓存
    downloadProgress: new Map(),
    sourceCache: new Map(),
  };

  // ── 小工具 ───────────────────────────────────────────────
  function toast(message, kind = "info") {
    const region = $("toastRegion");
    if (!region) return;
    const node = document.createElement("div");
    node.className = `toast${kind === "error" ? " error" : kind === "ok" ? " ok" : ""}`;
    node.textContent = message;
    region.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  const openModal = (id) => $(id)?.classList.remove("hidden");
  const closeModal = (id) => $(id)?.classList.add("hidden");

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function formatTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour12: false });
  }

  const projectId = () => state.project?.id || "";

  /** 就地输入框（Electron 不支持 window.prompt） */
  function promptInline(host, initial, onCommit) {
    if (!host) return;
    const input = document.createElement("input");
    input.className = "workbench-inline-input";
    input.value = initial || "";
    host.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.remove();
      if (commit && name) Promise.resolve(onCommit(name)).catch(() => {});
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
  }

  // ── 数据 ─────────────────────────────────────────────────
  async function refresh(options = {}) {
    if (!options.silent) {
      try {
        const snapshot = await api.snapshot();
        Object.assign(state, {
          storage: snapshot.storage,
          index: snapshot.index,
          project: snapshot.project,
          assets: snapshot.assets,
          capabilities: snapshot.capabilities,
          capabilityView: snapshot.capabilityView || null,
          ratioOptions: snapshot.ratioOptions || [],
          limits: snapshot.limits,
          accounts: snapshot.accounts || [],
          tasks: snapshot.tasks || [],
          queue: snapshot.queue || null,
        });
      } catch (error) {
        toast(`读取工作台数据失败：${error.message}`, "error");
        return;
      }
    }
    render();
  }

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !active.dataset || !active.dataset.focusKey) return null;
    return {
      key: active.dataset.focusKey,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }

  function restoreFocus(snapshot) {
    if (!snapshot) return;
    const next = document.querySelector(`[data-focus-key="${snapshot.key}"]`);
    if (!next) return;
    next.focus();
    if (typeof next.setSelectionRange === "function" && Number.isInteger(snapshot.start)) {
      try {
        next.setSelectionRange(snapshot.start, snapshot.end);
      } catch {}
    }
  }

  function render() {
    const focus = captureFocus();
    renderStorage();
    renderProjects();
    renderAssets();
    // 先把栏宽/折叠状态应用回来，再渲染内容（避免首帧按默认宽度闪一下）
    applyLayout();
    // 账号先渲染：首次进入会默认勾选第一个账号，主按钮的可用性依赖它
    renderAccounts();
    renderParams();
    renderCompose();
    renderStoryboards();
    renderTasks();
    renderRunProgress();
    renderHint();
    restoreFocus(focus);
  }

  /** 提交确认框里的实时进度：执行期间每一步都会刷新，避免看起来「点了没反应」 */
  function renderRunProgress() {
    const modal = $("workbenchRunModal");
    const status = $("workbenchRunStatus");
    if (!modal || !status || modal.classList.contains("hidden")) return;
    const attemptId = state.run.currentAttemptId;
    if (!attemptId) return;
    const record = (state.tasks || []).find((t) => t.id === attemptId);
    if (!record) return;
    const steps = record.driver?.steps || [];
    const last = steps[steps.length - 1];
    if (record.driver?.outcome === "running") {
      status.textContent = `第 ${steps.length} 步：${
        last ? STEP_LABEL[last.step] || last.step : "正在打开账号页面"
      }…（真实提交，请勿关闭窗口）`;
      return;
    }
    if (last) {
      status.textContent = `最近一步：${STEP_LABEL[last.step] || last.step}${last.detail ? ` · ${last.detail}` : ""}`;
    }
  }

  function renderHint() {
    const hint = $("workbenchHint");
    if (!hint) return;
    hint.textContent = state.lastSaved ? `已自动保存 ${state.lastSaved}` : "编辑内容会自动保存";
  }

  function renderStorage() {
    const node = $("workbenchStorage");
    if (!node) return;
    const storage = state.storage;
    if (!storage) {
      node.textContent = "数据目录读取中…";
      return;
    }
    // 本地路径不在主界面展示：只留一句状态，完整路径放进 title（详情/诊断里可见）
    node.textContent = storage.ok ? "数据目录：已就绪（隔离运行）" : storage.message;
    node.title = storage.ok ? `数据目录：${storage.root}` : "";
    node.classList.toggle("workbench-error", !storage.ok);
  }

  function renderProjects() {
    const select = $("workbenchProjectSelect");
    if (!select) return;
    select.innerHTML = "";
    if (!state.index.projects.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "（暂无项目，请先新建）";
      select.appendChild(option);
    }
    for (const project of state.index.projects) {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = `${project.name}（${project.storyboardCount} 个分镜）`;
      select.appendChild(option);
    }
    select.value = state.index.currentProjectId || "";
  }

  async function thumbFor(assetId) {
    if (state.thumbCache.has(assetId)) return state.thumbCache.get(assetId);
    let url = "";
    try {
      url = await api.asset.thumb(projectId(), assetId);
    } catch {}
    state.thumbCache.set(assetId, url);
    return url;
  }

  function assetById(assetId) {
    return state.assets.find((a) => a.id === assetId) || null;
  }

  async function paintThumb(imgNode, assetId) {
    const url = await thumbFor(assetId);
    if (url) {
      imgNode.src = url;
    } else {
      imgNode.replaceWith(Object.assign(document.createElement("span"), {
        className: "workbench-thumb-fallback",
        textContent: "无缩略图",
      }));
    }
  }

  // ── 素材库 ───────────────────────────────────────────────
  function renderAssets() {
    const list = $("workbenchAssetList");
    const count = $("workbenchAssetCount");
    if (!list) return;
    const keyword = state.search.trim().toLowerCase();
    const items = keyword
      ? state.assets.filter(
          (a) =>
            a.name.toLowerCase().includes(keyword) ||
            a.id.toLowerCase().includes(keyword) ||
            a.fileName.toLowerCase().includes(keyword)
        )
      : state.assets;
    if (count) count.textContent = String(items.length);

    list.innerHTML = "";
    if (!state.project) {
      list.appendChild(
        Object.assign(document.createElement("div"), {
          className: "workbench-empty",
          textContent: "请先新建或选择一个项目。",
        })
      );
      return;
    }
    if (!items.length) {
      list.appendChild(
        Object.assign(document.createElement("div"), {
          className: "workbench-empty",
          textContent: state.assets.length ? "没有匹配的素材。" : "还没有素材，先导入参考图片。",
        })
      );
      return;
    }

    for (const asset of items) {
      const card = document.createElement("div");
      card.className = "workbench-asset";
      card.dataset.assetId = asset.id;

      const thumbButton = document.createElement("button");
      thumbButton.type = "button";
      thumbButton.className = "workbench-asset-thumb";
      thumbButton.title = "预览";
      thumbButton.dataset.act = "preview";
      const img = document.createElement("img");
      img.alt = asset.name;
      thumbButton.appendChild(img);
      paintThumb(img, asset.id);
      card.appendChild(thumbButton);

      const meta = document.createElement("div");
      meta.className = "workbench-asset-meta";
      const nameInput = document.createElement("input");
      nameInput.className = "workbench-asset-name";
      nameInput.value = asset.name;
      nameInput.maxLength = 120;
      nameInput.dataset.focusKey = `asset-name:${asset.id}`;
      nameInput.dataset.act = "rename";
      meta.appendChild(nameInput);
      const sub = document.createElement("span");
      sub.className = "workbench-asset-sub";
      const dims = asset.width && asset.height ? `${asset.width}×${asset.height}` : "尺寸未知";
      sub.textContent = `${dims} · ${formatBytes(asset.bytes)} · ${asset.id}`;
      meta.appendChild(sub);
      card.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "workbench-asset-actions";
      for (const [act, label] of [
        ["insert", "插入"],
        ["delete", "删除"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "text-button";
        button.dataset.act = act;
        button.textContent = label;
        actions.appendChild(button);
      }
      card.appendChild(actions);
      list.appendChild(card);
    }
  }

  async function importAssets(paths) {
    if (!state.project) {
      toast("请先新建或选择项目", "error");
      return;
    }
    try {
      const result = Array.isArray(paths) && paths.length
        ? await api.asset.importPaths(projectId(), paths)
        : await api.asset.importDialog();
      if (result.canceled) return;
      const parts = [];
      if (result.imported.length) parts.push(`新增 ${result.imported.length} 张`);
      if (result.reused.length) parts.push(`复用已有 ${result.reused.length} 张（内容相同）`);
      if (result.failed.length) parts.push(`失败 ${result.failed.length} 张`);
      toast(parts.length ? parts.join("，") : "没有导入任何图片", result.failed.length ? "error" : "info");
      for (const item of result.failed) toast(`${item.file}：${item.message}`, "error");
      state.thumbCache.clear();
      await refresh();
    } catch (error) {
      toast(`导入失败：${error.message}`, "error");
    }
  }

  /** 剪贴板图片没有文件路径，只能按 MIME 推断扩展名 */
  const MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
  };

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : "");
      };
      reader.onerror = () => reject(reader.error || new Error("读取剪贴板图片失败"));
      reader.readAsDataURL(file);
    });
  }

  /** 直接把剪贴板里的图片存进素材库（不写临时文件，走 base64 通道） */
  async function importClipboardImages(files) {
    if (!state.project) {
      toast("请先新建或选择项目", "error");
      return;
    }
    const stamp = formatTime(new Date()).replace(/:/g, "");
    const items = [];
    for (const [index, file] of files.entries()) {
      const ext = MIME_EXT[file.type] || (/\.[a-z0-9]+$/i.exec(file.name || "")?.[0] || "").toLowerCase();
      if (!ext) {
        toast(`不支持的图片格式：${file.type || file.name || "未知"}`, "error");
        continue;
      }
      const base64 = await readAsBase64(file);
      if (!base64) continue;
      items.push({ name: `粘贴图片 ${stamp}-${index + 1}`, ext, base64 });
    }
    if (!items.length) return;
    try {
      const result = await api.asset.importBuffers(projectId(), items);
      const parts = [];
      if (result.imported.length) parts.push(`新增 ${result.imported.length} 张`);
      if (result.reused.length) parts.push(`复用已有 ${result.reused.length} 张（内容相同）`);
      if (result.failed.length) parts.push(`失败 ${result.failed.length} 张`);
      toast(`粘贴导入：${parts.join("，") || "没有导入任何图片"}`, result.failed.length ? "error" : "info");
      for (const item of result.failed) toast(`${item.file}：${item.message}`, "error");
      state.thumbCache.clear();
      await refresh();
    } catch (error) {
      toast(`粘贴导入失败：${error.message}`, "error");
    }
  }

  async function deleteAsset(assetId, resolution) {
    try {
      const result = await api.asset.remove(projectId(), [assetId], resolution);
      if (result.blocked) {
        showImpact(result.usages);
        return;
      }
      toast(`已删除 ${result.removed.length} 张素材${result.unbound ? `，解除 ${result.unbound} 处引用` : ""}`);
      state.thumbCache.delete(assetId);
      await refresh();
    } catch (error) {
      toast(`删除失败：${error.message}`, "error");
    }
  }

  function showImpact(usages) {
    const list = $("workbenchImpactList");
    const summary = $("workbenchImpactSummary");
    if (!list) return;
    list.innerHTML = "";
    let total = 0;
    const ids = [];
    for (const [assetId, items] of Object.entries(usages || {})) {
      if (!items.length) continue;
      ids.push(assetId);
      total += items.length;
      const asset = assetById(assetId);
      const row = document.createElement("div");
      row.className = "workbench-impact-row";
      const name = document.createElement("strong");
      name.textContent = asset ? asset.name : assetId;
      row.appendChild(name);
      const detail = document.createElement("span");
      detail.textContent = items
        .map((u) => `${u.name || "未命名分镜"} 里的 ${u.token}`)
        .join("、");
      row.appendChild(detail);
      list.appendChild(row);
    }
    if (summary) {
      summary.textContent = `共 ${total} 处引用。删除会同时解除这些引用，并从提示词中移除对应的 @图片 标记。`;
    }
    state.impact.assetIds = ids;
    openModal("workbenchImpactModal");
  }

  // ── 参数与单条创作区（主界面只显示一套当前生效设置） ────────
  function capabilityTarget() {
    return state.capabilities?.targets?.dola || state.capabilities?.targets?.doubao || null;
  }

  /** 当前正在创作的分镜：优先界面选中项，其次第一条 */
  function currentStoryboard() {
    const list = state.project?.storyboards || [];
    if (!list.length) return null;
    const wanted = state.compose.storyboardId || state.project?.ui?.selectedStoryboardId;
    return list.find((item) => item.id === wanted) || list[0];
  }

  function effectiveOf(storyboard) {
    const defaults = state.project?.defaults || {};
    const overrides = storyboard?.overrides || {};
    return {
      model: overrides.model || defaults.model,
      duration: overrides.duration || defaults.duration,
      ratio: overrides.ratio || defaults.ratio,
    };
  }

  /**
   * 把某条历史分镜载入上面的编辑框。
   * 切换前先把当前未落盘的输入保存掉，避免「切过去再切回来内容没了」。
   */
  async function loadStoryboardIntoCompose(storyboardId) {
    const current = currentStoryboard();
    if (current && current.id !== storyboardId) {
      const pendingKey = `sb-prompt:${current.id}`;
      const pending = state.pendingValues.get(pendingKey);
      if (pending !== undefined && pending !== current.prompt) {
        try {
          await api.storyboard.update(projectId(), current.id, { prompt: pending });
          state.pendingValues.delete(pendingKey);
        } catch (error) {
          toast(`切换前保存失败：${error.message}`, "error");
          return;
        }
      }
    }
    state.compose.storyboardId = "";
    state.compose.status = "";
    setMainStatus("");
    try {
      await api.ui.set(projectId(), { selectedStoryboardId: storyboardId });
    } catch {}
    await refresh();
  }

  /**
   * 主界面参数行：只渲染「当前生效」的一套值，改动即写到当前分镜的 overrides。
   * 这样就不会出现「改了全局默认，旧的单条覆盖还在偷偷生效」的歧义。
   */
  function renderParams() {
    const host = $("workbenchParamsRow");
    if (!host) return;
    host.innerHTML = "";
    if (!state.project) return;
    const storyboard = currentStoryboard();
    const target = capabilityTarget();
    const effective = effectiveOf(storyboard);
    const overrides = storyboard?.overrides || {};
    const view = state.capabilityView || {};

    const labelOfModel = new Map((view.modelLabels || []).map((m) => [m.value, m.label]));

    const model = document.createElement("select");
    model.id = "workbenchParamModel";
    model.dataset.focusKey = "param:model";
    for (const value of target?.models || []) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labelOfModel.get(value) ? `${value}（${labelOfModel.get(value)}）` : value;
      model.appendChild(option);
    }
    if (effective.model && !(target?.models || []).includes(effective.model)) {
      const option = document.createElement("option");
      option.value = effective.model;
      option.textContent = `${effective.model}（不在能力表中）`;
      model.appendChild(option);
    }
    model.value = effective.model || "";
    host.appendChild(field("模型", model));

    const duration = document.createElement("select");
    duration.id = "workbenchParamDuration";
    duration.dataset.focusKey = "param:duration";
    const nativeDurations = (target?.durations || []).map(String);
    const enhanced = view.enhancedDuration || null;
    for (const value of nativeDurations) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${value} 秒`;
      duration.appendChild(option);
    }
    if (enhanced) {
      const group = document.createElement("optgroup");
      group.label = `时长增强 ${enhanced.from}—${enhanced.to} 秒（仅 ${labelOfModel.get(enhanced.requiresModel) || enhanced.requiresModel}）`;
      for (const value of enhanced.values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = `${value} 秒（增强）`;
        group.appendChild(option);
      }
      duration.appendChild(group);
    }
    if (effective.duration && ![...nativeDurations, ...((enhanced && enhanced.values) || [])].includes(String(effective.duration))) {
      const option = document.createElement("option");
      option.value = String(effective.duration);
      option.textContent = `${effective.duration} 秒（不在已核实范围内）`;
      duration.appendChild(option);
    }
    duration.value = String(effective.duration || "");
    host.appendChild(field("时长", duration));

    const ratio = document.createElement("select");
    ratio.id = "workbenchParamRatio";
    ratio.dataset.focusKey = "param:ratio";
    ratioOptions(effective.ratio).forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      ratio.appendChild(option);
    });
    ratio.value = effective.ratio || "";
    host.appendChild(field("比例", ratio));

    // 生效来源标注：消除「全局改了但单条覆盖还在生效」的歧义
    const source = document.createElement("span");
    source.className = "workbench-param-source";
    const overridden = ["model", "duration", "ratio"].filter((key) => overrides[key]);
    source.textContent = overridden.length
      ? `当前生效值来自本条分镜的单条设置（${overridden.length} 项）；改这里的值会直接写入本条分镜`
      : "当前生效值继承自全局默认；改这里的值会写入本条分镜，不再影响全局";
    host.appendChild(source);

    // 增强时长的可用性说明（不静默降级）
    const enhancedNote = document.createElement("span");
    enhancedNote.className = "workbench-unknown";
    if (enhanced) {
      const usable = effective.model === enhanced.requiresModel;
      enhancedNote.textContent = usable
        ? `${enhanced.from}—${enhanced.to} 秒由应用自带增强器改写请求体，实际时长以请求体回读为准；结果视频长度平台不保证`
        : `${enhanced.from}—${enhanced.to} 秒增强仅 ${labelOfModel.get(enhanced.requiresModel) || enhanced.requiresModel} 可用，当前模型不支持（不会自动降级）`;
    } else {
      enhancedNote.textContent = "时长增强能力未在能力表中声明，只显示已核实档位";
    }
    host.appendChild(enhancedNote);

    const onChange = async () => {
      if (!storyboard) return;
      try {
        await api.storyboard.update(projectId(), storyboard.id, {
          overrides: { model: model.value, duration: duration.value, ratio: ratio.value },
        });
        state.lastSaved = formatTime(new Date());
        await refresh();
        setMainStatus("参数已保存到本条分镜", "ok");
      } catch (error) {
        toast(`保存参数失败：${error.message}`, "error");
      }
    };
    model.addEventListener("change", onChange);
    duration.addEventListener("change", onChange);
    ratio.addEventListener("change", onChange);
  }

  /** 比例候选：主进程给的已核实值 + 当前值（保证历史项目里已有的值也能选中） */
  function ratioOptions(current) {
    const list = (state.ratioOptions || []).slice();
    if (current && !list.includes(current)) list.unshift(current);
    if (!list.length) list.push("16:9");
    return list;
  }

  function field(name, control) {
    const wrap = document.createElement("label");
    wrap.className = "workbench-field";
    const span = document.createElement("span");
    span.textContent = name;
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
  }

  function setMainStatus(text, kind = "") {
    state.compose.status = text || "";
    state.compose.statusKind = kind;
    const host = $("workbenchMainStatus");
    if (host) {
      host.textContent = state.compose.status;
      host.className = `workbench-main-status${kind ? ` workbench-main-status-${kind}` : ""}`;
    }
  }

  /** 单条创作区：一个编辑框 + 引用摘要 + 主操作栏 */
  function renderCompose() {
    const prompt = $("workbenchMainPrompt");
    const refsHost = $("workbenchRefsRow");
    const summary = $("workbenchRunSummary");
    const button = $("workbenchGenerate");
    if (!prompt || !summary || !button) return;
    if (!state.project) return;
    const storyboard = currentStoryboard();

    // 正在编辑但尚未落盘的值优先，避免自动保存期间被覆盖
    const pending = storyboard ? state.pendingValues.get(`sb-prompt:${storyboard.id}`) : undefined;
    const value = pending === undefined ? String(storyboard?.prompt || "") : pending;
    if (document.activeElement !== prompt && prompt.value !== value) prompt.value = value;
    prompt.dataset.sbId = storyboard?.id || "";

    if (refsHost) {
      refsHost.innerHTML = "";
      const refs = storyboard?.refs || [];
      if (!refs.length) {
        const none = document.createElement("span");
        none.className = "workbench-refs-empty";
        none.textContent = "还没有参考图：在素材上点「插入」，或在提示词里输入 @";
        refsHost.appendChild(none);
      }
      refs.forEach((ref) => {
        const asset = (state.assets || []).find((item) => item.id === ref.assetId);
        const chip = document.createElement("span");
        chip.className = "workbench-ref-chip";
        const number = String(ref.token || "").replace(/[^\d]/g, "");
        chip.title = `编辑器里写 ${ref.token || `@图${number}`}，提交时写成「参考图${number}」；素材：${
          asset?.name || ref.name || ref.assetId
        }`;
        // 缩略图角标：一眼看出绑的是哪张图，又不占行高
        if (asset) {
          const thumb = document.createElement("img");
          thumb.alt = asset.name || "";
          paintThumb(thumb, asset.id);
          chip.appendChild(thumb);
        }
        const num = document.createElement("em");
        num.textContent = `参考图${number}`;
        chip.appendChild(num);
        const name = document.createElement("span");
        name.textContent = shortName(asset?.name || ref.name || ref.assetId);
        chip.appendChild(name);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "workbench-ref-remove";
        remove.dataset.act = "compose-unbind";
        remove.dataset.assetId = ref.assetId;
        remove.textContent = "×";
        remove.title = "解除引用";
        chip.appendChild(remove);
        refsHost.appendChild(chip);
      });
      // 已绑定数量与草稿保存状态：放在引用行末尾，不另占空间
      const meta = document.createElement("span");
      meta.className = "workbench-refs-meta";
      meta.textContent = `已绑定 ${refs.length} 张${state.lastSaved ? ` · 草稿已保存 ${state.lastSaved}` : " · 草稿自动保存已开启"}`;
      refsHost.appendChild(meta);
    if (refs.length) {
        const hint = document.createElement("span");
        hint.className = "workbench-refs-hint";
        hint.textContent = "平台不支持内联图片节点：编辑器里的 @图N 提交时会写成「参考图N」，并按同一编号顺序作为参考图上传";
        refsHost.appendChild(hint);
      }
    }

    const effective = effectiveOf(storyboard);
    const accountCount = (state.selectedAccountIds || []).length;
    const busy = state.compose.busy;
    const reasons = [];
    if (!storyboard) reasons.push("还没有分镜");
    if (!String(prompt.value || "").trim()) reasons.push("提示词为空");
    if (!accountCount) reasons.push("未选择执行账号");
    if (!effective.model || !effective.duration || !effective.ratio) reasons.push("参数未就绪");
    summary.textContent = `模型 ${effective.model || "-"} · 时长 ${effective.duration || "-"} 秒 · 比例 ${
      effective.ratio || "-"
    } · 已选 ${accountCount} 个账号，将创建 ${accountCount} 条生成任务，分别消耗对应账号额度`;
    button.disabled = Boolean(busy) || reasons.length > 0;
    button.textContent =
      busy === "checking"
        ? "正在检查…"
        : busy === "prechecking"
          ? "正在校验（不发送）…"
          : busy === "submitting"
            ? "正在提交…"
            : accountCount > 1
              ? `多账号生成（${accountCount}）`
              : "生成视频";
    button.title = reasons.length ? `不可提交：${reasons.join("；")}` : "向平台提交这一条（真实提交）";
    const precheck = $("workbenchPrecheck");
    if (precheck) {
      precheck.disabled = Boolean(busy) || !storyboard || !accountCount;
      precheck.textContent =
        busy === "prechecking" ? "校验中…" : `提交前校验（不发送）${accountCount > 1 ? `（${accountCount}）` : ""}`;
    }
    const auto = $("workbenchAutoDownload");
    if (auto) {
      const on = state.project?.settings?.autoDownload === true;
      if (auto.checked !== on && document.activeElement !== auto) auto.checked = on;
    }
    if (reasons.length && !busy) {
      setMainStatus(`暂不可提交：${reasons.join("；")}`, "warn");
    } else if (!busy && state.compose.statusKind === "warn") {
      setMainStatus("", "");
    }
  }

  /** 素材名截断显示（悬停可看全名） */
  function shortName(name, max = 14) {
    const text = String(name || "");
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  // ── 执行账号与任务 ───────────────────────────────────────
  const statusLabel = (status) => state.statusLabels?.[status] || status;
  const downloadLabel = (status) => state.downloadLabels?.[status] || status;
  // 驱动层步骤的中文名，与 workbench-dola-driver 里的 step 字段一一对应
  const STEP_LABEL = {
    openPage: "定位账号页面",
    waitReady: "等待页面就绪",
    enterVideoMode: "进入视频生成模式",
    clearAttachments: "清空残留参考图",
    setPrompt: "写入提示词",
    chooseModel: "选择模型",
    chooseDuration: "选择时长",
    chooseRatio: "设置比例",
    attachImages: "附加参考图",
    verifyRefs: "核实图片引用",
    readState: "回读参数与发送按钮",
    send: "点击发送",
    sendReaction: "确认平台已开始处理",
    platformReply: "核对平台回复",
    awaitResponse: "等待平台响应",
  };
  const ACTIVE_STATUSES = ["pending", "submitting", "queued", "generating"];
  const isActiveStatus = (status) => ACTIVE_STATUSES.includes(status);

  function emptyDiv(message) {
    return Object.assign(document.createElement("div"), { className: "workbench-empty", textContent: message });
  }

  function renderAccounts() {
    const host = $("workbenchAccountPicks");
    const note = $("workbenchAccountNote");
    if (!host) return;
    const accounts = state.accounts || [];
    host.innerHTML = "";

    if (!accounts.length) {
      host.appendChild(emptyDiv("（没有可执行账号）"));
      if (note) note.textContent = "未读到任何账号。账号来自本机既有账号列表，工作台不会新建或修改账号。";
      return;
    }

    // 账号集合变化时剔除失效选择；首次进入默认勾选第一个，避免「一个都没选」的困惑。
// 但用户手动清空过之后不再自动勾选，否则「清空」会失效。
    const valid = new Set(accounts.map((a) => a.id));
    state.selectedAccountIds = state.selectedAccountIds.filter((id) => valid.has(id));
    if (!state.selectedAccountIds.length && !state.accountsTouched) {
      state.selectedAccountIds = [accounts[0].id];
    }
    const picked = new Set(state.selectedAccountIds);

    for (const account of accounts) {
      const row = document.createElement("label");
      row.className = "workbench-account-pick";
      row.dataset.accountId = account.id;

      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = account.id;
      box.checked = picked.has(account.id);
      box.dataset.focusKey = `account:${account.id}`;
      box.dataset.act = "account-toggle";
      row.appendChild(box);

      const name = document.createElement("span");
      name.className = "workbench-account-name";
      name.textContent = account.name;
      row.appendChild(name);

      const meta = document.createElement("em");
      meta.textContent = account.blocked ? "已暂停" : `执行中 ${account.activeTasks}`;
      row.appendChild(meta);

      if (account.blocked) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "text-button";
        clear.dataset.act = "clear-block";
        clear.dataset.accountId = account.id;
        clear.textContent = "解除暂停";
        row.appendChild(clear);
      }
      host.appendChild(row);
    }

    if (!note) return;
    note.innerHTML = "";
    const blocked = accounts.filter((a) => picked.has(a.id) && a.blocked);
    const line = document.createElement("span");
    line.textContent = blocked.length
      ? `已选 ${picked.size} 个账号，其中 ${blocked.length} 个已暂停：${blocked
          .map((a) => `${a.name}（${a.blocked.label}）`)
          .join("、")}`
      // 平台额度与登录状态本工作台无法核实，按需求显示「未知」
      : `已选 ${picked.size} 个账号 · 登录状态：未知 · 额度：未知 · 当前创作区＝「多账号同稿生成」：同一份内容在每个所选账号各生成一次（共 ${picked.size} 条任务，分别消耗对应账号额度）；「分镜列表 / 批量」里是「多分镜分配执行」：不同分镜分配给账号，每条分镜只执行一次`;
    note.appendChild(line);
    for (const [act, label] of [
      ["accounts-all", "全选"],
      ["accounts-none", "清空"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.dataset.act = act;
      button.textContent = label;
      note.appendChild(button);
    }
  }

  function renderTasks() {
    const host = $("workbenchTaskList");
    const count = $("workbenchTaskCount");
    if (!host) return;
    const tasks = state.tasks || [];
    if (count) count.textContent = String(tasks.filter((t) => isActiveStatus(t.status)).length);
    host.innerHTML = "";
    if (!tasks.length) {
      host.appendChild(emptyDiv("还没有生成任务。在分镜卡片上点「生成这一条」开始。"));
      return;
    }
    for (const record of tasks) host.appendChild(taskCard(record));
  }

  function taskCard(record) {
    const card = document.createElement("div");
    card.className = "workbench-task";
    card.dataset.attemptId = record.id;
    if (isActiveStatus(record.status)) card.classList.add("workbench-task-active");

    const head = document.createElement("div");
    head.className = "workbench-task-head";
    const title = document.createElement("strong");
    title.textContent = `${record.storyboardName || "未命名分镜"} · 尝试 ${record.attempt}`;
    head.appendChild(title);
    const chip = document.createElement("span");
    chip.className = `workbench-status workbench-status-${record.status}`;
    chip.textContent = statusLabel(record.status);
    head.appendChild(chip);
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "workbench-task-meta";
    const pieces = [
      `账号 ${accountName(record.accountId)}`,
      record.submittedAt ? `提交 ${formatTime(record.submittedAt)}` : "尚未提交",
      `最近更新 ${formatTime(record.updatedAt)}`,
      record.platformTaskId ? `平台任务 ${record.platformTaskId}` : "平台任务 ID：无",
    ];
    if (record.params?.duration) {
      const evidence = record.driver?.durationEvidence;
      pieces.push(
        `时长 ${record.params.duration} 秒${
          evidence?.mode === "enhanced"
            ? evidence.submitted
              ? `（增强，请求体回读 ${evidence.submitted} 秒）`
              : "（增强，未回读到请求体时长）"
            : ""
        }`
      );
    }
    if (record.refs?.length) pieces.push(`参考图 ${record.refs.length} 张`);
    for (const piece of pieces) {
      const span = document.createElement("span");
      span.textContent = piece;
      meta.appendChild(span);
    }
    // UUID / 内部标识默认折叠（调试信息统一收纳，主视图只留业务信息）
    const detailBits = document.createElement("details");
    detailBits.className = "workbench-task-ids workbench-debug";
    detailBits.innerHTML = `<summary>调试信息 · 内部标识</summary><div>账号 ${record.accountId}</div><div>尝试 ${record.id}${
      record.params?.model ? ` · 模型标识 ${record.params.model}` : ""
    }</div>`;
    meta.appendChild(detailBits);
    card.appendChild(meta);

    // 自动重试：次数 / 原因 / 下次时间 / 停止按钮（全部可见，不静默重试）
    if (record.autoRetry && !record.autoRetry.stopped) {
      const box = document.createElement("div");
      box.className = "workbench-task-retry";
      box.textContent = `自动重试 第 ${record.autoRetry.count}/${record.autoRetry.max} 次 · 原因：${
        record.autoRetry.reason || "平台未受理"
      } · 下次：${formatTime(record.autoRetry.nextAt)}`;
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "text-button";
      stop.dataset.act = "stop-retry";
      stop.textContent = "停止重试";
      box.appendChild(stop);
      card.appendChild(box);
    } else if (record.autoRetry?.stopped) {
      const box = document.createElement("div");
      box.className = "workbench-task-retry workbench-task-retry-stopped";
      box.textContent = `自动重试已停止：${record.autoRetry.reason || "需人工处理"}`;
      card.appendChild(box);
    }

    // 平台明确拒绝（人脸未认证、内容规则等）：显示原因并要求人工处理，不自动换素材/换模型
    if (record.driver?.needsUser || record.autoRetry?.stopped) {
      const note = document.createElement("div");
      note.className = "workbench-task-reject";
      note.textContent = `平台未受理，需你处理：${
        record.error?.message || record.driver?.message || "见提交步骤"
      }。工作台不会自动换素材、换模型或重试。`;
      card.appendChild(note);
    }

    if (record.poll?.lastAt || record.poll?.message) {
      const poll = document.createElement("div");
      poll.className = "workbench-task-poll";
      poll.textContent = `状态更新 ${formatTime(record.poll.lastAt)} · ${record.poll.message || "平台未给出明确阶段"}${
        record.poll.stale ? "（监控异常）" : ""
      }`;
      card.appendChild(poll);
    }

    if (record.error) {
      const error = document.createElement("div");
      error.className = "workbench-task-error";
      error.textContent = `[${record.error.code}] ${record.error.message}`;
      card.appendChild(error);
    }

    // 驱动层逐步结果：让「点了生成没反应」变成「卡在第几步、页面上有哪些候选控件」
    const driver = record.driver || null;
    const steps = driver?.steps || [];
    if (driver?.outcome === "running") {
      const live = document.createElement("div");
      live.className = "workbench-task-running";
      const last = steps[steps.length - 1];
      const lastLabel = last ? STEP_LABEL[last.step] || last.step : "";
      live.textContent = `${driver.message || "提交进行中…"}${
        last ? ` · 最近完成：${lastLabel}${last.detail ? `（${last.detail}）` : ""}` : ""
      }`;
      card.appendChild(live);
    }
    if (driver && (steps.length || driver.outcome === "running")) {
      const box = document.createElement("details");
      box.className = "workbench-task-steps workbench-debug";
      // 进行中默认展开，用户能实时看到走到哪一步
      if (driver.outcome === "running") box.open = true;
      const summary = document.createElement("summary");
      const badCount = steps.filter((s) => s.ok === false).length;
      summary.textContent =
        driver.outcome === "running"
          ? `调试信息 · 提交步骤（已完成 ${steps.length} 步）`
          : `调试信息 · 提交步骤（${steps.length} 步${badCount ? `，${badCount} 步未成功` : "，全部成功"}）`;
      box.appendChild(summary);
      for (const step of steps) {
        const row = document.createElement("div");
        row.className = step.ok === false ? "workbench-step-bad" : "";
        row.textContent = `${step.ok === false ? "✕" : "✓"} ${STEP_LABEL[step.step] || step.step}${
          step.detail ? ` · ${step.detail}` : ""
        }`;
        box.appendChild(row);
      }
      if (driver.candidates?.length) {
        const row = document.createElement("div");
        row.className = "workbench-step-cands";
        row.textContent = `页面候选控件：${driver.candidates.join(" | ")}`;
        box.appendChild(row);
      }
      card.appendChild(box);
    }

    // 状态变化日志：只展示本工作台记录的阶段与脱敏摘要，不含 Cookie / Token
    const log = document.createElement("details");
    log.className = "workbench-task-log workbench-debug";
    const summary = document.createElement("summary");
    summary.textContent = `调试信息 · 状态变化（${record.history.length} 条，仅阶段与摘要）`;
    log.appendChild(summary);
    for (const item of record.history) {
      const row = document.createElement("div");
      row.textContent = `${formatTime(item.at)} ${statusLabel(item.status)}${item.note ? ` · ${item.note}` : ""}`;
      log.appendChild(row);
    }
    card.appendChild(log);

    const foot = document.createElement("div");
    foot.className = "workbench-task-foot";
    foot.appendChild(downloadBlock(record));

    const buttons = [];
    if (isActiveStatus(record.status)) buttons.push(["cancel", "取消"]);
    if (["failed", "manual", "unconfirmed"].includes(record.status)) buttons.push(["retry", "重新生成"]);
    if (record.status === "succeeded") {
      const dlStatus = record.download?.status || "idle";
      if (dlStatus === "downloading") {
        buttons.push(["download-pause", "暂停下载"]);
        buttons.push(["download-cancel", "取消下载"]);
      } else {
        buttons.push(["download", dlStatus === "done" ? "重新下载（换来源）" : dlStatus === "paused" ? "继续下载" : dlStatus === "failed" ? "重试下载" : "下载"]);
      }
      buttons.push(["sources", "查看下载来源"]);
      if (record.download?.resumed) buttons.push(["", "已续传"]);
    }
    if (record.download?.filePath) {
      buttons.push(["reveal", "打开所在目录"]);
      buttons.push(["open-file", "本地播放"]);
    }
    for (const [act, label] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      if (!act) {
        button.disabled = true;
        button.textContent = label;
        foot.appendChild(button);
        continue;
      }
      button.dataset.act = act;
      button.textContent = label;
      foot.appendChild(button);
    }
    card.appendChild(foot);
    return card;
  }

  const fmtBytes = (value) => {
    const bytes = Number(value) || 0;
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    let size = bytes;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
  };
  const fmtDuration = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (!total) return "";
    if (total < 60) return `${total} 秒`;
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes} 分 ${String(rest).padStart(2, "0")} 秒`;
  };

  /**
   * 下载区块：生成状态与下载状态分开显示。
   * 澜川同源是独立来源，进度条与阶段都单独标出；失败给原因与建议，不笼统报错。
   */
  function downloadBlock(record) {
    const wrap = document.createElement("div");
    wrap.className = "workbench-download";
    const dl = record.download || { status: "idle" };
    wrap.classList.add(`workbench-download-${dl.status}`);

    const head = document.createElement("div");
    head.className = "workbench-download-head";
    const chip = document.createElement("span");
    chip.className = `workbench-download-chip workbench-download-chip-${dl.status}`;
    chip.textContent = `下载：${downloadLabel(dl.status)}`;
    head.appendChild(chip);
    if (dl.sourceLabel || dl.source) {
      const source = document.createElement("span");
      source.className = `workbench-source workbench-source-${dl.source === "lanchuan-original" ? "lanchuan" : "playback"}`;
      source.textContent = `来源：${dl.sourceLabel || dl.source}`;
      source.title = dl.urlSafe ? `脱敏地址：${dl.urlSafe}` : "";
      head.appendChild(source);
    }
    // 已解析过的来源清单：澜川同源是否可用、不可用原因、可回退来源
    const cached = state.sourceCache.get(record.id);
    if (cached?.sources?.length) {
      const list = document.createElement("div");
      list.className = "workbench-source-list";
      for (const item of cached.sources) {
        const row = document.createElement("span");
        row.className = `workbench-source-item ${item.available ? "is-ok" : "is-off"}`;
        row.textContent = `${item.tag}：${item.available ? "可用" : item.error}${item.matchedBy && item.matchedBy !== "none" ? `（${item.matchedBy === "exact" ? "地址完全一致" : "同路径命中"}）` : ""}`;
        list.appendChild(row);
      }
      head.appendChild(list);
    }
    if (dl.status === "downloading") {
      const live = state.downloadProgress.get(record.id) || {};
      const received = Number(live.received ?? dl.bytes) || 0;
      const total = Number(live.total ?? dl.expectedBytes) || 0;
      const percent = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
      const meter = document.createElement("div");
      meter.className = "workbench-progress";
      const fill = document.createElement("span");
      fill.style.width = `${total ? percent : 6}%`;
      if (!total) fill.classList.add("is-unknown");
      meter.appendChild(fill);
      wrap.appendChild(head);
      wrap.appendChild(meter);
      const facts = document.createElement("div");
      facts.className = "workbench-download-facts";
      facts.textContent = [
        total ? `${fmtBytes(received)} / ${fmtBytes(total)}（${percent}%）` : `${fmtBytes(received)}（总大小未知）`,
        live.speed ? `${fmtBytes(live.speed)}/s` : "",
        live.remaining ? `剩余约 ${fmtDuration(live.remaining)}` : "",
        live.resumed || dl.resumed ? "断点续传中" : "",
        live.phase === "resolve" ? "正在解析澜川同源原片地址" : live.phase === "verify" ? "正在校验文件完整性" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      wrap.appendChild(facts);
      if (dl.message) {
        const note = document.createElement("div");
        note.className = "workbench-download-note";
        note.textContent = dl.message;
        wrap.appendChild(note);
      }
      return wrap;
    }

    wrap.appendChild(head);
    const facts = document.createElement("div");
    facts.className = "workbench-download-facts";
    const parts = [];
    if (dl.bytes) parts.push(fmtBytes(dl.bytes));
    if (dl.expectedBytes && dl.expectedBytes !== dl.bytes) parts.push(`共 ${fmtBytes(dl.expectedBytes)}`);
    if (dl.elapsedMs) parts.push(`耗时 ${fmtDuration(dl.elapsedMs / 1000)}`);
    if (dl.resumed) parts.push("已用断点续传");
    if (dl.attempts > 1) parts.push(`第 ${dl.attempts} 次`);
    if (parts.length) facts.textContent = parts.join(" · ");
    if (facts.textContent) wrap.appendChild(facts);

    if (dl.status === "failed" && (dl.message || dl.hint)) {
      const error = document.createElement("div");
      error.className = "workbench-download-error";
      error.textContent = `下载失败：${dl.message || ""}${dl.hint && dl.hint !== dl.message ? `；建议：${dl.hint}` : ""}${
        dl.errorCode ? `（${dl.errorCode}）` : ""
      }`;
      wrap.appendChild(error);
    } else if (dl.message) {
      const note = document.createElement("div");
      note.className = "workbench-download-note";
      note.textContent = dl.message;
      wrap.appendChild(note);
    }
    if (dl.filePath) {
      const pathText = document.createElement("div");
      pathText.className = "workbench-task-path";
      pathText.textContent = dl.filePath;
      pathText.title = dl.filePath;
      wrap.appendChild(pathText);
    }
    return wrap;
  }

  function accountName(accountId) {
    return state.accounts.find((a) => a.id === accountId)?.name || accountId;
  }

  /**
 * 提交确认框
 * 默认模式是「分配执行」：多条分镜分配给多个所选账号，每条分镜只执行一次。
 * 「对比模式」是独立选项，必须用户显式选择 —— 同一分镜才会在每个账号各生成一次。
 */
  function runPreview(host, previews, context = {}) {
    host.innerHTML = "";
    const list = Array.isArray(previews) ? previews : [previews];
    const first = list[0] || { params: {}, uploads: [], errors: [], limitations: [], promptPreview: "" };
    const mode = context.mode || "distribute";

    const modes = document.createElement("div");
    modes.className = "workbench-run-modes";
    modes.id = "workbenchRunModes";
    for (const [value, label, hint] of [
      ["distribute", "分配执行（默认）", "多条分镜按顺序分配给所选账号，每条分镜只执行一次"],
      ["compare", "对比模式", "同一条分镜在每个所选账号各生成一次（会按账号数成倍消耗额度）"],
    ]) {
      const wrap = document.createElement("label");
      wrap.className = "workbench-run-mode";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "workbenchRunMode";
      radio.value = value;
      radio.checked = mode === value;
      radio.dataset.act = "run-mode";
      wrap.appendChild(radio);
      const text = document.createElement("span");
      text.textContent = `${label} · ${hint}`;
      wrap.appendChild(text);
      modes.appendChild(wrap);
    }
    host.appendChild(modes);

    const rows = [
      ["模型", first.params.model || "(未设置)"],
      ["时长", first.params.duration ? `${first.params.duration} 秒` : "(未设置)"],
      ["比例", first.params.ratio || "(未设置，用平台默认)"],
      ["参考图片", first.uploads.length ? `${first.uploads.length} 张` : "无"],
    ];
    for (const [name, value] of rows) {
      const row = document.createElement("div");
      row.className = "workbench-run-row";
      const label = document.createElement("span");
      label.textContent = name;
      row.appendChild(label);
      const text = document.createElement("strong");
      text.textContent = value;
      row.appendChild(text);
      host.appendChild(row);
    }

    const assignments = context.assignments || [];
    const plan = document.createElement("div");
    plan.className = "workbench-run-plan";
    const head = document.createElement("div");
    head.className = "workbench-run-row";
    const headLabel = document.createElement("span");
    headLabel.textContent = "本次提交";
    head.appendChild(headLabel);
    const headValue = document.createElement("strong");
    headValue.textContent = `共 ${assignments.length} 条尝试（${assignments.filter((a) => a.valid).length} 条可提交）`;
    head.appendChild(headValue);
    plan.appendChild(head);
    for (const item of assignments) {
      const row = document.createElement("div");
      row.className = `workbench-run-row${item.valid ? "" : " workbench-run-row-bad"}`;
      const label = document.createElement("span");
      label.textContent = item.storyboardName || item.storyboardId;
      row.appendChild(label);
      const text = document.createElement("strong");
      text.textContent = item.valid
        ? `→ ${accountName(item.accountId)}`
        : `✕ 不可提交：${(item.errors || []).join("；") || "参数未通过校验"}`;
      row.appendChild(text);
      plan.appendChild(row);
    }
    host.appendChild(plan);

    const prompt = document.createElement("div");
    prompt.className = "workbench-run-prompt";
    prompt.textContent = first.promptPreview || "(空提示词)";
    host.appendChild(prompt);

    if (first.limitations.length) {
      const box = document.createElement("div");
      box.className = "workbench-run-notes";
      box.textContent = `平台限制说明：${first.limitations.join("；")}`;
      host.appendChild(box);
    }
    const status = document.createElement("div");
    status.className = "workbench-run-status";
    status.id = "workbenchRunStatus";
    host.appendChild(status);
  }

  /**
   * 打开提交确认框：先按模式算出「分镜 → 账号」的分配，再逐条做提交前预览。
   * 分配结果同时留在 state.run.assignments，确认时只提交校验通过的条目。
   */
  async function openRunModal(storyboardIds, mode = "distribute") {
    const accountIds = state.selectedAccountIds.slice();
    if (!accountIds.length) {
      toast("请先勾选执行账号（可多选）", "error");
      return;
    }
    const boards = (storyboardIds || []).filter(Boolean);
    if (!boards.length) {
      toast("当前没有可提交的分镜", "error");
      return;
    }
    const assignments = await api.task.assignments(boards, accountIds, mode);
    const names = new Map((state.project?.storyboards || []).map((s) => [s.id, s.name || s.id]));
    const cache = new Map();
    const rows = [];
    for (const item of assignments) {
      const key = `${item.storyboardId}|${item.accountId}`;
      let preview = cache.get(key);
      if (!preview) {
        try {
          preview = await api.task.preview(projectId(), item.storyboardId, item.accountId);
        } catch (error) {
          preview = { valid: false, errors: [error.message], warnings: [], limitations: [], uploads: [], params: {}, promptPreview: "" };
        }
        cache.set(key, preview);
      }
      rows.push({
        ...item,
        storyboardName: names.get(item.storyboardId) || item.storyboardId,
        valid: Boolean(preview.valid),
        errors: preview.errors || [],
        preview,
      });
    }
    state.run = { mode, storyboardIds: boards, accountIds, assignments: rows, currentAttemptId: "" };
    runPreview($("workbenchRunPreview"), rows.map((row) => row.preview), { mode, assignments: rows });
    const confirm = $("workbenchRunConfirm");
    if (confirm) confirm.disabled = !rows.some((row) => row.valid);
    openModal("workbenchRunModal");
  }

  // ── 单条创作区交互 ───────────────────────────────────────
  /** 某个账号的页面是否已打开且落在 dola 上 */
  function accountPageState(accountId) {
    const node = document.querySelector(`webview[partition="persist:doubao-manager-${accountId}"]`);
    if (!node) return { open: false, url: "" };
    let url = "";
    try {
      url = node.getURL ? String(node.getURL()) : "";
    } catch {
      url = "";
    }
    return { open: true, url };
  }

  /**
   * 自动准备所选账号的页面：缺页面就点开它，并等到真正落在 dola 上。
   * 逐个准备（点击切换标签页），页面打开后并行提交互不影响。
   */
  async function ensureAccountPages(accountIds) {
    const pending = [];
    for (const accountId of accountIds) {
      const state0 = accountPageState(accountId);
      if (state0.open && /dola\.com/i.test(state0.url)) continue;
      const clicked = document.querySelector(`.account-card[data-id="${accountId}"] .account-info`);
      if (!clicked) {
        pending.push({ accountId, reason: "账号卡片不存在，无法自动打开页面" });
        continue;
      }
      clicked.click();
      let ok = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const now = accountPageState(accountId);
        if (now.open && /dola\.com/i.test(now.url)) {
          ok = true;
          break;
        }
      }
      if (!ok) pending.push({ accountId, reason: "页面在 30 秒内没有就绪（可能需要重新登录）" });
    }
    return pending;
  }

  /**
   * 主按钮：把「当前这一条」提交给每个所选账号。
   * 同一份提示词/参考图/参数 → 每个账号各创建 1 条任务（内容快照相同，上传与提交各自独立），
   * 由队列按并发上限（默认 3）同时执行，不同账号互不阻塞。
   */
  async function generateCurrent() {
    if (state.compose.busy) return; // 提交期间防重复点击
    const storyboard = currentStoryboard();
    if (!storyboard) return setMainStatus("还没有分镜，先新增一条", "warn");
    const accountIds = [...new Set((state.selectedAccountIds || []).slice())];
    if (!accountIds.length) return setMainStatus("请先在右侧勾选执行账号", "warn");

    state.compose.busy = "checking";
    renderCompose();
    setMainStatus(`正在检查 ${accountIds.length} 个账号的提交条件…`);
    const previews = await Promise.all(
      accountIds.map((accountId) =>
        api.task
          .preview(projectId(), storyboard.id, accountId)
          .then((preview) => ({ accountId, preview }))
          .catch((error) => ({ accountId, preview: { valid: false, errors: [error.message] } }))
      )
    );
    const ready = previews.filter((item) => item.preview?.valid).map((item) => item.accountId);
    const blocked = previews.filter((item) => !item.preview?.valid);
    if (!ready.length) {
      state.compose.busy = "";
      renderCompose();
      return setMainStatus(`暂不可提交：${blocked.map((b) => `${accountName(b.accountId)}（${b.preview.errors.join("；")}）`).join("；")}`, "error");
    }

    // 自动准备页面，避免要求用户逐个手动点开
    setMainStatus(`正在准备 ${ready.length} 个账号的页面…`);
    const notReady = await ensureAccountPages(ready);
    const usable = ready.filter((id) => !notReady.some((item) => item.accountId === id));
    if (!usable.length) {
      state.compose.busy = "";
      renderCompose();
      return setMainStatus(`账号页面未就绪：${notReady.map((n) => `${accountName(n.accountId)}（${n.reason}）`).join("；")}`, "error");
    }

    state.compose.busy = "submitting";
    renderCompose();
    setMainStatus(`正在创建 ${usable.length} 条任务…（每个账号 1 条，分别消耗对应账号额度）`);
    const created = [];
    for (const accountId of usable) {
      try {
        const record = await api.task.enqueue(projectId(), storyboard.id, accountId);
        created.push({ accountId, attemptId: record.attempt.id });
      } catch (error) {
        toast(`${accountName(accountId)} 入队失败：${error.message}`, "error");
      }
    }
    await refresh();
    if (!created.length) {
      state.compose.busy = "";
      renderCompose();
      return setMainStatus("没有创建任何任务", "error");
    }
    // 交给队列按并发上限调度：不是逐个 await，而是同时跑（上限内）
    await api.queue.run();
    await refresh();
    setMainStatus(
      `已创建 ${created.length} 条任务，正在并发执行（上限 ${state.queue?.limits?.globalConcurrency ?? 3} 个账号，其余排队）…`
    );

    // 跟踪到「全部离开待执行/提交中」或超时，状态文案随任务变化
    const deadline = Date.now() + 180000;
    let lastLine = "";
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refresh();
      const records = created
        .map((item) => (state.tasks || []).find((task) => task.id === item.attemptId))
        .filter(Boolean);
      const counts = {};
      for (const record of records) counts[record.status] = (counts[record.status] || 0) + 1;
      const running = records.filter((r) => ["pending", "submitting"].includes(r.status)).length;
      lastLine = `共 ${records.length} 条：${Object.entries(counts)
        .map(([status, count]) => `${statusLabel(status)} ${count}`)
        .join(" · ")}`;
      setMainStatus(running ? `${lastLine}（进行中）` : lastLine, running ? "" : "ok");
      if (!running || Date.now() > deadline) break;
    }
    state.compose.busy = "";
    renderCompose();
    const failures = created
      .map((item) => (state.tasks || []).find((task) => task.id === item.attemptId))
      .filter((record) => record && !["queued", "generating", "succeeded"].includes(record.status));
    if (failures.length) {
      setMainStatus(
        `${lastLine}；${failures.length} 条未成功：${failures
          .map((r) => `${accountName(r.accountId)}（${r.error?.message || r.driver?.message || statusLabel(r.status)}）`)
          .join("；")}`,
        "error"
      );
    } else {
      setMainStatus(`${lastLine}；平台已受理，转入监控`, "ok");
    }
  }

  /**
   * 提交前校验：真实走一遍到「发送前」为止（进入视频模式 → 写提示词 → 设参数 → 上传参考图 → 核实引用），
   * 不点击发送、不消耗额度，也不落任务记录；多账号按并发上限同时校验，结果按账号分别展示。
   */
  async function precheckCurrent() {
    if (state.compose.busy) return;
    const storyboard = currentStoryboard();
    if (!storyboard) return setMainStatus("还没有分镜，先新增一条", "warn");
    const accountIds = [...new Set((state.selectedAccountIds || []).slice())];
    if (!accountIds.length) return setMainStatus("请先在右侧勾选执行账号", "warn");

    state.compose.busy = "prechecking";
    renderCompose();
    setMainStatus(`正在校验 ${accountIds.length} 个账号：走到发送前停下，不消耗生成额度…`);
    const notReady = await ensureAccountPages(accountIds);
    const usable = accountIds.filter((id) => !notReady.some((item) => item.accountId === id));
    if (!usable.length) {
      state.compose.busy = "";
      renderCompose();
      return setMainStatus(
        `账号页面未就绪：${notReady.map((n) => `${accountName(n.accountId)}（${n.reason}）`).join("；")}`,
        "error"
      );
    }

    const results = [];
    const line = () =>
      usable
        .map((id) => {
          const hit = results.find((item) => item.accountId === id);
          return `${accountName(id)}：${!hit ? "校验中…" : hit.ok ? "通过（未发送）" : "未通过"}`;
        })
        .join("；");
    const limit = Math.max(1, Math.min(3, Number(state.queue?.limits?.globalConcurrency) || 3));
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= usable.length) return;
        const accountId = usable[index];
        try {
          const result = await api.task.precheck(projectId(), storyboard.id, accountId);
          results.push({ accountId, ...result });
        } catch (error) {
          results.push({ accountId, ok: false, message: `校验失败：${error.message}` });
        }
        setMainStatus(line());
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, usable.length) }, worker));

    state.compose.busy = "";
    renderCompose();
    const passed = results.filter((item) => item.ok);
    const detail = usable
      .map((id) => {
        const hit = results.find((item) => item.accountId === id);
        return `${accountName(id)}：${hit?.ok ? "通过" : `未通过（${hit?.message || "未知原因"}）`}`;
      })
      .join("；");
    const blockedNote = notReady.length
      ? `；页面未就绪：${notReady.map((n) => `${accountName(n.accountId)}（${n.reason}）`).join("；")}`
      : "";
    setMainStatus(
      `提交前校验完成（未发送、未消耗额度）：${detail}${blockedNote}`,
      passed.length === usable.length && !notReady.length ? "ok" : "error"
    );
  }

  /** 创作区的 @ 提及、粘贴与拖拽：与素材库行为保持一致 */
  function bindComposeEvents() {
    const prompt = $("workbenchMainPrompt");

    prompt?.addEventListener("input", (event) => {
      const storyboard = currentStoryboard();
      if (!storyboard) return;
      const node = event.target;
      state.pendingValues.set(`sb-prompt:${storyboard.id}`, node.value);
      setMainStatus("");
      const caret = node.selectionStart;
      if (caret > 0 && node.value[caret - 1] === "@") {
        const withoutAt = node.value.slice(0, caret - 1) + node.value.slice(caret);
        openMention(storyboard.id, withoutAt, caret - 1);
        return;
      }
      scheduleUpdate(storyboard.id, { prompt: node.value });
      const summary = $("workbenchRunSummary");
      if (summary) summary.dataset.dirty = "1";
    });

    prompt?.addEventListener("blur", () => {
      const storyboard = currentStoryboard();
      if (!storyboard) return;
      const value = String(prompt.value || "");
      if (value !== String(storyboard.prompt || "")) scheduleUpdate(storyboard.id, { prompt: value });
    });

    for (const type of ["dragenter", "dragover"]) {
      prompt?.addEventListener(type, (event) => {
        event.preventDefault();
        event.stopPropagation();
        prompt.classList.add("is-over");
      });
    }
    prompt?.addEventListener("dragleave", () => prompt.classList.remove("is-over"));
    prompt?.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      prompt.classList.remove("is-over");
      const files = [...(event.dataTransfer?.files || [])].filter((file) => /^image\//i.test(file.type));
      if (files.length) await importClipboardImages(files);
    });
    prompt?.addEventListener("paste", async (event) => {
      const files = [...(event.clipboardData?.files || [])].filter((file) => /^image\//i.test(file.type));
      if (!files.length) return;
      event.preventDefault();
      await importClipboardImages(files);
    });

    $("workbenchGenerate")?.addEventListener("click", generateCurrent);
    $("workbenchPrecheck")?.addEventListener("click", precheckCurrent);
    $("workbenchAutoDownload")?.addEventListener("change", async (event) => {
      const enabled = event.target.checked === true;
      try {
        const result = await api.task.autoDownload(projectId(), enabled);
        await refresh();
        toast(result.enabled ? "已开启：生成成功后自动下载（澜川同源优先）" : "已关闭自动下载");
      } catch (error) {
        event.target.checked = !enabled;
        toast(`设置失败：${error.message}`, "error");
      }
    });

    $("workbenchRefsRow")?.addEventListener("click", async (event) => {
      const button = event.target.closest('[data-act="compose-unbind"]');
      if (!button) return;
      const storyboard = currentStoryboard();
      if (!storyboard) return;
      try {
        await api.storyboard.unbind(projectId(), storyboard.id, button.dataset.assetId);
        await refresh();
        toast("已解除引用");
      } catch (error) {
        toast(`解除引用失败：${error.message}`, "error");
      }
    });

    $("workbenchAssetsToggle")?.addEventListener("click", () => {
      state.assetsCollapsed = !state.assetsCollapsed;
      applyLayout({ assetsCollapsed: state.assetsCollapsed });
    });
    $("workbenchTasksToggle")?.addEventListener("click", () => {
      const collapsed = !document.querySelector(".workbench-body")?.classList.contains("is-tasks-collapsed");
      applyLayout({ tasksCollapsed: collapsed });
    });
    bindSplitters();
  }

  // ── 三栏布局：拖拽分隔条 + 折叠状态本地保存 ────────────────
  const LAYOUT_KEY = "dbm.workbench.layout.v1";
  const readLayout = () => {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") || {};
    } catch {
      return {};
    }
  };
  const writeLayout = (patch) => {
    const next = { ...readLayout(), ...patch };
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {}
    return next;
  };

  /** 应用（并记住）栏宽与折叠状态；默认 264 / 336，与既有观感一致 */
  function applyLayout(patch = {}) {
    const body = document.querySelector(".workbench-body");
    if (!body) return;
    const layout = writeLayout(patch);
    if (Number(layout.assetsWidth)) body.style.setProperty("--wb-assets-w", `${Number(layout.assetsWidth)}px`);
    if (Number(layout.tasksWidth)) body.style.setProperty("--wb-tasks-w", `${Number(layout.tasksWidth)}px`);
    body.classList.toggle("is-assets-collapsed", layout.assetsCollapsed === true);
    body.classList.toggle("is-tasks-collapsed", layout.tasksCollapsed === true);
    state.assetsCollapsed = layout.assetsCollapsed === true;
    const assetsToggle = $("workbenchAssetsToggle");
    if (assetsToggle) assetsToggle.textContent = state.assetsCollapsed ? "▶ 素材库" : "◀ 素材库";
    const tasksToggle = $("workbenchTasksToggle");
    if (tasksToggle) tasksToggle.textContent = layout.tasksCollapsed === true ? "◀ 账号与任务" : "收起 ▶";
  }

  function bindSplitters() {
    const body = document.querySelector(".workbench-body");
    if (!body) return;
    for (const [id, side, min, max] of [
      ["workbenchSplitAssets", "left", 180, 460],
      ["workbenchSplitTasks", "right", 260, 560],
    ]) {
      const bar = $(id);
      if (!bar || bar.dataset.bound === "1") continue;
      bar.dataset.bound = "1";
      let dragging = false;
      const move = (event) => {
        if (!dragging) return;
        const rect = body.getBoundingClientRect();
        const raw = side === "left" ? event.clientX - rect.left : rect.right - event.clientX;
        const width = Math.max(min, Math.min(max, Math.round(raw)));
        if (side === "left") body.style.setProperty("--wb-assets-w", `${width}px`);
        else body.style.setProperty("--wb-tasks-w", `${width}px`);
      };
      const up = () => {
        if (!dragging) return;
        dragging = false;
        bar.classList.remove("is-dragging");
        document.body.classList.remove("workbench-dragging");
        const computed = getComputedStyle(body).gridTemplateColumns.split(" ").map((v) => parseFloat(v) || 0);
        // 以实际渲染宽度落盘（第 1 列=素材，第 5 列=任务）
        applyLayout(
          side === "left" ? { assetsWidth: Math.round(computed[0] || 264) } : { tasksWidth: Math.round(computed[4] || 336) }
        );
      };
      bar.addEventListener("pointerdown", (event) => {
        dragging = true;
        bar.classList.add("is-dragging");
        document.body.classList.add("workbench-dragging");
        bar.setPointerCapture?.(event.pointerId);
      });
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
      bar.addEventListener("pointercancel", up);
      bar.addEventListener("dblclick", () => applyLayout(side === "left" ? { assetsWidth: 264 } : { tasksWidth: 336 }));
      bar.addEventListener("keydown", (event) => {
        // 键盘可达性：左右方向键微调 16px
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const layout = readLayout();
        const current = Number(side === "left" ? layout.assetsWidth : layout.tasksWidth) || (side === "left" ? 264 : 336);
        const delta = (event.key === "ArrowRight" ? 16 : -16) * (side === "left" ? 1 : -1);
        event.preventDefault();
        applyLayout(side === "left" ? { assetsWidth: Math.max(min, Math.min(max, current + delta)) } : { tasksWidth: Math.max(min, Math.min(max, current + delta)) });
      });
    }
  }

  function renderAssetsCollapse() {
    applyLayout({ assetsCollapsed: state.assetsCollapsed === true });
  }

  // ── 分镜 ─────────────────────────────────────────────────
  function renderStoryboards() {
    const host = $("workbenchStoryboardList");
    if (!host) return;
    host.innerHTML = "";
    if (!state.project) return;
    const storyboards = state.project.storyboards || [];
    if (!storyboards.length) {
      host.appendChild(
        Object.assign(document.createElement("div"), {
          className: "workbench-empty",
          textContent: "还没有分镜。可以「新增分镜」或「批量粘贴提示词」。",
        })
      );
      return;
    }
    storyboards.forEach((storyboard, index) => host.appendChild(storyboardCard(storyboard, index, storyboards)));
  }

  function storyboardCard(storyboard, index, all) {
    const card = document.createElement("div");
    card.className = "workbench-sb";
    card.dataset.sbId = storyboard.id;
    if (state.project.ui?.selectedStoryboardId === storyboard.id) {
      card.classList.add("workbench-sb-selected");
    }

    const header = document.createElement("div");
    header.className = "workbench-sb-head";
    const badge = document.createElement("span");
    badge.className = "workbench-sb-index";
    badge.textContent = `#${index + 1}`;
    header.appendChild(badge);

    const nameInput = document.createElement("input");
    nameInput.className = "workbench-sb-name";
    const pendingName = state.pendingValues.get(`sb-name:${storyboard.id}`);
    nameInput.value = pendingName === undefined ? storyboard.name : pendingName;
    nameInput.maxLength = 120;
    nameInput.dataset.focusKey = `sb-name:${storyboard.id}`;
    header.appendChild(nameInput);

    const actions = document.createElement("div");
    actions.className = "workbench-sb-actions";
    const buttons = [
      ["up", "上移", index === 0],
      ["down", "下移", index === all.length - 1],
      ["duplicate", "复制", false],
      ["delete", "删除", false],
    ];
    for (const [act, label, disabled] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.dataset.act = act;
      button.textContent = label;
      button.disabled = disabled;
      actions.appendChild(button);
    }
    header.appendChild(actions);
    card.appendChild(header);

    // 图片引用标签：显示缩略图 + token + 可删除
    const refs = document.createElement("div");
    refs.className = "workbench-sb-refs";
    if (!storyboard.refs.length) {
      const empty = document.createElement("span");
      empty.className = "workbench-refs-empty";
      empty.textContent = "在提示词里输入 @ 即可插入参考图片";
      refs.appendChild(empty);
    }
    for (const ref of storyboard.refs) {
      const asset = assetById(ref.assetId);
      const chip = document.createElement("span");
      chip.className = "workbench-ref-chip";
      if (asset) {
        const img = document.createElement("img");
        img.alt = asset.name;
        paintThumb(img, asset.id);
        chip.appendChild(img);
      }
      const text = document.createElement("b");
      text.textContent = `${ref.token} ${asset ? asset.name : "（素材已删除）"}`;
      chip.appendChild(text);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.act = "unbind";
      remove.dataset.assetId = ref.assetId;
      remove.title = "解除引用";
      remove.textContent = "×";
      chip.appendChild(remove);
      refs.appendChild(chip);
    }
    card.appendChild(refs);

    const prompt = document.createElement("textarea");
    prompt.className = "workbench-sb-prompt";
    const pendingPrompt = state.pendingValues.get(`sb-prompt:${storyboard.id}`);
    prompt.value = pendingPrompt === undefined ? storyboard.prompt : pendingPrompt;
    prompt.placeholder = "描述这个分镜的画面与动作；输入 @ 插入参考图片。";
    prompt.dataset.focusKey = `sb-prompt:${storyboard.id}`;
    card.appendChild(prompt);

    const foot = document.createElement("div");
    foot.className = "workbench-sb-foot";
    const params = document.createElement("span");
    const effective = effectiveParams(storyboard);
    const overridden = Object.entries(storyboard.overrides || {}).filter(([, v]) => v);
    params.textContent = `模型 ${effective.model} · 时长 ${effective.duration}${
      overridden.length ? `（含 ${overridden.length} 项单条覆盖）` : "（继承全局）"
    }`;
    foot.appendChild(params);

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "text-button";
    loadButton.dataset.act = "load";
    loadButton.textContent = "载入编辑区";
    loadButton.title = "把这条分镜载入上方的提示词编辑框";
    foot.appendChild(loadButton);

    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.className = "text-button workbench-run-button";
    runButton.dataset.act = "run";
    runButton.textContent = "生成这一条";
    foot.appendChild(runButton);

    const overrideToggle = document.createElement("button");
    overrideToggle.type = "button";
    overrideToggle.className = "text-button";
    overrideToggle.dataset.act = "override";
    overrideToggle.textContent = "单条覆盖";
    foot.appendChild(overrideToggle);
    card.appendChild(foot);

    const overrideBox = document.createElement("div");
    overrideBox.className = "workbench-sb-overrides hidden";
    const target = capabilityTarget();
    const modelSelect = document.createElement("select");
    modelSelect.dataset.act = "override-model";
    const inheritModel = document.createElement("option");
    inheritModel.value = "";
    inheritModel.textContent = "继承全局";
    modelSelect.appendChild(inheritModel);
    for (const value of target?.models || []) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      modelSelect.appendChild(option);
    }
    modelSelect.value = storyboard.overrides?.model || "";
    overrideBox.appendChild(field("模型", modelSelect));

    const durationSelect = document.createElement("select");
    durationSelect.dataset.act = "override-duration";
    const inheritDuration = document.createElement("option");
    inheritDuration.value = "";
    inheritDuration.textContent = "继承全局";
    durationSelect.appendChild(inheritDuration);
    for (const value of target?.durations || []) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = value === "auto" ? "自动" : `${value} 秒`;
      durationSelect.appendChild(option);
    }
    durationSelect.value = storyboard.overrides?.duration || "";
    overrideBox.appendChild(field("时长", durationSelect));

    const ratioSelect = document.createElement("select");
    ratioSelect.dataset.act = "override-ratio";
    const inheritRatio = document.createElement("option");
    inheritRatio.value = "";
    inheritRatio.textContent = "继承全局";
    ratioSelect.appendChild(inheritRatio);
    ratioOptions(storyboard.overrides?.ratio).forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      ratioSelect.appendChild(option);
    });
    ratioSelect.value = storyboard.overrides?.ratio || "";
    overrideBox.appendChild(field("比例", ratioSelect));

    const ratioNote = document.createElement("span");
    ratioNote.className = "workbench-unknown";
    ratioNote.textContent = "比例能力未核实";
    overrideBox.appendChild(ratioNote);

    card.appendChild(overrideBox);

    return card;
  }

  function effectiveParams(storyboard) {
    const defaults = state.project.defaults || {};
    return {
      model: storyboard.overrides?.model || defaults.model,
      duration: storyboard.overrides?.duration || defaults.duration,
      ratio: storyboard.overrides?.ratio || defaults.ratio,
    };
  }

  function scheduleUpdate(storyboardId, patch, options = {}) {
    const key = `${storyboardId}:${options.key || "prompt"}`;
    const timer = state.saveTimers.get(key);
    if (timer) clearTimeout(timer);
    state.saveTimers.set(
      key,
      setTimeout(async () => {
        state.saveTimers.delete(key);
        state.pendingValues.delete(`sb-${options.key || "prompt"}:${storyboardId}`);
        try {
          const result = await api.storyboard.update(projectId(), storyboardId, patch);
          state.lastSaved = formatTime(new Date());
          if (result.droppedTokens?.length) {
            toast(`提示词里已找不到 ${result.droppedTokens.join("、")}，对应引用已解除`, "error");
          }
          await refresh();
        } catch (error) {
          toast(`保存失败：${error.message}`, "error");
        }
      }, options.delay ?? 600)
    );
  }

  async function selectStoryboard(storyboardId) {
    if (!state.project) return;
    // 已在选中态就直接返回，避免 focusin → 保存 → 广播 → 重渲染 的回环
    if (state.project.ui?.selectedStoryboardId === storyboardId) {
      state.focusedStoryboardId = storyboardId;
      return;
    }
    state.focusedStoryboardId = storyboardId;
    try {
      await api.ui.set(projectId(), { selectedStoryboardId: storyboardId });
      state.project.ui = { ...(state.project.ui || {}), selectedStoryboardId: storyboardId };
    } catch {}
  }

  // ── @图片选择器 ───────────────────────────────────────────
  function openMention(storyboardId, prompt, caret) {
    state.mention = { storyboardId, prompt, caret, search: "" };
    const search = $("workbenchMentionSearch");
    if (search) search.value = "";
    renderMention();
    openModal("workbenchMentionModal");
    setTimeout(() => search?.focus(), 0);
  }

  function renderMention() {
    const list = $("workbenchMentionList");
    if (!list) return;
    const keyword = state.mention.search.trim().toLowerCase();
    const storyboard = state.project?.storyboards?.find((s) => s.id === state.mention.storyboardId);
    const bound = new Set((storyboard?.refs || []).map((r) => r.assetId));
    const items = state.assets.filter(
      (a) => !keyword || a.name.toLowerCase().includes(keyword) || a.id.includes(keyword)
    );
    list.innerHTML = "";
    if (!items.length) {
      list.appendChild(
        Object.assign(document.createElement("div"), {
          className: "workbench-empty",
          textContent: "没有可选素材，请先在左侧素材库导入图片。",
        })
      );
      return;
    }
    for (const asset of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "workbench-mention-row";
      row.dataset.assetId = asset.id;
      const img = document.createElement("img");
      img.alt = asset.name;
      paintThumb(img, asset.id);
      row.appendChild(img);
      const name = document.createElement("span");
      name.textContent = asset.name;
      row.appendChild(name);
      if (bound.has(asset.id)) {
        const mark = document.createElement("em");
        mark.textContent = "已引用";
        row.appendChild(mark);
      }
      row.addEventListener("click", () => bindFromMention(asset.id));
      list.appendChild(row);
    }
  }

  async function bindFromMention(assetId) {
    const { storyboardId, prompt, caret } = state.mention;
    closeModal("workbenchMentionModal");
    try {
      const result = await api.storyboard.bind(projectId(), storyboardId, assetId, { prompt, caret });
      state.lastSaved = formatTime(new Date());
      // 绑定后服务端会重写提示词（把 @图N 插到光标处）：
      // 必须先丢掉本地未落盘的旧值与待保存定时器，否则重渲染会用旧文本覆盖，视觉上就像「没关联」
      state.pendingValues.delete(`sb-prompt:${storyboardId}`);
      const timer = state.saveTimers.get(`${storyboardId}:prompt`);
      if (timer) {
        clearTimeout(timer);
        state.saveTimers.delete(`${storyboardId}:prompt`);
      }
      await refresh();
      if (!result.added) return toast("该素材已经引用过了");
      // 把 textarea 同步成服务端返回的文本，并把光标放到 token 之后，继续输入更顺手
      const node = document.querySelector(`[data-focus-key="sb-prompt:${storyboardId}"]`);
      if (node) {
        if (typeof result.storyboard?.prompt === "string") node.value = result.storyboard.prompt;
        node.focus();
        if (Number.isInteger(result.caret)) node.setSelectionRange(result.caret, result.caret);
      }
    } catch (error) {
      toast(`插入参考图片失败：${error.message}`, "error");
    }
  }

  // ── 批量粘贴 ─────────────────────────────────────────────
  let pasteItems = [];

  function pasteMode() {
    const checked = document.querySelector('input[name="workbenchPasteMode"]:checked');
    return checked?.value || "blank";
  }

  async function previewPaste() {
    const text = $("workbenchPasteText")?.value || "";
    const list = $("workbenchPasteList");
    const count = $("workbenchPasteCount");
    const button = $("workbenchPasteImport");
    try {
      const result = await api.prompt.split(text, pasteMode());
      pasteItems = result.items;
      if (count) count.textContent = `${result.count} 条`;
      if (button) button.disabled = result.count === 0;
      if (!list) return;
      list.innerHTML = "";
      for (const item of result.items) {
        const row = document.createElement("div");
        row.className = "workbench-paste-item";
        const head = document.createElement("div");
        const index = document.createElement("span");
        index.className = "workbench-paste-index";
        index.textContent = `#${item.index}`;
        head.appendChild(index);
        const name = document.createElement("strong");
        name.textContent = item.name;
        head.appendChild(name);
        const meta = document.createElement("em");
        meta.textContent = `${item.chars} 字 / ${item.lines} 行`;
        head.appendChild(meta);
        row.appendChild(head);
        const body = document.createElement("p");
        body.textContent = item.prompt.length > 160 ? `${item.prompt.slice(0, 160)}…` : item.prompt;
        row.appendChild(body);
        list.appendChild(row);
      }
    } catch (error) {
      toast(`拆分失败：${error.message}`, "error");
    }
  }

  // ── 事件绑定 ─────────────────────────────────────────────
  function bindEvents() {
    $("showWorkbench")?.addEventListener("click", () => {
      openModal("workbenchModal");
      refresh();
    });

    bindComposeEvents();
    renderAssetsCollapse();

    for (const node of document.querySelectorAll("#workbenchModal [data-close], #workbenchPasteModal [data-close], #workbenchMentionModal [data-close], #workbenchPreviewModal [data-close], #workbenchImpactModal [data-close]")) {
      node.addEventListener(
        "click",
        (event) => {
          event.stopPropagation();
          closeModal(node.dataset.close);
        },
        true
      );
    }

    $("workbenchProjectSelect")?.addEventListener("change", async (event) => {
      try {
        await api.project.open(event.target.value);
        state.thumbCache.clear();
        await refresh();
      } catch (error) {
        toast(`切换项目失败：${error.message}`, "error");
      }
    });

    $("workbenchProjectNew")?.addEventListener("click", async () => {
      try {
        // Electron 不支持 window.prompt，改为创建后就地改名
        await api.project.create(`项目 ${new Date().toLocaleDateString("zh-CN")}`);
        state.thumbCache.clear();
        await refresh();
        promptInline($("workbenchProjectSelect")?.parentElement, state.project?.name || "", async (name) => {
          if (!name) return;
          await api.project.rename(projectId(), name);
          await refresh();
        });
      } catch (error) {
        toast(`新建项目失败：${error.message}`, "error");
      }
    });

    $("workbenchProjectRename")?.addEventListener("click", () => {
      if (!state.project) return;
      promptInline($("workbenchProjectSelect")?.parentElement, state.project.name, async (name) => {
        if (!name) return;
        try {
          await api.project.rename(projectId(), name);
          await refresh();
        } catch (error) {
          toast(`重命名失败：${error.message}`, "error");
        }
      });
    });

    $("workbenchAssetSearch")?.addEventListener("input", (event) => {
      state.search = event.target.value;
      renderAssets();
    });

    $("workbenchAssetImport")?.addEventListener("click", () => importAssets(null));

    const dropzone = $("workbenchDropzone");
    if (dropzone) {
      const stop = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
        dropzone.addEventListener(type, stop);
      }
      dropzone.addEventListener("dragover", () => dropzone.classList.add("is-over"));
      dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));
      dropzone.addEventListener("drop", async (event) => {
        dropzone.classList.remove("is-over");
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return;
        if (!fileUtils) {
          return toast("当前环境不支持拖拽取路径，请用「导入图片」按钮", "error");
        }
        const paths = files.map((file) => fileUtils.getPathForFile(file)).filter(Boolean);
        if (!paths.length) return toast("未能读取拖入文件的路径，请用「导入图片」按钮", "error");
        await importAssets(paths);
      });
    }

    // 粘贴导入：工作台打开时，Ctrl+V 里有图片就存进素材库（纯文字粘贴不受影响）
    document.addEventListener("paste", async (event) => {
      const modal = $("workbenchModal");
      if (!modal || modal.classList.contains("hidden")) return;
      const files = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      event.preventDefault();
      await importClipboardImages(files);
    });

    $("workbenchAssetList")?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const assetId = button.closest(".workbench-asset")?.dataset.assetId;
      if (!assetId) return;
      const act = button.dataset.act;
      if (act === "delete") return deleteAsset(assetId, "abort");
      if (act === "preview") {
        const asset = assetById(assetId);
        const name = $("workbenchPreviewName");
        if (name) name.textContent = asset ? asset.name : "素材预览";
        const image = $("workbenchPreviewImage");
        if (image) image.src = await api.asset.preview(projectId(), assetId);
        return openModal("workbenchPreviewModal");
      }
      if (act === "insert") {
        const target = state.focusedStoryboardId || state.project?.storyboards?.[0]?.id;
        if (!target) return toast("请先新增一个分镜", "error");
        // 用输入框里的实时文本与光标，而不是等防抖落盘的旧值，否则刚打的字会被丢掉
        const node = document.querySelector(`[data-focus-key="sb-prompt:${target}"]`);
        state.mention = {
          storyboardId: target,
          prompt: node ? node.value : null,
          caret: node ? node.selectionStart : null,
          search: "",
        };
        await bindFromMention(assetId);
        return;
      }
    });

    $("workbenchAssetList")?.addEventListener(
      "change",
      async (event) => {
        const input = event.target.closest('[data-act="rename"]');
        if (!input) return;
        const assetId = input.closest(".workbench-asset")?.dataset.assetId;
        if (!assetId) return;
        try {
          await api.asset.rename(projectId(), assetId, input.value);
          // 改名只影响展示名，分镜里的引用按 assetId 保持不变
          await refresh();
          toast("已改名（分镜引用不受影响）");
        } catch (error) {
          toast(`改名失败：${error.message}`, "error");
        }
      },
      true
    );

    $("workbenchImpactConfirm")?.addEventListener("click", async () => {
      const ids = state.impact.assetIds.slice();
      closeModal("workbenchImpactModal");
      for (const id of ids) await deleteAsset(id, "unbind");
    });

    $("workbenchStoryboardAdd")?.addEventListener("click", async () => {
      if (!state.project) return toast("请先新建或选择项目", "error");
      try {
        const result = await api.storyboard.add(projectId(), {});
        await refresh();
        state.focusedStoryboardId = result.storyboard.id;
        document.querySelector(`[data-focus-key="sb-prompt:${result.storyboard.id}"]`)?.focus();
      } catch (error) {
        toast(`新增分镜失败：${error.message}`, "error");
      }
    });

    $("workbenchPasteOpen")?.addEventListener("click", () => {
      if (!state.project) return toast("请先新建或选择项目", "error");
      pasteItems = [];
      const text = $("workbenchPasteText");
      if (text) text.value = "";
      openModal("workbenchPasteModal");
      previewPaste();
    });

    let pasteTimer = 0;
    $("workbenchPasteText")?.addEventListener("input", () => {
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(previewPaste, 300);
    });

    $("workbenchPasteModes")?.addEventListener("change", previewPaste);

    $("workbenchPasteImport")?.addEventListener("click", async () => {
      if (!pasteItems.length) return;
      try {
        const result = await api.prompt.import(projectId(), pasteItems, pasteMode());
        closeModal("workbenchPasteModal");
        await refresh();
        toast(`已导入 ${result.created} 个分镜`);
      } catch (error) {
        toast(`导入失败：${error.message}`, "error");
      }
    });

    $("workbenchMentionSearch")?.addEventListener("input", (event) => {
      state.mention.search = event.target.value;
      renderMention();
    });

    $("workbenchAccountPicks")?.addEventListener("change", (event) => {
      const box = event.target.closest('input[type="checkbox"][data-act="account-toggle"]');
      if (!box) return;
      const id = box.value;
      const set = new Set(state.selectedAccountIds);
      if (box.checked) set.add(id);
      else set.delete(id);
      state.selectedAccountIds = [...set];
      state.accountsTouched = true;
      renderAccounts();
      // 账号选择直接影响主按钮的可用性，这里必须同步刷新
      renderCompose();
    });

    $("workbenchAccountPicks")?.addEventListener("click", async (event) => {
      const clear = event.target.closest('[data-act="clear-block"]');
      if (!clear) return;
      try {
        await api.account.clearBlock(clear.dataset.accountId);
        await refresh();
        toast("已解除账号暂停");
      } catch (error) {
        toast(`解除失败：${error.message}`, "error");
      }
    });

    $("workbenchQueuePause")?.addEventListener("click", async () => {
      try {
        await api.queue.pause();
        await refresh();
        toast("已暂停待执行队列");
      } catch (error) {
        toast(`暂停失败：${error.message}`, "error");
      }
    });

    $("workbenchQueueResume")?.addEventListener("click", async () => {
      try {
        await api.queue.resume();
        await refresh();
        toast("已恢复队列");
      } catch (error) {
        toast(`恢复失败：${error.message}`, "error");
      }
    });

    $("workbenchRunConfirm")?.addEventListener("click", async () => {
      const confirm = $("workbenchRunConfirm");
      const assignments = (state.run.assignments || []).filter((item) => item.valid);
      if (!assignments.length) return toast("没有校验通过的尝试可提交", "error");
      const original = confirm.textContent;
      confirm.disabled = true;
      confirm.textContent = "提交中…";
      const failed = [];
      let done = 0;
      try {
        for (const [index, item] of assignments.entries()) {
          const status = $("workbenchRunStatus");
          if (status) {
            status.textContent = `正在提交第 ${index + 1}/${assignments.length} 条：${item.storyboardName} → ${accountName(
              item.accountId
            )}（真实提交，请勿关闭窗口）…`;
          }
          try {
            const created = await api.task.enqueue(projectId(), item.storyboardId, item.accountId);
            state.run.currentAttemptId = created.attempt.id;
            await refresh();
            await api.task.execute(projectId(), created.attempt.id);
            done++;
          } catch (error) {
            failed.push(`${item.storyboardName} → ${accountName(item.accountId)}：${error.message}`);
          }
        }
        state.run.currentAttemptId = "";
        await refresh();
        closeModal("workbenchRunModal");
        if (failed.length) {
          toast(`已提交 ${done} 条，${failed.length} 条失败`, "error");
          for (const text of failed) toast(text, "error");
        } else {
          toast(`已提交 ${done} 条尝试，任务卡片里有逐步结果`, "ok");
        }
      } catch (error) {
        toast(`提交失败：${error.message}`, "error");
      } finally {
        confirm.disabled = false;
        confirm.textContent = original;
      }
    });

    // 模式切换：切换后重新算分配（默认分配执行，对比模式必须显式选择）
    $("workbenchRunPreview")?.addEventListener("change", async (event) => {
      const radio = event.target.closest('input[name="workbenchRunMode"]');
      if (!radio) return;
      try {
        await openRunModal(state.run.storyboardIds, radio.value);
      } catch (error) {
        toast(`重新计算分配失败：${error.message}`, "error");
      }
    });

    $("workbenchRunBatch")?.addEventListener("click", async () => {
      try {
        await openRunModal((state.project?.storyboards || []).map((s) => s.id), "distribute");
      } catch (error) {
        toast(`无法准备批量提交：${error.message}`, "error");
      }
    });

    $("workbenchAccountNote")?.addEventListener("click", (event) => {
      if (event.target.closest('[data-act="accounts-all"]')) {
        state.accountsTouched = true;
        state.selectedAccountIds = (state.accounts || []).map((a) => a.id);
        renderAccounts();
        renderCompose();
        return;
      }
      if (event.target.closest('[data-act="accounts-none"]')) {
        state.accountsTouched = true;
        state.selectedAccountIds = [];
        renderAccounts();
        renderCompose();
      }
    });

    $("workbenchTaskList")?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const attemptId = button.closest(".workbench-task")?.dataset.attemptId;
      if (!attemptId) return;
      button.disabled = true;
      try {
        if (button.dataset.act === "cancel") {
          const record = await api.task.cancel(projectId(), attemptId);
          toast(record.status === "canceled" ? "已取消" : `未取消：${record.poll?.message || "平台不支持取消"}`);
        } else if (button.dataset.act === "stop-retry") {
          await api.task.stopAutoRetry(projectId(), attemptId);
          toast("已停止自动重试");
        } else if (button.dataset.act === "retry") {
          await api.task.retry(projectId(), attemptId);
          toast("已创建新的尝试记录，历史保留");
        } else if (button.dataset.act === "download") {
          const record = (state.tasks || []).find((t) => t.id === attemptId);
          const dlStatus = record?.download?.status || "idle";
          const resumable = dlStatus === "paused" || dlStatus === "failed";
          const result = await api.task.download(projectId(), attemptId, { resume: resumable });
          if (result?.paused) toast("下载已暂停（分片已保留，可继续）");
          else if (result?.canceled) toast("已取消下载");
          else toast(result.ok ? `已下载：${result.filePath}` : `下载失败：${result.error}`, result.ok ? "info" : "error");
        } else if (button.dataset.act === "download-pause") {
          const result = await api.task.pauseDownload(projectId(), attemptId);
          toast(result?.ok ? "已暂停下载（分片保留，可续传）" : `未暂停：${result?.reason || "未知原因"}`, result?.ok ? "info" : "error");
        } else if (button.dataset.act === "download-cancel") {
          const result = await api.task.cancelDownload(projectId(), attemptId);
          toast(result?.ok ? "已取消下载" : `未取消：${result?.reason || "未知原因"}`, result?.ok ? "info" : "error");
        } else if (button.dataset.act === "sources") {
          const info = await api.task.sources(projectId(), attemptId, { refresh: true });
          state.sourceCache.set(attemptId, info);
          renderTasks();
          const lines = (info.sources || []).map(
            (s) => `${s.tag}：${s.available ? "可用" : `不可用（${s.error}）`}${s.urlSafe ? ` · ${s.urlSafe}` : ""}`
          );
          toast(`${info.note || ""}${lines.length ? `｜${lines.join("；")}` : ""}`, info.sources?.some((s) => s.available) ? "info" : "error");
        } else if (button.dataset.act === "reveal") {
          const result = await api.task.reveal(projectId(), attemptId);
          toast(`已在文件管理器中定位：${result.filePath}`);
        } else if (button.dataset.act === "open-file") {
          const result = await api.task.openFile(projectId(), attemptId);
          toast(`已用系统播放器打开：${result.filePath}`);
        }
        await refresh();
      } catch (error) {
        toast(`操作失败：${error.message}`, "error");
        button.disabled = false;
      }
    });

    const list = $("workbenchStoryboardList");
    if (!list) return;

    list.addEventListener("input", (event) => {
      const card = event.target.closest(".workbench-sb");
      if (!card) return;
      const storyboardId = card.dataset.sbId;
      state.focusedStoryboardId = storyboardId;
      if (event.target.classList.contains("workbench-sb-name")) {
        state.pendingValues.set(`sb-name:${storyboardId}`, event.target.value);
        scheduleUpdate(storyboardId, { name: event.target.value }, { key: "name" });
        return;
      }
      if (event.target.classList.contains("workbench-sb-prompt")) {
        const node = event.target;
        state.pendingValues.set(`sb-prompt:${storyboardId}`, node.value);
        const caret = node.selectionStart;
        // 刚输入 @ → 弹出图片选择器；把 @ 本身排除在插入点之外
        if (caret > 0 && node.value[caret - 1] === "@") {
          const withoutAt = node.value.slice(0, caret - 1) + node.value.slice(caret);
          openMention(storyboardId, withoutAt, caret - 1);
          return;
        }
        scheduleUpdate(storyboardId, { prompt: node.value });
      }
    });

    list.addEventListener("focusin", (event) => {
      const card = event.target.closest(".workbench-sb");
      if (card) selectStoryboard(card.dataset.sbId);
    });

    list.addEventListener("change", async (event) => {
      const card = event.target.closest(".workbench-sb");
      if (!card) return;
      const storyboardId = card.dataset.sbId;
      const act = event.target.dataset.act;
      if (act !== "override-model" && act !== "override-duration" && act !== "override-ratio") return;
      const patch = act === "override-model"
        ? { model: event.target.value }
        : act === "override-duration"
          ? { duration: event.target.value }
          : { ratio: event.target.value };
      try {
        await api.storyboard.update(projectId(), storyboardId, { overrides: patch });
        state.lastSaved = formatTime(new Date());
        await refresh();
      } catch (error) {
        toast(`保存单条覆盖失败：${error.message}`, "error");
      }
    });

    list.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const card = button.closest(".workbench-sb");
      if (!card) return;
      const storyboardId = card.dataset.sbId;
      const act = button.dataset.act;
      const storyboards = state.project.storyboards || [];
      const index = storyboards.findIndex((s) => s.id === storyboardId);

      try {
        if (act === "unbind") {
          await api.storyboard.unbind(projectId(), storyboardId, button.dataset.assetId);
          await refresh();
          return;
        }
        if (act === "delete") {
          await api.storyboard.remove(projectId(), storyboardId);
          await refresh();
          return;
        }
        if (act === "duplicate") {
          await api.storyboard.duplicate(projectId(), storyboardId);
          await refresh();
          return;
        }
        if (act === "override") {
          card.querySelector(".workbench-sb-overrides")?.classList.toggle("hidden");
          return;
        }
        if (act === "load") {
          await loadStoryboardIntoCompose(storyboardId);
          toast("已载入编辑区");
          return;
        }
        if (act === "run") {
          await openRunModal([storyboardId], "distribute");
          return;
        }
        if (act === "up" || act === "down") {
          const target = act === "up" ? index - 1 : index + 1;
          if (target < 0 || target >= storyboards.length) return;
          const ids = storyboards.map((s) => s.id);
          [ids[index], ids[target]] = [ids[target], ids[index]];
          await api.storyboard.reorder(projectId(), ids);
          await refresh();
        }
      } catch (error) {
        toast(`操作失败：${error.message}`, "error");
      }
    });
  }

  api.onChanged(() => {
    if (!$("workbenchModal") || $("workbenchModal").classList.contains("hidden")) return;
    refresh({ silent: false });
  });

  // 下载实时进度：只更新受影响的任务卡（节流到 ~4 次/秒），不整页刷新
  let progressFlush = 0;
  api.onDownloadProgress((payload) => {
    if (!payload?.attemptId) return;
    const current = state.downloadProgress.get(payload.attemptId) || {};
    state.downloadProgress.set(payload.attemptId, { ...current, ...payload });
    const now = Date.now();
    if (now - progressFlush < 250) return;
    progressFlush = now;
    if ($("workbenchModal")?.classList.contains("hidden")) return;
    const card = document.querySelector(`.workbench-task[data-attempt-id="${payload.attemptId}"]`);
    if (!card) return;
    const record = (state.tasks || []).find((t) => t.id === payload.attemptId);
    if (!record) return;
    const host = card.querySelector(".workbench-download");
    if (host) host.replaceWith(downloadBlock(record));
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindEvents);
  } else {
    bindEvents();
  }
})();