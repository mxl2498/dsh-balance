# 余额悬浮球（@dsh-external/余额悬浮球）

DSH Web 插件：**右下角悬浮显示 DeepSeek 账户余额 + 实时官网费率，点击直达官网充值页**。

- 悬浮胶囊实时显示总余额（如 `余额 ¥110.00`），可**拖动**到任意位置（记忆在 localStorage，越界自动回到默认位置）；
- **第二行实时显示当前模型费率**（如 `Flash 入1.5元/M·高峰`），按北京高峰/空闲时段自动切换，无需手动刷新；
- 点击展开明细卡片：总余额 / 充值余额 / 赠送余额、最近更新时间、**刷新**与**去充值 ↗** 按钮；
- **卡片内含完整模型费率表**：全部模型的高峰/空闲输入（缓存命中 / 未命中）与输出价格，数据**实时抓取自官网定价页**；
- 余额低于阈值（默认 ¥5）时胶囊变红并带 ⚠ 告警；
- 服务端代理余额与价格接口，`DEEPSEEK_API_KEY` 密钥只留在服务端，**不会进入浏览器**；
- 60 秒自动刷新（页面隐藏时暂停，回到前台立即补一次）。

## 截图

右下角悬浮球（两行：余额 + 实时费率；点击展开明细、费率表与充值入口）：

![余额悬浮球](docs/screenshot-pill.png)

设置 → 「余额悬浮球」页（开关 / 刷新间隔 / 低余额阈值 / 悬浮位置 / 显示费率 / 费率模型）：

![余额悬浮球设置页](docs/screenshot-settings.png)

## 架构

```
浏览器端（悬浮球 UI）  --fetch-->  服务端代理 /dsh-balance/balance  --fetch-->  DeepSeek API
   lib/client.js                    lib/index.js (ctx.webServer + ctx.credentials)   api.deepseek.com/user/balance
                                    /dsh-balance/pricing  --fetch-->  DeepSeek 官网定价页（解析 + 缓存）
```

服务端通过 `ctx.credentials` 解析 `DEEPSEEK_API_KEY`（DSH 凭证系统，当前已配置），
带 `Authorization: Bearer` 请求 `https://api.deepseek.com/user/balance`，结果缓存 60 秒。

费率数据由服务端抓取 `https://api-docs.deepseek.com/zh-cn/quick_start/pricing`
（Docusaurus SSR 静态表格，无需执行 JS），解析出各模型的高峰/空闲费率，
并按**北京时间**（UTC+8）计算当前时段（高峰 9-12 点、14-18 点，其余空闲），
结果缓存 6 小时，浏览器端只读取结构化 JSON。

## 配置

在 `cordis.patch.yml`（本包自带，可被 profile 的 patch 覆盖）中调整：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `cacheSeconds` | `60` | 服务端余额缓存秒数 |
| `topUpUrl` | `https://platform.deepseek.com/top_up` | 充值页地址 |
| `pricingUrl` | `https://api-docs.deepseek.com/zh-cn/quick_start/pricing` | 官网价格页地址 |
| `pricingCacheSeconds` | `21600` | 服务端价格缓存秒数（默认 6 小时） |
| `enabled` | `true` | 是否启用悬浮球 |
| `refreshSeconds` | `60` | 客户端自动刷新间隔秒数 |
| `lowBalanceThreshold` | `5` | 余额低于该值（CNY）时红色告警 |
| `position` | `bottom-right` | 默认悬浮位置（`bottom-right` / `top-right` / `bottom-left` / `top-left`） |

客户端设置（设置 → 余额悬浮球页，持久化在 localStorage）：

| 设置项 | 默认值 | 说明 |
|---|---|---|
| 启用悬浮球 | 开 | 总开关 |
| 刷新间隔（秒） | `60` | 余额与费率自动刷新频率 |
| 低余额阈值（¥） | `5` | 低于该值红色告警 |
| 悬浮位置 | `bottom-right` | 默认位置；拖动后以拖动位置为准 |
| 显示费率 | 开 | 悬浮球第二行显示当前模型实时费率 |
| 费率模型 | `deepseek-v4-flash` | 悬浮球展示的模型费率（选项动态取自官网，不影响实际调用） |

## 安装（从 GitHub）

```sh
# 加入 web profile 的依赖（声明 dsh.bundle，dsh plugin 会自动追加进 bundles）
dsh plugin --profile web add github:mxl2498/dsh-balance
# 然后重启 DSH Desktop / dsh web
```

本地开发时也可用 `dsh plugin --profile web add file:../dsh-balance` 安装本地目录。

## 注意

- 余额接口以 `balance_infos` 第一项为准（一般即 CNY 账户）；多币种时卡片会列出各项。
- 若显示"余额 --"，把鼠标悬停在胶囊上看具体错误（未配置密钥 / HTTP 状态 / 网络失败）。
- 费率以官网定价页为准，服务端缓存最多 6 小时；若官网改价，最迟 6 小时后自动更新。
- **周末低谷规则**：官网于 2026-08-23 起调整计费 —— 周末（周六/周日）全天不区分峰谷时段，统一按低谷价。插件自动读取官网备注并生效：周末悬浮球显示"低谷"，工作日按高峰（9-12 点、14-18 点）/ 空闲自动切换。
- 若显示"费率 --"或"费率获取失败"，请检查本机网络能否访问官网定价页。
- 充值页需要登录 DeepSeek 开放平台账号。
