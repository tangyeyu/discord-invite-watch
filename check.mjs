#!/usr/bin/env node
/**
 * 一键自检：把逻辑判据、网络通路、通知通路都验一遍。
 * 用法: node check.mjs
 *
 * 注意代理：本机直连 discord.com 不通（DNS 污染），网络类检查依赖代理。
 * 代理没开时这些项**标记为 SKIP 而不是 FAIL** —— 它们没被验证，不等于坏了，
 * 报 FAIL 会误导人去查代码（实测踩过）。
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const results = [];

function record(label, status, out = '') {
  results.push({ label, status });
  console.log(`\n===== ${label} =====`);
  if (out) console.log(out.trim() || '(无输出)');
  const mark = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`-> ${mark}`);
}

function run(label, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: DIR, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  record(label, r.status === 0 ? 'PASS' : 'FAIL', out);
  return out;
}

// ---- 先探测代理是否可用（决定网络类检查是跑还是跳过）----
function probeProxy() {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    'http://127.0.0.1:10808';
  let host = '127.0.0.1';
  let port = 10808;
  try {
    const u = new URL(raw);
    host = u.hostname;
    port = Number(u.port || 80);
  } catch {
    /* 用默认值 */
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(v);
      }
    };
    sock.setTimeout(3000, () => finish({ ok: false, host, port, reason: '连接超时' }));
    sock.on('connect', () => finish({ ok: true, host, port }));
    sock.on('error', (e) => finish({ ok: false, host, port, reason: e.code || e.message }));
  });
}

const node = process.execPath;
const proxy = await probeProxy();

console.log('================ 一键自检 ================');
console.log(`代理 ${proxy.host}:${proxy.port} → ${proxy.ok ? '可用' : '不可用（' + proxy.reason + '）'}`);

// 1) 判据自检（离线，永远能跑）
run('1) 判据自检（离线，不依赖网络）', node, ['monitor.mjs', '--simulate']);

if (!proxy.ok) {
  const why = `代理 ${proxy.host}:${proxy.port} 不可用（${proxy.reason}）—— 请先启动代理软件`;
  record('2) 网络通路（真实探测类脑邀请）', 'SKIP', why);
  record('3) 反例：无效邀请码必须被判失效', 'SKIP', why);
  console.log('\n提示：网络类检查已跳过，它们没被验证，不代表代码有问题。');
  console.log('      启动代理（如 v2rayN / xray）后重跑本脚本即可完成全部检查。');
} else {
  const live = run('2) 网络通路（真实探测类脑邀请）', node, ['monitor.mjs', '--check', 'HWNkueX34q', 'odysseia']);
  const liveOk = /OK\s+HWNkueX34q/.test(live) && /类脑/.test(live);
  record('2b) 类脑邀请确实可解析', liveOk ? 'PASS' : 'FAIL');

  // 反例：一个必然无效的码必须被判为失效，否则说明检测器恒真
  const bad = run('3) 反例：无效邀请码必须被判失效', node, ['monitor.mjs', '--check', 'zzzznotarealcode9988']);
  const badOk = /FAIL\s+zzzznotarealcode9988/.test(bad) && /404/.test(bad);
  record('3b) 检测器不是恒真', badOk ? 'PASS' : 'FAIL');
}

console.log('\n\n================ 汇总 ================');
let failed = 0;
let skipped = 0;
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  ${r.label}`);
  if (r.status === 'FAIL') failed++;
  if (r.status === 'SKIP') skipped++;
}
console.log(
  `\n${results.length - failed - skipped} 通过 / ${skipped} 跳过 / ${failed} 失败`
);
process.exit(failed === 0 ? 0 : 1);
