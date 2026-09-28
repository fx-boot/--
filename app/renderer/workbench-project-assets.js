"use strict";
window.openProjectAssetReuse = async function ({ api, target, onImported }) {
  if (document.getElementById("projectAssetReuse")) return;
  const focus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.id = "projectAssetReuse";
  overlay.className = "project-asset-overlay";
  overlay.innerHTML = `<section class="project-asset-dialog" role="dialog" aria-modal="true" aria-labelledby="projectAssetTitle">
    <header><h2 id="projectAssetTitle">复用项目素材</h2><button type="button" data-close aria-label="关闭素材复用">×</button></header>
    <p data-target></p><label for="projectAssetSource">素材来源</label><select id="projectAssetSource"></select>
    <div class="project-asset-options"></div><p role="status"></p>
    <footer><span data-count>已选 0 张</span><button type="button" class="primary-action" data-copy disabled>复用到当前集</button></footer>
  </section>`;
  document.body.append(overlay);
  const source = overlay.querySelector("select"), list = overlay.querySelector(".project-asset-options");
  const status = overlay.querySelector("[role=status]"), copy = overlay.querySelector("[data-copy]");
  overlay.querySelector("[data-target]").textContent = `保存到：${target.name}。素材会独立保存，来源删除后仍可使用；相同内容不重复导入。`;
  let selected = new Set(), busy = false, revision = 0;
  function close() { if (busy) return; revision++; overlay.remove(); focus?.focus(); }
  function update() { overlay.querySelector("[data-count]").textContent = `已选 ${selected.size} 张`; copy.disabled = busy || !selected.size; }
  overlay.querySelector("[data-close]").addEventListener("click", close);
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const items = [...overlay.querySelectorAll("button:not(:disabled),select:not(:disabled),input:not(:disabled)")];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  async function load() {
    const ticket = ++revision, sourceId = source.value;
    selected = new Set(); update(); list.replaceChildren(); status.textContent = "读取素材中…";
    if (!sourceId) { status.textContent = "暂无其他素材文件夹。先在项目公共素材或其他分集中导入图片。"; return; }
    try {
      const items = await api.asset.list(sourceId);
      if (ticket !== revision || !overlay.isConnected) return;
      status.textContent = items.length ? "勾选需要复用的图片。" : "这个文件夹还没有素材。";
      for (const asset of items) {
        const row = document.createElement("label"); row.className = "project-asset-option";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.setAttribute("aria-label", asset.name);
        checkbox.addEventListener("change", () => { checkbox.checked ? selected.add(asset.id) : selected.delete(asset.id); update(); });
        const img = document.createElement("img"); img.alt = asset.name;
        const name = document.createElement("span"); name.textContent = asset.name;
        row.append(checkbox, img, name); list.append(row);
        api.asset.thumb(sourceId, asset.id).then(url => { if (url && ticket === revision) img.src = url; }).catch(() => {});
      }
    } catch (error) { if (ticket === revision) status.textContent = error.message; }
  }
  source.addEventListener("change", load);
  copy.addEventListener("click", async () => {
    if (busy || !selected.size) return;
    busy = true; source.disabled = true; update();
    for (const node of list.querySelectorAll("input")) node.disabled = true;
    status.textContent = "正在保存素材…";
    try {
      const result = await api.asset.reuse(target.id, source.value, [...selected]);
      await onImported();
      status.textContent = `新增 ${result.imported.length} 张，已有 ${result.reused.length} 张。` + (result.failed.length ? "\n" + result.failed.map(item => `${item.file}：${item.message}`).join("\n") : "已保存，可以关闭窗口并插入提示词。");
      selected.clear(); for (const node of list.querySelectorAll("input")) node.checked = false;
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; source.disabled = false; for (const node of list.querySelectorAll("input")) node.disabled = false; update(); }
  });
  try {
    const folders = await api.asset.family(target.id);
    if (!overlay.isConnected) return;
    for (const folder of folders.filter(item => item.id !== target.id)) source.add(new Option(folder.parentId ? `分集 / ${folder.name}` : `${folder.name} / 公共素材`, folder.id));
    await load(); source.focus();
  } catch (error) { status.textContent = error.message; }
};
