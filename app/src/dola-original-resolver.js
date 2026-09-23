'use strict';
// Original-source resolver shared with 澜川 dola-112-core.js (2026-09-07).
const videoQuality=require('./video-quality'),crypto=require('node:crypto').webcrypto;
const DOLA_NO_WATERMARK_LR='unwatermarked';
const QAAB_SALT_HEX = "4dd4c2e6b83162090e52b3c7a6733ba4"
  + "1cb2462b829ab58a196b39db57177524"
  + "f49baf7f08e8d68d26a72e37c1a95a2f"
  + "1f05a51892aef2949732b62a38aadd58";
async function getDolaVideoUrlFromFallbackApi(fallbackApi, fetchImpl = globalThis.fetch) {
  if (!isOfficialDolaFallbackApi(fallbackApi)) {
    return "";
  }
  if (typeof fetchImpl !== "function") {
    return "";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    // codec_type=0 is the H.264 source returned by Dola's official fallback
    // endpoint. It matched the downloaded MP4 byte size, duration and bitrate
    // in the live acceptance sample; do not substitute the Doubao codec value.
    const url = replaceQueryParams(fallbackApi, {
      codec_type: "0",
      logo_type: DOLA_NO_WATERMARK_LR
    });
    const response = await fetchImpl(url, {
      method: "GET",
      credentials: "omit",
      headers: {
        "accept": "application/json,text/plain,*/*"
      },
      signal: controller.signal
    });
    if (response?.ok === false) {
      return "";
    }

    const payload = await response.json();
    const keySeed = findKeySeedDeep(payload)
      || findKeySeedDeep(url)
      || findKeySeedDeep(fallbackApi);
    for (const token of pickVideoUrlTokens(getVideoData(payload))) {
      const directUrl = await decodeMainUrl(token, keySeed);
      const acceptedUrl = normalizeOfficialDolaVideoUrl(directUrl);
      if (acceptedUrl) {
        return acceptedUrl;
      }
    }
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  return "";
}

function isOfficialDolaFallbackApi(value) {
  if (!isHttpUrl(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username && !parsed.password && (!parsed.port || parsed.port === "443")
      && /(?:^|\.)byteintlapi\.com$/i.test(parsed.hostname)
      && /^\/video\/fplay(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function pickVideoUrlTokens(data) {
  const entries = data?.video_list && typeof data.video_list === 'object' && Object.keys(data.video_list).length ? Object.values(data.video_list) : [data];
  return videoQuality.sorted(entries).flatMap(entry => {
    const keys = ['main_url', 'play_url', ...Object.keys(entry).filter(key => /^(?:backup|back)_url(?:_\d+)?$/i.test(key))];
    return [...new Set(keys.map(key => entry[key]).filter(token => typeof token === 'string' && token.trim()).map(token => token.trim()))];
  });
}

function normalizeOfficialDolaVideoUrl(value) {
  if (!isHttpUrl(value) || /\.(?:png|jpe?g|webp|gif)(?:$|[?])/i.test(value)) {
    return "";
  }
  try {
    const parsed = new URL(value);
    const lr = (parsed.searchParams.get("lr") || "").trim().toLowerCase();
    return /^(?:http|https):$/.test(parsed.protocol)
      && !parsed.username && !parsed.password
      && /(?:^|\.)dola\.com$/i.test(parsed.hostname)
      && lr === DOLA_NO_WATERMARK_LR
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

function replaceQueryParams(url, params) {
  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsedUrl.searchParams.set(key, value);
  }
  return parsedUrl.toString();
}

function getVideoData(payload) {
  const videoInfo = payload?.video_info || payload?.data?.video_info || payload;
  const data = videoInfo?.data || videoInfo;
  return data && typeof data === "object" ? data : {};
}

function pickMainUrlToken(data) {
  const entries = data?.video_list && typeof data.video_list === 'object' && Object.keys(data.video_list).length ? Object.values(data.video_list) : [data];
  const best = videoQuality.sorted(entries.filter(entry => typeof (entry?.main_url || entry?.play_url) === 'string' && (entry.main_url || entry.play_url).trim()))[0];
  return (best?.main_url || best?.play_url || '').trim();
}

function findKeySeedDeep(value, depth = 0) {
  if (depth > 10 || value == null) {
    return "";
  }

  if (typeof value === "string") {
    let match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
    if (match) {
      return decodeURIComponent(match[1]);
    }
    match = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  if (typeof value !== "object") {
    return "";
  }

  if (typeof value.key_seed === "string" && value.key_seed.trim()) {
    return value.key_seed.trim();
  }

  for (const item of Object.values(value)) {
    const hit = findKeySeedDeep(item, depth + 1);
    if (hit) {
      return hit;
    }
  }

  return "";
}

async function decodeMainUrl(token, keySeed = "") {
  if (isHttpUrl(token)) {
    return token;
  }

  const plainUrl = tryDecodeBase64Url(token);
  if (plainUrl) {
    return plainUrl;
  }

  if (token.startsWith("qAAB") && keySeed) {
    return await decodeQaabToken(token, keySeed);
  }

  return "";
}

function tryDecodeBase64Url(token) {
  const bytes = base64DecodeLoose(token);
  if (!bytes) {
    return "";
  }
  const text = asciiUrlFromBytes(bytes);
  return isHttpUrl(text) ? text : "";
}

function base64DecodeLoose(text) {
  const input = String(text || "").trim();
  const variants = [
    input,
    input.replace(/[$@#]/g, (char) => ({ "$": "_", "@": "/", "#": "." }[char])),
    input.replace(/[$@#]/g, (char) => ({ "$": "+", "@": "/", "#": "=" }[char]))
  ];
  const seen = new Set();

  for (const candidate of variants) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      const normalized = padBase64(candidate).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    } catch {
      // Try the next variant.
    }
  }

  return null;
}

function padBase64(text) {
  const pad = (4 - (text.length % 4)) % 4;
  return text + "=".repeat(pad);
}

function asciiUrlFromBytes(bytes) {
  if (!bytes || !bytes.length) {
    return "";
  }
  for (const byte of bytes) {
    if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) {
      return "";
    }
  }
  return new TextDecoder().decode(bytes);
}

async function decodeQaabToken(token, keySeed) {
  const data = base64DecodeLoose(token);
  const seed = base64DecodeLoose(keySeed);
  if (!data || !seed) {
    return "";
  }

  const digest1 = await crypto.subtle.digest("SHA-512", seed.slice(0, 32));
  const salt = hexToBytes(QAAB_SALT_HEX);
  const digest2Input = concatBytes(new Uint8Array(digest1), salt);
  const digest2 = new Uint8Array(await crypto.subtle.digest("SHA-512", digest2Input));
  const key = digest2.slice(0, 16);
  const iv = digest2.slice(16, 32);
  const attempts = [];

  if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
    attempts.push({ payload: data.slice(4), key, iv });
    attempts.push({ payload: data.slice(4), key: iv, iv: key });
    if (data.length > 36) {
      attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
      attempts.push({ payload: data.slice(36), key, iv });
    }
  } else {
    attempts.push({ payload: data, key, iv });
  }

  for (const attempt of attempts) {
    const url = await decryptAesCbcUrl(attempt.payload, attempt.key, attempt.iv);
    if (url) {
      return url;
    }
  }

  return "";
}

async function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
  if (!payload.length || payload.length % 16 !== 0) {
    return "";
  }

  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, key, payload));
    const direct = asciiUrlFromBytes(plain);
    if (isHttpUrl(direct)) {
      return direct;
    }
    const stripped = stripPkcs7(plain);
    const url = asciiUrlFromBytes(stripped);
    return isHttpUrl(url) ? url : "";
  } catch {
    return "";
  }
}

function stripPkcs7(bytes) {
  if (!bytes || !bytes.length) {
    return new Uint8Array();
  }
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16 || pad > bytes.length) {
    return bytes;
  }
  for (let index = bytes.length - pad; index < bytes.length; index += 1) {
    if (bytes[index] !== pad) {
      return bytes;
    }
  }
  return bytes.slice(0, bytes.length - pad);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concatBytes(first, second) {
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first, 0);
  bytes.set(second, first.length);
  return bytes;
}


function isHttpUrl(url){return typeof url==='string' && url.length<16000 && /^https?:\/\//i.test(url);}
module.exports={getDolaVideoUrlFromFallbackApi,isOfficialDolaFallbackApi,normalizeOfficialDolaVideoUrl,decodeMainUrl};
