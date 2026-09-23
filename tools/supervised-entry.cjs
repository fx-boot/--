/**
 * 隔离后正常运行真实应用的入口（受控入口）
 *
 * 与 boot-probe.cjs 的区别：本入口只做隔离与记录，然后把控制权完全交给真实应用，
 * 不写报告、不自动退出，供人工登录测试账号并使用工作台。
 *
 * 为什么不是只用 --user-data-dir：
 *   Chromium 在应用 JS 之前就会初始化 profile，这层只能靠 --user-data-dir；
 *   但主进程之后仍可能自行调整数据目录，这层只能靠拦截 app.setPath。
 *   两层的必要性已由 tools/isolation-verify.cjs 实测确认。
 *
 * 不提交任何生成任务；生成由使用者在工作台界面里点击触发。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const exeDir = path.dirname(process.execPath);
const isolatedRoot = path.resolve(
  process.env.DBM_ISOLATED_ROOT || path.join(exeDir, "isolated-data")
);
const appDataDir = path.join(isolatedRoot, "DoubaoAccountManager");

const record = {
  startedAt: new Date().toISOString(),
  isolatedRoot,
  appDataDir,
  chromiumUserDataDir: process.env.DBM_CHROMIUM_DIR || "",
  pathRequests: [],
  mainLoaded: false,
  error: null,
};

fs.mkdirSync(appDataDir, { recursive: true });
const nativeSetPath = app.setPath.bind(app);
for (const name of ["appData"]) nativeSetPath(name, isolatedRoot);
app.setPath = (name, value) => {
  if (["userData", "sessionData", "appData"].includes(name)) {
    const applied = name === "appData" ? isolatedRoot : appDataDir;
    record.pathRequests.push({ name, requested: String(value ?? ""), applied });
    return nativeSetPath(name, applied);
  }
  return nativeSetPath(name, value);
};
app.setPath("userData", appDataDir);

function writeRecord() {
  try {
    record.userDataApplied = app.getPath("userData");
    record.sessionDataApplied = app.getPath("sessionData");
    fs.writeFileSync(path.join(isolatedRoot, "launch-record.json"), JSON.stringify(record, null, 2));
  } catch {}
}

try {
  require("./src/main");
  record.mainLoaded = true;
} catch (error) {
  record.error = error?.stack || String(error);
  writeRecord();
  throw error;
}
writeRecord();

app.whenReady().then(writeRecord).catch(() => {});