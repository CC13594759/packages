// turn-udp.mjs
// UDP 中继（从 worker.js 通流提取）：Allocate(UDP transport) → Send/Data indication + CreatePermission。
// 上层接口与上一版一致：UdpRelay.send(proxy, peerIp, peerPort, data, onReply)。
import {
  log, toBytes, concatBytes, withTimeout, stripBrackets, randomTransactionId,
  CONNECT_TIMEOUT_MS, T, A, attr, message,
  encodeXorPeerAddress, decodeXorPeerAddress,
  readMessage, writeBytes, tcpConnect, turnAllocate
} from './turn-protocol.mjs';

// ---- XUDP 帧（worker.js 解包/回包格式） ----
// 发送布局: [ml(2B)][0,0,2,1,2][port(2B)][addr][plen(2B)][payload]，ml=7+addrLen
function encodeXudpAddr(host) {
  const s = String(host).replace(/^\[|\]$/g, '');
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) return new Uint8Array([0x01, +m[1], +m[2], +m[3], +m[4]]);
  const e = new TextEncoder().encode(s);
  const out = new Uint8Array(2 + e.length);
  out[0] = 0x02; out[1] = e.length; out.set(e, 2);
  return out;
}
function decodeXudpAddr(d) {
  if (!d.length) return '';
  if (d[0] === 0x01) return d.length >= 5 ? `${d[1]}.${d[2]}.${d[3]}.${d[4]}` : '';
  if (d[0] === 0x02) return d.length >= 2 + d[1] ? new TextDecoder().decode(d.subarray(2, 2 + d[1])) : '';
  return '';
}
function buildXudp(host, port, payload) {
  const a = encodeXudpAddr(host);
  const p = toBytes(payload);
  const ml = 7 + a.length;
  const b = new Uint8Array(2 + ml + 2 + p.length);
  b[0] = ml >> 8; b[1] = ml & 0xff;
  b[4] = 2; b[5] = 1; b[6] = 2;
  b[7] = port >> 8; b[8] = port & 0xff;
  b.set(a, 9);
  const o = 2 + ml;
  b[o] = p.length >> 8; b[o + 1] = p.length & 0xff;
  b.set(p, o + 2);
  return b;
}
function parseXudp(d) {
  d = toBytes(d);
  if (d.length < 6) return null;
  const ml = (d[0] << 8) | d[1], me = 2 + ml;
  if (ml < 4 || me > d.length) return null;
  const port = me >= 9 ? ((d[7] << 8) | d[8]) : 0;
  const host = me > 9 ? decodeXudpAddr(d.subarray(9, me)) : '';
  let payload = null;
  if ((d[5] & 1) && me + 2 <= d.length) {
    const pL = (d[me] << 8) | d[me + 1];
    if (me + 2 + pL <= d.length) payload = d.subarray(me + 2, me + 2 + pL);
  }
  return { host, port, payload };
}

// ---- UDP 中继本体（worker.js 通流逻辑） ----
// turn={host,port,user,pass}；onFrame(xudpFrame) 在收到回包时调用
async function turnUdpRelay(turn, onFrame) {
  const sock = tcpConnect({ hostname: stripBrackets(turn.host), port: turn.port });
  await withTimeout(sock.opened, CONNECT_TIMEOUT_MS, 'TURN UDP 控制连接超时');
  const writer = sock.writable.getWriter();
  const reader = sock.readable.getReader();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { writer.releaseLock(); } catch {}
    try { reader.releaseLock(); } catch {}
    try { sock.close(); } catch {}
  };
  let alloc;
  try {
    alloc = await turnAllocate(writer, reader, 17, turn.user, turn.pass, null);
  } catch (e) {
    try { writer.releaseLock(); } catch {}
    try { reader.releaseLock(); } catch {}
    try { sock.close(); } catch {}
    throw e;
  }
  const sign = alloc.sign, aa = alloc.authAttrs;
  // 读循环：Data indication → onFrame；Refresh 响应等杂项直接忽略
  let buf = alloc.extra;
  (async () => {
    try {
      for (;;) {
        const r = await readMessage(reader, buf, 'TURN UDP 读', null);
        buf = r.extraData;
        if (closed) break;
        const m = r.message;
        if (m.type === T.DATA_INDICATION && m.attributes[A.XOR_PEER_ADDRESS] && m.attributes[A.DATA]) {
          const peer = decodeXorPeerAddress(m.attributes[A.XOR_PEER_ADDRESS]);
          if (peer) {
            try { onFrame(buildXudp(peer.ip, peer.port, m.attributes[A.DATA])); } catch {}
          }
        }
      }
    } catch {} finally { close(); }
  })();
  // 写串行化
  let wchain = Promise.resolve();
  const wsend = (fn) => { wchain = wchain.then(fn, fn); return wchain; };
  // 保活：Refresh + 已授权 IP 的 Permission 续期（worker.js 同：240s）
  const permitted = new Set();
  const keepalive = () => {
    if (closed) return;
    wsend(async () => {
      if (closed) return;
      try {
        const msgs = [sign(message(T.REFRESH_REQUEST, randomTransactionId(), aa))];
        for (const ip of permitted) {
          msgs.push(sign(message(T.CREATE_PERMISSION_REQUEST, randomTransactionId(),
            [attr(A.XOR_PEER_ADDRESS, encodeXorPeerAddress(ip, 0)), ...aa])));
        }
        await writeBytes(writer, concatBytes(...msgs), 'TURN UDP 保活超时');
      } catch { close(); }
    }).finally(() => { if (!closed) setTimeout(keepalive, 240000); });
  };
  setTimeout(keepalive, 240000);
  return {
    async sendUdp(ip, port, payload) {
      if (closed) throw new Error('UDP relay closed');
      if (!permitted.has(ip)) {
        await wsend(async () => {
          if (closed || permitted.has(ip)) return;
          await writeBytes(writer,
            sign(message(T.CREATE_PERMISSION_REQUEST, randomTransactionId(),
              [attr(A.XOR_PEER_ADDRESS, encodeXorPeerAddress(ip, 0)), ...aa])),
            'TURN CreatePermission 超时');
          permitted.add(ip);
        });
      }
      // Send indication 不签名（worker.js 同）
      const si = message(T.SEND_INDICATION, randomTransactionId(), [
        attr(A.XOR_PEER_ADDRESS, encodeXorPeerAddress(ip, port)),
        attr(A.DATA, toBytes(payload))
      ]);
      await wsend(() => writeBytes(writer, si, 'TURN Send 超时').catch(() => {}));
    },
    close
  };
}

export class UdpRelay {
  constructor() {
    this._relays = new Map(); // proxyKey -> {ready, routes: Map<ip:port, onReply>}
  }
  _proxyKey(proxy) {
    return `${proxy.username || ''}@${stripBrackets(proxy.hostname)}:${proxy.port}`;
  }
  async _get(proxy) {
    const k = this._proxyKey(proxy);
    let e = this._relays.get(k);
    if (!e) {
      const routes = new Map();
      const turn = { host: proxy.hostname, port: proxy.port, user: proxy.username, pass: proxy.password };
      const ready = turnUdpRelay(turn, (frame) => {
        const p = parseXudp(frame);
        if (!p || !p.payload?.byteLength) return;
        const h = routes.get(`${p.host}:${p.port}`);
        if (h) { try { h(p.payload); } catch (err) { log('[UDP] 回包回调异常:', err?.message || err); } }
      }).then(
        (relay) => { e.relay = relay; return e; },
        (err) => { this._relays.delete(k); throw err; }
      );
      e = { relay: null, routes, ready };
      this._relays.set(k, e);
    }
    await e.ready;
    return e;
  }
  // 发一个 UDP 数据报；onReply(data) 在对端回包时被调用（按 ip:port 路由，后写覆盖）
  async send(proxy, peerIp, peerPort, data, onReply) {
    const e = await this._get(proxy);
    e.routes.set(`${peerIp}:${peerPort}`, onReply);
    await e.relay.sendUdp(peerIp, peerPort, data);
  }
}
