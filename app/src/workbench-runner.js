"use strict";
/**
 * 任务编排：队列、状态机、退避轮询、取消与重试
 *
 * 设计要点：
 * - 驱动层（driver）由外部注入，本模块不直接接触平台。因此可以用假驱动
 *   在离线环境下完整验证状态机、快照不可变、重试新尝试、下载独立状态等行为。
 * - 单账号单任务优先：默认全局并发 1、每账号并发 1。
 * - 提交结果不确定时，先核实（verifySubmission），核实不到就标记
 *   「提交结果待确认」，绝不盲目重复提交。
 * - 登录失效 / 验证码 / 限额 一律把该账号加入暂停并标记「需人工处理」。
 */

const {
  STATUS,
  STATUS_LABEL,
  applyStatus,
  createAttempt,
  isActive,
  isTerminal,
  setError,
  setResult,
  nextAttemptNumber,
} = require("./workbench-task-store");
const { buildPlan, validateParams } = require("./workbench-platform");

const ACCOUNT_BLOCK_PATTERNS = [
  { code: "AUTH", re: /登录|未登录|登录失效|重新登录|unauthor|401|403/i, label: "登录状态失效" },
  { code: "CAPTCHA", re: /验证码|人机|captcha|challenge/i, label: "出现验证码/人机校验" },
  { code: "QUOTA", re: /额度|限额|配额|次数不足|quota|limit exceeded/i, label: "额度或限额受限" },
];

function classifyBlock(message) {
  const text = String(message || "");
  for (const rule of ACCOUNT_BLOCK_PATTERNS) if (rule.re.test(text)) return rule;
  return null;
}

/** 每一步的可见说明：优先取失败原因 / 实际命中项，成功也给一句人话 */
function stepDetail(s) {
  if (s?.reason) return String(s.reason);
  if (s?.picked) return `已选择 ${s.picked}`;
  if (s?.clicked) return `命中控件：${s.clicked}`;
  if (Number(s?.count)) return `已上传 ${s.count} 张参考图`;
  if (s?.skipped) return "已跳过";
  if (s?.step === "setPrompt") return "已写入提示词";
  if (s?.step === "readState") return "已读取页面状态";
  return "";
}

/** 步骤列表 → 可落库、可展示的形式 */
function summarizeSteps(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((s) => ({
    step: String(s?.step || "").slice(0, 40),
    ok: s?.ok !== false,
    detail: stepDetail(s).slice(0, 200),
  }));
}

/** 提交进行中的中间态：界面据此显示「正在提交」与已完成的步骤 */
function runningDriver(message, steps = []) {
  return {
    outcome: "running",
    message: String(message || "提交进行中…").slice(0, 500),
    at: new Date().toISOString(),
    steps: summarizeSteps(steps),
    candidates: [],
  };
}

/** 把驱动层返回的步骤整理成可落库、可展示的形式（界面据此给出可见反馈） */
function summarizeDriver(submitted) {
  const list = Array.isArray(submitted?.steps) ? submitted.steps : [];
  const sendStep = list.find((s) => s?.step === "send");
  return {
    outcome: String(submitted?.outcome || "").slice(0, 20),
    message: String(submitted?.message || "").slice(0, 500),
    at: new Date().toISOString(),
    steps: summarizeSteps(list),
    candidates: (sendStep?.candidates || submitted?.candidates || []).slice(0, 12).map((c) => String(c).slice(0, 120)),
  };
}

function createRunner(options = {}) {
  const taskStore = options.taskStore;
  const driver = options.driver;
  const resolveAssets = options.resolveAssets || (async () => new Map());
  const capabilities = options.capabilities || null;
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancelSchedule = options.cancelSchedule || ((handle) => clearTimeout(handle));
  const onChanged = options.onChanged || (() => {});
  const log = options.log || (() => {});
  const globalConcurrency = options.globalConcurrency ?? 1;
  const perAccountConcurrency = options.perAccountConcurrency ?? 1;
  const pollBaseMs = options.pollBaseMs ?? 3000;
  const pollMaxMs = options.pollMaxMs ?? 30000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 30 * 60 * 1000;

  const state = {
    paused: false,
    running: new Map(), // attemptId -> {projectId, accountId, startedAt}
    timers: new Map(), // attemptId -> handle
    blockedAccounts: new Map(), // accountId -> {code,label,message,at}
    lastTick: "",
  };

  const runningCountFor = (accountId) =>
    [...state.running.values()].filter((r) => r.accountId === accountId).length;

  function notify() {
    onChanged();
  }

  function clearTimer(attemptId) {
    const handle = state.timers.get(attemptId);
    if (handle !== undefined) {
      state.timers.delete(attemptId);
      cancelSchedule(handle);
    }
  }

  async function loadRecord(projectId, attemptId) {
    const tasks = await taskStore.list(projectId);
    return tasks.find((t) => t.id === attemptId) || null;
  }

  async function patch(projectId, attemptId, mutator) {
    const record = await taskStore.update(projectId, attemptId, mutator);
    notify();
    return record;
  }

  function targetOf() {
    return options.target || "dola";
  }

  function blockAccount(accountId, rule, message) {
    state.blockedAccounts.set(accountId, {
      code: rule?.code || "UNKNOWN",
      label: rule?.label || "需要人工确认",
      message: String(message || "").slice(0, 300),
      at: new Date().toISOString(),
    });
    notify();
  }

  // ── 入队 ──────────────────────────────────────────────────
  async function enqueue(input = {}) {
    const { projectId, storyboardId, accountId } = input;
    if (!projectId) throw new Error("缺少项目标识");
    if (!storyboardId) throw new Error("缺少分镜标识");
    if (!accountId) throw new Error("请选择执行账号");

    const tasks = await taskStore.list(projectId);
    const record = createAttempt({
      projectId,
      storyboardId,
      storyboardName: input.storyboardName,
      accountId,
      attempt: nextAttemptNumber(tasks, projectId, storyboardId),
      retryOf: input.retryOf || "",
      params: input.params,
      refs: input.refs,
      note: input.note,
      canCancel: input.canCancel !== false,
    });
    await taskStore.append(projectId, record);
    notify();
    log("enqueue", { attemptId: record.id, accountId, storyboardId });
    return record;
  }

  // ── 单次执行 ───────────────────────────────────────────────
  async function execute(projectId, attemptId) {
    clearTimer(attemptId);
    const record = await loadRecord(projectId, attemptId);
    if (!record) throw new Error("任务不存在");
    if (isTerminal(record.status)) return record;
    const blocked = state.blockedAccounts.get(record.accountId);
    if (blocked) {
      return patch(projectId, attemptId, (r) => {
        setError(r, blocked.code, `${blocked.label}：${blocked.message}`);
        if (r.status !== STATUS.MANUAL) applyStatus(r, STATUS.MANUAL, "账号处于暂停状态，已停止执行");
        return r;
      });
    }

    state.running.set(attemptId, { projectId, accountId: record.accountId, startedAt: Date.now() });
    notify();

    // 中途步骤与最终结果都会写同一个 tasks.json：串行化写入，保证最终结果最后落盘。
    // 声明在 try 之外，catch 里才能等它们落地后再写失败结果。
    const liveSteps = [];
    let writeChain = Promise.resolve();
    const onStep = (step) => {
      liveSteps.push(step);
      writeChain = writeChain
        .then(() =>
          patch(projectId, attemptId, (r) => {
            r.driver = runningDriver("提交进行中…", liveSteps);
            return r;
          })
        )
        .catch(() => {});
    };

    try {
      // 1) 快照校验 + 计划
      const assetsById = await resolveAssets(projectId, record.refs);
      const plan = buildPlan({ target: targetOf(), attempt: record, assetsById, capabilities });
      if (!plan.valid) {
        await patch(projectId, attemptId, (r) => {
          setError(r, "INVALID_PARAMS", plan.errors.join("；"));
          if (r.status !== STATUS.MANUAL) applyStatus(r, STATUS.MANUAL, "参数不满足提交条件，已拒绝提交");
          return r;
        });
        return;
      }

      // 2) 提交
      await patch(projectId, attemptId, (r) => {
        if (r.status === STATUS.PENDING) applyStatus(r, STATUS.SUBMITTING, "开始提交");
        return r;
      });
      // 提交期间也必须有可见反馈：先写一条「进行中」，避免界面看起来完全没反应
      await patch(projectId, attemptId, (r) => {
        r.driver = runningDriver("正在打开账号页面并逐步提交…");
        return r;
      });

      const submitted = await driver.submit({ accountId: record.accountId, plan, attempt: record, onStep });
      const outcome = String(submitted?.outcome || (submitted?.platformTaskId ? "ok" : "unknown"));

      // 等中途写入全部落地后，再写最终结果：界面即使失败也能看到「卡在哪一步」
      await writeChain;
      await patch(projectId, attemptId, (r) => {
        r.driver = summarizeDriver(submitted);
        return r;
      });

      if (outcome === "failed") {
        const rule = classifyBlock(submitted?.message);
        await patch(projectId, attemptId, (r) => {
          setError(r, submitted?.errorCode || rule?.code || "SUBMIT_FAILED", submitted?.message || "提交失败");
          applyStatus(r, rule ? STATUS.MANUAL : STATUS.FAILED, rule ? rule.label : "提交失败");
          return r;
        });
        if (rule) blockAccount(record.accountId, rule, submitted?.message);
        return;
      }

      if (outcome === "unknown" || !submitted?.platformTaskId) {
        // 超时或结果不明：先核实，核实不到就挂起等人工，绝不重复提交
        const verified = driver.verifySubmission
          ? await driver.verifySubmission({ accountId: record.accountId, attempt: record }).catch(() => null)
          : null;
        if (verified?.found && verified.platformTaskId) {
          await patch(projectId, attemptId, (r) => {
            r.platformTaskId = verified.platformTaskId;
            applyStatus(r, STATUS.QUEUED, "提交结果经核实后确认");
            return r;
          });
        } else {
          await patch(projectId, attemptId, (r) => {
            r.poll = { ...r.poll, message: "提交结果不确定，等待人工核实" };
            applyStatus(r, STATUS.UNCONFIRMED, verified?.message || "提交结果待确认，未再次提交");
            return r;
          });
          return;
        }
      } else {
        const nextStatus = submitted.state === STATUS.GENERATING ? STATUS.GENERATING : STATUS.QUEUED;
        await patch(projectId, attemptId, (r) => {
          r.platformTaskId = submitted.platformTaskId;
          r.canCancel = submitted.canCancel !== false;
          applyStatus(r, nextStatus, submitted.message || "已提交到平台");
          return r;
        });
      }

      schedulePoll(projectId, attemptId, 0);
    } catch (error) {
      const rule = classifyBlock(error?.message);
      // 先让中途写入落地，再把「进行中」改成失败，避免被后到的步骤写入覆盖
      await writeChain;
      await patch(projectId, attemptId, (r) => {
        r.driver = {
          ...runningDriver(`执行中断：${error?.message || String(error)}`, liveSteps),
          outcome: "failed",
        };
        setError(r, rule?.code || "RUNNER_ERROR", error?.message || String(error));
        if (!isTerminal(r.status)) {
          if (r.status === STATUS.PENDING) applyStatus(r, STATUS.SUBMITTING);
          applyStatus(r, rule ? STATUS.MANUAL : STATUS.UNCONFIRMED, "执行中断，需人工确认");
        }
        return r;
      });
      if (rule) blockAccount(record.accountId, rule, error?.message);
    } finally {
      state.running.delete(attemptId);
      notify();
    }
  }

  // ── 轮询（带退避） ─────────────────────────────────────────
  function schedulePoll(projectId, attemptId, delayMs) {
    clearTimer(attemptId);
    // 注意：回调必须把 promise 返回出去，否则调度不可等待（测试与关闭流程都无法同步）
    const handle = schedule(() => {
      state.timers.delete(attemptId);
      return pollOnce(projectId, attemptId).catch((error) => log("poll-error", { attemptId, message: error?.message }));
    }, Math.max(0, delayMs));
    state.timers.set(attemptId, handle);
  }

  async function pollOnce(projectId, attemptId) {
    const record = await loadRecord(projectId, attemptId);
    if (!record || isTerminal(record.status)) return;
    if (state.paused) {
      schedulePoll(projectId, attemptId, pollBaseMs);
      return;
    }
    if (!record.platformTaskId) return;

    const startedAt = Date.parse(record.submittedAt || record.createdAt) || Date.now();
    if (Date.now() - startedAt > pollTimeoutMs) {
      await patch(projectId, attemptId, (r) => {
        r.poll = { ...r.poll, stale: true, message: "长时间未取得新状态" };
        applyStatus(r, STATUS.MANUAL, "监控超时：长时间未取得新状态，请人工核实");
        return r;
      });
      return;
    }

    let polled = null;
    try {
      polled = await driver.poll({
        accountId: record.accountId,
        platformTaskId: record.platformTaskId,
        attempt: record,
      });
    } catch (error) {
      polled = { state: "unknown", message: error?.message || String(error) };
    }

    const attemptCount = (record.poll?.count || 0) + 1;
    const backoff = Math.min(pollMaxMs, Math.round(pollBaseMs * Math.pow(1.6, attemptCount)));
    const at = new Date().toISOString();

    const rule = polled?.state === "failed" ? classifyBlock(polled?.message) : null;

    await patch(projectId, attemptId, (r) => {
      r.poll = {
        count: attemptCount,
        lastAt: at,
        nextAt: new Date(Date.now() + backoff).toISOString(),
        message: String(polled?.message || "").slice(0, 300),
        stale: false,
      };
      if (polled?.state === "succeeded") {
        setResult(r, polled.result || {});
        applyStatus(r, STATUS.SUCCEEDED, "平台返回生成成功");
      } else if (polled?.state === "failed") {
        setError(r, polled?.errorCode || rule?.code || "GENERATE_FAILED", polled?.message || "平台返回生成失败");
        applyStatus(r, rule ? STATUS.MANUAL : STATUS.FAILED, rule ? rule.label : "平台返回生成失败");
      } else if (polled?.state === "generating" && r.status !== STATUS.GENERATING) {
        r.canCancel = polled.canCancel !== false;
        applyStatus(r, STATUS.GENERATING, polled.message || "平台生成中");
      } else if (polled?.state === "queued" && r.status !== STATUS.QUEUED) {
        applyStatus(r, STATUS.QUEUED, polled.message || "平台排队中");
      }
      return r;
    });

    if (rule) blockAccount(record.accountId, rule, polled?.message);

    const latest = await loadRecord(projectId, attemptId);
    if (latest && !isTerminal(latest.status) && latest.status !== STATUS.MANUAL) {
      schedulePoll(projectId, attemptId, backoff);
    }
  }

  // ── 队列调度 ──────────────────────────────────────────────
  async function tick() {
    state.lastTick = new Date().toISOString();
    if (state.paused) return { started: [] };
    const started = [];
    const projects = options.listProjectIds ? await options.listProjectIds() : [];
    for (const projectId of projects) {
      const tasks = await taskStore.list(projectId);
      for (const task of tasks.filter((t) => t.status === STATUS.PENDING)) {
        if (state.running.size >= globalConcurrency) return { started };
        if (runningCountFor(task.accountId) >= perAccountConcurrency) continue;
        started.push(task.id);
        execute(projectId, task.id).catch(() => {});
      }
    }
    return { started };
  }

  // ── 暂停 / 恢复 / 取消 / 重试 ──────────────────────────────
  function pause() {
    state.paused = true;
    notify();
    return { paused: true };
  }

  function resume() {
    state.paused = false;
    notify();
    tick().catch(() => {});
    return { paused: false };
  }

  function clearAccountBlock(accountId) {
    state.blockedAccounts.delete(accountId);
    notify();
  }

  /**
   * 取消：仅当平台支持取消时才真正取消；
   * 已提交但平台不支持取消的，只能保持原状态并说明原因。
   */
  async function cancel(projectId, attemptId) {
    const record = await loadRecord(projectId, attemptId);
    if (!record) throw new Error("任务不存在");
    if (record.status === STATUS.PENDING) {
      return patch(projectId, attemptId, (r) => applyStatus(r, STATUS.CANCELED, "尚未提交，已在本地取消"));
    }
    if (isTerminal(record.status)) return record;
    if (!record.platformTaskId) {
      return patch(projectId, attemptId, (r) => {
        r.poll = { ...r.poll, message: "无平台任务 ID，无法确认取消结果" };
        applyStatus(r, STATUS.MANUAL, "无法取消：缺少平台任务 ID，请人工核实");
        return r;
      });
    }
    const result = await driver.cancel?.({
      accountId: record.accountId,
      platformTaskId: record.platformTaskId,
      attempt: record,
    });
    if (result?.canceled) {
      clearTimer(attemptId);
      return patch(projectId, attemptId, (r) => applyStatus(r, STATUS.CANCELED, result.message || "平台已取消"));
    }
    return patch(projectId, attemptId, (r) => {
      r.poll = { ...r.poll, message: result?.reason || "平台不支持取消" };
      return r;
    });
  }

  /** 重试 = 新建尝试记录，历史保留 */
  async function retry(projectId, attemptId) {
    const record = await loadRecord(projectId, attemptId);
    if (!record) throw new Error("任务不存在");
    if (isActive(record.status) && record.status !== STATUS.MANUAL && record.status !== STATUS.UNCONFIRMED) {
      throw new Error("任务仍在进行中，不能重试");
    }
    const next = await enqueue({
      projectId,
      storyboardId: record.storyboardId,
      storyboardName: record.storyboardName,
      accountId: record.accountId,
      params: record.params,
      refs: record.refs,
      retryOf: record.id,
      note: `第 ${record.attempt} 次尝试的重试`,
    });
    await execute(projectId, next.id);
    return next;
  }

  /** 重启后恢复追踪：把仍然活跃的记录重新纳入轮询，长时间无更新则标记监控异常 */
  async function recover() {
    const projects = options.listProjectIds ? await options.listProjectIds() : [];
    const resumed = [];
    const stale = [];
    for (const projectId of projects) {
      const tasks = await taskStore.list(projectId);
      for (const task of tasks) {
        if (!isActive(task.status)) continue;
        if (task.status === STATUS.PENDING) continue;
        const last = Date.parse(task.poll?.lastAt || task.updatedAt || task.createdAt) || 0;
        if (Date.now() - last > (options.staleMs ?? 5 * 60 * 1000)) {
          stale.push(task.id);
          await patch(projectId, task.id, (r) => {
            r.poll = { ...r.poll, stale: true, message: "重启后长时间无更新，请人工核实" };
            if (r.status !== STATUS.UNCONFIRMED && r.status !== STATUS.MANUAL) {
              applyStatus(r, STATUS.MANUAL, "监控异常：重启后长时间无新状态");
            }
            return r;
          });
        } else {
          resumed.push(task.id);
          schedulePoll(projectId, task.id, pollBaseMs);
        }
      }
    }
    return { resumed, stale };
  }

  function status() {
    return {
      paused: state.paused,
      running: [...state.running.entries()].map(([id, info]) => ({ attemptId: id, ...info })),
      blockedAccounts: [...state.blockedAccounts.entries()].map(([accountId, info]) => ({ accountId, ...info })),
      lastTick: state.lastTick,
      limits: { globalConcurrency, perAccountConcurrency },
    };
  }

  return {
    cancel,
    clearAccountBlock,
    enqueue,
    execute,
    pause,
    recover,
    resume,
    retry,
    status,
    tick,
  };
}

module.exports = { ACCOUNT_BLOCK_PATTERNS, classifyBlock, createRunner, summarizeDriver };