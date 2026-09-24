"use strict";
/**
 * 工作台持久化层（项目 / 分镜 / 草稿）
 *
 * 设计要点：
 * - 数据根目录：<userData>/workbench，与既有模块（video-log 存 diagnostics/）保持同一约定，
 *   不写入安装目录、不写入正式版账号数据目录。
 * - 写入一律「临时文件 + rename」原子替换，避免半截文件；任何一次分镜编辑即时落盘，
 *   因此「自动保存」就是常规写入路径，重启后从 project.json 恢复。
 * - schemaVersion 随文件保存，读取时经 migrate 归一化，便于后续升级。
 * - 所有对外标识先过 assertId，防止路径穿越。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SCHEMA_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 图片引用的稳定 token 形态，例如 @图1；写入提示词文本中的就是它 */
const TOKEN_RE = /@图(\d{1,3})/g;

function assertId(value, label = "标识") {
  const id = String(value ?? "");
  if (!ID_RE.test(id)) throw new Error(`${label}无效`);
  return id;
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function dump(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function text(value, max = 0) {
  const out = String(value ?? "");
  return max > 0 ? out.slice(0, max) : out;
}

/** 分镜：全局默认参数由项目 defaults 提供，单条只存覆盖项 */
function normalizeStoryboard(input = {}, order = 0) {
  const refs = Array.isArray(input.refs) ? input.refs : [];
  const seen = new Set();
  const normalizedRefs = [];
  for (const ref of refs) {
    const assetId = text(ref?.assetId);
    if (!ID_RE.test(assetId) || seen.has(assetId)) continue;
    seen.add(assetId);
    normalizedRefs.push({ assetId, token: text(ref?.token, 16) || `@图${normalizedRefs.length + 1}` });
  }
  const overrides = input.overrides && typeof input.overrides === "object" ? input.overrides : {};
  return {
    id: ID_RE.test(text(input.id)) ? text(input.id) : newId("sb"),
    order: Number.isInteger(input.order) ? input.order : order,
    name: text(input.name, 120),
    prompt: text(input.prompt),
    refs: normalizedRefs,
    overrides: {
      model: text(overrides.model, 40),
      duration: text(overrides.duration, 16),
      ratio: text(overrides.ratio, 16),
    },
    settings: input.settings && typeof input.settings === "object" ? input.settings : {},
    updatedAt: text(input.updatedAt) || new Date().toISOString(),
  };
}

function normalizeDefaults(input = {}) {
  return {
    model: text(input.model, 40) || "seedance2.5",
    duration: text(input.duration, 16) || "10",
    ratio: text(input.ratio, 16) || "16:9",
    removeWatermark: input.removeWatermark !== false,
  };
}

function normalizeProject(input = {}, id) {
  const storyboards = Array.isArray(input.storyboards) ? input.storyboards : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: text(input.name, 120) || "未命名项目",
    createdAt: text(input.createdAt) || new Date().toISOString(),
    updatedAt: text(input.updatedAt) || new Date().toISOString(),
    defaults: normalizeDefaults(input.defaults),
    storyboards: storyboards.map((sb, i) => normalizeStoryboard(sb, i)),
    ui: input.ui && typeof input.ui === "object" ? input.ui : {},
    // 项目级设置必须保留：任务服务通过 saveProject 写入 settings.autoDownload，
    // 旧实现归一化时把 settings 丢掉，导致「生成成功后自动下载」开关永远读不到、永久失效。
    settings: input.settings && typeof input.settings === "object" ? input.settings : {},
    generation: Number.isInteger(input.generation) ? input.generation : 1,
  };
}

/** 用 token 在提示词文本中的出现情况，重建「位置与顺序都正确」的引用表 */
function syncRefsFromPrompt(prompt, refs) {
  const bound = new Map(refs.map((r) => [r.token, r.assetId]));
  const ordered = [];
  const used = new Set();
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(prompt))) {
    const token = match[0];
    const assetId = bound.get(token);
    if (!assetId || used.has(assetId)) continue;
    used.add(assetId);
    ordered.push({ assetId, token });
  }
  const dropped = refs.filter((r) => !used.has(r.assetId)).map((r) => r.token);
  return { refs: ordered, dropped };
}

/** 给提示词里尚未编号的引用分配 token（按传入顺序），返回 token 映射 */
function assignTokens(existingRefs) {
  const taken = new Set(existingRefs.map((r) => r.token));
  let next = 1;
  return () => {
    while (taken.has(`@图${next}`)) next++;
    const token = `@图${next}`;
    taken.add(token);
    return token;
  };
}

/**
 * 批量粘贴：按指定规则把一段文本拆成多条分镜提示词。
 * 纯函数，便于脱离 Electron 直接验证。
 */
function splitPrompts(rawText, mode = "blank") {
  const raw = String(rawText ?? "").replace(/\r\n?/g, "\n");
  let blocks;
  if (mode === "line") {
    blocks = raw.split("\n");
  } else if (mode === "marker") {
    blocks = raw.split(/\n(?=\s*(?:#{1,6}\s|分镜\s*\d+|---+\s*$))/m);
  } else {
    blocks = raw.split(/\n\s*\n/);
  }
  const items = [];
  for (const block of blocks) {
    const body = block.trim();
    if (!body) continue;
    // 去掉常见序号前缀，仅用于生成默认名称；正文原样保留
    const firstLine = body.split("\n")[0].trim();
    const stripped = firstLine.replace(
      /^\s*(?:\d+\s*[.、)）:：]|#{1,6}\s+|分镜\s*\d+\s*[:：]?)\s*/,
      ""
    );
    items.push({
      index: items.length + 1,
      name: (stripped || firstLine).slice(0, 40),
      prompt: body,
      chars: body.length,
      lines: body.split("\n").length,
    });
  }
  return { mode, count: items.length, items };
}

function createStore(rootDir) {
  const projectsDir = path.join(rootDir, "projects");
  const indexPath = path.join(rootDir, "projects.json");

  function ensureDirs() {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  // 同一文件的写入串行化 + 唯一临时名。
  // 旧实现临时名固定为 `${file}.tmp` 且不串行化：两个 debounce（提示词自动保存、
  // 分镜参数保存）同时到期时会互相覆盖临时文件，或后写覆盖前写，导致分镜/引用丢失。
  const writeQueues = new Map();
  async function writeFileAtomic(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    await fsp.writeFile(tmp, dump(value), "utf8");
    try {
      await fsp.rename(tmp, file);
    } catch (error) {
      try {
        await fsp.rm(tmp, { force: true });
      } catch {}
      throw error;
    }
  }

  function writeAtomic(file, value) {
    const prev = writeQueues.get(file) || Promise.resolve();
    const next = prev.then(
      () => writeFileAtomic(file, value),
      () => writeFileAtomic(file, value)
    );
    writeQueues.set(file, next.catch(() => {}));
    return next;
  }

  async function readJson(file, fallback) {
    try {
      const value = JSON.parse(await fsp.readFile(file, "utf8"));
      return value && typeof value === "object" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  const projectDir = (projectId) => path.join(projectsDir, assertId(projectId, "项目标识"));
  const projectFile = (projectId) => path.join(projectDir(projectId), "project.json");

  async function readIndex() {
    const raw = await readJson(indexPath, {});
    const projects = Array.isArray(raw.projects) ? raw.projects : [];
    return {
      schemaVersion: SCHEMA_VERSION,
      currentProjectId: ID_RE.test(text(raw.currentProjectId)) ? text(raw.currentProjectId) : "",
      projects: projects
        .filter((p) => ID_RE.test(text(p?.id)))
        .map((p) => ({
          id: text(p.id),
          name: text(p.name, 120) || "未命名项目",
          createdAt: text(p.createdAt),
          updatedAt: text(p.updatedAt),
          storyboardCount: Number.isInteger(p.storyboardCount) ? p.storyboardCount : 0,
        })),
    };
  }

  async function writeIndex(index) {
    await writeAtomic(indexPath, index);
  }

  /** 保持索引里的摘要与项目文件一致 */
  async function touchIndex(project) {
    const index = await readIndex();
    const entry = index.projects.find((p) => p.id === project.id);
    const summary = {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      storyboardCount: project.storyboards.length,
    };
    if (entry) Object.assign(entry, summary);
    else index.projects.push(summary);
    index.currentProjectId = project.id;
    await writeIndex(index);
    return index;
  }

  return {
    rootDir,

    ensure: ensureDirs,
    readIndex,

    async createProject(name) {
      const id = newId("prj");
      const project = normalizeProject({ name }, id);
      await writeAtomic(projectFile(id), project);
      await fsp.mkdir(path.join(projectDir(id), "assets"), { recursive: true });
      await fsp.mkdir(path.join(projectDir(id), "thumbs"), { recursive: true });
      const index = await touchIndex(project);
      return { project, index };
    },

    async openProject(projectId) {
      const id = assertId(projectId, "项目标识");
      const project = await readJson(projectFile(id), null);
      if (!project) throw new Error("项目不存在或已损坏");
      const normalized = normalizeProject(project, id);
      const index = await readIndex();
      if (index.currentProjectId !== id) {
        index.currentProjectId = id;
        await writeIndex(index);
      }
      return normalized;
    },

    readProject: async (projectId) =>
      readJson(projectFile(assertId(projectId, "项目标识")), null),

    async saveProject(project) {
      const normalized = normalizeProject(project, assertId(project.id, "项目标识"));
      normalized.updatedAt = new Date().toISOString();
      await writeAtomic(projectFile(normalized.id), normalized);
      await touchIndex(normalized);
      return normalized;
    },

    async renameProject(projectId, name) {
      const project = await this.openProject(projectId);
      project.name = text(name, 120) || project.name;
      return this.saveProject(project);
    },

    async deleteProject(projectId) {
      const id = assertId(projectId, "项目标识");
      const index = await readIndex();
      index.projects = index.projects.filter((p) => p.id !== id);
      if (index.currentProjectId === id) index.currentProjectId = index.projects[0]?.id || "";
      await writeIndex(index);
      await fsp.rm(projectDir(id), { recursive: true, force: true });
      return index;
    },

    /** 项目数据目录（素材、缩略图都在这里，便于整体备份/迁移） */
    attachmentsDir(projectId) {
      return projectDir(projectId);
    },
    assetsDir: (projectId) => path.join(projectDir(projectId), "assets"),
    thumbsDir: (projectId) => path.join(projectDir(projectId), "thumbs"),
    assetCatalogFile: (projectId) => path.join(projectDir(projectId), "assets.json"),
  };
}

module.exports = {
  SCHEMA_VERSION,
  TOKEN_RE,
  assignTokens,
  assertId,
  createStore,
  newId,
  normalizeDefaults,
  normalizeProject,
  normalizeStoryboard,
  splitPrompts,
  syncRefsFromPrompt,
};