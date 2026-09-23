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
    limits: null,
    accounts: [],
    tasks: [],
    queue: null,
    selectedAccountId: "",
    run: { storyboardId: "", attemptId: "" },
    search: "",
    saveTimers: new Map(),
    // 正在编辑但尚未落盘的值：重渲染时优先使用，避免自动保存期间的输入被覆盖
    pendingValues: new Map(),
    lastSaved: "",
    focusedStoryboardId: "",
    mention: { storyboardId: "", prompt: "", caret: 0, search: "" },
    impact: { assetIds: [] },
    thumbCache: new Map(),
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
    renderDefaults();
    renderStoryboards();
    renderAccounts();
    renderTasks();
    renderHint();
    restoreFocus(focus);
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
    node.textContent = storage.ok
      ? `数据目录：${storage.root}（素材导入后会复制到项目目录，原文件移动不影响项目）`
      : storage.message;
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

  // ── 默认参数（只展示平台真实能力） ────────────────────────
  function capabilityTarget() {
    return state.capabilities?.targets?.dola || state.capabilities?.targets?.doubao || null;
  }

  function renderDefaults() {
    const host = $("workbenchDefaults");
    if (!host) return;
    host.innerHTML = "";
    if (!state.project) return;

    const target = capabilityTarget();
    const defaults = state.project.defaults;

    const label = document.createElement("span");
    label.className = "workbench-defaults-label";
    label.textContent = "全局默认参数";
    host.appendChild(label);

    const model = document.createElement("select");
    model.dataset.focusKey = "default:model";
    for (const value of target?.models || []) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      model.appendChild(option);
    }
    model.value = defaults.model;
    if (model.value !== defaults.model) {
      const option = document.createElement("option");
      option.value = defaults.model;
      option.textContent = `${defaults.model}（不在能力表中）`;
      option.disabled = true;
      model.appendChild(option);
      model.value = defaults.model;
    }
    host.appendChild(field("模型", model));

    const duration = document.createElement("select");
    duration.dataset.focusKey = "default:duration";
    for (const value of target?.durations || []) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = value === "auto" ? "自动" : `${value} 秒`;
      duration.appendChild(option);
    }
    duration.value = String(defaults.duration);
    host.appendChild(field("时长", duration));

    const ratio = document.createElement("select");
    ratio.disabled = true;
    ratio.dataset.focusKey = "default:ratio";
    const placeholder = document.createElement("option");
    placeholder.value = defaults.ratio;
    placeholder.textContent = "平台比例能力未核实";
    ratio.appendChild(placeholder);
    host.appendChild(field("比例", ratio));

    const refLimit = document.createElement("span");
    refLimit.className = "workbench-unknown";
    refLimit.textContent = "参考图数量上限：未知";
    host.appendChild(refLimit);

    const onChange = async () => {
      try {
        await api.project.defaults(projectId(), {
          model: model.value,
          duration: duration.value,
          ratio: ratio.value,
        });
        state.lastSaved = formatTime(new Date());
        await refresh();
      } catch (error) {
        toast(`保存默认参数失败：${error.message}`, "error");
      }
    };
    model.addEventListener("change", onChange);
    duration.addEventListener("change", onChange);
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

  // ── 执行账号与任务 ───────────────────────────────────────
  const statusLabel = (status) => state.statusLabels?.[status] || status;
  const downloadLabel = (status) => state.downloadLabels?.[status] || status;
  const ACTIVE_STATUSES = ["pending", "submitting", "queued", "generating"];
  const isActiveStatus = (status) => ACTIVE_STATUSES.includes(status);

  function emptyDiv(message) {
    return Object.assign(document.createElement("div"), { className: "workbench-empty", textContent: message });
  }

  function renderAccounts() {
    const select = $("workbenchAccountSelect");
    const note = $("workbenchAccountNote");
    if (!select) return;
    const accounts = state.accounts || [];
    if (!accounts.length) {
      select.innerHTML = "";
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "（没有可执行账号）";
      select.appendChild(option);
      if (note) note.textContent = "未读到任何账号。账号来自本机既有账号列表，工作台不会新建或修改账号。";
      return;
    }
    if (!accounts.some((a) => a.id === state.selectedAccountId)) {
      state.selectedAccountId = accounts[0].id;
    }
    select.innerHTML = "";
    for (const account of accounts) {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.name}${account.blocked ? "（已暂停）" : ""} · 执行中 ${account.activeTasks}`;
      select.appendChild(option);
    }
    select.value = state.selectedAccountId;

    if (!note) return;
    note.innerHTML = "";
    const current = accounts.find((a) => a.id === state.selectedAccountId);
    const line = document.createElement("span");
    if (current?.blocked) {
      line.textContent = `已暂停：${current.blocked.label}（${current.blocked.message || "无详情"}）`;
    } else {
      // 平台额度与登录状态本工作台无法核实，按需求显示「未知」
      line.textContent = `登录状态：未知 · 额度：未知 · 执行中任务：${current?.activeTasks ?? 0}`;
    }
    note.appendChild(line);
    if (current?.blocked) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "text-button";
      clear.dataset.act = "clear-block";
      clear.textContent = "解除暂停";
      note.appendChild(clear);
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
      `账号 ${record.accountId}`,
      record.submittedAt ? `提交 ${formatTime(record.submittedAt)}` : "尚未提交",
      `最近更新 ${formatTime(record.updatedAt)}`,
      record.platformTaskId ? `平台任务 ${record.platformTaskId}` : "平台任务 ID：无",
    ];
    if (record.params?.model) pieces.push(`模型 ${record.params.model}`);
    if (record.params?.duration) pieces.push(`时长 ${record.params.duration}`);
    if (record.refs?.length) pieces.push(`参考图 ${record.refs.length} 张`);
    for (const piece of pieces) {
      const span = document.createElement("span");
      span.textContent = piece;
      meta.appendChild(span);
    }
    card.appendChild(meta);

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

    // 状态变化日志：只展示本工作台记录的阶段与脱敏摘要，不含 Cookie / Token
    const log = document.createElement("details");
    log.className = "workbench-task-log";
    const summary = document.createElement("summary");
    summary.textContent = `状态变化（${record.history.length} 条，仅阶段与摘要）`;
    log.appendChild(summary);
    for (const item of record.history) {
      const row = document.createElement("div");
      row.textContent = `${formatTime(item.at)} ${statusLabel(item.status)}${item.note ? ` · ${item.note}` : ""}`;
      log.appendChild(row);
    }
    card.appendChild(log);

    const foot = document.createElement("div");
    foot.className = "workbench-task-foot";
    const dl = document.createElement("span");
    dl.className = "workbench-download-state";
    dl.textContent = `下载：${downloadLabel(record.download?.status)}${
      record.download?.message ? `（${record.download.message}）` : ""
    }`;
    foot.appendChild(dl);
    if (record.result?.filePath) {
      const pathText = document.createElement("span");
      pathText.className = "workbench-task-path";
      pathText.textContent = record.result.filePath;
      foot.appendChild(pathText);
    }

    const buttons = [];
    if (isActiveStatus(record.status)) buttons.push(["cancel", "取消"]);
    if (["failed", "manual", "unconfirmed"].includes(record.status)) buttons.push(["retry", "重试"]);
    if (record.status === "succeeded") buttons.push(["download", "下载"]);
    for (const [act, label] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.dataset.act = act;
      button.textContent = label;
      foot.appendChild(button);
    }
    card.appendChild(foot);
    return card;
  }

  function runPreview(host, preview) {
    host.innerHTML = "";
    const rows = [
      ["分镜", state.project?.storyboards?.find((s) => s.id === state.run.storyboardId)?.name || ""],
      ["模型", preview.params.model || "(未设置)"],
      ["时长", preview.params.duration || "(未设置)"],
      ["比例", preview.params.ratio ? `${preview.params.ratio}（平台比例能力未核实，不会提交）` : "(未设置)"],
      ["参考图片", preview.uploads.length ? `${preview.uploads.length} 张` : "无"],
      ["执行账号", state.accounts.find((a) => a.id === preview.accountId)?.name || preview.accountId],
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
    const prompt = document.createElement("div");
    prompt.className = "workbench-run-prompt";
    prompt.textContent = preview.promptPreview || "(空提示词)";
    host.appendChild(prompt);

    if (preview.errors.length) {
      const box = document.createElement("div");
      box.className = "workbench-run-errors";
      box.textContent = `无法提交：${preview.errors.join("；")}`;
      host.appendChild(box);
    }
    if (preview.limitations.length) {
      const box = document.createElement("div");
      box.className = "workbench-run-notes";
      box.textContent = `平台限制说明：${preview.limitations.join("；")}`;
      host.appendChild(box);
    }
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
    ratioSelect.disabled = true;
    const ratioOption = document.createElement("option");
    ratioOption.value = storyboard.overrides?.ratio || "";
    ratioOption.textContent = "平台比例能力未核实";
    ratioSelect.appendChild(ratioOption);
    overrideBox.appendChild(field("比例", ratioSelect));

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
      await refresh();
      if (!result.added) return toast("该素材已经引用过了");
      // 把光标放到 token 之后，继续输入更顺手
      const node = document.querySelector(`[data-focus-key="sb-prompt:${storyboardId}"]`);
      if (node && Number.isInteger(result.caret)) {
        node.focus();
        node.setSelectionRange(result.caret, result.caret);
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
        state.mention = { storyboardId: target, prompt: null, caret: null, search: "" };
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

    $("workbenchAccountSelect")?.addEventListener("change", (event) => {
      state.selectedAccountId = event.target.value;
      renderAccounts();
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
      if (confirm) confirm.disabled = true;
      try {
        const created = await api.task.enqueue(projectId(), state.run.storyboardId, state.selectedAccountId);
        closeModal("workbenchRunModal");
        await refresh();
        toast(`已入队第 ${created.attempt.attempt} 次尝试，开始提交`);
        await api.task.execute(projectId(), created.attempt.id);
        await refresh();
      } catch (error) {
        toast(`提交失败：${error.message}`, "error");
      } finally {
        if (confirm) confirm.disabled = false;
      }
    });

    $("workbenchAccountNote")?.addEventListener("click", async (event) => {
      if (!event.target.closest('[data-act="clear-block"]')) return;
      try {
        await api.account.clearBlock(state.selectedAccountId);
        await refresh();
        toast("已解除账号暂停");
      } catch (error) {
        toast(`解除失败：${error.message}`, "error");
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
        } else if (button.dataset.act === "retry") {
          await api.task.retry(projectId(), attemptId);
          toast("已创建新的尝试记录，历史保留");
        } else if (button.dataset.act === "download") {
          const result = await api.task.download(projectId(), attemptId);
          toast(result.ok ? `已下载：${result.filePath}` : `下载失败：${result.error}`, result.ok ? "info" : "error");
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
      if (act !== "override-model" && act !== "override-duration") return;
      const patch = act === "override-model"
        ? { model: event.target.value }
        : { duration: event.target.value };
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
        if (act === "run") {
          if (!state.selectedAccountId) return toast("请先选择执行账号", "error");
          const preview = await api.task.preview(projectId(), storyboardId, state.selectedAccountId);
          state.run = { storyboardId, attemptId: "" };
          runPreview($("workbenchRunPreview"), preview);
          const confirm = $("workbenchRunConfirm");
          if (confirm) confirm.disabled = !preview.valid;
          openModal("workbenchRunModal");
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindEvents);
  } else {
    bindEvents();
  }
})();