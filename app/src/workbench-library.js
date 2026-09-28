"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { newId, assertId, syncRefsFromPrompt } = require("./workbench-store");
const { snapshotParams, snapshotRefs } = require("./workbench-task-store");

function createLibrary({ store, taskStore, assets }) {
  const nameOf = (value) => {
    const name = String(value || "").trim().slice(0, 80);
    if (!name) throw new Error("请输入名称");
    return name;
  };
  function draftOf(project, id) {
    const draft = project.storyboards.find((item) => item.id === id);
    if (!draft) throw new Error("当前草稿不存在");
    return draft;
  }
  function snapshot(project, draft) {
    const overrides = Object.fromEntries(Object.entries(draft.overrides || {}).filter(([, value]) => value !== ""));
    return { params: snapshotParams({ ...project.defaults, ...overrides, prompt: draft.prompt }), refs: snapshotRefs(draft.refs) };
  }
  async function requireTask(projectId, id) {
    const task = (await taskStore.list(projectId)).find((item) => item.id === id);
    if (!task) throw new Error("任务不存在");
    return task;
  }
  async function validateRefs(projectId, data) {
    const tokens = new Set(data.params.prompt.match(/@图\d{1,3}/g) || []);
    for (const token of tokens) {
      const ref = data.refs.find((item) => item.token === token);
      const asset = ref && await assets.findAsset(projectId, ref.assetId);
      if (!asset) throw new Error(`参考图 ${token} 已缺失，请先恢复素材；当前草稿未替换`);
      const dir = path.resolve(store.assetsDir(projectId));
      const file = path.resolve(dir, asset.fileName);
      if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || (ref.sha256 && ref.sha256 !== asset.sha256)) {
        throw new Error(`参考图 ${token} 不可用或内容已变化；当前草稿未替换`);
      }
    }
  }
  function assign(draft, data) {
    const { prompt, ...params } = snapshotParams(data.params);
    draft.prompt = prompt;
    draft.overrides = params;
    draft.refs = syncRefsFromPrompt(prompt, snapshotRefs(data.refs)).refs;
    draft.updatedAt = new Date().toISOString();
  }
  const operations = {
    async save(projectId, input) {
      let template;
      await store.updateProject(projectId, async (project) => {
        const data = snapshot(project, draftOf(project, input.draftId));
        if (!data.params.prompt.trim()) throw new Error("提示词为空，不能保存模板");
        const refs = [];
        for (const ref of data.refs) {
          const asset = await assets.findAsset(projectId, ref.assetId);
          refs.push({ ...ref, name: asset?.name || "", sha256: asset?.sha256 || "" });
        }
        template = { id: newId("tpl"), name: nameOf(input.name), createdAt: new Date().toISOString(), ...data, refs };
        project.library.templates.unshift(template);
      });
      return template;
    },
    async rename(projectId, input) {
      return store.updateProject(projectId, (project) => {
        const template = project.library.templates.find((item) => item.id === input.id);
        if (!template) throw new Error("模板不存在");
        template.name = nameOf(input.name);
      });
    },
    async remove(projectId, input) {
      return store.updateProject(projectId, (project) => {
        project.library.templates = project.library.templates.filter((item) => item.id !== input.id);
      });
    },
    async apply(projectId, input) {
      const task = input.kind === "history" ? await requireTask(projectId, input.id) : null;
      if (!task && input.kind !== "template") throw new Error("未知方案类型");
      return store.updateProject(projectId, async (project) => {
        const source = task || project.library.templates.find((item) => item.id === input.id);
        if (!source) throw new Error("模板不存在");
        const data = { params: snapshotParams(source.params), refs: snapshotRefs(source.refs) };
        await validateRefs(projectId, data);
        const draft = draftOf(project, input.draftId);
        project.library.undo = { draftId: draft.id, ...snapshot(project, draft) };
        assign(draft, data);
      });
    },
    async undo(projectId) {
      return store.updateProject(projectId, (project) => {
        const previous = project.library.undo;
        if (!previous) throw new Error("没有可以撤销的载入");
        assign(draftOf(project, previous.draftId), previous);
        project.library.undo = null;
      });
    },
    async favorite(projectId, input) {
      const task = await requireTask(projectId, input.id);
      if (task.status !== "succeeded") throw new Error("只能收藏已生成的作品");
      return store.updateProject(projectId, (project) => {
        const favorites = new Set(project.library.favorites);
        if (input.enabled === true) favorites.add(task.id); else favorites.delete(task.id);
        project.library.favorites = [...favorites];
      });
    },
    async media(projectId, input) {
      const task = await requireTask(projectId, input.id);
      if (task.status !== "succeeded") throw new Error("视频尚未生成成功");
      const local = task.download?.filePath || task.result?.filePath;
      if (local && fs.existsSync(local) && fs.statSync(local).isFile()) return { url: pathToFileURL(local).href, local: true };
      const url = task.result?.videoUrl || "";
      if (!/^https?:\/\//i.test(url)) throw new Error("没有可播放的视频地址，请先下载或刷新结果");
      return { url, local: false };
    },
  };
  return {
    async command(operation, projectId, input = {}) {
      assertId(projectId, "项目标识");
      if (!Object.hasOwn(operations, operation)) throw new Error("不支持的作品库操作");
      return operations[operation](projectId, input);
    },
  };
}
module.exports = { createLibrary };
