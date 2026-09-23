"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CUSTOM_CHANNEL = "accounts:import-compatible";
const REFRESH_CHANNEL = "accounts:compatible-refreshed";
const DEFAULT_DOMAIN = ".dola.com";
const DEFAULT_URL = "https://www.dola.com/";
const MAX_REMARK_LENGTH = 100;
const PERSIST_SECONDS = 365 * 24 * 60 * 60;
const AUTH_COOKIE_NAMES = new Set([
  "sessionid",
  "sessionid_ss",
  "sid_tt",
  "uid_tt",
  "uid_tt_ss",
]);
const COOKIE_ATTRIBUTES = new Set([
  "domain",
  "expires",
  "httponly",
  "max-age",
  "partitioned",
  "path",
  "samesite",
  "secure",
]);
const state = {
  importHandler: null,
  installed: false,
  listHandler: null,
  originalHandle: null,
  partitionWriteQueues: new Map(),
  queue: Promise.resolve(),
  registered: false,
  registrationRequested: false,
  updateHandler: null,
  watchedPartitions: new Set(),
};

function enqueuePartitionWrite(accountId, task) {
  const key = text(accountId);
  const previous = state.partitionWriteQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => {});
  state.partitionWriteQueues.set(key, settled);
  settled.finally(() => {
    if (state.partitionWriteQueues.get(key) === settled) state.partitionWriteQueues.delete(key);
  });
  return next;
}

function debug(message) {
  if (process.env.DBM_COMPAT_DEBUG === "1") process.stderr.write(`[cookie-import] ${message}\n`);
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validCookieName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function normalizeDomain(value) {
  let domain = text(value).toLowerCase();
  if (!domain) return DEFAULT_DOMAIN;
  domain = domain.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  if (!domain) return DEFAULT_DOMAIN;
  if (domain === "dola.com") return ".dola.com";
  if (domain === "doubao.com") return ".doubao.com";
  if (domain === "ciciai.com") return ".ciciai.com";
  if (/^(?:\.|[a-z0-9-]+\.)+(?:dola|doubao|ciciai)\.com$/i.test(domain)) return domain;
  return DEFAULT_DOMAIN;
}

function normalizeSameSite(value) {
  const sameSite = text(value).toLowerCase().replace(/[ -]/g, "_");
  if (["strict", "lax", "unspecified"].includes(sameSite)) return sameSite;
  if (["none", "no_restriction", "norestriction"].includes(sameSite)) return "no_restriction";
  return "unspecified";
}

function normalizeExpiration(value) {
  if (value == null || value === "") return 0;
  let expiration = Number(value);
  if (!Number.isFinite(expiration)) expiration = Date.parse(String(value)) / 1000;
  if (!Number.isFinite(expiration) || expiration <= 0) return 0;
  if (expiration > 100000000000) expiration /= 1000;
  return expiration > Date.now() / 1000 ? expiration : 0;
}

function normalizeCookieRecord(record, defaultDomain = DEFAULT_DOMAIN) {
  if (!isObject(record)) return null;
  const name = text(record.name ?? record.key);
  if (!name || !validCookieName(name)) return null;
  const value = record.value == null ? "" : String(record.value);
  const domain = normalizeDomain(record.domain || defaultDomain);
  const cookiePath = text(record.path) || "/";
  const expirationSource = record.expirationDate ?? record.expires ?? record.expiry ?? record.expiration;
  let expirationDate = normalizeExpiration(expirationSource);
  const explicitExpiration = Boolean(expirationDate);
  if (!expirationDate && (expirationSource == null || expirationSource === "")) {
    expirationDate = Math.floor(Date.now() / 1000) + PERSIST_SECONDS;
  }
  const cookie = {
    name,
    value,
    domain,
    hostOnly: !domain.startsWith("."),
    path: cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`,
    secure: record.secure == null ? true : Boolean(record.secure),
    httpOnly: Boolean(record.httpOnly ?? record.httponly),
    session: !expirationDate,
    sameSite: normalizeSameSite(record.sameSite ?? record.samesite),
  };
  if (expirationDate) cookie.expirationDate = expirationDate;
  Object.defineProperty(cookie, "_explicitExpiration", {
    configurable: true,
    enumerable: false,
    value: explicitExpiration,
    writable: true,
  });
  return cookie;
}

function parseCookieHeader(value, defaultDomain = DEFAULT_DOMAIN) {
  const header = stripBom(value).trim().replace(/^cookie\s*:\s*/i, "");
  if (!header) return [];
  const records = [];
  const indexes = new Map();
  for (const segment of header.split(/;|\r?\n/)) {
    const part = segment.trim();
    if (!part || !part.includes("=")) continue;
    const splitAt = part.indexOf("=");
    const name = part.slice(0, splitAt).trim();
    const lowerName = name.toLowerCase();
    if (!validCookieName(name) || COOKIE_ATTRIBUTES.has(lowerName)) continue;
    const cookie = normalizeCookieRecord(
      { name, value: part.slice(splitAt + 1).trim(), domain: defaultDomain },
      defaultDomain
    );
    if (!cookie) continue;
    const key = `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
    if (indexes.has(key)) records[indexes.get(key)] = cookie;
    else {
      indexes.set(key, records.length);
      records.push(cookie);
    }
  }
  return applySidGuardExpiration(records);
}

function expirationFromSidGuard(value) {
  let decoded = text(value);
  try { decoded = decodeURIComponent(decoded); } catch {}
  const numbers = (decoded.match(/\d{6,13}/g) || []).map(Number).filter(Number.isFinite);
  const now = Math.floor(Date.now() / 1000);
  const limit = now + 400 * 24 * 60 * 60;
  for (const raw of numbers) {
    const seconds = raw > 100000000000 ? Math.floor(raw / 1000) : raw;
    if (seconds > now + 60 && seconds <= limit) return seconds;
  }
  for (let index = 0; index < numbers.length - 1; index += 1) {
    const issuedAt = numbers[index] > 100000000000 ? Math.floor(numbers[index] / 1000) : numbers[index];
    const lifetime = numbers[index + 1];
    const expires = issuedAt + lifetime;
    if (issuedAt > 1500000000 && lifetime > 3600 && expires > now + 60 && expires <= limit) return expires;
  }
  return 0;
}

function applySidGuardExpiration(cookies) {
  const records = Array.isArray(cookies) ? cookies : [];
  const guard = records.find((cookie) => cookie.name.toLowerCase() === "sid_guard");
  const guardExpiration = expirationFromSidGuard(guard?.value);
  if (!guardExpiration) return records;
  for (const cookie of records) {
    if (cookie._explicitExpiration) continue;
    cookie.expirationDate = guardExpiration;
    cookie.session = false;
  }
  return records;
}

function cookieMapToRecords(value) {
  if (!isObject(value)) return [];
  return Object.entries(value).map(([name, cookieValue]) =>
    normalizeCookieRecord({ name, value: cookieValue, domain: DEFAULT_DOMAIN })
  ).filter(Boolean);
}

function mergeCookies(...groups) {
  const merged = [];
  const indexes = new Map();
  for (const group of groups) {
    for (const cookie of group || []) {
      if (!cookie) continue;
      const key = `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
      if (indexes.has(key)) merged[indexes.get(key)] = cookie;
      else {
        indexes.set(key, merged.length);
        merged.push(cookie);
      }
    }
  }
  return merged;
}

function hasAuthCookie(cookies) {
  return cookies.some((cookie) => AUTH_COOKIE_NAMES.has(cookie.name.toLowerCase()) && cookie.value);
}

function looksLikeCookieRecord(value) {
  return isObject(value) && text(value.name ?? value.key) && value.value != null;
}

function cookiesFromItem(item) {
  if (typeof item === "string") return parseCookieHeader(item);
  if (!isObject(item)) return [];
  const cookieField = item.cookies ?? item.cookieList ?? item.cookie_list;
  let structured = [];
  if (Array.isArray(cookieField)) {
    structured = cookieField.map((cookie) => normalizeCookieRecord(cookie)).filter(Boolean);
  } else if (isObject(cookieField)) {
    structured = cookieMapToRecords(cookieField);
  }
  const header = [
    item.cookieHeader,
    item.cookie_header,
    item.cookie,
    item.rawCookie,
    item.raw_cookie,
  ].map(text).find(Boolean);
  const fromHeader = header ? parseCookieHeader(header) : [];
  const scalarSession = text(item.sessionid ?? item.session_id);
  const scalarCookies = scalarSession ? [
    normalizeCookieRecord({ name: "sessionid", value: scalarSession }),
    normalizeCookieRecord({ name: "sessionid_ss", value: scalarSession }),
    normalizeCookieRecord({ name: "sid_tt", value: text(item.sid_tt) || scalarSession }),
  ] : [];
  return applySidGuardExpiration(mergeCookies(fromHeader, structured, scalarCookies));
}

function displayName(item, index, explicitName = "") {
  const source = isObject(item) ? item : {};
  return text(
    explicitName || source.accountName || source.account_name || source.name ||
    source.phone || source.user_id || source.userId || source.id
  ) || `Dola ${String(index + 1).padStart(3, "0")}`;
}

function accountRemark(item) {
  if (!isObject(item)) return "Imported from Dola register";
  const parts = [];
  const sourceId = text(item.accountId ?? item.account_id ?? item.id);
  const phone = text(item.phone);
  const userId = text(item.user_id ?? item.userId);
  const note = text(item.note ?? item.remark);
  if (sourceId) parts.push(`source_id=${sourceId}`);
  if (phone) parts.push(`phone=${phone}`);
  if (userId) parts.push(`user_id=${userId}`);
  if (note) parts.push(note);
  return parts.join("; ").slice(0, 500) || "Imported from Dola register";
}

function accountFromItem(item, index, explicitName = "") {
  const cookies = cookiesFromItem(item);
  if (!hasAuthCookie(cookies)) return null;
  const source = isObject(item) ? item : {};
  const hasExplicitName = Boolean(text(
    explicitName || source.accountName || source.account_name || source.name ||
    source.phone || source.user_id || source.userId || source.id
  ));
  return {
    name: displayName(item, index, explicitName),
    nameGenerated: !hasExplicitName,
    remark: remarkWithCookieIdentity(accountRemark(item), cookies),
    createdAt: isObject(item) ? text(item.createdAt ?? item.created_at) : "",
    cookies,
  };
}

function unwrapJsonItems(value) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of ["accounts", "pool", "items", "results", "data"]) {
    if (Array.isArray(value[key])) return value[key];
    if (isObject(value[key]) && Array.isArray(value[key].accounts)) return value[key].accounts;
  }
  return [];
}

function parseJsonExport(value) {
  if (isObject(value) && (
    value.format === "doubao-manager-backup" ||
    (isObject(value.sessions) && Array.isArray(value.accounts))
  )) return null;

  if (Array.isArray(value) && value.length && value.every(looksLikeCookieRecord)) {
    const cookies = applySidGuardExpiration(value.map((cookie) => normalizeCookieRecord(cookie)).filter(Boolean));
    return hasAuthCookie(cookies) ? [{
      name: "Dola 001",
      nameGenerated: true,
      remark: "Imported from Dola browser cookies",
      createdAt: "",
      cookies,
    }] : [];
  }

  let items = unwrapJsonItems(value);
  if (!items.length && (typeof value === "string" || isObject(value))) items = [value];
  if (!items.length && isObject(value)) {
    items = Object.entries(value)
      .filter(([, cookieValue]) => typeof cookieValue === "string")
      .map(([name, cookie]) => ({ name, cookie }));
  }

  const accounts = [];
  for (const item of items) {
    const account = accountFromItem(item, accounts.length);
    if (account) accounts.push(account);
  }
  return accounts;
}

function splitExplicitName(line) {
  for (const delimiter of ["||||", "::::", "\t", "|"]) {
    const at = line.indexOf(delimiter);
    if (at <= 0) continue;
    const possibleName = line.slice(0, at).trim();
    const possibleCookie = line.slice(at + delimiter.length).trim();
    if (!possibleName.includes("=") && hasAuthCookie(parseCookieHeader(possibleCookie))) {
      return { name: possibleName, cookie: possibleCookie };
    }
  }
  return { name: "", cookie: line };
}

function parseTextExport(raw) {
  const clean = stripBom(raw).trim();
  if (!clean) return [];
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    line && !line.startsWith("#") && !line.startsWith("//")
  );
  if (!lines.length) return [];

  const singlePairs = lines.every((line) => !line.includes(";") && line.includes("="));
  if (singlePairs) {
    const cookies = parseCookieHeader(lines.join("\n"));
    if (hasAuthCookie(cookies)) return [{
      name: "Dola 001",
      nameGenerated: true,
      remark: "Imported from Dola register",
      createdAt: "",
      cookies,
    }];
  }

  const accounts = [];
  for (const line of lines) {
    if (/^[{[]/.test(line)) {
      try {
        const parsed = parseJsonExport(JSON.parse(line));
        if (parsed) accounts.push(...parsed);
        continue;
      } catch {}
    }
    const named = splitExplicitName(line);
    const account = accountFromItem(named.cookie, accounts.length, named.name);
    if (account) accounts.push(account);
  }
  return accounts;
}

function deduplicateAccounts(accounts) {
  const indexes = new Map();
  const output = [];
  for (const account of accounts) {
    const identities = Array.from(remarkIdentities(account.remark));
    const explicitIdentity = ["source_id:", "user_id:", "phone:"]
      .map((prefix) => identities.find((identity) => identity.startsWith(prefix)))
      .find(Boolean);
    const uidIdentity = cookieIdentity(account.cookies);
    const authSignature = account.cookies
      .filter((cookie) => AUTH_COOKIE_NAMES.has(cookie.name.toLowerCase()))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .sort()
      .join(";");
    const signature = explicitIdentity
      ? `explicit:${explicitIdentity}`
      : uidIdentity
        ? `uid:${uidIdentity}`
        : authSignature
          ? `auth:${authSignature}`
          : "";
    if (!signature) continue;
    if (indexes.has(signature)) output[indexes.get(signature)] = account;
    else {
      indexes.set(signature, output.length);
      output.push(account);
    }
  }
  return output;
}

function parseDolaExport(raw) {
  const clean = stripBom(raw).trim();
  if (!clean) return [];
  if (/^[{[]/.test(clean)) {
    try {
      const parsed = parseJsonExport(JSON.parse(clean));
      if (parsed === null) return null;
      return deduplicateAccounts(parsed);
    } catch {}
  }
  return deduplicateAccounts(parseTextExport(clean));
}

function validDate(value, fallback) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function normalizedAccountName(value) {
  return text(value).toLowerCase().replace(/\s+/g, " ");
}

function cookieIdentity(cookies) {
  for (const name of ["uid_tt", "uid_tt_ss"]) {
    const cookie = (cookies || []).find((item) => item.name.toLowerCase() === name && item.value);
    if (cookie) return crypto.createHash("sha256").update(cookie.value).digest("hex");
  }
  return "";
}

function remarkIdentityPairs(value) {
  const identities = [];
  for (const match of text(value).matchAll(
    /(?:^|;\s*)(source_id|phone|user_id|dola_uid|dola_uid_sha256)=([^;]+)/gi
  )) {
    const key = match[1].toLowerCase();
    const identityValue = match[2].trim();
    identities.push({ key, value: identityValue, normalized: `${key}:${identityValue.toLowerCase()}` });
  }
  return identities;
}

function remarkIdentities(value) {
  return new Set(remarkIdentityPairs(value).map((identity) => identity.normalized));
}

function cookieIdentitiesMatch(left, right) {
  const first = text(left).toLowerCase();
  const second = text(right).toLowerCase();
  if (!first || !second || Math.min(first.length, second.length) < 16) return false;
  return first.startsWith(second) || second.startsWith(first);
}

function remarkMatchesCookieIdentity(value, identity) {
  return remarkIdentityPairs(value).some((candidate) =>
    (candidate.key === "dola_uid" || candidate.key === "dola_uid_sha256") &&
    cookieIdentitiesMatch(candidate.value, identity)
  );
}

function withoutUidIdentityMarkers(value) {
  return text(value)
    .replace(/(?:^|;\s*)dola_uid(?:_sha256)?=[^;]*/gi, "")
    .replace(/^[;\s]+|[;\s]+$/g, "") || "Imported from Dola register";
}

function remarkWithCookieIdentity(value, cookies) {
  const original = text(value) || "Imported from Dola register";
  const identity = cookieIdentity(cookies);
  if (!identity) return original.slice(0, MAX_REMARK_LENGTH);
  const base = withoutUidIdentityMarkers(original);
  const token = `dola_uid=${identity.slice(0, 32)}`;
  const maxBaseLength = Math.max(0, MAX_REMARK_LENGTH - token.length - 2);
  const trimmedBase = base.slice(0, maxBaseLength).replace(/[;\s]+$/, "");
  return trimmedBase ? `${trimmedBase}; ${token}` : token;
}

function mergeRemarkIdentityMarkers(existingRemark, sourceRemark, cookies) {
  const base = withoutUidIdentityMarkers(existingRemark);
  const source = remarkWithCookieIdentity(sourceRemark, cookies);
  const existing = remarkIdentities(base);
  const additions = remarkIdentityPairs(source)
    .filter((identity) => !existing.has(identity.normalized))
    .map((identity) => `${identity.key}=${identity.value}`);
  if (!additions.length) return base.slice(0, MAX_REMARK_LENGTH);
  const suffix = additions.join("; ");
  const maxBaseLength = Math.max(0, MAX_REMARK_LENGTH - suffix.length - 2);
  const trimmedBase = base.slice(0, maxBaseLength).replace(/[;\s]+$/, "");
  return trimmedBase ? `${trimmedBase}; ${suffix}` : suffix.slice(0, MAX_REMARK_LENGTH);
}

function matchExistingAccount(source, existingAccounts, usedIds) {
  const candidates = (existingAccounts || []).filter((account) =>
    account && account.id && account.platform === "dola" && !usedIds.has(account.id)
  );
  const sourceCookieIdentity = cookieIdentity(source.cookies);
  if (sourceCookieIdentity) {
    const byCookie = candidates.find((account) =>
      cookieIdentitiesMatch(account.cookieIdentity, sourceCookieIdentity) ||
      remarkMatchesCookieIdentity(account.remark, sourceCookieIdentity)
    );
    if (byCookie) return byCookie;
  }
  const sourceRemarkIdentities = remarkIdentities(source.remark);
  if (sourceRemarkIdentities.size) {
    const byRemark = candidates.find((account) => {
      const existing = remarkIdentities(account.remark);
      return Array.from(sourceRemarkIdentities).some((identity) => existing.has(identity));
    });
    if (byRemark) return byRemark;
  }
  const name = normalizedAccountName(source.name);
  if (!name || source.nameGenerated || /^dola \d+$/i.test(name)) return null;
  const matchingNames = candidates.filter((account) => normalizedAccountName(account.name) === name);
  return matchingNames.length === 1 ? matchingNames[0] : null;
}

function createNativeBackup(accounts, now = new Date().toISOString(), options = {}) {
  const existingAccounts = Array.isArray(options.existingAccounts) ? options.existingAccounts : [];
  const existingFingerprints = isObject(options.existingFingerprints) ? options.existingFingerprints : {};
  const usedIds = new Set();
  const backup = {
    format: "doubao-manager-backup",
    version: 3,
    exportedAt: now,
    warning: "This file contains authentication cookies and browser identity seeds. Keep it private.",
    accounts: [],
    sessions: {},
    fingerprints: {},
  };
  const plan = [];
  for (const source of accounts) {
    const sourceRemark = remarkWithCookieIdentity(source.remark, source.cookies);
    const sourceForMatch = { ...source, remark: sourceRemark };
    const existing = matchExistingAccount(sourceForMatch, existingAccounts, usedIds);
    const id = existing?.id || crypto.randomUUID();
    usedIds.add(id);
    const createdAt = validDate(existing?.createdAt || source.createdAt, now);
    if (!existing) {
      backup.accounts.push({
        id,
        platform: "dola",
        name: source.name,
        url: DEFAULT_URL,
        group: "Dola register",
        remark: sourceRemark,
        createdAt,
      });
      backup.sessions[id] = { cookies: source.cookies, localStorage: [] };
      backup.fingerprints[id] = isObject(existingFingerprints[id])
        ? existingFingerprints[id]
        : { version: 1, seed: crypto.randomBytes(32).toString("hex"), createdAt };
    }
    plan.push({
      id,
      existing: Boolean(existing),
      existingAccount: existing || null,
      name: source.name,
      remark: sourceRemark,
      nameGenerated: Boolean(source.nameGenerated),
      cookies: source.cookies,
    });
  }
  return { backup, plan };
}

function buildNativeBackup(accounts, now = new Date().toISOString(), options = {}) {
  return createNativeBackup(accounts, now, options).backup;
}

async function prepareImportFile(filePath, options = {}) {
  const absolutePath = path.resolve(String(filePath || ""));
  if (!absolutePath || !fs.existsSync(absolutePath)) throw new Error("Import file does not exist");
  if (path.extname(absolutePath).toLowerCase() === ".dbmbackup") {
    return { path: absolutePath, converted: false, count: 0, plan: [], cleanup: async () => {} };
  }
  const raw = await fs.promises.readFile(absolutePath, "utf8");
  const accounts = parseDolaExport(raw);
  if (accounts === null) {
    return { path: absolutePath, converted: false, count: 0, plan: [], cleanup: async () => {} };
  }
  if (!accounts.length) {
    return { path: absolutePath, converted: false, count: 0, plan: [], cleanup: async () => {} };
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dbm-dola-import-"));
  const preparedPath = path.join(tempDir, "dola-register.dbmbackup");
  const prepared = createNativeBackup(accounts, new Date().toISOString(), options);
  await fs.promises.writeFile(
    preparedPath,
    JSON.stringify(prepared.backup, null, 2),
    "utf8"
  );
  return {
    path: preparedPath,
    converted: true,
    count: accounts.length,
    nativeCount: prepared.backup.accounts.length,
    plan: prepared.plan,
    cleanup: () => fs.promises.rm(tempDir, { recursive: true, force: true }),
  };
}

function relevantCookieDomain(value) {
  return /(^|\.)(dola|doubao|ciciai)\.com$/i.test(text(value).replace(/^\./, ""));
}

function relevantCookieFamily(value) {
  const match = text(value).replace(/^\./, "").toLowerCase()
    .match(/(?:^|\.)((?:dola|doubao|ciciai)\.com)$/i);
  return match?.[1] || "";
}

function credentialCookieName(value) {
  const name = text(value).toLowerCase();
  return AUTH_COOKIE_NAMES.has(name) ||
    /^(passport_|sid_|ssid_|d_ticket$|odin_tt$|mstoken$|has_biz_token$|store-)/i.test(name);
}

function cookieUrl(cookie) {
  const domain = text(cookie.domain).replace(/^\./, "") || "dola.com";
  const cookiePath = (text(cookie.path) || "/").replace(/^([^/])/, "/$1");
  return `${cookie.secure === false ? "http" : "https"}://${domain}${cookiePath}`;
}

function cookieSetDetails(cookie, forcePersistent = false) {
  const expirationDate = Number(cookie.expirationDate) > Date.now() / 1000
    ? Number(cookie.expirationDate)
    : Math.floor(Date.now() / 1000) + PERSIST_SECONDS;
  const details = {
    url: cookieUrl(cookie),
    name: text(cookie.name),
    value: cookie.value == null ? "" : String(cookie.value),
    path: text(cookie.path) || "/",
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: normalizeSameSite(cookie.sameSite),
  };
  if (text(cookie.domain)) details.domain = normalizeDomain(cookie.domain);
  if (forcePersistent || !cookie.session || expirationDate) details.expirationDate = expirationDate;
  return details;
}

async function readExistingAccountContext(existingAccounts) {
  const { app, session } = require("electron");
  await app.whenReady();
  const accounts = [];
  for (const account of existingAccounts || []) {
    if (!account?.id || account.platform !== "dola") continue;
    let identity = "";
    try {
      const partition = session.fromPartition(`persist:doubao-manager-${account.id}`);
      identity = cookieIdentity(await partition.cookies.get({ url: DEFAULT_URL }));
    } catch (error) {
      debug(`identity read failed for ${account.id}: ${error.message}`);
    }
    const markedIdentity = remarkIdentityPairs(account.remark)
      .find((candidate) => candidate.key === "dola_uid" || candidate.key === "dola_uid_sha256")
      ?.value.toLowerCase() || "";
    accounts.push({ ...account, cookieIdentity: identity || markedIdentity });
  }
  let fingerprints = {};
  try {
    fingerprints = JSON.parse(await fs.promises.readFile(
      path.join(app.getPath("userData"), "browser-fingerprints.json"),
      "utf8"
    ));
  } catch {}
  return { existingAccounts: accounts, existingFingerprints: fingerprints };
}

function remapNewAccountIds(plan, beforeAccounts, afterAccounts) {
  const beforeIds = new Set((beforeAccounts || []).map((account) => account.id));
  const available = (afterAccounts || []).filter((account) =>
    account?.id && account.platform === "dola" && !beforeIds.has(account.id)
  );
  const used = new Set();
  for (const entry of plan || []) {
    if (entry.existing) continue;
    const candidates = available.filter((account) => !used.has(account.id));
    const name = normalizedAccountName(entry.name);
    const remarkIds = remarkIdentities(entry.remark);
    let matched = candidates.find((account) => normalizedAccountName(account.name) === name);
    if (!matched && remarkIds.size) {
      matched = candidates.find((account) => {
        const existing = remarkIdentities(account.remark);
        return Array.from(remarkIds).some((identity) => existing.has(identity));
      });
    }
    if (!matched && candidates.length === 1) matched = candidates[0];
    if (!matched) continue;
    entry.id = matched.id;
    used.add(matched.id);
  }
  return plan;
}

async function persistExistingIdentityMarkers(event, plan) {
  if (typeof state.updateHandler !== "function") return 0;
  let updated = 0;
  for (const entry of plan || []) {
    const account = entry.existingAccount;
    if (!entry.existing || !account?.id) continue;
    const remark = mergeRemarkIdentityMarkers(account.remark, entry.remark, entry.cookies);
    if (remark === text(account.remark)) continue;
    const result = await state.updateHandler(event, account.id, {
      platform: account.platform,
      name: account.name,
      url: account.url || DEFAULT_URL,
      group: account.group || "",
      remark,
    });
    if (result?.ok === false) {
      throw new Error(result.message || `Failed to save Dola identity marker for ${account.name}`);
    }
    account.remark = remark;
    updated += 1;
  }
  return updated;
}

function watchDolaPartition(accountId) {
  if (!accountId || state.watchedPartitions.has(accountId)) return;
  const { session } = require("electron");
  const partition = session.fromPartition(`persist:doubao-manager-${accountId}`);
  state.watchedPartitions.add(accountId);
  partition.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || !relevantCookieDomain(cookie.domain) || (!cookie.session && cookie.expirationDate)) return;
    enqueuePartitionWrite(accountId, async () => {
      const matching = (await partition.cookies.get({ name: cookie.name })).find((current) =>
        current.domain === cookie.domain &&
        current.path === cookie.path &&
        current.value === cookie.value
      );
      if (!matching || (!matching.session && matching.expirationDate)) return;
      await partition.cookies.set(cookieSetDetails(matching, true));
      await partition.cookies.flushStore();
    }).catch((error) => {
      debug(`cookie persistence failed for ${accountId}/${cookie.name}: ${error.message}`);
    });
  });
}

async function refreshImportedSessions(plan) {
  const { session, webContents } = require("electron");
  const refreshedAccountIds = [];
  let updatedAccounts = 0;
  let addedAccounts = 0;
  for (const entry of plan || []) {
    await enqueuePartitionWrite(entry.id, async () => {
      const partition = session.fromPartition(`persist:doubao-manager-${entry.id}`);
      const currentCookies = await partition.cookies.get({});
      const importedFamilies = new Set((entry.cookies || [])
        .map((cookie) => relevantCookieFamily(cookie.domain))
        .filter(Boolean));
      const currentRelevant = currentCookies.filter((cookie) =>
        importedFamilies.has(relevantCookieFamily(cookie.domain))
      );
      const openViews = webContents.getAllWebContents().filter((contents) =>
        contents.getType() === "webview" && contents.session === partition && !contents.isDestroyed()
      );
      for (const contents of openViews) {
        try { contents.stop(); } catch {}
      }
      const authFailures = [];
      try {
        for (const cookie of currentRelevant) {
          try { await partition.cookies.remove(cookieUrl(cookie), cookie.name); } catch {}
        }
        for (const cookie of entry.cookies || []) {
          try {
            await partition.cookies.set(cookieSetDetails(cookie, true));
          } catch (error) {
            debug(`cookie refresh failed for ${entry.id}/${cookie.name}: ${error.message}`);
            if (credentialCookieName(cookie.name)) authFailures.push(cookie.name);
          }
        }
        if (authFailures.length) {
          throw new Error(`Failed to refresh authentication cookies: ${authFailures.join(", ")}`);
        }
        await partition.cookies.flushStore();
        await partition.clearCache();
      } catch (error) {
        for (const cookie of await partition.cookies.get({})) {
          if (!importedFamilies.has(relevantCookieFamily(cookie.domain))) continue;
          try { await partition.cookies.remove(cookieUrl(cookie), cookie.name); } catch {}
        }
        for (const cookie of currentRelevant) {
          try { await partition.cookies.set(cookieSetDetails(cookie, true)); } catch {}
        }
        await partition.cookies.flushStore();
        for (const contents of openViews) {
          try { contents.reloadIgnoringCache(); } catch {}
        }
        throw error;
      }
      for (const contents of openViews) {
        try {
          contents.reloadIgnoringCache();
        } catch {}
      }
      watchDolaPartition(entry.id);
    });
    refreshedAccountIds.push(entry.id);
    if (entry.existing) updatedAccounts += 1;
    else addedAccounts += 1;
  }
  return { refreshedAccountIds, updatedAccounts, addedAccounts, reloadInMain: true };
}

async function persistExistingDolaCookies() {
  const { app, session } = require("electron");
  await app.whenReady();
  let accounts = [];
  try {
    accounts = JSON.parse(await fs.promises.readFile(path.join(app.getPath("userData"), "accounts.json"), "utf8"));
  } catch {}
  let persisted = 0;
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account?.id || account.platform !== "dola") continue;
    persisted += await enqueuePartitionWrite(account.id, async () => {
      const partition = session.fromPartition(`persist:doubao-manager-${account.id}`);
      watchDolaPartition(account.id);
      const cookies = await partition.cookies.get({});
      let accountPersisted = 0;
      for (const cookie of cookies) {
        if (!relevantCookieDomain(cookie.domain) || (!cookie.session && cookie.expirationDate)) continue;
        try {
          await partition.cookies.set(cookieSetDetails(cookie, true));
          accountPersisted += 1;
        } catch (error) {
          debug(`startup persistence failed for ${account.id}/${cookie.name}: ${error.message}`);
        }
      }
      await partition.cookies.flushStore();
      return accountPersisted;
    });
  }
  debug(`persisted ${persisted} existing Dola session cookies`);
  return persisted;
}

function captureAccountsImport() {
  const { ipcMain } = require("electron");
  if (state.installed) return;
  state.installed = true;
  state.originalHandle = ipcMain.handle;
  ipcMain.handle = function compatibleHandle(channel, listener) {
    const result = state.originalHandle.call(this, channel, listener);
    if (channel === "accounts:import") {
      state.importHandler = listener;
      debug("captured native accounts import handler");
      if (state.registrationRequested) queueMicrotask(installCompatibleHandler);
    } else if (channel === "accounts:list") {
      state.listHandler = listener;
      debug("captured native accounts list handler");
    } else if (channel === "accounts:update") {
      state.updateHandler = listener;
      debug("captured native accounts update handler");
    }
    return result;
  };
}

function enqueue(task) {
  const next = state.queue.then(task, task);
  state.queue = next.catch(() => {});
  return next;
}

async function chooseImportFile(dialog, parentWindow) {
  const configured = text(process.env.DBM_DOLA_IMPORT_PATH || process.env.DBM_E2E_IMPORT_PATH);
  if (configured && fs.existsSync(configured)) return configured;
  const options = {
    title: "Import accounts or Dola cookies",
    properties: ["openFile"],
    filters: [
      { name: "Account and cookie files", extensions: ["dbmbackup", "json", "csv", "txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths?.[0]) return "";
  return result.filePaths[0];
}

function installCompatibleHandler() {
  if (state.registered || typeof state.importHandler !== "function") return false;
  const { BrowserWindow, dialog, ipcMain } = require("electron");
  try { ipcMain.removeHandler(CUSTOM_CHANNEL); } catch {}
  ipcMain.handle(CUSTOM_CHANNEL, (event) => enqueue(async () => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const selectedPath = await chooseImportFile(dialog, parentWindow);
    if (!selectedPath) return { ok: false, canceled: true };
    let existingContext = {};
    let existingSnapshot = [];
    if (path.extname(selectedPath).toLowerCase() !== ".dbmbackup" && typeof state.listHandler === "function") {
      existingSnapshot = await state.listHandler(event);
      existingContext = await readExistingAccountContext(existingSnapshot);
    }
    const prepared = await prepareImportFile(selectedPath, existingContext);
    const previousE2EPath = process.env.DBM_E2E_IMPORT_PATH;
    const originalShowOpenDialog = dialog.showOpenDialog;
    process.env.DBM_E2E_IMPORT_PATH = prepared.path;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [prepared.path] });
    try {
      const result = prepared.converted && prepared.nativeCount === 0
        ? { ok: true, imported: 0, message: `已覆盖刷新 ${prepared.count} 个 Dola 账号 Cookie` }
        : await state.importHandler(event);
      if (isObject(result) && prepared.converted) {
        if (prepared.nativeCount > 0 && typeof state.listHandler === "function") {
          remapNewAccountIds(prepared.plan, existingSnapshot, await state.listHandler(event));
        }
        const identityMarkersUpdated = await persistExistingIdentityMarkers(event, prepared.plan);
        const refreshPlan = result.ok === false
          ? prepared.plan.filter((entry) => entry.existing)
          : prepared.plan;
        const refreshed = await refreshImportedSessions(refreshPlan);
        if (refreshed.refreshedAccountIds.length && !event.sender.isDestroyed()) {
          event.sender.send(REFRESH_CHANNEL, refreshed);
        }
        return {
          ...result,
          ...refreshed,
          identityMarkersUpdated,
          sourceFormat: "dola-register",
          sourceAccounts: prepared.count,
        };
      }
      return result;
    } finally {
      dialog.showOpenDialog = originalShowOpenDialog;
      if (previousE2EPath == null) delete process.env.DBM_E2E_IMPORT_PATH;
      else process.env.DBM_E2E_IMPORT_PATH = previousE2EPath;
      await prepared.cleanup();
    }
  }));
  state.registered = true;
  debug("compatible import handler installed");
  return true;
}

function registerCompatibleImport() {
  state.registrationRequested = true;
  if (!installCompatibleHandler()) debug("waiting for native accounts import handler");
}

module.exports = {
  buildNativeBackup,
  captureAccountsImport,
  parseCookieHeader,
  parseDolaExport,
  persistExistingDolaCookies,
  prepareImportFile,
  registerCompatibleImport,
};
