"use strict";
/**
 * 任务服务：把编排层、驱动层、下载与账号信息接到 IPC 上
 *
 * 账号来源沿用既有约定：读取 <userData>/accounts.json（account-proxy.js 已是同一做法），
 * 只读、不改写。会话分区按既有规则推导：persist:doubao-manager-<accountId>。
 *
 * 状态口径：可核实的只有「本工作台的任务数」与「账号异常信息」；
 * 平台额度与登录状态本层无法核实，一律返回 unknown，界面显示「未知」。
 */

const fs = require("node:fs");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { net } = require("electron");

const { createTaskStore, isActive } = require("./workbench-task-store");
const { createRunner } = require("./workbench-runner");
const { createDownloader } = require("./workbench-download");
const { createDolaDriver, PARTITION_PREFIX } = require("./workbench-dola-driver");
const { assignStoryboards } = require("./workbench-platform");
const { VIDEO_CAPABILITIES } = require("./video-capabilities");

const ACCOUNTS_FILE = "accounts.json";

function readAccounts(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, ACCOUNTS_FILE), "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
    return list
      .filter((a) => a && typeof a.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(a.id))
      .map((a) => ({
        id: a.id,
        name: String(a.name || a.remark || a.id).slice(0, 120),
        platform: String(a.platform || ""),
        group: String(a.group || ""),
        remark: String(a.remark || ""),
        sessionPartition: `${PARTITION_PREFIX}${a.id}`,
      }));
  } catch {
    return [];
  }
}

/** 用 Electron net 走账号会话下载；沿用页面 Referer，与既有高清原片下载一致 */
async function electronFetchToFile({ url, filePath, session }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let request;
    try {
      request = net.request({ url, session, useSessionCookies: true, redirect: "follow" });
    } catch (error) {
      return finish({ ok: false, error: `请求无法建立：${error.message}` });
    }
    request.setHeader("Referer", "https://www.dola.com/");
    request.on("response", (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.on("data", () => {});
        return finish({ ok: false, error: `下载失败，HTTP ${response.statusCode}` });
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", async () => {
        try {
          const buffer = Buffer.concat(chunks);
          await fsp.mkdir(path.dirname(filePath), { recursive: true });
          await fsp.writeFile(filePath, buffer);
          finish({
            ok: true,
            bytes: buffer.length,
            mime: String(response.headers["content-type"] || "").split(";")[0].trim(),
          });
        } catch (error) {
          finish({ ok: false, error: `写入文件失败：${error.message}` });
        }
      });
      response.on("error", (error) => finish({ ok: false, error: error.message }));
    });
    request.on("error", (error) => finish({ ok: false, error: error.message }));
    request.end();
  });
}

function createTaskService({ store, assets, userDataDir, log = () => {}, onChanged = () => {} }) {
  const taskStore = createTaskStore((projectId) => store.attachmentsDir(projectId));
  const capabilities = VIDEO_CAPABILITIES;

  async function resolveAssets(projectId, refs) {
    const map = new Map();
    const catalog = await assets.list(projectId);
    const byId = new Map(catalog.map((a) => [a.id, a]));
    const dir = store.assetsDir(projectId);
    for (const ref of refs || []) {
      const asset = byId.get(ref.assetId);
      if (!asset) continue;
      map.set(ref.assetId, {
        name: asset.name,
        filePath: path.join(dir, asset.fileName),
        sha256: asset.sha256,
        width: asset.width,
        height: asset.height,
      });
    }
    return map;
  }

  async function listProjectIds() {
    const index = await store.readIndex();
    return index.projects.map((p) => p.id);
  }

  const target = "dola";
  const driver = createDolaDriver({ log });
  const runner = createRunner({
    taskStore,
    driver,
    capabilities,
    target,
    resolveAssets,
    listProjectIds,
    onChanged,
    log,
  });

  const downloader = createDownloader({
    taskStore,
    outputDirFor: async (projectId) => path.join(store.attachmentsDir(projectId), "downloads"),
    fetchToFile: async ({ url, filePath, accountId }) => {
      const { session } = require("electron");
      return electronFetchToFile({ url, filePath, session: session.fromPartition(`${PARTITION_PREFIX}${accountId}`) });
    },
  });

  async function accountView() {
    const accounts = readAccounts(userDataDir);
    const blocked = new Map(runner.status().blockedAccounts.map((b) => [b.accountId, b]));
    const counts = new Map();
    const index = await store.readIndex();
    for (const project of index.projects) {
      for (const task of await taskStore.list(project.id)) {
        if (!isActive(task.status)) continue;
        counts.set(task.accountId, (counts.get(task.accountId) || 0) + 1);
      }
    }
    return accounts.map((account) => ({
      ...account,
      activeTasks: counts.get(account.id) || 0,
      blocked: blocked.get(account.id) || null,
      // 本层无法核实平台额度与登录状态：明确返回未知，不编造
      quota: { known: false, label: "未知" },
      loginState: { known: false, label: "未知" },
    }));
  }

  async function tasksFor(projectId) {
    const tasks = await taskStore.list(projectId);
    // 新到旧排列，便于界面直接展示
    return tasks.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** 入队前先把「校验结果与限制」返回给界面，避免用户盲提交 */
  async function previewPlan(projectId, storyboardId, accountId) {
    const { normalizeProject } = require("./workbench-store");
    const raw = await store.readProject(projectId);
    if (!raw) throw new Error("项目不存在");
    const project = normalizeProject(raw, raw.id);
    const storyboard = project.storyboards.find((s) => s.id === storyboardId);
    if (!storyboard) throw new Error("分镜不存在");
    const defaults = project.defaults || {};
    const params = {
      model: storyboard.overrides?.model || defaults.model,
      duration: storyboard.overrides?.duration || defaults.duration,
      ratio: storyboard.overrides?.ratio || defaults.ratio,
      removeWatermark: defaults.removeWatermark !== false,
      prompt: storyboard.prompt,
    };
    const { buildPlan } = require("./workbench-platform");
    const assetsById = await resolveAssets(projectId, storyboard.refs);
    const snapshotRefs = (storyboard.refs || []).map((ref) => ({
      assetId: ref.assetId,
      token: ref.token,
      name: assetsById.get(ref.assetId)?.name || "",
      sha256: assetsById.get(ref.assetId)?.sha256 || "",
      filePath: assetsById.get(ref.assetId)?.filePath || "",
    }));
    const plan = buildPlan({
      target,
      attempt: { params, refs: snapshotRefs },
      assetsById,
      capabilities,
    });
    return {
      accountId,
      params,
      // 快照用引用：带名称与内容哈希，入队时直接落库
      refs: snapshotRefs.map((ref) => ({
        assetId: ref.assetId,
        token: ref.token,
        name: ref.name,
        sha256: ref.sha256,
      })),
      valid: plan.valid,
      errors: plan.errors,
      warnings: plan.warnings,
      limitations: plan.limitations,
      uploads: plan.uploads,
      promptPreview: plan.plainText,
    };
  }

  function handlers() {
    return {
      "workbench:accounts": () => accountView(),

      "workbench:task-preview": (_e, projectId, storyboardId, accountId) =>
        previewPlan(projectId, storyboardId, accountId),

      /** 单条入队：参数与素材引用在此刻拍成快照，之后分镜再改也不影响本记录 */
      "workbench:task-enqueue": async (_e, projectId, storyboardId, accountId) => {
        const preview = await previewPlan(projectId, storyboardId, accountId);
        const { normalizeProject } = require("./workbench-store");
        const raw = await store.readProject(projectId);
        const project = normalizeProject(raw, raw.id);
        const storyboard = project.storyboards.find((s) => s.id === storyboardId);
        const record = await runner.enqueue({
          projectId,
          storyboardId,
          storyboardName: storyboard.name,
          accountId,
          params: preview.params,
          refs: preview.refs,
        });
        return { attempt: record, preview };
      },

      "workbench:tasks": (_e, projectId) => tasksFor(projectId),
      /** 分镜 × 账号的分配计划（纯逻辑，纯函数在 workbench-platform 里） */
      "workbench:task-assignments": (_e, storyboardIds, accountIds, mode) =>
        assignStoryboards({
          storyboardIds: Array.isArray(storyboardIds) ? storyboardIds : [],
          accountIds: Array.isArray(accountIds) ? accountIds : [],
          mode: String(mode || "distribute"),
        }),
      "workbench:task-execute": async (_e, projectId, attemptId) => {
        await runner.execute(projectId, attemptId);
        return { ok: true };
      },
      "workbench:task-cancel": (_e, projectId, attemptId) => runner.cancel(projectId, attemptId),
      "workbench:task-retry": (_e, projectId, attemptId) => runner.retry(projectId, attemptId),
      "workbench:task-download": async (_e, projectId, attemptId) => {
        const raw = await store.readProject(projectId);
        const project = raw ? { name: raw.name, storyboards: raw.storyboards || [] } : { name: "", storyboards: [] };
        const tasks = await taskStore.list(projectId);
        const record = tasks.find((t) => t.id === attemptId);
        const index = Math.max(1, project.storyboards.findIndex((s) => s.id === record?.storyboardId) + 1);
        return downloader.download({ projectId, attemptId, projectName: project.name, storyboardIndex: index });
      },
      "workbench:queue-status": () => runner.status(),
      "workbench:queue-pause": () => runner.pause(),
      "workbench:queue-resume": () => runner.resume(),
      "workbench:account-clear-block": (_e, accountId) => runner.clearAccountBlock(String(accountId)),
    };
  }

  return {
    handlers: handlers(),
    runner,
    driver,
    taskStore,
    accountView,
    dispose: () => {
      try {
        driver.dispose();
      } catch {}
    },
    recover: () => runner.recover(),
    status: () => runner.status(),
    tasksFor,
    previewPlan,
  };
}

module.exports = { ACCOUNTS_FILE, createTaskService, electronFetchToFile, readAccounts };