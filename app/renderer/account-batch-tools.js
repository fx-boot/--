"use strict";

(() => {
  if (window.__DBM_ACCOUNT_BATCH_TOOLS__) return;
  window.__DBM_ACCOUNT_BATCH_TOOLS__ = true;

  const selected = new Set();
  let batchMode = false;
  let deleteData = false;
  let deleting = false;
  let modalReturnFocus = null;

  const byId = (id) => document.getElementById(id);
  const list = byId("accountList");
  const headingActions = document.querySelector(".left-panel .panel-heading .heading-actions");
  if (!list || !headingActions || !window.managerAPI?.accounts) return;

  const batchButton = document.createElement("button");
  batchButton.type = "button";
  batchButton.id = "batchSelectAccounts";
  batchButton.className = "import-account-button batch-select-button";
  batchButton.textContent = "批量删除";
  batchButton.title = "选择多个账号进行删除";
  headingActions.insertBefore(batchButton, byId("addAccount"));

  const toolbar = document.createElement("div");
  toolbar.id = "batchAccountToolbar";
  toolbar.className = "batch-account-toolbar hidden";
  toolbar.innerHTML = `
    <label class="batch-select-all"><input type="checkbox" id="batchSelectAll"><span>全选</span></label>
    <span class="batch-selection-count" id="batchSelectionCount">已选 0 个</span>
    <button type="button" class="batch-cancel" id="batchCancel" title="退出批量选择" aria-label="退出批量选择">&times;</button>
    <button type="button" class="batch-delete-command" id="batchDeleteCommand" disabled>删除</button>
  `;
  list.parentElement.insertBefore(toolbar, list);

  const modal = document.createElement("div");
  modal.id = "batchDeleteModal";
  modal.className = "overlay hidden";
  modal.innerHTML = `
    <section class="modal confirm-modal batch-delete-modal" role="dialog" aria-modal="true" aria-labelledby="batchDeleteTitle" aria-describedby="batchDeleteMessage" tabindex="-1">
      <div class="danger-icon">!</div>
      <h2 id="batchDeleteTitle">批量删除账号</h2>
      <p id="batchDeleteMessage"></p>
      <div class="delete-choice-list" id="batchDeleteChoices">
        <button type="button" class="delete-choice" data-batch-delete-data="false">
          <strong>仅移除账号</strong>
          <span>保留 Cookie、缓存、登录状态和账号指纹</span>
        </button>
        <button type="button" class="delete-choice danger" data-batch-delete-data="true">
          <strong>移除账号并清除数据</strong>
          <span>同时清除所选账号的本地登录状态与浏览器数据</span>
        </button>
      </div>
      <div class="modal-actions batch-final-actions hidden" id="batchFinalActions">
        <button type="button" class="secondary-action" id="batchDeleteBack">返回</button>
        <button type="button" class="danger-action" id="batchDeleteConfirm">确认删除</button>
      </div>
      <div class="modal-actions" id="batchChoiceActions">
        <button type="button" class="secondary-action" id="batchDeleteCancel">取消</button>
      </div>
    </section>
  `;
  document.body.appendChild(modal);

  const selectAll = byId("batchSelectAll");
  const selectionCount = byId("batchSelectionCount");
  const deleteCommand = byId("batchDeleteCommand");
  const deleteTitle = byId("batchDeleteTitle");
  const deleteMessage = byId("batchDeleteMessage");
  const deleteChoices = byId("batchDeleteChoices");
  const finalActions = byId("batchFinalActions");
  const choiceActions = byId("batchChoiceActions");
  const confirmDelete = byId("batchDeleteConfirm");

  function cards() {
    return Array.from(list.querySelectorAll(".account-card[data-id]"));
  }

  function updateSelection() {
    const currentCards = cards();
    const visibleIds = new Set(currentCards.map((card) => card.dataset.id));
    for (const id of selected) {
      if (!visibleIds.has(id)) selected.delete(id);
    }
    for (const card of currentCards) {
      const checked = selected.has(card.dataset.id);
      card.classList.toggle("batch-selected", batchMode && checked);
      const checkbox = card.querySelector(".batch-account-check");
      if (checkbox) checkbox.checked = checked;
    }
    const visibleSelected = Array.from(visibleIds).filter((id) => selected.has(id)).length;
    selectAll.checked = visibleIds.size > 0 && visibleSelected === visibleIds.size;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.size;
    selectionCount.textContent = `已选 ${selected.size} 个`;
    deleteCommand.textContent = selected.size ? `删除 (${selected.size})` : "删除";
    deleteCommand.disabled = selected.size === 0 || deleting;
  }

  function decorateCards() {
    for (const card of cards()) {
      card.classList.toggle("batch-selectable", batchMode);
      let checkbox = card.querySelector(".batch-account-check");
      if (!checkbox) {
        checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "batch-account-check";
        checkbox.addEventListener("click", (event) => event.stopPropagation());
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(card.dataset.id);
          else selected.delete(card.dataset.id);
          updateSelection();
        });
        card.prepend(checkbox);
      }
      const accountName = card.querySelector(".account-info strong")?.textContent?.trim() || card.dataset.id;
      checkbox.setAttribute("aria-label", `选择账号 ${accountName}`);
    }
    updateSelection();
  }

  function setBatchMode(value) {
    batchMode = Boolean(value);
    if (!batchMode) selected.clear();
    list.classList.toggle("batch-mode", batchMode);
    toolbar.classList.toggle("hidden", !batchMode);
    batchButton.classList.toggle("active", batchMode);
    batchButton.setAttribute("aria-pressed", String(batchMode));
    batchButton.textContent = batchMode ? "退出批量" : "批量删除";
    decorateCards();
  }

  function showToast(message, type = "ok") {
    const region = byId("toastRegion");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = `toast batch-tools-toast ${type}`;
    toast.textContent = message;
    region.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function resetDeleteModal() {
    deleteData = false;
    deleteTitle.textContent = "批量删除账号";
    deleteMessage.textContent = `已选择 ${selected.size} 个账号，请选择数据处理方式。`;
    deleteChoices.classList.remove("hidden");
    choiceActions.classList.remove("hidden");
    finalActions.classList.add("hidden");
    confirmDelete.disabled = false;
    confirmDelete.textContent = "确认删除";
  }

  function closeDeleteModal() {
    if (deleting) return;
    modal.classList.add("hidden");
    modalReturnFocus?.focus?.();
    modalReturnFocus = null;
  }

  function openDeleteModal() {
    if (!selected.size) return;
    modalReturnFocus = document.activeElement;
    resetDeleteModal();
    modal.classList.remove("hidden");
    deleteChoices.querySelector("button")?.focus();
  }

  function chooseDeleteMode(value) {
    deleteData = value;
    deleteChoices.classList.add("hidden");
    choiceActions.classList.add("hidden");
    finalActions.classList.remove("hidden");
    deleteTitle.textContent = `确认删除 ${selected.size} 个账号？`;
    deleteMessage.textContent = deleteData
      ? "账号及其 Cookie、缓存、登录状态和浏览器数据将被清除。"
      : "账号将从列表中移除，本地登录数据会保留。";
    confirmDelete.textContent = deleteData ? "删除并清除数据" : "确认移除";
  }

  async function executeDelete() {
    if (deleting || !selected.size) return;
    deleting = true;
    batchButton.disabled = true;
    selectAll.disabled = true;
    byId("batchCancel").disabled = true;
    confirmDelete.disabled = true;
    confirmDelete.textContent = "删除中...";
    const ids = Array.from(selected);
    const failures = [];
    for (const id of ids) {
      try {
        const result = await window.managerAPI.accounts.delete(id, { deleteData });
        if (result?.ok === false) failures.push(id);
      } catch {
        failures.push(id);
      }
    }
    modal.classList.add("hidden");
    window.dispatchEvent(new CustomEvent("dbm:batch-delete-complete", {
      detail: { requested: ids.length, deleted: ids.length - failures.length, failures, deleteData },
    }));
    if (failures.length) showToast(`已删除 ${ids.length - failures.length} 个，${failures.length} 个失败`, "warn");
    else showToast(`已删除 ${ids.length} 个账号`, "ok");
    if (window.__DBM_SKIP_BATCH_RELOAD__ === true) {
      for (const id of ids.filter((id) => !failures.includes(id))) {
        list.querySelector(`.account-card[data-id="${CSS.escape(id)}"]`)?.remove();
      }
      setBatchMode(false);
      deleting = false;
      batchButton.disabled = false;
      selectAll.disabled = false;
      byId("batchCancel").disabled = false;
    } else {
      setTimeout(() => location.reload(), 450);
    }
  }

  batchButton.addEventListener("click", () => setBatchMode(!batchMode));
  byId("batchCancel").addEventListener("click", () => setBatchMode(false));
  deleteCommand.addEventListener("click", openDeleteModal);
  byId("batchDeleteCancel").addEventListener("click", closeDeleteModal);
  byId("batchDeleteBack").addEventListener("click", resetDeleteModal);
  confirmDelete.addEventListener("click", executeDelete);
  deleteChoices.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-batch-delete-data]");
    if (choice) chooseDeleteMode(choice.dataset.batchDeleteData === "true");
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeDeleteModal();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDeleteModal();
    }
  });
  selectAll.addEventListener("change", () => {
    for (const card of cards()) {
      if (selectAll.checked) selected.add(card.dataset.id);
      else selected.delete(card.dataset.id);
    }
    updateSelection();
  });
  list.addEventListener("click", (event) => {
    if (!batchMode || event.target.closest(".batch-account-check")) return;
    const card = event.target.closest(".account-card[data-id]");
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (selected.has(card.dataset.id)) selected.delete(card.dataset.id);
    else selected.add(card.dataset.id);
    updateSelection();
  }, true);

  let decorateQueued = false;
  new MutationObserver(() => {
    if (decorateQueued) return;
    decorateQueued = true;
    queueMicrotask(() => {
      decorateQueued = false;
      decorateCards();
    });
  }).observe(list, { childList: true, subtree: false });

  window.managerCompatAPI?.onAccountsRefreshed?.((payload) => {
    const accountIds = Array.isArray(payload?.refreshedAccountIds) ? payload.refreshedAccountIds : [];
    if (payload?.reloadInMain !== true) {
      for (const accountId of accountIds) {
        const webview = document.querySelector(`#browserStack webview[data-account-id="${CSS.escape(accountId)}"]`);
        try { webview?.reloadIgnoringCache?.(); } catch { try { webview?.reload?.(); } catch {} }
      }
    }
    if (payload?.updatedAccounts) showToast(`已覆盖刷新 ${payload.updatedAccounts} 个账号 Cookie`, "ok");
  });

  decorateCards();
})();
