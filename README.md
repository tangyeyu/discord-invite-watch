# discord-invite-watch

**当 Discord 服务器的邀请处于 `paused`（暂停加入）状态时，在它重新开放的第一时间通知你。**

起因是想加一个暂时关闭加入的中文 Discord 社区（30 万+ 成员）。
Discord 不提供任何"开放了叫我"的机制，而手动反复点链接既费时又容易误判 ——
于是做了这套工具：**自动检测 + 多通路推送**，把"点链接"这一步留给人（约 2 秒）。

```
   Cloudflare Worker ──每分钟──┐
                               ├──► 成员数上涨 ⇒ 推送（微信 / Discord webhook）
   本机计划任务 ────每 2 分钟──┘
```

---

## 核心原理：为什么"成员数"能判断开放与否

这是本项目最关键的发现，也是它能工作的原因。

**Discord 的邀请暂停状态，在公开 API 里读不到。** 已逐项验证过：

| 尝试 | 结果 |
|---|---|
| 邀请对象里有 `paused` 字段吗 | ❌ 不存在（与正常开放的服务器字段完全一致） |
| `guild.features` 含 `INVITES_DISABLED` 吗 | ❌ 不含 |
| `/guilds/{id}/invites`、`/vanity-url`、`/guilds/{id}` | ❌ HTTP 401（需鉴权） |
| `/widget.json` / `/public-updates` / discovery 端点 | ❌ 403 / 404 |

**但有个可靠的间接信号：暂停会把 `approximate_member_count` 冻结。**

对一个 38 万人、1.6 万在线的服务器连续采样 137 秒：

| 时刻 | 成员数 | 在线数 |
|---|---|---|
| 22:25:27 | 381861 | 8897 |
| 22:26:13 | 381861 | 8897 |
| 22:26:58 | 381861 | 8897 |
| 22:27:43 | 381861 | 8897 |

**一动不动。** 因为暂停期间无人能进 ⇒ 计数冻结；一旦恢复，计数就会上涨。

于是判定条件极简：**成员数相对基线上涨 ≥ 阈值 ⇒ 判定为"已开放"并立刻推送。**
默认阈值 1，即**第一个挤进去的人**就会触发通知。

---

## 快速开始

### 1. 本机守望者（只需 Node ≥ 18，零依赖）

```powershell
# 自检判据逻辑（离线，应全部 PASS）
node monitor.mjs --simulate

# 建立基线
node monitor.mjs --baseline-only

# 装成 Windows 计划任务（默认每 5 分钟；建议 2 分钟）
powershell -File install-task.ps1 -IntervalMinutes 2

# 随时体检
node check.mjs
```

改 `monitor.config.json` 换目标服务器：

| 字段 | 说明 |
|---|---|
| `inviteCode` | 要监控的邀请码（`discord.gg/xxx` 里的 `xxx`） |
| `altCodes` | 额外的码（如自定义短链），交叉验证用 |
| `pollSeconds` | 轮询间隔 |
| `minMemberDelta` | 成员数上涨多少算"开放"（暂停期间冻结，1 即可） |
| `notify.webhookUrl` | 推送用的 webhook |

### 2. 云端哨兵（电脑关机也继续盯）

```powershell
cd cloudflare-worker
powershell -File deploy.ps1        # 自动：登录 → 建 KV → 写 secret → 部署 → 线上验证
```

详见 [`cloudflare-worker/README-cloud.md`](cloudflare-worker/README-cloud.md)。

### 3. 推送通路（三选一或全要）

```powershell
cd cloudflare-worker
node setup-push.mjs sct     <Server酱 SendKey>    # → 微信（推荐，绕开 Google 服务问题）
node setup-push.mjs discord <webhook URL>         # → Discord
node setup-push.mjs list                          # 查看已配置
```

**为什么推荐 Server酱**：安卓版 Discord 的推送走 Google FCM，
在国内没有 Google 服务框架（GMS）时**收不到任何通知**；
Server酱只需一个 HTTPS 请求就把消息推到微信，不依赖 Google、也不依赖 Discord 推送。

---

## 一键体检

```
双击 check-status.cmd
```

一次查三件事，避免看到"未开启"却分不清是"真没开"还是"哨兵挂了"：

| 检查项 | 判定依据 |
|---|---|
| **社区是否开启** | 成员数与基线对比 → `OPEN` / `PAUSED` / `SHRINK` / `UNKNOWN` |
| **本机守望者** | 计划任务是否存在、启用、上次结果 |
| **云端哨兵** | Worker 是否响应（自动用 DoH 绕开 DNS 污染） |

---

## 其他可选部署方式

| 方式 | 检测精度 | 成本 | 关机后可用 |
|---|---|---|---|
| 本机计划任务 | 2 分钟 | 0 | ❌ |
| **Cloudflare Worker** | **1 分钟** | **0** | **✅** |
| Linux VPS / 树莓派 | 任意 | ¥10–30/月 或一次性硬件 | ✅ |
| GitHub Actions cron | 5–40 分钟 | 0 | ✅（但延迟不可控，仅作备份） |

Linux 一键部署：`bash deploy-vps.sh install`

---

## 排查过程中踩到的坑（都已修进代码）

这些都是实测踩出来的，记录在此免得后来者重走：

### 1. Discord 反枚举限流返回 `404` 而不是 `429`

连续快速请求 20 个邀请码 → **全部 404**；同样这些码间隔 400ms 重发 → **全部 200**。
所以**单次 404 不能判定邀请失效**，必须连续多次 + 退避重试。
（纯手工"狂点链接刷新"很容易据此得出错误结论。）

### 2. `workers.dev` 会被 DNS 污染

本机实测系统 DNS 把 `<worker>.<sub>.workers.dev` 解析到 **Facebook 的 IP**
（`31.13.67.19`），导致 `EPROTO` / `CERT_HAS_EXPIRED`，
看起来像"Worker 坏了"；用 DNS over HTTPS 取真实 IP（`104.21.x.x`）就正常。
→ 见 `cloudflare-worker/doh-lookup.mjs`

### 3. Cloudflare `error 1101` 可能是账号层面的限制

同一份代码在某账号上 500/1101（连"只返回常量"的最小 Worker 都失败），
换一个干净账号后**立即正常**。判断方法：如果**你自己原有的**其它 Worker
也返回 1101，而**不存在的** Worker 返回 1042，那就是账号问题而非代码问题。

### 4. `wrangler login --browser=false` 在输出被重定向时不启动回调服务器

wrangler 用 `process.stdin.isTTY` 判断交互性（`cli.js:29060`）。
一旦输出被重定向/管道 → 判定非交互 → **只打印授权链接，不启动 OAuth 回调服务器**
（本机实测为 `localhost:8976`）→ 浏览器授权后回调无处可去 → 永久干等。
必须**继承控制台**启动；授权链接改从 wrangler 日志文件读取。

### 5. PowerShell 5.1 的 stderr 陷阱

`npx` 每次都往 stderr 打 npm 警告，而 PS 5.1 把原生命令的 stderr 当作
**终止性错误** —— 配合 `$ErrorActionPreference='Stop'` 会让脚本**静默中断**。
→ 见 `tools/ps-util.ps1` 的 `Invoke-Native`

### 6. PowerShell 脚本必须带 UTF-8 BOM

PS 5.1 靠 BOM 识别 UTF-8；无 BOM 时按 GBK 解码，中文注释吃掉引号后
报出一堆假语法错误（`Missing type name after '['`）。
→ `cloudflare-worker/fix-bom.mjs` 可一键修复并自检所有 `.ps1`

### 7. 反向：`.cmd` 必须保持纯 ASCII

cmd.exe 按 **GBK OEM 代码页**逐字节解析批处理文件，UTF-8 中文行会被切碎
后当命令执行（`'脑社区...' is not recognized`），`chcp 65001` 也救不了
（它在解析之后才生效）。所以中文输出全部交给 `.ps1`。

### 8. `Get-Content` 默认按 ANSI 解码，会把 UTF-8 文件写坏

PS 5.1 的 `Get-Content -Raw` 读 UTF-8 文件得到乱码，再 `WriteAllText` 写回
就**永久损坏**了中文内容（本项目的 `wrangler.toml` 就这么被毁过一次，不可逆）。
**读文件一律加 `-Encoding UTF8`。**

---

## 关于"自动加入"：为什么本项目不做

需求容易延伸成"检测到开放就自动加入"。这里有个必须说清的技术事实：

> **Discord 机器人（Bot）无法代替你加入服务器。**
> Bot 用 bot token 加入后，服务器里多出来的是**那个 bot**，不是你。
> `guilds.join` 作用域只覆盖「该 bot 已加入的服务器」，对"你还没进的新服务器"无用。

所以"自动加入"技术上只剩一条路：**自动化你自己的用户账号**（self-bot），
用 user token 调用未公开的 `POST /api/v10/invites/{code}`。
这违反 Discord ToS，且从数据中心 IP 登录还会触发风控；加上人机校验，
**成功率低而代价是整个账号被封**。

风险不对称是这里的判断依据：
- 「晚几分钟才点到链接」的代价 = 错过一个社区
- 「账号被封」的代价 = 丢掉整个 Discord 账号

因此本项目的设计是**自动检测 + 强提醒，把点链接留给人**（约 2 秒）。

---

## 目录结构

```
monitor.mjs                 本机守望者（零依赖，自带系统代理探测）
monitor.config.json         配置（邀请码、间隔、阈值、通知）
check-status.ps1 / .cmd     一键体检（社区 + 守望者 + 云端哨兵）
check-connect.mjs           Discord 通路自检（DNS / 代理 / 真实端点）
install-task.ps1            安装 Windows 计划任务
deploy-vps.sh               Linux VPS / 树莓派一键部署
test-notify.ps1             桌面通知通路自检
tools/ps-util.ps1           原生命令调用封装（PS 5.1 stderr 陷阱）
tools/chrome-helper.ps1     统一的浏览器调用（显式指定 Chrome）
tools/open-chrome.ps1       用 Chrome 打开链接
cloudflare-worker/
  worker.mjs                云端哨兵（每分钟 cron，多通路推送）
  wrangler.toml             部署配置
  deploy.ps1 / launch.ps1   一键部署（含账号切换、端口自愈）
  setup-push.mjs            配置推送通路（API 写 secret）
  doh-lookup.mjs            DoH 解析，绕开 DNS 污染
  fix-bom.mjs               修复 .ps1 的 BOM 并语法自检
  README-cloud.md           云端方案详解 + 一次完整故障排查记录
```

---

## 免责声明

本项目只读取 Discord 的**公开**接口（`GET /api/v10/invites/{code}`，无需鉴权），
不登录、不使用 user token、不做自动化加入，不违反 ToS。

请自行遵守 Discord 服务条款及目标服务器的规则。
轮询间隔建议不低于 1 分钟，避免给对方服务造成不必要的负载。

## License

[MIT](LICENSE)
