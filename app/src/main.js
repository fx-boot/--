"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const accountProxy = require("./account-proxy");
const cookieImportCompat = require("./cookie-import-compat");
require('./hd-original-service').install();
require('./video-log-service').install();
require('./workbench-service').install();

const debug = (message) => {
  if (process.env.DBM_COMPAT_DEBUG === "1") process.stderr.write(`[cookie-import] ${message}\n`);
};

debug("loader started");

const bytecodePath = path.join(__dirname, "main.jsc");
const bytecodeHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync(bytecodePath))
  .digest("hex");

if (bytecodeHash !== "b4f9dc7840cc773182bb9ed35c06b79eb793f3ebe30c470e0db0563d811cac01") {
  throw new Error("\u7a0b\u5e8f\u6838\u5fc3\u5b8c\u6574\u6027\u6821\u9a8c\u5931\u8d25\uff0c\u8bf7\u91cd\u65b0\u5b89\u88c5 V2.0");
}

debug("bytecode verified");
cookieImportCompat.captureAccountsImport();
accountProxy.captureAccountLifecycle();
debug("IPC capture installed");
require("bytenode");
debug("bytenode loaded");
require(bytecodePath);
debug("application bytecode loaded");
try {
  cookieImportCompat.registerCompatibleImport();
} catch (error) {
  debug(error.stack || String(error));
  throw error;
}
debug("compatible import registered");
accountProxy.registerAccountProxy();
debug("account proxy registered");
require("./account-proxy-pool").registerAccountProxyPool();
debug("account proxy pool registered");
cookieImportCompat.persistExistingDolaCookies().catch((error) => {
  debug(error.stack || String(error));
});
