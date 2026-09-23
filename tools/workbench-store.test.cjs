#!/usr/bin/env node
/**
 * workbench-store 纯逻辑测试（不依赖 Electron）
 *
 * 覆盖阶段 1 里最容易出错、且日后改动风险最高的部分：
 *   - @图片 引用表的重建（位置、顺序、去重、悬空裁剪）
 *   - token 分配不与已有 token 冲突
 *   - 批量粘贴拆分
 *   - 草稿写入 / 重启恢复 / schema 归一化
 *   - 项目标识的路径安全
 *   - 改名不影响引用（引用只认 assetId）
 *
 * 用法：node tools/workbench-store.test.cjs
 * 退出码：0 全部通过；1 存在失败
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require(path.join(__dirname, "..", "app", "src", "workbench-store.js"));
const { assertId, assignTokens, createStore, normalizeProject, normalizeStoryboard, splitPrompts, syncRefsFromPrompt } = store;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

async function main() {
  console.log("── 标识安全 ──");
  check("接受合法标识", assertId("asset_ab12cd34ef56") === "asset_ab12cd34ef56");
  for (const bad of ["../evil", "a/b", "..", "", "A" .repeat(80), "a b", "a\\b"]) {
    let threw = false;
    try {
      assertId(bad);
    } catch {
      threw = true;
    }
    check(`拒绝非法标识 ${JSON.stringify(bad.slice(0, 12))}`, threw);
  }

  console.log("── token 分配 ──");
  const next = assignTokens([{ assetId: "asset_a", token: "@图1" }, { assetId: "asset_b", token: "@图3" }]);
  eq("跳过已占用编号", [next(), next()], ["@图2", "@图4"]);

  console.log("── 引用表重建（位置与顺序） ──");
  const refs = [
    { assetId: "asset_a", token: "@图1" },
    { assetId: "asset_b", token: "@图2" },
  ];
  eq(
    "顺序跟随文本出现位置而非数组顺序",
    syncRefsFromPrompt("先 @图2 再 @图1", refs).refs.map((r) => r.assetId),
    ["asset_b", "asset_a"]
  );
  eq(
    "文本中缺失的引用被裁掉并报告",
    syncRefsFromPrompt("只有 @图1", refs),
    { refs: [{ assetId: "asset_a", token: "@图1" }], dropped: ["@图2"] }
  );
  eq(
    "同一 token 重复出现只保留一次",
    syncRefsFromPrompt("@图1 再来 @图1", refs).refs.length,
    1
  );
  eq("无引用时返回空表", syncRefsFromPrompt("纯文本", refs).refs, []);
  eq(
    "不会把 @图10 误判为 @图1",
    syncRefsFromPrompt("@图10", [{ assetId: "asset_a", token: "@图1" }]).refs,
    []
  );

  console.log("── 批量粘贴拆分 ──");
  eq("空行分隔为 3 条", splitPrompts("一\n\n二\n\n三", "blank").count, 3);
  eq("每行一条为 2 条", splitPrompts("一\n二", "line").count, 2);
  eq("按分镜标记拆分", splitPrompts("分镜1：推开木门\n分镜2：镜头拉远", "marker").count, 2);
  eq("按 Markdown 标题拆分", splitPrompts("## 一\n内容A\n## 二\n内容B", "marker").count, 2);
  eq("序号前缀用于命名且从正文剥离", splitPrompts("1. 推开木门", "blank").items[0].name, "推开木门");
  eq("正文原样保留（含序号）", splitPrompts("1. 推开木门", "blank").items[0].prompt, "1. 推开木门");
  eq("空白输入得到 0 条", splitPrompts("   \n\n  ", "blank").count, 0);

  console.log("── 分镜归一化 ──");
  const sb = normalizeStoryboard({
    name: "分镜 A",
    prompt: "@图1 推门",
    refs: [
      { assetId: "asset_a", token: "@图1" },
      { assetId: "asset_a", token: "@图2" },
      { assetId: "bad id!", token: "@图3" },
    ],
  });
  eq("重复与非法引用被剔除", sb.refs, [{ assetId: "asset_a", token: "@图1" }]);
  check("自动补齐 id", /^sb_[a-z0-9]+$/.test(sb.id), sb.id);
  eq("覆盖项缺省为空字符串", sb.overrides, { model: "", duration: "", ratio: "" });

  console.log("── 项目归一化 ──");
  const project = normalizeProject({ name: "项目A", defaults: { model: "seedance2.0fast" } }, "prj_test");
  eq("未给出的默认值被补齐", project.defaults, {
    model: "seedance2.0fast",
    duration: "10",
    ratio: "16:9",
    removeWatermark: true,
  });
  eq("schemaVersion 写入", project.schemaVersion, 1);

  console.log("── 草稿写入与重启恢复 ──");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-store-test-"));
  try {
    const s1 = createStore(root);
    s1.ensure();
    const { project: created } = await s1.createProject("短剧 A");
    check("项目目录建立", fs.existsSync(s1.assetsDir(created.id)));

    created.defaults.model = "seedance2.5";
    created.storyboards.push(
      normalizeStoryboard(
        { name: "分镜 1", prompt: "推开木门 @图1", refs: [{ assetId: "asset_aaaaaaaaaaaa", token: "@图1" }] },
        0
      )
    );
    await s1.saveProject(created);

    const saved = JSON.parse(fs.readFileSync(path.join(root, "projects", created.id, "project.json"), "utf8"));
    check("project.json 可解析", saved && saved.id === created.id);
    check("无残留临时文件", !fs.existsSync(path.join(root, "projects", created.id, "project.json.tmp")));

    const s2 = createStore(root);
    const index = await s2.readIndex();
    eq("索引记录当前项目", index.currentProjectId, created.id);
    eq("索引摘要含分镜数", index.projects[0].storyboardCount, 1);

    const restored = normalizeProject(await s2.readProject(created.id), created.id);
    eq("重启后分镜数量一致", restored.storyboards.length, 1);
    eq("重启后引用仍按 assetId 保存", restored.storyboards[0].refs, [
      { assetId: "asset_aaaaaaaaaaaa", token: "@图1" },
    ]);
    eq("重启后提示词一致", restored.storyboards[0].prompt, "推开木门 @图1");
    eq("重启后默认参数一致", restored.defaults.model, "seedance2.5");

    // 改名安全：素材展示名变化不进入引用表，引用只由 assetId 决定
    const renamed = normalizeProject(JSON.parse(JSON.stringify(restored)), created.id);
    renamed.storyboards[0].name = "分镜 1（改名）";
    await s2.saveProject(renamed);
    const after = normalizeProject(await s2.readProject(created.id), created.id);
    eq("改名后引用不变", after.storyboards[0].refs, restored.storyboards[0].refs);

    const indexAfterDelete = await s2.deleteProject(created.id);
    check("删除项目后目录移除", !fs.existsSync(path.join(root, "projects", created.id)));
    eq("删除后索引清空", indexAfterDelete.projects.length, 0);
    eq("删除后不再指向该项目", indexAfterDelete.currentProjectId, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("");
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  console.log("结论：workbench-store 逻辑测试全部通过。");
}

main().catch((error) => {
  console.error("测试异常：", error);
  process.exit(1);
});