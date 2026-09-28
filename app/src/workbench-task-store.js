"use strict";
/**
 * 生成任务与尝试记录
 *
 * 该模块只依赖 node 内置模块，可脱离 Electron 直接测试。
 *
 * 关键约束（对应需求）：
 * - 每个尝试都保存：内部任务 ID、分镜 ID、账号 ID、参数快照、素材引用快照、
 *   平台任务 ID、提交时间、状态变化历史、错误信息、结果信息。
 * - 参数与素材引用是「快照」：分镜之后被编辑，不得改变已提交任务的记录。
 * - 下载状态与生成状态彼此独立：下载失败绝不把生成判定为失败。
 * - 重试生成 = 新尝试记录，历史保留。
 * - 平台结果必须按 (账号, 平台任务 ID) 双键匹配，避免关联到错误分镜或错误账号。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SCHEMA_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TASKS = 4000;

const STATUS = Object.freeze({
  PENDING: "pending",
  SUBMITTING: "submitting",
  QUEUED: "queued",
  GENERATING: "generating",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  MANUAL: "manual",
  UNCONFIRMED: "unconfirmed",
  CANCELED: "canceled",
});

const STATUS_LABEL = Object.freeze({
  pending: "待执行",
  submitting: "提交中",
  queued: "平台排队",
  generating: "生成中",
  succeeded: "生成成功",
  failed: "生成失败",
  manual: "需人工处理",
  unconfirmed: "提交结果待确认",
  canceled: "已取消",
});

/** 允许的状态迁移；未列出的迁移一律拒绝 */
const TRANSITIONS = Object.freeze({
  pending: ["submitting", "canceled", "manual", "failed"],
  submitting: ["queued", "generating", "succeeded", "failed", "unconfirmed", "manual", "canceled"],
  queued: ["generating", "succeeded", "failed", "unconfirmed", "manual", "canceled"],
  generating: ["succeeded", "failed", "unconfirmed", "manual", "canceled"],
  succeeded: [],
  failed: ["submitting"], // 仅「重试」时先复位为 submitting，且必须是新尝试；见 retryOf
  manual: ["canceled", "unconfirmed"],
  // 「提交结果待确认」也必须能走到「需人工处理」：监控窗口到期时轮询就是这么收尾的
  // （workbench-runner.js pollOnce 的监控超时分支）。旧表漏了 manual，导致该分支
  // 每次都抛「不允许的状态迁移：提交结果待确认 → 需人工处理」，任务被永久卡在待确认。
  // 实测：2026-09-24 真实提交 att_d56d75641fc4。
  unconfirmed: ["succeeded", "failed", "queued", "generating", "canceled", "manual"],
  canceled: [],
});

const ACTIVE_STATUSES = Object.freeze([
  STATUS.PENDING,
  STATUS.SUBMITTING,
  STATUS.QUEUED,
  STATUS.GENERATING,
]);

const TERMINAL_STATUSES = Object.freeze([STATUS.SUCCEEDED, STATUS.FAILED, STATUS.CANCELED]);

/** 下载状态与生成状态完全独立 */
const DOWNLOAD_STATUS = Object.freeze({
  IDLE: "idle",
  RUNNING: "downloading",
  PAUSED: "paused",
  DONE: "done",
  FAILED: "failed",
});

const DOWNLOAD_LABEL = Object.freeze({
  idle: "未下载",
  downloading: "下载中",
  paused: "已暂停",
  done: "已下载",
  failed: "下载失败",
});

const text = (value, max = 0) => {
  const out = String(value ?? "");
  return max > 0 ? out.slice(0, max) : out;
};

const newAttemptId = () => `att_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

/** 参数快照：调用方必须传入当时的有效参数，之后不再从分镜读取 */
function snapshotParams(input = {}) {
  return {
    model: text(input.model, 40),
    duration: text(input.duration, 16),
    ratio: text(input.ratio, 16),
    removeWatermark: input.removeWatermark !== false,
    prompt: text(input.prompt),
  };
}

/** 素材引用快照：带内容哈希，便于日后核对同一张图 */
function snapshotRefs(refs) {
  return (Array.isArray(refs) ? refs : []).map((ref) => ({
    assetId: text(ref?.assetId),
    token: text(ref?.token, 16),
    name: text(ref?.name, 120),
    sha256: text(ref?.sha256, 64),
  }));
}

function normalizeAttempt(input = {}) {
  // 未知/缺失状态**不得**默认成「待执行」。
  // runner.tick 会把所有 pending 记录纳入准入并真正向平台提交，因此一条被损坏、
  // 被手工编辑、或由其它版本写入的记录，一旦被强转成 pending，就会在用户下次点
  // 「生成」时被重新提交——重复消耗额度，且用户完全无感知。
  // 规则：已知状态原样保留；状态缺失（新建/极旧记录）按 pending；非空但无法识别
  // 的状态一律落到「需人工处理」，并把原值记进历史，供人工核实后再决定。
  const rawStatus = String(input.status ?? "").trim();
  const knownStatus = Object.values(STATUS).includes(rawStatus);
  const status = knownStatus ? rawStatus : rawStatus ? STATUS.MANUAL : STATUS.PENDING;
  const downloadStatus = Object.values(DOWNLOAD_STATUS).includes(input.download?.status)
    ? input.download.status
    : DOWNLOAD_STATUS.IDLE;
  const now = new Date().toISOString();
  return {
    id: ID_RE.test(text(input.id)) ? text(input.id) : newAttemptId(),
    projectId: text(input.projectId),
    storyboardId: text(input.storyboardId),
    storyboardName: text(input.storyboardName, 120),
    accountId: text(input.accountId),
    attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
    retryOf: text(input.retryOf),
    status,
    params: snapshotParams(input.params),
    refs: snapshotRefs(input.refs),
    platformTaskId: text(input.platformTaskId, 120),
    createdAt: text(input.createdAt) || now,
    submittedAt: text(input.submittedAt),
    updatedAt: text(input.updatedAt) || now,
    finishedAt: text(input.finishedAt),
    history: [
      ...(Array.isArray(input.history) ? input.history : []).map((h) => ({
        status: text(h?.status),
        at: text(h?.at),
        note: text(h?.note, 300),
      })),
      // 状态被识别失败时留痕：否则用户只会看到一个「需人工处理」的任务，无从判断原因
      ...(!knownStatus && rawStatus
        ? [{ status: STATUS.MANUAL, at: now, note: `记录里的状态「${text(rawStatus, 40)}」无法识别，已转为需人工处理，未自动执行` }]
        : []),
    ],
    error: input.error
      ? { code: text(input.error.code, 60), message: text(input.error.message, 500), at: text(input.error.at) }
      : !knownStatus && rawStatus
        ? { code: "UNKNOWN_STATUS", message: `记录状态无法识别（原值：${text(rawStatus, 40)}），已停止自动执行以免重复提交`, at: now }
        : null,
    result: input.result
      ? {
          videoUrl: text(input.result.videoUrl),
          filePath: text(input.result.filePath, 500),
          width: Number(input.result.width) || 0,
          height: Number(input.result.height) || 0,
          durationSeconds: Number(input.result.durationSeconds) || 0,
          at: text(input.result.at),
        }
      : null,
    download: {
      status: downloadStatus,
      // 下载来源与进度：与生成状态完全独立，「下载失败不改变生成结果」
      source: text(input.download?.source, 40),
      sourceLabel: text(input.download?.sourceLabel, 80),
      url: text(input.download?.url),
      urlSafe: text(input.download?.urlSafe, 300),
      filePath: text(input.download?.filePath, 500),
      message: text(input.download?.message, 300),
      hint: text(input.download?.hint, 300),
      errorCode: text(input.download?.errorCode, 60),
      bytes: Number(input.download?.bytes) || 0,
      expectedBytes: Number(input.download?.expectedBytes) || 0,
      elapsedMs: Number(input.download?.elapsedMs) || 0,
      resumed: input.download?.resumed === true,
      startedAt: text(input.download?.startedAt),
      attempts: Number(input.download?.attempts) || 0,
      history: (Array.isArray(input.download?.history) ? input.download.history : []).slice(-20).map((h) => ({
        status: text(h?.status, 20),
        at: text(h?.at),
        note: text(h?.note, 200),
        source: text(h?.source, 40),
      })),
      at: text(input.download?.at),
    },
    interruption: input.interruption ? { stopped: input.interruption.stopped === true, at: text(input.interruption.at), resumedAt: text(input.interruption.resumedAt), platformMayContinue: input.interruption.platformMayContinue === true } : null,
    platformContext: input.platformContext ? { requestMessageId: text(input.platformContext.requestMessageId, 60), beforeCount: Math.max(0, Number(input.platformContext.beforeCount) || 0), url: text(input.platformContext.url, 4000) } : null,
    platformReply: input.platformReply?.text ? { text: text(input.platformReply.text, 8000), at: text(input.platformReply.at) } : null,
    poll: {
      count: Number(input.poll?.count) || 0,
      lastAt: text(input.poll?.lastAt),
      nextAt: text(input.poll?.nextAt),
      message: text(input.poll?.message, 300),
      stale: Boolean(input.poll?.stale),
    },
    // 驱动层逐步执行结果：把「哪一步成功/失败、失败时的候选控件」落库，
    // 界面据此给出可见反馈，而不是只显示一个笼统的失败
    driver: {
      outcome: text(input.driver?.outcome, 20),
      message: text(input.driver?.message, 500),
      at: text(input.driver?.at),
      steps: (Array.isArray(input.driver?.steps) ? input.driver.steps : []).slice(0, 20).map((s) => ({
        step: text(s?.step, 40),
        ok: s?.ok !== false,
        detail: text(s?.detail, 200),
      })),
      candidates: (Array.isArray(input.driver?.candidates) ? input.driver.candidates : []).slice(0, 12).map((c) => text(c, 120)),
      // 受理/重试判定所依据的证据：原样落库，便于事后核对（不臆断）
      accepted: input.driver?.accepted === true,
      retryable: input.driver?.retryable === true,
      needsUser: input.driver?.needsUser === true,
      evidence: input.driver?.evidence && typeof input.driver.evidence === "object" ? input.driver.evidence : null,
      acceptanceEvidence:
        input.driver?.acceptanceEvidence && typeof input.driver.acceptanceEvidence === "object"
          ? input.driver.acceptanceEvidence
          : null,
      durationEvidence:
        input.driver?.durationEvidence && typeof input.driver.durationEvidence === "object"
          ? {
              required: text(input.driver.durationEvidence.required, 8),
              submitted: text(input.driver.durationEvidence.submitted, 8),
              mode: text(input.driver.durationEvidence.mode, 16),
            }
          : null,
    },
    // 自动重试：次数 / 上限 / 原因 / 下次时间 / 是否已停止（界面据此展示与停止）
    autoRetry: input.autoRetry
      ? {
          count: Number(input.autoRetry.count) || 0,
          max: Number(input.autoRetry.max) || 0,
          reason: text(input.autoRetry.reason, 200),
          nextAt: text(input.autoRetry.nextAt),
          stopped: input.autoRetry.stopped === true,
        }
      : null,
    // 平台是否已受理本次提交（受理不等于生成成功）
    accepted: input.accepted === true,
    acceptanceEvidence:
      input.acceptanceEvidence && typeof input.acceptanceEvidence === "object" ? input.acceptanceEvidence : null,
    canCancel: input.canCancel !== false,
  };
}

function createAttempt(input = {}) {
  const record = normalizeAttempt({ ...input, status: STATUS.PENDING });
  record.history = [
    { status: STATUS.PENDING, at: record.createdAt, note: text(input.note, 300) || "已创建尝试记录" },
  ];
  return record;
}

/** 状态迁移：非法迁移直接抛错，避免状态被静默改写 */
function applyStatus(record, status, note = "") {
  const from = record.status;
  if (!Object.values(STATUS).includes(status)) throw new Error(`未知状态：${status}`);
  // 幂等：重复写入同一状态直接跳过。
  // 旧实现会抛「不允许的状态迁移」，轮询在「账号已被判为需人工处理」后再次收到
  // 平台拒绝时，整个 patch 回滚，poll 计数与错误信息都写不进去。
  if (from === status) return record;
  if (!canTransition(from, status)) {
    throw new Error(`不允许的状态迁移：${STATUS_LABEL[from] || from} → ${STATUS_LABEL[status] || status}`);
  }
  const at = new Date().toISOString();
  record.status = status;
  record.updatedAt = at;
  record.history.push({ status, at, note: text(note, 300) });
  if (status === STATUS.SUBMITTING && !record.submittedAt) record.submittedAt = at;
  if (isTerminal(status) || status === STATUS.UNCONFIRMED) {
    if (isTerminal(status)) record.finishedAt = at;
  }
  return record;
}

function setError(record, code, message) {
  record.error = { code: text(code, 60), message: text(message, 500), at: new Date().toISOString() };
  record.updatedAt = record.error.at;
  return record;
}

function setResult(record, patch = {}) {
  const at = new Date().toISOString();
  record.result = {
    videoUrl: text(patch.videoUrl ?? record.result?.videoUrl),
    filePath: text(patch.filePath ?? record.result?.filePath, 500),
    width: Number(patch.width ?? record.result?.width) || 0,
    height: Number(patch.height ?? record.result?.height) || 0,
    durationSeconds: Number(patch.durationSeconds ?? record.result?.durationSeconds) || 0,
    at,
  };
  record.updatedAt = at;
  return record;
}

/**
 * 只改下载状态。刻意不触碰 status/error/finishedAt，
 * 保证「下载失败不改变生成结果」。
 */
function setDownload(record, status, patch = {}) {
  if (!Object.values(DOWNLOAD_STATUS).includes(status)) throw new Error(`未知下载状态：${status}`);
  const at = new Date().toISOString();
  const previous = record.download || {};
  record.download = {
    status,
    // 来源（澜川同源 / 平台播放版）与脱敏地址：界面据此标注，完整地址只作为请求参数保留
    source: text(patch.source ?? previous.source, 40),
    sourceLabel: text(patch.sourceLabel ?? previous.sourceLabel, 80),
    url: text(patch.url ?? previous.url),
    urlSafe: text(patch.urlSafe ?? previous.urlSafe, 300),
    filePath: text(patch.filePath ?? previous.filePath, 500),
    message: text(patch.message ?? "", 300),
    hint: text(patch.hint ?? "", 300),
    errorCode: text(patch.errorCode ?? "", 60),
    bytes: Number(patch.bytes ?? previous.bytes) || 0,
    expectedBytes: Number(patch.expectedBytes ?? previous.expectedBytes) || 0,
    elapsedMs: Number(patch.elapsedMs ?? previous.elapsedMs) || 0,
    resumed: patch.resumed === true || (patch.resumed === undefined && previous.resumed === true),
    startedAt: text(patch.startedAt ?? previous.startedAt),
    attempts:
      status === DOWNLOAD_STATUS.RUNNING
        ? (Number(previous.attempts) || 0) + 1
        : Number(previous.attempts) || 0,
    history: (Array.isArray(previous.history) ? previous.history : []).slice(-19).concat([
      { status, at, note: text(patch.message ?? "", 200), source: text(patch.source ?? previous.source, 40) },
    ]),
    at,
  };
  record.updatedAt = at;
  return record;
}

/** 按 (账号, 平台任务 ID) 双键匹配，避免把结果挂到错误分镜或错误账号 */
function matchByPlatformTask(tasks, accountId, platformTaskId) {
  const id = text(platformTaskId);
  if (!id) return { record: null, ambiguous: false, reason: "没有平台任务 ID" };
  const hits = (tasks || []).filter((t) => t.platformTaskId === id);
  if (!hits.length) return { record: null, ambiguous: false, reason: "没有匹配的记录" };
  const scoped = hits.filter((t) => t.accountId === text(accountId));
  if (!scoped.length) {
    return { record: null, ambiguous: false, reason: "平台任务 ID 存在，但归属其他账号，拒绝关联" };
  }
  if (scoped.length > 1) return { record: null, ambiguous: true, reason: "同一账号下平台任务 ID 重复" };
  return { record: scoped[0], ambiguous: false, reason: "" };
}

function nextAttemptNumber(tasks, projectId, storyboardId) {
  const numbers = (tasks || [])
    .filter((t) => t.projectId === projectId && t.storyboardId === storyboardId)
    .map((t) => Number(t.attempt) || 0);
  return (numbers.length ? Math.max(...numbers) : 0) + 1;
}

/**
 * 任务持久化：每个项目一个 tasks.json。
 * dirFor(projectId) 返回项目数据目录。
 */
function createTaskStore(dirFor) {
  const fileFor = (projectId) => path.join(dirFor(projectId), "tasks.json");

  function read(projectId) {
    const file = fileFor(projectId);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      // 文件不存在：正常情况（首次使用）
      return { schemaVersion: SCHEMA_VERSION, tasks: [] };
    }
    try {
      const value = JSON.parse(raw);
      const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
      return { schemaVersion: SCHEMA_VERSION, tasks: tasks.map(normalizeAttempt) };
    } catch {
      // 解析失败：先把损坏文件备份出来再返回空。
      // 旧实现直接返回空数组，随后任何一次 append 都会用空历史覆盖原文件，
      // 等于一次损坏就静默清空全部任务记录，且无从恢复。
      try {
        const backup = `${file}.corrupt-${Date.now()}.json`;
        fs.copyFileSync(file, backup);
        console.error(`[task-store] tasks.json 解析失败，已备份到 ${backup}`);
      } catch {}
      return { schemaVersion: SCHEMA_VERSION, tasks: [] };
    }
  }

  async function write(projectId, doc) {
    const file = fileFor(projectId);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 持久化层不裁剪记录：活动任务、下载及重试链均依赖历史 ID。
    // 展示数量由渲染层分页控制；归档功能落地前必须保全历史。
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, file);
    return doc;
  }

  /**
   * 同一项目串行化「读-改-写」。
   * 多账号并行时会有多个任务同时更新同一个 tasks.json，
   * 不做串行化会出现「后写覆盖前写」，导致有条任务状态凭空消失。
   */
  const queues = new Map();
  function serialized(projectId, task) {
    const previous = queues.get(projectId) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(
      projectId,
      next.catch(() => {})
    );
    return next;
  }

  return {
    read,
    async list(projectId) {
      return read(projectId).tasks;
    },
    async append(projectId, attempt) {
      return serialized(projectId, async () => {
        const doc = read(projectId);
        doc.tasks.push(normalizeAttempt(attempt));
        await write(projectId, doc);
        return attempt;
      });
    },
    /** 就地更新：mutator 返回 false 表示放弃写入 */
    async update(projectId, attemptId, mutator) {
      return serialized(projectId, async () => {
        const doc = read(projectId);
        const index = doc.tasks.findIndex((t) => t.id === attemptId);
        if (index < 0) throw new Error("任务记录不存在");
        const kept = mutator(doc.tasks[index]);
        if (kept !== false) await write(projectId, doc);
        return doc.tasks[index];
      });
    },
    async replaceAll(projectId, tasks) {
      return serialized(projectId, () =>
        write(projectId, { schemaVersion: SCHEMA_VERSION, tasks: (tasks || []).map(normalizeAttempt) })
      );
    },
    /**
     * 批量清理历史记录（目前只用于「清理已完成任务」）。
     * 安全约束（缺一不可，否则会损坏其它链路）：
     * - 只允许删除终态记录：活动任务（待执行/提交中/排队/生成中）永不清理，否则 runner 会「任务记录不存在」；
     * - 默认只清「生成成功」；失败与需人工处理的记录保留，供用户排查与重试；
     * - 下载中/已暂停的记录一律跳过：分片与断点续传状态都挂在记录上，删掉就再也续不上；
     * - 返回 removedIds 与 skipped（原因），界面据此如实提示「清了几条、留了几条、为什么留」。
     */
    async clear(projectId, options = {}) {
      const requested = Array.isArray(options.statuses) && options.statuses.length ? options.statuses : [STATUS.SUCCEEDED];
      const allowed = new Set(requested.filter((s) => TERMINAL_STATUSES.includes(s)));
      if (!allowed.size) throw new Error("只能清理已结束的任务（生成成功/失败/已取消）");
      return serialized(projectId, async () => {
        const doc = read(projectId);
        const kept = [];
        const removedIds = [];
        const skipped = [];
        for (const task of doc.tasks) {
          if (!allowed.has(task.status)) {
            kept.push(task);
            continue;
          }
          const downloadStatus = task.download?.status;
          if (downloadStatus === DOWNLOAD_STATUS.RUNNING || downloadStatus === DOWNLOAD_STATUS.PAUSED) {
            kept.push(task);
            skipped.push({ id: task.id, status: task.status, reason: "下载尚未完成（下载中或已暂停），保留记录以便继续下载" });
            continue;
          }
          removedIds.push(task.id);
        }
        if (!removedIds.length) return { removed: 0, removedIds: [], skipped };
        await write(projectId, { schemaVersion: SCHEMA_VERSION, tasks: kept });
        return { removed: removedIds.length, removedIds, skipped };
      });
    },
    nextAttemptNumber,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  DOWNLOAD_LABEL,
  DOWNLOAD_STATUS,
  MAX_TASKS,
  SCHEMA_VERSION,
  STATUS,
  STATUS_LABEL,
  TERMINAL_STATUSES,
  TRANSITIONS,
  applyStatus,
  canTransition,
  createAttempt,
  createTaskStore,
  isActive,
  isTerminal,
  matchByPlatformTask,
  newAttemptId,
  nextAttemptNumber,
  normalizeAttempt,
  setDownload,
  setError,
  setResult,
  snapshotParams,
  snapshotRefs,
};
