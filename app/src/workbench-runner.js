"use strict";
/**
 * 任务编排：队列、状态机、退避轮询、取消与重试
 *
 * 设计要点：
 * - 驱动层（driver）由外部注入，本模块不直接接触平台。因此可以用假驱动
 *   在离线环境下完整验证状态机、快照不可变、重试新尝试、下载独立状态等行为。
 * - 并发：默认全局并发 3（可配置）、每账号并发 1；不同账号的上传/提交/监控可重叠。
 * - 提交结果不确定时，先核实（verifySubmission），核实不到就标记
 *   「提交结果待确认」，绝不盲目重复提交。
 * - 登录失效 / 验证码 / 限额 一律把该账号加入暂停并标记「需人工处理」。
 */

const {
  STATUS,
  STATUS_LABEL,
  applyStatus,
  canTransition,
  createAttempt,
  isActive,
  isTerminal,
  setError,
  setResult,
  nextAttemptNumber,
} = require("./workbench-task-store");
const { buildPlan, validateParams } = require("./workbench-platform");

const ACCOUNT_BLOCK_PATTERNS = [
  // AUTH 必须由「登录/鉴权」语义或明确的 HTTP 401/403 语义触发。
  // 旧实现含裸 `401|403`，会把任意含这两个数字的文本（例如网络请求摘要里的
  // 「RESP /list→403」）误判成「登录状态失效」，进而把账号封停、后续任务全部转人工。
  {
    code: "AUTH",
    re: /未登录|(?:请(?:先)?|需要|重新)登录|登录(?:状态)?(?:已|已经)?(?:失效|过期|超时|失败)|unauthoriz|未授权|鉴权失败|认证失败|HTTP\s*40[13]|40[13]\s*(?:Unauthorized|Forbidden)/i,
    label: "登录状态失效",
  },
  { code: "CAPTCHA", re: /验证码|人机|captcha|challenge/i, label: "出现验证码/人机校验" },
  { code: "QUOTA", re: /额度|限额|配额|次数不足|quota|limit exceeded/i, label: "额度或限额受限" },
];

// 仅对用户指定的明确拒绝启用有限重提；不把其他平台规则拒绝当作临时错误。
function isPortraitRetry(response) {
  const text = String(response?.platformReply?.text || response?.message || "");
  return response?.errorCode === "FACE_UNVERIFIED" && /未认证人脸/.test(text) && /Dreamina\s+Seedance\s+2\.5/i.test(text) && /暂不支持/.test(text);
}

function classifyBlock(message, errorCode = "") {
  const codes = { AUTH: "AUTH", SESSION_EXPIRED: "AUTH", CAPTCHA: "CAPTCHA", QUOTA: "QUOTA", QUOTA_EXHAUSTED: "QUOTA" };
  const code = codes[String(errorCode).toUpperCase()];
  if (code) return ACCOUNT_BLOCK_PATTERNS.find((rule) => rule.code === code);
  // 正常/否定证据不能把整个账号封停；仍保留同一句中其他真实故障的证据。
  const text = String(message || "")
    .replace(/(?:未|没有|无需|不需要)(?:出现|检测到|触发|完成|进行)?(?:验证码|人机校验)/g, "")
    .replace(/(?:验证码|人机校验)(?:已通过|通过|正常)/g, "")
    .replace(/(?:额度|配额|限额)(?:充足|正常|未用完|未耗尽|未达到)/g, "")
    .replace(/\b(?:no|without)\s+(?:captcha|challenge)\b/gi, "");
  for (const rule of ACCOUNT_BLOCK_PATTERNS) if (rule.re.test(text)) return rule;
  return null;
}

/** 每一步的可见说明：优先取失败原因 / 实际命中项，并补上主进程侧的页面事实 */
function stepDetail(s) {
  const bits = [];
  // panelStage / 显式带 detail 的步骤：原样展示（六控件状态、阶段、耗时），
  // 否则下面规则认不出 panelStage 会落成空串。
  if (s?.detail) bits.push(String(s.detail));
  else if (s?.reason) bits.push(String(s.reason));
  else if (s?.skipped) bits.push("已跳过");
  else if (s?.clicked) bits.push(`命中控件：${s.clicked}`);
  else if (s?.picked && s?.after) bits.push(`已选择 ${s.picked}（回读 ${s.after}）`);
  else if (s?.picked) bits.push(`已选择 ${s.picked}`);
  else if (s?.step === "enterVideoMode") bits.push("已进入视频生成模式");
  else if (s?.step === "waitReady") bits.push("页面已就绪");
  else if (s?.step === "waitComposer") bits.push("输入区已就绪（编辑器/上传入口/发送按钮齐全）");
  else if (s?.step === "attachmentsPre") bits.push(`输入区已有 ${Number(s?.count) || 0} 张参考图（核对归属后复用）`);
  else if (s?.step === "attachImages")
    bits.push(
      `参考图 ${Number(s?.count) || 0}/${Number(s?.expected) || Number(s?.count) || 0} 张` +
        (Number(s?.reused) ? `（复用 ${s.reused} 张，未重复上传）` : "") +
        (Number(s?.removedExtras) ? `（移除本工具残留 ${s.removedExtras} 张）` : "")
    );
  else if (Number(s?.count)) bits.push(`已上传 ${s.count} 张参考图`);
  else if (s?.step === "verifyRefs")
    bits.push(
      `参考图核实 缩略图 ${Number(s?.attachmentCards) || 0}/${Number(s?.expected) || 0}、顺序一致：${
        s?.orderMatched === false ? "否" : "是"
      }`
    );
  else if (s?.step === "openPage") bits.push("已找到账号页面");
  else if (s?.step === "setPrompt") bits.push("已写入提示词");
  else if (s?.step === "sendReaction")
    bits.push(
      s?.started
        ? `页面已起反应（${[s.editorEmptied ? "编辑器已清空" : "", s.changedUrl ? "地址已变化" : "", s.moreMessages ? "出现新消息" : ""].filter(Boolean).join("、") || "有生成相关提示"}）`
        : `点击后页面没有任何反应${s?.hints?.length ? `（页面提示：${s.hints.join("、")}）` : ""}`
    );
  else if (s?.step === "platformReply") bits.push("已核对平台回复");
  else if (s?.step === "setDurationEnhancement")
    bits.push(
      s?.skipped
        ? "使用平台原生时长"
        : s?.ok
          ? `已开启时长增强（请求体改写为 ${Number(s?.requiredSeconds) || 0} 秒）`
          : "时长增强条件不满足"
    );
  else if (s?.step === "readState") bits.push("已读取页面状态");

  // 页面地址 / 加载中 / 渲染进程崩溃：这些是判断「是不是撞了登录墙或页面没加载完」的依据
  const url = String(s?.pageUrl || s?.url || "");
  if (url && !bits.some((bit) => bit.includes(url))) bits.push(`页面：${url}`);
  if (s?.sessionMatched === false) bits.push("会话归属无法核实");
  else if (s?.storageUnderUserData === false) bits.push("会话存储不在本实例数据目录");
  else if (s?.storagePath) bits.push(`会话存储：${String(s.storagePath).slice(0, 80)}`);
  if (s?.inVideoMode === false) bits.push("不在视频生成模式");
  if (s?.activation) {
    bits.push(
      s.activation.lifecycle === "active"
        ? `后台页面已激活（生命周期 active${s.activation.focusEmulated ? "、已模拟焦点" : ""}）`
        : `后台页面未能激活${(s.activation.errors || []).length ? `（${s.activation.errors.join("；")}）` : ""}`
    );
  }
  if (s?.loading) bits.push("页面仍在加载");
  if (s?.crashed) bits.push("渲染进程已崩溃");
  if (Number(s?.webContentsId)) bits.push(`webContents #${s.webContentsId}`);
  return bits.join(" · ");
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
    // 受理/重试判定所依据的证据（原样落库，便于事后核对，不臆断）
    accepted: submitted?.accepted === true,
    retryable: submitted?.retryable === true,
    needsUser: submitted?.needsUser === true,
    evidence: submitted?.evidence || null,
    acceptanceEvidence: submitted?.acceptanceEvidence || null,
    durationEvidence: submitted?.durationEvidence || null,
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
  const globalConcurrency = options.globalConcurrency ?? 3;
  const perAccountConcurrency = options.perAccountConcurrency ?? 1;
  const pollBaseMs = options.pollBaseMs ?? 3000;
  const pollMaxMs = options.pollMaxMs ?? 10000;
  // 监控看门狗默认 6 小时：旧默认是 Infinity，等于把看门狗关掉——
  // 遗留的 submitting/queued/generating 记录会永远轮询、永不收尾为「需人工处理」，
  // 用户看到的是一条永远「生成中」的任务。给一个可被覆盖的有限默认值。
  const pollTimeoutMs = options.pollTimeoutMs ?? 6 * 60 * 60 * 1000;
  // 重启后判定「长时间无更新」的阈值：默认 30 分钟（旧默认 Infinity 会让该分支永不触发）
  const staleMs = options.staleMs ?? 30 * 60 * 1000;
  // 轮询连续失败上限：达到后停止轮询并转「需人工处理」，避免无限空转
  const pollErrorLimit = options.pollErrorLimit ?? 5;
  // 自动重试策略：只在「明确没有受理 + 临时可恢复」时触发，默认最多 2 次（总提交 3 次）
  const maxAutoRetries = options.maxAutoRetries ?? 2;
  const autoRetryBaseMs = options.autoRetryBaseMs ?? 8000;
  const autoRetryMaxMs = options.autoRetryMaxMs ?? 60000;

  const state = {
    paused: false,
    running: new Map(), // attemptId -> {projectId, accountId, startedAt}
    timers: new Map(), // attemptId -> handle
    blockedAccounts: new Map(), // accountId -> {code,label,message,at}
    // 提交锁：按「项目 + 分镜 + 账号」加锁 —— 同一分镜发给不同账号必须能并行，
    // 只有同一账号的同一条分镜才互斥（防止重复点击或自动重试与手动点击并发）
    locks: new Map(),
    autoRetries: new Map(), // attemptId -> {count, reason, nextAt, handle}
    lastTick: "",
  };

  const lockKey = (projectId, storyboardId, accountId) => `${projectId}:${storyboardId}:${accountId || "*"}`;

  function lockOf(projectId, storyboardId, accountId) {
    const lock = state.locks.get(lockKey(projectId, storyboardId, accountId));
    if (!lock) return null;
    return lock;
  }

  function takeLock(projectId, storyboardId, accountId, attemptId, reason) {
    state.locks.set(lockKey(projectId, storyboardId, accountId), {
      at: new Date().toISOString(),
      attemptId,
      accountId,
      storyboardId,
      reason,
      until: "",
    });
    notify();
  }

  function releaseLock(projectId, storyboardId, accountId) {
    state.locks.delete(lockKey(projectId, storyboardId, accountId));
    notify();
  }

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

  // 所有入口共用准入检查。串行化的仅是读记录/占槽位，不是平台操作。
  let admissionChain = Promise.resolve();
  const executions = new Map();
  const waitingProjects = new Set();

  function admit(projectId, attemptId) {
    const admission = admissionChain.then(async () => {
      if (executions.has(attemptId)) return { started: false, completion: executions.get(attemptId) };
      const record = await loadRecord(projectId, attemptId);
      if (!record) throw new Error("任务不存在");
      if (record.status !== STATUS.PENDING) return { started: false, record };
      const held = lockOf(projectId, record.storyboardId, record.accountId);
      if (held && held.attemptId !== attemptId) {
        throw new Error(`这条分镜正在提交中（${held.reason}），已跳过重复提交，避免重复消耗额度`);
      }
      if (state.paused || state.running.size >= globalConcurrency || runningCountFor(record.accountId) >= perAccountConcurrency) {
        waitingProjects.add(projectId);
        return { started: false, record };
      }
      state.running.set(attemptId, { projectId, accountId: record.accountId, startedAt: Date.now() });
      let completed = false;
      const completion = Promise.resolve().then(() => executeReserved(projectId, attemptId, record)).then((value) => {
        completed = true;
        return value;
      }).finally(() => {
        state.running.delete(attemptId);
        executions.delete(attemptId);
        notify();
        // 补派曾因槽位不足等待的项目，避免其他项目一直得不到启动机会。
        const projects = new Set(waitingProjects);
        // 落库异常时不立即重派同项目，否则仍为 pending 的记录会陷入紧密重试。
        if (completed) projects.add(projectId);
        else projects.delete(projectId);
        waitingProjects.clear();
        for (const id of projects) void tick(id).catch((error) => log("queue-error", { message: error.message }));
      });
      executions.set(attemptId, completion);
      // tick 不等待整个提交过程，也必须消费其异常，避免未处理的 rejection。
      void completion.catch((error) => log("execute-error", { attemptId, message: error.message }));
      notify();
      return { started: true, completion };
    });
    admissionChain = admission.then(() => undefined, () => undefined);
    return admission;
  }

  async function execute(projectId, attemptId) {
    const admission = await admit(projectId, attemptId);
    return admission.completion ? admission.completion : admission.record;
  }

  // ── 单次执行：只能在准入成功、槽位已登记后调用 ───────────
  const submissionControls = new Map();

  async function executeReserved(projectId, attemptId, record) {
    clearTimer(attemptId);
    const blocked = state.blockedAccounts.get(record.accountId);
    if (blocked) {
      const blockedRecord = await patch(projectId, attemptId, (r) => {
        setError(r, blocked.code, `${blocked.label}：${blocked.message}`);
        if (r.status !== STATUS.MANUAL) applyStatus(r, STATUS.MANUAL, "账号处于暂停状态，已停止执行");
        return r;
      });
      return blockedRecord;
    }

    // 提交锁：同一条分镜在同一时刻只能有一次提交（手动点击与自动重试不能并发）
    const held = lockOf(projectId, record.storyboardId, record.accountId);
    if (held && held.attemptId !== attemptId) {
      notify();
      throw new Error(`这条分镜正在提交中（${held.reason}），已跳过重复提交，避免重复消耗额度`);
    }
    takeLock(projectId, record.storyboardId, record.accountId, attemptId, "正在提交");
    let keepLock = false;

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
      // 附件复用是按「账号 + 分镜」记账的（驱动层的 attachKey 用 plan.storyboardId），
      // buildPlan 本身不产出该字段，这里补上，避免不同分镜共用同一份附件账。
      plan.storyboardId = record.storyboardId;
      if (!plan.valid) {
        await patch(projectId, attemptId, (r) => {
          setError(r, "INVALID_PARAMS", plan.errors.join("；"));
          if (r.status !== STATUS.MANUAL) applyStatus(r, STATUS.MANUAL, "参数不满足提交条件，已拒绝提交");
          return r;
        });
        return;
      }

      // 2) 提交
      let claimed = false;
      await patch(projectId, attemptId, (r) => {
        if (r.status !== STATUS.PENDING) return false;
        applyStatus(r, STATUS.SUBMITTING, "开始提交");
        claimed = true;
        return r;
      });
      if (!claimed) return;
      // 提交期间也必须有可见反馈：先写一条「进行中」，避免界面看起来完全没反应
      await patch(projectId, attemptId, (r) => {
        r.driver = runningDriver("正在打开账号页面并逐步提交…");
        return r;
      });

      if ((await loadRecord(projectId, attemptId))?.interruption?.stopped) return;
      const control = { requested: false, dispatched: false };
      submissionControls.set(attemptId, control);
      const checkInterrupted = () => {
        if (control.requested && !control.dispatched) {
          const error = new Error("已中断提交，未点击发送");
          error.code = "LOCAL_INTERRUPTED";
          throw error;
        }
      };
      const submitted = await driver.submit({ accountId: record.accountId, plan, attempt: record, onStep,
        checkInterrupted,
        onBeforeSend: () => { checkInterrupted(); control.dispatched = true; },
      });
      const outcome = String(submitted?.outcome || (submitted?.platformTaskId ? "ok" : "unknown"));

      // 等中途写入全部落地后，再写最终结果：界面即使失败也能看到「卡在哪一步」
      await writeChain;
      await patch(projectId, attemptId, (r) => {
        r.driver = summarizeDriver(submitted);
        if (submitted?.platformTaskId) r.platformTaskId = submitted.platformTaskId;
        if (submitted?.platformContext) r.platformContext = submitted.platformContext;
        if (submitted?.platformReply?.text) r.platformReply = submitted.platformReply;
        return r;
      });

      if ((await loadRecord(projectId, attemptId))?.interruption?.stopped) return;

      if (outcome === "failed") {
        const rule = classifyBlock(submitted?.message, submitted?.errorCode);
        await patch(projectId, attemptId, (r) => {
          setError(r, submitted?.errorCode || rule?.code || "SUBMIT_FAILED", submitted?.message || "提交失败");
          applyStatus(r, rule ? STATUS.MANUAL : STATUS.FAILED, rule ? rule.label : "提交失败");
          return r;
        });
        if (rule) blockAccount(record.accountId, rule, submitted?.message);
        const portraitRetry = isPortraitRetry(submitted);
        // 只有指定的肖像回复例外；其他需人工处理的拒绝不自动重试。
        if (!portraitRetry && (submitted?.needsUser || !submitted?.retryable)) {
          releaseLock(projectId, record.storyboardId, record.accountId);
          return;
        }
        // 明确「没有受理 + 临时可恢复」：按上限自动重试
        const retried = await scheduleAutoRetry(projectId, attemptId, portraitRetry ? { ...submitted, retryAfterMs: 30000 } : submitted);
        if (retried) keepLock = true;
        return;
      }

      if (outcome === "accepted" && submitted?.accepted) {
        // 平台已受理但没有任务 ID：停止重复提交、转入监控（不算生成成功）
        await patch(projectId, attemptId, (r) => {
          r.accepted = true;
          r.acceptanceEvidence = submitted?.acceptanceEvidence || { kind: "platform-message" };
          applyStatus(r, STATUS.QUEUED, submitted?.message || "平台已受理，等待任务 ID");
          return r;
        });
        releaseLock(projectId, record.storyboardId, record.accountId);
        schedulePoll(projectId, attemptId, pollBaseMs);
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
          // 「提交结果待确认」同样必须继续监控：平台可能已经受理并生成完成，只是提交时
          // 没抓到任务 ID。旧实现在这里直接 return、不再安排轮询，于是任务永远停在
          // 「提交结果待确认」，连平台给出的明确拒绝（如额度用尽）都读不到
          // （实测 2026-09-24 真实提交 att_d56d75641fc4）。
          // 监控只读取页面，不会重复提交、也不会换模型重发。
          schedulePoll(projectId, attemptId, pollBaseMs);
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
      if ((await loadRecord(projectId, attemptId))?.interruption?.stopped) return;
      const rule = classifyBlock(error?.message, error?.code);
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
      submissionControls.delete(attemptId);
      // 有自动重试在排队时保留提交锁，避免手动再点一次造成并发提交
      if (!keepLock) releaseLock(projectId, record.storyboardId, record.accountId);
      notify();
    }
  }

  /**
   * 自动重试：只在「明确没有受理 + 临时可恢复」时调用。
   * 每次重试都是一条新的尝试记录（关联同一条分镜），保留全部证据。
   * 重试前先复核是否已有本次任务被受理，避免重复消耗额度。
   */
  async function scheduleAutoRetry(projectId, attemptId, submitted) {
    const record = await loadRecord(projectId, attemptId);
    if (!record || record.interruption?.stopped || record.autoRetry?.stopped || state.autoRetries.has(attemptId)) return false;
    // 复核：已经有任务 ID / 已被受理，绝不重试
    if (record.platformTaskId || record.accepted) {
      log("auto-retry-skip", { attemptId, reason: "已有受理证据" });
      return false;
    }
    // 重试次数按「同一条分镜的尝试链」累计，避免每次重试都从 0 重新开始
    const performed = await autoRetryCountOf(projectId, record);
    if (performed >= maxAutoRetries) {
      await patch(projectId, attemptId, (r) => {
        r.autoRetry = { count: performed, max: maxAutoRetries, stopped: true, reason: "已达自动重试上限，停止重试" };
        return r;
      });
      log("auto-retry-exhausted", { attemptId, performed });
      return false;
    }
    const count = performed + 1;
    const requested = Number(submitted?.retryAfterMs) || 0;
    const backoff = Math.max(requested, Math.min(autoRetryMaxMs, autoRetryBaseMs * Math.pow(2, performed)));
    const nextAt = new Date(Date.now() + backoff).toISOString();
    const reason = String(submitted?.message || "平台未受理本次提交").slice(0, 200);
    const handle = schedule(() => {
      state.autoRetries.delete(attemptId);
      // 交给尝试链上的新记录重新加锁，避免锁卡在旧尝试上
      releaseLock(projectId, record.storyboardId, record.accountId);
      return retry(projectId, attemptId).catch((error) => log("auto-retry-error", { attemptId, message: error?.message }));
    }, backoff);
    state.autoRetries.set(attemptId, { count, reason, nextAt, handle, projectId });
    await patch(projectId, attemptId, (r) => {
      r.autoRetry = { count, max: maxAutoRetries, reason, nextAt, stopped: false };
      r.poll = { ...r.poll, message: `平台未受理，将在 ${Math.round(backoff / 1000)} 秒后自动重试（第 ${count}/${maxAutoRetries} 次）` };
      return r;
    });
    log("auto-retry-scheduled", { attemptId, count, backoff, reason });
    return true;
  }

  /** 统计这条分镜已经自动重试过几次（沿 retryOf 链回溯，只数自动重试产生的记录） */
  async function autoRetryCountOf(projectId, record) {
    const tasks = await taskStore.list(projectId);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    let count = 0;
    let current = record?.retryOf ? byId.get(record.retryOf) : null;
    let guard = 0;
    while (current && guard < 20) {
      if (current.autoRetry && !current.autoRetry.stopped) count++;
      current = current.retryOf ? byId.get(current.retryOf) : null;
      guard++;
    }
    return count;
  }

  /** 手动停止自动重试（对应界面上的「停止重试」） */
  async function stopAutoRetry(projectId, attemptId) {
    const pending = state.autoRetries.get(attemptId);
    if (pending) {
      cancelSchedule(pending.handle);
      state.autoRetries.delete(attemptId);
    }
    const record = await loadRecord(projectId, attemptId);
    if (record) releaseLock(projectId, record.storyboardId, record.accountId);
    return patch(projectId, attemptId, (r) => {
      r.autoRetry = { ...(r.autoRetry || {}), stopped: true, reason: "已手动停止自动重试" };
      // 已经是终态就只更新说明，不做状态迁移（避免非法迁移）
      if (!isTerminal(r.status)) applyStatus(r, STATUS.FAILED, "已停止自动重试，需人工处理");
      return r;
    });
  }

  // ── 轮询（带退避） ─────────────────────────────────────────
  /** 查询暂时失败仍继续低频重试，直到结果明确或用户停止跟踪。 */
  const pollErrorStreak = new Map();

  function schedulePoll(projectId, attemptId, delayMs) {
    clearTimer(attemptId);
    // 注意：回调必须把 promise 返回出去，否则调度不可等待（测试与关闭流程都无法同步）
    const handle = schedule(() => {
      state.timers.delete(attemptId);
      return pollOnce(projectId, attemptId)
        .then(() => {
          pollErrorStreak.delete(attemptId);
        })
        .catch((error) => {
          // 实测（2026-09-24，真实提交 att_d56d75641fc4）：旧实现只把异常写进日志、
          // 不再安排下一次轮询，于是任务永远停在「提交结果待确认」——之后平台即使已经
          // 给出结果（含明确拒绝）也永远不会被发现。改为：出错后仍继续轮询，
          // 查询失败不会停止跟踪；不重新提交生成请求。
          const streak = (pollErrorStreak.get(attemptId) || 0) + 1;
          pollErrorStreak.set(attemptId, streak);
          log("poll-error", { attemptId, streak, message: error?.message || String(error) });
          // 连续失败到上限就停手：旧实现无限以 pollMaxMs 重排，任务可能长期空转且
          // 界面看不到任何进展。转「需人工处理」把决定权交回用户，不再自动纠缠。
          if (streak >= pollErrorLimit) {
            log("poll-give-up", { attemptId, streak, limit: pollErrorLimit });
            void patch(projectId, attemptId, (r) => {
              r.poll = {
                ...r.poll,
                message: `连续 ${streak} 次查询失败，已停止自动轮询，请人工核实平台结果`,
                stale: true,
              };
              if (!isTerminal(r.status) && r.status !== STATUS.MANUAL && r.status !== STATUS.UNCONFIRMED) {
                applyStatus(r, STATUS.MANUAL, `监控异常：连续 ${streak} 次查询失败`);
              }
              return r;
            }).catch(() => {});
            return;
          }
          schedulePoll(projectId, attemptId, pollMaxMs);
        });
    }, Math.max(0, delayMs));
    state.timers.set(attemptId, handle);
  }

  async function pollOnce(projectId, attemptId) {
    const record = await loadRecord(projectId, attemptId);
    if (!record || isTerminal(record.status) || record.interruption?.stopped) return;
    // 有平台任务 ID 时按 ID 核实；没有 ID 的「提交结果待确认」任务同样必须继续监控——
    // 实测（2026-09-24 真实提交 att_d56d75641fc4）：平台已受理并生成了视频，
    // 但驱动没在超时窗口内抓到任务 ID，旧逻辑在此直接 return，
    // 于是工作台永远停在「待确认」、也永远不会转入下载。改为：无 ID 时仍轮询，
    // 由驱动按「页面上出现本次提示词对应的视频」判定结果（不依赖平台 ID）。
    // 可监控判定：有平台任务 ID 就按 ID 核实；没有 ID 但已经进入平台侧流转的状态
    // （待确认 / 排队 / 生成中）同样必须继续轮询——平台可能已受理并生成完成，
    // 只是提交时没抓到任务 ID。旧实现只认 platformTaskId 与 unconfirmed，
    // 于是 execute() 的「平台已受理但无 ID」QUEUED 排了一次 poll 后立即在这里 return，
    // 且不再重排，任务永远卡在排队、发现不了成功或失败。
    // submitting 仅在「本进程当前没有在跑这条提交」时才监控（重启后遗留的提交只能靠轮询收尾），
    // 避免与正在进行的提交争抢同一个 webview。
    const monitorable =
      Boolean(record.platformTaskId) ||
      record.status === STATUS.UNCONFIRMED ||
      record.status === STATUS.QUEUED ||
      record.status === STATUS.GENERATING ||
      (record.status === STATUS.SUBMITTING && !state.running.has(attemptId));
    if (!monitorable) return;

    const startedAt = Date.parse(record.interruption?.resumedAt || record.submittedAt || record.createdAt) || Date.now();
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

    const rule = polled?.state === "failed" ? classifyBlock(polled?.message, polled?.errorCode) : null;

    const updated = await patch(projectId, attemptId, (r) => {
      if (r.interruption?.stopped || isTerminal(r.status)) return false;
      r.poll = {
        count: attemptCount,
        lastAt: at,
        nextAt: new Date(Date.now() + backoff).toISOString(),
        message: String(polled?.message || "").slice(0, 300),
        stale: false,
      };
      if (polled?.platformReply?.text) r.platformReply = polled.platformReply;
      // 状态落库前先判断迁移是否合法：`manual` 只允许 → canceled/unconfirmed，
      // 若平台此刻又返回成功/失败，旧实现会直接抛「不允许的状态迁移」，
      // 异常被调度层 catch 吞掉 —— poll 计数与平台回复都写不进去，界面毫无痕迹。
      // 这里改为：非法迁移不改状态，但把平台结论完整写进 poll.message 供人工核实。
      const moveTo = (target, note) => {
        if (canTransition(r.status, target)) {
          applyStatus(r, target, note);
          return true;
        }
        r.poll = {
          ...r.poll,
          message: `${note}；但当前状态为「${STATUS_LABEL[r.status] || r.status}」，未自动改写，请人工核实`.slice(0, 300),
        };
        return false;
      };
      if (polled?.state === "succeeded") {
        setResult(r, polled.result || {});
        moveTo(STATUS.SUCCEEDED, "平台返回生成成功");
      } else if (polled?.state === "failed") {
        setError(r, polled?.errorCode || rule?.code || "GENERATE_FAILED", polled?.message || "平台返回生成失败");
        moveTo(rule ? STATUS.MANUAL : STATUS.FAILED, rule ? rule.label : "平台返回生成失败");
      } else if (polled?.state === "generating" && r.status !== STATUS.GENERATING) {
        r.canCancel = polled.canCancel !== false;
        moveTo(STATUS.GENERATING, polled.message || "平台生成中");
      } else if (polled?.state === "queued" && r.status !== STATUS.QUEUED) {
        moveTo(STATUS.QUEUED, polled.message || "平台排队中");
      }
      return r;
    });

    if (updated.interruption?.stopped) return;
    if (rule) blockAccount(record.accountId, rule, polled?.message);
    if (!rule && polled?.state === "failed" && isPortraitRetry(polled)) {
      await scheduleAutoRetry(projectId, attemptId, { ...polled, retryAfterMs: 30000 });
    }

    // 生成成功后：按设置决定是否自动开始下载（下载完全独立，失败不影响生成状态）
    if (polled?.state === "succeeded" && typeof options.onResultReady === "function") {
      try {
        await options.onResultReady({ projectId, attemptId });
      } catch (error) {
        log("auto-download-skipped", { projectId, attemptId, reason: error?.message || String(error) });
      }
    }

    const latest = await loadRecord(projectId, attemptId);
    if (latest && !isTerminal(latest.status) && latest.status !== STATUS.MANUAL) {
      schedulePoll(projectId, attemptId, backoff);
    }
  }

  // ── 队列调度 ──────────────────────────────────────────────
  /** scopeProjectId 只在补派槽位时传入：只扫本项目，避免连带启动其他项目的任务 */
  async function tick(scopeProjectId = "") {
    state.lastTick = new Date().toISOString();
    if (state.paused) return { started: [] };
    const started = [];
    const projects = scopeProjectId
      ? [scopeProjectId]
      : options.listProjectIds
        ? await options.listProjectIds()
        : [];
    for (const projectId of projects) {
      const tasks = await taskStore.list(projectId);
      for (const task of tasks.filter((t) => t.status === STATUS.PENDING)) {
        if (state.running.size >= globalConcurrency) {
          for (const id of projects) waitingProjects.add(id);
          return { started };
        }
        if (runningCountFor(task.accountId) >= perAccountConcurrency) {
          waitingProjects.add(projectId);
          continue;
        }
        try {
          const admission = await admit(projectId, task.id);
          if (admission.started) started.push(task.id);
        } catch (error) {
          log("queue-skip", { attemptId: task.id, message: error.message });
        }
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
    for (const projectId of waitingProjects) void tick(projectId).catch(() => {});
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
      const updated = await patch(projectId, attemptId, (r) => {
        if (r.status !== STATUS.PENDING) return false;
        return applyStatus(r, STATUS.CANCELED, "尚未提交，已在本地取消");
      });
      if (updated.status === STATUS.CANCELED) return updated;
      return cancel(projectId, attemptId);
    }
    if (isTerminal(record.status)) return record;
    // 提交准入已完成时不能声称本地取消成功，也不能抢写 manual 干扰受理结果落库。
    if (record.status === STATUS.SUBMITTING && state.running.has(attemptId)) {
      return patch(projectId, attemptId, (r) => {
        r.poll = { ...r.poll, message: "正在提交，请等待平台受理后再尝试取消" };
        return r;
      });
    }
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

  async function interrupt(projectId, attemptId) {
    const record = await loadRecord(projectId, attemptId);
    if (!record) throw new Error("任务不存在");
    if (isTerminal(record.status) && !state.autoRetries.has(attemptId)) return record;
    const control = submissionControls.get(attemptId);
    if (control) control.requested = true;
    clearTimer(attemptId);
    const automatic = state.autoRetries.get(attemptId);
    if (automatic) { cancelSchedule(automatic.handle); state.autoRetries.delete(attemptId); releaseLock(projectId, record.storyboardId, record.accountId); }
    return patch(projectId, attemptId, (r) => {
      if (isTerminal(r.status) && !automatic) return false;
      const localOnly = r.status === STATUS.PENDING || (control && !control.dispatched) || (automatic && !r.platformTaskId && !r.driver?.accepted);
      r.interruption = { stopped: true, at: new Date().toISOString(), platformMayContinue: !localOnly };
      r.autoRetry = r.autoRetry ? { ...r.autoRetry, stopped: true } : null;
      r.poll = { ...r.poll, nextAt: "", message: localOnly ? "已中断，未发送到豆包" : "已停止本地跟踪；豆包可能仍在生成，平台扣费不一定停止" };
      if (!isTerminal(r.status)) applyStatus(r, localOnly ? STATUS.CANCELED : STATUS.MANUAL, r.poll.message);
      return r;
    });
  }

  async function resumeMonitoring(projectId, attemptId) {
    if (state.running.has(attemptId)) throw new Error("提交步骤正在收尾，请稍后恢复查询");
    const record = await patch(projectId, attemptId, r => {
      if (isTerminal(r.status) || !(r.interruption?.stopped && r.interruption.platformMayContinue || r.submittedAt && [STATUS.MANUAL, STATUS.UNCONFIRMED].includes(r.status))) return false;
      r.interruption = { ...r.interruption, stopped: false, resumedAt: new Date().toISOString() };
      applyStatus(r, STATUS.UNCONFIRMED, "恢复查询，不重新提交");
      r.poll = { ...r.poll, message: "已恢复状态查询，不会重新提交", stale: false };
      return r;
    });
    if (!record.interruption?.stopped && !isTerminal(record.status)) schedulePoll(projectId, attemptId, 0);
    return record;
  }

  const retryRequests = new Map();
  /** 合并同一来源的重复点击；每次实际重试仍保留独立历史。 */
  function retry(projectId, attemptId) {
    const key = `${projectId}:${attemptId}`;
    if (retryRequests.has(key)) return retryRequests.get(key);
    const request = retryOnce(projectId, attemptId).finally(() => retryRequests.delete(key));
    retryRequests.set(key, request);
    return request;
  }

  async function retryOnce(projectId, attemptId) {
    const record = await loadRecord(projectId, attemptId);
    if (!record) throw new Error("任务不存在");
    if (isActive(record.status) && record.status !== STATUS.MANUAL && record.status !== STATUS.UNCONFIRMED) {
      throw new Error("任务仍在进行中，不能重试");
    }
    if (record.interruption?.platformMayContinue && !isTerminal(record.status)) throw new Error("该任务可能仍在豆包生成，请先恢复查询或核实平台结果");
    const tasks = await taskStore.list(projectId);
    const pendingRetry = tasks.find((task) => task.retryOf === attemptId && !isTerminal(task.status));
    if (pendingRetry) {
      await execute(projectId, pendingRetry.id);
      return pendingRetry;
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
        // 「提交结果待确认」也要恢复监控：它可能已被平台受理并生成完成，
        // 只是提交时没抓到平台任务 ID（见 pollOnce 的同类修复）。
        if (task.interruption?.stopped) continue;
        if (!isActive(task.status) && task.status !== STATUS.UNCONFIRMED) continue;
        if (task.status === STATUS.PENDING) continue;
        const last = Date.parse(task.poll?.lastAt || task.updatedAt || task.createdAt) || 0;
        const isUnconfirmed = task.status === STATUS.UNCONFIRMED;
        // 待确认任务优先恢复监控：它没有任何轮询记录（lastAt 为空），
        // 若按「长时间无更新」处理就永远不会再被核实，这正是实测踩到的坑。
        if (isUnconfirmed || Date.now() - last <= staleMs) {
          resumed.push(task.id);
          schedulePoll(projectId, task.id, pollBaseMs);
          continue;
        }
        stale.push(task.id);
        await patch(projectId, task.id, (r) => {
          r.poll = { ...r.poll, stale: true, message: "重启后长时间无更新，请人工核实" };
          if (r.status !== STATUS.UNCONFIRMED && r.status !== STATUS.MANUAL) {
            applyStatus(r, STATUS.MANUAL, "监控异常：重启后长时间无新状态");
          }
          return r;
        });
      }
    }
    // 重启后把遗留的「待执行」任务续跑起来。
    // 旧实现只 recover 轮询、不触发调度，于是重启前排队但未开始的任务永远不会被派发，
    // 用户看到一条「待执行」却始终不动。
    let started = [];
    try {
      const result = await tick();
      started = result?.started || [];
    } catch (error) {
      log("recover-tick-failed", { message: error?.message || String(error) });
    }
    return { resumed, stale, started };
  }

  function status() {
    return {
      paused: state.paused,
      running: [...state.running.entries()].map(([id, info]) => ({ attemptId: id, ...info })),
      blockedAccounts: [...state.blockedAccounts.entries()].map(([accountId, info]) => ({ accountId, ...info })),
      // 提交锁与待执行的自动重试：界面据此展示「第几次 / 原因 / 下次时间 / 停止按钮」
      locks: [...state.locks.entries()].map(([key, info]) => ({ key, ...info })),
      autoRetries: [...state.autoRetries.entries()].map(([attemptId, info]) => ({
        attemptId,
        count: info.count,
        reason: info.reason,
        nextAt: info.nextAt,
      })),
      limits: { globalConcurrency, perAccountConcurrency, maxAutoRetries },
      lastTick: state.lastTick,
    };
  }

  return {
    cancel,
    interrupt,
    resumeMonitoring,
    clearAccountBlock,
    enqueue,
    execute,
    pause,
    recover,
    resume,
    retry,
    status,
    stopAutoRetry,
    tick,
  };
}

module.exports = { ACCOUNT_BLOCK_PATTERNS, classifyBlock, createRunner, stepDetail, summarizeDriver };
