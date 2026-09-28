/**
 * 视频创作工作台 · 单提示词编辑器
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
    // 账号列表加载状态：刷新按钮期间显示 loading；读取失败保留旧列表并显示具体错误
    accountsLoading: false,
    accountsError: null,
    tasks: [],
    taskFilter: "all",
    taskSearch: "",
    taskVisibleLimit: 40,
    queue: null,
    // 执行账号可多选：一次为每个勾选账号各建一条尝试
    selectedAccountIds: [],
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
    // 草稿三态：saved（已保存）/ saving（保存中）/ dirty（存在未保存改动）
    draftState: "saved",
    // 分集列表的批量选中集合（不落盘，仅本次会话）
    episodeSelection: new Set(),
    // 账号勾选持久化的归属项目：切换项目时从该项目自己的 ui 重新载入
    accountsOwner: "",
    mention: { storyboardId: "", prompt: "", caret: 0, search: "" },
    impact: { assetIds: [] },
    thumbCache: new Map(),
    // 下载实时进度（attemptId → {received,total,speed,remaining,phase}）与来源解析缓存
    downloadProgress: new Map(),
    sourceCache: new Map(),
    // 版本信息：主窗口左下角徽标与「关于/更新日志」共用（启动时单独拉取一次）
    appVersion: null,
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

  /**
   * 通用确认弹窗（Electron 渲染层没有可用的原生 confirm）。
   * 返回 "ok" | "alt" | "cancel"：三按钮版本用于「保存并切换 / 丢弃改动 / 取消」。
   * options.extra 可放一段自定义说明节点（例如将被一并删除的分集清单）。
   */
  function confirmAction(options = {}) {
    const modal = $("workbenchConfirmModal");
    if (!modal) return Promise.resolve("ok");
    const icon = $("workbenchConfirmIcon");
    $("workbenchConfirmTitle").textContent = options.title || "确认操作";
    $("workbenchConfirmMessage").textContent = options.message || "";
    if (icon) icon.textContent = options.danger === false ? "i" : "!";
    const extra = $("workbenchConfirmExtra");
    if (extra) {
      extra.replaceChildren();
      if (options.extra) extra.appendChild(options.extra);
      extra.hidden = !options.extra;
    }
    const ok = $("workbenchConfirmOk");
    ok.textContent = options.okLabel || "确认";
    ok.className = options.danger === false ? "primary-action" : "danger-action";
    const alt = $("workbenchConfirmAlt");
    alt.hidden = !options.altLabel;
    alt.textContent = options.altLabel || "";
    return new Promise((resolve) => {
      const finish = (value) => {
        ok.removeEventListener("click", onOk);
        alt.removeEventListener("click", onAlt);
        modal.removeEventListener("click", onClose, true);
        closeModal("workbenchConfirmModal");
        resolve(value);
      };
      const onOk = () => finish("ok");
      const onAlt = () => finish("alt");
      const onClose = (event) => {
        if (event.target === modal || event.target.closest("[data-close]")) finish("cancel");
      };
      ok.addEventListener("click", onOk);
      alt.addEventListener("click", onAlt);
      modal.addEventListener("click", onClose, true);
      openModal("workbenchConfirmModal");
      ok.focus();
    });
  }

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
  let creationLibrary;
  let refreshVersion = 0;
  let editorFingerprint = "";
  async function refresh(options = {}) {
    const version = ++refreshVersion;
    let tasksOnly = false;
    if (!options.silent) {
      try {
        const snapshot = await api.snapshot();
        if (version !== refreshVersion) return;
        const fingerprint = JSON.stringify([snapshot.storage, snapshot.index, snapshot.project, snapshot.assets,
          snapshot.capabilities, snapshot.capabilityView, snapshot.ratioOptions, snapshot.limits, snapshot.appVersion]);
        tasksOnly = options.tasksOnly === true && fingerprint === editorFingerprint;
        editorFingerprint = fingerprint;
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
          accountsError: snapshot.accountsError || null,
          tasks: snapshot.tasks || [],
          statusLabels: snapshot.statusLabels || {},
          downloadLabels: snapshot.downloadLabels || {},
          queue: snapshot.queue || null,
          appVersion: snapshot.appVersion || null,
        });
        applyVersion();
      } catch (error) {
        toast(`读取工作台数据失败：${error.message}`, "error");
        return;
      }
    }
    if (tasksOnly) {
      const focus = captureFocus();
      renderAccounts();
      renderTasks();
      renderHint();
      restoreFocus(focus);
    } else {
      render();
    }
    creationLibrary?.render();
    return true;
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
    renderEpisodes();
    renderAssets();
    // 先把栏宽/折叠状态应用回来，再渲染内容（避免首帧按默认宽度闪一下）
    applyLayout();
    // 账号先渲染：首次进入会默认勾选第一个账号，主按钮的可用性依赖它
    renderAccounts();
    renderParams();
    renderCompose();
    renderTasks();
    renderHint();
    restoreDraftBackup();
    restoreFocus(focus);
  }

  /** 草稿状态文案：保存中 / 存在未保存改动 / 已自动保存 */
  function draftText() {
    if (state.draftState === "saving") return "草稿保存中…";
    if (state.draftState === "dirty") return "存在未保存改动（松开输入 0.6 秒自动保存，Ctrl+S 立即保存）";
    return state.lastSaved ? `草稿已保存 ${state.lastSaved}` : "编辑内容会自动保存";
  }

  function renderHint() {
    const hint = $("workbenchHint");
    if (!hint) return;
    hint.textContent = draftText();
    hint.classList.toggle("is-dirty", state.draftState !== "saved");
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
    const episodes = $("workbenchEpisodeSelect");
    if (!select) return;
    const projects = state.index.projects || [];
    const current = state.project;
    const rootId = current?.parentId || current?.id || "";
    const root = projects.find(p => p.id === rootId);
    select.replaceChildren();
    const roots = projects.filter(p => !p.parentId || !projects.some(parent => parent.id === p.parentId));
    for (const project of roots) select.add(new Option(project.name, project.id));
    if (!roots.length) select.add(new Option("（暂无项目，请先新建）", ""));
    select.value = rootId;
    if (episodes) {
      episodes.replaceChildren();
      episodes.add(new Option("公共素材 / 项目工作区", rootId));
      // 下拉顺序与「分集列表」保持一致（列表里上移下移后，这里同步变化）
      for (const child of episodesOf(rootId)) episodes.add(new Option(child.name, child.id));
      episodes.value = current?.id || rootId;
      episodes.disabled = !current || Boolean(state.compose.busy);
    }
    const label = $("workbenchAssetLocation");
    if (label) label.textContent = current ? (root?.name || current.name) + " / " + (current.parentId ? current.name : "公共素材") : "请先创建项目";
  }

  // ── 分集列表 / 批量（编辑框仍只编辑当前分集；顺序本地记忆） ──
  const EPISODE_ORDER_KEY = "dbm.workbench.episodeOrder.v1";

  function readEpisodeOrder(rootId) {
    try {
      const map = JSON.parse(localStorage.getItem(EPISODE_ORDER_KEY) || "{}") || {};
      return Array.isArray(map[rootId]) ? map[rootId] : [];
    } catch {
      return [];
    }
  }

  function writeEpisodeOrder(rootId, ids) {
    try {
      const map = JSON.parse(localStorage.getItem(EPISODE_ORDER_KEY) || "{}") || {};
      map[rootId] = ids;
      localStorage.setItem(EPISODE_ORDER_KEY, JSON.stringify(map));
    } catch {}
  }

  /** 分集顺序：本地记忆优先，其余按名称数字序，保证新建分集出现在末尾 */
  function episodesOf(rootId) {
    if (!rootId) return [];
    const children = (state.index.projects || []).filter((item) => item.parentId === rootId);
    const rank = new Map(readEpisodeOrder(rootId).map((id, index) => [id, index]));
    const tail = Number.MAX_SAFE_INTEGER;
    return children.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : tail;
      const rb = rank.has(b.id) ? rank.get(b.id) : tail;
      if (ra !== rb) return ra - rb;
      return String(a.name).localeCompare(String(b.name), "zh-CN", { numeric: true });
    });
  }

  const currentRootId = () => state.project?.parentId || state.project?.id || "";

  function renderEpisodes() {
    const host = $("workbenchEpisodeList");
    if (!host) return;
    const current = state.project;
    const rootId = currentRootId();
    const episodes = rootId ? episodesOf(rootId) : [];
    if ($("workbenchEpisodeSummary")) $("workbenchEpisodeSummary").textContent = `分集列表 / 批量（${episodes.length}）`;
    // 选中集合按现存分集收敛，避免删除后残留脏选中
    const alive = new Set(episodes.map((item) => item.id));
    state.episodeSelection = new Set([...state.episodeSelection].filter((id) => alive.has(id)));
    const picked = state.episodeSelection;
    host.replaceChildren();
    if (!episodes.length) host.appendChild(emptyDiv("当前大项目下还没有分集，点上方「新建分集」开始。"));
    episodes.forEach((episode, index) => {
      const row = document.createElement("div");
      row.className = `workbench-episode${episode.id === current?.id ? " is-current" : ""}`;
      row.dataset.projectId = episode.id;

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = picked.has(episode.id);
      box.dataset.act = "episode-select";
      box.title = "选中后可批量复制/删除";
      row.appendChild(box);

      const seq = document.createElement("span");
      seq.className = "workbench-episode-index";
      seq.textContent = String(index + 1);
      row.appendChild(seq);

      const main = document.createElement("div");
      main.className = "workbench-episode-main";
      const title = document.createElement("strong");
      title.textContent = episode.name || "未命名分集";
      main.appendChild(title);
      const preview = document.createElement("span");
      preview.className = "workbench-episode-preview";
      preview.textContent = episode.promptPreview || "（暂无提示词）";
      preview.title = episode.promptPreview || "";
      main.appendChild(preview);
      const meta = document.createElement("em");
      meta.textContent = `素材 ${episode.refCount || 0} 张 · 更新 ${formatTime(episode.updatedAt) || "—"}`;
      main.appendChild(meta);
      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "workbench-episode-actions-btns";
      for (const [act, label, hint] of [
        ["open", "编辑", "载入这条分集到上方编辑框"],
        ["up", "↑", "上移一位"],
        ["down", "↓", "下移一位"],
        ["copy", "复制", "复制这条分集（含提示词、参数与素材）"],
        ["remove", "删除", "删除这条分集（含素材与任务记录）"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "text-button";
        button.dataset.act = act;
        button.textContent = label;
        button.title = hint;
        button.disabled = Boolean(state.compose.busy);
        actions.appendChild(button);
      }
      row.appendChild(actions);
      host.appendChild(row);
    });

    const all = $("workbenchEpisodeAll");
    if (all) {
      all.checked = episodes.length > 0 && picked.size === episodes.length;
      all.disabled = Boolean(state.compose.busy) || !episodes.length;
    }
    if ($("workbenchEpisodeSelection")) {
      $("workbenchEpisodeSelection").textContent = picked.size ? `已选 ${picked.size} 条` : "未选择分集";
    }
    const single = picked.size === 1;
    if ($("workbenchEpisodeUp")) $("workbenchEpisodeUp").disabled = Boolean(state.compose.busy) || !single;
    if ($("workbenchEpisodeDown")) $("workbenchEpisodeDown").disabled = Boolean(state.compose.busy) || !single;
    if ($("workbenchEpisodeCopy")) {
      $("workbenchEpisodeCopy").disabled = Boolean(state.compose.busy) || !picked.size;
      $("workbenchEpisodeCopy").textContent = picked.size > 1 ? `批量复制（${picked.size}）` : "批量复制";
    }
    if ($("workbenchEpisodeRemove")) {
      $("workbenchEpisodeRemove").disabled = Boolean(state.compose.busy) || !picked.size;
      $("workbenchEpisodeRemove").textContent = picked.size > 1 ? `批量删除（${picked.size}）` : "批量删除";
    }
  }

  /** 上移/下移：把选中的这一条在列表里移动一位，并本地记忆顺序 */
  function moveEpisode(id, delta) {
    const rootId = currentRootId();
    const ids = episodesOf(rootId).map((item) => item.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) {
      toast(delta < 0 ? "已经在最前面了" : "已经在最后面了");
      return;
    }
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    writeEpisodeOrder(rootId, ids);
    renderEpisodes();
    renderProjects();
    toast("已调整分集顺序（重启后保持）");
  }

  async function removeEpisodes(ids) {
    const wanted = new Set(ids);
    const episodes = (state.index.projects || []).filter((item) => wanted.has(item.id));
    if (!episodes.length) return;
    const extra = document.createElement("div");
    extra.className = "workbench-confirm-list";
    for (const episode of episodes) {
      const line = document.createElement("span");
      line.textContent = `${episode.name}（素材 ${episode.refCount || 0} 张）`;
      extra.appendChild(line);
    }
    const choice = await confirmAction({
      title: `删除 ${episodes.length} 条分集？`,
      message: "删除会一并移除这些分集的素材、任务记录与已下载文件，无法恢复。其中若有未结束的任务或未完成的下载，会拒绝删除并提示先处理。",
      okLabel: `确认删除（${episodes.length}）`,
      extra,
    });
    if (choice !== "ok") return;
    const failed = [];
    for (const episode of episodes) {
      try {
        const result = await api.project.remove(episode.id);
        if (result?.cleanupFailed?.length) failed.push(`${episode.name}：目录未能删净（文件被占用）`);
      } catch (error) {
        failed.push(`${episode.name}：${error.message}`);
      }
    }
    const done = episodes.length - failed.length;
    if (done) toast(`已删除 ${done} 条分集`, "ok");
    for (const line of failed) toast(`未删除 ${line}`, "error");
    state.episodeSelection = new Set();
    state.thumbCache.clear();
    await refresh();
  }

  async function duplicateEpisodes(ids) {
    const list = ids.slice();
    if (!list.length) return;
    const stayId = projectId();
    state.compose.busy = "duplicate";
    renderCompose();
    const created = [];
    try {
      for (const id of list) {
        const episode = (state.index.projects || []).find((item) => item.id === id);
        try {
          created.push(await api.project.duplicate(id));
        } catch (error) {
          toast(`复制「${episode?.name || id}」失败：${error.message}`, "error");
        }
      }
      if (created.length) {
        toast(`已复制 ${created.length} 条分集（含提示词、参数与素材）`, "ok");
        for (const item of created) {
          if (item.droppedRefs?.length) {
            toast(`${item.name}：${item.droppedRefs.join("、")} 素材复制失败，已同步移除该引用`, "error");
          }
        }
      }
      state.episodeSelection = new Set();
      state.thumbCache.clear();
      // 复制会把「当前项目」切到副本上，这里拉回用户原本所在的分集，不打断编辑
      if (stayId && (state.index.projects || []).some((item) => item.id === stayId)) await api.project.open(stayId);
      await refresh();
    } finally {
      state.compose.busy = "";
      renderCompose();
    }
  }

  async function removeCurrentProject() {
    const current = state.project;
    if (!current) return;
    if (current.parentId) return removeEpisodes([current.id]);
    const children = (state.index.projects || []).filter((item) => item.parentId === current.id);
    const extra = document.createElement("div");
    extra.className = "workbench-confirm-list";
    for (const child of children) {
      const line = document.createElement("span");
      line.textContent = `${child.name}（素材 ${child.refCount || 0} 张）`;
      extra.appendChild(line);
    }
    const choice = await confirmAction({
      title: `删除大项目「${current.name}」？`,
      message: children.length
        ? `该项目下还有 ${children.length} 条分集，点确认后会连同分集、素材、任务记录与已下载文件一起删除，无法恢复。有未结束任务或未完成下载时会拒绝删除。`
        : "删除会一并移除该项目的素材、任务记录与已下载文件，无法恢复。",
      okLabel: children.length ? `连同 ${children.length} 条分集一起删除` : "确认删除",
      extra: children.length ? extra : null,
    });
    if (choice !== "ok") return;
    try {
      const result = await api.project.remove(current.id, { cascade: children.length > 0 });
      toast(`已删除项目${result?.removed?.length > 1 ? `及其 ${result.removed.length - 1} 条分集` : ""}`, "ok");
      if (result?.cleanupFailed?.length) {
        toast(`${result.cleanupFailed.length} 个目录未能删净（文件被占用），可在数据目录手工清理`, "error");
      }
      state.episodeSelection = new Set();
      state.thumbCache.clear();
      await refresh();
    } catch (error) {
      toast(`删除项目失败：${error.message}`, "error");
    }
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
        .map((u) => `${u.name || "历史草稿"} 里的 ${u.token}`)
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
    source.textContent = "参数与提示词自动保存，重新打开可继续创作";
    host.appendChild(source);

    // 增强时长的可用性说明（不静默降级）
    const enhancedNote = document.createElement("span");
    enhancedNote.className = "workbench-unknown";
    if (enhanced) {
      const usable = effective.model === enhanced.requiresModel;
      enhancedNote.textContent = usable
        ? `${enhanced.from}—${enhanced.to} 秒为增强时长，实际成片时长以平台结果为准`
        : `${enhanced.from}—${enhanced.to} 秒增强仅 ${labelOfModel.get(enhanced.requiresModel) || enhanced.requiresModel} 可用，当前模型不支持（不会自动降级）`;
    } else {
      enhancedNote.textContent = "时长增强能力未在能力表中声明，只显示已核实档位";
    }
    if (enhanced && Number(effective.duration) >= enhanced.from) host.appendChild(enhancedNote);

    const onChange = async () => {
      if (!storyboard) return;
      try {
        const ownerId = projectId();
        const patch = { overrides: { model: model.value, duration: duration.value, ratio: ratio.value } };
        await writeDraft(ownerId, () => api.storyboard.update(ownerId, storyboard.id, patch));
        state.lastSaved = formatTime(new Date());
        await refresh();
        setMainStatus("参数已保存", "ok");
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
    prompt.dataset.focusKey = storyboard ? `sb-prompt:${storyboard.id}` : "";
    prompt.readOnly = Boolean(state.compose.busy);
    for (const id of [
      "workbenchProjectSelect",
      "workbenchEpisodeSelect",
      "workbenchEpisodeNew",
      "workbenchProjectNew",
      "workbenchProjectRename",
      "workbenchEpisodeDelete",
      "workbenchProjectDelete",
    ]) {
      if ($(id)) $(id).disabled = Boolean(state.compose.busy);
    }

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
      meta.textContent = `已绑定 ${refs.length} 张 · ${draftText()}`;
      meta.classList.toggle("is-dirty", state.draftState !== "saved");
      refsHost.appendChild(meta);
    if (refs.length) {
        const hint = document.createElement("span");
        hint.className = "workbench-refs-hint";
        hint.textContent = "引用图片按编号发送，请保持提示词中的 @图N 与参考图对应。";
        refsHost.appendChild(hint);
      }
    }

    const effective = effectiveOf(storyboard);
    const accountCount = (state.selectedAccountIds || []).length;
    const busy = state.compose.busy;
    const reasons = [];
    if (!storyboard) reasons.push("请先新建项目");
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
      const on = state.project?.settings?.autoDownload !== false;
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
    reactivatePage: "重新激活隐藏页面",
    webviewGone: "页面被卸载，等待恢复",
    panelStage: "面板加载阶段",
    enterVideoMode: "进入视频生成模式",
    waitComposer: "等待面板控件齐全",
    attachmentsPre: "读取输入区状态",
    clearAttachments: "清空残留参考图",
    setPrompt: "写入提示词",
    setPromptAfterUpload: "上传后重新写入提示词",
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

  /**
   * 「刷新账号」：重新从应用数据目录读取最新账号列表。
   * - 成功：用新列表渲染，已勾选状态由 renderAccounts 按「id 仍存在则保留」规则处理；
   * - 失败（IPC 异常或读文件/JSON 错误）：保留旧列表，错误条显示具体原因并给「重试」。
   */
  async function refreshAccounts() {
    if (state.accountsLoading) return;
    state.accountsLoading = true;
    state.accountsError = null;
    renderAccounts();
    try {
      const result = await api.account.status();
      if (result && result.error) {
        // 主进程读到了错误（ENOENT/JSON 损坏等），保留当前列表不清空
        state.accountsError = result.error;
      } else {
        state.accounts = (result && result.accounts) || [];
        state.accountsError = null;
      }
    } catch (error) {
      state.accountsError = { message: error?.message || String(error), at: "", dir: "" };
    } finally {
      state.accountsLoading = false;
      renderAccounts();
      // 勾选数量可能变化（新增账号不会影响，删除账号会剔除勾选），同步主按钮文案
      renderCompose();
    }
  }

  function renderAccounts() {
    const host = $("workbenchAccountPicks");
    const note = $("workbenchAccountNote");
    const refreshButton = $("workbenchAccountsRefresh");
    if (!host) return;
    const accounts = state.accounts || [];
    // 勾选配置随项目保存（project.ui.selectedAccountIds）：切换项目/重启后恢复用户自己的勾选。
    // 旧实现只存在渲染进程内存里，重启后回到「默认勾选第一个」，用户「清空」的意图也不被记住。
    const owner = projectId();
    if (state.accountsOwner !== owner) {
      state.accountsOwner = owner;
      const saved = state.project?.ui?.selectedAccountIds;
      state.selectedAccountIds = Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
      state.accountsTouched = Array.isArray(saved);
    }
    host.innerHTML = "";

    if (refreshButton) {
      refreshButton.disabled = state.accountsLoading;
      refreshButton.textContent = state.accountsLoading ? "读取中…" : "刷新账号";
    }

    // 读取中：列表区给明确提示（首次加载时 accounts 可能为空，不能误显示空态）
    if (state.accountsLoading && !accounts.length) {
      host.appendChild(emptyDiv("账号读取中…"));
      if (note) note.textContent = "正在从应用数据目录读取账号列表。";
      return;
    }

    // 读取失败：错误条显示具体原因与「重试」；已有旧列表时旧列表仍可见
    if (state.accountsError) {
      const banner = document.createElement("div");
      banner.className = "workbench-account-error";
      const msg = document.createElement("span");
      msg.textContent = `账号读取失败：${state.accountsError.message}`;
      banner.appendChild(msg);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-button";
      retry.dataset.act = "accounts-retry";
      retry.textContent = "重试";
      banner.appendChild(retry);
      host.appendChild(banner);
    }

    if (!accounts.length) {
      // 只有非加载、非错误、且确实为 0 个时才显示空态
      if (!state.accountsError) {
        host.appendChild(emptyDiv("（没有可执行账号）"));
        if (note) note.textContent = "未读到任何账号。账号来自本机既有账号列表，工作台不会新建或修改账号。";
      }
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
      : `已选 ${picked.size} 个账号 · 登录与额度未知。单条创作将生成 ${picked.size} 份，分别消耗账号额度。`;
    line.title = "当前提示词将在每个所选账号各生成一次，分别消耗对应账号额度。";
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

  /** 把账号勾选写回项目 ui（失败不阻塞交互，只提示一次） */
  function persistAccountSelection() {
    const ownerId = projectId();
    if (!ownerId) return;
    api.ui
      .set(ownerId, { selectedAccountIds: state.selectedAccountIds.slice() })
      .catch((error) => toast(`账号勾选未能保存（重启后会恢复默认）：${error.message}`, "error"));
  }

  const taskCardFingerprints = new WeakMap();
  let renderedTaskProject = "";
  function needsAttention(record) {
    return ["failed", "manual", "unconfirmed"].includes(record.status) || record.download?.status === "failed";
  }

  function renderTasks() {
    const host = $("workbenchTaskList");
    if (!host) return;
    if (renderedTaskProject !== projectId()) {
      renderedTaskProject = projectId();
      state.taskVisibleLimit = 40;
      host.replaceChildren();
    }
    const tasks = state.tasks || [];
    const active = tasks.filter((task) => isActiveStatus(task.status)).length;
    const attention = tasks.filter(needsAttention).length;
    const succeeded = tasks.filter((task) => task.status === "succeeded").length;
    if ($("workbenchTaskCount")) $("workbenchTaskCount").textContent = String(active);
    if ($("workbenchTaskSummary")) $("workbenchTaskSummary").textContent =
      `${state.queue?.paused ? "队列已暂停 · " : ""}${active} 进行中 · ${attention} 需处理 · ${succeeded} 已生成`;
    const names = new Map((state.accounts || []).map((account) => [account.id, account.name]));
    const query = state.taskSearch.trim().toLocaleLowerCase();
    const filtered = tasks.filter((record) => {
      if (state.taskFilter === "active" && !isActiveStatus(record.status)) return false;
      if (state.taskFilter === "attention" && !needsAttention(record)) return false;
      if (state.taskFilter === "succeeded" && record.status !== "succeeded") return false;
      return !query || `${record.storyboardName || ""} ${names.get(record.accountId) || record.accountId}`.toLocaleLowerCase().includes(query);
    });
    const visible = filtered.slice(0, state.taskVisibleLimit);
    const ids = new Set(visible.map((record) => record.id));
    for (const child of [...host.children]) {
      if (!ids.has(child.dataset.attemptId)) child.remove();
    }
    const existing = new Map([...host.children].map((node) => [node.dataset.attemptId, node]));
    for (const [index, record] of visible.entries()) {
      let card = existing.get(record.id);
      const fingerprint = JSON.stringify([record, names.get(record.accountId), state.sourceCache.get(record.id), state.statusLabels, state.downloadLabels]);
      if (!card || taskCardFingerprints.get(card) !== fingerprint) {
        const old = card;
        const openDetails = new Set(old ? [...old.querySelectorAll("details[open]")].map((node) => node.className) : []);
        const focusedAction = old?.contains(document.activeElement) ? document.activeElement.dataset.act : "";
        card = taskCard(record);
        for (const detail of card.querySelectorAll("details")) detail.open = openDetails.has(detail.className);
        taskCardFingerprints.set(card, fingerprint);
        if (old) old.replaceWith(card);
        if (focusedAction) [...card.querySelectorAll("button[data-act]")].find((node) => node.dataset.act === focusedAction)?.focus({ preventScroll: true });
      }
      if (host.children[index] !== card) host.insertBefore(card, host.children[index] || null);
    }
    if (!visible.length) host.appendChild(emptyDiv(tasks.length ? "没有匹配的任务，试试其他筛选条件。" : "还没有生成任务。填写提示词并选择账号后即可开始。"));
    for (const button of $("workbenchTaskFilters")?.querySelectorAll("button[data-filter]") || []) {
      button.setAttribute("aria-pressed", String(button.dataset.filter === state.taskFilter));
    }
    if ($("workbenchTaskRange")) $("workbenchTaskRange").textContent = `显示 ${visible.length} / ${filtered.length} 条`;
    if ($("workbenchTaskMore")) $("workbenchTaskMore").hidden = visible.length >= filtered.length;
    if ($("workbenchQueuePause")) $("workbenchQueuePause").disabled = state.queue?.paused === true;
    if ($("workbenchQueueResume")) $("workbenchQueueResume").disabled = state.queue?.paused !== true;
  }

  function taskCard(record) {
    const card = document.createElement("div");
    card.className = "workbench-task";
    card.dataset.attemptId = record.id;
    if (isActiveStatus(record.status)) card.classList.add("workbench-task-active");

    const head = document.createElement("div");
    head.className = "workbench-task-head";
    const title = document.createElement("strong");
    title.textContent = `${record.storyboardName || "视频创作"} · 尝试 ${record.attempt}`;
    head.appendChild(title);
    const chip = document.createElement("span");
    chip.className = `workbench-status workbench-status-${record.status}`;
    chip.textContent = record.interruption?.stopped ? (record.interruption.platformMayContinue ? "本地跟踪已停止" : "已中断提交") : statusLabel(record.status);
    head.appendChild(chip);
    card.appendChild(head);

    if (!record.interruption?.stopped && ["pending", "submitting", "queued", "generating", "unconfirmed"].includes(record.status)) {
      const control = document.createElement("div");
      control.className = "workbench-stop-control";
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "workbench-stop-button";
      stop.dataset.act = "interrupt";
      stop.textContent = ["pending", "submitting"].includes(record.status) ? "■ 中断当前提交" : "■ 停止跟踪并释放账号";
      const hint = document.createElement("small");
      hint.textContent = "停止后可用该账号提交新任务。已发送到豆包的任务可能仍在生成。";
      control.append(stop, hint);
      card.appendChild(control);
    }

    const feedback = document.createElement("section");
    feedback.className = "workbench-platform-feedback";
    const guidance = document.createElement("strong");
    guidance.textContent = ({
      pending: "已加入队列，尚未发送；无需再次点击生成。",
      submitting: "正在提交，尚未确认豆包是否受理；请勿重复提交。",
      queued: "豆包已受理，正在等待结果；不代表已生成成功，请勿重复提交。",
      generating: "豆包正在生成，请等待结果，无需再次点击。",
      succeeded: "已检测到生成的视频，生成成功；下载失败也无需重新生成。",
      failed: "本次任务失败，请查看原因，处理后可使用「重试」。",
      unconfirmed: "暂未确认结果，不代表失败；请先核实豆包页面，避免重复扣费。",
      manual: "需要人工核实或处理；请先查看豆包回复，不要盲目重复提交。",
      canceled: "本次任务已取消。",
    })[record.status] || "正在等待任务状态。";
    if (record.interruption?.stopped) guidance.textContent = record.interruption.platformMayContinue ? "已停止本地跟踪，可用该账号提交新任务。豆包可能仍在生成或扣费，也可恢复查询原任务。" : "已中断提交，没有向豆包发送本次请求。";
    if (record.autoRetry?.nextAt && !record.autoRetry.stopped) guidance.textContent = `豆包未受理，已安排自动重提（${record.autoRetry.count}/${record.autoRetry.max}）。可点击停止重试。`;
    feedback.appendChild(guidance);
    const replyTitle = document.createElement("div");
    replyTitle.className = "workbench-reply-title";
    replyTitle.textContent = `豆包回复${record.platformReply?.at ? ` · ${formatTime(record.platformReply.at)}` : ""}`;
    feedback.appendChild(replyTitle);
    const reply = document.createElement("div");
    reply.className = "workbench-reply-text";
    reply.textContent = record.platformReply?.text || record.driver?.acceptanceEvidence?.excerpt || record.driver?.evidence?.excerpt || "暂未读取到本次请求的豆包回复，请以任务状态为准。";
    feedback.appendChild(reply);
    card.appendChild(feedback);

    const meta = document.createElement("div");
    meta.className = "workbench-task-meta";
    const pieces = [
      `账号 ${accountName(record.accountId)}`,
      record.submittedAt ? `提交 ${formatTime(record.submittedAt)}` : "尚未提交",
      `最近更新 ${formatTime(record.updatedAt)}`,
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
    const idsSummary = document.createElement("summary");
    idsSummary.textContent = "任务标识与模型";
    detailBits.appendChild(idsSummary);
    for (const line of [`账号 ${record.accountId}`, `尝试 ${record.id}`,
      `平台任务 ${record.platformTaskId || "等待平台返回"}`, `模型 ${record.params?.model || "未指定"}`]) {
      const row = document.createElement("div");
      row.textContent = line;
      detailBits.appendChild(row);
    }
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
    if ((record.driver?.needsUser && !record.autoRetry?.nextAt) || record.autoRetry?.stopped) {
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
      // 进行中与失败默认展开：失败卡片直接呈现「卡在第几步、哪一步没成功」的完整报错
      if (driver.outcome === "running" || driver.outcome === "failed" || steps.some((step) => step.ok === false)) {
        box.open = true;
      }
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
    if (record.interruption?.stopped && record.interruption.platformMayContinue) buttons.push(["resume-monitoring", "恢复查询"]);
    else if (record.submittedAt && ["manual", "unconfirmed"].includes(record.status)) buttons.push(["resume-monitoring", "重新查询豆包"]);
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
    chip.textContent = dl.errorCode === "QUALITY_SIZE_LOW" || dl.errorCode === "QUALITY_PROBE_FAILED" ? "下载：画质待核验" : `下载：${downloadLabel(dl.status)}`;
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
    if (!storyboard) return setMainStatus("请先新建或选择项目", "warn");
    const accountIds = [...new Set((state.selectedAccountIds || []).slice())];
    if (!accountIds.length) return setMainStatus("请先在右侧勾选执行账号", "warn");

    // 批量生成必须二次确认：任务数 = 账号数，每个账号各消耗一次额度，提交后无法撤回
    if (accountIds.length > 1) {
      const choice = await confirmAction({
        title: `确认多账号生成（${accountIds.length} 条任务）？`,
        message: `将在 ${accountIds.length} 个账号各生成一次，共创建 ${accountIds.length} 条任务，分别消耗对应账号额度。提交后平台侧可能已计费，不能撤回。`,
        okLabel: `确认生成（${accountIds.length} 条）`,
      });
      if (choice !== "ok") return setMainStatus("已取消本次批量生成", "warn");
    }

    state.compose.busy = "checking";
    renderCompose();
    try { await flushComposeDraft(); } catch (error) {
      state.compose.busy = "";
      renderCompose();
      return setMainStatus(`保存提示词失败，未提交：${error.message}`, "error");
    }
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
    if (state.queue?.paused) {
      state.compose.busy = "";
      renderCompose();
      return setMainStatus(`已加入队列 ${created.length} 条任务。队列已暂停，点击「恢复队列」后开始。`);
    }
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
        `${lastLine}；${failures.length} 条需核实或处理（不代表生成失败）：${failures
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
    if (!storyboard) return setMainStatus("请先新建或选择项目", "warn");
    const accountIds = [...new Set((state.selectedAccountIds || []).slice())];
    if (!accountIds.length) return setMainStatus("请先在右侧勾选执行账号", "warn");

    state.compose.busy = "prechecking";
    renderCompose();
    try { await flushComposeDraft(); } catch (error) {
      state.compose.busy = "";
      renderCompose();
      return setMainStatus(`保存提示词失败，未校验：${error.message}`, "error");
    }
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
      // 兜底草稿随输入落 localStorage：即使 600ms 内关闭窗口/异常退出也能恢复
      backupDraft(storyboard.id, node.value);
      state.draftState = "dirty";
      renderHint();
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

    // 快捷键：Ctrl+Enter 生成、Ctrl+S 立即保存（保存失败会明确提示，不静默）
    prompt?.addEventListener("keydown", (event) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl) return;
      if (event.key === "Enter") {
        event.preventDefault();
        $("workbenchGenerate")?.click();
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        void (async () => {
          try {
            await flushComposeDraft();
            toast("提示词已保存", "ok");
            await refresh();
          } catch (error) {
            toast(`保存失败：${error.message}`, "error");
          }
        })();
      }
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

    const runComposeAction = (action) => action().catch((error) => {
      state.compose.busy = "";
      renderCompose();
      setMainStatus(`操作中断：${error.message}，请查看任务状态后再继续。`, "error");
    });
    $("workbenchGenerate")?.addEventListener("click", () => runComposeAction(generateCurrent));
    $("workbenchPrecheck")?.addEventListener("click", () => runComposeAction(precheckCurrent));
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
    $("workbenchVersionLog")?.addEventListener("click", () => {
      renderChangelog();
      $("workbenchChangelogModal")?.classList.remove("hidden");
    });
  }

  // ── 三栏布局：拖拽分隔条 + 折叠状态本地保存 ────────────────
  const LAYOUT_KEY = "dbm.workbench.layout.v1";
  // 默认三栏比例：把更多宽度让给中间主编辑区（素材 264 / 任务 348），
  // 与 workbench.css 各断点的兜底值保持一致；拖拽后的宽度会覆盖它并本地记忆。
  const ASSETS_DEFAULT = 264;
  const TASKS_DEFAULT = 348;
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

  /** 应用（并记住）栏宽与折叠状态；默认 264 / 348（可拖拽、双击复位） */
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
    // 分集列表的展开状态与栏宽共用同一份本地记录，重启后保持一致
    const episodeWrap = $("workbenchEpisodeWrap");
    if (episodeWrap) {
      const open = layout.episodesOpen === true;
      if (episodeWrap.open !== open) episodeWrap.open = open;
    }
  }

  function bindSplitters() {
    const body = document.querySelector(".workbench-body");
    if (!body) return;
    for (const [id, side, min, max] of [
      ["workbenchSplitAssets", "left", 200, 520],
      ["workbenchSplitTasks", "right", 280, 640],
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
          side === "left"
            ? { assetsWidth: Math.round(computed[0] || ASSETS_DEFAULT) }
            : { tasksWidth: Math.round(computed[4] || TASKS_DEFAULT) }
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
      bar.addEventListener("dblclick", () =>
        applyLayout(side === "left" ? { assetsWidth: ASSETS_DEFAULT } : { tasksWidth: TASKS_DEFAULT })
      );
      bar.addEventListener("keydown", (event) => {
        // 键盘可达性：左右方向键微调 16px
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const layout = readLayout();
        const current = Number(side === "left" ? layout.assetsWidth : layout.tasksWidth) || (side === "left" ? ASSETS_DEFAULT : TASKS_DEFAULT);
        const delta = (event.key === "ArrowRight" ? 16 : -16) * (side === "left" ? 1 : -1);
        event.preventDefault();
        applyLayout(side === "left" ? { assetsWidth: Math.max(min, Math.min(max, current + delta)) } : { tasksWidth: Math.max(min, Math.min(max, current + delta)) });
      });
    }
  }

  function renderAssetsCollapse() {
    applyLayout({ assetsCollapsed: state.assetsCollapsed === true });
  }

  // ── 版本号与更新日志 ───────────────────────────────────────
  const escapeVersionText = (value) =>
    String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  /** 标题处版本徽标：固定展示 v主.次.补丁，悬停查看渠道/发布/Git/构建信息 */
  function applyVersion() {
    const brand = document.querySelector(".brand strong");
    if (brand && state.appVersion?.version) brand.textContent = `澜川Dola管理器 · v${state.appVersion.version}`;

    const info = state.appVersion;
    const badge = $("workbenchVersion");
    if (!badge) return;
    badge.textContent = info?.display || "v—";
    const facts = [];
    if (info?.channel) facts.push(`渠道：${info.channel}`);
    if (info?.releasedAt) facts.push(`发布：${info.releasedAt}`);
    if (info?.gitCommit) facts.push(`Git 提交：${info.gitCommit}`);
    if (info?.buildAt) facts.push(`构建时间：${info.buildAt}`);
    badge.title = info
      ? `当前版本 ${info.display}${facts.length ? `\n${facts.join("\n")}` : ""}`
      : "当前版本（语义化版本）";
  }

  /** 更新日志弹窗：当前版本更新摘要 + 构建信息 + 历史版本记录 */
  function renderChangelog() {
    const host = $("workbenchChangelogBody");
    if (!host) return;
    const info = state.appVersion;
    if (!info) {
      host.textContent = "版本信息不可用";
      return;
    }
    const listItems = (items) =>
      (items || []).map((text) => `<li>${escapeVersionText(text)}</li>`).join("");
    const meta = [
      `发布日期：${info.releasedAt || "—"}`,
      `渠道：${info.channel || "—"}`,
    ];
    if (info.gitCommit) meta.push(`Git 提交：${info.gitCommit}`);
    if (info.buildAt) meta.push(`构建时间：${info.buildAt}`);
    if (info.buildChannel) meta.push(`构建渠道：${info.buildChannel}`);
    const history = (info.history || [])
      .map(
        (entry) =>
          `<section class="workbench-changelog-entry">
             <h3>v${escapeVersionText(entry.version || "")}<em>${escapeVersionText(entry.date || "")}</em></h3>
             <ul>${listItems(entry.notes)}</ul>
           </section>`
      )
      .join("");
    host.innerHTML =
      `<section class="workbench-changelog-entry is-current">
         <h3>${escapeVersionText(info.display)}<em>当前版本</em></h3>
         <p class="workbench-changelog-meta">${meta.map(escapeVersionText).join(" · ")}</p>
         <ul>${listItems(info.notes)}</ul>
       </section>` + history;
  }

  // ── 草稿自动保存 ─────────────────────────────────────────
  // 兜底草稿：600ms 防抖窗口内关闭窗口/异常退出时，最后一次输入不会随进程消失。
  // 正常保存成功后会清掉；重启打开工作台时若发现比已保存内容新，会恢复并提示。
  const DRAFT_BACKUP_KEY = "dbm.workbench.draft.v1";
  let draftRestoreChecked = false;

  function backupDraft(storyboardId, value) {
    try {
      localStorage.setItem(
        DRAFT_BACKUP_KEY,
        JSON.stringify({ projectId: projectId(), storyboardId, value: String(value ?? ""), at: Date.now() })
      );
    } catch {}
  }

  function clearDraftBackup() {
    try {
      localStorage.removeItem(DRAFT_BACKUP_KEY);
    } catch {}
  }

  /** 启动/刷新时检查兜底草稿：只处理与当前项目、当前分集匹配且比已保存内容新的一份 */
  function restoreDraftBackup() {
    if (draftRestoreChecked) return;
    if (!state.project) return;
    draftRestoreChecked = true;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(DRAFT_BACKUP_KEY) || "null");
    } catch {
      saved = null;
    }
    if (!saved || !saved.storyboardId || saved.projectId !== projectId()) return;
    const storyboard = (state.project.storyboards || []).find((item) => item.id === saved.storyboardId);
    if (!storyboard || String(storyboard.prompt || "") === String(saved.value || "")) {
      clearDraftBackup();
      return;
    }
    state.pendingValues.set(`sb-prompt:${saved.storyboardId}`, String(saved.value || ""));
    state.draftState = "dirty";
    const node = $("workbenchMainPrompt");
    if (node && currentStoryboard()?.id === saved.storyboardId) node.value = String(saved.value || "");
    toast("已恢复上次未保存的提示词，正在自动保存…");
    scheduleUpdate(saved.storyboardId, { prompt: String(saved.value || "") }, { delay: 300 });
  }

  const draftWrites = new Map();
  function writeDraft(ownerId, operation) {
    const previous = draftWrites.get(ownerId) || Promise.resolve();
    const next = previous.then(operation, operation);
    draftWrites.set(ownerId, next);
    const cleanup = () => { if (draftWrites.get(ownerId) === next) draftWrites.delete(ownerId); };
    next.then(cleanup, cleanup);
    return next;
  }

  function cancelDraftTimer(storyboardId) {
    const key = `${storyboardId}:prompt`;
    const timer = state.saveTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    state.saveTimers.delete(key);
  }

  async function persistPrompt(ownerId, storyboardId, prompt) {
    const result = await writeDraft(ownerId, () => api.storyboard.update(ownerId, storyboardId, { prompt }));
    if (projectId() === ownerId && result.storyboard) {
      state.project = { ...state.project, storyboards: state.project.storyboards.map((draft) =>
        draft.id === storyboardId ? result.storyboard : draft) };
    }
    const key = `sb-prompt:${storyboardId}`;
    if (state.pendingValues.get(key) === prompt) state.pendingValues.delete(key);
    state.lastSaved = formatTime(new Date());
    state.draftState = "saved";
    renderHint();
    // 保存成功即撤销兜底草稿（只清属于本次保存的那一份）
    try {
      const backup = JSON.parse(localStorage.getItem(DRAFT_BACKUP_KEY) || "null");
      if (backup?.storyboardId === storyboardId && backup?.projectId === ownerId) clearDraftBackup();
    } catch {}
    if (result.droppedTokens?.length) toast(`提示词里已找不到 ${result.droppedTokens.join("、")}，对应引用已解除`, "error");
    return result;
  }

  async function flushComposeDraft() {
    const storyboard = currentStoryboard();
    if (!storyboard) return;
    const ownerId = projectId();
    cancelDraftTimer(storyboard.id);
    const value = $("workbenchMainPrompt")?.value ?? storyboard.prompt;
    state.draftState = "saving";
    renderHint();
    await persistPrompt(ownerId, storyboard.id, value);
  }

  /** 编辑框里是否存在尚未落盘的改动（含未到期的防抖定时器） */
  function composeDirty() {
    const storyboard = currentStoryboard();
    if (!storyboard) return false;
    if (state.saveTimers.has(`${storyboard.id}:prompt`)) return true;
    const node = $("workbenchMainPrompt");
    const pending = state.pendingValues.get(`sb-prompt:${storyboard.id}`);
    const live = node && node.dataset.sbId === storyboard.id ? String(node.value || "") : pending;
    const value = live === undefined ? String(storyboard.prompt || "") : live;
    return value !== String(storyboard.prompt || "");
  }

  /**
   * 切换项目/分集前的兜底：有未保存改动时先确认（保存并切换 / 丢弃改动 / 取消）。
   * 返回 true 表示可以继续切换。
   */
  async function confirmLeaveDraft() {
    if (!composeDirty()) {
      try {
        await flushComposeDraft();
      } catch {}
      return true;
    }
    const choice = await confirmAction({
      title: "当前分集有未保存的改动",
      message: "这条提示词还没写回草稿。直接切换会丢失刚输入的内容。",
      okLabel: "保存并切换",
      altLabel: "丢弃改动",
      danger: false,
    });
    if (choice === "cancel") return false;
    if (choice === "ok") {
      try {
        await flushComposeDraft();
      } catch (error) {
        toast(`保存失败，未切换：${error.message}`, "error");
        return false;
      }
      return true;
    }
    // 丢弃：只清掉还没落盘的本地值，服务端草稿保持上一次保存的内容
    const storyboard = currentStoryboard();
    if (storyboard) {
      cancelDraftTimer(storyboard.id);
      state.pendingValues.delete(`sb-prompt:${storyboard.id}`);
      const node = $("workbenchMainPrompt");
      if (node) node.value = String(storyboard.prompt || "");
    }
    clearDraftBackup();
    state.draftState = "saved";
    renderHint();
    renderCompose();
    return true;
  }

  function scheduleUpdate(storyboardId, patch, options = {}) {
    const ownerId = projectId();
    cancelDraftTimer(storyboardId);
    state.draftState = "dirty";
    renderHint();
    state.saveTimers.set(`${storyboardId}:prompt`, setTimeout(async () => {
      state.saveTimers.delete(`${storyboardId}:prompt`);
      try {
        state.draftState = "saving";
        renderHint();
        await persistPrompt(ownerId, storyboardId, patch.prompt);
        if (projectId() === ownerId) await refresh();
      } catch (error) {
        state.draftState = "dirty";
        renderHint();
        toast(`保存失败，输入仍保留在编辑区：${error.message}`, "error");
      }
    }, options.delay ?? 600));
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
      const ownerId = projectId();
      cancelDraftTimer(storyboardId);
      const result = await writeDraft(ownerId, () => api.storyboard.bind(ownerId, storyboardId, assetId, { prompt, caret }));
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

  // ── 事件绑定 ─────────────────────────────────────────────
  function bindEvents() {
    $("workbenchTaskFilters")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-filter]");
      if (!button) return;
      state.taskFilter = button.dataset.filter;
      state.taskVisibleLimit = 40;
      renderTasks();
      $("workbenchTaskList").scrollTop = 0;
    });
    $("workbenchTaskSearch")?.addEventListener("input", (event) => {
      state.taskSearch = event.target.value;
      state.taskVisibleLimit = 40;
      renderTasks();
      $("workbenchTaskList").scrollTop = 0;
    });
    $("workbenchTaskMore")?.addEventListener("click", () => {
      state.taskVisibleLimit += 40;
      renderTasks();
    });
    let openingWorkbench = false;
    $("showWorkbench")?.addEventListener("click", async () => {
      openModal("workbenchModal");
      if (openingWorkbench) return;
      openingWorkbench = true;
      try {
        const loaded = await refresh();
        if (loaded && !state.project) {
          await api.project.create("视频创作");
          await refresh();
        }
      } catch (error) {
        toast(`打开创作区失败：${error.message}`, "error");
      } finally {
        openingWorkbench = false;
      }
    });

    bindComposeEvents();
    renderAssetsCollapse();

    for (const node of document.querySelectorAll("#workbenchModal [data-close], #workbenchMentionModal [data-close], #workbenchPreviewModal [data-close], #workbenchImpactModal [data-close]")) {
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
      const targetProjectId = event.target.value;
      try {
        // 有未保存改动时先确认（保存并切换 / 丢弃 / 取消），取消则把下拉选回原值
        if (!(await confirmLeaveDraft())) {
          await refresh();
          return;
        }
        await api.project.open(targetProjectId);
        state.thumbCache.clear();
        await refresh();
        toast(`已切换项目：${state.project?.name || ""}`);
      } catch (error) {
        toast(`切换项目失败：${error.message}`, "error");
        await refresh();
      }
    });

    $("workbenchEpisodeSelect")?.addEventListener("change", async (event) => {
      const targetId = event.target.value;
      try {
        if (!(await confirmLeaveDraft())) {
          await refresh();
          return;
        }
        await api.project.open(targetId);
        state.thumbCache.clear();
        await refresh();
        toast(`已切换分集：${state.project?.name || ""}`);
      } catch (error) {
        toast(error.message, "error");
        await refresh();
      }
    });
    $("workbenchEpisodeNew")?.addEventListener("click", async () => {
      if (!state.project) return toast("请先新建大项目", "error");
      try {
        if (!(await confirmLeaveDraft())) return;
        const parentId = state.project.parentId || state.project.id;
        // 编号由主进程串行分配：快速连点也不会出现两个「第 1 集」
        await api.project.create("", { parentId });
        state.thumbCache.clear();
        await refresh();
        toast(`已新建分集：${state.project?.name || ""}`, "ok");
      } catch (error) { toast("新建分集失败：" + error.message, "error"); }
    });

    // ── 删除分集 / 删除项目（标题栏入口，高危操作一律二次确认） ──
    $("workbenchEpisodeDelete")?.addEventListener("click", async () => {
      const current = state.project;
      if (!current?.parentId) return toast("当前是「公共素材 / 项目工作区」，请先选中要删除的分集", "error");
      await removeEpisodes([current.id]);
    });
    $("workbenchProjectDelete")?.addEventListener("click", () => void removeCurrentProject());

    // ── 分集列表 / 批量 ──
    $("workbenchEpisodeWrap")?.addEventListener("toggle", () => {
      writeLayout({ episodesOpen: $("workbenchEpisodeWrap")?.open === true });
    });
    $("workbenchEpisodeList")?.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-act]");
      if (!button) return;
      const projectIdOfRow = button.closest(".workbench-episode")?.dataset.projectId;
      if (!projectIdOfRow) return;
      const act = button.dataset.act;
      if (act === "up" || act === "down") return moveEpisode(projectIdOfRow, act === "up" ? -1 : 1);
      if (act === "copy") return void duplicateEpisodes([projectIdOfRow]);
      if (act === "remove") return void removeEpisodes([projectIdOfRow]);
      if (act === "open") {
        try {
          if (!(await confirmLeaveDraft())) return;
          await api.project.open(projectIdOfRow);
          state.thumbCache.clear();
          await refresh();
        } catch (error) {
          toast(`载入分集失败：${error.message}`, "error");
        }
      }
    });
    $("workbenchEpisodeList")?.addEventListener("change", (event) => {
      const box = event.target.closest('input[data-act="episode-select"]');
      if (!box) return;
      const id = box.closest(".workbench-episode")?.dataset.projectId;
      if (!id) return;
      const next = new Set(state.episodeSelection);
      if (box.checked) next.add(id);
      else next.delete(id);
      state.episodeSelection = next;
      renderEpisodes();
    });
    $("workbenchEpisodeAll")?.addEventListener("change", (event) => {
      const episodes = episodesOf(currentRootId());
      state.episodeSelection = event.target.checked ? new Set(episodes.map((item) => item.id)) : new Set();
      renderEpisodes();
    });
    $("workbenchEpisodeUp")?.addEventListener("click", () => {
      const [id] = [...state.episodeSelection];
      if (id) moveEpisode(id, -1);
    });
    $("workbenchEpisodeDown")?.addEventListener("click", () => {
      const [id] = [...state.episodeSelection];
      if (id) moveEpisode(id, 1);
    });
    $("workbenchEpisodeCopy")?.addEventListener("click", () => void duplicateEpisodes([...state.episodeSelection]));
    $("workbenchEpisodeRemove")?.addEventListener("click", () => void removeEpisodes([...state.episodeSelection]));

    // ── 任务批量清理（只清「生成成功且下载未在进行」的记录） ──
    $("workbenchTaskClear")?.addEventListener("click", async () => {
      const succeeded = (state.tasks || []).filter((task) => task.status === "succeeded").length;
      if (!succeeded) return toast("当前没有可清理的已完成任务（失败与未完成任务都会保留）");
      const choice = await confirmAction({
        title: `清理 ${succeeded} 条已完成任务记录？`,
        message:
          "只删除「生成成功且下载未在进行」的任务记录；失败、需人工处理、未完成，以及下载中/已暂停的记录都会保留。已下载到本地的视频文件不会被删除。",
        okLabel: `确认清理（${succeeded}）`,
      });
      if (choice !== "ok") return;
      try {
        const result = await api.task.clear(projectId(), { statuses: ["succeeded"] });
        toast(
          `已清理 ${result.removed} 条记录${
            result.skipped?.length ? `；${result.skipped.length} 条因下载未完成被保留` : ""
          }`,
          "ok"
        );
        await refresh();
      } catch (error) {
        toast(`清理失败：${error.message}`, "error");
      }
    });

    $("workbenchAssetReuse")?.addEventListener("click", async () => {
      if (!state.project) return;
      try {
        await flushComposeDraft();
        window.openProjectAssetReuse({ api, target: {id: state.project.id, name: state.project.parentId ? state.project.name : state.project.name + " / 公共素材"}, onImported: async () => { state.thumbCache.clear(); await refresh(); } });
      } catch (error) { toast(error.message, "error"); }
    });

    $("workbenchProjectNew")?.addEventListener("click", async () => {
      try {
        // 先保存当前编辑内容，再切换到新项目。
        if (!(await confirmLeaveDraft())) return;
        await api.project.create(`项目 ${new Date().toLocaleDateString("zh-CN")}`);
        state.thumbCache.clear();
        await refresh();
        toast(`已新建项目：${state.project?.name || ""}`, "ok");
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
        const target = currentStoryboard()?.id;
        if (!target) return toast("请先新建或选择项目", "error");
        // 用输入框里的实时文本与光标，而不是等防抖落盘的旧值，否则刚打的字会被丢掉
        const node = document.querySelector(`[data-focus-key="sb-prompt:${target}"]`);
        let base = node ? node.value : null;
        let caret = node ? node.selectionStart : null;
        // 选中了一段文字再点「插入」：用这条 @图N 替换选中的那段，而不是插在选区后面
        if (node && Number.isInteger(node.selectionStart) && node.selectionEnd > node.selectionStart) {
          base = node.value.slice(0, node.selectionStart) + node.value.slice(node.selectionEnd);
          caret = node.selectionStart;
        }
        state.mention = { storyboardId: target, prompt: base, caret, search: "" };
        await bindFromMention(assetId);
        return;
      }
    });

    // 素材悬停放大预览：延迟 320ms 出现，移开立即隐藏（不占用卡位、不阻塞点击）
    let hoverTimer = null;
    const hoverNode = () => {
      let node = $("workbenchAssetHover");
      if (!node) {
        node = document.createElement("div");
        node.id = "workbenchAssetHover";
        node.className = "workbench-hover-preview";
        document.body.appendChild(node);
      }
      return node;
    };
    const hideHover = () => {
      clearTimeout(hoverTimer);
      $("workbenchAssetHover")?.classList.remove("is-visible");
    };
    $("workbenchAssetList")?.addEventListener("mouseover", (event) => {
      const thumb = event.target.closest(".workbench-asset-thumb");
      if (!thumb) return;
      const assetId = thumb.closest(".workbench-asset")?.dataset.assetId;
      if (!assetId) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(async () => {
        const url = await thumbFor(assetId);
        if (!url) return;
        const node = hoverNode();
        const rect = thumb.getBoundingClientRect();
        node.replaceChildren(Object.assign(document.createElement("img"), { src: url, alt: "素材预览" }));
        const width = 240;
        node.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 16, rect.right + 12))}px`;
        node.style.top = `${Math.max(8, rect.top - 24)}px`;
        node.style.width = `${width}px`;
        node.classList.add("is-visible");
      }, 320);
    });
    $("workbenchAssetList")?.addEventListener("mouseout", (event) => {
      if (event.target.closest(".workbench-asset-thumb")) hideHover();
    });
    $("workbenchAssetList")?.addEventListener("scroll", hideHover);

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
          toast("已改名（图片引用不受影响）");
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
      persistAccountSelection();
      renderAccounts();
      // 账号选择直接影响主按钮的可用性，这里必须同步刷新
      renderCompose();
    });

    $("workbenchAccountsRefresh")?.addEventListener("click", refreshAccounts);

    $("workbenchAccountPicks")?.addEventListener("click", async (event) => {
      if (event.target.closest('[data-act="accounts-retry"]')) {
        await refreshAccounts();
        return;
      }
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

    $("workbenchAccountNote")?.addEventListener("click", (event) => {
      if (event.target.closest('[data-act="accounts-all"]')) {
        state.accountsTouched = true;
        state.selectedAccountIds = (state.accounts || []).map((a) => a.id);
        persistAccountSelection();
        renderAccounts();
        renderCompose();
        return;
      }
      if (event.target.closest('[data-act="accounts-none"]')) {
        state.accountsTouched = true;
        state.selectedAccountIds = [];
        persistAccountSelection();
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
        if (button.dataset.act === "interrupt") {
          const record = await api.task.interrupt(projectId(), attemptId);
          toast(record.interruption?.stopped ? (record.interruption.platformMayContinue ? "已停止跟踪，可用该账号创建新任务；豆包可能仍在生成" : "已中断，未发送到豆包") : "任务已结束，无需中断");
        } else if (button.dataset.act === "resume-monitoring") {
          await api.task.resumeMonitoring(projectId(), attemptId);
          toast("已恢复查询，不会重新提交");
        } else if (button.dataset.act === "cancel") {
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
      } finally {
        button.disabled = false;
      }
    });

    // 关闭窗口 / 页面隐藏前的兜底保存：
    // 旧实现只有 600ms 防抖，编辑后立刻退出会让最后一次输入永久丢失。
    // 这里双保险：先尽力 flush（正常路径），同时把未落盘的值写进 localStorage（异常退出也能恢复）。
    window.addEventListener("beforeunload", () => {
      const storyboard = currentStoryboard();
      const node = $("workbenchMainPrompt");
      if (storyboard && node && String(node.value || "") !== String(storyboard.prompt || "")) {
        backupDraft(storyboard.id, node.value);
      }
      try {
        void flushComposeDraft();
      } catch {}
    });
    window.addEventListener("pagehide", () => void flushComposeDraft().catch(() => {}));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flushComposeDraft().catch(() => {});
    });
  }

  api.onChanged(() => {
    if (!$("workbenchModal") || $("workbenchModal").classList.contains("hidden")) return;
    refresh({ silent: false, tasksOnly: true });
  });

  // 一次合并所有下载的最新进度，避免全局节流让其他账号的更新丢失。
  let progressTimer = null;
  const pendingProgress = new Set();
  api.onDownloadProgress((payload) => {
    if (!payload?.attemptId) return;
    const current = state.downloadProgress.get(payload.attemptId) || {};
    state.downloadProgress.set(payload.attemptId, { ...current, ...payload });
    pendingProgress.add(payload.attemptId);
    if (progressTimer !== null) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      const ids = new Set(pendingProgress);
      pendingProgress.clear();
      if ($("workbenchModal")?.classList.contains("hidden")) return;
      const records = new Map((state.tasks || []).map((record) => [record.id, record]));
      for (const card of $("workbenchTaskList")?.children || []) {
        const id = card.dataset.attemptId;
        if (!ids.has(id) || !records.has(id)) continue;
        const host = card.querySelector(".workbench-download");
        if (host) host.replaceWith(downloadBlock(records.get(id)));
      }
    }, 250);
  });

  /**
   * 主窗口左下角：固定展示软件全称 + 当前语义化版本号。
   * 与工作台弹窗解耦——不打开工作台也能看到版本，点击直接看「关于/更新日志」。
   */
  async function bootstrapVersionBadge() {
    const badge = $("appVersionBadge");
    const num = $("appVersionNum");
    if (badge && badge.dataset.bound !== "1") {
      badge.dataset.bound = "1";
      badge.addEventListener("click", () => {
        renderChangelog();
        $("workbenchChangelogModal")?.classList.remove("hidden");
      });
    }
    try {
      const info = await api.versionInfo();
      if (info) state.appVersion = info;
    } catch {}
    const info = state.appVersion;
    if (num) num.textContent = info?.display || "v—";
    if (badge) {
      const facts = [];
      if (info?.channel) facts.push(`渠道：${info.channel}`);
      if (info?.releasedAt) facts.push(`发布：${info.releasedAt}`);
      if (info?.gitCommit) facts.push(`Git 提交：${info.gitCommit}`);
      if (info?.buildAt) facts.push(`构建时间：${info.buildAt}`);
      badge.title = info
        ? `澜川Dola管理器 ${info.display}（点击查看更新日志）${facts.length ? `\n${facts.join("\n")}` : ""}`
        : "当前版本（语义化版本）";
    }
    applyVersion();
  }

  function bootstrap() {
    bindEvents();
    creationLibrary = window.createWorkbenchLibrary?.({
      api, getState: () => state, refresh, toast,
      withDraft: async (operation, input) => {
        if (state.compose.busy) throw new Error("请等待当前操作完成");
        const ownerId = projectId();
        const draft = currentStoryboard();
        if (!draft) throw new Error("尚未准备好草稿");
        state.compose.busy = "library";
        renderCompose();
        try {
          await flushComposeDraft();
          await writeDraft(ownerId, () => api.library(operation, ownerId, { ...input, draftId: draft.id }));
          if (operation === "apply" || operation === "undo") {
            state.pendingValues.delete(`sb-prompt:${draft.id}`);
            state.compose.status = "";
          }
          await refresh();
        } finally { state.compose.busy = ""; renderCompose(); }
      },
    });
    for (const [id, tab] of [["workbenchTemplates", "templates"], ["workbenchHistory", "history"], ["workbenchWorks", "works"]]) {
      $(id)?.addEventListener("click", () => creationLibrary?.open(tab));
    }
    // 版本徽标单独引导：失败不影响工作台本身
    bootstrapVersionBadge().catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
