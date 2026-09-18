#!/usr/bin/env node
/**
 * 类脑 ΟΔΥΣΣΕΙΑ 邀请链接守望者 / Discord invite watcher
 *
 * 目的：在《类脑》社区重新开放加入的那一刻发出通知。
 *
 * ── 为什么这样做得通（已实测核实，2025 现场探测）────────────────────────────
 * 公开接口 https://discord.com/api/v10/invites/<code>?with_counts=true&with_expiration=true
 * 在**不带任何 token** 的情况下会返回：
 *   guild.verification_level      入群验证等级（3 = 强制手机验证）
 *   guild.vanity_url_code         服务器自定义短链
 *   approximate_member_count      近似成员数
 *   approximate_presence_count    近似在线数
 *   expires_at                    null = 永不过期；有时间戳 = 限时邀请
 *   channel.id / channel.name     该邀请码当前落地到哪个频道
 *
 * 于是可以只用 HTTP 轮询实现三路判据：
 *   A. 成员数**增长**            → 有人在进群 = 开放中
 *   B. 落地频道发生变化          → 管理员改了邀请设置（开放/关闭时通常都会改）
 *   C. 落地频道回到 / 离开某个标记频道 → 精细的开关信号
 * 再加上 D. 链接从失效变有效 / 从限时变永久。
 *
 * ── 两个必须防的坑（都实测过）──────────────────────────────────────────────
 * 1) **突发请求会被反枚举限流，且返回 404**（不是 429）。
 *    实测：连续 20 次快速请求 → 全部 404；同样这些码、间隔 400ms → 全部 200。
 *    因此单次 404 **不能**判定"已失效"，必须连续 N 次才认，且要有退避。
 * 2) **成员数是近似值**，不是精确值，突变 1 人不足为凭。
 *    故默认阈值 MIN_MEMBER_DELTA=2，并可在配置里调。
 *
 * 用法：
 *   node monitor.mjs --once                 # 跑一次（计划任务用）
 *   node monitor.mjs                        # 前台常驻轮询
 *   node monitor.mjs --baseline-only        # 只重置基线，不发通知
 *   node monitor.mjs --simulate             # 离线自检：把 A/B/C/D 四条判据演一遍
 *   node monitor.mjs --check <code>...      # 手动体检一批邀请码（自动限速）
 *
 * 配置：同目录 monitor.config.json（不存在则用内置默认值 = 类脑社区）
 * 依赖：无。只用 Node 内置模块（node:fs / node:path / node:child_process）。
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(DIR, 'monitor.config.json');
const STATE_PATH = path.join(DIR, 'state.json');

const DEFAULTS = {
  inviteCode: 'HWNkueX34q',
  guildName: '类脑ΟΔΥΣΣΕΙΑ',
  guildId: '1134557553011998840',
  altCodes: ['odysseia'],
  pollSeconds: 300,
  minMemberDelta: 2,
  notify: { toast: true, sound: true, webhookUrl: '' },
  // 想要"落地频道 == 某频道才报警"，把频道 id 填到这里
  openChannelIds: []
};

function log(...a) {
  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}]`, ...a);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────────── 配置 / 状态 ─────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    log('未找到 monitor.config.json，使用内置默认配置（类脑）。');
    return { ...DEFAULTS };
  }
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const cfg = { ...DEFAULTS, ...user, notify: { ...DEFAULTS.notify, ...(user.notify || {}) } };
    if (!Array.isArray(cfg.altCodes)) cfg.altCodes = [];
    if (!Array.isArray(cfg.openChannelIds)) cfg.openChannelIds = [];
    return cfg;
  } catch (e) {
    log(`monitor.config.json 解析失败（${e.message}），回退内置默认配置。`);
    return { ...DEFAULTS };
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { baseline: null, watched: {}, log: [] };
  }
}

function saveState(state) {
  if (Array.isArray(state.log) && state.log.length > 500) {
    state.log = state.log.slice(-500);
  }
  // 原子写：临时文件 + 改名（Windows 上 rename 覆盖已存在文件是允许的）
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

// ───────────────────────────── 网络 ─────────────────────────────

const API = 'https://discord.com/api/v10';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 代理自动探测 —— 本机实测必须，否则整个脚本静默失败。
 *
 * 实测事实：本机 discord.com 被解析到 199.59.148.106（污染地址），直连 TLS
 * 直接 ECONNRESET；PowerShell 的 Invoke-WebRequest 走系统代理（注册表
 * HKCU\...\Internet Settings = 127.0.0.1:10808）所以能通。而 **Node 的 fetch
 * 不读系统代理**，报 UND_ERR_CONNECT_TIMEOUT。
 * 又实测：本机 Node 24 无法 import('undici')（内置但不暴露），
 * 所以不依赖 undici，改为自己用 node:http 打 CONNECT 隧道（见 httpGetViaProxy）。
 */
function normalizeProxyUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function detectSystemProxy() {
  const fromEnv = normalizeProxyUrl(
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
  );
  if (fromEnv) return { url: fromEnv, source: '环境变量' };

  if (process.platform !== 'win32') return { url: null, source: '无（非 Windows）' };

  try {
    const ps =
      `$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; ` +
      `if ($p -and $p.ProxyEnable -eq 1) { [string]$p.ProxyServer }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    }).trim();
    if (!out) return { url: null, source: '系统代理未启用' };
    // 可能是 "host:port" 或 "http=host:port;https=host:port"
    let picked = out;
    if (out.includes('=')) {
      const parts = Object.fromEntries(
        out.split(';').filter(Boolean).map((kv) => {
          const i = kv.indexOf('=');
          return [kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim()];
        })
      );
      picked = parts.https || parts.http || Object.values(parts)[0] || '';
    }
    const url = normalizeProxyUrl(picked);
    return { url, source: url ? `Windows 系统代理(${out})` : '系统代理解析失败' };
  } catch (e) {
    return { url: null, source: `系统代理探测失败: ${e.message}` };
  }
}

let PROXY = null; // URL 或 null

function setupNetwork({ disableProxy = false } = {}) {
  if (disableProxy) {
    PROXY = null;
    log('网络：已用 --no-proxy 禁用代理，直连 discord.com');
    return;
  }
  const info = detectSystemProxy();
  PROXY = info.url;
  log(PROXY ? `网络：${info.source} → ${PROXY.origin}（CONNECT 隧道）` : `网络：${info.source} —— 直连 discord.com`);
}

/**
 * 探测代理端口是否真的在监听。
 *
 * 为什么需要：实测踩过 —— 代理软件（v2rayN/xray）关掉后，所有请求都会失败，
 * 而原先的诊断会把它报成「疑似限流」（因为连接错误和 404 走了同一分支），
 * 于是日志一路显示"限流未定论"，但真正该做的是**去把代理打开**。
 * 这两种原因的处置完全不同，必须区分。
 */
function probeProxyPort(timeoutMs = 3000) {
  if (!PROXY) return Promise.resolve({ ok: true, skipped: true });
  return new Promise((resolve) => {
    const sock = net.connect({ host: PROXY.hostname, port: Number(PROXY.port || 80) });
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(v);
      }
    };
    sock.setTimeout(timeoutMs, () => finish({ ok: false, reason: '连接超时' }));
    sock.on('connect', () => finish({ ok: true }));
    sock.on('error', (e) => finish({ ok: false, reason: e.code || e.message }));
  });
}

/** chunked 传输解码（Discord 常用 Transfer-Encoding: chunked，没有 Content-Length） */
function decodeChunked(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf('\r\n', pos);
    if (nl < 0) break;
    const size = parseInt(buf.slice(pos, nl).toString('latin1').trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = nl + 2;
    out.push(buf.slice(start, start + size));
    pos = start + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * 零依赖 HTTP GET。走代理时用 CONNECT 隧道 + tls.connect；
 * 不用全局 fetch，因为全局 fetch 无法指定隧道 socket。
 */
function httpGetViaProxy(target, { timeoutMs = 20000 } = {}) {
  const u = new URL(target);
  const port = u.port || 443;
  return new Promise((resolve, reject) => {
    let head = null;
    let chunked = false;
    let need = null;
    let body = Buffer.alloc(0);
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      const text = (chunked ? decodeChunked(body) : body).toString('utf8');
      const raw = head.raw;
      req.destroy?.();
      tlsSock?.destroy();
      resolve({
        status: head.status,
        headers: { get: (k) => raw[String(k).toLowerCase()] ?? null },
        text: async () => text
      });
    };

    let tlsSock = null;
    const connectReq = http.request({
      host: PROXY.hostname,
      port: PROXY.port ? Number(PROXY.port) : 80,
      method: 'CONNECT',
      path: `${u.hostname}:${port}`,
      headers: { Host: `${u.hostname}:${port}`, 'Proxy-Connection': 'keep-alive' },
      timeout: timeoutMs
    });
    const req = connectReq;

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理拒绝 CONNECT：HTTP ${res.statusCode}`));
      }
      tlsSock = tls.connect({ socket, servername: u.hostname, ALPNProtocols: ['http/1.1'] }, () => {
        tlsSock.write(
          [
            `GET ${u.pathname}${u.search} HTTP/1.1`,
            `Host: ${u.hostname}`,
            `User-Agent: ${UA}`,
            'Accept: application/json',
            'Accept-Encoding: identity',
            'Connection: close',
            '',
            ''
          ].join('\r\n')
        );
      });
      tlsSock.setTimeout(timeoutMs, () => tlsSock.destroy(new Error('CONNECT 隧道超时')));
      tlsSock.on('error', (e) => {
        if (!done) reject(e);
      });
      tlsSock.on('data', (chunk) => {
        try {
          if (!head) {
            body = Buffer.concat([body, chunk]);
            const headEnd = body.indexOf('\r\n\r\n');
            if (headEnd < 0) return;
            const lines = body.slice(0, headEnd).toString('latin1').split('\r\n');
            const status = Number((lines[0].match(/^HTTP\/\d\.\d (\d+)/) || [])[1]);
            const raw = {};
            for (const line of lines.slice(1)) {
              const i = line.indexOf(':');
              if (i > 0) raw[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
            head = { status, raw };
            chunked = /chunked/i.test(raw['transfer-encoding'] || '');
            need = raw['content-length'] ? Number(raw['content-length']) : null;
            body = body.slice(headEnd + 4);
          } else {
            body = Buffer.concat([body, chunk]);
          }
          if (chunked) {
            if (/\r\n0\r\n\r\n$/.test(body.toString('latin1'))) finish();
          } else if (need == null || body.length >= need) {
            finish();
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('连接代理超时')));
    connectReq.on('error', reject);
    connectReq.end();
  });
}

/** 直连（无代理时） */
function httpGetDirect(target, { timeoutMs = 20000 } = {}) {
  const u = new URL(target);
  return new Promise((resolve, reject) => {
    const req = https.get(
      target,
      { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'identity' }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
            text: async () => Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error(`连接 ${u.hostname} 超时`)));
    req.on('error', reject);
  });
}

function httpGet(target, opts) {
  return PROXY ? httpGetViaProxy(target, opts) : httpGetDirect(target, opts);
}

/** 解析一个邀请码。永不抛异常，统一返回结构化结果。 */
async function resolveInvite(code, { timeoutMs = 20000 } = {}) {
  const url = `${API}/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`;
  try {
    const res = await httpGet(url, { timeoutMs });
    const retryAfter = Number(res.headers.get('retry-after') || 0) || null;
    let body = null;
    const raw = await res.text();
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        httpStatus: res.status,
        retryAfter,
        errorCode: body && body.code,
        message: (body && body.message) || `HTTP ${res.status}`,
        rawText: body ? null : raw.slice(0, 200)
      };
    }
    const g = body.guild || {};
    const p = body.profile || {};
    return {
      ok: true,
      httpStatus: res.status,
      code: body.code,
      type: body.type,
      expiresAt: body.expires_at ?? null,
      inviter: body.inviter ? { id: body.inviter.id, username: body.inviter.username } : null,
      guild: {
        id: g.id,
        name: g.name,
        verificationLevel: g.verification_level,
        vanityUrlCode: g.vanity_url_code ?? null,
        features: Array.isArray(g.features) ? g.features : [],
        description: g.description ?? null
      },
      memberCount: body.approximate_member_count ?? p.member_count ?? null,
      onlineCount: body.approximate_presence_count ?? p.online_count ?? null,
      channel: body.channel ? { id: body.channel.id, name: body.channel.name, type: body.channel.type } : null
    };
  } catch (e) {
    const detail = e.cause
      ? `${e.cause.code ?? e.cause.name ?? ''} ${e.cause.message ?? ''}`.trim()
      : e.code || null;
    return {
      ok: false,
      networkError: e.name === 'AbortError' ? 'timeout' : e.message,
      cause: detail || null
    };
  }
}

/** 带自愈的取数：分批 + 间隔 + 对"疑似限流"的 404 重试。 */
async function fetchWithHeal(code, cfg) {
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    const r = await resolveInvite(code);
    attempts.push(r);
    if (r.ok) return { ...r, attempts };
    const transient = r.httpStatus === 404 || r.httpStatus === 429 || r.httpStatus == null;
    if (!transient) break; // 403/401 等不是限流，重试无意义
    if (i < 2) {
      const wait = r.retryAfter ? r.retryAfter * 1000 : 3000 * (i + 1);
      log(`  ${code}: HTTP ${r.httpStatus ?? '网络错误'}，疑似限流，${Math.round(wait / 1000)}s 后重试…`);
      await sleep(wait);
    }
  }
  const last = attempts[attempts.length - 1];
  const allNotFound = attempts.length >= 2 && attempts.every((a) => a.httpStatus === 404);
  // 连续多次 404 才认"确实失效"；只一次且有重试仍 404 也接受（3 次都 404 已足够）
  return { ...last, notFoundConfirmed: allNotFound, attempts };
}

// ───────────────────────────── 判定 ─────────────────────────────

const CHANNEL_ROLE = {
  '1134565363506483352': '大厅 welcome',
  '1134601781352079420': '角色文字模板'
};

function roleOfChannel(id) {
  return CHANNEL_ROLE[id] ? `${CHANNEL_ROLE[id]}(${id})` : String(id);
}

/**
 * 比较两次探测，返回事件列表。
 * previous 为 null 时只建立基线，不产生事件。
 */
function detectEvents(cfg, previous, cur) {
  const events = [];
  if (!previous) return events;

  // D. 可用性变化。只有"上一次**已确认**失效"才有资格说重新开放——
  //    上一次只是网络错误/限流时不许报警（否则首次运行就会假警报，实测踩过）。
  if (!previous.ok && cur.ok) {
    if (previous.notFoundConfirmed) {
      events.push({ level: 'open', kind: 'INVITE_RESOLVED', text: '邀请链接从「已确认失效」恢复可解析 —— 极可能已重新开放' });
    } else {
      events.push({ level: 'info', kind: 'RECOVERED_FROM_ERROR', text: '上一轮取数失败（限流/网络），本轮恢复正常，不视为开放信号' });
    }
  }
  if (previous.ok && !cur.ok && cur.notFoundConfirmed) {
    events.push({ level: 'closed', kind: 'INVITE_GONE', text: `邀请链接已失效（连续 ${cur.attempts?.length ?? '?'} 次 404）` });
  }

  if (cur.ok) {
    const chanChanged = previous.channelId && cur.channel?.id && previous.channelId !== cur.channel.id;
    const countGrew = previous.memberCount != null && cur.memberCount != null
      && cur.memberCount - previous.memberCount >= cfg.minMemberDelta;
    const expChanged = previous.expiresAt !== cur.expiresAt;

    // A. 成员增长 = 最硬的"开放中"证据
    if (countGrew) {
      events.push({
        level: 'open',
        kind: 'MEMBERS_GREW',
        text: `成员数增长 +${cur.memberCount - previous.memberCount}（${previous.memberCount} → ${cur.memberCount}）—— 有人成功进群，开放中`
      });
    }

    // C. 落地频道切换
    if (chanChanged) {
      const toOpen = cfg.openChannelIds.includes(cur.channel.id);
      events.push({
        level: toOpen ? 'open' : 'info',
        kind: 'CHANNEL_SWITCHED',
        text: `邀请落地频道变化：${roleOfChannel(previous.channelId)} → ${roleOfChannel(cur.channel.id)}`
      });
    }

    // B. 限时/永久变化
    if (expChanged) {
      events.push({
        level: 'info',
        kind: 'EXPIRY_CHANGED',
        text: `过期时间变化：${previous.expiresAt ?? '永不过期'} → ${cur.expiresAt ?? '永不过期'}`
      });
    }

    // 兜底：成员数在动但没到阈值
    if (!countGrew && previous.memberCount != null && cur.memberCount != null
      && cur.memberCount - previous.memberCount > 0) {
      events.push({
        level: 'info',
        kind: 'MEMBERS_TICK',
        text: `成员数 +${cur.memberCount - previous.memberCount}（小于阈值 ${cfg.minMemberDelta}，视为噪声，不报警）`
      });
    }
  }

  // 同一轮里"可解析"和"成员增长"是同一件事的两种说法，只留最有信息量的一条
  const kinds = new Set(events.map((e) => e.kind));
  const pruned = events.filter((e) => !(e.kind === 'INVITE_RESOLVED' && kinds.has('MEMBERS_GREW')));
  const op = pruned.filter((e) => e.level === 'open');
  if (op.length <= 1) return pruned;
  return [op[0], ...pruned.filter((e) => e !== op[0])];
}

function snapshot(result) {
  if (!result.ok) {
    return {
      ok: false,
      httpStatus: result.httpStatus ?? null,
      notFoundConfirmed: !!result.notFoundConfirmed,
      errorCode: result.errorCode ?? null,
      message: result.message ?? result.networkError ?? null
    };
  }
  return {
    ok: true,
    httpStatus: result.httpStatus,
    guildId: result.guild.id,
    guildName: result.guild.name,
    verificationLevel: result.guild.verificationLevel,
    vanityUrlCode: result.guild.vanityUrlCode,
    memberCount: result.memberCount,
    onlineCount: result.onlineCount,
    channelId: result.channel?.id ?? null,
    channelName: result.channel?.name ?? null,
    expiresAt: result.expiresAt ?? null
  };
}

// ───────────────────────────── 通知 ─────────────────────────────

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => resolve({ err, stdout, stderr })
    );
  });
}

async function notifyToast(title, body) {
  if (process.platform !== 'win32') return false;
  const xml =
    `<toast duration="long"><visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>` +
    `</binding></visual><audio src="ms-winsoundevent:Notification.Looping.Alarm2" loop="false"/></toast>`;
  const script = [
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null`,
    `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null`,
    `$x = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$x.LoadXml(${psQuote(xml)})`,
    `$t = New-Object Windows.UI.Notifications.ToastNotification $x`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote('类脑邀请守望者')}).Show($t)`
  ].join('; ');
  const r = await runPowerShell(script);
  return !r.err;
}

async function notifySound() {
  if (process.platform !== 'win32') return false;
  const r = await runPowerShell(
    `[console]::beep(880,250); [console]::beep(1180,250); [console]::beep(1560,400)`
  );
  return !r.err;
}

async function notifyWebhook(url, text) {
  if (!url) return false;
  try {
    const res = await httpPostJson(url, { content: text.slice(0, 1900), username: '类脑邀请守望者' });
    if (!res.ok) log(`webhook 返回 HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    log(`webhook 推送失败：${e.message}`);
    return false;
  }
}

/** 极简 POST JSON（webhook 用），同样支持代理隧道 */
function httpPostJson(target, payload, { timeoutMs = 20000 } = {}) {
  const u = new URL(target);
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = [
    `POST ${u.pathname}${u.search} HTTP/1.1`,
    `Host: ${u.hostname}`,
    `User-Agent: ${UA}`,
    'Content-Type: application/json',
    `Content-Length: ${data.length}`,
    'Connection: close',
    '',
    ''
  ].join('\r\n');

  const parse = (raw) => {
    const headEnd = raw.indexOf('\r\n\r\n');
    const status = Number((raw.slice(0, headEnd).match(/^HTTP\/\d\.\d (\d+)/) || [])[1]);
    return { ok: status >= 200 && status < 300, status };
  };

  return new Promise((resolve, reject) => {
    const send = (sock) => {
      sock.setTimeout(timeoutMs, () => sock.destroy(new Error('webhook 超时')));
      sock.on('error', reject);
      sock.on('data', (c) => {
        try {
          const r = parse(c.toString('latin1'));
          sock.destroy();
          resolve(r);
        } catch (e) {
          reject(e);
        }
      });
      sock.write(head);
      sock.write(data);
    };

    if (!PROXY) {
      send(tls.connect({ host: u.hostname, port: u.port || 443, servername: u.hostname }));
      return;
    }
    const cr = http.request({
      host: PROXY.hostname,
      port: PROXY.port ? Number(PROXY.port) : 80,
      method: 'CONNECT',
      path: `${u.hostname}:443`,
      headers: { Host: `${u.hostname}:443` },
      timeout: timeoutMs
    });
    cr.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`代理拒绝 CONNECT：HTTP ${res.statusCode}`));
      send(tls.connect({ socket, servername: u.hostname }));
    });
    cr.on('error', reject);
    cr.end();
  });
}

async function announce(cfg, title, lines) {
  const body = lines.join('\n');
  log(`★ ${title} —— ${body.replace(/\n/g, ' / ')}`);
  const done = [];
  if (cfg.notify.toast) done.push('toast=' + (await notifyToast(title, body)));
  if (cfg.notify.sound) done.push('sound=' + (await notifySound()));
  if (cfg.notify.webhookUrl) done.push('webhook=' + (await notifyWebhook(cfg.notify.webhookUrl, `**${title}**\n${body}`)));
  if (done.length) log('  通知通道：' + done.join(' '));
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function runOnce(cfg, state, { silentIfNoEvent = false } = {}) {
  const codes = [cfg.inviteCode, ...cfg.altCodes.filter((c) => c !== cfg.inviteCode)];

  // 先探代理端口：代理没开时所有请求都会失败，此时报「疑似限流」是误导
  // （两者处置完全不同：一个是去开代理，一个是等限流恢复）。
  const pre = await probeProxyPort();
  const proxyDown = pre.ok === false;
  if (proxyDown) {
    log(`⚠ 代理不可用：${PROXY.origin} 无法连接（${pre.reason}）`);
    log('  → 请先启动代理软件（如 v2rayN / xray），确认其端口在监听后再重试。');
    log('  → 本轮不报"限流"，也不改变基线（避免把网络故障误记成状态变化）。');
    if (cfg.notify.webhookUrl) {
      await notifyWebhook(cfg.notify.webhookUrl, `⚠ 类脑守望者：代理不可用（${PROXY.origin}，${pre.reason}）——本轮未检测，请启动代理。`);
    }
    return state;
  }

  for (const code of codes) {
    const cur = await fetchWithHeal(code, cfg);
    const prev = state.watched[code] || null;
    const events = detectEvents(cfg, prev ? normalizePrev(prev) : null, cur);
    const snap = snapshot(cur);

    // ⚠ 取数失败时**不能**用失败快照覆盖原状态！
    // snapshot() 在失败时不带 memberCount，直接覆盖会把有效基线抹成 undefined，
    // 之后 delta 永远算不出来 —— 等代理恢复后真正的"开放"信号会被漏掉。
    // （实测踩过：代理关闭期间跑了一次 --once，基线就被清空了。）
    // 正确做法：只追加失败信息，保留上一次成功的基线。
    if (cur.ok) {
      state.watched[code] = { ...snap, at: new Date().toISOString() };
    } else if (prev) {
      state.watched[code] = {
        ...prev,
        lastError: snap.message || snap.httpStatus || 'unknown',
        lastErrorAt: new Date().toISOString()
      };
    } else {
      // 从未成功过，只能记录失败状态（此时没有基线可丢）
      state.watched[code] = { ...snap, at: new Date().toISOString() };
    }

    const statusText = cur.ok
      ? `OK  ${cur.guild.name}  成员=${cur.memberCount} 在线=${cur.onlineCount} 验证等级=${cur.guild.verificationLevel} 落地=${roleOfChannel(cur.channel?.id)} 过期=${cur.expiresAt ?? '永不过期'}`
      : cur.httpStatus
        ? `不可用 HTTP=${cur.httpStatus}${cur.notFoundConfirmed ? '（已确认失效）' : '（疑似限流，未定论）'}`
        : PROXY
          ? '不可用：连接失败（非 HTTP 错误，检查代理/网络）'
          : '不可用：直连失败（本机直连 discord.com 不通属正常，需启用代理）';
    log(`[${code}] ${statusText}`);

    // ---- 报警去重（冷却期）----
    // 实测事故：2026-09-17 社区开放约 27 分钟，成员数持续上涨，
    // 每轮都满足"上涨≥阈值" => 本机连推 6 条、加上云端共 11 条。
    // 而 Server酱 免费版每天只有 5 条额度 —— **警报风暴把通路自己打爆了**，
    // 结果最该收到的那条反而没到。
    // 所以：同一开放窗口内只推一次，冷却期内不再重复推（仍然记日志）。
    const cooldownMs = (cfg.alertCooldownMinutes ?? 30) * 60 * 1000;
    const lastAlert = state.lastAlertAt ? new Date(state.lastAlertAt).getTime() : 0;
    const inCooldown = lastAlert && Date.now() - lastAlert < cooldownMs;

    for (const ev of events) {
      state.log.push({ at: new Date().toISOString(), code, ...ev });
      if (ev.level === 'open') {
        if (inCooldown) {
          const leftMin = Math.ceil((cooldownMs - (Date.now() - lastAlert)) / 60000);
          log(`  · 已检测到开放信号（${ev.kind}），但处于冷却期（还剩约 ${leftMin} 分钟），本次不重复推送`);
          log(`    —— 避免同一开放窗口内多次推送耗尽推送额度（历史事故见代码注释）`);
          continue;
        }
        await announce(cfg, `★ 类脑可能已开放加入！（${code}）`, [
          ev.text,
          `立刻试：https://discord.com/invite/${code}`,
          `短链：https://discord.gg/${cur.ok && cur.guild.vanityUrlCode ? cur.guild.vanityUrlCode : ''}`,
          `当前成员 ${cur.memberCount ?? '?'} / 在线 ${cur.onlineCount ?? '?'}`,
          `（${cfg.alertCooldownMinutes ?? 30} 分钟内不再重复提醒）`
        ].filter(Boolean));
        state.lastAlertAt = new Date().toISOString();
      } else if (ev.level === 'closed') {
        await announce(cfg, `类脑邀请链接失效了（${code}）`, [ev.text]);
        state.lastAlertAt = new Date().toISOString();
      } else if (!silentIfNoEvent) {
        log(`  · 事件(${ev.kind})：${ev.text}`);
      }
    }

    if (code !== codes[codes.length - 1]) await sleep(1500); // 多码之间留间隔，避开反枚举限流
  }

  saveState(state);
  return state;
}

/** 旧状态没有嵌套结构时的兼容处理 */
function normalizePrev(prev) {
  return {
    ok: !!prev.ok,
    httpStatus: prev.httpStatus ?? null,
    notFoundConfirmed: !!prev.notFoundConfirmed,
    memberCount: prev.memberCount ?? null,
    channelId: prev.channelId ?? null,
    expiresAt: prev.expiresAt ?? null
  };
}

/** 离线自检：不联网，把四条判据各演一遍，确认报警器本身可信 */
async function simulate(cfg) {
  const fake = (o) => ({ ok: true, httpStatus: 200, guild: { id: cfg.guildId, name: cfg.guildName, verificationLevel: 3, vanityUrlCode: 'odysseia' }, memberCount: 381862, onlineCount: 16469, channel: { id: '1134601781352079420', name: '👼｜角色文字模板' }, expiresAt: null, ...o });

  // 阈值相关的用例必须**自带阈值**，不能依赖 monitor.config.json 里的当前值 ——
  // 否则用户一改配置（例如把 minMemberDelta 调成 1），自检就会"失败"，
  // 而那其实是配置生效的正确表现。实测踩过这个坑：测试做了对配置的隐含假设。
  const cfgThr2 = { ...cfg, minMemberDelta: 2 };
  const cases = [
    ['A 成员增长 → 必须 open', fake({ memberCount: 381900 }), fake({}), cfgThr2],
    ['A 增长 1 人（阈值 2，噪声）→ 不许 open', fake({ memberCount: 381863 }), fake({}), cfgThr2],
    ['A2 增长 2 人（阈值 2，恰好达标）→ 必须 open', fake({ memberCount: 381864 }), fake({}), cfgThr2],
    ['A3 增长 1 人（阈值 1）→ 必须 open', fake({ memberCount: 381863 }), fake({}), { ...cfg, minMemberDelta: 1 }],
    // B 用例：基线必须带 channelId，否则判定里的 `previous.channelId &&` 会短路，
    // 根本走不到"频道切换"分支（实测踩过：fake({}) 作为基线缺少 channelId，
    // 导致这条断言永远失败 —— mock 少造了数据，不是代码有问题）。
    ['B 落地频道切换（非 openChannelIds）→ 必须 info', fake({ channel: { id: '1139999999999999999', name: 'other' } }), fake({ channelId: '1134601781352079420' })],
    ['C 落地频道切到 openChannelIds → 必须 open', fake({ channel: { id: '1134565363506483352', name: 'welcome' } }), fake({ channelId: '1134601781352079420' })],
    ['D 从 404 变可解析 → 必须 open', fake({}), { ok: false, httpStatus: 404, notFoundConfirmed: true, attempts: [1, 2, 3] }],
    ['D 从可解析变 404 → 必须 closed', { ok: false, httpStatus: 404, notFoundConfirmed: true, attempts: [1, 2, 3] }, fake({})],
    ['E 404 但未确认 → 不许 closed', { ok: false, httpStatus: 404, notFoundConfirmed: false, attempts: [1] }, fake({})],
    ['G 上轮仅网络错误 → 不许 open（防首次假警报）', fake({}), { ok: false, networkError: 'fetch failed', notFoundConfirmed: false }],
    ['F 首次建立基线 → 不许任何事件', fake({}), null]
  ];

  const cfg2 = { ...cfg, openChannelIds: ['1134565363506483352'] };
  let pass = 0;
  let fail = 0;
  for (const [name, cur, prev, caseCfg] of cases) {
    // 每个用例可以自带配置（阈值等），没带就用默认的 cfg2
    const evs = detectEvents(caseCfg || cfg2, prev, cur);
    const kinds = evs.map((e) => `${e.level}:${e.kind}`).join(',') || '(无)';
    const expectOpen = /必须 open/.test(name);
    const expectClosed = /必须 closed/.test(name);
    const expectInfo = /必须 info/.test(name);
    const forbidOpen = /不许 open/.test(name);
    const forbidClosed = /不许 closed/.test(name);
    const forbidAny = /不许任何事件/.test(name);

    let ok = true;
    if (expectOpen && !evs.some((e) => e.level === 'open')) ok = false;
    if (expectClosed && !evs.some((e) => e.level === 'closed')) ok = false;
    if (expectInfo && !evs.some((e) => e.level === 'info')) ok = false;
    if (forbidOpen && evs.some((e) => e.level === 'open')) ok = false;
    if (forbidClosed && evs.some((e) => e.level === 'closed')) ok = false;
    if (forbidAny && evs.length > 0) ok = false;

    if (ok) { pass++; log(`  PASS  ${name}  → ${kinds}`); }
    else { fail++; log(`  FAIL  ${name}  → ${kinds}`); }
  }
  log(`自检结果：${pass} 通过 / ${fail} 失败`);
  return fail === 0 ? 0 : 1;
}

/** 手动体检一批邀请码（自动限速，避开反枚举 404） */
async function checkCodes(codes) {
  log(`体检 ${codes.length} 个邀请码（每个间隔 1.2s，规避反枚举限流）…`);
  for (let i = 0; i < codes.length; i++) {
    const r = await resolveInvite(codes[i]);
    if (r.ok) {
      log(`  ${String(i + 1).padStart(2)}. OK   ${codes[i].padEnd(24)} ${r.guild.name}  成员=${r.memberCount} 验证等级=${r.guild.verificationLevel} 过期=${r.expiresAt ?? '永不过期'} 落地=${r.channel?.name}`);
    } else {
      log(`  ${String(i + 1).padStart(2)}. FAIL ${codes[i].padEnd(24)} HTTP=${r.httpStatus ?? 'n/a'} code=${r.errorCode ?? '-'}`);
    }
    if (i < codes.length - 1) await sleep(1200);
  }
}

// ───────────────────────────── 入口 ─────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node monitor.mjs [--once|--daemon|--baseline-only|--simulate|--check <code>...]');
    return 0;
  }

  if (argv.includes('--simulate')) {
    log('离线自检（不联网）——验证报警判据本身是否正确');
    return await simulate(cfg);
  }

  setupNetwork({ disableProxy: argv.includes('--no-proxy') });

  const checkIdx = argv.indexOf('--check');
  if (checkIdx >= 0) {
    const codes = argv.slice(checkIdx + 1).filter((a) => !a.startsWith('--'));
    if (!codes.length) {
      console.error('--check 后面要跟至少一个邀请码');
      return 2;
    }
    await checkCodes(codes);
    return 0;
  }

  const state = loadState();
  const baselineOnly = argv.includes('--baseline-only');

  if (baselineOnly) {
    log('仅重置基线（不触发通知）');
    for (const code of [cfg.inviteCode, ...cfg.altCodes]) {
      const r = await fetchWithHeal(code, cfg);
      state.watched[code] = { ...snapshot(r), at: new Date().toISOString() };
      log(`  [${code}] 基线 = ${r.ok ? `成员 ${r.memberCount} / 落地 ${r.channel?.name}` : `HTTP ${r.httpStatus}`}`);
      if (r.ok && cfg.openChannelIds.includes(r.channel?.id)) {
        log('  ⚠ 注意：基线落地频道就在 openChannelIds 里 —— 按你的配置口径，它现在可能已经开放了，立刻手动试一次链接。');
      }
      await sleep(1500);
    }
    saveState(state);
    return 0;
  }

  if (argv.includes('--once')) {
    await runOnce(cfg, state);
    return 0;
  }

  // 常驻轮询
  log(`常驻模式：每 ${cfg.pollSeconds}s 检查一次。Ctrl+C 退出。`);
  let backoff = 0;
  let stop = false;
  process.on('SIGINT', () => {
    log('收到退出信号，收尾…');
    stop = true;
  });
  while (!stop) {
    try {
      await runOnce(cfg, state);
      backoff = 0;
    } catch (e) {
      backoff = Math.min(backoff ? backoff * 2 : 60, 1800);
      log(`本轮异常：${e.message}；${backoff}s 后重试`);
    }
    const wait = (backoff || cfg.pollSeconds) * 1000;
    const until = Date.now() + wait;
    while (!stop && Date.now() < until) {
      await sleep(Math.min(1000, until - Date.now()));
    }
  }
  saveState(state);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('致命错误:', e);
    process.exit(1);
  });
