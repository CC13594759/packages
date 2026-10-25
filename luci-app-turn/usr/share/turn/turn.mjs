// turn.mjs
// TURN 客户端：HTTP CONNECT 代理（:8899）+ SOCKS5 代理（:9988，TCP+UDP）+ Web 管理面板（:8081）
// 协议实现见 turn-protocol.mjs，UDP 中继见 turn-udp.mjs，SOCKS5 服务端见 turn-socks5.mjs
//
// 环境变量：
//   LISTEN_HOST  代理监听，默认 0.0.0.0
//   LISTEN_PORT  HTTP 代理端口，默认 8899
//   SOCKS_HOST   SOCKS5 监听，默认跟 LISTEN_HOST
//   SOCKS_PORT   SOCKS5 端口，默认 9988；设为 0 则不启动 SOCKS5
//   PANEL_HOST   API 监听，默认 0.0.0.0（供 LuCI 调用）
//   PANEL_PORT   API 端口，默认 8081
// 服务器列表与 urltest 配置存 JSON：OpenWrt 用 /etc/config/turn，Docker 用 DATA_DIR/turn

import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { log, turnConnect, testTurnServer, parseTurnUrl } from './turn-protocol.mjs';
import { startSocks5 } from './turn-socks5.mjs';

const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8899);
const SOCKS_HOST = process.env.SOCKS_HOST || LISTEN_HOST;
const SOCKS_PORT = Number(process.env.SOCKS_PORT || 9988);
const PANEL_HOST = process.env.PANEL_HOST || '0.0.0.0';
const PANEL_PORT = Number(process.env.PANEL_PORT || 8081);

// ---------------- 配置存储 ----------------
// JSON 文件：OpenWrt 用 /etc/config/turn（/etc/config 存在即认定），Docker 用 DATA_DIR/turn
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fsSync from 'node:fs';
const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const TURN_JSON = process.env.TURN_JSON ||
  (fsSync.existsSync('/etc/config') ? '/etc/config/turn' : path.join(DATA_DIR, 'turn'));

let store = { servers: [], urltest: defaultUrltest(), proxyauth: defaultProxyauth() };
let activeId = null; // 当前使用的服务器：纯内存，不写闪存
let lastRun = null; // 上次 URLTest 结果：纯内存，不写闪存
function defaultUrltest() {
  return { enabled: false, intervalSec: 300, toleranceMs: 50 };
}
function defaultProxyauth() {
  return { enabled: false, username: '', password: '' };
}
// 代理认证是否通过：未启用则直接放行
function proxyAuthOk(username, password) {
  const cfg = store.proxyauth;
  if (!cfg || !cfg.enabled) return true;
  return username === cfg.username && password === cfg.password;
}
// HTTP 代理：检查 Proxy-Authorization: Basic base64(用户名:密码)
function httpProxyAuthOk(req) {
  const cfg = store.proxyauth;
  if (!cfg || !cfg.enabled) return true;
  const h = req.headers['proxy-authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return proxyAuthOk(decoded.slice(0, i), decoded.slice(i + 1));
}
function mask(s) {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: !!password };
}
async function saveStore() {
  await fs.mkdir(path.dirname(TURN_JSON), { recursive: true });
  await fs.writeFile(TURN_JSON, JSON.stringify(store, null, 2), 'utf8');
}
// 解析 UCI 值（仅迁移用）：'...' 段拼接，内嵌单引号为 '\''
function parseUciValue(s) {
  s = String(s || '').trim();
  if (!s.startsWith(`'`)) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] !== `'`) break;
    i++;
    while (i < s.length && s[i] !== `'`) { out += s[i]; i++; }
    if (i < s.length) i++;
    if (s[i] === '\\' && s[i + 1] === `'`) { out += `'`; i += 2; }
  }
  return out;
}
// 旧位置一次性迁移到 TURN_JSON（仅当新文件不存在）
async function migrateLegacy() {
  if (fsSync.existsSync(TURN_JSON)) return;
  // 1) UCI server 段
  try {
    let stdout = '';
    ({ stdout } = await execFileAsync('uci', ['show', 'turn']));
    const sections = {};
    for (const line of String(stdout).split('\n')) {
      let m = line.match(/^turn\.([A-Za-z0-9_]+)=([A-Za-z0-9_]+)$/);
      if (m) { sections[m[1]] = { type: m[2], opts: {} }; continue; }
      m = line.match(/^turn\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)=(.*)$/);
      if (m && sections[m[1]]) sections[m[1]].opts[m[2]] = parseUciValue(m[3]);
    }
    const clean = (v) => String(v || '').replace(/^'+|'+$/g, ''); // 去之前 bug 的多余引号
    const servers = [];
    for (const { type, opts } of Object.values(sections)) {
      if (type !== 'server' || !opts.host) continue;
      servers.push({ id: crypto.randomUUID(), name: clean(opts.name) || clean(opts.host),
        host: clean(opts.host), port: Number(opts.port) || 3478,
        username: clean(opts.username), password: opts.password || '', lastTest: null });
    }
    const main = sections.main?.opts || {};
    if (servers.length || main.urltest_enabled) {
      if (servers.length) store.servers = servers;
      if (main.urltest_enabled) store.urltest = { enabled: main.urltest_enabled === '1',
        intervalSec: Math.max(60, Number(main.urltest_interval) || 300),
        toleranceMs: Math.max(0, Number(main.urltest_tolerance) || 0) };
      await saveStore();
      log(`[迁移] 从 UCI 导入 ${servers.length} 台服务器 → ${TURN_JSON}`);
      return;
    }
  } catch {}
  // 2) 旧 JSON 文件（/app/data 为更早版本路径）
  for (const p of ['/app/data/servers.json']) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.servers) && parsed.servers.length) {
        store = { servers: parsed.servers, urltest: { ...defaultUrltest(), ...(parsed.urltest || {}) },
          proxyauth: { ...defaultProxyauth(), ...(parsed.proxyauth || {}) } };
        await saveStore();
        await fs.rename(p, p + '.migrated').catch(() => {});
        log(`[迁移] 从 ${p} 导入 ${parsed.servers.length} 台服务器 → ${TURN_JSON}`);
        return;
      }
    } catch {}
  }
}
async function loadStore() {
  await migrateLegacy();
  try {
    const raw = await fs.readFile(TURN_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.servers)) {
      store = { servers: parsed.servers, urltest: { ...defaultUrltest(), ...(parsed.urltest || {}) },
        proxyauth: { ...defaultProxyauth(), ...(parsed.proxyauth || {}) } };
    }
  } catch {}
  activeId = store.servers[0]?.id || null;
  log(`[存储] 载入 ${store.servers.length} 台 TURN 服务器（${TURN_JSON}）`);
}
function getActive() {
  return store.servers.find(s => s.id === activeId) || null;
}
function toProxy(s) {
  return { hostname: s.host, port: s.port, username: s.username || null, password: s.password || null };
}

// 并发测试全部服务器（默认并发 5），更新每台的 lastTest
async function testAll(concurrency = 5) {
  const results = [];
  const queue = [...store.servers];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) {
      const s = queue.shift();
      const r = await testTurnServer(toProxy(s));
      s.lastTest = { ...r, at: new Date().toISOString() };
      results.push({ id: s.id, name: s.name, ...r });
    }
  });
  await Promise.all(workers);
  return results;
}

// URLTest：测全部，自动把当前服务器切到延迟最低的那台
async function runUrltest() {
  if (!store.servers.length) return { at: new Date().toISOString(), results: [], switched: null, note: '没有服务器' };
  log('[URLTest] 开始测试全部服务器…');
  const results = await testAll(5);
  const ok = results.filter(r => r.ok).sort((a, b) => a.rttMs - b.rttMs);
  const cfg = store.urltest;
  let switched = null;
  if (ok.length) {
    const best = ok[0];
    const current = getActive();
    const currentR = current && results.find(r => r.id === current.id);
    const shouldSwitch = !current || !currentR?.ok || (best.id !== current.id && best.rttMs + cfg.toleranceMs < currentR.rttMs);
    if (shouldSwitch && current?.id !== best.id) {
      activeId = best.id;
      switched = { from: current?.name || null, to: best.name, rttMs: best.rttMs };
      log(`[URLTest] 切换当前服务器: ${switched.from || '无'} -> ${best.name} (${best.rttMs}ms)`);
    } else {
      log(`[URLTest] 保持当前服务器: ${current?.name}（最优 ${best.name} ${best.rttMs}ms，未超容差 ${cfg.toleranceMs}ms）`);
    }
  } else {
    log('[URLTest] 全部服务器测试失败，不切换');
  }
  lastRun = {
    at: new Date().toISOString(),
    results: results.map(r => ({ id: r.id, name: r.name, ok: r.ok, rttMs: r.rttMs, error: r.error || null })),
    switched
  };
  return lastRun;
}

let urltestTimer = null;
function scheduleUrltest() {
  if (urltestTimer) { clearInterval(urltestTimer); urltestTimer = null; }
  const cfg = store.urltest;
  if (cfg.enabled && cfg.intervalSec >= 60) {
    urltestTimer = setInterval(async () => {
      try { await runUrltest(); } catch (e) { log('[URLTest] 定时执行失败:', e.message); }
    }, cfg.intervalSec * 1000);
    urltestTimer.unref();
    log(`[URLTest] 定时优选已启用，每 ${cfg.intervalSec}s 执行一次`);
  }
}

// 批量解析：每行一个 turn:// URL，可选 "备注名 <空格> turn://..." 前缀
function parseBatch(text) {
  const added = [], failed = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      let name = null, urlStr = line;
      const sp = line.search(/\s/);
      if (sp > 0) { name = line.slice(0, sp).trim(); urlStr = line.slice(sp).trim(); }
      const t = parseTurnUrl(urlStr);
      added.push({
        name: name || t.hostname,
        host: t.hostname, port: t.port,
        username: t.username || '', password: t.password || '',
        lastTest: null
      });
    } catch (e) {
      failed.push({ line, error: e.message });
    }
  }
  return { added, failed };
}

// ---------------- HTTP CONNECT 代理 ----------------
const proxyServer = http.createServer();
proxyServer.on('connect', async (req, clientSocket, head) => {
  if (!httpProxyAuthOk(req)) {
    try { clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="turn"\r\n\r\n'); } catch {}
    clientSocket.destroy();
    return;
  }
  const active = getActive();
  if (!active) {
    try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
    clientSocket.destroy();
    return;
  }
  const [host, portStr] = (req.url || '').split(':');
  const port = Number(portStr || 443);
  if (!host || !port) { clientSocket.destroy(); return; }
  log('[代理]', `${host}:${port}`, '经', active.name);
  let relay;
  try {
    relay = await turnConnect(toProxy(active), host, port);
  } catch (e) {
    log('[代理] TURN 中继失败:', e?.message || e);
    try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
    clientSocket.destroy();
    return;
  }
  const onErr = () => { try { relay.close(); } catch {} try { clientSocket.destroy(); } catch {} };
  clientSocket.on('error', onErr);
  (async () => {
    const w = relay.writable.getWriter();
    try {
      if (head?.length) await w.write(new Uint8Array(head));
      for await (const chunk of clientSocket) await w.write(chunk);
    } catch {}
    finally {
      try { w.releaseLock(); } catch {}
      try { relay.close(); } catch {}
    }
  })();
  (async () => {
    const r = relay.readable.getReader();
    try {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        if (!clientSocket.write(value)) await new Promise(res => clientSocket.once('drain', res));
      }
    } catch {}
    finally {
      try { r.releaseLock(); } catch {}
      try { relay.close(); } catch {}
      try { clientSocket.end(); } catch {}
    }
  })();
});
proxyServer.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });

// ---------------- 管理面板 ----------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}
function validateServerInput(b) {
  const host = String(b.host || '').trim();
  if (!host) throw new Error('主机不能为空');
  const port = Number(b.port || 3478);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口须为 1-65535');
  return {
    name: String(b.name || host).trim() || host,
    host,
    port,
    username: String(b.username || ''),
    password: b.password === undefined ? undefined : String(b.password)
  };
}


const panelServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // 8081 管理接口仅允许内网/回环来源：本机持有公网 IP，公网直达 /api 可任意增删服务器、改写认证配置
  const _rip = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  const _lanOnly = _rip === '127.0.0.1' || _rip === '::1'
    || /^10\./.test(_rip) || /^192\.168\./.test(_rip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(_rip)
    || /^(fc|fd)/i.test(_rip) || /^fe80:/i.test(_rip);
  if (!_lanOnly) { res.writeHead(403, { 'Content-Length': '0' }); return res.end(); }
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Length': '0'
      });
      return res.end();
    }
    if (url.pathname === '/api/servers' && req.method === 'GET') {
      return json(res, 200, { servers: store.servers.map(mask), activeId });
    }
    if (url.pathname === '/api/servers' && req.method === 'POST') {
      const v = validateServerInput(await readBody(req));
      const s = { id: crypto.randomUUID(), name: v.name, host: v.host, port: v.port,
        username: v.username, password: v.password || '', lastTest: null };
      store.servers.push(s);
      await saveStore();
      if (!activeId) activeId = s.id;
      log('[面板] 添加服务器:', s.name, `${s.host}:${s.port}`);
      return json(res, 200, { server: mask(s) });
    }
    // 精确路由必须放在 /api/servers/:id 参数路由前面，否则会被吞掉
    if (url.pathname === '/api/servers/batch' && req.method === 'POST') {
      const { added, failed } = parseBatch((await readBody(req)).text);
      for (const v of added) {
        const s = { id: crypto.randomUUID(), name: v.name, host: v.host, port: v.port,
          username: v.username, password: v.password || '', lastTest: null };
        store.servers.push(s);
        if (!activeId) activeId = s.id;
      }
      await saveStore();
      log(`[面板] 批量添加: 成功 ${added.length} 台，失败 ${failed.length} 行`);
      return json(res, 200, { added: added.length, failed, servers: store.servers.map(mask) });
    }
    if (url.pathname === '/api/servers/test-all' && req.method === 'POST') {
      log('[面板] 批量测试全部服务器');
      const results = await testAll(5);
      return json(res, 200, { results });
    }
    let m = url.pathname.match(/^\/api\/servers\/([^/]+)$/);
    if (m) {
      const s = store.servers.find(x => x.id === m[1]);
      if (!s) return json(res, 404, { error: '服务器不存在' });
      if (req.method === 'PUT') {
        const v = validateServerInput(await readBody(req));
        s.name = v.name; s.host = v.host; s.port = v.port; s.username = v.username;
        if (v.password) s.password = v.password; // 留空则不改
        await saveStore();
        log('[面板] 更新服务器:', s.name);
        return json(res, 200, { server: mask(s) });
      }
      if (req.method === 'DELETE') {
        store.servers = store.servers.filter(x => x.id !== s.id);
        if (activeId === s.id) activeId = store.servers[0]?.id || null;
        await saveStore();
        log('[面板] 删除服务器:', s.name);
        return json(res, 200, { ok: true });
      }
    }
    m = url.pathname.match(/^\/api\/servers\/([^/]+)\/activate$/);
    if (m && req.method === 'POST') {
      const s = store.servers.find(x => x.id === m[1]);
      if (!s) return json(res, 404, { error: '服务器不存在' });
      activeId = s.id;
      log('[面板] 切换当前服务器:', s.name, `${s.host}:${s.port}`);
      return json(res, 200, { ok: true, activeId: s.id });
    }
    m = url.pathname.match(/^\/api\/servers\/([^/]+)\/test$/);
    if (m && req.method === 'POST') {
      const s = store.servers.find(x => x.id === m[1]);
      if (!s) return json(res, 404, { error: '服务器不存在' });
      log('[面板] 测试服务器:', s.name);
      const r = await testTurnServer(toProxy(s));
      s.lastTest = { ...r, at: new Date().toISOString() };
      return json(res, 200, r);
    }
    if (url.pathname === '/api/urltest' && req.method === 'GET') {
      return json(res, 200, { ...store.urltest, lastRun });
    }
    if (url.pathname === '/api/urltest' && req.method === 'PUT') {
      const b = await readBody(req);
      const cfg = store.urltest;
      cfg.enabled = !!b.enabled;
      cfg.intervalSec = Math.max(60, Number(b.intervalSec) || 300);
      cfg.toleranceMs = Math.max(0, Number(b.toleranceMs) || 0);
      await saveStore();
      scheduleUrltest();
      log('[面板] URLTest 配置更新:', `启用=${cfg.enabled}`, `间隔=${cfg.intervalSec}s`, `容差=${cfg.toleranceMs}ms`);
      return json(res, 200, { ...cfg, lastRun });
    }
    if (url.pathname === '/api/urltest/run' && req.method === 'POST') {
      const lastRun = await runUrltest();
      return json(res, 200, lastRun);
    }
    if (url.pathname === '/api/proxyauth' && req.method === 'GET') {
      const c = store.proxyauth;
      return json(res, 200, { enabled: !!c.enabled, username: c.username || '', hasPassword: !!c.password });
    }
    if (url.pathname === '/api/proxyauth' && req.method === 'PUT') {
      const b = await readBody(req);
      const c = store.proxyauth;
      c.enabled = !!b.enabled;
      if (typeof b.username === 'string') c.username = b.username.trim();
      if (typeof b.password === 'string' && b.password) c.password = b.password; // 留空则不改
      await saveStore();
      log('[面板] 代理认证更新:', `启用=${c.enabled}`, `用户名=${c.username || '(空)'}`);
      return json(res, 200, { enabled: c.enabled, username: c.username, hasPassword: !!c.password });
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const active = getActive();
      return json(res, 200, {
        http: { host: LISTEN_HOST, port: LISTEN_PORT },
        socks5: SOCKS_PORT ? { host: SOCKS_HOST, port: SOCKS_PORT } : null,
        servers: store.servers.length,
        active: active ? active.name : null
      });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 400, { error: e.message || '请求失败' });
  }
});

// ---------------- 启动 ----------------
await loadStore();
scheduleUrltest();
proxyServer.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`[启动] HTTP 代理监听 ${LISTEN_HOST}:${LISTEN_PORT}`);
});
let socksServer = null;
if (SOCKS_PORT) {
  socksServer = startSocks5({
    host: SOCKS_HOST, port: SOCKS_PORT,
    getProxy: () => { const s = getActive(); return s ? toProxy(s) : null; },
    getAuth: () => { const c = store.proxyauth; return (c && c.enabled && c.username) ? { username: c.username, password: c.password } : null; }
  });
} else {
  log('[启动] SOCKS5 已禁用（SOCKS_PORT=0）');
}
panelServer.listen(PANEL_PORT, PANEL_HOST, () => {
  log(`[启动] API 接口 http://${PANEL_HOST === '0.0.0.0' ? '本机IP' : PANEL_HOST}:${PANEL_PORT}（仅供 LuCI 调用）`);
});
const shutdown = () => {
  log('[退出] 关闭中…');
  if (urltestTimer) { clearInterval(urltestTimer); urltestTimer = null; }
  const closers = [proxyServer, panelServer];
  if (socksServer) closers.push(socksServer);
  let n = closers.length;
  const done = () => { if (--n <= 0) process.exit(0); };
  closers.forEach(s => s.close(done));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
