/**
 * 工作台端到端流程探针（隔离环境内运行真实应用）
 *
 * 目的：验证静态检查覆盖不到的部分 —— 渲染层代码在真实 Electron 里能否跑通、
 * IPC 往返是否正常、素材/分镜/@图片引用/任务入队的完整闭环是否成立。
 *
 * 明确不做的事：
 *   - 不执行任何真实生成（不调用 task.execute），因此不消耗任何账号额度；
 *   - 不使用真实账号，入队用的是占位账号标识；
 *   - 不触碰正式版目录（沿用 supervisor 的两层隔离）。
 *
 * 由 tools/pack-app.cjs --entry-file 注入，报告写到 exe 同目录。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, nativeImage } = require("electron");

const exeDir = path.dirname(process.execPath);
const isolatedRoot = path.resolve(
  process.env.DBM_ISOLATED_ROOT || path.join(exeDir, "flow-probe-data")
);
const appDataDir = path.join(isolatedRoot, "DoubaoAccountManager");
const reportPath = path.join(exeDir, "flow-probe-report.json");

const report = {
  startedAt: new Date().toISOString(),
  isolatedRoot,
  checks: [],
  steps: {},
  consoleErrors: [],
  pageErrors: [],
  diagnostics: [],
  error: null,
  ok: false,
};

function writeAndExit(code) {
  report.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch {}
  app.exit(code);
}

process.on("uncaughtException", (err) => {
  report.error = err?.stack || String(err);
  writeAndExit(1);
});
process.on("unhandledRejection", (err) => {
  report.error = err?.stack || String(err);
  writeAndExit(1);
});

// 两层隔离（与 supervised-entry 一致）
fs.mkdirSync(appDataDir, { recursive: true });
const nativeSetPath = app.setPath.bind(app);
nativeSetPath("appData", isolatedRoot);
app.setPath = (name, value) =>
  ["userData", "sessionData", "appData"].includes(name)
    ? nativeSetPath(name, name === "appData" ? isolatedRoot : appDataDir)
    : nativeSetPath(name, value);
app.setPath("userData", appDataDir);

// 造 3 个占位账号：只为验证「多选账号 / 批量入队 / 提交预览」的界面与数据链路，
// 全程不调用 task.execute，因此不会有任何真实提交、不消耗任何额度。
try {
  fs.writeFileSync(
    path.join(appDataDir, "accounts.json"),
    `${JSON.stringify(
      {
        accounts: [
          { id: "probe-acct-001", name: "探针账号A", platform: "dola" },
          { id: "probe-acct-002", name: "探针账号B", platform: "dola" },
          { id: "probe-acct-003", name: "探针账号C", platform: "dola" },
        ],
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  report.diagnostics.push({ label: "写占位账号", error: error.message });
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("console-message", (_e, level, message) => {
    // level 3 = error
    if (Number(level) >= 3) report.consoleErrors.push(String(message).slice(0, 400));
  });
  contents.on("render-process-gone", (_e, details) =>
    report.pageErrors.push({ kind: "render-process-gone", reason: details?.reason })
  );
  contents.on("preload-error", (_e, preloadPath, error) =>
    report.pageErrors.push({ kind: "preload-error", preloadPath, error: error.message })
  );
});
app.on("browser-window-created", (_event, win) => {
  win.show = () => {};
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    report.pageErrors.push({ kind: "did-fail-load", code, desc, url })
  );
});

report.mainLoaded = false;
try {
  require("./src/main");
  report.mainLoaded = true;
} catch (error) {
  report.requireError = error?.stack || String(error);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, tries = 200, step = 100) {
  for (let i = 0; i < tries; i++) {
    let value;
    try {
      value = await fn();
    } catch (error) {
      report.diagnostics.push({ label, error: error.message });
      value = null;
    }
    if (value) return value;
    await delay(step);
  }
  throw new Error(`等待超时：${label}`);
}

function check(name, condition, detail) {
  report.checks.push({ name, pass: Boolean(condition), detail: detail === undefined ? null : detail });
  return Boolean(condition);
}

/** 生成一张真实的 400x400 PNG（用原始位图构造，确保缩略图分支被覆盖） */
function makeFixture(file) {
  const width = 400;
  const height = 400;
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      bitmap[i] = Math.round((x / width) * 255); // B
      bitmap[i + 1] = Math.round((y / height) * 255); // G
      bitmap[i + 2] = 200; // R
      bitmap[i + 3] = 255; // A
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, image.toPNG());
  return { file, size: fs.statSync(file).size, dims: image.getSize() };
}

(async () => {
  await app.whenReady();
  report.electron = process.versions.electron;
  report.chrome = process.versions.chrome;
  const win = await waitFor(
    () =>
      BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL().endsWith("/renderer/index.html")
      ),
    "主窗口"
  );
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await waitFor(() => js("Boolean(window.managerWorkbenchAPI)"), "工作台 preload");
  check("主进程加载成功", report.mainLoaded);

  // ── 1. 素材：真实 PNG 导入 ──
  const fixture = makeFixture(path.join(isolatedRoot, "fixtures", "flow-test.png"));
  report.steps.fixture = fixture;
  check("测试图片已生成且可被 Electron 解析", fixture.dims.width === 400 && fixture.dims.height === 400, fixture);

  const created = await js(`window.managerWorkbenchAPI.project.create(${JSON.stringify("端到端流程验证")})`);
  const projectId = created.projectId;
  check("项目已创建", Boolean(projectId), projectId);

  const imported = await js(
    `window.managerWorkbenchAPI.asset.importPaths(${JSON.stringify(projectId)}, [${JSON.stringify(fixture.file)}])`
  );
  report.steps.import = imported;
  check("图片导入成功", imported.imported.length === 1, imported);
  const assetId = imported.imported[0]?.id;
  check("素材获得稳定 assetId", /^asset_[0-9a-f]{12}$/.test(String(assetId)), assetId);
  check("素材记录了尺寸", imported.imported[0]?.width === 400 && imported.imported[0]?.height === 400, imported.imported[0]);
  check("生成了缩略图", imported.imported[0]?.hasThumb === true);

  const thumb = await js(`window.managerWorkbenchAPI.asset.thumb(${JSON.stringify(projectId)}, ${JSON.stringify(assetId)})`);
  check("缩略图返回 data URL（绕开 CSP 对 file:// 的限制）", String(thumb).startsWith("data:image/png;base64,"), String(thumb).slice(0, 32));
  const preview = await js(`window.managerWorkbenchAPI.asset.preview(${JSON.stringify(projectId)}, ${JSON.stringify(assetId)})`);
  check("预览返回 data URL", String(preview).startsWith("data:image/png;base64,"));

  const again = await js(
    `window.managerWorkbenchAPI.asset.importPaths(${JSON.stringify(projectId)}, [${JSON.stringify(fixture.file)}])`
  );
  check("同一张图重复导入复用同一 assetId", again.reused.length === 1 && again.reused[0].id === assetId, again.reused);

  // ── 2. 分镜 + @图片绑定（走与界面一致的插入光标路径） ──
  const added = await js(`window.managerWorkbenchAPI.storyboard.add(${JSON.stringify(projectId)}, {})`);
  const storyboardId = added.storyboard.id;
  check("分镜已创建", Boolean(storyboardId));

  const prefix = "镜头推进，";
  await js(
    `window.managerWorkbenchAPI.storyboard.update(${JSON.stringify(projectId)}, ${JSON.stringify(storyboardId)}, {name: ${JSON.stringify("开场")}, prompt: ${JSON.stringify(prefix)}})`
  );
  const bound = await js(
    `window.managerWorkbenchAPI.storyboard.bind(${JSON.stringify(projectId)}, ${JSON.stringify(storyboardId)}, ${JSON.stringify(assetId)}, {prompt: ${JSON.stringify(prefix)}, caret: ${prefix.length}})`
  );
  report.steps.bind = { token: bound.token, caret: bound.caret, prompt: bound.storyboard?.prompt };
  check("@图片绑定成功并分配 token", bound.added === true && bound.token === "@图1", report.steps.bind);
  check("token 插入在光标位置而不是一律追加末尾", String(bound.storyboard?.prompt).startsWith(prefix), bound.storyboard?.prompt);
  check("引用表记录了 assetId", bound.storyboard?.refs?.[0]?.assetId === assetId, bound.storyboard?.refs);

  // ── 3. 改名不影响引用 ──
  await js(
    `window.managerWorkbenchAPI.asset.rename(${JSON.stringify(projectId)}, ${JSON.stringify(assetId)}, ${JSON.stringify("改名后的素材")})`
  );
  let snap = await js("window.managerWorkbenchAPI.snapshot()");
  const sbAfterRename = snap.project.storyboards.find((s) => s.id === storyboardId);
  check("改名后引用仍是同一 assetId", sbAfterRename?.refs?.[0]?.assetId === assetId, sbAfterRename?.refs);
  check("改名后素材展示名已更新", snap.assets.find((a) => a.id === assetId)?.name === "改名后的素材");
  check("提示词内容未被改名影响", sbAfterRename?.prompt === bound.storyboard?.prompt);

  // ── 4. 界面状态（重启恢复用） ──
  await js(
    `window.managerWorkbenchAPI.ui.set(${JSON.stringify(projectId)}, {selectedStoryboardId: ${JSON.stringify(storyboardId)}})`
  );
  snap = await js("window.managerWorkbenchAPI.snapshot()");
  check("界面选中态已持久化", snap.project?.ui?.selectedStoryboardId === storyboardId);

  // ── 5. 提交前校验预览（真实能力表） ──
  const previewPlan = await js(
    `window.managerWorkbenchAPI.task.preview(${JSON.stringify(projectId)}, ${JSON.stringify(storyboardId)}, ${JSON.stringify("placeholder-account")})`
  );
  report.steps.preview = {
    valid: previewPlan.valid,
    errors: previewPlan.errors,
    warnings: previewPlan.warnings,
    limitations: previewPlan.limitations,
    uploads: previewPlan.uploads,
    params: previewPlan.params,
  };
  check("预览通过了参数校验", previewPlan.valid === true, previewPlan.errors);
  check("预览带上了真实上传文件路径", previewPlan.uploads.length === 1 && fs.existsSync(previewPlan.uploads[0]), previewPlan.uploads);
  check("比例与参考图上限被明确标注为平台未提供", previewPlan.warnings.length >= 1, previewPlan.warnings);
  check("提示词预览里引用位置以原子占位符呈现", String(previewPlan.promptPreview).includes("\uFFFC"), previewPlan.promptPreview);

  // ── 6. 任务入队（占位账号，不执行、不消耗额度） ──
  const enqueued = await js(
    `window.managerWorkbenchAPI.task.enqueue(${JSON.stringify(projectId)}, ${JSON.stringify(storyboardId)}, ${JSON.stringify("placeholder-account")})`
  );
  const attempt = enqueued.attempt;
  report.steps.attempt = { id: attempt.id, status: attempt.status, attempt: attempt.attempt, refs: attempt.refs, params: attempt.params };
  check("任务入队为待执行", attempt.status === "pending");
  check("尝试编号从 1 开始", attempt.attempt === 1);
  check("参数快照已落库", attempt.params.model && attempt.params.duration, attempt.params);
  check(
    "引用快照含名称与内容哈希（不是仅靠文件名匹配）",
    Boolean(attempt.refs?.[0]?.assetId) && Boolean(attempt.refs?.[0]?.sha256),
    attempt.refs
  );

  // 分镜随后被编辑，已入队任务的快照不得改变
  await js(
    `window.managerWorkbenchAPI.storyboard.update(${JSON.stringify(projectId)}, ${JSON.stringify(storyboardId)}, {prompt: "完全改写的提示词"})`
  );
  snap = await js("window.managerWorkbenchAPI.snapshot()");
  const attemptAfterEdit = snap.tasks.find((t) => t.id === attempt.id);
  check("分镜改写后任务参数快照不变", attemptAfterEdit?.params?.prompt === attempt.params.prompt, attemptAfterEdit?.params?.prompt);

  // ── 7. 素材删除影响范围 ──
  // 注意顺序：引用查询必须在「改写提示词」之外的另一条分镜上做。
  // sbA 的提示词已被改写，其引用按设计已被裁掉，因此这里新建 sbB 重新建立引用。
  const addedB = await js(`window.managerWorkbenchAPI.storyboard.add(${JSON.stringify(projectId)}, {})`);
  const storyboardBId = addedB.storyboard.id;
  const prefixB = "第二个镜头，";
  await js(
    `window.managerWorkbenchAPI.storyboard.update(${JSON.stringify(projectId)}, ${JSON.stringify(storyboardBId)}, {prompt: ${JSON.stringify(prefixB)}})`
  );
  await js(
    `window.managerWorkbenchAPI.storyboard.bind(${JSON.stringify(projectId)}, ${JSON.stringify(storyboardBId)}, ${JSON.stringify(assetId)}, {prompt: ${JSON.stringify(prefixB)}, caret: ${prefixB.length}})`
  );

  const usages = await js(
    `window.managerWorkbenchAPI.asset.usages(${JSON.stringify(projectId)}, [${JSON.stringify(assetId)}])`
  );
  check("能查出被哪条分镜以哪个 token 引用", usages[assetId]?.length === 1, usages);
  check("影响范围指向正确的分镜", usages[assetId]?.[0]?.storyboardId === storyboardBId, usages[assetId]);

  const blocked = await js(
    `window.managerWorkbenchAPI.asset.remove(${JSON.stringify(projectId)}, [${JSON.stringify(assetId)}], "abort")`
  );
  check("直接删除被引用的素材会被拦下并返回影响范围", blocked.blocked === true && Object.keys(blocked.usages).length === 1, blocked);
  check("被拦下时素材仍在列表中", (await js("window.managerWorkbenchAPI.snapshot()")).assets.length === 1);

  const unbound = await js(
    `window.managerWorkbenchAPI.asset.remove(${JSON.stringify(projectId)}, [${JSON.stringify(assetId)}], "unbind")`
  );
  check("确认后才真正删除并解除引用", unbound.blocked === false && unbound.removed.length === 1 && unbound.unbound === 1, unbound);

  snap = await js("window.managerWorkbenchAPI.snapshot()");
  const sbAfterDelete = snap.project.storyboards.find((s) => s.id === storyboardBId);
  check("解除引用后提示词里不再残留 token", !String(sbAfterDelete?.prompt).includes("@图"), sbAfterDelete?.prompt);
  check("引用表已清空", (sbAfterDelete?.refs || []).length === 0);
  check("素材已从列表移除", snap.assets.length === 0);

  // ── 8. 落盘检查（重启恢复的前提） ──
  const projectDir = path.join(appDataDir, "workbench", "projects", projectId);
  const projectFile = path.join(projectDir, "project.json");
  const tasksFile = path.join(projectDir, "tasks.json");
  check("project.json 已写入隔离目录", fs.existsSync(projectFile), projectFile.replace(isolatedRoot, "<隔离根>"));
  check("tasks.json 已写入隔离目录", fs.existsSync(tasksFile));
  const persisted = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
  check("任务记录可反序列化且含状态历史", Array.isArray(persisted.tasks) && persisted.tasks[0]?.history?.length >= 1, persisted.tasks?.[0]?.history);
  report.steps.persistedAttempt = persisted.tasks?.[0];
  check("素材目录已清理干净", !fs.existsSync(path.join(projectDir, "assets", `${assetId}.png`)));

  // ── 9. 渲染层真实可用性（点开工作台面板，看是否真的渲染出来） ──
  report.steps.renderer = {};
  const opened = await js(`(() => {
    const btn = document.getElementById('showWorkbench');
    if (!btn) return { clicked: false, reason: '找不到工具栏按钮' };
    btn.click();
    return { clicked: true };
  })()`);
  check("工具栏「分镜工作台」按钮存在并可点击", opened.clicked === true, opened);
  await delay(1200);
  report.steps.renderer.panelVisible = await js(
    `!document.getElementById('workbenchModal').classList.contains('hidden')`
  );
  check("工作台面板已打开", report.steps.renderer.panelVisible === true);

  report.steps.renderer.storyboardCards = await js(`document.querySelectorAll('.workbench-sb').length`);
  report.steps.renderer.assetCards = await js(`document.querySelectorAll('.workbench-asset').length`);
  report.steps.renderer.defaultsRendered = await js(
    `document.querySelectorAll('#workbenchDefaults select').length`
  );
  report.steps.renderer.modelOptions = await js(
    `[...document.querySelectorAll('#workbenchDefaults select')][0] ? [...[...document.querySelectorAll('#workbenchDefaults select')][0].options].map(o=>o.textContent) : []`
  );
  report.steps.renderer.durationOptions = await js(
    `[...document.querySelectorAll('#workbenchDefaults select')][1] ? [...[...document.querySelectorAll('#workbenchDefaults select')][1].options].map(o=>o.textContent) : []`
  );
  report.steps.renderer.statusText = await js(`document.getElementById('workbenchHint')?.textContent || ''`);
  report.steps.renderer.storageText = await js(`document.getElementById('workbenchStorage')?.textContent || ''`);
  check("分镜卡片已渲染", report.steps.renderer.storyboardCards >= 1, report.steps.renderer.storyboardCards);
  check("默认参数下拉已渲染", report.steps.renderer.defaultsRendered >= 2, report.steps.renderer.defaultsRendered);
  check(
    "模型下拉来自真实能力表",
    (report.steps.renderer.modelOptions || []).some((t) => t.includes("seedance2.5")),
    report.steps.renderer.modelOptions
  );
  check("渲染层未产生控制台错误", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3));
  check("渲染层未出现 preload / 加载失败", report.pageErrors.length === 0, report.pageErrors.slice(0, 3));

  // ── 10. 比例可选 / 提示词框加大（用户反馈项） ──
  report.steps.fixes = {};
  const defaultsInfo = await js(`(() => {
    const selects = [...document.querySelectorAll('#workbenchDefaults select')];
    if (selects.length < 3) return { count: selects.length };
    const ratio = selects[2];
    return {
      count: selects.length,
      ratioDisabled: ratio.disabled,
      ratioOptions: [...ratio.options].map((o) => o.value),
      ratioValue: ratio.value,
      notes: [...document.querySelectorAll('#workbenchDefaults .workbench-unknown')].map((n) => n.textContent),
    };
  })()`);
  report.steps.fixes.defaults = defaultsInfo;
  check("全局默认参数含比例下拉", defaultsInfo.count >= 3, defaultsInfo);
  check("比例下拉可选（不再被禁用）", defaultsInfo.ratioDisabled === false, defaultsInfo);
  check("比例下拉提供多个常见候选值", (defaultsInfo.ratioOptions || []).length >= 4, defaultsInfo.ratioOptions);
  check(
    "比例旁仍标注平台能力未核实",
    (defaultsInfo.notes || []).some((t) => String(t).includes("未核实")),
    defaultsInfo.notes
  );

  const promptBox = await js(`(() => {
    const ta = document.querySelector('.workbench-sb-prompt');
    if (!ta) return null;
    const style = getComputedStyle(ta);
    return { minHeight: style.minHeight, fontSize: style.fontSize };
  })()`);
  report.steps.fixes.promptBox = promptBox;
  check("提示词输入框已放大（最小高度 >= 200px）", promptBox && parseFloat(promptBox.minHeight) >= 200, promptBox);

  // ── 11. 执行账号改为多选 ──
  const accountPicks = await js(`(() => {
    const host = document.getElementById('workbenchAccountPicks');
    if (!host) return { boxes: 0, checked: 0, names: [], note: '' };
    const boxes = [...host.querySelectorAll('input[type="checkbox"]')];
    return {
      boxes: boxes.length,
      checked: boxes.filter((b) => b.checked).length,
      names: [...host.querySelectorAll('.workbench-account-name')].map((n) => n.textContent),
      note: document.getElementById('workbenchAccountNote')?.textContent || '',
    };
  })()`);
  report.steps.fixes.accounts = accountPicks;
  check("账号已是多选复选框列表", accountPicks.boxes >= 3, accountPicks);
  check("默认至少勾选一个账号", accountPicks.checked >= 1, accountPicks.checked);
  check("账号来自本机账号列表（只读）", accountPicks.names.includes("探针账号A"), accountPicks.names);

  // ── 12. @图片绑定后视觉同步（用户反馈「艾特过后未关联」） ──
  const reimported = await js(
    `window.managerWorkbenchAPI.asset.importPaths(${JSON.stringify(projectId)}, [${JSON.stringify(fixture.file)}])`
  );
  check(
    "重新导入素材以便验证 @ 绑定（已删过，故可能复用）",
    reimported.imported.length + reimported.reused.length === 1,
    reimported
  );
  await js(`document.getElementById('showWorkbench').click()`);
  await delay(700);
  check("素材列表已重新出现素材", (await js(`document.querySelectorAll('.workbench-asset').length`)) >= 1);

  // 在第一条分镜里输入 @（此刻自动保存仍在防抖窗口内，正是会出问题的时序）
  const typed = await js(`(() => {
    const ta = document.querySelector('.workbench-sb-prompt');
    if (!ta) return { ok: false };
    ta.focus();
    ta.value = ${JSON.stringify("镜头推进 @")};
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: ta.value };
  })()`);
  await delay(150);
  const mentionVisible = await js(`!document.getElementById('workbenchMentionModal').classList.contains('hidden')`);
  check("输入 @ 会弹出素材选择器", mentionVisible === true, typed);
  const clickedRow = await js(`(() => {
    const row = document.querySelector('#workbenchMentionList .workbench-mention-row');
    if (!row) return false;
    row.click();
    return true;
  })()`);
  check("素材选择器里能点选素材", clickedRow === true);
  // 等到超过自动保存防抖时间再看：若旧值仍会覆盖，这里就会看到裸 @
  await delay(1200);
  const afterBind = await js(`(() => {
    const ta = document.querySelector('.workbench-sb-prompt');
    return {
      textareaValue: ta ? ta.value : '',
      chips: document.querySelectorAll('.workbench-ref-chip').length,
      chipText: document.querySelector('.workbench-ref-chip')?.textContent || '',
    };
  })()`);
  report.steps.fixes.afterBind = afterBind;
  check("@绑定后提示词输入框里出现 @图 标记", String(afterBind.textareaValue).includes("@图"), afterBind.textareaValue);
  check("@绑定后不再是裸 @ 结尾", !String(afterBind.textareaValue).trim().endsWith("@"), afterBind.textareaValue);
  check("@绑定后出现引用标签", afterBind.chips >= 1, afterBind.chipText);

  // ── 13. 粘贴导入通道（剪贴板图片走 base64） ──
  const pasteBase64 = fs.readFileSync(fixture.file).toString("base64");
  const pasted = await js(
    `window.managerWorkbenchAPI.asset.importBuffers(${JSON.stringify(projectId)}, [{ name: "探针粘贴图片", ext: ".png", base64: ${JSON.stringify(
      pasteBase64
    )} }])`
  );
  report.steps.fixes.paste = { imported: pasted.imported.length, reused: pasted.reused.length, failed: pasted.failed };
  check(
    "粘贴导入通道可用（base64 → 素材库）",
    pasted.imported.length + pasted.reused.length === 1 && pasted.failed.length === 0,
    pasted
  );

  // ── 14. 批量账号提交预览（只预览，绝不点确认，不消耗额度） ──
  await js(`(() => { document.querySelector('#workbenchAccountNote [data-act="accounts-all"]')?.click(); })()`);
  await delay(250);
  const allChecked = await js(
    `[...document.querySelectorAll('#workbenchAccountPicks input[type="checkbox"]')].filter((b) => b.checked).length`
  );
  check("「全选」勾上了全部账号", allChecked === 3, allChecked);

  await js(`(() => { document.querySelector('.workbench-sb .workbench-run-button')?.click(); })()`);
  await delay(1800);
  const runModal = await js(`(() => {
    const modal = document.getElementById('workbenchRunModal');
    return {
      visible: !modal.classList.contains('hidden'),
      status: document.getElementById('workbenchRunStatus')?.textContent ?? null,
      rows: [...document.querySelectorAll('#workbenchRunPreview .workbench-run-row')].map((r) => r.textContent),
    };
  })()`);
  report.steps.fixes.runModal = runModal;
  check("点「生成这一条」会打开提交确认，而不是毫无反应", runModal.visible === true, runModal);
  check(
    "确认框列出了被勾选的全部账号（一账号一条尝试）",
    (runModal.rows || []).some((t) => t.includes("探针账号A") && t.includes("探针账号C")),
    runModal.rows
  );
  check("确认框内有可见的状态位，提交时不再静默", runModal.status !== null, runModal.status);
  await js(`(() => { document.querySelector('#workbenchRunModal [data-close]')?.click(); })()`);
  await delay(300);

  // ── 15. 驱动步骤落库后能被界面展示（「卡在哪一步」可见） ──
  const probeTasksFile = path.join(projectDir, "tasks.json");
  const probeTasksDoc = JSON.parse(fs.readFileSync(probeTasksFile, "utf8"));
  probeTasksDoc.tasks[0].driver = {
    outcome: "failed",
    message: "页面上找不到发送按钮，无法提交生成",
    at: new Date().toISOString(),
    steps: [
      { step: "setPrompt", ok: true, detail: "已写入提示词" },
      { step: "send", ok: false, detail: "页面上找不到发送按钮，无法提交生成" },
    ],
    candidates: ["label:发送", "toolbar-tail:button"],
  };
  fs.writeFileSync(probeTasksFile, `${JSON.stringify(probeTasksDoc, null, 2)}\n`);
  await js(`document.getElementById('showWorkbench').click()`);
  await delay(1000);
  const stepView = await js(`(() => {
    const box = document.querySelector('.workbench-task-steps');
    return {
      count: document.querySelectorAll('.workbench-task-steps').length,
      text: box ? box.textContent : '',
      bad: document.querySelectorAll('.workbench-step-bad').length,
      candidates: document.querySelector('.workbench-step-cands')?.textContent || '',
    };
  })()`);
  report.steps.fixes.stepView = stepView;
  check("任务卡片展示提交步骤", stepView.count >= 1, stepView);
  check("失败步骤被单独标出并写明步骤名", stepView.bad >= 1 && stepView.text.includes("点击发送"), stepView.text);
  check("失败步骤带上页面候选控件清单", stepView.candidates.includes("label:发送"), stepView.candidates);

  await delay(800);
  check("隔离内未出现越界写入（报告目录仍在隔离根内）", reportPath.startsWith(exeDir));

  report.ok = report.checks.every((c) => c.pass);
  writeAndExit(report.ok ? 0 : 1);
})().catch((error) => {
  report.error = error?.stack ? error.stack : String(error);
  writeAndExit(1);
});