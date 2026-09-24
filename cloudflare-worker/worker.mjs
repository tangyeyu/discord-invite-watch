/**
 * 类脑 ΟΔΥΣΣΕΙΑ 邀请守望者 —— Cloudflare Worker 版
 *
 * 与本地 monitor.mjs 的区别：跑在 Cloudflare 边缘节点上，
 * **你电脑关机、断网、代理挂掉都照常工作**，且天然在墙外可直连 discord.com。
 *
 * 判定逻辑与本地版一致（实测依据）：
 *   暂停期间 Discord 冻结 approximate_member_count；
 *   一旦恢复开放，计数开始上涨 → 视为「开放了」，立刻推送通知。
 *
 * 部署见 README-cloud.md。需要：KV 命名空间 + 每分钟 cron + 一个 Discord webhook。
 */

// ---------------------------------------------------------------- 配置
// 全部可由环境变量覆盖（wrangler.toml 的 [vars] 或 wrangler secret），
// 所以换一个社区不需要改代码。默认值指向「类脑 ΟΔΥΣΣΕΙΑ」（本项目的缘起）。
//
// 要监控别的服务器时，把 INVITE_CODE 换成目标邀请码即可。
// ALT_CODE 是可选的第二个码（比如自定义短链），用于交叉验证；
// 留空则跳过。两个码落在不同频道时，还能作为额外的变化信号。
const cfg = (env) => ({
  inviteCode: (env && env.INVITE_CODE) || 'HWNkueX34q',
  altCode: env && env.ALT_CODE !== undefined ? env.ALT_CODE : 'odysseia',
  threshold: Number((env && env.THRESHOLD) || 1),
  // 服务器标识校验：ID 优先（稳定），名称次要（可能为空）
  expectGuildId: (env && env.EXPECT_GUILD_ID) || '',
  expectGuild: (env && env.EXPECT_GUILD) || '',
  pingUserId: (env && env.PING_USER_ID) || '',
  // 报警冷却（分钟）：同一开放窗口内只推一次。
  // 实测事故：2026-09-17 社区开放约 27 分钟，成员数持续上涨，每分钟一轮 =>
  // 本机+云端共推出 11 条，而 Server酱 免费版每天仅 5 条额度，
  // 额度被前几条打光，最该收到的那条反而没到。
  cooldownMinutes: Number((env && env.ALERT_COOLDOWN_MINUTES) || 30)
});

const KV_KEY = 'baseline';
const STATE_TTL = 60 * 60 * 24 * 30;

const API = 'https://discord.com/api/v10';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 带超时的 fetch —— 没有超时的话，对端不响应会把 Worker 拖到被平台杀掉（1101） */
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getInvite(code) {
  const url = `${API}/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.ok) {
        const j = await res.json();
        return {
          ok: true,
          memberCount: j.approximate_member_count ?? null,
          onlineCount: j.approximate_presence_count ?? null,
          // guildId 比 name 稳定：实测从 Cloudflare 边缘拿到的响应里
          // guild.name 可能为空（guildName 变 null），而 guild.id 一直有值。
          // 所以「邀请码被改指到别的服务器」这项校验优先用 ID。
          guildId: j.guild && j.guild.id,
          guildName: j.guild && j.guild.name,
          channelId: j.channel && j.channel.id,
          channelName: j.channel && j.channel.name,
          verificationLevel: j.guild && j.guild.verification_level,
          expiresAt: j.expires_at ?? null
        };
      }
      // 实测：Discord 反枚举限流返回 404 而非 429，需要退避重试
      if (res.status === 404 || res.status === 429) {
        const ra = Number(res.headers.get('retry-after') || 0);
        await new Promise((r) => setTimeout(r, ra ? ra * 1000 : 2500 * (attempt + 1)));
        continue;
      }
      // 非 404/429 的 HTTP 错误：把状态码与响应体片段带出去，便于事后定位
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 120);
      } catch {
        /* 拿不到就算了 */
      }
      return { ok: false, status: res.status, detail };
    } catch (e) {
      // 不要吞掉异常原因：否则只会看到 "FETCH_FAILED(unreachable)"，
      // 分不清是超时 / DNS / TLS 还是被拦。
      // 注意：Workers 运行时里 fetch 抛出的对象结构可能和 Node 不同，
      // 所以把能拿到的字段都尝试一遍（实测出现过 message 为空的情况）。
      const parts = [];
      if (e) {
        parts.push(`name=${e.name || typeof e}`);
        if (e.message) parts.push(`msg=${e.message}`);
        if (e.cause) parts.push(`cause=${e.cause.code || e.cause.message || String(e.cause)}`);
        if (!e.message && !e.cause) {
          try {
            parts.push(`raw=${String(e).slice(0, 120)}`);
          } catch {
            parts.push('raw=<unstringifiable>');
          }
        }
      } else {
        parts.push('thrown=null');
      }
      lastError = parts.join(' ');
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { ok: false, status: 'unreachable', detail: lastError || '未知网络错误（3 次重试均失败）' };
}

/**
 * 推送到 Server酱（推微信）。
 *
 * 为什么需要它：安卓版 Discord 的推送走 Google FCM，国内没有 Google 服务框架
 * 或 GMS 连不上时**收不到任何通知**；而 Discord 本身也要梯子。
 * Server酱把这些绕开了：一个 HTTPS 请求就把消息推到微信。
 *
 * 兼容两种 SendKey：
 *   · SCT 开头  -> 新版接口 https://sctapi.ftqq.com/<key>.send
 *   · 其它      -> 旧版接口 https://sc.ftqq.com/<key>.send
 * 两个都是 POST 表单：title=标题&desp=正文。
 */
async function pushServerChan(env, title, body) {
  const key = env.SERVERCHAN_KEY;
  if (!key) return { skipped: true };
  const isNew = /^sct/i.test(key.trim());
  const url = isNew
    ? `https://sctapi.ftqq.com/${encodeURIComponent(key.trim())}.send`
    : `https://sc.ftqq.com/${encodeURIComponent(key.trim())}.send`;
  try {
    const form = new URLSearchParams({ title, desp: body });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text.slice(0, 200) };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * 统一推送入口：所有已配置的通路都发一遍。
 * 多通路是刻意的 —— 微信推送（Server酱）与 Discord webhook 互为冗余，
 * 任何一条挂了另一条还能到。
 */
async function pushAll(env, title, body, discordContent) {
  const out = {};
  if (env.SERVERCHAN_KEY) out.serverchan = await pushServerChan(env, title, body);
  if (env.DISCORD_WEBHOOK) out.discord = await push(env, discordContent ?? body);
  if (!Object.keys(out).length) out.none = { skipped: true, hint: '未配置任何推送通路' };
  return out;
}

async function push(env, content) {
  if (!env.DISCORD_WEBHOOK) return { skipped: true };
  try {
    const res = await fetch(env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        username: (env && env.WEBHOOK_NAME) || 'Invite Watcher',
        allowed_mentions: cfg(env).pingUserId ? { parse: ['users'] } : { parse: [] }
      })
    });
    return { status: res.status, ok: res.ok };
  } catch (e) {
    return { error: String(e) };
  }
}

function fmt(n) {
  return n == null ? '?' : String(n);
}

async function state(env) {
  try {
    const raw = await env.LEINA_KV.get(KV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function saveState(env, obj) {
  await env.LEINA_KV.put(KV_KEY, JSON.stringify(obj), { expirationTtl: STATE_TTL });
}

/** 记录事件，最多保留 50 条，便于事后对账 */
async function addEvent(env, ev) {
  const s = (await state(env)) || {};
  const log = Array.isArray(s.log) ? s.log : [];
  log.push(ev);
  s.log = log.slice(-50);
  await saveState(env, s);
}

async function check(env) {
  const now = new Date().toISOString();
  const c = cfg(env);
  const cur = await getInvite(c.inviteCode);
  const alt = c.altCode ? await getInvite(c.altCode) : { ok: false };
  const prev = await state(env);

  const result = {
    at: now,
    invite: c.inviteCode,
    ok: cur.ok,
    memberCount: cur.memberCount ?? null,
    onlineCount: cur.onlineCount ?? null,
    altMemberCount: alt.memberCount ?? null,
    altChannel: alt.channelName ?? null,
    verificationLevel: cur.verificationLevel ?? null,
    // 邀请码被回收改指到别的服务器时能立刻看出来（配了 EXPECT_GUILD/EXPECT_GUILD_ID 才判定）
    guildId: cur.guildId ?? null,
    guildName: cur.guildName ?? null,
    events: []
  };

  // 首次运行只建立基线，绝不报警（避免假警报 —— 本地版实测踩过这个坑）
  if (!prev) {
    await saveState(env, { baseline: cur.memberCount, at: now, log: [] });
    const who = cur.guildName || c.expectGuild || c.inviteCode;
    const p = await pushAll(
      env,
      `邀请守望者已上线（${who}）`,
      `✅ 云端哨兵已上线（每分钟检查一次）\n\n监控对象：${who}\n基线成员数：${fmt(cur.memberCount)}\n之后只要计数上涨就会通知你。\n\n注意：邀请处于 paused 时成员数是冻结的，不变属正常。`,
      `✅ 邀请守望者已上线\n监控：${who}\n基线成员数：${fmt(cur.memberCount)}\n之后只要计数上涨就会通知你。`
    );
    result.events.push('BASELINE_SET');
    result.push = p;
    return result;
  }

  const prevCount = prev.baseline;
  result.baseline = prevCount ?? null;

  // 邀请被改指到别的服务器要能看出来（否则会误报"开放"）。
  // 优先用 guildId 比对：实测从 Cloudflare 边缘拿到的响应里 guild.name 可能为空，
  // 只看 name 会导致这项保护静默失效。name 仅作为次要判据（两者都配时任一不符即告警）。
  const idMismatch = c.expectGuildId && cur.guildId && cur.guildId !== c.expectGuildId;
  const nameMismatch = c.expectGuild && cur.guildName && !cur.guildName.includes(c.expectGuild);
  if (cur.ok && (idMismatch || nameMismatch)) {
    const actual = idMismatch ? `${cur.guildId}（ID 不符）` : `${cur.guildName}（名称不符）`;
    result.events.push(`GUILD_MISMATCH(${actual})`);
    await pushAll(
      env,
      '⚠ 邀请码指向的服务器变了',
      `期望「${c.expectGuildId || c.expectGuild}」，实际「${actual}」。\n邀请码可能已被回收/改指，请人工确认——此时"成员数上涨"已不能代表目标社区开放。`,
      `⚠ 邀请码指向的服务器变了：期望 ${c.expectGuildId || c.expectGuild}，实际 ${actual}`
    );
    return result;
  }

  if (cur.ok && cur.memberCount != null && prevCount != null) {
    const delta = cur.memberCount - prevCount;
    if (delta >= c.threshold) {
      // 冷却期内不重复推送（同一开放窗口只推一次）
      const cooldownMs = c.cooldownMinutes * 60 * 1000;
      const lastAlert = prev.lastAlertAt ? new Date(prev.lastAlertAt).getTime() : 0;
      if (lastAlert && Date.now() - lastAlert < cooldownMs) {
        const leftMin = Math.ceil((cooldownMs - (Date.now() - lastAlert)) / 60000);
        result.events.push(`OPEN_SUPPRESSED(delta=${delta},cooldownLeft=${leftMin}min)`);
        await saveState(env, { ...(await state(env)), baseline: cur.memberCount, at: now });
        return result;
      }

      // ★ 核心信号：恢复开放
      const ping = c.pingUserId ? `<@${c.pingUserId}> ` : '';
      const title = `★ ${c.expectGuild || '目标社区'}可能已恢复开放！`;
      const msg = [
        `${ping}🔔 **可能已恢复开放！**`,
        '',
        `成员数上涨 **+${delta}**（${prevCount} → ${cur.memberCount}）`,
        `说明邀请暂停已解除、有人成功进群。`,
        '',
        `👉 立刻加入：https://discord.com/invite/${c.inviteCode}`,
        c.altCode ? `短链：https://discord.gg/${c.altCode}` : '',
        '',
        `当前在线 ${fmt(cur.onlineCount)}｜验证等级 ${fmt(cur.verificationLevel)}`
      ].filter((x) => x !== '').join('\n');
      const r = await pushAll(
        env,
        title,
        [
          `成员数上涨 +${delta}（${prevCount} → ${cur.memberCount}）`,
          `说明邀请暂停已解除、已经有人成功进群。`,
          ``,
          `【立刻点这个链接加入】`,
          `https://discord.com/invite/${c.inviteCode}`,
          c.altCode ? `短链：https://discord.gg/${c.altCode}` : '',
          ``,
          `注意：本服务器验证等级为最高（需要【已验证手机号】的账号）。`,
          `当前在线 ${fmt(cur.onlineCount)}｜验证等级 ${fmt(cur.verificationLevel)}`,
          `（${c.cooldownMinutes} 分钟内不再重复提醒，避免耗尽推送额度）`
        ].filter((x) => x !== '').join('\n'),
        msg
      );
      result.events.push(`OPEN_DETECTED(delta=${delta})`);
      result.push = r;
      await addEvent(env, { at: now, kind: 'OPEN', delta, from: prevCount, to: cur.memberCount });
      // 报警后把基线推到当前值，并记录报警时间（冷却期据此计算）
      await saveState(env, { ...(await state(env)), baseline: cur.memberCount, at: now, lastAlertAt: now });
    } else if (delta < 0) {
      // 计数下降（有人退群/清理），只记录不报警
      result.events.push(`MEMBERS_DROPPED(delta=${delta})`);
      await addEvent(env, { at: now, kind: 'DROP', delta, from: prevCount, to: cur.memberCount });
      await saveState(env, { ...(await state(env)), baseline: cur.memberCount, at: now });
    } else {
      result.events.push('NO_CHANGE');
      const s = (await state(env)) || {};
      s.at = now;
      s.lastSeen = cur.memberCount;
      await saveState(env, s);
    }
  } else if (!cur.ok) {
    // 带上原因：只写 FETCH_FAILED(unreachable) 无法区分超时/DNS/TLS/被拦
    result.events.push(`FETCH_FAILED(status=${cur.status}${cur.detail ? ', ' + cur.detail : ''})`);
    result.fetchOk = false;
    // 取数失败不改变基线、不报警（限流也会 404，基线必须保住 —— 否则恢复后
    // prevCount 为 null，delta 永远算不出来，真正的开放信号会被漏掉）
  }

  return result;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env));
  },

  async fetch(req, env) {
    try {
      const url = new URL(req.url);

      // 手动重置基线：/reset
      if (url.pathname === '/reset') {
        const cur = await getInvite(cfg(env).inviteCode);
        await saveState(env, { baseline: cur.memberCount, at: new Date().toISOString(), log: [] });
        return Response.json({ ok: true, reset: true, baseline: cur.memberCount });
      }

      // 立即检查一次（不等待 cron）：/ 或 /check
      const r = await check(env);
      return Response.json(r, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      // 把真实错误暴露出来，否则线上只会看到 error 1101，无法定位
      return Response.json(
        {
          ok: false,
          error: String(e && e.message ? e.message : e),
          stack: String(e && e.stack ? e.stack : '').split('\n').slice(0, 6),
          envKeys: env ? Object.keys(env) : null,
          hasKV: Boolean(env && env.LEINA_KV),
          hasJson: typeof Response.json === 'function'
        },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      );
    }
  }
};
