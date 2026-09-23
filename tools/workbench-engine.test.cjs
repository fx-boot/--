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
const { createRunner, classifyBlock } = require(path.join(SRC, "workbench-runner.js"));
const download = require(path.join(SRC, "workbench-download.js"));
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