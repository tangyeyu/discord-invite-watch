// 设置推送通路的 secret 并重新部署云端哨兵
//
// 为什么不用 `npx wrangler secret put`：在 PowerShell 里用管道喂 stdin 会被
// wrangler 判定为非交互环境并报 "it's necessary to set a CLOUDFLARE_API_TOKEN"（实测）。
// 直接调 Cloudflare API 设 secret 更稳，也便于脚本化。
//
// 用法：
//   node setup-push.mjs sct <SendKey>        设置 Server酱
//   node setup-push.mjs discord <webhookURL> 设置 Discord webhook
//   node setup-push.mjs list                 列出已设置的 secret
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

const PROXY = { host: '127.0.0.1', port: 10808 };
// 账号 ID：优先读环境变量 CLOUDFLARE_ACCOUNT_ID，其次从 wrangler whoami 自动识别。
// 不要在这里硬编码账号 ID —— 那是个人信息，且换账号后容易忘记改。
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const SCRIPT = process.env.WORKER_NAME || 'leina-invite-watch';

const cfgPath = path.join(os.homedir(), 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml');
const token = (fs.readFileSync(cfgPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/) || [])[1];
if (!token) {
  console.error('读不到 wrangler OAuth token，请先 wrangler login');
  process.exit(1);
}

// 账号 ID 自动识别：ACCOUNT 为空时从 wrangler whoami 输出里取
let accountId = ACCOUNT;
if (!accountId) {
  try {
    const who = execFileSync('npx', ['wrangler', 'whoami'], {
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:10808' }
    });
    accountId = (who.match(/\b([0-9a-f]{32})\b/) || [])[1] || '';
  } catch {
    /* 下面统一报错 */
  }
}
if (!accountId) {
  console.error('无法确定 Cloudflare 账号 ID。请设置环境变量 CLOUDFLARE_ACCOUNT_ID，或先 wrangler login。');
  process.exit(1);
}
console.log(`账号 ID: ${accountId}`);
console.log(`Worker : ${SCRIPT}\n`);

// Cloudflare API 调用。
// 注意：chunked 解码必须在 Buffer 上做，不能先 toString 再按字符切 ——
// 响应里含多字节 UTF-8 时按字符索引会切坏（实测：list 静默返回空列表，
// 让人误以为没配 secret）。
function api(method, p, body) {
  return new Promise((resolve) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const collect = (sock) => {
      const chunks = [];
      sock.setTimeout(30000, () => {
        sock.destroy();
        resolve({ err: 'TIMEOUT' });
      });
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => {
        const buf = Buffer.concat(chunks);
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd < 0) return resolve({ err: '响应头不完整' });
        const head = buf.slice(0, headEnd).toString('latin1');
        let b = buf.slice(headEnd + 4);
        if (/transfer-encoding:\s*chunked/i.test(head)) {
          const out = [];
          let pos = 0;
          while (pos < b.length) {
            const nl = b.indexOf('\r\n', pos);
            if (nl < 0) break;
            const size = parseInt(b.slice(pos, nl).toString('latin1').trim(), 16);
            if (!Number.isFinite(size) || size === 0) break;
            out.push(b.slice(nl + 2, nl + 2 + size));
            pos = nl + 2 + size + 2;
          }
          b = Buffer.concat(out);
        }
        resolve({ status: Number((head.match(/^HTTP\/\d\.\d (\d+)/) || [])[1]), body: b.toString('utf8') });
      });
      sock.on('error', (e) => resolve({ err: e.code || e.message }));
      sock.write(
        `${method} ${p} HTTP/1.1\r\nHost: api.cloudflare.com\r\nAuthorization: Bearer ${token}\r\nAccept: application/json\r\n` +
          (payload ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : '') +
          `User-Agent: curl/8.0\r\nConnection: close\r\n\r\n` + (payload || '')
      );
    };
    const cr = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: 'api.cloudflare.com:443', headers: { Host: 'api.cloudflare.com:443' } });
    cr.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return resolve({ err: 'CONNECT ' + res.statusCode });
      collect(tls.connect({ socket, host: 'api.cloudflare.com', servername: 'api.cloudflare.com' }));
    });
    cr.on('error', (e) => resolve({ err: e.code || e.message }));
    cr.end();
  });
}

const [, , action, value] = process.argv;

if (action === 'list' || !action) {
  const r = await api('GET', `/client/v4/accounts/${accountId}/workers/scripts/${SCRIPT}/secrets`);
  console.log('已设置的 secret：');
  if (r.err) {
    // 不要静默返回空列表 —— 那会让人误以为"没配置"（实测踩过）
    console.log(`  [X] 查询失败：${r.err}`);
    process.exit(1);
  }
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {
    console.log(`  [X] 响应无法解析（HTTP ${r.status}）：${(r.body || '').slice(0, 200)}`);
    process.exit(1);
  }
  if (!j.success) {
    console.log(`  [X] API 返回失败：${JSON.stringify(j.errors || j)}`.slice(0, 300));
    process.exit(1);
  }
  if (!j.result?.length) console.log('  （无 —— 尚未配置任何推送通路）');
  for (const s of j.result || []) console.log(`  - ${s.name}   类型=${s.type}   更新于 ${s.modified_on ?? '-'}`);
  process.exit(0);
}

if (action !== 'sct' && action !== 'discord') {
  console.log('用法: node setup-push.mjs {sct <SendKey>|discord <webhookURL>|list}');
  process.exit(2);
}
if (!value) {
  console.error('缺少值。sct 需要 SendKey，discord 需要 webhook URL。');
  process.exit(2);
}

const name = action === 'sct' ? 'SERVERCHAN_KEY' : 'DISCORD_WEBHOOK';

// --- 基本格式校验（反例保护：避免把明显错误的值写进去）---
if (action === 'sct' && !/^sct/i.test(value)) {
  console.error(`[X] SendKey 通常以 SCT 开头，你给的是 "${value.slice(0, 12)}..."`);
  console.error('    请到 https://sct.ftqq.com/ 复制 SendKey。');
  process.exit(1);
}
if (action === 'discord' && !/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(value)) {
  console.error('[X] 这不像 Discord webhook URL（应形如 https://discord.com/api/webhooks/...）');
  process.exit(1);
}

console.log(`设置 ${name} ...`);
const put = await api('PUT', `/client/v4/accounts/${accountId}/workers/scripts/${SCRIPT}/secrets`, {
  name,
  text: value,
  type: 'secret_text'
});
console.log(`  HTTP ${put.status}`);
try {
  const j = JSON.parse(put.body);
  console.log(`  success=${j.success}`);
  if (!j.success) {
    console.log('  errors=' + JSON.stringify(j.errors));
    process.exit(1);
  }
  console.log(`  ${name} 已写入（值不会回显）`);
} catch {
  console.log('  ' + (put.body || put.err || '').slice(0, 300));
}

// --- 自校准：回读 secret 列表确认存在 ---
const chk = await api('GET', `/client/v4/accounts/${accountId}/workers/scripts/${SCRIPT}/secrets`);
let found = false;
try {
  found = (JSON.parse(chk.body).result || []).some((s) => s.name === name);
} catch {}
console.log(`\n回读校验: ${found ? 'PASS —— secret 确实存在' : 'FAIL —— 没找到，设置可能失败'}`);

console.log('\n注意：secret 生效需要**重新部署**一次。下面自动执行 wrangler deploy …');
try {
  const out = execFileSync('npx', ['wrangler', 'deploy'], {
    cwd: path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), ''),
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:10808', HTTP_PROXY: 'http://127.0.0.1:10808' }
  });
  const line = out.split(/\r?\n/).filter((l) => /workers\.dev|Version ID|Uploaded|Deployed/.test(l));
  console.log(line.join('\n'));
  console.log('\n✅ 完成。之后每次检查若有开放信号，就会推送到你配置的通路。');
} catch (e) {
  console.log('部署失败，请手动执行： cd cloudflare-worker; npx wrangler deploy');
  console.log(String(e.stdout || e.message).slice(0, 400));
  process.exit(1);
}
