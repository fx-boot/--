#!/usr/bin/env node
/**
 * 阶段 2 引擎离线测试（不依赖 Electron、不接触平台、不消耗任何账号额度）
 *
 * 覆盖：任务状态机与非法迁移、参数/引用快照不可变、重试=新尝试、下载状态独立、
 * 平台结果双键匹配、能力校验拒绝不支持参数、结构化引用分段位置、
 * 编排层全流程（含“提交结果待确认”绝不重复提交）、取消语义、下载命名不覆盖。
 *
 * 用法：node tools/workbench-engine.test.cjs
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "app", "src");
const task = require(path.join(SRC, "workbench-task-store.js"));
const platform = require(path.join(SRC, "workbench-platform.js"));
const { createRunner, classifyBlock, summarizeDriver } = require(path.join(SRC, "workbench-runner.js"));
const download = require(path.join(SRC, "workbench-download.js"));
const { createAssets } = require(path.join(SRC, "workbench-assets.js"));
const { VIDEO_CAPABILITIES } = require(path.join(SRC, "video-capabilities.js"));
const store = require(path.join(SRC, "workbench-store.js"));

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function throws(name, fn, match) {
  try {
    fn();
    check(name, false, "未抛错");
  } catch (error) {
    check(name, !match || match.test(error.message), error.message);
  }
}

function createFakeScheduler() {
  let seq = 0;
  const pending = new Map();
  return {
    schedule(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    async flush(limit = 30) {
      let ran = 0;
      while (pending.size && ran < limit) {
        const [id, item] = pending.entries().next().value;
        pending.delete(id);
        ran++;
        await item.fn();
      }
      return ran;
    },
    get size() {
      return pending.size;
    },
  };
}

async function main() {
  const CAPS = VIDEO_CAPABILITIES;

  // ══ 0. 模块可加载性与导出完整性 ══
  // node --check 只能查语法；「导出了未声明的标识符」这类错误只在真实 require 时暴露
  // （workbench-dola-driver 曾因 module.exports 里多写了一个工厂内部函数而整包启动失败）。
  console.log("── 模块加载 ──");
  for (const file of [
    "workbench-task-store.js",
    "workbench-platform.js",
    "workbench-runner.js",
    "workbench-download.js",
    "workbench-store.js",
    "workbench-assets.js",
  ]) {
    try {
      require(path.join(SRC, file));
      check(`可加载 ${file}`, true);
    } catch (error) {
      check(`可加载 ${file}`, false, error.message);
    }
  }
  for (const file of ["workbench-dola-driver.js", "workbench-task-service.js", "workbench-service.js"]) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    const block = /module\.exports\s*=\s*\{([\s\S]*?)\}/.exec(src);
    if (!block) {
      check(`${file} 有 module.exports`, false);
      continue;
    }
    const names = block[1]
      .split(",")
      .map((part) => part.trim().split(":")[0].trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    // 模块作用域声明：函数（含 async）、类、const/let/var，以及解构导入
    const destructured = [...src.matchAll(/(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim().split(":")[0].trim()))
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    // 模块作用域声明必须出现在「列 0」：这里刻意不加 \s*，
    // 否则工厂函数内部（缩进）的同名声明也会被误判为模块作用域 —— 该漏洞曾让
    // 「导出工厂内部函数」的缺陷逃过检查，直到隔离探针启动时才暴露。
    const declared = (name) =>
      new RegExp(`(?:^|\\n)(?:async\\s+)?function\\s+${name}\\b`).test(src) ||
      new RegExp(`(?:^|\\n)class\\s+${name}\\b`).test(src) ||
      new RegExp(`(?:^|\\n)(?:const|let|var)\\s+${name}\\b`).test(src) ||
      destructured.includes(name);
    const missing = names.filter((name) => !declared(name));
    check(`${file} 导出的标识符都在模块作用域声明`, missing.length === 0, missing);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-engine-test-"));
  const projectId = "prj_test";
  const taskStore = task.createTaskStore((id) => path.join(root, id));

  // ══ 1. 状态机 ══
  console.log("── 状态机 ──");
  const rec = task.createAttempt({
    projectId,
    storyboardId: "sb_1",
    accountId: "acc_1",
    params: { model: "seedance2.5", duration: "10", prompt: "推门 @图1" },
    refs: [{ assetId: "asset_a", token: "@图1", name: "门", sha256: "aa" }],
  });
  eq("初始为待执行", rec.status, task.STATUS.PENDING);
  check("初始历史有 1 条", rec.history.length === 1);
  task.applyStatus(rec, task.STATUS.SUBMITTING);
  eq("待执行→提交中", rec.status, "submitting");
  task.applyStatus(rec, task.STATUS.QUEUED);
  task.applyStatus(rec, task.STATUS.GENERATING);
  task.applyStatus(rec, task.STATUS.SUCCEEDED);
  eq("走到生成成功", rec.status, "succeeded");
  throws("生成成功后不允许再迁移", () => task.applyStatus(rec, task.STATUS.GENERATING), /不允许的状态迁移/);
  throws(
    "待执行不允许直接跳到生成成功",
    () => task.applyStatus(task.createAttempt({ projectId, storyboardId: "sb_2", accountId: "acc_1" }), task.STATUS.SUCCEEDED),
    /不允许的状态迁移/
  );
  check("状态中文名齐全", Object.keys(task.STATUS).length === Object.keys(task.STATUS_LABEL).length);
  eq("状态共 9 种", Object.keys(task.STATUS).length, 9);
  eq("登录失效被识别为账号阻塞", classifyBlock("登录状态已失效，请重新登录")?.code, "AUTH");
  eq("验证码被识别", classifyBlock("请完成验证码")?.code, "CAPTCHA");
  eq("限额被识别", classifyBlock("今日额度已用完")?.code, "QUOTA");

  // ══ 1b. 本轮修复回归（离线、不接触平台） ══
  console.log("── 本轮修复回归 ──");
  // AUTH 误判：网络摘要里的裸 401/403 数字不能被当成登录失效，否则账号会被误封
  eq(
    "网络摘要里的 403 不再误判为登录失效",
    classifyBlock("观察到的请求：RESP /list→403 | POST /chat/completion→200"),
    null
  );
  eq("明确的 HTTP 403 仍判为登录失效", classifyBlock("HTTP 403 Forbidden")?.code, "AUTH");
  // 状态幂等：重复写入同一状态不再抛错（否则轮询的计数与错误信息会整段回滚）
  const idem = task.createAttempt({ projectId, storyboardId: "sb_idem", accountId: "acc_1" });
  task.applyStatus(idem, task.STATUS.MANUAL);
  task.applyStatus(idem, task.STATUS.MANUAL, "再次确认");
  eq("重复写入同一状态不抛错且状态不变", idem.status, "manual");
  // 项目级 settings 必须被归一化保留：任务服务靠它保存「生成成功后自动下载」
  const preserved = store.normalizeProject({ id: "prj_x", settings: { autoDownload: true } }, "prj_x");
  eq("项目级 settings.autoDownload 被保留", preserved.settings.autoDownload, true);
  eq("未提供 settings 时补空对象", store.normalizeProject({ id: "prj_y" }, "prj_y").settings, {});

  // ══ 2. 快照不可变 ══
  console.log("── 快照不可变 ──");
  const snap = task.createAttempt({
    projectId,
    storyboardId: "sb_1",
    accountId: "acc_1",
    params: { model: "seedance2.0fast", duration: "5", prompt: "原始提示词 @图1" },
    refs: [{ assetId: "asset_a", token: "@图1", name: "旧名", sha256: "hash1" }],
  });
  await taskStore.append(projectId, snap);
  // 模拟分镜随后被编辑：改名、改提示词、解除引用
  const editedStoryboard = { name: "改名后的分镜", prompt: "完全不同的提示词", refs: [] };
  const after = (await taskStore.list(projectId)).find((t) => t.id === snap.id);
  eq("提示词快照不受分镜编辑影响", after.params.prompt, "原始提示词 @图1");
  eq("素材引用快照不受影响", after.refs, [{ assetId: "asset_a", token: "@图1", name: "旧名", sha256: "hash1" }]);
  check("分镜改名不写入任务快照", editedStoryboard.name !== after.storyboardName);

  // ══ 3. 重试 = 新尝试 ══
  console.log("── 重试新尝试 ──");
  eq("首个尝试编号为 1", snap.attempt, 1);
  const tasksNow = await taskStore.list(projectId);
  eq("同分镜下一个编号为 2", task.nextAttemptNumber(tasksNow, projectId, "sb_1"), 2);

  // ══ 4. 下载状态独立 ══
  console.log("── 下载状态独立 ──");
  const dl = task.createAttempt({ projectId, storyboardId: "sb_3", accountId: "acc_1" });
  task.applyStatus(dl, task.STATUS.SUBMITTING);
  task.applyStatus(dl, task.STATUS.SUCCEEDED);
  task.setResult(dl, { videoUrl: "https://example.com/a.mp4", width: 1920, height: 1080 });
  task.setDownload(dl, task.DOWNLOAD_STATUS.RUNNING);
  task.setDownload(dl, task.DOWNLOAD_STATUS.FAILED, { message: "网络中断" });
  eq("下载失败不改生成状态", dl.status, "succeeded");
  eq("下载失败不改错误字段", dl.error, null);
  eq("下载状态本身为失败", dl.download.status, "failed");
  eq("下载重试次数被记录", dl.download.attempts, 1);
  eq("结果信息仍在", dl.result.width, 1920);
  throws("未知下载状态被拒绝", () => task.setDownload(dl, "weird"), /未知下载状态/);

  // ══ 5. 平台结果双键匹配 ══
  console.log("── 平台结果归属 ──");
  const list = [
    task.normalizeAttempt({ id: "att_a", projectId, storyboardId: "sb_1", accountId: "acc_1", platformTaskId: "task_9" }),
    task.normalizeAttempt({ id: "att_b", projectId, storyboardId: "sb_2", accountId: "acc_2", platformTaskId: "task_9" }),
  ];
  eq("账号正确时命中自身记录", task.matchByPlatformTask(list, "acc_1", "task_9").record?.id, "att_a");
  check("账号不匹配时拒绝关联", task.matchByPlatformTask(list, "acc_3", "task_9").record === null);
  check("拒绝原因可读", /归属其他账号/.test(task.matchByPlatformTask(list, "acc_3", "task_9").reason));
  check("无平台任务 ID 时不匹配", task.matchByPlatformTask(list, "acc_1", "").record === null);

  // ══ 6. 能力校验 ══
  console.log("── 能力校验 ──");
  const okParams = { model: "seedance2.5", duration: "10", prompt: "推门" };
  check("合法参数通过", platform.validateParams({ params: okParams, capabilities: CAPS }).ok);
  check(
    "不支持的模型被拒绝",
    platform.validateParams({ params: { ...okParams, model: "sora" }, capabilities: CAPS }).errors.join().includes("不在平台能力表")
  );
  check(
    "不支持的时长被拒绝",
    platform.validateParams({ params: { ...okParams, duration: "7" }, capabilities: CAPS }).errors.join().includes("不在平台"),
    platform.validateParams({ params: { ...okParams, duration: "7" }, capabilities: CAPS }).errors
  );
  check(
    "空提示词被拒绝",
    platform.validateParams({ params: { ...okParams, prompt: "  " }, capabilities: CAPS }).ok === false
  );
  check(
    "引用缺本地文件被拒绝",
    platform
      .validateParams({ params: okParams, refs: [{ token: "@图1" }], capabilities: CAPS })
      .errors.join()
      .includes("缺少本地文件")
  );
  const ratioWarn = platform.validateParams({ params: { ...okParams, ratio: "16:9" }, capabilities: CAPS });
check("已核实的比例不再产生任何比例告警", !/比例/.test(ratioWarn.warnings.join("；")), ratioWarn.warnings);
check("已核实的比例通过校验", ratioWarn.ok, ratioWarn.errors);
const refWarn = platform.validateParams({
    params: okParams,
    refs: [{ token: "@图1", filePath: "x.png" }],
    capabilities: CAPS,
  });
  check("参考图上限未知时给出警告", refWarn.warnings.join().includes("未声明参考图数量上限"));

  const described = platform.describeCapabilities(CAPS, "dola");
  eq("比例已核实（不再标记为未知）", described.unknown.ratio, false);
  eq("比例候选来自能力表", described.ratios.length, 6);
  eq("参考图上限标记为未知", described.unknown.maxReferenceImages, true);
  eq("额度标记为未知", described.unknown.quota, true);
  check("模型来自真实能力表", described.models.includes("seedance2.5"));
  check("模型带平台菜单文案", described.modelLabels.some((m) => m.value === "seedance2.5" && m.label === "Seedance 2.5"), described.modelLabels);

  // ══ 7. 结构化引用 → 分段（位置与顺序） ══
  console.log("── 引用分段 ──");
  const assetsById = new Map([
    ["asset_a", { name: "门", filePath: "A.png", sha256: "aa", width: 100, height: 200 }],
    ["asset_b", { name: "车", filePath: "B.png", sha256: "bb" }],
  ]);
  const segments = platform.buildSegments("开场 @图2 之后 @图1 结束", [
    { assetId: "asset_a", token: "@图1" },
    { assetId: "asset_b", token: "@图2" },
  ], assetsById);
  eq(
    "分段类型与顺序跟随文本",
    segments.map((s) => s.kind),
    ["text", "image", "text", "image", "text"]
  );
  eq("图片顺序按出现位置（先图2 后图1）", segments.filter((s) => s.kind === "image").map((s) => s.assetId), [
    "asset_b",
    "asset_a",
  ]);
  eq("文本段保留原文", segments[0].value, "开场 ");
  eq("图片段带本地文件路径", segments[1].filePath, "B.png");
  // 实测：平台编辑器不支持内联图片节点，写入 U+FFFC 只会变成方框（用户截图里的 OBJ）
  const platformText = platform.toPlatformText(segments);
  eq("提交文本把 @图N 写成参考图N", platformText, "开场 参考图2 之后 参考图1 结束");
  check("提交文本不再包含 U+FFFC 占位符", !platformText.includes("\uFFFC"), platformText);
  const ordered = platform.orderReferences(segments);
  eq("附件按 @图N 编号升序排列（参考图N = 第 N 个附件）", ordered.map((item) => item.label), ["参考图1", "参考图2"]);
  eq("参考图1 对应的是 @图1 绑定的素材", ordered[0].assetId, "asset_a");
  eq("每个引用带上传顺序", ordered.map((item) => item.order), [1, 2]);
  eq("无 token 时只有一段文本", platform.buildSegments("纯文本", [], assetsById).length, 1);

  const plan = platform.buildPlan({
    attempt: task.createAttempt({
      projectId,
      storyboardId: "sb_1",
      accountId: "acc_1",
      params: { ...okParams, prompt: "推门 @图1" },
      refs: [{ assetId: "asset_a", token: "@图1" }],
    }),
    assetsById,
    capabilities: CAPS,
  });
  check("计划有效", plan.valid);
  eq("计划内含 1 张上传图", plan.uploads, ["A.png"]);
  check("计划声明了进度百分比限制", plan.limitations.join().includes("进度百分比"));

  // ══ 8. 编排层全流程（假驱动，无真实调用） ══
  console.log("── 编排：正常闭环 ──");
  const sched = createFakeScheduler();
  const calls = { submit: 0, poll: 0, cancel: 0, verify: 0 };
  let pollScript = [];
  const driver = {
    async submit() {
      calls.submit++;
      return { outcome: "ok", platformTaskId: "pt_1", state: "queued", message: "已提交" };
    },
    async poll() {
      calls.poll++;
      return pollScript.shift() || { state: "generating", message: "生成中" };
    },
    async cancel() {
      calls.cancel++;
      return { canceled: true };
    },
    async verifySubmission() {
      calls.verify++;
      return { found: false };
    },
  };
  const runner = createRunner({
    taskStore,
    driver,
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
    pollBaseMs: 10,
    pollMaxMs: 20,
  });

  const goodParams = { ...okParams, prompt: "推门 @图1" };
  const goodRefs = [{ assetId: "asset_a", token: "@图1" }];
  const happy = await runner.enqueue({
    projectId,
    storyboardId: "sb_happy",
    storyboardName: "开篇",
    accountId: "acc_1",
    params: goodParams,
    refs: goodRefs,
  });
  eq("入队即待执行", happy.status, "pending");
  pollScript = [{ state: "generating", message: "生成中" }, { state: "succeeded", result: { videoUrl: "https://example.com/v.mp4", width: 1280, height: 720 } }];
  await runner.execute(projectId, happy.id);
  let happyNow = (await taskStore.list(projectId)).find((t) => t.id === happy.id);
  eq("提交后进入平台排队", happyNow.status, "queued");
  eq("平台任务 ID 已记录", happyNow.platformTaskId, "pt_1");
  check("提交时间已写入", Boolean(happyNow.submittedAt));
  await sched.flush();
  happyNow = (await taskStore.list(projectId)).find((t) => t.id === happy.id);
  eq("轮询后生成成功", happyNow.status, "succeeded");
  eq("结果地址已记录", happyNow.result.videoUrl, "https://example.com/v.mp4");
  check("状态历史含多次迁移", happyNow.history.length >= 4, happyNow.history.map((h) => h.status));
  check("轮询次数被记录", happyNow.poll.count >= 1);

  console.log("── 编排：提交结果不确定 ──");
  calls.submit = 0;
  calls.verify = 0;
  const unknownStore = task.createTaskStore((id) => path.join(root, "unknown-" + id));
  const unknownSched = createFakeScheduler();
  const unknownDriver = createRunner({
    taskStore: unknownStore,
    driver: {
      async submit() {
        calls.submit++;
        return { outcome: "unknown", message: "提交超时" };
      },
      async poll() {
        return { state: "generating" };
      },
      async verifySubmission() {
        calls.verify++;
        return { found: false, message: "未在平台找到该任务" };
      },
    },
    capabilities: CAPS,
    schedule: unknownSched.schedule,
    cancelSchedule: unknownSched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => ["prj_unknown"],
  });
  const unconfirmed = await unknownDriver.enqueue({
    projectId: "prj_unknown",
    storyboardId: "sb_unknown",
    accountId: "acc_1",
    params: goodParams,
    refs: goodRefs,
  });
  await unknownDriver.execute("prj_unknown", unconfirmed.id);
  const unconfirmedNow = (await unknownStore.list("prj_unknown")).find((t) => t.id === unconfirmed.id);
  eq("核实不到时标记提交结果待确认", unconfirmedNow.status, "unconfirmed");
  eq("提交只发生一次（未盲目重复提交）", calls.submit, 1);
  eq("确实做了核实", calls.verify, 1);
  // 待确认任务必须继续被监控：平台可能已受理并生成完成，或已明确拒绝（额度用尽等）。
  // 旧实现在这里不再安排轮询，任务就永远停在待确认（实测 2026-09-24）。
  check("待确认任务继续被监控（安排了轮询）", unknownSched.size >= 1, { size: unknownSched.size });
  eq("仍然只提交一次（监控不等于重发）", calls.submit, 1);

  console.log("── 编排：提交超时但核实到成功 ──");
  const verifyRunner = createRunner({
    taskStore,
    driver: {
      async submit() {
        return { outcome: "unknown" };
      },
      async poll() {
        return { state: "queued" };
      },
      async verifySubmission() {
        return { found: true, platformTaskId: "pt_recovered" };
      },
    },
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
  });
  const recovered = await verifyRunner.enqueue({
    projectId,
    storyboardId: "sb_recover",
    accountId: "acc_1",
    params: goodParams,
    refs: goodRefs,
  });
  await verifyRunner.execute(projectId, recovered.id);
  const recoveredNow = (await taskStore.list(projectId)).find((t) => t.id === recovered.id);
  eq("核实成功后进入排队", recoveredNow.status, "queued");
  eq("回收到的平台任务 ID 被采用", recoveredNow.platformTaskId, "pt_recovered");

  console.log("── 编排：账号异常 / 参数非法 ──");
  const blockedRunner = createRunner({
    taskStore,
    driver: {
      async submit() {
        return { outcome: "failed", message: "登录状态已失效，请重新登录", errorCode: "AUTH" };
      },
      async poll() {
        return { state: "unknown" };
      },
    },
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
  });
  const blockedAttempt = await blockedRunner.enqueue({
    projectId,
    storyboardId: "sb_auth",
    accountId: "acc_1",
    params: goodParams,
    refs: goodRefs,
  });
  await blockedRunner.execute(projectId, blockedAttempt.id);
  const blockedNow = (await taskStore.list(projectId)).find((t) => t.id === blockedAttempt.id);
  eq("登录失效标记需人工处理", blockedNow.status, "manual");
  eq("并且暂停了该账号", blockedRunner.status().blockedAccounts[0].code, "AUTH");
  const secondInBlocked = await blockedRunner.enqueue({
    projectId,
    storyboardId: "sb_auth2",
    accountId: "acc_1",
    params: goodParams,
    refs: goodRefs,
  });
  await blockedRunner.execute(projectId, secondInBlocked.id);
  const secondNow = (await taskStore.list(projectId)).find((t) => t.id === secondInBlocked.id);
  eq("账号暂停期间同一账号任务不再提交（直接标记人工）", secondNow.status, "manual");
  blockedRunner.clearAccountBlock("acc_1");

  let submitCalls = 0;
  const strictRunner = createRunner({
    taskStore,
    driver: {
      async submit() {
        submitCalls++;
        return { outcome: "ok", platformTaskId: "x", state: "queued" };
      },
      async poll() {
        return { state: "succeeded" };
      },
    },
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
  });
  const badAttempt = await strictRunner.enqueue({
    projectId,
    storyboardId: "sb_bad",
    accountId: "acc_2",
    params: { ...okParams, model: "sora", prompt: "推门 @图1" },
    refs: goodRefs,
  });
  await strictRunner.execute(projectId, badAttempt.id);
  const badNow = (await taskStore.list(projectId)).find((t) => t.id === badAttempt.id);
  eq("参数非法被拒绝提交", badNow.status, "manual");
  eq("驱动层完全未被调用", submitCalls, 0);

  console.log("── 编排：取消 ──");
  const cancelRunner = createRunner({
    taskStore,
    driver: {
      async submit() {
        return { outcome: "ok", platformTaskId: "pt_c", state: "queued" };
      },
      async poll() {
        return { state: "generating" };
      },
      async cancel() {
        return { canceled: true, message: "平台已取消" };
      },
    },
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
  });
  const pendingAttempt = await cancelRunner.enqueue({
    projectId,
    storyboardId: "sb_cancel1",
    accountId: "acc_2",
    params: goodParams,
    refs: goodRefs,
  });
  const canceledLocal = await cancelRunner.cancel(projectId, pendingAttempt.id);
  eq("未提交的任务在本地取消", canceledLocal.status, "canceled");

  const runningAttempt = await cancelRunner.enqueue({
    projectId,
    storyboardId: "sb_cancel2",
    accountId: "acc_2",
    params: goodParams,
    refs: goodRefs,
  });
  await cancelRunner.execute(projectId, runningAttempt.id);
  const canceledRemote = await cancelRunner.cancel(projectId, runningAttempt.id);
  eq("平台支持时真取消", canceledRemote.status, "canceled");

  const noCancelRunner = createRunner({
    taskStore,
    driver: {
      async submit() {
        return { outcome: "ok", platformTaskId: "pt_nc", state: "queued" };
      },
      async poll() {
        return { state: "generating" };
      },
      async cancel() {
        return { canceled: false, reason: "平台不支持取消生成中的任务" };
      },
    },
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
  });
  const noCancelAttempt = await noCancelRunner.enqueue({
    projectId,
    storyboardId: "sb_cancel3",
    accountId: "acc_2",
    params: goodParams,
    refs: goodRefs,
  });
  await noCancelRunner.execute(projectId, noCancelAttempt.id);
  const notCanceled = await noCancelRunner.cancel(projectId, noCancelAttempt.id);
  eq("平台不支持取消时状态不变", notCanceled.status, "queued");
  check("并说明原因", /不支持取消/.test(notCanceled.poll.message), notCanceled.poll.message);

  console.log("── 编排：重试与暂停 ──");
  const retryRunner = createRunner({
    taskStore,
    driver: {
      async submit() {
        return { outcome: "failed", message: "生成服务暂时不可用" };
      },
      async poll() {
        return { state: "unknown" };
      },
    },
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
  });
  const failAttempt = await retryRunner.enqueue({
    projectId,
    storyboardId: "sb_retry",
    accountId: "acc_3",
    params: goodParams,
    refs: goodRefs,
  });
  await retryRunner.execute(projectId, failAttempt.id);
  const failedNow = (await taskStore.list(projectId)).find((t) => t.id === failAttempt.id);
  eq("普通失败标记生成失败", failedNow.status, "failed");
  const retried = await retryRunner.retry(projectId, failAttempt.id);
  eq("重试产生新尝试编号", retried.attempt, 2);
  eq("重试指向原尝试", retried.retryOf, failAttempt.id);
  const allForSb = (await taskStore.list(projectId)).filter((t) => t.storyboardId === "sb_retry");
  eq("历史两条都保留", allForSb.length, 2);
  eq("原尝试仍是失败状态", allForSb.find((t) => t.id === failAttempt.id).status, "failed");

  retryRunner.pause();
  eq("暂停生效", retryRunner.status().paused, true);
  const whilePaused = await retryRunner.tick();
  eq("暂停时不再派发待执行任务", whilePaused.started.length, 0);

  // ══ 9. 重启恢复 ══
  console.log("── 重启恢复 ──");
  const recoverRunner = createRunner({
    taskStore,
    driver: {
      async poll() {
        return { state: "generating" };
      },
    },
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
    staleMs: 0,
  });
  const recovered2 = await recoverRunner.recover();
  check("把活跃记录纳入轮询或标记异常", recovered2.resumed.length + recovered2.stale.length > 0, recovered2);
  const staleOnes = (await taskStore.list(projectId)).filter((t) => t.poll?.stale);
  check("长时间无更新被标记监控异常", staleOnes.length > 0, staleOnes.length);

  // ══ 10. 下载（澜川同源 + 平台播放版 双来源） ══
  console.log("── 下载 ──");
  eq(
    "文件名含项目/分镜/账号/来源标识",
    download.buildFileName({ projectName: "短剧A", storyboardIndex: 3, attemptNumber: 2, url: "https://x/v.mp4", accountName: "Dola 004", sourceTag: "澜川同源" }),
    "短剧A_分镜03_Dola004_澜川同源_v02.mp4"
  );
  eq("非法字符被替换", download.sanitizeSegment('a/b:c*?"<>|'), "a_b_c" + "_".repeat(6));
  eq("webm 扩展名按 MIME", download.extensionFor("https://x/v", "video/webm"), ".webm");
  eq("未知 MIME 回退 mp4", download.extensionFor("https://x/v", "application/octet-stream"), ".mp4");

  // 10.1 来源识别：同源必须能证明是「同一个视频」才可用
  const srcApi = require(path.join(SRC, "workbench-sources.js"));
  const { createParser } = require(path.join(SRC, "hd-candidates.js"));
  const srcParser = createParser();
  const playUrl = "https://v3-web.dola.com/abc/def/video.mp4?sign=AAA";
  const groupsExact = [
    { id: "g1", title: "视频原片", fallbackApi: "https://v9.byteintlapi.com/video/fplay/?vid=1", variants: [{ url: playUrl, width: 720, height: 1280 }] },
  ];
  const withSame = srcApi.buildSources({ videoUrl: playUrl, groups: groupsExact, parser: srcParser });
  const lanchuan = withSame.sources.find((s) => s.kind === "lanchuan-original");
  eq("同源来源被识别为可用", lanchuan.available, true);
  eq("同源匹配方式是地址完全一致", lanchuan.matchedBy, "exact");
  eq("默认来源优先澜川同源", srcApi.defaultSourceId(withSame.sources), "lanchuan");
  eq("来源标签用于文件名（澜川同源）", lanchuan.tag, "澜川同源");
  const noMatch = srcApi.buildSources({ videoUrl: "https://v3-web.dola.com/other.mp4", groups: groupsExact, parser: srcParser });
  const lanchuanOff = noMatch.sources.find((s) => s.kind === "lanchuan-original");
  eq("对不上就不给同源（不猜）", lanchuanOff.available, false);
  check("并写明原因", /无法确认是同一个视频/.test(lanchuanOff.error), lanchuanOff.error);
  eq("此时默认来源回落到平台播放版", srcApi.defaultSourceId(noMatch.sources), "playback");
  const redacted = srcApi.redactUrl(playUrl);
  eq("对外地址脱敏（去掉签名）", redacted, "https://v3-web.dola.com/abc/def/video.mp4");
  check("同源链接类错误值得回退播放版", srcApi.shouldFallbackToPlayback("ORIGINAL_UNAVAILABLE") && srcApi.shouldFallbackToPlayback("HTTP_403"), true);
  check("普通网络错误不走回退（先重试同一来源）", srcApi.shouldFallbackToPlayback("ECONNRESET") === false, true);

  const dlDir = path.join(root, "downloads");
  const dlStore = task.createTaskStore((id) => path.join(root, id));
  const dlAttempt = task.createAttempt({
    projectId: "prj_dl",
    storyboardId: "sb_dl",
    accountId: "acc_1",
    params: { ...okParams },
    refs: [],
  });
  task.applyStatus(dlAttempt, "submitting");
  task.applyStatus(dlAttempt, "succeeded");
  task.setResult(dlAttempt, { videoUrl: playUrl });
  await dlStore.append("prj_dl", dlAttempt);

  const progressEvents = [];
  const failingDownloader = download.createDownloader({
    taskStore: dlStore,
    outputDirFor: async () => dlDir,
    sessionFor: () => ({}),
    groupsForAccount: () => groupsExact,
    parser: srcParser,
    onProgress: (payload) => progressEvents.push(payload),
    transfer: async () => {
      throw Object.assign(new Error("连接被重置"), { code: "ECONNRESET" });
    },
    resolveFallback: async () => "https://v3-web.dola.com/original.mp4",
  });
  const dlResult = await failingDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1, accountName: "Dola 004" });
  eq("下载失败被如实返回", dlResult.ok, false);
  const afterFail = (await dlStore.list("prj_dl"))[0];
  eq("下载失败后生成状态仍是成功", afterFail.status, "succeeded");
  eq("下载状态为失败", afterFail.download.status, "failed");
  eq("生成结果未被清空", afterFail.result.videoUrl, playUrl);
  check("失败原因带错误码与建议", /ECONNRESET/.test(afterFail.download.errorCode) && Boolean(afterFail.download.hint), afterFail.download);
  check("同源失败后按规则回退播放版", progressEvents.some((p) => p.phase === "fallback"), progressEvents.map((p) => p.phase));

  // 10.2 同源可用 → 解析原片并下载成功；进度/来源/校验都落库
  const okDownloader = download.createDownloader({
    taskStore: dlStore,
    outputDirFor: async () => dlDir,
    sessionFor: () => ({}),
    groupsForAccount: () => groupsExact,
    parser: srcParser,
    probe: { inspect: async () => ({ status: "ready", width: 720, height: 1280, duration: 5 }) },
    transfer: async ({ partPath, onProgress }) => {
      onProgress({ received: 4, total: 11, resumed: false });
      fs.writeFileSync(partPath, "video-bytes");
      onProgress({ received: 11, total: 11, resumed: false });
      return { received: 11, total: 11, resumed: false };
    },
    resolveFallback: async () => "https://v3-web.dola.com/original.mp4?lr=unwatermarked",
  });
  const firstDownload = await okDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1, accountName: "Dola 004" });
  check("下载成功", firstDownload.ok, firstDownload);
  check("文件名带账号与来源标识", /短剧A_分镜01_Dola004_澜川同源_v01\.mp4$/.test(firstDownload.filePath), firstDownload.filePath);
  const afterOk = (await dlStore.list("prj_dl"))[0];
  eq("来源类型落库为澜川同源", afterOk.download.source, "lanchuan-original");
  eq("记录下载字节数", afterOk.download.bytes, 11);
  eq("记录下载耗时字段存在", typeof afterOk.download.elapsedMs, "number");
  check("地址脱敏落库（不含签名）", !/\?/.test(afterOk.download.urlSafe || "?") || !/sign=/.test(afterOk.download.urlSafe), afterOk.download.urlSafe);
  check("下载记录留下阶段历史", (afterOk.download.history || []).length >= 1, afterOk.download.history);

  const secondDownload = await okDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1, accountName: "Dola 004" });
  check("重复下载不覆盖历史文件", secondDownload.filePath !== firstDownload.filePath, secondDownload.filePath);
  check("重复下载结果仍在", fs.existsSync(firstDownload.filePath) && fs.existsSync(secondDownload.filePath));

  // 10.3 完整性校验失败 → 标记失败（不是生成失败）
  const corruptDownloader = download.createDownloader({
    taskStore: dlStore,
    outputDirFor: async () => dlDir,
    sessionFor: () => ({}),
    groupsForAccount: () => groupsExact,
    parser: srcParser,
    probe: { inspect: async () => ({ status: "unavailable", message: "未发现可读取的视频轨道" }) },
    transfer: async ({ partPath }) => {
      fs.writeFileSync(partPath, "broken");
      return { received: 6, total: 6, resumed: false };
    },
    resolveFallback: async () => "https://v3-web.dola.com/original.mp4",
  });
  const corrupt = await corruptDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1, accountName: "Dola 004" });
  eq("文件损坏判为下载失败", corrupt.ok, false);
  const afterCorrupt = (await dlStore.list("prj_dl"))[0];
  eq("损坏错误码明确", afterCorrupt.download.errorCode, "FILE_CORRUPT");
  eq("损坏也不改生成状态", afterCorrupt.status, "succeeded");

  // 10.4 暂停 → 保留分片 → 续传成功
  const partProbe = path.join(dlDir, ".dbm-dl-" + dlAttempt.id + ".part");
  const pauseDownloader = download.createDownloader({
    taskStore: dlStore,
    outputDirFor: async () => dlDir,
    sessionFor: () => ({}),
    groupsForAccount: () => groupsExact,
    parser: srcParser,
    probe: { inspect: async () => ({ status: "ready", width: 720, height: 1280 }) },
    transfer: async ({ partPath, signal, onProgress }) => {
      fs.writeFileSync(partPath, "half");
      onProgress({ received: 4, total: 11, resumed: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
      fs.appendFileSync(partPath, "-rest");
      return { received: 11, total: 11, resumed: true };
    },
    resolveFallback: async () => "https://v3-web.dola.com/original.mp4",
  });
  const runPromise = pauseDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1, accountName: "Dola 004" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pausedResult = await pauseDownloader.pause("prj_dl", dlAttempt.id);
  check("暂停指令被接受", pausedResult.ok, pausedResult);
  const pausedRun = await runPromise;
  eq("暂停按预期返回", pausedRun.paused === true, true);
  const afterPause = (await dlStore.list("prj_dl"))[0];
  eq("暂停状态落库", afterPause.download.status, "paused");
  check("暂停保留分片（可续传）", fs.existsSync(partProbe), partProbe);
  const resumableInfo = await pauseDownloader.resumable("prj_dl", dlAttempt.id);
  check("可续传信息可读", resumableInfo.resumable === true && resumableInfo.bytes > 0, resumableInfo);
  const resumeRun = await pauseDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1, accountName: "Dola 004", resume: true });
  check("续传后下载成功", resumeRun.ok, resumeRun);
  const afterResume = (await dlStore.list("prj_dl"))[0];
  eq("续传标记落库", afterResume.download.resumed, true);
  check("续传不再残留分片", !fs.existsSync(partProbe), partProbe);

  // 10.5 取消 → 删除分片、标记失败但不动生成状态
  const cancelDownloader = download.createDownloader({
    taskStore: dlStore,
    outputDirFor: async () => dlDir,
    sessionFor: () => ({}),
    groupsForAccount: () => groupsExact,
    parser: srcParser,
    transfer: async ({ partPath, signal, onProgress }) => {
      fs.writeFileSync(partPath, "half");
      onProgress({ received: 4, total: 11, resumed: false });
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
      return { received: 11, total: 11, resumed: false };
    },
    resolveFallback: async () => "https://v3-web.dola.com/original.mp4",
  });
  const cancelPromise = cancelDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1, accountName: "Dola 004" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await cancelDownloader.cancel("prj_dl", dlAttempt.id);
  const cancelRun = await cancelPromise;
  eq("取消按预期返回", cancelRun.canceled === true, true);
  check("取消后不留分片", !fs.existsSync(partProbe), partProbe);
  const afterCancel = (await dlStore.list("prj_dl"))[0];
  eq("取消后生成状态仍是成功", afterCancel.status, "succeeded");
  eq("取消记在下载状态里", afterCancel.download.errorCode, "CANCELED");

  // 10.6 来源不可用（本次结果没有地址 / 对不上）时给出可执行原因
  const noSourceDownloader = download.createDownloader({
    taskStore: dlStore,
    outputDirFor: async () => dlDir,
    sessionFor: () => ({}),
    groupsForAccount: () => [],
    parser: srcParser,
    transfer: async () => {
      throw new Error("不该被调用");
    },
  });
  const noSource = await noSourceDownloader.resolveSources({ projectId: "prj_dl", attemptId: dlAttempt.id });
  eq("没有页面分组时同源不可用", noSource.sources.find((s) => s.kind === "lanchuan-original").available, false);
  eq("播放版仍可用（有地址就能下）", noSource.sources.find((s) => s.kind === "platform-playback").available, true);

  fs.rmSync(dlDir, { recursive: true, force: true });

  // ══ 11. 素材删除（离线可测：remove 路径不依赖 Electron） ══
  // 这一段是为了锁住一个真实缺陷：createAssets 内部把缩略图缓存命名为 thumbs，
  // 与 dirs() 返回的 thumbs 目录同名，remove() 里解构后被遮蔽成字符串，
  // thumbs.delete 直接抛 TypeError，导致线上删除素材必然失败。
  console.log("── 素材删除 ──");
  const assetRoot = path.join(root, "assetproj");
  const assetsDir = path.join(assetRoot, "assets");
  const thumbsDir = path.join(assetRoot, "thumbs");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  const catalogFile = path.join(assetRoot, "assets.json");
  const fakeId = "asset_aaaaaaaaaaaa";
  fs.writeFileSync(path.join(assetsDir, `${fakeId}.png`), "png-bytes");
  fs.writeFileSync(path.join(thumbsDir, `${fakeId}.png`), "thumb-bytes");
  fs.writeFileSync(
    catalogFile,
    JSON.stringify({
      schemaVersion: 1,
      assets: [
        {
          id: fakeId,
          name: "测试素材",
          fileName: `${fakeId}.png`,
          ext: ".png",
          bytes: 9,
          sha256: "a".repeat(64),
          width: 10,
          height: 10,
          importedAt: new Date().toISOString(),
          hasThumb: true,
        },
      ],
    })
  );
  const assetsApi = createAssets({
    assetsDir: () => assetsDir,
    thumbsDir: () => thumbsDir,
    assetCatalogFile: () => catalogFile,
  });
  eq("素材列表可读", (await assetsApi.list("prj_x")).length, 1);
  let removeError = null;
  let removedList = [];
  try {
    removedList = await assetsApi.remove("prj_x", [fakeId]);
  } catch (error) {
    removeError = error.message;
  }
  check("删除素材不抛异常", removeError === null, removeError);
  eq("删除返回被删项", removedList.length, 1);
  check("素材文件已删除", !fs.existsSync(path.join(assetsDir, `${fakeId}.png`)));
  check("缩略图已删除", !fs.existsSync(path.join(thumbsDir, `${fakeId}.png`)));
  eq("目录记录已更新", JSON.parse(fs.readFileSync(catalogFile, "utf8")).assets.length, 0);

  // ══ 12. 用户反馈修复项（离线可测部分） ══
  console.log("── 修改项：发送步骤回报 / 比例候选 / 粘贴导入 ──");

  // 12.1 驱动层步骤整理：把「点了生成没反应」变成逐步骤的可见结果
  const summarized = summarizeDriver({
    outcome: "failed",
    message: "页面上找不到发送按钮，无法提交生成",
    steps: [
      { step: "setPrompt", ok: true, readback: "镜头推进" },
      { step: "chooseModel", ok: true, picked: "2.5", available: ["2.5", "2.0"] },
      { step: "chooseRatio", ok: false, reason: "页面上找不到该控件" },
      { step: "attachImages", ok: true, count: 2 },
      { step: "send", ok: false, reason: "页面上找不到发送按钮，无法提交生成", candidates: ["label:发送"] },
    ],
  });
  eq("步骤数量被完整保留", summarized.steps.length, 5);
  eq("成功步骤被标注为成功", summarized.steps[0].ok, true);
  eq("失败步骤被标注为失败", summarized.steps[2].ok, false);
  eq("失败步骤带上原因", summarized.steps[2].detail, "页面上找不到该控件");
  eq("选择类步骤记录实际命中项", summarized.steps[1].detail, "已选择 2.5");
  eq("上传类步骤记录数量", summarized.steps[3].detail, "参考图 2/2 张");
  eq("发送失败原因被带出", summarized.steps[4].detail, "页面上找不到发送按钮，无法提交生成");
  eq("候选控件清单被带出（供首次实机校准）", summarized.candidates.length, 1);
  eq("候选控件来自发送步骤", summarized.candidates[0], "label:发送");

  // 12.1a 重试场景必须能看出「没有重复上传」：复用张数与残留清理都要落库可见
  const reusedRun = summarizeDriver({
    outcome: "submitted",
    steps: [
      { step: "waitComposer", ok: true },
      { step: "attachmentsPre", ok: true, count: 3, alts: ["asset_a.png", "asset_b.png", "asset_c.png"] },
      { step: "attachImages", ok: true, count: 3, expected: 3, reused: 3, removedExtras: 1 },
      { step: "verifyRefs", ok: true, expected: 3, attachmentCards: 3, orderMatched: true },
    ],
  });
  eq("输入区已有附件时显示「核对归属后复用」", reusedRun.steps[1].detail, "输入区已有 3 张参考图（核对归属后复用）");
  eq(
    "复用与残留清理都在步骤里写明（证明没有重复上传）",
    reusedRun.steps[2].detail,
    "参考图 3/3 张（复用 3 张，未重复上传）（移除本工具残留 1 张）"
  );
  eq("参考图核实步骤写明顺序是否一致", reusedRun.steps[3].detail, "参考图核实 缩略图 3/3、顺序一致：是");

  // 12.1b 脚本超时时必须带上主进程侧的页面事实，否则只剩一句「超时」无法判断
  const timedOut = summarizeDriver({
    outcome: "failed",
    message: "写入提示词失败",
    steps: [
      {
        step: "setPrompt",
        ok: false,
        reason: "页面脚本执行超时（15 秒无响应）",
        url: "https://www.dola.com/",
        loading: true,
        webContentsId: 42,
      },
    ],
  });
  check("超时步骤带上页面地址", timedOut.steps[0].detail.includes("https://www.dola.com/"), timedOut.steps[0].detail);
  check("超时步骤标出页面仍在加载", timedOut.steps[0].detail.includes("页面仍在加载"), timedOut.steps[0].detail);
  check("超时步骤标出实际驱动的 webContents 编号", timedOut.steps[0].detail.includes("#42"), timedOut.steps[0].detail);
  const crashed = summarizeDriver({
    outcome: "failed",
    message: "x",
    steps: [{ step: "setPrompt", ok: false, reason: "脚本失败", crashed: true }],
  });
  check("渲染进程崩溃会被明确标出", crashed.steps[0].detail.includes("渲染进程已崩溃"), crashed.steps[0].detail);

  // 12.2 驱动步骤随任务记录一起落库，界面才有东西可展示
  const driverStore = task.createTaskStore((projectId) => path.join(root, "driverproj", projectId));
  const driverAttempt = task.createAttempt({ projectId: "prj_driver", storyboardId: "sb_1", accountId: "acct_1" });
  await driverStore.append("prj_driver", driverAttempt);
  await driverStore.update("prj_driver", driverAttempt.id, (record) => {
    record.driver = summarized;
    return record;
  });
  const driverReloaded = (await driverStore.list("prj_driver"))[0];
  eq("驱动步骤已落库并可重启后恢复", driverReloaded.driver.steps.length, 5);
  eq("落库后失败标记仍准确", driverReloaded.driver.steps[4].ok, false);
  eq("落库后候选控件仍在", driverReloaded.driver.candidates[0], "label:发送");
  eq("驱动总体结果已落库", driverReloaded.driver.outcome, "failed");

  // 12.3 比例：候选值来自平台实测能力表，且不再声称「未核实」
  const ratios = platform.ratioOptionsFor(VIDEO_CAPABILITIES, "dola");
  check("比例候选非空", ratios.length >= 4, ratios);
  check("比例候选含 16:9 与 9:16", ratios.includes("16:9") && ratios.includes("9:16"), ratios);
  check(
    "比例控件选择器已登记",
    typeof platform.DOLA_SELECTORS.ratioControl === "string" && platform.DOLA_SELECTORS.ratioControl.length > 0,
    platform.DOLA_SELECTORS.ratioControl
  );
  const ratioWarning = platform
    .validateParams({
      target: "dola",
      params: { model: "seedance2.5", duration: "10", prompt: "x", ratio: "9:16" },
      refs: [],
      capabilities: VIDEO_CAPABILITIES,
    })
    .warnings.join("；");
  check("已核实比例不再写「未核实」", !/未核实/.test(ratioWarning), ratioWarning);
  // 关键：比例不在能力表里时必须拒绝提交，而不是「尝试设置、设不上也继续」
  const badRatio = platform.validateParams({
    target: "dola",
    params: { model: "seedance2.5", duration: "10", prompt: "x", ratio: "4:5" },
    refs: [],
    capabilities: VIDEO_CAPABILITIES,
  });
  check("不在能力表里的比例被拒绝提交", badRatio.ok === false && badRatio.errors.join().includes("比例 4:5"), badRatio);
  const noRatio = platform.validateParams({
    target: "dola",
    params: { model: "seedance2.5", duration: "10", prompt: "x", ratio: "" },
    refs: [],
    capabilities: VIDEO_CAPABILITIES,
  });
  check("未设置比例时说明会用平台默认（不假装核实）", noRatio.warnings.join().includes("平台默认比例"), noRatio.warnings);

  // 12.3b 能力表必须是实测值：此前写着平台并不存在的 seedance2.0mini 与 15/30 秒
  check("模型不含平台上并不存在的 mini", !platform.modelOptionsFor(VIDEO_CAPABILITIES, "dola").includes("seedance2.0mini"), platform.modelOptionsFor(VIDEO_CAPABILITIES, "dola"));
  eq("时长只有实测的 5s / 10s", platform.durationOptionsFor(VIDEO_CAPABILITIES, "dola"), ["5", "10"]);
  check("30 秒不在默认能力表中（需应用自带增强才可能出现）", !platform.durationOptionsFor(VIDEO_CAPABILITIES, "dola").includes("30"));
  eq("模型菜单文案取自实测", platform.menuLabelForModel("seedance2.0fast"), "Seedance 2.0 Fast");
  // 16—30 秒走应用自带的时长增强：只有 Seedance 2.5 可用，且绝不静默降级
  const thirtyOn25 = platform.validateParams({
    target: "dola",
    params: { model: "seedance2.5", duration: "30", prompt: "x", ratio: "9:16" },
    refs: [],
    capabilities: VIDEO_CAPABILITIES,
  });
  check("Seedance 2.5 上 30 秒（增强）通过校验", thirtyOn25.ok, thirtyOn25.errors);
  const thirtyOn10 = platform.validateParams({
    target: "dola",
    params: { model: "seedance1.0", duration: "30", prompt: "x", ratio: "9:16" },
    refs: [],
    capabilities: VIDEO_CAPABILITIES,
  });
  check(
    "非 2.5 模型上 30 秒被拒绝且说明原因（不降级到 10 秒）",
    thirtyOn10.ok === false && /时长增强|不会自动降级/.test(thirtyOn10.errors.join()),
    thirtyOn10.errors
  );
  const enhancedPlan = platform.buildPlan({
    attempt: task.createAttempt({
      projectId,
      storyboardId: "sb_enh",
      accountId: "acc_1",
      params: { model: "seedance2.5", duration: "24", prompt: "推门" },
      refs: [],
    }),
    capabilities: VIDEO_CAPABILITIES,
  });
  eq("增强时长在计划里被标为 enhanced", enhancedPlan.params.durationMode, "enhanced");
  eq("计划带上增强所需模型", enhancedPlan.params.durationEnhancement?.requiresModel, "seedance2.5");
  check("计划说明实际时长以请求体回读为准", enhancedPlan.limitations.join().includes("请求体"), enhancedPlan.limitations);

  // 12.4 粘贴导入：剪贴板图片走 base64 落盘，并沿用内容哈希去重
  const pasteRoot = path.join(root, "pasteproj");
  const pasteAssetsDir = path.join(pasteRoot, "assets");
  const pasteThumbsDir = path.join(pasteRoot, "thumbs");
  fs.mkdirSync(pasteAssetsDir, { recursive: true });
  fs.mkdirSync(pasteThumbsDir, { recursive: true });
  const pasteApi = createAssets({
    assetsDir: () => pasteAssetsDir,
    thumbsDir: () => pasteThumbsDir,
    assetCatalogFile: () => path.join(pasteRoot, "assets.json"),
  });
  const pngBase64 = Buffer.from("paste-png-bytes").toString("base64");
  const pasted = await pasteApi.importBuffers("prj_paste", [{ name: "粘贴图片 1", ext: ".png", base64: pngBase64 }]);
  eq("粘贴导入新增 1 张", pasted.imported.length, 1);
  check("粘贴导入沿用内容哈希命名", /^asset_[0-9a-f]{12}$/.test(pasted.imported[0].id), pasted.imported[0].id);
  check("粘贴图片已写入素材目录", fs.existsSync(path.join(pasteAssetsDir, pasted.imported[0].fileName)));
  const pastedAgain = await pasteApi.importBuffers("prj_paste", [{ name: "粘贴图片 2", ext: ".png", base64: pngBase64 }]);
  eq("同一内容再次粘贴被复用", pastedAgain.reused.length, 1);
  eq("复用时 assetId 不变", pastedAgain.reused[0].id, pasted.imported[0].id);
  const pastedBad = await pasteApi.importBuffers("prj_paste", [
    { name: "坏扩展名", ext: ".txt", base64: pngBase64 },
    { name: "空内容", ext: ".png", base64: "" },
  ]);
  eq("不支持的扩展名与空内容都被拒绝", pastedBad.failed.length, 2);
  eq("失败项不会被记为导入", pastedBad.imported.length, 0);

  // 12.5 提交期间必须有可见反馈：driver 尚未返回时，任务记录就该是「进行中」并带已完成步骤。
  // 这一段锁住「点了提交看起来毫无反应」：旧实现只在 submit 返回后才写一次性结果。
  console.log("── 修改项：提交期间的可见反馈 ──");
  let releaseSubmit = () => {};
  const submitGate = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  const liveRunner = createRunner({
    taskStore,
    driver: {
      async submit({ onStep }) {
        onStep({ step: "setPrompt", ok: true, readback: "推门" });
        onStep({ step: "chooseModel", ok: true, picked: "2.5" });
        await submitGate;
        return {
          outcome: "failed",
          message: "页面上找不到发送按钮，无法提交生成",
          steps: [
            { step: "setPrompt", ok: true, readback: "推门" },
            { step: "chooseModel", ok: true, picked: "2.5" },
            { step: "send", ok: false, reason: "页面上找不到发送按钮，无法提交生成", candidates: ["label:发送"] },
          ],
        };
      },
    },
    capabilities: CAPS,
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
  });
  const liveAttempt = await liveRunner.enqueue({
    projectId,
    storyboardId: "sb_live",
    accountId: "acc_1",
    params: goodParams,
    refs: goodRefs,
  });
  const executing = liveRunner.execute(projectId, liveAttempt.id);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const midState = (await taskStore.list(projectId)).find((t) => t.id === liveAttempt.id);
  eq("提交期间记录为进行中", midState.driver.outcome, "running");
  eq("提交期间已完成的步骤立刻可见", midState.driver.steps.length, 2);
  eq("进行中也能看出走到了哪一步", midState.driver.steps[1].detail, "已选择 2.5");
  releaseSubmit();
  await executing;
  const finalState = (await taskStore.list(projectId)).find((t) => t.id === liveAttempt.id);
  eq("最终结果覆盖进行中状态", finalState.driver.outcome, "failed");
  eq("最终步骤被完整记录", finalState.driver.steps.length, 3);
  eq("最终候选控件清单被保留", finalState.driver.candidates[0], "label:发送");
  eq("失败步骤原因可读", finalState.driver.steps[2].detail, "页面上找不到发送按钮，无法提交生成");
  eq("失败后状态仍为生成失败", finalState.status, "failed");

  // ══ 13. 回归：上一轮真实失败暴露的缺陷（这些用例在旧实现上会失败） ══
  // 背景：隔离版任务日志 att_1bea070d7ef0 显示 openPage/setPrompt 成功，
  // 但 chooseModel/chooseDuration/chooseRatio/send 全部失败，页面地址是 /chat/ ——
  // 也就是「没进入视频生成模式」；而更早两次失败是「页面没加载完就操作」。
  console.log("── 回归：真实页面接入链路 ──");
  const driverSrc = fs.readFileSync(path.join(SRC, "workbench-dola-driver.js"), "utf8");
  const rendererSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const indexSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "index.html"), "utf8");

  check("驱动层有「等页面就绪」步骤", /waitForPageReady/.test(driverSrc) && driverSrc.includes('record("waitReady"'));
  check("驱动层会进入视频生成模式（聊天模式下控件根本不存在）", /STEP_ENTER_VIDEO/.test(driverSrc) && driverSrc.includes('record("enterVideoMode"'));
  check(
    "「视频生成」入口用实测的 skill 按钮",
    platform.DOLA_SELECTORS.videoModeButton.includes("skill_bar_button_17"),
    platform.DOLA_SELECTORS.videoModeButton
  );
  check("打开菜单用真实指针事件（radix 不认 element.click）", driverSrc.includes("pointerdown") && driverSrc.includes("PointerEvent") && !/control\.click\(\)/.test(driverSrc));
  check("不再用 element.click() 打开菜单", !/control\.click\(\)/.test(driverSrc));
  check("发送按钮用实测 id", platform.DOLA_SELECTORS.sendButton === "#flow-end-msg-send", platform.DOLA_SELECTORS.sendButton);
  check("不再猜「工具栏最后一个按钮」当发送按钮", !/toolbar-tail/.test(driverSrc));
  check(
    "参数控件选择器不再保留猜测的兜底键名",
    platform.DOLA_SELECTORS.modelControl === '[data-input-engine-actionbar-control-key="video-model"]' &&
      platform.DOLA_SELECTORS.durationControl === '[data-input-engine-actionbar-control-key="video-duration"]',
    [platform.DOLA_SELECTORS.modelControl, platform.DOLA_SELECTORS.durationControl]
  );
  check("编辑器优先用实测的 tiptap 编辑器", platform.DOLA_SELECTORS.editor.startsWith("div.tiptap.ProseMirror"), platform.DOLA_SELECTORS.editor);

  // 参数设不上必须阻断：旧实现把「参数设置失败」当非致命继续，于是用平台默认值白白生成
  const sendAt = driverSrc.indexOf('record("send"');
  const blocksBeforeSend = (marker) => {
    const at = driverSrc.indexOf(marker);
    return at > 0 && at < sendAt && /return fail\(/.test(driverSrc.slice(at, at + 400));
  };
  check("模型失败即阻断（且在发送之前）", blocksBeforeSend("if (!modelStep?.ok)"));
  check("时长失败即阻断（且在发送之前）", blocksBeforeSend("if (!durationStep?.ok)"));
  check("比例失败即阻断（且在发送之前）", blocksBeforeSend("if (!ratioStep?.ok)"));
  check("已删除「找不到比例控件也继续生成」的旧处理", !/不阻塞提交/.test(driverSrc));
  check("参数必须回读一致（回读不一致视为未生效）", /回读不一致/.test(driverSrc));

  // 图片引用必须核实，不能只因为「工作台写了 @图1」就认为平台收到了引用
  check("提交前核实编辑器内联引用", /STEP_VERIFY_REFS/.test(driverSrc) && driverSrc.includes('record("verifyRefs"'));
  check("引用未核实通过就阻断提交（且在发送之前）", blocksBeforeSend("if (!refsStep?.ok)"));

  // 归属：定位页面时必须能证明「本进程 + 该账号隔离会话」
  check("驱动层带会话归属证据", /sessionEvidence/.test(driverSrc) && /sessionMatched/.test(driverSrc));
  check("分区无法核实时停止操作该页面", /已停止操作该页面/.test(driverSrc));
  // 实测：Electron 的 Session 不暴露 getPartition()，旧实现据此判断会永远「未取到」而误报失败
  check("不再依赖 Electron 不存在的 Session.getPartition", !/\.getPartition\?\.\(\)/.test(driverSrc) && !/\.getPartition\(\)/.test(driverSrc));
  check("会话存储路径不在本实例数据目录时也停手", /storageUnderUserData/.test(driverSrc));

  // 实测缺陷（2026-09-23 真实提交 att_5344bc651f4b / att_a3ccf555afb4）：
  // 点击确实命中了 #flow-end-msg-send，但平台毫无反应，事后会话页是空的。
  // 旧实现只在「点击成功」后干等任务 ID，把「点击没生效」误当成「响应来得慢」。
  check("发送后有「页面是否真的起反应」的判定", /STEP_SEND_REACTION/.test(driverSrc) && /waitForSendReaction/.test(driverSrc));
  check("页面没反应时明确失败而不是干等", /没有任何反应/.test(driverSrc) && /没有真正提交/.test(driverSrc));
  check("记录生成类网络请求（区分点击没生效与拿不到任务 ID）", /requestWillBeSent/.test(driverSrc) && /observedRequests/.test(driverSrc));
  check("记录请求时丢弃查询串（避免把敏感参数落库）", /parsed\.pathname/.test(driverSrc));
  check("参考图数量必须与本次一致（按附件标识核对，不靠文件名）", /countOk/.test(driverSrc) && /state\.attachments\.set/.test(driverSrc));

  // 实测证据（会话 38417881046054929）：平台拒绝时不会给任务 ID，而是在会话里回一条说明
  // 「出于肖像保护考虑，未认证人脸暂不支持用 Dreamina Seedance 2.5 生成视频」。
  // 旧实现只盯任务 ID，于是把这种明确拒绝误报成「提交结果待确认」。
  check("会读取平台在会话里的回复", /STEP_READ_REPLIES/.test(driverSrc) && /classifyPlatformReply/.test(driverSrc));
  check(
    "平台明确拒绝时判为失败、不可重试、需要人工处理",
    /outcome: "failed"/.test(driverSrc) &&
      /retryable: false/.test(driverSrc) &&
      /needsUser: true/.test(driverSrc) &&
      driverSrc.indexOf("needsUser: true") > driverSrc.indexOf("classifyPlatformReply")
  );
  check("平台回复只取本次提交之后的新消息（旧提示不算本次）", /before\.count|beforeMessages/.test(driverSrc) && /urlChanged/.test(driverSrc));
  const faceReject = platform.classifyPlatformReply(
    "出于肖像保护考虑，未认证人脸暂不支持用 Dreamina Seedance 2.5 生成视频。你可以尝试换其它参考图或文生视频。"
  );
  eq("未认证人脸被识别为平台拒绝", faceReject?.code, "FACE_UNVERIFIED");
  check("识别结果带上平台原文", /未认证人脸/.test(faceReject?.excerpt || ""), faceReject);
  const needConfirm = platform.classifyPlatformReply(
    "This is a very long, highly specified 13-shot underwater narrative. I can generate it, but it's too extensive for a single turn.Please confirm one of these options: A. Generate a 15-second ..."
  );
  eq("提示词过长要求确认也被识别", needConfirm?.code, "NEED_CONFIRM");
  // 实测（2026-09-24 真实提交 att_d56d75641fc4，Dola 004）：平台回
  // 「今天的生成次数已经达到上限，明天再来免费生成吧」——必须判失败并带原文，
  // 不能停在「提交结果待确认」，也不能自动重试。
  const quota = platform.classifyPlatformReply("今天的生成次数已经达到上限，明天再来免费生成吧");
  eq("平台额度用尽被识别为明确拒绝", quota?.code, "QUOTA_EXHAUSTED");
  check("额度拒绝带上平台原文", /明天再来/.test(quota?.excerpt || ""), quota?.excerpt);
  eq("额度不足的其它说法也能识别", platform.classifyPlatformReply("当前额度不足，请稍后再试")?.code, "QUOTA_EXHAUSTED");
  eq("正常回复不会被误判为拒绝", platform.classifyPlatformReply("正在为你生成视频，请稍候"), null);
  eq("空文本不臆断", platform.classifyPlatformReply(""), null);

  // 步骤顺序：等就绪 → 进视频模式 → 清残留图 → 写提示词 → 选参数 → 传图 → 核实 → 发送
  const order = [
    'record("waitReady"',
    'record("enterVideoMode"',
    'record("attachmentsPre"',
    'record("setPrompt"',
    'record("chooseModel"',
    'record("chooseDuration"',
    'record("attachImages"',
    'record("verifyRefs"',
    'record("send"',
  ].map((marker) => driverSrc.indexOf(marker));
  check(
    "步骤顺序固定为：就绪 → 视频模式 → 附件来源审查 → 提示词 → 参数 → 图片 → 核实 → 发送",
    order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])),
    order
  );
  check(
    "上传前审查附件来源：本工具传过的复用，来源不明的停下报告冲突",
    /STEP_ATTACHMENTS_STATE/.test(driverSrc) &&
      /ATTACHMENT_CONFLICT/.test(driverSrc) &&
      /reused: true/.test(driverSrc) &&
      !/STEP_CLEAR_ATTACHMENTS/.test(driverSrc)
  );
  check(
    "附件查询限定在输入容器内（不再整页统计 img）",
    /guidance-input/.test(driverSrc) && /image-wrapper/.test(driverSrc) && !/document\.querySelectorAll\('img'\)/.test(driverSrc)
  );
  check("逐张上传并等待每张完成，失败只补传缺失的那张", /files: \[item\.filePath\]/.test(driverSrc) && /failed\.push\(item\)/.test(driverSrc));

  // 页面脚本是「HELPERS + STEP_xxx」拼成同一段脚本执行的，因此每个 STEP 脚本的顶层
  // 声明都不能与 HELPERS 重名 —— 重名会让整段脚本抛 SyntaxError，而 executeJavaScript
  // 只回一句「Script failed to execute」，实机极难定位。
  // 实测 2026-09-24：STEP_READ_RESULT 里写了 const norm，与 HELPERS 的 norm 冲突，
  // 导致 poll 一直失败、任务永远停在「提交结果待确认」。
  {
    const BT = String.fromCharCode(96);
    const lines = driverSrc.split("\n");
    const readBlock = (name) => {
      const start = lines.findIndex((l) => l.startsWith("const " + name + " = " + BT));
      if (start < 0) return null;
      const body = [];
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() === BT + ";") return body.join("\n");
        body.push(lines[i]);
      }
      return null;
    };
    // 只取「缩进不超过 2 空格」的顶层声明（IIFE 内部的更深缩进自动排除）
    const topLevelNames = (src) => {
      const names = new Set();
      for (const line of String(src || "").split("\n")) {
        const m = /^( {0,2})(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/.exec(line);
        if (m) names.add(m[2]);
      }
      return names;
    };
    const helpersNames = topLevelNames(readBlock("HELPERS"));
    check("能解析出 HELPERS 的顶层标识符（测试自身有效）", helpersNames.size >= 8, helpersNames.size);
    const stepNames = lines
      .filter((l) => /^const STEP_[A-Z_]+ = /.test(l))
      .map((l) => l.slice("const ".length, l.indexOf(" = ")));
    const conflicts = [];
    for (const name of stepNames) {
      const body = readBlock(name);
      if (body === null) continue;
      for (const declared of topLevelNames(body)) {
        if (helpersNames.has(declared)) conflicts.push(`${name}.${declared}`);
      }
    }
    check(`页面脚本不与 HELPERS 重名（检查了 ${stepNames.length} 段脚本）`, conflicts.length === 0, conflicts);
  }
  check("同一账号的上传与提交有互斥锁（不同账号可并发）", /withAccountLock/.test(driverSrc));
  check("提交前复核附件数量/顺序/编号标注", /missingCount/.test(driverSrc) && /extraCount/.test(driverSrc) && /orderMatched/.test(driverSrc));

  // 实测缺陷（2026-09-23）：平台处理完上传后不会清空 input.value，
  // 再次上传同一批图片时 FileList 没变化、change 不触发 → 页面上没有缩略图，等于发了个没有参考图的请求
  check("上传前先清空 file input 的 value", /STEP_RESET_FILE_INPUT/.test(driverSrc));
  check(
    "清空 file input 发生在设置文件之前",
    driverSrc.indexOf("STEP_RESET_FILE_INPUT") > 0 &&
      driverSrc.indexOf("const reset = await evaluate") < driverSrc.indexOf("DOM.setFileInputFiles"),
    [driverSrc.indexOf("const reset = await evaluate"), driverSrc.indexOf("DOM.setFileInputFiles")]
  );
  check("清空失败（没有文件入口）即阻断上传", /没有可用的文件上传入口/.test(driverSrc));

  // 实测缺陷（2026-09-23 真实提交）：刚点开账号时 getURL() 短暂为空，
  // 旧实现立刻判定「页面不在 dola 上」直接失败（提交记录 att_01c7f8fc56d8，31ms 就失败）
  check("定位页面会等到真正落到 dola 上（不是立刻放弃）", /for \(;;\)/.test(driverSrc) && /deadline/.test(driverSrc));
  check("等页面就绪有明确上限", /READY_TIMEOUT_MS/.test(driverSrc));
  check("失败时给出实测状态而不是含糊报错", /秒内没有就绪/.test(driverSrc) && /实测状态/.test(driverSrc));

  // 多账号默认语义：默认「分配执行」，对比模式必须显式选择
  console.log("── 回归：多账号默认语义 ──");
  const boards = ["sb_1", "sb_2", "sb_3"];
  const accounts = ["acc_a", "acc_b"];
  const distributed = platform.assignStoryboards({ storyboardIds: boards, accountIds: accounts });
  eq("默认模式每条分镜只执行一次", distributed.length, 3);
  eq("默认模式分镜不重复", [...new Set(distributed.map((a) => a.storyboardId))].length, 3);
  eq("默认模式按顺序轮转账号", distributed.map((a) => a.accountId), ["acc_a", "acc_b", "acc_a"]);
  eq("默认模式标记为 distribute", distributed[0].mode, "distribute");
  const compared = platform.assignStoryboards({ storyboardIds: boards, accountIds: accounts, mode: "compare" });
  eq("对比模式才在每个账号各生成一次", compared.length, 6);
  eq("对比模式标记为 compare", compared[0].mode, "compare");
  eq("单分镜单账号默认只产生一条（本轮真实验证的路径）", platform.assignStoryboards({ storyboardIds: ["sb_1"], accountIds: ["acc_a"] }).length, 1);
  eq("单分镜多账号在默认模式下仍只有一条", platform.assignStoryboards({ storyboardIds: ["sb_1"], accountIds: accounts }).length, 1);
  eq("对比模式下单分镜多账号成倍", platform.assignStoryboards({ storyboardIds: ["sb_1"], accountIds: accounts, mode: "compare" }).length, 2);
  eq("空输入返回空计划", platform.assignStoryboards({ storyboardIds: [], accountIds: accounts }).length, 0);

  check("渲染层默认模式是分配执行", /run: \{ mode: "distribute"/.test(rendererSrc), "state.run 初始化");
  check("打开确认框的默认模式是分配执行", /async function openRunModal\(storyboardIds, mode = "distribute"\)/.test(rendererSrc));
  check("确认框提供模式选择", /workbenchRunMode/.test(rendererSrc));
  check("分镜卡片按钮走分配模式", /openRunModal\(\[storyboardId\], "distribute"\)/.test(rendererSrc));
  check("工具栏有「生成整批（分配执行）」入口", /id="workbenchRunBatch"/.test(indexSrc) && /workbenchRunBatch/.test(rendererSrc));

  check("界面不再写「每个账号各生成一条」当作默认", !/每个账号各生成一条/.test(rendererSrc));

  const labelSrc = rendererSrc;
  check(
    "步骤中文名包含新步骤",
    ["waitReady", "enterVideoMode", "verifyRefs"].every((key) => labelSrc.includes(`${key}:`)),
    ["waitReady", "enterVideoMode", "verifyRefs"].filter((key) => !labelSrc.includes(`${key}:`))
  );

  // ══ 14. 自动重试与提交锁（第八项验收重点） ══
  const RETRY_PARAMS = { model: "seedance2.5", duration: "10", ratio: "9:16", prompt: "推门" };
  console.log("── 自动重试与提交锁 ──");
  const retryStore = task.createTaskStore((id) => path.join(root, "retry-" + id));
  const retrySched = createFakeScheduler();
  const mkRunner = (driver, extra = {}) =>
    createRunner({
      taskStore: retryStore,
      driver,
      capabilities: CAPS,
      schedule: retrySched.schedule,
      cancelSchedule: retrySched.cancel,
      resolveAssets: async () => new Map(),
      listProjectIds: async () => ["prj_retry"],
      autoRetryBaseMs: 10,
      ...extra,
    });

  // 14.1 已取得任务 ID → 绝不重提
  let okCalls = 0;
  const okRunner = mkRunner({
    async submit() {
      okCalls++;
      return { outcome: "ok", platformTaskId: "pt_ok", accepted: true, state: "queued", message: "已取得任务 ID" };
    },
    async poll() {
      return { state: "generating" };
    },
  });
  const okAttempt = await okRunner.enqueue({ projectId: "prj_retry", storyboardId: "sb_ok", accountId: "acc_1", params: { model: "seedance2.5", duration: "10", ratio: "9:16", prompt: "推门" }, refs: [] });
  await okRunner.execute("prj_retry", okAttempt.id);
  await retrySched.flush();
  eq("有任务 ID 时只提交一次", okCalls, 1);
  check("有任务 ID 时进入监控（排队/生成中）", ["queued", "generating"].includes((await retryStore.list("prj_retry")).find((t) => t.id === okAttempt.id).status));

  // 14.2 平台已受理（无任务 ID）→ 停止重复提交，转入监控
  let acceptedCalls = 0;
  const acceptedRunner = mkRunner({
    async submit() {
      acceptedCalls++;
      return {
        outcome: "accepted",
        accepted: true,
        acceptanceEvidence: { kind: "platform-message", codes: ["PLAN_USE", "COST_FORECAST"], strength: "accepted" },
        state: "queued",
        message: "平台已受理，等待任务 ID",
      };
    },
    async poll() {
      return { state: "unknown" };
    },
  });
  const acceptedAttempt = await acceptedRunner.enqueue({
    projectId: "prj_retry",
    storyboardId: "sb_accepted",
    accountId: "acc_1",
    params: RETRY_PARAMS,
    refs: [],
  });
  await acceptedRunner.execute("prj_retry", acceptedAttempt.id);
  await retrySched.flush();
  eq("平台受理后不再重复提交", acceptedCalls, 1);
  const acceptedNow = (await retryStore.list("prj_retry")).find((t) => t.id === acceptedAttempt.id);
  eq("受理状态进入排队", acceptedNow.status, "queued");
  check("受理证据被落库", acceptedNow.acceptanceEvidence?.kind === "platform-message", acceptedNow.acceptanceEvidence);

  // 14.3 响应超时（没有受理证据）→ 标记待确认，不自动重提
  let timeoutCalls = 0;
  const timeoutRunner = mkRunner({
    async submit() {
      timeoutCalls++;
      return { outcome: "unknown", message: "响应超时，未取得任务 ID" };
    },
    async verifySubmission() {
      return { found: false, message: "未在平台找到该任务" };
    },
    async poll() {
      return { state: "unknown" };
    },
  });
  const timeoutAttempt = await timeoutRunner.enqueue({ projectId: "prj_retry", storyboardId: "sb_timeout", accountId: "acc_1", params: { model: "seedance2.5", duration: "10", ratio: "9:16", prompt: "推门" }, refs: [] });
  await timeoutRunner.execute("prj_retry", timeoutAttempt.id);
  await retrySched.flush();
  eq("超时未确认时只提交一次（不盲目重提）", timeoutCalls, 1);
  eq("标记为提交结果待确认", (await retryStore.list("prj_retry")).find((t) => t.id === timeoutAttempt.id).status, "unconfirmed");

  // 14.4 明确临时失败且未创建任务 → 按上限自动重试（默认最多 2 次，总 3 次）
  let transientCalls = 0;
  const transientRunner = mkRunner({
    async submit() {
      transientCalls++;
      return { outcome: "failed", retryable: true, accepted: false, message: "点击后页面没有反应", evidence: { kind: "no-reaction" } };
    },
    async poll() {
      return { state: "unknown" };
    },
  });
  const transientAttempt = await transientRunner.enqueue({
    projectId: "prj_retry",
    storyboardId: "sb_transient",
    accountId: "acc_1",
    params: RETRY_PARAMS,
    refs: [],
  });
  await transientRunner.execute("prj_retry", transientAttempt.id);
  const firstRetry = (await retryStore.list("prj_retry")).find((t) => t.id === transientAttempt.id);
  eq("安排第 1 次自动重试", firstRetry.autoRetry?.count, 1);
  check("重试信息里有原因与下次时间", Boolean(firstRetry.autoRetry?.reason) && Boolean(firstRetry.autoRetry?.nextAt), firstRetry.autoRetry);
  check("重试等待期间锁住这条分镜（按账号加锁）", transientRunner.status().locks.some((lock) => lock.key === "prj_retry:sb_transient:acc_1"), transientRunner.status().locks);
  await retrySched.flush();
  await retrySched.flush();
  await retrySched.flush();
  eq("总计最多提交 3 次（1 次原始 + 2 次重试）", transientCalls, 3);
  const chain = (await retryStore.list("prj_retry")).filter((t) => t.storyboardId === "sb_transient");
  eq("每次重试都留下独立尝试记录", chain.length, 3);
  check("重试记录指向原尝试", chain.some((t) => t.retryOf === transientAttempt.id), chain.map((t) => t.retryOf));
  check("达到上限后标记为已停止", chain.some((t) => t.autoRetry?.stopped), chain.map((t) => t.autoRetry));

  // 14.5 平台明确拒绝（人脸未认证等）→ 不重试、不换素材换模型、提示人工处理
  let rejectCalls = 0;
  const rejectRunner = mkRunner({
    async submit() {
      rejectCalls++;
      return {
        outcome: "failed",
        errorCode: "FACE_UNVERIFIED",
        retryable: false,
        needsUser: true,
        message: "平台拒绝：未认证人脸不支持该模型",
      };
    },
    async poll() {
      return { state: "unknown" };
    },
  });
  const rejectAttempt = await rejectRunner.enqueue({
    projectId: "prj_retry",
    storyboardId: "sb_reject",
    accountId: "acc_1",
    params: RETRY_PARAMS,
    refs: [],
  });
  await rejectRunner.execute("prj_retry", rejectAttempt.id);
  await retrySched.flush();
  eq("明确拒绝只提交一次", rejectCalls, 1);
  const rejectNow = (await retryStore.list("prj_retry")).find((t) => t.id === rejectAttempt.id);
  eq("明确拒绝标记为生成失败（非待确认）", rejectNow.status, "failed");
  eq("明确拒绝不带自动重试", rejectNow.autoRetry?.count, undefined);
  check("拒绝原因可读", /未认证人脸/.test(rejectNow.error?.message || ""), rejectNow.error);
  check("释放提交锁（可人工处理后重试）", !rejectRunner.status().locks.some((lock) => lock.key.startsWith("prj_retry:sb_reject")));

  // 14.6 提交锁：等待自动重试期间，手动再点同一条分镜会被拒绝
  let lockCalls = 0;
  const lockRunner = mkRunner({
    async submit() {
      lockCalls++;
      return { outcome: "failed", retryable: true, accepted: false, message: "临时失败" };
    },
    async poll() {
      return { state: "unknown" };
    },
  });
  const lockedFirst = await lockRunner.enqueue({ projectId: "prj_retry", storyboardId: "sb_lock", accountId: "acc_1", params: { model: "seedance2.5", duration: "10", ratio: "9:16", prompt: "推门" }, refs: [] });
  await lockRunner.execute("prj_retry", lockedFirst.id);
  const lockedSecond = await lockRunner.enqueue({ projectId: "prj_retry", storyboardId: "sb_lock", accountId: "acc_1", params: { model: "seedance2.5", duration: "10", ratio: "9:16", prompt: "推门" }, refs: [] });
  let lockError = "";
  try {
    await lockRunner.execute("prj_retry", lockedSecond.id);
  } catch (error) {
    lockError = error.message;
  }
  check("重试等待期间手点会被拒绝并说明原因", /正在提交中/.test(lockError), lockError);
  await lockRunner.stopAutoRetry("prj_retry", lockedFirst.id);
  check("停止重试后释放锁", !lockRunner.status().locks.some((lock) => lock.key.startsWith("prj_retry:sb_lock")));
  eq("停止重试后不再继续提交", lockCalls, 1);

  // 14.7 受理信号识别：不硬编码整句，靠结构特征（使用+生成 / 消耗+额度）
  const costHint = platform.classifyAcceptance("本次使用 Dreamina Seedance 2.5 生成，将消耗 2 个视频生成额度");
  eq("费用预告类提示被识别为受理", costHint?.strength, "accepted");
  check("受理判定说明不算生成成功", /不算生成成功|不作为生成成功依据/.test(costHint?.note || ""), costHint?.note);
  eq("只出现“消耗额度”时算弱信号", platform.classifyAcceptance("本次将消耗 1 个额度")?.strength, "hint");
  eq("普通回复不会被当成受理", platform.classifyAcceptance("有什么我可以帮你的吗"), null);
  eq("生成中字样被识别为强受理信号", platform.classifyAcceptance("正在生成视频，请稍候")?.strength, "accepted");

  // 14.8 轮询自身出错不能让监控永久停摆
  // 实测（2026-09-24 真实提交 att_d56d75641fc4）：该任务的 poll 在 20:46:20 之后
  // 再无任何写入（nextAt 已过期、count 停在 43），界面永远停在「提交结果待确认」，
  // 之后平台即使已经给出结果也永远不会被发现。旧实现只把异常写进日志、不再安排下一次轮询。
  {
    const errStore = task.createTaskStore((id) => path.join(root, "pollerr-" + id));
    const errSched = createFakeScheduler();
    let pollCalls = 0;
    const errRunner = createRunner({
      taskStore: errStore,
      driver: {
        async submit() {
          return { outcome: "ok", platformTaskId: "pt_pollerr", accepted: true, state: "queued", message: "已取得任务 ID" };
        },
        async poll() {
          pollCalls++;
          if (pollCalls === 1) throw new Error("任务记录不存在");
          return { state: "succeeded", result: { videoUrl: "https://example.com/pollerr.mp4" } };
        },
      },
      capabilities: CAPS,
      schedule: errSched.schedule,
      cancelSchedule: errSched.cancel,
      resolveAssets: async () => new Map(),
      listProjectIds: async () => ["prj_pollerr"],
      pollBaseMs: 0,
      pollMaxMs: 0,
    });
    const errAttempt = await errRunner.enqueue({
      projectId: "prj_pollerr",
      storyboardId: "sb_pollerr",
      accountId: "acc_1",
      params: RETRY_PARAMS,
      refs: [],
    });
    await errRunner.execute("prj_pollerr", errAttempt.id);
    await errSched.flush(12);
    const errNow = (await errStore.list("prj_pollerr")).find((t) => t.id === errAttempt.id);
    check("轮询抛错后仍会继续轮询", pollCalls >= 2, pollCalls);
    eq("轮询抛错不再让任务永远停在待确认", errNow.status, "succeeded");
  }

  // 14.9 轮询阶段读到平台明确拒绝：带上平台原文、不自动重试
  {
    const rejStore = task.createTaskStore((id) => path.join(root, "pollrej-" + id));
    const rejSched = createFakeScheduler();
    const rejectText = "今天的生成次数已经达到上限，明天再来免费生成吧";
    const rule = platform.classifyPlatformReply(rejectText);
    const rejRunner = createRunner({
      taskStore: rejStore,
      driver: {
        async submit() {
          return { outcome: "ok", platformTaskId: "pt_pollrej", accepted: true, state: "queued", message: "已取得任务 ID" };
        },
        async poll() {
          return {
            state: "failed",
            errorCode: rule.code,
            message: `${rule.label}；平台原文：${rule.excerpt}`,
            evidence: { kind: "platform-reply", code: rule.code, excerpt: rule.excerpt },
          };
        },
      },
      capabilities: CAPS,
      schedule: rejSched.schedule,
      cancelSchedule: rejSched.cancel,
      resolveAssets: async () => new Map(),
      listProjectIds: async () => ["prj_pollrej"],
      pollBaseMs: 0,
      pollMaxMs: 0,
    });
    const rejAttempt = await rejRunner.enqueue({
      projectId: "prj_pollrej",
      storyboardId: "sb_pollrej",
      accountId: "acc_quota",
      params: RETRY_PARAMS,
      refs: [],
    });
    await rejRunner.execute("prj_pollrej", rejAttempt.id);
    await rejSched.flush(12);
    const rejNow = (await rejStore.list("prj_pollrej")).find((t) => t.id === rejAttempt.id);
    check("平台明确拒绝时任务离开监控态（不再停在待确认）", ["failed", "manual"].includes(rejNow.status), rejNow.status);
    eq("错误码为额度用尽", rejNow.error?.code, "QUOTA_EXHAUSTED");
    check("界面上能看到平台原文", /明天再来/.test(rejNow.error?.message || ""), rejNow.error);
    eq("额度类拒绝不自动重试", rejNow.autoRetry?.count, undefined);
    check("额度类拒绝会暂停该账号，避免继续消耗", rejRunner.status().blockedAccounts.some((b) => b.accountId === "acc_quota"), rejRunner.status().blockedAccounts);
  }

  // 14.10 监控窗口到期：待确认任务必须能收尾
  // 实测（2026-09-24 真实提交 att_d56d75641fc4）：该任务停在「提交结果待确认」，
  // 轮询次数冻结在 43、nextAt 早已过期，界面永远不再变化。
  // 根因：pollOnce 的监控超时分支请求 unconfirmed → manual，而迁移表里没有这一条，
  // applyStatus 每次都抛「不允许的状态迁移」，任务被永久卡在待确认。
  {
    check("待确认 → 需人工处理 是合法迁移", task.canTransition("unconfirmed", "manual"));
    const toStore = task.createTaskStore((id) => path.join(root, "pollto-" + id));
    const toSched = createFakeScheduler();
    let toPollCalls = 0;
    const toRunner = createRunner({
      taskStore: toStore,
      driver: {
        async submit() {
          return { outcome: "unknown", message: "响应超时，未取得任务 ID" };
        },
        async verifySubmission() {
          return { found: false, message: "未在平台找到该任务" };
        },
        async poll() {
          toPollCalls++;
          return { state: "unknown", message: "消息里还没有视频" };
        },
      },
      capabilities: CAPS,
      schedule: toSched.schedule,
      cancelSchedule: toSched.cancel,
      resolveAssets: async () => new Map(),
      listProjectIds: async () => ["prj_pollto"],
      pollBaseMs: 0,
      pollMaxMs: 0,
      pollTimeoutMs: 0, // 立刻视为已超过监控窗口
    });
    const toAttempt = await toRunner.enqueue({
      projectId: "prj_pollto",
      storyboardId: "sb_pollto",
      accountId: "acc_1",
      params: RETRY_PARAMS,
      refs: [],
    });
    await toRunner.execute("prj_pollto", toAttempt.id);
    await toSched.flush(12);
    const toNow = (await toStore.list("prj_pollto")).find((t) => t.id === toAttempt.id);
    eq("监控窗口到期后待确认任务转入需人工处理", toNow.status, "manual");
    check("不再停留在待确认", toNow.status !== "unconfirmed");
    check("给出人工核实提示", /人工核实|监控超时/.test(toNow.history[toNow.history.length - 1]?.note || ""), toNow.history[toNow.history.length - 1]);
    eq("到期后不再继续轮询", toPollCalls, 0);
    eq("不自动重试", toNow.autoRetry?.count, undefined);
  }

  // ══ 15. 多账号并行（第二/三项验收重点） ══
  console.log("── 多账号并行与账号隔离 ──");
  const concStoreFor = (tag) => task.createTaskStore((id) => path.join(root, "conc-" + tag + "-" + id));
  const concStore = concStoreFor("main");
  const concSched = createFakeScheduler();
  const timeline = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const makeConcRunner = (submitImpl, store, projectId, extra = {}) =>
    createRunner({
      taskStore: store,
      driver: {
        async submit(args) {
          return submitImpl(args);
        },
        async poll() {
          return { state: "generating" };
        },
      },
      capabilities: CAPS,
      schedule: concSched.schedule,
      cancelSchedule: concSched.cancel,
      resolveAssets: async () => new Map(),
      listProjectIds: async () => [projectId],
      pollBaseMs: 100000,
      globalConcurrency: 3,
      ...extra,
    });

  const track = (label) => async ({ accountId }) => {
    const startedAt = Date.now();
    await sleep(150);
    timeline.push({ label, accountId, startedAt, endedAt: Date.now() });
    return { outcome: "ok", platformTaskId: `pt_${accountId}`, accepted: true, state: "queued", message: "已提交" };
  };
  const concRunner = makeConcRunner(track("ok"), concStoreFor("a"), "prj_conc_a");
  for (const accountId of ["acc_a", "acc_b", "acc_c", "acc_d"]) {
    await concRunner.enqueue({ projectId: "prj_conc_a", storyboardId: "sb_multi", accountId, params: RETRY_PARAMS, refs: [] });
  }
  await concRunner.tick();
  await sleep(80);
  eq("并发上限 3：先启动 3 条", concRunner.status().running.length, 3);
  for (let i = 0; i < 40 && concRunner.status().running.length; i++) await sleep(50);
  await sleep(120);
  for (let i = 0; i < 40 && timeline.length < 4; i++) await sleep(50);

  const overlap = timeline.length >= 3 && Math.max(...timeline.slice(0, 3).map((t) => t.startedAt)) < Math.min(...timeline.slice(0, 3).map((t) => t.endedAt));
  check("前 3 个账号的执行时间确实重叠（真并发，不是串行）", overlap === true, timeline);
  eq("第 4 个账号在前 3 个让出槽位后才执行", timeline.length, 4);
  const allQueued = (await concStoreFor("a").list("prj_conc_a")).filter((t) => t.status === "queued");
  eq("4 条任务分别属于 4 个账号", allQueued.length, 4);
  eq(
    "每条任务的平台任务 ID 与账号一一对应（不串号）",
    allQueued.map((t) => t.platformTaskId).sort().join(","),
    "pt_acc_a,pt_acc_b,pt_acc_c,pt_acc_d"
  );

  // 15.2 同一账号不并发（每账号最多 1 条）
  timeline.length = 0;
  const sameAccountRunner = makeConcRunner(track("same"), concStoreFor("b"), "prj_conc_b", { globalConcurrency: 3 });
  await sameAccountRunner.enqueue({ projectId: "prj_conc_b", storyboardId: "sb_s1", accountId: "acc_x", params: RETRY_PARAMS, refs: [] });
  await sameAccountRunner.enqueue({ projectId: "prj_conc_b", storyboardId: "sb_s2", accountId: "acc_x", params: RETRY_PARAMS, refs: [] });
  await sameAccountRunner.tick();
  for (let i = 0; i < 60 && timeline.length < 2; i++) await sleep(50);
  const sameOverlap = timeline.length >= 2 && timeline[1].startedAt < timeline[0].endedAt;
  check("同一账号不会同时执行两条任务", sameOverlap === false, timeline);

  // 15.3 一个账号失败不阻塞其他账号
  timeline.length = 0;
  const mixedRunner = makeConcRunner(async ({ accountId }) => {
    const startedAt = Date.now();
    await sleep(120);
    timeline.push({ accountId, startedAt, endedAt: Date.now() });
    if (accountId === "acc_bad") {
      return { outcome: "failed", retryable: false, needsUser: true, message: "平台拒绝：未认证人脸不支持该模型" };
    }
    return { outcome: "ok", platformTaskId: `pt_${accountId}`, accepted: true, state: "queued", message: "已提交" };
  }, concStoreFor("c"), "prj_conc_c");
  for (const accountId of ["acc_good1", "acc_bad", "acc_good2"]) {
    await mixedRunner.enqueue({ projectId: "prj_conc_c", storyboardId: "sb_mix", accountId, params: RETRY_PARAMS, refs: [] });
  }
  await mixedRunner.tick();
  for (let i = 0; i < 60 && mixedRunner.status().running.length; i++) await sleep(50);
  const mixed = await concStoreFor("c").list("prj_conc_c");
  const good1 = mixed.find((t) => t.accountId === "acc_good1");
  const good2 = mixed.find((t) => t.accountId === "acc_good2");
  const bad = mixed.find((t) => t.accountId === "acc_bad");
  eq("一个账号失败不影响其他账号提交", [good1?.status, good2?.status].join(","), "queued,queued");
  eq("失败账号单独标记失败（人脸未认证不是账号阻塞）", bad?.status, "failed");
  check("并提示需要人工处理", bad?.driver?.needsUser === true, bad?.driver);

  // 15.5 暂停队列：不再启动新任务，但已提交的继续监控
  timeline.length = 0;
  const pauseSched = createFakeScheduler();
  const pauseRunner = makeConcRunner(track("pause"), concStoreFor("d"), "prj_conc_d", {
    schedule: pauseSched.schedule,
    cancelSchedule: pauseSched.cancel,
  });
  const submitFirst = await pauseRunner.enqueue({
    projectId: "prj_conc_d",
    storyboardId: "sb_pause",
    accountId: "acc_p1",
    params: RETRY_PARAMS,
    refs: [],
  });
  await pauseRunner.tick();
  for (let i = 0; i < 40 && pauseRunner.status().running.length; i++) await sleep(50);
  const polledBefore = (await concStoreFor("d").list("prj_conc_d")).find((t) => t.id === submitFirst.id)?.poll?.count || 0;
  pauseRunner.pause();
  await pauseRunner.enqueue({ projectId: "prj_conc_d", storyboardId: "sb_pause2", accountId: "acc_p2", params: RETRY_PARAMS, refs: [] });
  const pausedTick = await pauseRunner.tick();
  eq("暂停后不再启动新任务", pausedTick.started.length, 0);
  await pauseSched.flush(10);
  const polledAfter = (await concStoreFor("d").list("prj_conc_d")).find((t) => t.id === submitFirst.id)?.poll?.count || 0;
  check("暂停期间已提交任务仍在监控（轮询继续）", polledAfter > polledBefore, { polledBefore, polledAfter, scheduled: pauseSched.size });
  pauseRunner.resume();

  fs.rmSync(root, { recursive: true, force: true });

  console.log("");
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("结论：阶段2 引擎离线测试全部通过（全程未接触平台、未消耗额度）。");
}

main().catch((error) => {
  console.error("测试异常：", error);
  process.exit(1);
});