"use strict";
window.createWorkbenchLibrary = ({ api, getState, withDraft, refresh, toast }) => {
  let tab = "templates", query = "", limit = 30, selected = new Set(), owner = "", busy = false;
  let favoritesOnly = false, mediaVersion = 0, lastFocus = null;
  let accountFilter = "", downloadFilter = "", sortOrder = "newest";
  const fingerprints = new WeakMap();
  const overlay = document.createElement("div");
  overlay.id = "workbenchLibraryModal";
  overlay.className = "overlay hidden";
  overlay.innerHTML = `<section class="modal creation-library" role="dialog" aria-modal="true" aria-labelledby="libraryTitle">
    <div class="modal-title"><div><h2 id="libraryTitle">创作资料库</h2><p id="libraryProject"></p></div><button type="button" class="modal-close" id="libraryClose" aria-label="关闭资料库">×</button></div>
    <div class="library-toolbar"><nav aria-label="资料分类"><button data-tab="templates">提示词模板</button><button data-tab="history">历史方案</button><button data-tab="works">生成作品</button></nav><input id="librarySearch" type="search" placeholder="搜索名称或提示词" aria-label="搜索资料"></div>
    <div class="library-filter-row"><select id="libraryAccount" aria-label="按账号筛选"><option value="">全部账号</option></select><select id="libraryDownload" aria-label="按下载状态筛选"><option value="">全部下载状态</option><option value="done">已下载</option><option value="pending">尚未下载完成</option></select><select id="librarySort" aria-label="排序"><option value="newest">最新在前</option><option value="oldest">最早在前</option></select><span id="libraryCount" role="status"></span></div>
    <div class="library-save" id="librarySaveRow"><input id="libraryName" maxlength="80" placeholder="给当前提示词起个名字" aria-label="模板名称"><button id="librarySave" class="primary-action">保存当前为模板</button></div>
    <div class="library-actions"><span id="libraryHint"></span><label id="libraryFavoriteWrap" hidden><input type="checkbox" id="libraryFavorites"> 只看收藏</label><button id="libraryUndo" hidden>撤销上次载入</button><button id="libraryClearSelection" hidden>清空选择</button><button id="libraryCompare" hidden>对比所选（0/2）</button></div>
    <div id="libraryCompareArea" hidden><div class="library-player-actions"><button id="libraryPlay">同步播放</button><button id="libraryPause">全部暂停</button><button id="libraryRestart">回到开头</button><button id="libraryExitCompare">关闭播放器</button><span>仅左侧播放声音</span></div><div id="libraryPlayers"></div></div>
    <div id="libraryList" class="library-list"></div><button id="libraryMore" hidden>显示更多</button>
    <div id="libraryMessage" role="status" aria-live="polite"></div>
  </section>`;
  document.body.append(overlay);
  const $ = (id) => overlay.querySelector(`#${id}`);
  function button(label, action) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    node.addEventListener("click", () => run(action)); return node;
  }
  function stopPlayers() {
    mediaVersion++;
    for (const video of overlay.querySelectorAll("video")) { video.pause(); video.removeAttribute("src"); video.load(); }
    $("libraryPlayers").replaceChildren(); $("libraryCompareArea").hidden = true;
  }
  function close() { stopPlayers(); overlay.classList.add("hidden"); lastFocus?.focus(); }
  async function run(action) {
    if (busy) return;
    busy = true; $("libraryMessage").textContent = "处理中…";
    overlay.querySelectorAll("button").forEach((node) => { node.disabled = true; });
    let shouldRender = true;
    try { shouldRender = (await action()) !== false; $("libraryMessage").textContent = ""; }
    catch (error) { shouldRender = false; $("libraryMessage").textContent = error.message; }
    finally { busy = false; overlay.querySelectorAll("button").forEach((node) => { node.disabled = false; }); if (shouldRender) render(true); }
  }
  async function mutate(operation, input) {
    if (owner !== getState().project?.id) throw new Error("项目已切换，请重新打开资料库");
    await api.library(operation, owner, input); await refresh();
  }
  async function apply(kind, id) {
    await withDraft("apply", { kind, id });
    close(); toast("方案已载入，可修改后生成；资料库内可撤销这次载入", "ok");
  }
  function render(force = false) {
    if (overlay.classList.contains("hidden")) return;
    const state = getState();
    if (owner !== state.project?.id) { close(); return; }
    const library = state.project.library || {};
    const names = new Map((state.accounts || []).map((account) => [account.id, account.name]));
    const accountOptions = [...new Set((state.tasks || []).map((task) => task.accountId))].filter(Boolean);
    const optionsKey = JSON.stringify(accountOptions.map((id) => [id, names.get(id)]));
    const accountSelect = $("libraryAccount");
    if (accountSelect.dataset.optionsKey !== optionsKey) {
      accountSelect.replaceChildren(new Option("全部账号", ""), ...accountOptions.map((id) => new Option(names.get(id) || id, id)));
      accountSelect.dataset.optionsKey = optionsKey;
      if (!accountOptions.includes(accountFilter)) accountFilter = "";
      accountSelect.value = accountFilter;
    }
    accountSelect.hidden = tab === "templates";
    $("libraryDownload").hidden = tab !== "works";
    const available = new Set((state.tasks || []).filter((task) => task.status === "succeeded").map((task) => task.id));
    selected = new Set([...selected].filter((id) => available.has(id)));
    $("libraryClearSelection").hidden = tab !== "works" || !selected.size;
    $("libraryProject").textContent = `${state.project.name} · 仅当前项目`;
    $("librarySaveRow").hidden = tab !== "templates";
    $("libraryFavoriteWrap").hidden = tab !== "works";
    $("libraryUndo").hidden = !library.undo;
    $("libraryCompare").hidden = tab !== "works";
    $("libraryCompare").textContent = `对比所选（${selected.size}/2）`;
    overlay.querySelectorAll("[data-tab]").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.tab === tab)));
    $("libraryHint").textContent = tab === "templates" ? "保存提示词、参数和参考图绑定。载入会替换当前草稿，可撤销。" : tab === "history" ? "复用当时的提示词与参数，只载入编辑器，不提交生成。" : "收藏满意作品，选择两个视频并排对比。优先播放本地文件。";
    const favorites = new Set(library.favorites || []);
    const tasks = state.tasks || [];
    let items = tab === "templates" ? library.templates || [] : tasks.filter((item) => tab !== "works" || item.status === "succeeded");
    items = items.filter((item) => (tab === "templates" || !accountFilter || item.accountId === accountFilter)
      && (tab !== "works" || !downloadFilter || (downloadFilter === "done" ? item.download?.status === "done" : item.download?.status !== "done"))
      && (!favoritesOnly || tab !== "works" || favorites.has(item.id)) && `${item.name || item.storyboardName || ""} ${item.params?.prompt || ""} ${names.get(item.accountId) || item.accountId || ""}`.toLocaleLowerCase().includes(query));
    items.sort((a, b) => (sortOrder === "newest" ? -1 : 1) * String(a.createdAt).localeCompare(String(b.createdAt)));
    const host = $("libraryList");
    const existing = new Map([...host.querySelectorAll(".library-card")].map((card) => [card.dataset.id, card]));
    const visible = items.slice(0, limit);
    const ids = new Set(visible.map((item) => item.id));
    for (const card of existing.values()) if (!ids.has(card.dataset.id)) card.remove();
    host.querySelector(".library-empty")?.remove();
    $("libraryCount").textContent = `显示 ${visible.length} / ${items.length} 条`;
    if (!items.length) { const empty = document.createElement("p"); empty.className = "library-empty"; empty.textContent = query || favoritesOnly ? "没有匹配的内容" : tab === "templates" ? "还没有模板。写好提示词后，给它起个名字保存。" : "这里还没有生成记录"; host.append(empty); }
    for (const [index, item] of visible.entries()) {
      const previous = existing.get(item.id);
      const fingerprint = JSON.stringify([tab, item, names.get(item.accountId), favorites.has(item.id), state.statusLabels?.[item.status]]);
      if (previous && ((!force && previous.dataset.editing) || (fingerprints.get(previous) === fingerprint && !previous.dataset.editing))) {
        const checkbox = previous.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = selected.has(item.id);
        if (host.children[index] !== previous) host.insertBefore(previous, host.children[index] || null);
        continue;
      }
      const card = document.createElement("article"); card.className = "library-card"; card.dataset.id = item.id;
      const title = document.createElement("strong"); title.textContent = item.name || `${item.storyboardName || "视频创作"} · 尝试 ${item.attempt}`;
      const meta = document.createElement("small"); meta.textContent = [names.get(item.accountId) || item.accountId, item.params?.model, item.params?.duration && `${item.params.duration} 秒`, item.params?.ratio, new Date(item.createdAt).toLocaleString("zh-CN"), tab !== "templates" ? state.statusLabels?.[item.status] || item.status : ""].filter(Boolean).join(" · ");
      const prompt = document.createElement("p"); prompt.className = "library-prompt"; prompt.textContent = item.params?.prompt || "（没有提示词）";
      const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "完整提示词与参考图";
      const full = document.createElement("p"); full.className = "library-full-prompt"; full.textContent = `${item.params?.prompt || ""}\n\n参考图：${item.refs?.map((ref) => `${ref.token} ${ref.name || ref.assetId}`).join("、") || "无"}`;
      details.append(summary, full);
      details.open = previous?.querySelector("details")?.open || false;
      const actions = document.createElement("div"); actions.className = "library-card-actions";
      actions.append(button("载入编辑器", () => apply(tab === "templates" ? "template" : "history", item.id)));
      if (tab === "templates") {
        actions.append(button("重命名", async () => {
          card.dataset.editing = "rename";
          const input = document.createElement("input"); input.value = item.name; input.maxLength = 80; input.setAttribute("aria-label", "新的模板名称");
          const save = button("保存名称", () => mutate("rename", { id: item.id, name: input.value }));
          const cancel = button("取消", async () => render(true));
          actions.replaceChildren(input, save, cancel); input.focus(); input.select();
          return false;
        }));
        actions.append(button("删除", async () => {
          card.dataset.editing = "delete";
          actions.replaceChildren(button("确认删除模板", () => mutate("remove", { id: item.id })), button("保留", async () => render(true)));
          return false;
        }));
      }
      if (tab === "works") {
        actions.append(button(favorites.has(item.id) ? "★ 已收藏" : "☆ 收藏", () => mutate("favorite", { id: item.id, enabled: !favorites.has(item.id) })));
        actions.append(button("播放", () => showPlayers([item.id])));
        const choose = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(item.id);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked && selected.size >= 2) { checkbox.checked = false; $("libraryMessage").textContent = "最多选择两个作品进行对比"; return; }
          if (checkbox.checked) selected.add(item.id); else selected.delete(item.id);
          $("libraryCompare").textContent = `对比所选（${selected.size}/2）`;
          $("libraryClearSelection").hidden = !selected.size;
        });
        choose.append(checkbox, " 加入对比"); actions.append(choose);
        if (item.download?.filePath || item.result?.filePath) actions.append(button("打开文件", () => api.task.openFile(owner, item.id)));
      }
      card.append(title, meta, prompt, details, actions);
      fingerprints.set(card, fingerprint);
      if (previous?.isConnected) previous.replaceWith(card);
      if (host.children[index] !== card) host.insertBefore(card, host.children[index] || null);
    }
    $("libraryMore").hidden = items.length <= limit;
  }
  async function showPlayers(ids) {
    stopPlayers(); const version = mediaVersion;
    const media = await Promise.all(ids.map((id) => api.library("media", owner, { id })));
    if (version !== mediaVersion || overlay.classList.contains("hidden")) return;
    $("libraryCompareArea").hidden = false;
    media.forEach((source, index) => {
      const container = document.createElement("div");
      const task = getState().tasks.find((item) => item.id === ids[index]);
      const label = document.createElement("strong"); label.textContent = `${index ? "B" : "A"} · ${task?.storyboardName || "作品"} · ${source.local ? "本地" : "在线"}`;
      const video = document.createElement("video"); video.controls = true; video.preload = "metadata"; video.muted = index > 0; video.src = source.url;
      video.addEventListener("error", () => { $("libraryMessage").textContent = "视频无法播放，在线地址可能失效或受访问限制。请在任务面板下载后再试。"; });
      video.addEventListener("ended", () => overlay.querySelectorAll("video").forEach((item) => item.pause()));
      if (index === 0) video.addEventListener("timeupdate", () => {
        const other = $("libraryPlayers").querySelectorAll("video")[1];
        if (other?.readyState >= 1 && !video.paused && Math.abs(other.currentTime - video.currentTime) > 0.3) other.currentTime = Math.min(video.currentTime, other.duration || video.currentTime);
      });
      const facts = document.createElement("small");
      const account = getState().accounts.find((item) => item.id === task?.accountId);
      facts.textContent = `${account?.name || task?.accountId || ""} · 尝试 ${task?.attempt || 1} · ${task?.params?.duration || "?"} 秒 · ${task?.params?.ratio || ""}`;
      const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "查看此版本提示词";
      const prompt = document.createElement("p"); prompt.className = "library-full-prompt"; prompt.textContent = task?.params?.prompt || "";
      details.append(summary, prompt);
      container.append(label, facts, video, details); $("libraryPlayers").append(container);
    });
    $("libraryCompareArea").scrollIntoView({ block: "nearest" });
  }
  $("libraryClose").onclick = () => { if (!busy) close(); };
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const nodes = [...overlay.querySelectorAll("button,input,video,summary")].filter((node) => !node.disabled && node.getClientRects().length);
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    }
  });
  overlay.querySelectorAll("[data-tab]").forEach((node) => node.onclick = () => { stopPlayers(); tab = node.dataset.tab; limit = 30; render(); });
  $("libraryAccount").onchange = (event) => { accountFilter = event.target.value; limit = 30; render(); };
  $("libraryDownload").onchange = (event) => { downloadFilter = event.target.value; limit = 30; render(); };
  $("librarySort").onchange = (event) => { sortOrder = event.target.value; render(); };
  $("libraryClearSelection").onclick = () => { selected.clear(); render(); };
  $("librarySearch").oninput = (event) => { query = event.target.value.trim().toLocaleLowerCase(); limit = 30; render(); };
  $("libraryFavorites").onchange = (event) => { favoritesOnly = event.target.checked; render(); };
  $("libraryMore").onclick = () => { limit += 30; render(); };
  $("librarySave").onclick = () => run(async () => { await withDraft("save", { name: $("libraryName").value }); $("libraryName").value = ""; toast("模板已保存", "ok"); });
  $("libraryUndo").onclick = () => run(async () => { await withDraft("undo", {}); close(); toast("已恢复载入前的草稿", "ok"); });
  $("libraryCompare").onclick = () => run(async () => { if (selected.size !== 2) throw new Error("请先选择两个作品"); await showPlayers([...selected]); });
  $("libraryPlay").onclick = () => run(async () => {
    const videos = [...overlay.querySelectorAll("video")];
    if (videos.some((video) => video.readyState < 1)) throw new Error("视频仍在载入，请稍候");
    if (videos[1]) videos[1].currentTime = videos[0].currentTime;
    const results = await Promise.allSettled(videos.map((video) => video.play()));
    if (results.some((result) => result.status === "rejected")) { videos.forEach((video) => video.pause()); throw new Error("播放未成功，请检查视频地址或使用本地文件"); }
  });
  $("libraryPause").onclick = () => overlay.querySelectorAll("video").forEach((video) => video.pause());
  $("libraryRestart").onclick = () => overlay.querySelectorAll("video").forEach((video) => { video.pause(); if (video.readyState >= 1) video.currentTime = 0; });
  $("libraryExitCompare").onclick = stopPlayers;
  return {
    open(nextTab) {
      if (!getState().project || getState().compose.busy) return;
      lastFocus = document.activeElement; owner = getState().project.id; tab = nextTab; query = ""; limit = 30; selected.clear();
      accountFilter = ""; downloadFilter = ""; favoritesOnly = false;
      $("libraryAccount").value = ""; $("libraryDownload").value = ""; $("libraryFavorites").checked = false;
      $("librarySearch").value = ""; $("libraryMessage").textContent = ""; overlay.classList.remove("hidden"); render(); $("librarySearch").focus();
    },
    render,
  };
};
