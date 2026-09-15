# 云端哨兵（Cloudflare Worker 版）—— 电脑关机也继续盯

> ## 📌 本文档是排查记录 + 使用说明
>
> 下面第 1 节保留了一次真实故障的完整排查过程（**已解决**）。保留它是因为
> 「workers.dev 全部返回 error 1101」是个很容易误判成"代码写错"的坑，
> 记录下证据链能帮后来者少走弯路。
>
> **结论先行**：根因是**旧账号层面被限制**（该账号内有 `edgetunnel` 这类代理 Worker）。
> 换一个干净的 Cloudflare 账号后，**同一份代码完全正常**。

---

## 0. 结论：1101 的真实原因与解决办法

| 现象 | `error code: 1101`（Worker 抛异常或无法执行） |
|---|---|
| 误判方向 | 以为是代码 bug（其实最小探针 Worker 也同样失败） |
| **真实原因** | **账号层面受限**，与代码无关 |
| **解决办法** | **换一个干净的 Cloudflare 账号**，重新部署即可 |

换账号后还遇到两个坑（已在新版本代码里处理）：

1. **新账号没有 `workers.dev` 子域** —— 首次部署会报
   `You need to register a workers.dev subdomain`。可在控制台 Workers & Pages
   页面进入一次自动创建，或用 API：
   `PUT /client/v4/accounts/{account_id}/workers/subdomain {"subdomain":"你的前缀"}`
2. **`workers.dev` 可能被 DNS 污染** —— 本机实测系统 DNS 把
   `<worker>.<sub>.workers.dev` 解析到 Facebook 的 IP，导致
   `EPROTO` / `CERT_HAS_EXPIRED` 这类握手错误，看起来像"Worker 坏了"。
   用 DNS over HTTPS 取真实 IP 即可（参见 `doh-lookup.mjs`）。

> 账号 ID、子域、KV id 这类信息**不要在公开仓库里硬编码** —— 本仓库已全部改为
> 占位符或环境变量。

---

## 1. 排查记录（历史，已解决）

> ⚠️ 下面提到的子域属于**当时那个有问题的旧账号**，仅作记录（此处已隐去）；
> 你自己的部署不会用到它。

> ### 🚫 当时的结论：该方案在这个 Cloudflare 账号上跑不起来
>
> 代码无误、部署也成功，但**该账号的 workers.dev 全面无法执行脚本**。证据链：
>
> | 测试对象 | 结果 | 说明 |
> |---|---|---|
> | 部署的最小探针 Worker（只 `return Response.json()`，无 fetch 无 KV） | **500 / error 1101** | 连常量都返回不了 |
> | 主 Worker `leina-invite-watch` | 500 / 1101 | |
> | **该账号原有的** `edgetunnel` | 500 / 1101 | **与本文代码无关的旧 Worker，同样失败** |
> | **该账号原有的** `white-dew-6a28` | 500 / 1101 | 同样失败 |
> | 从未部署过的名字 `super-pine-3667` | 404 / **error 1042** | 对照组：错误码不同，证明 1101 ≠ "不存在" |
>
> 已逐项排除：子域已注册且 `enabled: true`、脚本 `handlers: ["fetch"]`、
> 部署记录 `percentage: 100` 且 `deployed`、KV 绑定正常、`compatibility_date` 无异常、
> `Response.json` 可用、Cloudflare API 全程 200。**问题在账号层面，不在代码。**
>
> **最终验证**：换一个干净账号后，同一份代码立即正常工作（HTTP 200）。

>
> 最可能的关联：该账号存在 `edgetunnel` 这类代理类 Worker，可能导致 workers.dev
> 被 Cloudflare 限制。**建议去 Cloudflare 控制台 `Workers & Pages` 页面看是否有
> 警告横幅**（我没有你的控制台访问权，这一步只能你来）。
>
> ### 三条出路（按成本排序）
> 1. **换一个干净的 Cloudflare 账号**（新邮箱注册，5 分钟），再跑 `deploy.ps1` —— 代码已验证可用
> 2. **改用 VPS / 树莓派**：上一层目录的 `deploy-vps.sh`，一条命令装完，完全不依赖 Cloudflare
> 3. **先用本地计划任务顶着**（已装好、已在跑）：只要电脑开机就在工作
>
> 本目录的代码与脚本**保持可用状态**，等账号问题解决后直接 `deploy.ps1` 即可。

**它做什么**：在 Cloudflare 边缘节点上每分钟检查一次类脑邀请的 `member_count`，
一旦计数上涨（= 邀请暂停解除、有人成功进群）就通过 Discord webhook 推给你。
你电脑关机、断网、代理挂掉都不影响它。

**它不做什么**：它**不会替你加入**。原因见主 README 的「自动加入」章节 ——
（1）Bot 无法代替用户加入；（2）自动化用户账号属于 ToS 禁止的 self-bot 行为。
它的职责是**在开放的第一分钟把你叫醒**，点一下链接这件事由你完成（约 2 秒）。

---

## 一、为什么不用 GitHub Actions 的 cron

GitHub Actions 的定时任务是**尽力而为**，高峰期普遍延迟 **5～40 分钟**
（社区长期反馈：`*/5 * * * *` 实测常常变成 39 分钟才跑一次）。
对于「怕错过开放窗口」这个目标，延迟 40 分钟等于没用。
Cloudflare 的 cron 精度是**分钟级**，且免费额度足够（每天 1440 次请求，免费额度 10 万次/天）。

> 目录上一层的 `github-actions-workflow.yml` 仍保留作为**第三重备份**，
> 但不要把主力押在它身上。

---

## 二、部署步骤（一键脚本，约 3 分钟）

> 先说明两处**必须你本人操作**的地方，其余全部自动：
> ① 浏览器里点 Cloudflare 授权（我没有你的账号，也不能代点）
> ② 粘贴 Discord webhook URL（这是你私有服务器里的东西）
>
> 还没有 Cloudflare 账号也没关系 —— 授权页上可以直接免费注册。

```powershell
cd <本仓库>\cloudflare-worker
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
```

脚本依次做：设置代理 → 检查 wrangler 与 10808 端口 → 检测登录状态 →
`wrangler login` → 创建 KV 命名空间并**自动回填 id 到 wrangler.toml（含回填校验）** →
写入 webhook 密钥 → `wrangler deploy` → **用线上地址实测两次调用**确认不误报。

**看到这两行就说明成功**：
```
[OK] 第一次调用: memberCount=381861  events=BASELINE_SET
[OK] 暂停中不误报 —— 判定逻辑正常
```

之后确认定时器在跑：
```powershell
npx wrangler tail        # 等 1~2 分钟，应看到每分钟一次的 cron 日志
```

### 已在本机预置好的部分
- `wrangler` 4.131.2 已安装（`node_modules` 在上一层的 `leina-invite-watch/`）
- `workerd.exe` (94 MB) 与 `esbuild.exe` (11 MB) 平台二进制已就位
- `wrangler.toml` 已通过 `wrangler deploy --dry-run` 验证：
  打包 6.13 KiB / gzip 2.40 KiB，KV 绑定识别正常
- `deploy.ps1` 已通过 PowerShell 解析器零错误检查，并实测能正确停在登录步骤

### 手动步骤（脚本不好使时的退路）
```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:10808'
$env:HTTP_PROXY  = 'http://127.0.0.1:10808'
npx wrangler login
npx wrangler kv namespace create LEINA_KV     # 把返回的 id 填进 wrangler.toml
Write-Output "你的webhook URL" | npx wrangler secret put DISCORD_WEBHOOK
npx wrangler deploy
```
> 这段是 fallback，未在真机跑通（只跑到登录步骤）—— 一键脚本才是验证过的路径。

### ⚠ 关于 deploy.ps1 的 BOM（已知例外）
`deploy.ps1` **刻意保存为 UTF-8 带 BOM**。实测原因：PowerShell 5.1 会把
「无 BOM 的 UTF-8」当 GBK 解码，中文注释被误解码后吃掉引号，解析直接失败
（`Missing type name after '['` / `The string is missing the terminator: '@`）。
同一文件加 BOM 后解析 OK，把非 ASCII 全换成 `x` 后也 OK —— 是编码问题而非结构问题。
因此 `check-encoding.mjs` 对这个文件报「不应带 BOM」是**已知误报，可忽略**；
仓库其它文件仍保持无 BOM。

---

## 三、Discord webhook 怎么拿

1. 在**你自己的**任意 Discord 服务器里：`频道设置（齿轮）→ 整合 → Webhook → 新建 Webhook`
2. 复制 URL（形如 `https://discord.com/api/webhooks/123.../abc...`）
3. **在该频道里 @ 你的用户名一次，然后开启该频道的通知** —— 这样 webhook 一发消息，
   手机 Discord 就会推送

> 关键点：webhook 只发到**你有权限的那个频道**，所以这条通知链路
> **完全不依赖类脑社区** —— 你还没进群也能收到推送。这正是它能用的原因。

---

## 四、逻辑说明与已实测的边界

| 场景 | 行为 | 实测 |
|---|---|---|
| 首次运行 | 只设基线 + 推一条「已上线」，**不报警** | ✅ |
| 计数不变（暂停中） | 静默，记 `NO_CHANGE` | ✅ |
| 计数 **+1** | **立刻报警**（含 @你 + 链接） | ✅ |
| 报警后 | 基线推高，同一波增长**不重复刷屏** | ✅ |
| 计数下降（有人退群） | 记录 `MEMBERS_DROPPED`，**不报警** | ✅ |
| 限流 404 / 网络失败 | 记 `FETCH_FAILED`，**不改基线不报警** | ✅ 实测 Discord 反枚举限流返回 404 而非 429 |
| `/reset` | 手动重置基线 | ✅ |

以上 11 条断言由 `_test_worker.mjs` 用 mock 跑过，全绿。

### 已知安全项
`/reset` 与 `/` 是**公开可访问**的。风险有限（只能重置基线或触发一次检查，
改不了你的账号、发不出任意消息），但如果你介意，把 `worker.mjs` 里 `fetch`
入口的两条分支删掉，只保留 `scheduled` 即可。

---

## 五、想要「多个哨兵」时的取舍

| 方案 | 检测精度 | 成本 | 你关机后可用 | 稳定性 |
|---|---|---|---|---|
| 本地计划任务（已装） | 2 分钟 | 0 | ❌ | 高（但受本机代理影响） |
| **Cloudflare Worker（本方案）** | **1 分钟** | **0** | **✅** | 高 |
| GitHub Actions cron | 5～40 分钟 | 0 | ✅ | 中（延迟不可控） |
| Oracle Cloud 永久免费 ARM 机 | 可做到 10 秒 | 0（但抢不到机器） | ✅ | 中高 |
| 自己的 VPS / 树莓派 | 可做到 10 秒 | ¥10～30/月 或一次性硬件 | ✅ | 高 |

**推荐组合**：Cloudflare Worker（主力，1 分钟）+ 本地计划任务（备用，2 分钟）。
两者判定逻辑一致，互为冗余。都报警说明信号可信。
