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
  manual: ["canceled"],
  unconfirmed: ["succeeded", "failed", "queued", "generating", "canceled"],
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
  DONE: "done",
  FAILED: "failed",
});

const DOWNLOAD_LABEL = Object.freeze({
  idle: "未下载",
  downloading: "下载中",
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
  const status = Object.values(STATUS).includes(input.status) ? input.status : STATUS.PENDING;
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
    history: (Array.isArray(input.history) ? input.history : []).map((h) => ({
      status: text(h?.status),
      at: text(h?.at),
      note: text(h?.note, 300),
    })),
    error: input.error
      ? { code: text(input.error.code, 60), message: text(input.error.message, 500), at: text(input.error.at) }
      : null,
    result: input.result
      ? {
          videoUrl: text(input.result.videoUrl, 800),
          filePath: text(input.result.filePath, 500),
          width: Number(input.result.width) || 0,
          height: Number(input.result.height) || 0,
          durationSeconds: Number(input.result.durationSeconds) || 0,
          at: text(input.result.at),
        }
      : null,
    download: {
      status: downloadStatus,
      filePath: text(input.download?.filePath, 500),
      message: text(input.download?.message, 300),
      attempts: Number(input.download?.attempts) || 0,
      at: text(input.download?.at),
    },
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
    videoUrl: text(patch.videoUrl ?? record.result?.videoUrl, 800),
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
  record.download = {
    status,
    filePath: text(patch.filePath ?? record.download?.filePath, 500),
    message: text(patch.message ?? "", 300),
    attempts:
      status === DOWNLOAD_STATUS.RUNNING
        ? (Number(record.download?.attempts) || 0) + 1
        : Number(record.download?.attempts) || 0,
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
    try {
      const value = JSON.parse(fs.readFileSync(fileFor(projectId), "utf8"));
      const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
      return { schemaVersion: SCHEMA_VERSION, tasks: tasks.map(normalizeAttempt) };
    } catch {
      return { schemaVersion: SCHEMA_VERSION, tasks: [] };
    }
  }

  async function write(projectId, doc) {
    const file = fileFor(projectId);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 保留最近 MAX_TASKS 条，避免无限增长；历史仍可导出
    if (doc.tasks.length > MAX_TASKS) doc.tasks = doc.tasks.slice(-MAX_TASKS);
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