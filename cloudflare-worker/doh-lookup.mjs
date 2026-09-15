// 可复用的 DoH 解析器：绕过系统 DNS 污染拿到真实 IP
// 背景：本机 workers.dev / discord.com 等被 DNS 污染（实测 workers.dev 被解析到
// Facebook 的 31.13.67.19），而 tls.connect({host}) 用的是系统 DNS，于是握手死掉
// （EPROTO / CERT_HAS_EXPIRED）。必须自己用 DoH 取真实 IP 再显式传入 lookup。
import http from 'node:http';
import tls from 'node:tls';

const PROXY = { host: '127.0.0.1', port: 10808 };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function httpsGetViaProxy(hostname, pathq, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const collect = (sock) => {
      const bufs = [];
      sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve({ err: 'TIMEOUT' }); });
      sock.on('data', (c) => bufs.push(c));
      sock.on('end', () => {
        const raw = Buffer.concat(bufs).toString('utf8');
        const i = raw.indexOf('\r\n\r\n');
        let b = raw.slice(i + 4);
        if (/transfer-encoding:\s*chunked/i.test(raw.slice(0, i))) {
          const out = []; let pos = 0;
          while (pos < b.length) {
            const nl = b.indexOf('\r\n', pos);
            if (nl < 0) break;
            const size = parseInt(b.slice(pos, nl).trim(), 16);
            if (!Number.isFinite(size) || size === 0) break;
            out.push(b.slice(nl + 2, nl + 2 + size));
            pos = nl + 2 + size + 2;
          }
          b = out.join('');
        }
        resolve({ body: b });
      });
      sock.on('error', (e) => resolve({ err: e.code || e.message }));
      sock.write(`GET ${pathq} HTTP/1.1\r\nHost: ${hostname}\r\nUser-Agent: ${UA}\r\nAccept: application/dns-json\r\nConnection: close\r\n\r\n`);
    };
    const cr = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: `${hostname}:443`, headers: { Host: `${hostname}:443` } });
    cr.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return resolve({ err: 'CONNECT ' + res.statusCode });
      collect(tls.connect({ socket, servername: hostname }));
    });
    cr.on('error', (e) => resolve({ err: e.code || e.message }));
    cr.end();
  });
}

/** 用 DoH 查 A 记录，返回 IP 数组（失败返回 []） */
export async function resolveViaDoh(hostname) {
  const dohHosts = ['cloudflare-dns.com', 'dns.google', '1.1.1.1'];
  for (const dh of dohHosts) {
    const pathq = `/dns-query?name=${encodeURIComponent(hostname)}&type=A`;
    const r = await httpsGetViaProxy(dh, pathq);
    if (r.err || !r.body) continue;
    try {
      const j = JSON.parse(r.body);
      const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
      if (ips.length) return ips;
    } catch {
      /* 换下一个 DoH 服务 */
    }
  }
  return [];
}

/** 生成给 tls.connect / https.request 用的 lookup，强制走已解析的真实 IP */
export function makeLookup(ip) {
  return (host, opts, cb) => cb(null, ip, 4);
}

export { httpsGetViaProxy, PROXY, UA };
