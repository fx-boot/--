"use strict";
/**
 * 离线单元测试：工作台数据层（项目 / 分集 / 素材 / 任务）增删改查与并发边界
 *
 * 覆盖：新增 / 修改 / 删除 / 重启加载 / 并发读写，以及 v0.6.11 一轮修复项的回归断言
 *      （B1 未知状态、B2 缺素材阻断、B3 索引损坏重建、B4 删除保护、B5 看门狗、
 *        B8 分集编号、B10 状态迁移、B14/B15 素材删除、B16 批量清理）。
 * 约束：不依赖 Electron、不启动界面、不访问网络、不消耗任何平台额度。
 *      （素材缩略图与图片尺寸依赖 Electron 的 nativeImage，源码里已 try/catch 兜底，
 *        因此素材导入/删除可以在纯 node 下验证。）
 *
 * 用法：node tools/workbench-crud-guard.test.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "app", "src");
const { briefOf, createStore, normalizeProject, syncRefsFromPrompt } = require(path.join(SRC, "workbench-store.js"));
const {
  DOWNLOAD_STATUS,
  STATUS,
  canTransition,
  createTaskStore,
  isActive,
  normalizeAttempt,
} = require(path.join(SRC, "workbench-task-store.js"));
const { buildPlan, validateParams } = require(path.join(SRC, "workbench-platform.js"));
const { createRunner } = require(path.join(SRC, "workbench-runner.js"));
const { createAssets } = require(path.join(SRC, "workbench-assets.js"));
const { VIDEO_CAPABILITIES } = require(path.join(SRC, "video-capabilities.js"));

const results = [];
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push(`  [通过] ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`  [失败] ${name}\n         ${error && error.message ? error.message : error}`);
  }
}

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "dbm-workbench-test-"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const PARAMS = { model: "seedance2.5", duration: "10", ratio: "16:9", removeWatermark: true, prompt: "测试提示词" };

async function main() {
  // ── 一、项目 / 分集：新增、修改、删除、重启加载 ──────────────
  await test("新增项目：文件落盘、索引选中新项目并带提示词摘要", async () => {
    const root = tempRoot();
    const store = createStore(root);
    store.ensure();
    const { project } = await store.createProject("测试项目");
    assert.ok(fs.existsSync(path.join(root, "projects", project.id, "project.json")), "project.json 应已落盘");
    assert.ok(fs.existsSync(path.join(root, "projects", project.id, "assets")), "assets 目录应已创建");
    const index = await store.readIndex();
    assert.equal(index.currentProjectId, project.id);
    assert.equal(index.projects.length, 1);
    assert.equal(index.projects[0].refCount, 0);
    assert.equal(index.projects[0].promptPreview, "");

    const saved = await store.updateProject(project.id, (draft) => {
      draft.storyboards = [
        { id: "", name: "视频创作", prompt: "一只猫在跑 @图1", refs: [{ assetId: "asset_0123456789ab", token: "@图1" }] },
      ];
    });
    assert.equal(saved.storyboards.length, 1);
    const after = await store.readIndex();
    assert.equal(after.projects[0].promptPreview, "一只猫在跑 @图1");
    assert.equal(after.projects[0].refCount, 1);
  });

  await test("修改项目：同一项目并发写入按队列串行，不丢更新", async () => {
    const store = createStore(tempRoot());
    store.ensure();
    const { project } = await store.createProject("并发修改");
    await Promise.all(
      Array.from({ length: 12 }, () =>
        store.updateProject(project.id, async (draft) => {
          await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15)));
          draft.generation = (Number(draft.generation) || 1) + 1;
        })
      )
    );
    const saved = await store.readProject(project.id);
    assert.equal(saved.generation, 13, "12 次并发自增都应落盘（旧实现会互相覆盖）");
  });

  await test("并发新建分集：服务端串行编号，不出现同名分集", async () => {
    const store = createStore(tempRoot());
    store.ensure();
    const { project: parent } = await store.createProject("大项目");
    const created = await Promise.all(
      [1, 2, 3].map(() => store.createProject("", { parentId: parent.id, episodeNumbering: true }))
    );
    const names = created.map((item) => item.project.name).sort();
    assert.deepEqual(names, ["第 1 集", "第 2 集", "第 3 集"]);
  });

  await test("并发新建项目：索引串行写入，条目与目录一一对应", async () => {
    const root = tempRoot();
    const store = createStore(root);
    store.ensure();
    await Promise.all(Array.from({ length: 6 }, (_, i) => store.createProject(`项目${i}`)));
    const index = await store.readIndex();
    assert.equal(index.projects.length, 6);
    for (const entry of index.projects) {
      assert.ok(fs.existsSync(path.join(root, "projects", entry.id, "project.json")));
    }
  });

  await test("删除项目：有分集时默认拒绝；cascade 时连同分集一起删除", async () => {
    const root = tempRoot();
    const store = createStore(root);
    store.ensure();
    const { project: parent } = await store.createProject("大项目");
    const { project: episode } = await store.createProject("第 1 集", { parentId: parent.id });
    await assert.rejects(() => store.deleteProject(parent.id), /分集/, "默认必须拒绝删除带分集的项目");
    const result = await store.deleteProject(parent.id, { cascade: true });
    assert.deepEqual([...result.removed].sort(), [parent.id, episode.id].sort());
    assert.equal(result.cleanupFailed.length, 0);
    assert.equal((await store.readIndex()).projects.length, 0);
    assert.ok(!fs.existsSync(path.join(root, "projects", episode.id)), "分集目录应一并删除");
  });

  await test("重启加载：新实例读到同一份项目 / 分集 / 引用", async () => {
    const root = tempRoot();
    const first = createStore(root);
    first.ensure();
    const { project } = await first.createProject("重启");
    await first.updateProject(project.id, (draft) => {
      draft.storyboards = [
        { id: "", name: "视频创作", prompt: "海边日落 @图1", refs: [{ assetId: "asset_0123456789ab", token: "@图1" }] },
      ];
    });
    const second = createStore(root);
    const index = await second.readIndex();
    const opened = await second.openProject(project.id);
    assert.equal(opened.storyboards.length, 1);
    assert.equal(opened.storyboards[0].prompt, "海边日落 @图1");
    assert.equal(opened.storyboards[0].refs.length, 1);
    assert.equal(opened.storyboards[0].refs[0].assetId, "asset_0123456789ab");
    assert.equal(index.projects[0].promptPreview, "海边日落 @图1");
  });

  await test("索引损坏：先备份再从 projects 目录重建，项目不会凭空消失", async () => {
    const root = tempRoot();
    const store = createStore(root);
    store.ensure();
    const { project } = await store.createProject("损坏测试");
    fs.writeFileSync(path.join(root, "projects.json"), "{ 这不是合法的 JSON", "utf8");
    const index = await store.readIndex();
    assert.equal(index.projects.length, 1);
    assert.equal(index.projects[0].id, project.id);
    assert.equal(fs.readdirSync(root).filter((name) => name.includes(".corrupt-")).length, 1, "损坏文件应先取证备份");
    assert.equal(store.recoveryInfo()?.projectCount, 1);
  });

  await test("旧版索引（缺摘要字段）：读取时自愈补全，不显示为空", async () => {
    const root = tempRoot();
    const store = createStore(root);
    store.ensure();
    const { project } = await store.createProject("旧索引");
    await store.updateProject(project.id, (draft) => {
      draft.storyboards = [{ id: "", name: "视频创作", prompt: "旧版索引测试" }];
    });
    const file = path.join(root, "projects.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.projects = raw.projects.map(({ id, name, parentId, createdAt, updatedAt }) => ({
      id, name, parentId, createdAt, updatedAt,
    }));
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");

    const fresh = createStore(root);
    const index = await fresh.readIndex();
    assert.equal(index.projects[0].promptPreview, "旧版索引测试");
  });

  // ── 二、素材：导入、去重、删除顺序 ──────────────────────────
  await test("素材：按内容去重（assetId 由 sha256 派生），删除后索引与文件同时消失", async () => {
    const root = tempRoot();
    const store = createStore(root);
    store.ensure();
    const { project } = await store.createProject("素材项目");
    const assets = createAssets(store);
    const source = path.join(root, "sample.png");
    fs.writeFileSync(
      source,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
    );

    const first = await assets.importPaths(project.id, [source]);
    assert.equal(first.imported.length, 1, "首次导入应新增 1 张");
    const assetId = first.imported[0].id;
    assert.match(assetId, /^asset_[0-9a-f]{12}$/, "assetId 应由内容哈希派生");

    const again = await assets.importPaths(project.id, [source]);
    assert.equal(again.imported.length, 0);
    assert.equal(again.reused.length, 1, "同一张图重复导入应复用同一 assetId");
    assert.equal(again.reused[0].id, assetId);

    const removed = await assets.remove(project.id, [assetId]);
    assert.equal(removed.length, 1);
    assert.equal((await assets.list(project.id)).length, 0, "catalog 应已移除记录");
    assert.ok(!fs.existsSync(path.join(store.assetsDir(project.id), removed[0].fileName)), "素材文件应已删除");
    assert.deepEqual(await assets.remove(project.id, [assetId]), [], "重复删除应幂等");
  });

  // ── 三、任务记录：状态、并发、清理 ──────────────────────────
  await test("任务状态未知：判为「需人工处理」，绝不再进入自动提交", async () => {
    const record = normalizeAttempt({
      id: "att_aaaaaaaaaaaa",
      projectId: "prj_x",
      storyboardId: "sb_x",
      accountId: "acc",
      status: "记录被损坏",
      params: PARAMS,
      refs: [],
    });
    assert.equal(record.status, STATUS.MANUAL);
    assert.equal(isActive(record.status), false);
    assert.equal(record.error.code, "UNKNOWN_STATUS");
    assert.ok(record.history.some((item) => /无法识别/.test(item.note)), "应在历史里留痕");
    assert.equal([record].filter((task) => task.status === STATUS.PENDING).length, 0, "tick 准入条件是 pending");
  });

  await test("状态迁移：非法迁移被拒绝、同状态幂等、待确认可收尾", () => {
    assert.equal(canTransition(STATUS.MANUAL, STATUS.FAILED), false, "需人工处理 → 失败 属非法迁移");
    assert.equal(canTransition(STATUS.MANUAL, STATUS.MANUAL), true);
    assert.equal(canTransition(STATUS.UNCONFIRMED, STATUS.MANUAL), true, "监控超时收尾必须允许");
    assert.equal(canTransition(STATUS.SUCCEEDED, STATUS.PENDING), false);
  });

  await test("任务并发写入：20 条并行追加全部保留；重启后仍可读", async () => {
    const root = tempRoot();
    const taskStore = createTaskStore(() => root);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        taskStore.append("prj_y", {
          id: `att_${String(index).padStart(2, "0")}_x`,
          projectId: "prj_y",
          storyboardId: "sb_y",
          accountId: "acc",
          status: STATUS.PENDING,
          params: PARAMS,
          refs: [],
        })
      )
    );
    assert.equal((await taskStore.list("prj_y")).length, 20);
    assert.equal((await createTaskStore(() => root).list("prj_y")).length, 20, "重启后应读到同一份记录");
  });

  await test("任务文件损坏：备份后返回空表，不静默清空且不影响后续写入", async () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "tasks.json"), "{ 坏数据", "utf8");
    const taskStore = createTaskStore(() => root);
    assert.equal((await taskStore.list("prj_z")).length, 0);
    assert.equal(fs.readdirSync(root).filter((name) => name.includes(".corrupt-")).length, 1, "损坏文件应先备份");
    await taskStore.append("prj_z", { projectId: "prj_z", storyboardId: "sb_z", accountId: "acc", status: STATUS.PENDING, params: PARAMS, refs: [] });
    assert.equal((await taskStore.list("prj_z")).length, 1);
  });

  await test("批量清理：只清「生成成功且下载未在进行」的记录，失败与未完成一律保留", async () => {
    const root = tempRoot();
    const taskStore = createTaskStore(() => root);
    const base = { projectId: "prj_c", storyboardId: "sb_c", accountId: "acc", params: PARAMS, refs: [] };
    await taskStore.append("prj_c", { ...base, id: "att_done000001", status: STATUS.SUCCEEDED, download: { status: DOWNLOAD_STATUS.DONE } });
    await taskStore.append("prj_c", { ...base, id: "att_paused0001", status: STATUS.SUCCEEDED, download: { status: DOWNLOAD_STATUS.PAUSED } });
    await taskStore.append("prj_c", { ...base, id: "att_failed0001", status: STATUS.FAILED });
    await taskStore.append("prj_c", { ...base, id: "att_manual0001", status: STATUS.MANUAL });
    await taskStore.append("prj_c", { ...base, id: "att_pending001", status: STATUS.PENDING });

    const result = await taskStore.clear("prj_c");
    assert.equal(result.removed, 1);
    assert.deepEqual(result.removedIds, ["att_done000001"]);
    assert.equal(result.skipped.length, 1, "下载暂停的记录应被保留并说明原因");
    const left = (await taskStore.list("prj_c")).map((task) => task.id).sort();
    assert.deepEqual(left, ["att_failed0001", "att_manual0001", "att_paused0001", "att_pending001"]);
    await assert.rejects(() => taskStore.clear("prj_c", { statuses: ["pending"] }), /只能清理已结束的任务/);
  });

  // ── 四、平台校验：缺素材必须阻断（与 resolveAssets 的存在性校验配合） ──
  await test("提交前校验：引用的素材没有本地文件时必须阻断提交", () => {
    const attempt = { id: "att_blocked001", params: { ...PARAMS, prompt: "画面 @图1" }, refs: [{ assetId: "asset_0123456789ab", token: "@图1", name: "图" }] };
    const plan = buildPlan({ target: "dola", attempt, assetsById: new Map(), capabilities: VIDEO_CAPABILITIES });
    assert.equal(plan.valid, false, "引用未解析出本地文件时必须 invalid");
    assert.ok(plan.errors.join("；").includes("参考图"), `错误信息应指明参考图缺失：${plan.errors.join("；")}`);

    const okPlan = buildPlan({
      target: "dola",
      attempt,
      assetsById: new Map([["asset_0123456789ab", { filePath: "C:/tmp/a.png", name: "图" }]]),
      capabilities: VIDEO_CAPABILITIES,
    });
    assert.equal(okPlan.valid, true, "有本地文件时应通过校验");
    assert.deepEqual(okPlan.uploads, ["C:/tmp/a.png"]);
  });

  await test("参数校验：提示词为空必须报错；数量上限未核实时只警告不编造", () => {
    const empty = validateParams({ target: "dola", params: { ...PARAMS, prompt: "" }, refs: [], capabilities: VIDEO_CAPABILITIES });
    assert.equal(empty.ok, false);

    const refs = Array.from({ length: 12 }, (_, i) => ({ token: `@图${i + 1}`, filePath: "C:/tmp/a.png" }));
    const unknown = validateParams({ target: "dola", params: { ...PARAMS, prompt: "x" }, refs, capabilities: VIDEO_CAPABILITIES });
    assert.equal(unknown.ok, true);
    assert.ok(unknown.warnings.some((line) => line.includes("上限")));

    const declared = clone(VIDEO_CAPABILITIES);
    declared.targets.dola.maxReferenceImages = 3;
    const over = validateParams({ target: "dola", params: { ...PARAMS, prompt: "x" }, refs, capabilities: declared });
    assert.equal(over.ok, false, "超过已声明上限应拒绝");

    const badModel = validateParams({ target: "dola", params: { ...PARAMS, model: "seedance9.9", prompt: "x" }, refs: [], capabilities: VIDEO_CAPABILITIES });
    assert.equal(badModel.ok, false);
    const badRatio = validateParams({ target: "dola", params: { ...PARAMS, ratio: "7:5", prompt: "x" }, refs: [], capabilities: VIDEO_CAPABILITIES });
    assert.equal(badRatio.ok, false);
  });

  // ── 五、调度：准入与看门狗 ─────────────────────────────────
  await test("队列准入：只有 pending 会被提交，损坏状态（需人工处理）不会被自动提交", async () => {
    const root = tempRoot();
    const taskStore = createTaskStore(() => root);
    const submitted = [];
    const driver = {
      async submit({ attempt }) {
        submitted.push(attempt.id);
        return { outcome: "accepted", accepted: true, platformTaskId: `plat_${attempt.id}`, steps: [] };
      },
      async poll() {
        return { status: "generating", message: "生成中" };
      },
    };
    const base = { projectId: "prj_q", storyboardId: "sb_q", accountId: "acc_q", params: PARAMS, refs: [] };
    await taskStore.append("prj_q", { ...base, id: "att_pending0001", status: STATUS.PENDING });
    await taskStore.append("prj_q", { ...base, id: "att_broken0001", status: "未知状态" });
    const runner = createRunner({
      taskStore,
      driver,
      capabilities: VIDEO_CAPABILITIES,
      listProjectIds: async () => ["prj_q"],
      schedule: () => 0,
      cancelSchedule: () => {},
      onChanged: () => {},
      log: () => {},
    });
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(submitted, ["att_pending0001"], "只允许提交 pending 任务");
    const list = await taskStore.list("prj_q");
    assert.equal(list.find((task) => task.id === "att_broken0001").status, STATUS.MANUAL);
    runner.pause();
  });

  await test("重启恢复：长时间无更新的在途任务收尾为需人工处理（看门狗默认 30 分钟）", async () => {
    const root = tempRoot();
    const taskStore = createTaskStore(() => root);
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await taskStore.append("prj_r", {
      projectId: "prj_r",
      storyboardId: "sb_r",
      accountId: "acc_r",
      id: "att_stale00001",
      status: STATUS.GENERATING,
      createdAt: stale,
      updatedAt: stale,
      poll: { lastAt: stale },
      params: PARAMS,
      refs: [],
    });
    const runner = createRunner({
      taskStore,
      driver: { async poll() { return { status: "generating", message: "生成中" }; } },
      capabilities: VIDEO_CAPABILITIES,
      listProjectIds: async () => ["prj_r"],
      schedule: () => 0,
      cancelSchedule: () => {},
      onChanged: () => {},
      log: () => {},
    });
    await runner.recover();
    const record = (await taskStore.list("prj_r"))[0];
    assert.equal(record.status, STATUS.MANUAL, "超期在途任务必须收尾，不能永远「生成中」");
    assert.equal(record.poll.stale, true);
    runner.pause();
  });

  // ── 六、纯函数：摘要与引用同步 ─────────────────────────────
  await test("纯函数：briefOf 生成摘要与引用数；syncRefsFromPrompt 按出现顺序重建引用", () => {
    const brief = briefOf(normalizeProject({ storyboards: [{ prompt: "  多行\n文本 @图1 ", refs: [{ assetId: "asset_0123456789ab", token: "@图1" }] }] }, "prj_brief"));
    assert.equal(brief.promptPreview, "多行 文本 @图1");
    assert.equal(brief.refCount, 1);

    const { refs, dropped } = syncRefsFromPrompt("先 @图2 后 @图1", [
      { assetId: "asset_0123456789ab", token: "@图1" },
      { assetId: "asset_abcdefghijkl", token: "@图2" },
    ]);
    assert.deepEqual(refs.map((ref) => ref.token), ["@图2", "@图1"]);
    assert.deepEqual(dropped, []);
  });

  // ── 汇总 ────────────────────────────────────────────────
  console.log("\n工作台增删改查 / 并发边界 离线单元测试");
  console.log(results.join("\n"));
  console.log(`\n共 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("测试脚本异常：", error);
  process.exit(1);
});