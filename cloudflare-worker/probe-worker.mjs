// 探测云端 Worker 是否正常（自带 DoH，绕开 workers.dev 的 DNS 污染）
//
// 为什么不用 PowerShell 的 Invoke-WebRequest：
//   本机 workers.dev 被 DNS 污染（实测解析到 Facebook 的 IP），
//   而 PS 5.1 无法指定「连哪个 IP、SNI 用哪个域名」；
//   给 Invoke-WebRequest 加 Host 头并不可靠（实测时好时坏，
//   连到污染 IP 时报 NO_RESPONSE，看起来像 Worker 挂了）。
//   所以统一由这里用 DoH 取真实 IP 后显式建连。
//
// 用法： node probe-worker.mjs <hostname> [proxy]
// 输出： 单行 JSON，便于 PowerShell 解析
//   { ok, status, memberCount, events, guildName, ip, error }
import http from 'node:http';
import tls from 'node:tls';
import { resolveViaDoh, PROXY as DEFAULT_PROXY } from './doh-lookup.mjs';

const host = process.argv[2];
if (!host) {
  console.log(JSON.stringify({ ok: false, error: 'missing hostname argument' }));
  process.exit(2);
}
const proxyUrl = process.argv[3] || '';
let PROXY = DEFAULT_PROXY;
if (proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    PROXY = { host: u.hostname, port: Number(u.port || 80) };
  } catch {
    /* 用默认值 */
  }
}

function getViaIp(hostname, ip, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const cr = http.request({
      host: PROXY.host,
      port: PROXY.port,
      method: 'CONNECT',
      path: `${ip}:443`,
      headers: { Host: `${ip}:443` },
      timeout: timeoutMs
    });
    cr.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return done({ error: `代理拒绝 CONNECT：HTTP ${res.statusCode}` });
      // host: hostname 必须显式指定！
      // 否则 tls.connect 会从传入的 socket 继承 host（那是 IP），
      // 于是 SNI 变成 IP —— 违反 RFC 6066，Node 会打 DEP0123 警告，
      // 且 TLS 校验按 IP 走会失败（实测踩过）。
      const t = tls.connect({ socket, host: hostname, servername: hostname });
      let buf = '';
      t.setTimeout(timeoutMs, () => {
        t.destroy();
        done({ error: 'TIMEOUT' });
      });
      t.on('error', (e) => done({ error: e.code || e.message }));
      t.on('data', (c) => {
        buf += c.toString('utf8');
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i);
        let body = buf.slice(i + 4);
        if (/transfer-encoding:\s*chunked/i.test(head)) {
          const out = [];
          let pos = 0;
          while (pos < body.length) {
            const nl = body.indexOf('\r\n', pos);
            if (nl < 0) break;
            const size = parseInt(body.slice(pos, nl).trim(), 16);
            if (!Number.isFinite(size) || size === 0) break;
            out.push(body.slice(nl + 2, nl + 2 + size));
            pos = nl + 2 + size + 2;
          }
          body = out.join('');
        }
        done({ status: Number((head.match(/^HTTP\/\d\.\d (\d+)/) || [])[1]), body });
        t.destroy();
      });
      t.write(
        `GET / HTTP/1.1\r\nHost: ${hostname}\r\n` +
          `User-Agent: discord-invite-watch/1.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`
      );
    });
    cr.on('timeout', () => {
      done({ error: '连接代理超时' });
      cr.destroy();
    });
    cr.on('error', (e) => done({ error: e.code || e.message }));
    cr.end();
  });
}

// 策略：**先用确定性 anycast IP，DoH 只作兜底**。
//
// 为什么顺序这么排（实测教训）：DoH 在本机代理下并不可靠 ——
// cloudflare-dns.com 返回 noA、dns.google 解析失败、1.1.1.1 报
// CERT_ALTNAME_INVALID（代理对 DoH 域名有干扰）。若先跑 DoH，6 个端点
// 各超时 12 秒，既慢、又可能让代理随后对连接设限，导致紧接着的兜底 IP
// 连接报 EPROTO —— 看起来像"Worker 挂了"，其实是刚那波 DoH 拖垮的。
//
// 而 Cloudflare 边缘按 SNI 路由，任意常见 anycast IP 都能服务目标 Worker
// （实测 104.16.0.1 / 104.17.0.1 / 172.64.0.1 访问 <worker>.<sub>.workers.dev 全部 200）。
const ANYCAST_IPS = ['104.16.0.1', '104.17.0.1', '172.64.0.1'];

async function tryIp(ip) {
  // 对瞬时错误（EPROTO/ECONNRESET/TIMEOUT 等）重试一次，避免偶发抖动被当成"不可用"
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await getViaIp(host, ip);
    if (r.status) return r; // 拿到 HTTP 状态码就算成功建连
    if (attempt === 0) await new Promise((x) => setTimeout(x, 700));
    else return r;
  }
}

let used = null;
let last = null;

// 第一步：确定性 anycast IP
for (const ip of ANYCAST_IPS) {
  last = await tryIp(ip);
  if (last.status === 200) {
    used = { ip, via: 'anycast' };
    break;
  }
}

// 第二步：DoH 解析（仅当 anycast 没成功时）
if (!used) {
  const dohIps = await resolveViaDoh(host);
  for (const ip of dohIps) {
    last = await tryIp(ip);
    if (last.status === 200) {
      used = { ip, via: 'doh' };
      break;
    }
  }
  if (!used) {
    console.log(
      JSON.stringify({
        ok: false,
        status: last?.status ?? null,
        dohError: resolveViaDoh.lastError || null,
        error: last?.error ?? null,
        body: String(last?.body || '').slice(0, 300)
      })
    );
    process.exit(0);
  }
}

{
  let parsed = null;
  try {
    parsed = JSON.parse(last.body);
  } catch {
    /* 非 JSON 也算可达，下面标记 */
  }
  console.log(
    JSON.stringify({
      ok: true,
      status: 200,
      ip: used.ip,
      via: used.via,
      memberCount: parsed?.memberCount ?? null,
      events: parsed?.events ?? null,
      guildId: parsed?.guildId ?? null,
      guildName: parsed?.guildName ?? null,
      baseline: parsed?.baseline ?? null,
      raw: parsed ? undefined : String(last.body || '').slice(0, 200)
    })
  );
}
