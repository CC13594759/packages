// turn-protocol.mjs
// TURN-over-TCP 客户端协议实现（RFC 6062），移植自 edgetunnel turnConnect。
// 导出：turnConnect（完整中继，会话复用）、testTurnServer（仅 Allocate 连通性测试）、parseTurnUrl、tcpConnect
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';

export const CONNECT_TIMEOUT_MS = 9999;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------- 基础工具 ----------------
export function log(...args) { console.log(new Date().toISOString(), ...args); }
export function toBytes(v) {
  if (v == null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return textEncoder.encode(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error('unsupported chunk type');
}
export function concatBytes(...chunks) {
  const parts = chunks.map(toBytes);
  const total = parts.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of parts) { out.set(c, off); off += c.byteLength; }
  return out;
}
export async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(message)), ms); })
    ]);
  } finally { clearTimeout(timer); }
}
export function isIPv4(v) {
  const p = String(v || '').split('.');
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x >= 0 && +x <= 255);
}
export function stripBrackets(h = '') {
  const s = String(h || '').trim();
  return (s.startsWith('[') && s.endsWith(']')) ? s.slice(1, -1) : s;
}
export function randomTransactionId() { return crypto.randomBytes(12); }

// ---------------- STUN/TURN 报文 ----------------
export const MAGIC = [0x21, 0x12, 0xa4, 0x42];
export const T = {
  ALLOCATE_REQUEST: 0x0003, ALLOCATE_SUCCESS: 0x0103, ALLOCATE_ERROR: 0x0113,
  CREATE_PERMISSION_REQUEST: 0x0008, CREATE_PERMISSION_SUCCESS: 0x0108,
  CONNECT_REQUEST: 0x000a, CONNECT_SUCCESS: 0x010a,
  CONNECTION_BIND_REQUEST: 0x000b, CONNECTION_BIND_SUCCESS: 0x010b,
  REFRESH_REQUEST: 0x0004, REFRESH_SUCCESS: 0x0104,
  SEND_INDICATION: 0x0016, DATA_INDICATION: 0x0017
};
export const A = {
  USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009,
  XOR_PEER_ADDRESS: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015,
  REQUESTED_TRANSPORT: 0x0019, CONNECTION_ID: 0x002a, LIFETIME: 0x000d
};
// XOR-PEER-ADDRESS 编解码（仅 IPv4）
export function encodeXorPeerAddress(ip, port) {
  const b = new Uint8Array(8);
  b[1] = 1;
  new DataView(b.buffer).setUint16(2, port ^ 0x2112);
  String(ip).split('.').forEach((v, i) => { b[4 + i] = Number(v) ^ MAGIC[i]; });
  return b;
}
export function decodeXorPeerAddress(data) {
  const d = toBytes(data);
  if (d.byteLength < 8 || d[1] !== 1) return null;
  const port = (((d[2] << 8) | d[3]) ^ 0x2112) & 0xffff;
  const ip = [0, 1, 2, 3].map(i => d[4 + i] ^ MAGIC[i]).join('.');
  return { ip, port };
}
const pad = n => (4 - (n % 4)) % 4;
export function attr(type, value) {
  const v = toBytes(value);
  const b = new Uint8Array(4 + v.byteLength + pad(v.byteLength));
  new DataView(b.buffer).setUint16(0, type);
  new DataView(b.buffer).setUint16(2, v.byteLength);
  b.set(v, 4);
  return b;
}
export function message(type, txId, attrs) {
  const body = concatBytes(...attrs);
  const b = new Uint8Array(20 + body.byteLength);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, type);
  dv.setUint16(2, body.byteLength);
  b.set(MAGIC, 4);
  b.set(toBytes(txId).subarray(0, 12), 8);
  b.set(body, 20);
  return b;
}
export function parseErrorCode(data) {
  const d = toBytes(data);
  return d.byteLength >= 4 ? (d[2] & 7) * 100 + d[3] : 0;
}
export function addIntegrity(msg, key) {
  const signed = new Uint8Array(toBytes(msg));
  new DataView(signed.buffer).setUint16(2, new DataView(signed.buffer).getUint16(2) + 24);
  const sig = crypto.createHmac('sha1', Buffer.from(key)).update(signed).digest();
  return concatBytes(signed, attr(A.MESSAGE_INTEGRITY, sig));
}
export async function readMessage(reader, buffered = null, timeoutMsg = 'TURN response timed out', timeoutMs = CONNECT_TIMEOUT_MS) {
  let buf = buffered?.byteLength ? toBytes(buffered) : new Uint8Array(0);
  const pull = async () => {
    const rp = reader.read();
    const { done, value } = timeoutMs == null ? await rp : await withTimeout(rp, timeoutMs, timeoutMsg);
    if (done) throw new Error('TURN server closed connection');
    if (value?.byteLength) buf = concatBytes(buf, value);
  };
  while (buf.byteLength < 20) await pull();
  const len = 20 + ((buf[2] << 8) | buf[3]);
  if (len > 65555) throw new Error('TURN response too large');
  while (buf.byteLength < len) await pull();
  const mb = buf.subarray(0, len);
  if (MAGIC.some((v, i) => mb[4 + i] !== v)) throw new Error('Invalid TURN/STUN response');
  const view = new DataView(mb.buffer, mb.byteOffset, mb.byteLength);
  const attributes = {};
  for (let off = 20; off + 4 <= len;) {
    const type = view.getUint16(off), alen = view.getUint16(off + 2);
    if (off + 4 + alen > mb.byteLength) break;
    attributes[type] = mb.slice(off + 4, off + 4 + alen);
    off += 4 + alen + pad(alen);
  }
  return { message: { type: view.getUint16(0), txId: mb.slice(8, 20), attributes }, extraData: buf.subarray(len) };
}
export async function writeBytes(writer, bytes, timeoutMsg) {
  await withTimeout(writer.write(toBytes(bytes)), CONNECT_TIMEOUT_MS, timeoutMsg);
}

// ---------------- TCP 连接适配 ----------------
export function tcpConnect({ hostname, port }) {
  const sock = net.createConnection({ host: hostname, port });
  let openRes, openRej, closeRes;
  const opened = new Promise((res, rej) => { openRes = res; openRej = rej; });
  const closed = new Promise(res => { closeRes = res; });
  sock.once('connect', () => { sock.removeListener('error', openRej); openRes(); });
  sock.once('error', openRej);
  sock.on('error', () => {});
  sock.once('close', () => closeRes());
  return {
    readable: Readable.toWeb(sock),
    writable: Writable.toWeb(sock),
    opened, closed,
    close: () => { try { sock.destroy(); } catch {} }
  };
}

export async function resolveIPv4(host) {
  const h = stripBrackets(host);
  if (isIPv4(h)) return h;
  const r = await dns.lookup(h, { family: 4 }).catch(() => null);
  const ip = r?.address && isIPv4(r.address) ? r.address : null;
  if (!ip) throw new Error(`无法解析 ${host} 为 IPv4`);
  return ip;
}

export function parseTurnUrl(raw) {
  if (!raw) throw new Error('TURN 地址格式错误，例如 turn://用户名:密码@turn.example.com:3478');
  const u = new URL(raw);
  if (u.protocol !== 'turn:') throw new Error(`TURN 地址协议须为 turn://，当前为 ${u.protocol}//`);
  return {
    hostname: u.hostname,
    port: u.port ? Number(u.port) : 3478,
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null
  };
}

// ---------------- TURN 客户端引擎（从 worker.js 提取，RFC 8656 + RFC 6062） ----------------
// worker.js 原名对照：過鬼=Allocate+认证，通鬼=TCP 中继(ConnectionBind)，通流=UDP 中继
// 与上一版(会话复用)不同：每次 turnConnect 做完整握手(Allocate→Permission→Connect→ConnectionBind)，
// 实现更简单，无复杂状态机；代价是每连接多几次 RTT。

// Allocate + 长连接认证(401 → USERNAME/REALM/NONCE/MESSAGE-INTEGRITY 重试)
// pl(authAttrs, sign) 如提供，会在认证 Allocate 后流水线发出附加请求(如 CreatePermission/Connect)
export async function turnAllocate(writer, reader, transport, username, password, pl) {
  const tp = new Uint8Array([transport, 0, 0, 0]);
  await writeBytes(writer,
    message(T.ALLOCATE_REQUEST, randomTransactionId(), [attr(A.REQUESTED_TRANSPORT, tp)]),
    'TURN Allocate 请求超时');
  let resp = await readMessage(reader, null, 'TURN Allocate 响应超时');
  let m = resp.message, extra = resp.extraData;
  let key = null, authAttrs = [];
  const sign = x => key ? addIntegrity(x, key) : x;
  if (m.type === T.ALLOCATE_ERROR && username && parseErrorCode(m.attributes[A.ERROR_CODE]) === 401) {
    const realm = textDecoder.decode(m.attributes[A.REALM] || new Uint8Array(0));
    const nonce = m.attributes[A.NONCE] || new Uint8Array(0);
    key = crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
    authAttrs = [
      attr(A.USERNAME, textEncoder.encode(username)),
      attr(A.REALM, textEncoder.encode(realm)),
      attr(A.NONCE, nonce)
    ];
    const aq = addIntegrity(
      message(T.ALLOCATE_REQUEST, randomTransactionId(),
        [attr(A.REQUESTED_TRANSPORT, tp), ...authAttrs]), key);
    const extras = pl ? await Promise.all(pl(authAttrs, sign)) : [];
    await writeBytes(writer, extras.length ? concatBytes(aq, ...extras) : aq, 'TURN 认证 Allocate 请求超时');
    resp = await readMessage(reader, extra, 'TURN 认证 Allocate 响应超时');
    m = resp.message; extra = resp.extraData;
  } else if (pl && m.type === T.ALLOCATE_SUCCESS) {
    const extras = await Promise.all(pl(authAttrs, sign));
    if (extras.length) await writeBytes(writer, concatBytes(...extras), 'TURN 附加请求超时');
  }
  if (m.type !== T.ALLOCATE_SUCCESS) {
    const code = parseErrorCode(m.attributes[A.ERROR_CODE]);
    throw new Error(code ? `TURN Allocate 失败，错误码 ${code}` : 'TURN Allocate 失败');
  }
  const ltB = m.attributes[A.LIFETIME];
  const lifetimeSec = ltB?.byteLength >= 4
    ? new DataView(ltB.buffer, ltB.byteOffset, 4).getUint32(0) : 0;
  return { key, authAttrs, extra, sign, lifetimeSec };
}

// TCP 中继：Allocate → CreatePermission → Connect → 新连接 ConnectionBind
// turn = {host, port, user, pass}；targetIp 必须已是 IPv4
// 返回 {readable, writable, close, prefix}，失败返回 null
async function turnConnectTcp(turn, targetIp, targetPort) {
  let ctrl = null, data = null;
  let refreshTimer = null, drainReader = null, refreshWriter = null;
  let closed = false;
  const closeAll = () => { try { ctrl?.close(); } catch {} try { data?.close(); } catch {} };
  const close = () => {
    if (closed) return;
    closed = true;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    try { drainReader?.cancel('tunnel_closed')?.catch?.(() => {}); } catch {}
    try { refreshWriter?.releaseLock(); } catch {}
    closeAll();
    refreshWriter = null;
  };
  try {
    ctrl = tcpConnect({ hostname: stripBrackets(turn.host), port: turn.port });
    await withTimeout(ctrl.opened, CONNECT_TIMEOUT_MS, 'TURN 控制连接超时');
    const cw = ctrl.writable.getWriter(), cr = ctrl.readable.getReader();
    const peerAttr = attr(A.XOR_PEER_ADDRESS, encodeXorPeerAddress(targetIp, targetPort));
    let alloc;
    try {
      alloc = await turnAllocate(cw, cr, 6, turn.user, turn.pass, (aa, sign) => [
        sign(message(T.CREATE_PERMISSION_REQUEST, randomTransactionId(), [peerAttr, ...aa])),
        sign(message(T.CONNECT_REQUEST, randomTransactionId(), [peerAttr, ...aa]))
      ]);
    } catch (e) {
      try { cw.releaseLock(); } catch {}
      try { cr.releaseLock(); } catch {}
      closeAll();
      return null;
    }
    // 等 CreatePermission 成功
    let resp = await readMessage(cr, alloc.extra, 'TURN CreatePermission 响应超时');
    if (resp.message.type !== T.CREATE_PERMISSION_SUCCESS) {
      try { cw.releaseLock(); } catch {}
      try { cr.releaseLock(); } catch {}
      closeAll();
      return null;
    }
    // 等 Connect 成功（带 CONNECTION_ID）
    resp = await readMessage(cr, resp.extraData, 'TURN Connect 响应超时');
    const connId = resp.message.attributes[A.CONNECTION_ID];
    if (resp.message.type !== T.CONNECT_SUCCESS || !connId?.byteLength) {
      try { cw.releaseLock(); } catch {}
      try { cr.releaseLock(); } catch {}
      closeAll();
      return null;
    }
    // 数据连接 + ConnectionBind
    const ds = tcpConnect({ hostname: stripBrackets(turn.host), port: turn.port });
    try {
      await withTimeout(ds.opened, CONNECT_TIMEOUT_MS, 'TURN 数据连接超时');
    } catch (e) {
      try { ds.close(); } catch {}
      try { cw.releaseLock(); } catch {}
      try { cr.releaseLock(); } catch {}
      closeAll();
      return null;
    }
    data = ds;
    const dw = data.writable.getWriter(), dr = data.readable.getReader();
    let bindOk = false;
    try {
      await writeBytes(dw,
        alloc.sign(message(T.CONNECTION_BIND_REQUEST, randomTransactionId(),
          [attr(A.CONNECTION_ID, connId), ...alloc.authAttrs])),
        'TURN ConnectionBind 请求超时');
      resp = await readMessage(dr, null, 'TURN ConnectionBind 响应超时');
      bindOk = resp.message.type === T.CONNECTION_BIND_SUCCESS;
    } catch {}
    const prefix = bindOk && resp.extraData?.byteLength ? resp.extraData.slice() : null;
    try { dw.releaseLock(); } catch {}
    try { dr.releaseLock(); } catch {}
    try { cw.releaseLock(); } catch {}
    try { cr.releaseLock(); } catch {}
    if (!bindOk) { closeAll(); return null; }
    // 控制通道：读循环只负责吞掉对端关闭/杂项；保活只写不读
    refreshWriter = ctrl.writable.getWriter();
    drainReader = ctrl.readable.getReader();
    (async () => {
      try {
        for (;;) {
          const r = drainReader;
          if (!r) break;
          const { done } = await r.read();
          if (done) break;
        }
      } catch {}
      try { drainReader?.releaseLock(); } catch {}
      drainReader = null;
    })();
    const keepalive = async () => {
      if (closed) return;
      try {
        const rq = alloc.sign(message(T.REFRESH_REQUEST, randomTransactionId(), alloc.authAttrs));
        const pq = alloc.sign(message(T.CREATE_PERMISSION_REQUEST, randomTransactionId(),
          [peerAttr, ...alloc.authAttrs]));
        await writeBytes(refreshWriter, concatBytes(rq, pq), 'TURN 保活超时');
      } catch { close(); return; }
      if (!closed) refreshTimer = setTimeout(keepalive, 270000);
    };
    refreshTimer = setTimeout(keepalive, 270000);
    return { readable: data.readable, writable: data.writable, close, prefix };
  } catch {
    close();
    return null;
  }
}

// 对外：完整 TURN TCP 中继。proxy={hostname,port,username,password}
// 返回 {readable, writable, close}（readable 已含 prefix），失败抛错
export async function turnConnect(proxy, targetHost, targetPort) {
  const targetIp = await resolveIPv4(targetHost);
  const turn = { host: proxy.hostname, port: proxy.port, user: proxy.username, pass: proxy.password };
  const t = await turnConnectTcp(turn, targetIp, targetPort);
  if (!t) throw new Error('TURN 中继建立失败');
  if (!t.prefix?.byteLength) return { readable: t.readable, writable: t.writable, close: t.close };
  const dr = t.readable.getReader();
  const readable = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(t.prefix)); },
    async pull(c) {
      try {
        const { done, value } = await dr.read();
        if (done) { try { dr.releaseLock(); } catch {} c.close(); }
        else if (value?.byteLength) c.enqueue(new Uint8Array(value));
      } catch { try { dr.releaseLock(); } catch {} c.close(); }
    },
    cancel() { try { dr.cancel(); } catch {} t.close(); }
  });
  return { readable, writable: t.writable, close: t.close };
}

// 对外：仅 Allocate 的连通性测试（供 urltest）
export async function testTurnServer(proxy) {
  const started = Date.now();
  const sock = tcpConnect({ hostname: stripBrackets(proxy.hostname), port: proxy.port });
  try {
    await withTimeout(sock.opened, CONNECT_TIMEOUT_MS, 'TURN 连接超时');
    const writer = sock.writable.getWriter();
    const reader = sock.readable.getReader();
    try {
      const alloc = await turnAllocate(writer, reader, 6, proxy.username, proxy.password, null);
      return { ok: true, rttMs: Date.now() - started, lifetimeSec: alloc.lifetimeSec };
    } catch (e) {
      return { ok: false, rttMs: Date.now() - started, error: e?.message || String(e) };
    } finally {
      try { writer.releaseLock(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  } catch (e) {
    return { ok: false, rttMs: Date.now() - started, error: e?.message || String(e) };
  } finally {
    try { sock.close(); } catch {}
  }
}
