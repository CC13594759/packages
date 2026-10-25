// turn-socks5.mjs
// SOCKS5 代理服务端（RFC 1928），后端走 TURN 中继：
//   - CONNECT：复用 turnConnect 的 TCP 中继通路（许可+连接流水线，会话复用）
//   - UDP ASSOCIATE：UDP 数据报经 UdpRelay 以 TURN Send/Data indication 中继
// 不支持：IPv6、BIND、分片（FRAG!=0 直接丢弃）
// 认证：getAuth() 返回 {username, password} 时启用用户名密码认证（RFC 1929），返回 null 时无认证
import net from 'node:net';
import dgram from 'node:dgram';
import { log, turnConnect, resolveIPv4 } from './turn-protocol.mjs';
import { UdpRelay } from './turn-udp.mjs';

// 带缓冲的精确读取；握手结束后 detach() 把剩余字节交还，切换裸转发
class SockBuf {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.closed = false;
    this._onData = (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
    };
    this._onClose = () => {
      this.closed = true;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
    };
    sock.on('data', this._onData);
    sock.once('close', this._onClose);
    sock.on('error', () => {});
  }
  read(n, timeoutMs = 15000) {
    const start = Date.now();
    return (async () => {
      while (this.buf.length < n) {
        if (this.closed) throw new Error('SOCKS5 连接已关闭');
        await new Promise((res, rej) => {
          const left = Math.max(1, timeoutMs - (Date.now() - start));
          const t = setTimeout(() => { this.waiter = null; rej(new Error('SOCKS5 读取超时')); }, left);
          if (t.unref) t.unref();
          this.waiter = () => { clearTimeout(t); res(); };
        });
      }
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return out;
    })();
  }
  detach() {
    this.sock.removeListener('data', this._onData);
    this.sock.removeListener('close', this._onClose);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

const dnsCache = new Map();
async function resolveCached(host) {
  const now = Date.now();
  const c = dnsCache.get(host);
  if (c && c.exp > now) return c.ip;
  const ip = await resolveIPv4(host);
  dnsCache.set(host, { ip, exp: now + 60000 });
  if (dnsCache.size > 500) dnsCache.clear();
  return ip;
}

export function parseUdpDatagram(msg) {
  if (msg.length < 10) throw new Error('UDP 数据报过短');
  const frag = msg[2], atyp = msg[3];
  let host, port, headerLen;
  if (atyp === 0x01) {
    host = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`;
    port = msg.readUInt16BE(8); headerLen = 10;
  } else if (atyp === 0x03) {
    const l = msg[4];
    if (msg.length < 7 + l) throw new Error('UDP 数据报过短');
    host = msg.subarray(5, 5 + l).toString('utf8');
    port = msg.readUInt16BE(5 + l); headerLen = 7 + l;
  } else {
    throw new Error('不支持的地址类型');
  }
  return { frag, host, port, data: msg.subarray(headerLen) };
}

export function buildUdpDatagram(dstIp, dstPort, payload) {
  const p = dstIp.split('.').map(Number);
  const h = Buffer.alloc(10);
  h[3] = 0x01;
  p.forEach((v, i) => { h[4 + i] = v; });
  h.writeUInt16BE(dstPort, 8);
  return Buffer.concat([h, Buffer.from(payload)]);
}

// clientSocket <--> TURN relay 双向转发（握手后残留字节先发）
function pipeTcp(clientSocket, relay, leftover) {
  const onErr = () => { try { relay.close(); } catch {} try { clientSocket.destroy(); } catch {} };
  clientSocket.on('error', onErr);
  (async () => {
    const w = relay.writable.getWriter();
    try {
      if (leftover?.length) await w.write(new Uint8Array(leftover));
      for await (const chunk of clientSocket) await w.write(chunk);
    } catch {} finally {
      try { w.releaseLock(); } catch {}
      try { relay.close(); } catch {}
    }
  })();
  (async () => {
    const r = relay.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        if (!clientSocket.write(value)) await new Promise(res => clientSocket.once('drain', res));
      }
    } catch {} finally {
      try { r.releaseLock(); } catch {}
      try { relay.close(); } catch {}
      try { clientSocket.end(); } catch {}
    }
  })();
}

async function handleConnect(sock, sb, host, port, getProxy) {
  const fail = (code) => {
    try { sock.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {}
    sb.detach();
    try { sock.destroy(); } catch {}
  };
  const proxy = getProxy();
  if (!proxy) { fail(0x01); return; }
  let ip;
  try { ip = await resolveCached(host); }
  catch { fail(0x04); return; }
  log('[SOCKS5]', `${host}:${port}`, '经', proxy.name || proxy.hostname);
  let relay;
  try {
    relay = await turnConnect(proxy, ip, port);
  } catch (e) {
    log('[SOCKS5] TURN 中继失败:', e?.message || e);
    fail(0x05);
    return;
  }
  try { sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {}
  const leftover = sb.detach();
  pipeTcp(sock, relay, leftover);
}

async function handleUdpAssociate(sock, sb, bindHost, getProxy, udpRelay) {
  const proxy = getProxy();
  if (!proxy) {
    try { sock.write(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {}
    sb.detach();
    try { sock.destroy(); } catch {}
    return;
  }
  const udpSock = dgram.createSocket('udp4');
  try {
    await new Promise((res, rej) => {
      udpSock.once('error', rej);
      udpSock.bind(0, bindHost, () => { udpSock.removeListener('error', rej); res(); });
    });
  } catch (e) {
    log('[SOCKS5] UDP 中继端口绑定失败:', e?.message || e);
    try { sock.write(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {}
    sb.detach();
    try { sock.destroy(); } catch {}
    return;
  }
  const boundPort = udpSock.address().port;
  let localIp = sock.localAddress || '127.0.0.1';
  if (localIp.includes(':')) localIp = '127.0.0.1'; // 只要 IPv4 展示
  const parts = localIp.split('.').map(Number);
  const rep = Buffer.alloc(10);
  rep[3] = 0x01;
  parts.forEach((v, i) => { rep[4 + i] = v; });
  rep.writeUInt16BE(boundPort, 8);
  rep[0] = 5;
  try { sock.write(rep); } catch {}
  sb.detach(); // TCP 只做关联保活，不再读
  const assoc = { udpSock, clientEp: null, closed: false };
  const onClose = () => {
    if (assoc.closed) return;
    assoc.closed = true;
    try { udpSock.close(); } catch {}
  };
  sock.once('close', onClose);
  sock.once('error', onClose);
  udpSock.on('error', () => {});
  udpSock.on('message', (msg, rinfo) => {
    (async () => {
      if (assoc.closed) return;
      let p;
      try { p = parseUdpDatagram(msg); } catch { return; }
      if (p.frag !== 0) return; // 不支持分片
      assoc.clientEp = { address: rinfo.address, port: rinfo.port };
      const peerIp = await resolveCached(p.host);
      const peerPort = p.port;
      const payload = p.data;
      await udpRelay.send(proxy, peerIp, peerPort, payload, (replyData) => {
        const ep = assoc.clientEp;
        if (!ep || assoc.closed) return;
        const out = buildUdpDatagram(peerIp, peerPort, replyData);
        udpSock.send(out, ep.port, ep.address, () => {});
      });
    })().catch(e => log('[SOCKS5] UDP 处理失败:', e?.message || e));
  });
  log('[SOCKS5] UDP ASSOCIATE 已建立，中继', `${localIp}:${boundPort}`);
}

async function handleClient(sock, bindHost, getProxy, getAuth, udpRelay) {
  const sb = new SockBuf(sock);
  try {
    const g = await sb.read(2);
    if (g[0] !== 0x05) throw new Error('不是 SOCKS5 协议');
    const methods = await sb.read(g[1]);
    const auth = getAuth ? getAuth() : null;
    if (auth) {
      // 要求用户名密码认证（RFC 1929）
      if (!methods.includes(0x02)) {
        try { sock.write(Buffer.from([5, 0xff])); } catch {}
        throw new Error('需要用户名密码认证，客户端未提供');
      }
      sock.write(Buffer.from([5, 0x02]));
      const ah = await sb.read(2);
      if (ah[0] !== 0x01) throw new Error('认证子协商版本错误');
      const ulen = ah[1];
      const ub = await sb.read(ulen + 1);
      const username = ub.subarray(0, ulen).toString('utf8');
      const plen = ub[ulen];
      const pb = await sb.read(plen);
      const password = pb.toString('utf8');
      if (username !== auth.username || password !== auth.password) {
        try { sock.write(Buffer.from([1, 0xff])); } catch {}
        throw new Error('SOCKS5 用户名或密码错误');
      }
      sock.write(Buffer.from([1, 0x00]));
    } else {
      if (!methods.includes(0x00)) {
        try { sock.write(Buffer.from([5, 0xff])); } catch {}
        throw new Error('客户端要求认证，不支持');
      }
      sock.write(Buffer.from([5, 0]));
    }
    const h = await sb.read(4);
    if (h[0] !== 0x05) throw new Error('请求版本错误');
    const cmd = h[1], atyp = h[3];
    let host, port;
    if (atyp === 0x01) {
      const b = await sb.read(6);
      host = `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
      port = b.readUInt16BE(4);
    } else if (atyp === 0x03) {
      const l = (await sb.read(1))[0];
      const b = await sb.read(l + 2);
      host = b.subarray(0, l).toString('utf8');
      port = b.readUInt16BE(l);
    } else {
      try { sock.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {}
      throw new Error('地址类型不支持（仅 IPv4/域名）');
    }
    if (cmd === 0x01) await handleConnect(sock, sb, host, port, getProxy);
    else if (cmd === 0x03) await handleUdpAssociate(sock, sb, bindHost, getProxy, udpRelay);
    else {
      try { sock.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {}
      throw new Error('不支持的命令');
    }
  } catch (e) {
    try { sb.detach(); } catch {}
    try { sock.destroy(); } catch {}
    if (!/读取超时|连接已关闭/.test(e?.message || '')) log('[SOCKS5] 会话异常:', e?.message || e);
  }
}

export function startSocks5({ host, port, getProxy, getAuth }) {
  const udpRelay = new UdpRelay();
  const server = net.createServer((sock) => {
    handleClient(sock, host, getProxy, getAuth, udpRelay).catch(e => {
      log('[SOCKS5] 会话异常:', e?.message || e);
      try { sock.destroy(); } catch {}
    });
  });
  server.on('error', (e) => log('[SOCKS5] 监听失败:', e?.message || e));
  server.listen(port, host, () => log(`[启动] SOCKS5 代理监听 ${host}:${port}（TCP+UDP）`));
  return server;
}
