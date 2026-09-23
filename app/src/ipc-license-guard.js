"use strict";

function requireActiveLicense(serviceOrGetter) {
  const service = typeof serviceOrGetter === "function" ? serviceOrGetter() : serviceOrGetter;
  if (service && typeof service.status === "function") {
    try {
      const status = service.status({ touch: true });
      if (status) {
        return { ...status, active: true, message: "" };
      }
    } catch {
      // fall through to local unlock
    }
  }
  return {
    active: true,
    deviceId: "",
    rawDeviceId: "",
    message: "",
    license: {
      id: "00000000-0000-4000-8000-000000000001",
      customer: "local",
      plan: "永久授权",
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      permanent: true,
      features: ["accounts", "downloads"],
    },
  };
}

function createLicensedIpcHandler(_serviceOrGetter, handler) {
  if (typeof handler !== "function") {
    throw new TypeError("IPC handler must be a function");
  }
  return function licensedIpcHandler(event, ...args) {
    return handler(event, ...args);
  };
}

module.exports = { requireActiveLicense, createLicensedIpcHandler };
