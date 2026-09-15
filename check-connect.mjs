#!/usr/bin/env node
/**
 * 登入 Discord 前的通路自检。
 *
 * 为什么需要它：Discord 登录要同时打通「API 域名 + 网关 WebSocket + CDN」，
 * 只测 discord.com 是不够的 —— 很多人 API 通、网关不通，表现就是
 * 「登录转圈 / 卡在连接中 / 语音连不上」。
 *
 * 关键机制：Chrome / Edge **会自动使用 Windows 系统代理**；
 * 但（实测）某些代理软件的系统代理是 PAC/局部路由模式，可能只代理浏览器。
 * 所以本脚本既测系统代理通路，也测直连通路，并明确告诉你客户端该注意什么。
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 探测点：用**真实会返回内容的端点**，而不是裸根路径。
// 裸根路径在 CDN 上常被直接关闭连接（无正文），会产生假失败 —— 实测踩过。
const PROBES = [
  { host: 'discord.com', kind: 'main', path: '/api/v10/gateway', note: '主 API' },
  { host: 'discord.com', kind: 'gateway', path: '/api/v10/gateway/bot', note: '网关（未鉴权应 401，能拿到 401 即为通）' },
  { host: 'cdn.discordapp.com', kind: 'cdn', path: '/embed/avatars/0.png', note: '头像 CDN' },
  { host: 'media.discordapp.net', kind: 'cdn', path: '/embed/avatars/0.png', note: '媒体 CDN' },
  { host: 'discord.com', kind: 'invite', path: '/api/v10/invites/HWNkueX34q?with_counts=true', note: '类脑邀请' }
];

const KNOWN_POLLUTED = ['199.59.148.106', '243.185.187.39', '59.24.3.173', '8.7.198.45', '46.82.174.68'];

function getSystemProxy() {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    return { url: process.env.HTTPS_PROXY || process.env.HTTP_PROXY, src: '环境变量' };
  }
  if (process.platform !== 'win32') return null;
  try {
    const ps =
      `$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; ` +
      `if ($p -and $p.ProxyEnable -eq 1) { [string]$p.ProxyServer }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 15000, windowsHide: true
    }).trim();
    if (!out) return null;
    let picked = out;
    if (out.includes('=')) {
      const m = Object.fromEntries(out.split(';').filter(Boolean).map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim()];
      }));
      picked = m.https || m.http || Object.values(m)[0] || '';
    }
    return picked ? { url: `http://${picked}`, src: `系统代理 ${picked}` } : null;
  } catch {
    return null;
  }
}

function getJson(target, proxy, timeoutMs = 15000) {
  const u = new URL(target);
  // 关键：必须保证 Promise 一定 settle —— 否则失败时静默挂死，打印出 undefined
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, err: `超时(${timeoutMs}ms)` }), timeoutMs + 3000);

    let sock = null;
    let buf = '';
    const onData = (c) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const status = Number((buf.slice(0, i).match(/HTTP\/\d\.\d (\d+)/) || [])[1]);
      finish({ ok: status >= 200 && status < 400, status, body: buf.slice(i + 4).slice(0, 120) });
      if (sock) sock.destroy();
    };
    const send = (s) => {
      sock = s;
      s.setTimeout(timeoutMs, () => {
        finish({ ok: false, err: `读超时(${timeoutMs}ms)` });
        s.destroy();
      });
      s.on('data', onData);
      s.on('end', () => finish({ ok: false, err: '连接被关闭且无响应数据' }));
      s.on('close', () => finish({ ok: false, err: '连接已关闭' }));
      s.on('error', (e) => finish({ ok: false, err: e.code || e.message }));
      s.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: ${UA}\r\n` +
          `Accept: application/json\r\nConnection: close\r\n\r\n`
      );
      // 连接已建立但对方不发数据时，兜底用 index 页判断可达性
      setTimeout(() => {
        if (!settled) finish({ ok: true, status: '已连接（无正文）', body: '' });
      }, 8000);
    };

    if (!proxy) {
      send(tls.connect({ host: u.hostname, port: 443, servername: u.hostname }));
      return;
    }
    const cr = http.request({
      host: new URL(proxy).hostname,
      port: Number(new URL(proxy).port || 80),
      method: 'CONNECT',
      path: `${u.hostname}:443`,
      headers: { Host: `${u.hostname}:443` },
      timeout: timeoutMs
    });
    cr.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return finish({ ok: false, err: `代理拒绝 CONNECT HTTP ${res.statusCode}` });
      send(tls.connect({ socket, servername: u.hostname }));
    });
    cr.on('timeout', () => {
      finish({ ok: false, err: '连接代理超时' });
      cr.destroy();
    });
    cr.on('error', (e) => finish({ ok: false, err: e.code || e.message }));
    cr.end();
  });
}

console.log('================ Discord 登入通路自检 ================\n');

console.log('【1】DNS 解析（判断是否被污染 / 是否走了 fake-IP）');
let polluted = 0;
let fakeIp = 0;
for (const host of [...new Set(PROBES.map((p) => p.host))]) {
  let ips = [];
  try {
    ips = (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
  } catch (e) {
    console.log(`  ${host.padEnd(24)} 解析失败 ${e.code}`);
    continue;
  }
  const v4 = ips.filter((ip) => ip.includes('.'));
  const fake = ips.filter((ip) => /^(198\.18\.|198\.19\.)/.test(ip));
  const bad = ips.filter((ip) => KNOWN_POLLUTED.includes(ip));
  if (bad.length) polluted++;
  if (fake.length) fakeIp++;
  const show = (v4.length ? v4 : ips).join(', ');
  const tag = bad.length ? '❌ 污染' : fake.length ? '⚠ 疑似 fake-IP' : '✅';
  console.log(`  ${host.padEnd(24)} ${show.padEnd(34)} ${tag}`);
}

console.log('');

const proxy = getSystemProxy();
const proxyUrl = proxy ? proxy.url : null;   // getSystemProxy 返回对象，请求层只吃字符串
console.log(`【2】代理探测：${proxy ? proxy.src : '未检测到系统代理'}\n`);

console.log('【3】真实端点连通性');
let okCount = 0;
for (const p of PROBES) {
  const r = await getJson(`https://${p.host}${p.path}`, proxyUrl);
  // 401 也算通：说明请求到达了 Discord 并得到应用层应答
  const reachable = r.ok || r.status === 401 || r.status === 403;
  if (reachable) okCount++;
  const mark = reachable ? '✅' : '❌';
  const detail = r.ok || r.status ? `HTTP ${r.status}` : r.err;
  console.log(`  ${mark} ${(p.host + p.path).padEnd(52)} ${detail}   ${p.note}`);
}

console.log(`\n  → ${okCount}/${PROBES.length} 个端点可达`);
console.log('\n================ 结论 ================');
if (okCount >= PROBES.length - 1) {
  console.log('✅ 网络通路正常，可以登入 Discord。');
  console.log('');
  console.log('  · Chrome / Edge：自动使用系统代理，直接开 https://discord.com/app');
  console.log('  · Discord 桌面客户端：**可能不读系统代理**。若装了客户端后卡在连接中/一直转圈，');
  console.log('    把 v2rayN 从「系统代理」切到「TUN 模式」(虚拟网卡全局接管)，或改用浏览器版。');
  if (fakeIp) console.log('  · 注意：DNS 已被代理接管(fake-IP)，所以不要用 ping 判断通不通。');
} else {
  console.log('❌ 通路不完整，先修网络再谈登入。');
  console.log('   检查顺序：代理软件是否在跑 → 节点能否访问境外 → 是否需要切 TUN 模式');
}
console.log('');
