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
    platform.validateParams({ params: { ...okParams, duration: "7" }, capabilities: CAPS }).errors.join().includes("不在平台能力表")
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
  check("比例给出警告而非伪造能力", ratioWarn.warnings.join().includes("未提供比例能力表"));
  const refWarn = platform.validateParams({
    params: okParams,
    refs: [{ token: "@图1", filePath: "x.png" }],
    capabilities: CAPS,
  });
  check("参考图上限未知时给出警告", refWarn.warnings.join().includes("未声明参考图数量上限"));

  const described = platform.describeCapabilities(CAPS, "dola");
  eq("比例标记为未知", described.unknown.ratio, true);
  eq("参考图上限标记为未知", described.unknown.maxReferenceImages, true);
  eq("额度标记为未知", described.unknown.quota, true);
  check("模型来自真实能力表", described.models.includes("seedance2.5"));

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
  eq("原子占位符使用 \\uFFFC", platform.segmentsToPlainText(segments).includes("\uFFFC"), true);
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
  const unknownDriver = createRunner({
    taskStore,
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
    schedule: sched.schedule,
    cancelSchedule: sched.cancel,
    resolveAssets: async () => assetsById,
    listProjectIds: async () => [projectId],
  });
  const unconfirmed = await unknownDriver.enqueue({
    projectId,
    storyboardId: "sb_unknown",
    accountId: "acc_1",
    params: goodParams,
    refs: goodRefs,
  });
  await unknownDriver.execute(projectId, unconfirmed.id);
  const unconfirmedNow = (await taskStore.list(projectId)).find((t) => t.id === unconfirmed.id);
  eq("核实不到时标记提交结果待确认", unconfirmedNow.status, "unconfirmed");
  eq("提交只发生一次（未盲目重复提交）", calls.submit, 1);
  eq("确实做了核实", calls.verify, 1);
  check("没有安排轮询", sched.size === 0);

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

  // ══ 10. 下载 ══
  console.log("── 下载 ──");
  eq("文件名含项目/分镜/尝试", download.buildFileName({ projectName: "短剧A", storyboardIndex: 3, attemptNumber: 2, url: "https://x/v.mp4" }), "短剧A_分镜03_尝试02.mp4");
  eq("非法字符被替换", download.sanitizeSegment('a/b:c*?"<>|'), "a_b_c" + "_".repeat(6));
  eq("webm 扩展名按 MIME", download.extensionFor("https://x/v", "video/webm"), ".webm");
  eq("未知 MIME 回退 mp4", download.extensionFor("https://x/v", "application/octet-stream"), ".mp4");

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
  task.setResult(dlAttempt, { videoUrl: "https://example.com/v.mp4" });
  await dlStore.append("prj_dl", dlAttempt);

  const failingDownloader = download.createDownloader({
    taskStore: dlStore,
    outputDirFor: async () => dlDir,
    fetchToFile: async ({ filePath }) => {
      fs.writeFileSync(filePath, "partial");
      return { ok: false, error: "连接被重置" };
    },
  });
  const dlResult = await failingDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1 });
  eq("下载失败被如实返回", dlResult.ok, false);
  const afterFail = (await dlStore.list("prj_dl"))[0];
  eq("下载失败后生成状态仍是成功", afterFail.status, "succeeded");
  eq("下载状态为失败", afterFail.download.status, "failed");
  eq("生成结果未被清空", afterFail.result.videoUrl, "https://example.com/v.mp4");

  fs.rmSync(dlDir, { recursive: true, force: true });
  const okDownloader = download.createDownloader({
    taskStore: dlStore,
    outputDirFor: async () => dlDir,
    fetchToFile: async ({ filePath }) => {
      fs.writeFileSync(filePath, "video-bytes");
      return { ok: true, bytes: 11, mime: "video/mp4" };
    },
  });
  const firstDownload = await okDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1 });
  check("下载成功", firstDownload.ok, firstDownload);
  check("文件名符合命名规则", /短剧A_分镜01_尝试01\.mp4$/.test(firstDownload.filePath), firstDownload.filePath);
  const secondDownload = await okDownloader.download({ projectId: "prj_dl", attemptId: dlAttempt.id, projectName: "短剧A", storyboardIndex: 1 });
  check("重复下载不覆盖历史文件", secondDownload.filePath !== firstDownload.filePath, secondDownload.filePath);
  check("重复下载结果仍在", fs.existsSync(firstDownload.filePath) && fs.existsSync(secondDownload.filePath));

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
  eq("上传类步骤记录数量", summarized.steps[3].detail, "已上传 2 张参考图");
  eq("发送失败原因被带出", summarized.steps[4].detail, "页面上找不到发送按钮，无法提交生成");
  eq("候选控件清单被带出（供首次实机校准）", summarized.candidates.length, 1);
  eq("候选控件来自发送步骤", summarized.candidates[0], "label:发送");

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

  // 12.3 比例：给出常见候选值，且继续标注「平台能力未核实」
  check("比例候选值非空", platform.RATIO_OPTIONS.length >= 4, platform.RATIO_OPTIONS);
  check(
    "比例候选含 16:9 与 9:16",
    platform.RATIO_OPTIONS.includes("16:9") && platform.RATIO_OPTIONS.includes("9:16"),
    platform.RATIO_OPTIONS
  );
  check(
    "比例控件选择器已登记（探测不到会如实回报而不是猜）",
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
  check("比例仍被标注为未核实", /未核实|以平台实际结果为准/.test(ratioWarning), ratioWarning);
  check("比例不再声称「不会被提交」", !/不会被提交/.test(ratioWarning), ratioWarning);

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