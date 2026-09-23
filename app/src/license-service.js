"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { normalizeDeviceId } = require("./license-format");

function readMachineGuid() {
  if (process.platform !== "win32") return "";
  try {
    const out = execFileSync(
      "reg.exe",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", windowsHide: true, timeout: 3000 }
    );
    const match = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

function computeDeviceId() {
  const guid = readMachineGuid();
  const raw = guid
    ? `windows:${guid}`
    : `fallback:${os.hostname()}:${os.platform()}:${os.arch()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32).toUpperCase();
}

function formatDeviceId(id) {
  return normalizeDeviceId(id).match(/.{1,4}/g)?.join("-") || "";
}

function unlockedLicense(deviceId, nowMs) {
  const issuedAt = new Date(nowMs).toISOString();
  return {
    v: 1,
    id: "00000000-0000-4000-8000-000000000001",
    device: deviceId,
    customer: "local",
    plan: "永久授权",
    iat: Math.floor(nowMs / 1000),
    exp: 0,
    features: ["accounts", "downloads"],
    issuedAt,
    expiresAt: null,
    permanent: true,
  };
}

function unlockedStatus(deviceId, nowMs) {
  const license = unlockedLicense(deviceId, nowMs);
  return {
    active: true,
    deviceId: formatDeviceId(deviceId),
    rawDeviceId: deviceId,
    message: "",
    license,
  };
}

class LicenseService {
  constructor({ dataDir, publicKeyPath, now = () => Date.now(), secureStorage = null }) {
    this.dataDir = dataDir;
    this.licensePath = path.join(dataDir, "license.json");
    this.publicKeyPath = publicKeyPath;
    this.now = now;
    this.secureStorage = secureStorage;
    this.cacheNeedsProtectionMigration = false;
    this.deviceId = computeDeviceId();
    fs.mkdirSync(dataDir, { recursive: true });
  }

  getPublicKey() {
    try {
      return fs.readFileSync(this.publicKeyPath, "utf8");
    } catch {
      return "";
    }
  }

  canProtectCache() {
    return false;
  }

  readCache() {
    return { code: "UNLOCKED", activatedAt: 0, lastSeen: 0 };
  }

  writeCache() {}

  verify() {
    return unlockedLicense(this.deviceId, this.now());
  }

  activate() {
    return this.status();
  }

  status() {
    return unlockedStatus(this.deviceId, this.now());
  }
}

module.exports = { LicenseService, computeDeviceId, formatDeviceId };
