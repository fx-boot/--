'use strict';

// Local no-auth SOCKS5 frontends that chain:
//   window session -> 127.0.0.1:port -> parent rule proxy (7897, SOCKS5 or HTTP CONNECT)
//   -> remote authenticated SOCKS5 (IPWeb gate) -> target
// Ported from Dola号池注册台 proxy_chain.py.

const net = require('node:net');
const tls = require('node:tls');

const DEFAULT_PARENT = '127.0.0.1:7897';

class ProxyChainError extends Error { }
class SocksAuthError extends Error { }
class SocksConnectError extends Error { }

function parseParent(parent) {
  const value = String(parent || DEFAULT_PARENT).trim() || DEFAULT_PARENT;
  if (value.includes('://')) {
    try {
      const u = new URL(value);
      return { host: u.hostname || '127.0.0.1', port: Number(u.port) || 7897 };
    } catch (_) { /* fall through */ }
  }
  const idx = value.lastIndexOf(':');
  if (idx > 0) return { host: value.slice(0, idx) || '127.0.0.1', port: Number(value.slice(idx + 1)) || 7897 };
  return { host: value, port: 7897 };
}

function parseProxyLine(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      if (!u.hostname || !u.port) return null;
      return {
        host: u.hostname,
        port: Number(u.port),
        user: decodeURIComponent(u.username || ''),
        pass: decodeURIComponent(u.password || '')
      };
    } catch (_) { return null; }
  }
  const parts = s.split(':');
  if (parts.length >= 4) {
    const port = Number(parts[1]);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { host: parts[0], port, user: parts[2], pass: parts.slice(3).join(':') };
  }
  if (parts.length === 2) {
    const port = Number(parts[1]);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { host: parts[0], port, user: '', pass: '' };
  }
  return null;
}

function maskProxyLine(line) {
  const r = parseProxyLine(line);
  if (!r) return '';
  const user = r.user ? `${r.user.slice(0, 18)}${r.user.length > 18 ? '…' : ''}:***@` : '';
  return `socks5://${user}${r.host}:${r.port}`;
}

// Buffered reader over a socket for handshake phases.
class SockReader {
  constructor(sock) {
    this.buf = Buffer.alloc(0);
    this.err = null;
    this.closed = false;
    this.waiters = [];
    sock.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this._drain();
    });
    sock.on('error', (err) => { this.err = err; this._drain(); });
    sock.on('close', () => { this.closed = true; this._drain(); });
  }

  _drain() {
    if (!this.waiters.length) return;
    const pending = [];
    for (const w of this.waiters) {
      if (w.settled) continue;
      if (this.err) { w.settled = true; clearTimeout(w.timer); w.reject(this.err); continue; }
      if (this.buf.length >= w.n) {
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        w.settled = true; clearTimeout(w.timer); w.resolve(out);
        continue;
      }
      if (this.closed) { w.settled = true; clearTimeout(w.timer); w.reject(new Error('socket closed while reading')); continue; }
      pending.push(w);
    }
    this.waiters = pending;
  }

  read(n, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const w = { n, resolve, reject, settled: false, timer: null };
      w.timer = setTimeout(() => {
        if (w.settled) return;
        w.settled = true;
        this.waiters = this.waiters.filter((item) => item !== w);
        reject(new Error(`read timeout (${n}B)`));
      }, timeoutMs);
      this.waiters.push(w);
      this._drain();
    });
  }
}

function connectTcp(host, port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect ${host}:${port} timeout`));
    }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// SOCKS5 no-auth connect through parent (Clash mixed port).
async function socks5ParentConnect(parentHost, parentPort, targetHost, targetPort, timeoutMs = 20000) {
  const sock = await connectTcp(parentHost, parentPort, timeoutMs);
  try {
    const reader = new SockReader(sock);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    const greet = await reader.read(2, timeoutMs);
    if (greet[0] !== 0x05 || greet[1] !== 0x00) throw new Error(`parent SOCKS greet rejected: ${greet.toString('hex')}`);
    const dest = Buffer.from(targetHost, 'utf8');
    if (dest.length > 255) throw new Error('target host too long for SOCKS5');
    const head = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, dest.length]), dest, Buffer.alloc(2)]);
    head.writeUInt16BE(targetPort, head.length - 2);
    sock.write(head);
    const rep = await reader.read(4, timeoutMs);
    if (rep[0] !== 0x05 || rep[1] !== 0x00) throw new Error(`parent SOCKS connect failed rep=${rep[1]}`);
    const atyp = rep[3];
    if (atyp === 1) await reader.read(6, timeoutMs);
    else if (atyp === 3) { const ln = (await reader.read(1, timeoutMs))[0]; await reader.read(ln + 2, timeoutMs); }
    else if (atyp === 4) await reader.read(18, timeoutMs);
    else throw new Error(`parent SOCKS unknown atyp=${atyp}`);
    return sock;
  } catch (err) {
    sock.destroy();
    throw err;
  }
}

// HTTP CONNECT through parent.
async function httpParentConnect(parentHost, parentPort, targetHost, targetPort, timeoutMs = 20000) {
  const sock = await connectTcp(parentHost, parentPort, timeoutMs);
  try {
    const req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`;
    sock.write(req, 'ascii');
    let data = Buffer.alloc(0);
    const deadline = Date.now() + timeoutMs;
    while (!data.includes('\r\n\r\n')) {
      if (Date.now() > deadline) throw new Error('CONNECT response timeout');
      const chunk = await new Promise((resolve, reject) => {
        sock.once('data', resolve);
        sock.once('error', reject);
        setTimeout(() => reject(new Error('CONNECT read timeout')), Math.max(1, deadline - Date.now()));
      });
      data = Buffer.concat([data, chunk]);
      if (data.length > 16384) break;
    }
    const status = data.subarray(0, data.indexOf('\r\n')).toString('ascii');
    if (!status.includes(' 200')) throw new Error(`CONNECT failed: ${status}`);
    return sock;
  } catch (err) {
    sock.destroy();
    throw err;
  }
}

async function parentTunnel(parentHost, parentPort, targetHost, targetPort, timeoutMs = 20000) {
  const errors = [];
  try {
    return await socks5ParentConnect(parentHost, parentPort, targetHost, targetPort, timeoutMs);
  } catch (err) { errors.push(`socks5=${err.message}`); }
  try {
    return await httpParentConnect(parentHost, parentPort, targetHost, targetPort, timeoutMs);
  } catch (err) { errors.push(`http=${err.message}`); }
  throw new ProxyChainError(`parent tunnel ${parentHost}:${parentPort} -> ${targetHost}:${targetPort} failed (${errors.join('; ')})`);
}

// Authenticate against remote SOCKS5 and CONNECT to dest through it.
async function socks5AuthConnect(sock, user, pass, destHost, destPort, timeoutMs = 20000) {
  const reader = new SockReader(sock);
  sock.write(Buffer.from([0x05, 0x01, 0x02]));
  const greet = await reader.read(2, timeoutMs);
  if (greet[0] !== 0x05 || greet[1] !== 0x02) throw new SocksConnectError(`SOCKS greet rejected: ${greet.toString('hex')}`);
  const ub = Buffer.from(String(user || ''), 'utf8');
  const pb = Buffer.from(String(pass || ''), 'utf8');
  if (ub.length > 255 || pb.length > 255) throw new Error('username/password too long for SOCKS5');
  sock.write(Buffer.concat([Buffer.from([0x01, ub.length]), ub, Buffer.from([pb.length]), pb]));
  let auth;
  try {
    auth = await reader.read(2, timeoutMs);
  } catch (err) {
    throw new SocksAuthError(`SOCKS auth closed by remote: ${err.message}`);
  }
  if (auth[0] !== 0x01 || auth[1] !== 0x00) throw new SocksAuthError(`SOCKS auth failed: ${auth.toString('hex')}`);
  const dest = Buffer.from(destHost, 'utf8');
  if (dest.length > 255) throw new Error('destination host too long');
  const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, dest.length]), dest, Buffer.alloc(2)]);
  req.writeUInt16BE(destPort, req.length - 2);
  sock.write(req);
  const head = await reader.read(4, timeoutMs);
  if (head[1] !== 0) throw new SocksConnectError(`SOCKS connect failed rep=${head[1]}`);
  const atyp = head[3];
  if (atyp === 1) await reader.read(4 + 2, timeoutMs);
  else if (atyp === 3) { const ln = (await reader.read(1, timeoutMs))[0]; await reader.read(ln + 2, timeoutMs); }
  else if (atyp === 4) await reader.read(16 + 2, timeoutMs);
  else throw new SocksConnectError(`SOCKS unknown atyp=${atyp}`);
}

async function assertParentAvailable(parent, timeoutMs = 3000) {
  const { host, port } = parseParent(parent);
  try {
    const sock = await connectTcp(host, port, timeoutMs);
    sock.destroy();
  } catch (err) {
    throw new ProxyChainError(`代理无法经本机规则代理建立链路（请确认 ${port} 已开）：${err.message}`);
  }
}

async function probeRemote(remote, parent, timeoutMs = 10000) {
  const { host, port } = parseParent(parent);
  let sock = null;
  try {
    sock = await parentTunnel(host, port, remote.host, remote.port, timeoutMs);
    if (remote.user || remote.pass) {
      await socks5AuthConnect(sock, remote.user, remote.pass, '1.1.1.1', 443, timeoutMs);
    } else {
      const reader = new SockReader(sock);
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      const greet = await reader.read(2, timeoutMs);
      if (greet[0] !== 0x05 || greet[1] !== 0x00) throw new SocksConnectError('remote SOCKS greet invalid');
    }
  } catch (err) {
    if (err instanceof SocksAuthError) {
      throw new ProxyChainError(`远端 SOCKS5 认证失败（账密/套餐/会话失效）；链路已走本机 ${port}，请更换代理：${err.message}`);
    }
    if (err instanceof SocksConnectError) {
      throw new ProxyChainError(`远端 SOCKS5 经本机 ${port} 可达但连接目标失败；请更换代理或地区节点：${err.message}`);
    }
    if (err instanceof ProxyChainError) throw err;
    throw new ProxyChainError(`代理无法经本机规则代理建立链路（请确认 ${port} 已开）：${err.message}`);
  } finally {
    if (sock) sock.destroy();
  }
}

class ChainedSocksServer {
  constructor(remote, parent) {
    this.remote = remote;
    const { host, port } = parseParent(parent);
    this.parentHost = host;
    this.parentPort = port;
    this.server = null;
    this.localPort = 0;
    this.lastError = '';
    this.startedAt = 0;
  }

  start() {
    if (this.server) return Promise.resolve(this.localPort);
    return new Promise((resolve, reject) => {
      const srv = net.createServer((client) => { this._handleClient(client); });
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        this.localPort = srv.address().port;
        this.startedAt = Date.now();
        resolve(this.localPort);
      });
    });
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch (_) { }
      this.server = null;
    }
  }

  get localUrl() {
    return `socks5://127.0.0.1:${this.localPort}`;
  }

  async _handleClient(client) {
    let remoteTcp = null;
    client.on('error', () => { });
    try {
      const reader = new SockReader(client);
      const head = await reader.read(2, 30000);
      if (head[0] !== 0x05) { client.destroy(); return; }
      await reader.read(head[1], 30000);
      client.write(Buffer.from([0x05, 0x00]));

      const req = await reader.read(4, 30000);
      if (req[0] !== 0x05 || req[1] !== 0x01) {
        client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
        return;
      }
      const atyp = req[3];
      let addr;
      if (atyp === 1) {
        const raw = await reader.read(4, 30000);
        addr = Array.from(raw).join('.');
      } else if (atyp === 3) {
        const ln = (await reader.read(1, 30000))[0];
        addr = (await reader.read(ln, 30000)).toString('utf8');
      } else if (atyp === 4) {
        const raw = await reader.read(16, 30000);
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(raw.readUInt16BE(i).toString(16));
        addr = parts.join(':');
      } else {
        client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
        return;
      }
      const portBuf = await reader.read(2, 30000);
      const destPort = portBuf.readUInt16BE(0);

      remoteTcp = await parentTunnel(this.parentHost, this.parentPort, this.remote.host, this.remote.port, 20000);
      remoteTcp.on('error', () => { });
      await socks5AuthConnect(remoteTcp, this.remote.user, this.remote.pass, addr, destPort, 20000);

      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      this.lastError = '';
      client.pipe(remoteTcp).pipe(client);
      const cleanup = () => { try { client.destroy(); } catch (_) { } try { remoteTcp && remoteTcp.destroy(); } catch (_) { } };
      client.once('close', cleanup);
      remoteTcp.once('close', cleanup);
    } catch (err) {
      this.lastError = `${err.name}: ${err.message}`;
      try { client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch (_) { }
      try { client.destroy(); } catch (_) { }
      if (remoteTcp) { try { remoteTcp.destroy(); } catch (_) { } }
    }
  }
}

class ProxyChainManager {
  constructor(parent) {
    this.parent = parent || DEFAULT_PARENT;
    this.servers = new Map();
  }

  setParent(parent) {
    const next = parent || DEFAULT_PARENT;
    if (next !== this.parent) {
      this.closeAll();
      this.parent = next;
    }
  }

  keyFor(remote, tag = '') {
    return `${remote.host}:${remote.port}:${remote.user}:${remote.pass}:${tag}`;
  }

  // Full-chain probe, then publish a local no-auth SOCKS5 port.
  async ensure(proxyLine, { tag = '', probe = true } = {}) {
    const remote = parseProxyLine(proxyLine);
    if (!remote) throw new ProxyChainError('代理参数无效');
    const key = this.keyFor(remote, tag);
    const existing = this.servers.get(key);
    if (existing && existing.server) return existing;
    await assertParentAvailable(this.parent);
    if (probe) await probeRemote(remote, this.parent);
    const srv = new ChainedSocksServer(remote, this.parent);
    await srv.start();
    this.servers.set(key, srv);
    return srv;
  }

  stop(key) {
    const srv = this.servers.get(key);
    if (srv) { srv.stop(); this.servers.delete(key); }
  }

  closeAll() {
    for (const srv of this.servers.values()) srv.stop();
    this.servers.clear();
  }
}

// Minimal HTTP(S) GET through a local no-auth SOCKS5 port (for exit-IP display).
async function fetchViaLocalSocks(localPort, url, timeoutMs = 20000) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const destPort = Number(target.port) || (isHttps ? 443 : 80);
  let sock = await connectTcp('127.0.0.1', localPort, timeoutMs);
  try {
    const reader = new SockReader(sock);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    const greet = await reader.read(2, timeoutMs);
    if (greet[0] !== 0x05 || greet[1] !== 0x00) throw new Error('local socks greet failed');
    const dest = Buffer.from(target.hostname, 'utf8');
    const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, dest.length]), dest, Buffer.alloc(2)]);
    req.writeUInt16BE(destPort, req.length - 2);
    sock.write(req);
    const head = await reader.read(4, timeoutMs);
    if (head[1] !== 0) throw new Error(`local socks connect failed rep=${head[1]}`);
    const atyp = head[3];
    if (atyp === 1) await reader.read(6, timeoutMs);
    else if (atyp === 3) { const ln = (await reader.read(1, timeoutMs))[0]; await reader.read(ln + 2, timeoutMs); }
    else if (atyp === 4) await reader.read(18, timeoutMs);

    if (isHttps) {
      sock = tls.connect({ socket: sock, servername: target.hostname, rejectUnauthorized: false });
      await new Promise((resolve, reject) => {
        sock.once('secureConnect', resolve);
        sock.once('error', reject);
        setTimeout(() => reject(new Error('tls timeout')), timeoutMs);
      });
    }

    const path = `${target.pathname || '/'}${target.search || ''}`;
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: intl-doubao-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n`, 'ascii');
    const chunks = [];
    await new Promise((resolve) => {
      sock.on('data', (c) => chunks.push(c));
      sock.once('close', resolve);
      sock.once('error', resolve);
      setTimeout(resolve, timeoutMs);
    });
    const raw = Buffer.concat(chunks).toString('utf8');
    const sep = raw.indexOf('\r\n\r\n');
    const headText = sep >= 0 ? raw.slice(0, sep) : raw;
    let body = sep >= 0 ? raw.slice(sep + 4) : '';
    const statusMatch = headText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (/transfer-encoding:\s*chunked/i.test(headText)) body = dechunk(body);
    return { status, body };
  } finally {
    try { sock.destroy(); } catch (_) { }
  }
}

function dechunk(text) {
  let out = '';
  let rest = text;
  for (let guard = 0; guard < 10000; guard += 1) {
    const idx = rest.indexOf('\r\n');
    if (idx < 0) break;
    const size = parseInt(rest.slice(0, idx), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += rest.slice(idx + 2, idx + 2 + size);
    rest = rest.slice(idx + 2 + size + 2);
  }
  return out;
}

async function fetchExitIp(localPort, timeoutMs = 20000) {
  const attempts = [
    { url: 'https://api.ipify.org?format=json', pick: (data) => data.ip },
    { url: 'http://ip-api.com/json/?fields=query,country,countryCode', pick: (data) => `${data.query || ''}${data.countryCode ? ` (${data.countryCode})` : ''}` }
  ];
  for (const attempt of attempts) {
    try {
      const { status, body } = await fetchViaLocalSocks(localPort, attempt.url, timeoutMs);
      if (status >= 200 && status < 300) {
        const data = JSON.parse(body);
        const ip = attempt.pick(data);
        if (ip) return String(ip).trim();
      }
    } catch (_) { /* try next */ }
  }
  return '';
}

module.exports = {
  DEFAULT_PARENT,
  ProxyChainError,
  SocksAuthError,
  SocksConnectError,
  parseParent,
  parseProxyLine,
  maskProxyLine,
  socks5ParentConnect,
  httpParentConnect,
  assertParentAvailable,
  probeRemote,
  ChainedSocksServer,
  ProxyChainManager,
  fetchViaLocalSocks,
  fetchExitIp
};
