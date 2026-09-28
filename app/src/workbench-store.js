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
      ...(typeof overrides.removeWatermark === "boolean" ? { removeWatermark: overrides.removeWatermark } : {}),
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
    parentId: ID_RE.test(text(input.parentId)) && input.parentId !== id ? text(input.parentId) : "",
    createdAt: text(input.createdAt) || new Date().toISOString(),
    updatedAt: text(input.updatedAt) || new Date().toISOString(),
    defaults: normalizeDefaults(input.defaults),
    storyboards: storyboards.map((sb, i) => normalizeStoryboard(sb, i)),
    ui: input.ui && typeof input.ui === "object" ? input.ui : {},
    // 项目级设置必须保留：任务服务通过 saveProject 写入 settings.autoDownload，
    // 旧实现归一化时把 settings 丢掉，导致「生成成功后自动下载」开关永远读不到、永久失效。
    settings: input.settings && typeof input.settings === "object" ? input.settings : {},
    library: {
      templates: Array.isArray(input.library?.templates) ? input.library.templates : [],
      favorites: Array.isArray(input.library?.favorites) ? input.library.favorites.filter((id) => ID_RE.test(String(id))) : [],
      undo: input.library?.undo || null,
    },
    generation: Number.isInteger(input.generation) ? input.generation : 1,
  };
}

/**
 * 索引摘要里附带「提示词摘要 + 引用素材数」。
 * 分集列表要展示每条分集的提示词摘要与绑定素材数量，如果只靠打开项目逐个读取，
 * 列表渲染会退化成 N 次 IO；摘要随索引写入，读取一次索引即可完整渲染。
 */
function briefOf(project) {
  const storyboard = (Array.isArray(project?.storyboards) ? project.storyboards : [])[0] || null;
  const prompt = text(storyboard?.prompt).replace(/\s+/g, " ").trim();
  return {
    promptPreview: prompt.slice(0, 60),
    refCount: Array.isArray(storyboard?.refs) ? storyboard.refs.length : 0,
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

  function serialized(file, operation) {
    const previous = writeQueues.get(file) || Promise.resolve();
    const next = previous.then(operation, operation);
    writeQueues.set(file, next.catch(() => {}));
    return next;
  }

  function writeAtomic(file, value) {
    return serialized(file, () => writeFileAtomic(file, value));
  }

  // 独立于文件队列的「按业务 key 串行」域。
  // 用途：需要「先读后写」才能确定的业务编号（如分集序号）。不能复用文件队列，
  // 否则内部再调用 touchIndex 会造成同一队列自等待。
  const keyQueues = new Map();
  function serializedByKey(key, operation) {
    const previous = keyQueues.get(key) || Promise.resolve();
    const next = previous.then(operation, operation);
    keyQueues.set(key, next.catch(() => {}));
    return next;
  }

  function updateIndex(mutator) {
    return serialized(indexPath, async () => {
      const index = await readIndex();
      await mutator(index);
      await writeFileAtomic(indexPath, index);
      return index;
    });
  }

  async function readJson(file, fallback) {
    try {
      const value = JSON.parse(await fsp.readFile(file, "utf8"));
      return value && typeof value === "object" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  /** 区分「文件不存在」与「内容损坏」；损坏时调用方可备份并尝试恢复 */
  async function readJsonStrict(file) {
    let raw;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch {
      return { exists: false, corrupt: false, value: null };
    }
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object") return { exists: true, corrupt: true, value: null };
      return { exists: true, corrupt: false, value };
    } catch {
      return { exists: true, corrupt: true, value: null };
    }
  }

  /** 损坏文件的取证备份：先留底再重建，绝不直接丢弃用户数据 */
  async function backupCorrupt(file) {
    const target = `${file}.corrupt-${Date.now()}.json`;
    try {
      await fsp.copyFile(file, target);
      return target;
    } catch {
      return "";
    }
  }

  // 最近一次索引恢复记录（供界面提示「已从磁盘重建」，而不是静默显示为空）
  let lastIndexRecovery = null;
  function recoveryInfo() {
    return lastIndexRecovery;
  }

  /**
   * 从 projects/ 目录扫描 project.json 重建索引。
   * 旧实现在 projects.json 损坏时直接返回空列表 —— 界面上「所有项目消失」，
   * 但磁盘目录其实都在，用户很可能重新建项目，导致旧数据彻底失联。
   */
  async function rebuildIndexFromDisk() {
    let names = [];
    try {
      names = await fsp.readdir(projectsDir);
    } catch {
      names = [];
    }
    const projects = [];
    for (const name of names) {
      if (!ID_RE.test(name)) continue;
      const project = await readJson(path.join(projectsDir, name, "project.json"), null);
      if (!project || !ID_RE.test(text(project.id))) continue;
      projects.push({
        id: text(project.id),
        name: text(project.name, 120) || "未命名项目",
        parentId: ID_RE.test(text(project.parentId)) ? text(project.parentId) : "",
        createdAt: text(project.createdAt),
        updatedAt: text(project.updatedAt),
        storyboardCount: Array.isArray(project.storyboards) ? project.storyboards.length : 0,
        ...briefOf(project),
      });
    }
    projects.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    // 当前项目：取最近更新的大项目（分集不作为默认当前项）
    const root = projects.filter((p) => !p.parentId).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return { schemaVersion: SCHEMA_VERSION, currentProjectId: root ? root.id : "", projects };
  }

  const projectDir = (projectId) => path.join(projectsDir, assertId(projectId, "项目标识"));
  const projectFile = (projectId) => path.join(projectDir(projectId), "project.json");

  // 旧版索引缺失摘要字段时的补全缓存（进程内）：只补读一次，不额外写盘——
  // 索引写入统一走 updateIndex 队列，这里若直接写会与队列里的写入互相覆盖。
  const summaryCache = new Map();
  async function enrichSummaries(entries) {
    for (const entry of entries) {
      if (summaryCache.has(entry.id)) continue;
      const project = await readJson(projectFile(entry.id), null);
      summaryCache.set(entry.id, project ? briefOf(project) : { promptPreview: "", refCount: 0 });
    }
  }

  async function readIndex() {
    const parsed = await readJsonStrict(indexPath);
    if (parsed.corrupt) {
      const backup = await backupCorrupt(indexPath);
      const rebuilt = await rebuildIndexFromDisk();
      lastIndexRecovery = {
        at: new Date().toISOString(),
        backup,
        recoveredFrom: "projects 目录扫描重建",
        projectCount: rebuilt.projects.length,
      };
      // 立刻把重建结果落盘，避免每次读都重建（也避免后续写入基于空索引覆盖）
      try {
        await writeFileAtomic(indexPath, rebuilt);
      } catch {}
      return rebuilt;
    }
    const raw = parsed.value || {};
    const list = Array.isArray(raw.projects) ? raw.projects : [];
    const projects = [];
    const needBrief = [];
    for (const p of list) {
      if (!ID_RE.test(text(p?.id))) continue;
      const entry = {
        id: text(p.id),
        name: text(p.name, 120) || "未命名项目",
        parentId: ID_RE.test(text(p.parentId)) ? text(p.parentId) : "",
        createdAt: text(p.createdAt),
        updatedAt: text(p.updatedAt),
        storyboardCount: Number.isInteger(p.storyboardCount) ? p.storyboardCount : 0,
        promptPreview: text(p.promptPreview, 60),
        refCount: Number.isInteger(p.refCount) ? p.refCount : 0,
      };
      // 旧版索引没有摘要字段（refCount 非整数且没有写过 promptPreview）：
      // 第一次读取时补一次，让分集列表不必等到「编辑过每一条」才有摘要可看。
      if (!Number.isInteger(p.refCount) && text(p.promptPreview) === "") needBrief.push(entry);
      projects.push(entry);
    }
    if (needBrief.length) {
      await enrichSummaries(needBrief);
      for (const entry of needBrief) Object.assign(entry, summaryCache.get(entry.id));
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      currentProjectId: ID_RE.test(text(raw.currentProjectId)) ? text(raw.currentProjectId) : "",
      projects,
    };
  }

  /** 保持索引里的摘要与项目文件一致 */
  function touchIndex(project, select = false) {
    return updateIndex((index) => {
      const entry = index.projects.find((p) => p.id === project.id);
      const summary = {
        id: project.id,
        name: project.name,
        parentId: project.parentId || "",
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        storyboardCount: project.storyboards.length,
        ...briefOf(project),
      };
      if (entry) Object.assign(entry, summary);
      else index.projects.push(summary);
      if (select) index.currentProjectId = project.id;
    });
  }

  return {
    rootDir,

    ensure: ensureDirs,
    readIndex,
    // 索引损坏后从磁盘重建的最近一次记录（界面据此提示「已恢复」，不是静默清空）
    recoveryInfo,

    // 兼容旧项目：只为完全空的项目初始化一个草稿，不删除历史分镜。
    // 和项目写入共用文件队列，多个快照同时读取时也只创建一次。
    async ensureComposeDraft(projectId) {
      const id = assertId(projectId, "项目标识");
      const file = projectFile(id);
      const previous = writeQueues.get(file) || Promise.resolve();
      const initialize = async () => {
        const raw = await readJson(file, null);
        if (!raw) throw new Error("项目不存在或已损坏");
        const project = normalizeProject(raw, id);
        if (project.storyboards.length) return project;
        const draft = normalizeStoryboard({ name: "视频创作" });
        project.storyboards = [draft];
        project.ui = { ...project.ui, selectedStoryboardId: draft.id };
        await writeFileAtomic(file, project);
        await touchIndex(project);
        return project;
      };
      const next = previous.then(initialize, initialize);
      writeQueues.set(file, next.catch(() => {}));
      return next;
    },

    async createProject(name, options = {}) {
      const parentId = options.parentId ? assertId(options.parentId, "所属项目") : "";
      if (parentId) {
        const parent = await readJson(projectFile(parentId), null);
        if (!parent || parent.parentId) throw new Error("请选择一个大项目作为所属项目");
      }
      const createNow = async (finalName) => {
        const id = newId("prj");
        const project = normalizeProject({ name: finalName, parentId }, id);
        const dir = projectDir(id);
        let index;
        try {
          await writeAtomic(projectFile(id), project);
          await fsp.mkdir(path.join(dir, "assets"), { recursive: true });
          await fsp.mkdir(path.join(dir, "thumbs"), { recursive: true });
          index = await touchIndex(project, true);
        } catch (error) {
          // 回滚：旧实现中途失败会在磁盘留下「有目录、索引无记录」的孤儿项目，
          // 用户既看不到也无法删除，只能手工清理。失败即清理，保证索引与磁盘一致。
          try {
            await fsp.rm(dir, { recursive: true, force: true });
          } catch {}
          throw error;
        }
        return { project, index };
      };
      // 分集编号在服务端串行分配：旧实现由渲染层先按现有名字算编号、再发创建请求，
      // 快速连点两次会都算出「第 1 集」，产生两个同名分集（下拉里无法区分）。
      if (parentId && options.episodeNumbering) {
        return serializedByKey(`episode:${parentId}`, async () => {
          const index = await readIndex();
          const used = index.projects
            .filter((p) => p.parentId === parentId)
            .map((p) => {
              const m = /^第\s*(\d+)\s*集/.exec(String(p.name || ""));
              return m ? Number(m[1]) : 0;
            });
          return createNow(`第 ${(used.length ? Math.max(...used) : 0) + 1} 集`);
        });
      }
      return createNow(name);
    },

    async openProject(projectId) {
      const id = assertId(projectId, "项目标识");
      const project = await readJson(projectFile(id), null);
      if (!project) throw new Error("项目不存在或已损坏");
      const normalized = normalizeProject(project, id);
      await updateIndex((index) => { index.currentProjectId = id; });
      return normalized;
    },

    readProject: async (projectId) =>
      readJson(projectFile(assertId(projectId, "项目标识")), null),

    // 整份替换仅供兼容/导入；交互修改必须使用 updateProject。
    async saveProject(project) {
      const normalized = normalizeProject(project, assertId(project.id, "项目标识"));
      normalized.updatedAt = new Date().toISOString();
      await writeAtomic(projectFile(normalized.id), normalized);
      await touchIndex(normalized);
      return normalized;
    },

    // 每次修改必须在同一项目队列内读取最新数据，不能排队写入调用方的旧快照。
    updateProject(projectId, mutator) {
      const id = assertId(projectId, "项目标识");
      const file = projectFile(id);
      return serialized(file, async () => {
        const raw = await readJson(file, null);
        if (!raw) throw new Error("项目不存在或已损坏");
        const project = normalizeProject(raw, id);
        await mutator(project);
        const normalized = normalizeProject(project, id);
        normalized.updatedAt = new Date().toISOString();
        await writeFileAtomic(file, normalized);
        await touchIndex(normalized);
        return normalized;
      });
    },

    async renameProject(projectId, name) {
      return this.updateProject(projectId, (project) => {
        project.name = text(name, 120) || project.name;
      });
    },

    /**
     * 删除项目。
     * - 默认：大项目下还有分集时拒绝（避免误删整季内容）；
     * - options.cascade=true：连同其下全部分集一并删除（界面在用户二次确认后传 true）。
     * 返回 { index, removed, cleanupFailed }：cleanupFailed 是「索引已摘除但目录没删干净」的 id，
     * 供界面提示（例如文件被播放器占用），而不是直接抛错让用户以为删除失败。
     */
    async deleteProject(projectId, options = {}) {
      const id = assertId(projectId, "项目标识");
      const cascade = options.cascade === true;
      return serialized(projectFile(id), async () => {
        const before = await readIndex();
        const targets = new Set([id]);
        if (cascade) {
          // 分集只允许一级，但数据可能被外部改动成多层：按 parentId 链闭包收敛，避免留下孤儿
          let grew = true;
          while (grew) {
            grew = false;
            for (const p of before.projects) {
              if (p.parentId && targets.has(p.parentId) && !targets.has(p.id)) {
                targets.add(p.id);
                grew = true;
              }
            }
          }
        } else {
          const children = before.projects.filter((p) => p.parentId === id);
          if (children.length) {
            throw new Error(`项目下仍有 ${children.length} 个分集，请先删除分集，或选择「连同分集一起删除」`);
          }
        }
        const removed = [...targets];
        const index = await updateIndex((idx) => {
          idx.projects = idx.projects.filter((p) => !targets.has(p.id));
          if (targets.has(idx.currentProjectId)) {
            const rest = idx.projects.filter((p) => !p.parentId);
            const next = rest.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
            idx.currentProjectId = next?.id || idx.projects[0]?.id || "";
          }
        });
        // 先摘索引再删目录：读取以索引为准，删到一半中断也不会「复活」成可见项目；
        // 目录残留属于可清理垃圾（cleanupFailed 会上报），不影响数据一致性。
        const cleanupFailed = [];
        for (const target of removed) {
          try {
            await fsp.rm(projectDir(target), { recursive: true, force: true });
          } catch {
            cleanupFailed.push(target);
          }
        }
        return { index, removed, cleanupFailed };
      });
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
  briefOf,
  createStore,
  newId,
  normalizeDefaults,
  normalizeProject,
  normalizeStoryboard,
  splitPrompts,
  syncRefsFromPrompt,
};
