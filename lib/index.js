/**
 * dsh-balance, 服务端半区。
 *
 * 职责：
 * 1) 把 DeepSeek 开放平台的余额查询接口代理到本机（/dsh-balance/balance），
 *    让浏览器端只拿到余额 JSON，密钥（DEEPSEEK_API_KEY）始终留在服务端。
 * 2) 抓取 DeepSeek 官网价格页（/dsh-balance/pricing），解析出各模型费率
 *    并按北京时区标记当前高峰/空闲时段，浏览器端据此实时显示费率。
 *
 * 余额接口：GET https://api.deepseek.com/user/balance
 * 返回示例：{ "is_available": true, "balance_infos": [
 *   { "currency": "CNY", "total_balance": "110.00",
 *     "granted_balance": "10.00", "topped_up_balance": "100.00" } ] }
 *
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * （Docusaurus SSR 页面，价格表格直接内联在 HTML 中，无需执行 JS）
 *
 * 依赖注入：ctx.credentials（解析 DEEPSEEK_API_KEY）、ctx.webServer（注册路由）。
 * 零外部包依赖（凭证引用直接传字符串，Node 26 自带 fetch / AbortSignal.timeout）。
 */

export const name = '余额悬浮球'

export const inject = ['webServer', 'credentials']

/** 余额查询接口（可在 patch config 中覆盖）。 */
const DEFAULT_BALANCE_API = 'https://api.deepseek.com/user/balance'
/** 默认充值页地址（可在 patch config 中覆盖）。 */
const DEFAULT_TOP_UP_URL = 'https://platform.deepseek.com/top_up'
/** 官网价格页地址（可在 patch config 中覆盖）。 */
const DEFAULT_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
/** DSH 凭证系统中 DeepSeek 密钥的引用名。 */
const API_KEY_REF = 'DEEPSEEK_API_KEY'
/** 请求 DeepSeek 接口的超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 15000
/** 价格缓存默认时长（秒）：官网价格不会频繁变动，6 小时足够。 */
const DEFAULT_PRICING_CACHE_SECONDS = 6 * 60 * 60
/** 兜底高峰时段（北京时间）：与官网“扣费规则”备注一致。 */
const FALLBACK_PEAK_SLOTS = [[9, 12], [14, 18]]

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {unknown} body - 响应体。
 */
function json(res, body) {
  const text = JSON.stringify(body)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 剥离 HTML 标签与常见实体，返回纯文本。 */
function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim()
}

/** 从 "0.05元" / "1.5元" 提取数字；解析失败返回 null。 */
function parsePrice(s) {
  const m = String(s).match(/[\d.]+/)
  return m ? parseFloat(m[0]) : null
}

/**
 * 解析官网价格页 HTML，提取模型列表与费率表。
 * 表格结构（rowspan 使行内 td 数量不一）：
 *   tr[0]  模型 | deepseek-v4-flash | deepseek-v4-pro | deepseek-v4-flash-vision-exp
 *   tr[3]  模型版本 | DeepSeek-V4-Flash-0731 | ...
 *   tr[13] 价格(1)(2) | 百万tokens输入（缓存命中） | 空闲时段 | p0 | p1 | p2
 *   tr[14] 高峰时段 | p0 | p1 | p2
 *   tr[15] 百万tokens输入（缓存未命中） | 空闲时段 | p0 | p1 | p2
 *   tr[16] 高峰时段 | p0 | p1 | p2
 *   tr[17] 百万tokens输出 | 空闲时段 | p0 | p1 | p2
 *   tr[18] 高峰时段 | p0 | p1 | p2
 * @param {string} html - 价格页 HTML。
 * @returns {{ models: object[], peakSlots: number[][] }} 结构化价格。
 */
function parsePricingHtml(html) {
  // 1) 收集所有 <table>，挑出含“价格”的那个
  const tables = []
  let pos = 0
  while (true) {
    const start = html.indexOf('<table', pos)
    if (start === -1) break
    const end = html.indexOf('</table>', start)
    if (end === -1) break
    tables.push(html.slice(start, end + 8))
    pos = end + 8
  }
  const table = tables.find((t) => t.includes('价格')) || tables[0]
  if (!table) throw new Error('价格表格未找到')

  const tdsOf = (tr) => [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripHtml(m[1]))
  const trs = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1])

  // 2) 模型 id（表头第一行，跳过“模型”标签列）
  const header = tdsOf(trs[0])
  const modelIds = header.slice(1).filter(Boolean)

  // 3) 模型版本（“模型版本”行）
  const versionRow = trs.find((tr) => stripHtml(tr).startsWith('模型版本'))
  const versions = versionRow ? tdsOf(versionRow).slice(1) : []

  // 4) 价格行：“价格”标签行开始，共 6 行（3 类 × 空闲/高峰）
  const priceRowIdx = trs.findIndex((tr) => /^价格/.test(stripHtml(tr)))
  if (priceRowIdx === -1) throw new Error('价格行未找到')
  const priceRows = trs.slice(priceRowIdx, Math.min(trs.length, priceRowIdx + 6)).map(tdsOf)

  // 5) 归一化：行内第一个 td 若是 rowspan 占位“价格”则丢弃；遇“百万tokens”行换类别
  const parsed = []
  let currentLabel = null
  for (const cells of priceRows) {
    let rest = cells[0] && /^价格/.test(cells[0]) ? cells.slice(1) : cells
    let label, period, prices
    if (rest.length >= 2 && /百万tokens/.test(rest[0])) {
      label = rest[0]
      period = rest[1]
      prices = rest.slice(2)
    } else {
      label = currentLabel
      period = rest[0]
      prices = rest.slice(1)
    }
    if (label === null) continue
    currentLabel = label
    parsed.push({ label, period, prices })
  }

  // 6) 组装模型价格对象
  const models = modelIds.map((id, i) => ({
    id,
    version: versions[i] || null,
    input: { cacheHit: { offPeak: null, peak: null }, cacheMiss: { offPeak: null, peak: null } },
    output: { offPeak: null, peak: null },
  }))
  for (const row of parsed) {
    const key = row.label.includes('缓存命中')
      ? 'cacheHit'
      : row.label.includes('缓存未命中')
        ? 'cacheMiss'
        : row.label.includes('输出')
          ? 'output'
          : null
    if (key === null) continue
    const period = row.period.includes('空闲') ? 'offPeak' : 'peak'
    row.prices.forEach((p, i) => {
      if (!models[i]) return
      const v = parsePrice(p)
      if (key === 'output') models[i].output[period] = v
      else models[i].input[key][period] = v
    })
  }

  // 7) 高峰时段：从页面备注提取“高峰时段为北京时间（周一至周五）9:00 - 12:00、14:00 - 18:00”
  //    官网新版文案带“周一至周五”前缀，旧文案无前缀，两种都兼容。
  let peakSlots = FALLBACK_PEAK_SLOTS
  const noteMatch = html.match(/高峰时段为北京时间\s*(?:周一至周五|工作日)?\s*([\d:]+)\s*-\s*([\d:]+)[、，,]\s*([\d:]+)\s*-\s*([\d:]+)/)
  if (noteMatch) {
    const slots = []
    for (let k = 1; k < noteMatch.length; k += 2) {
      const start = parseInt(noteMatch[k], 10)
      const end = parseInt(noteMatch[k + 1], 10)
      if (Number.isFinite(start) && Number.isFinite(end)) slots.push([start, end])
    }
    if (slots.length) peakSlots = slots
  }

  // 8) 周末低谷规则：周末（周六、周日）全天不再区分峰谷时段，统一按低谷价。
  //    识别两种官网文案：
  //    旧文案：“我们将于北京时间2026年8月23日（周日）00:00起，对峰谷计费规则做出调整，
  //            周末（周六、周日）全天不再区分峰谷时段，统一按照低谷时段价格收取调用费用。”
  //    新文案：“高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。”
  //            —— 高峰限定周一至周五，则周末低谷规则长期有效（生效时间记为 0 = 一直生效）。
  let weekendFlat = false
  let weekendFlatStart = null
  if (/周末[^。]*?(?:不[^。]*?区分[^。]*?峰谷|统一按照低谷时段价格)/.test(html)) {
    weekendFlat = true
    const dm = html.match(/北京时间\s*(\d{4})年(\d{1,2})月(\d{1,2})日/)
    if (dm) {
      // 北京时区 00:00 = UTC 前一天的 16:00
      weekendFlatStart = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0) - 8 * 3600 * 1000
    }
  } else if (/高峰时段为北京时间\s*周一至周五/.test(html)) {
    weekendFlat = true
    weekendFlatStart = 0 // 长期有效
  }

  return { models, peakSlots, weekendFlat, weekendFlatStart }
}

/**
 * 判断当前是否为高峰时段（按北京时间，UTC+8）。
 * 周末低谷规则生效后，周六/周日全天返回空闲（低谷）。
 * @param {number[][]} peakSlots - 高峰时段区间，如 [[9,12],[14,18]]。
 * @param {boolean} [weekendFlat] - 是否启用周末低谷规则。
 * @param {number|null} [weekendFlatStart] - 周末低谷规则生效时间（UTC 时间戳）。
 * @returns {'peak' | 'offPeak'}
 */
function currentPeriod(peakSlots, weekendFlat = false, weekendFlatStart = null) {
  const now = new Date()
  if (weekendFlat && weekendFlatStart !== null && now.getTime() >= weekendFlatStart) {
    // 北京时间星期几（0=周日）
    const bjDay = new Date(now.getTime() + 8 * 3600 * 1000).getUTCDay()
    if (bjDay === 0 || bjDay === 6) return 'offPeak'
  }
  const bjHour = (now.getUTCHours() + 8) % 24
  for (const [start, end] of peakSlots) {
    if (bjHour >= start && bjHour < end) return 'peak'
  }
  return 'offPeak'
}

/**
 * 服务端入口：注册余额代理路由与价格路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {object} [config] - patch 传入的配置。
 */
export function apply(ctx, config = {}) {
  const balanceApi = config.balanceApi || DEFAULT_BALANCE_API
  const topUpUrl = config.topUpUrl || DEFAULT_TOP_UP_URL
  const pricingUrl = config.pricingUrl || DEFAULT_PRICING_URL
  const cacheMs = (config.cacheSeconds ?? 60) * 1000
  const pricingCacheMs = (config.pricingCacheSeconds ?? DEFAULT_PRICING_CACHE_SECONDS) * 1000

  /** 最近一次成功响应的缓存（含时间戳）。 */
  let cache = null
  /** 进行中的请求（并发去重）。 */
  let inflight = null
  /** 价格缓存与进行中的抓取。 */
  let pricingCache = null
  let pricingInflight = null

  /**
   * 取余额：命中缓存直接返回；否则请求 DeepSeek 并更新缓存。
   * 失败不缓存（下次轮询重试）。
   * @returns {Promise<object>} 统一的响应信封。
   */
  async function fetchBalance() {
    if (cache && Date.now() - cache.at < cacheMs) return cache.payload
    inflight ??= (async () => {
      try {
        const cred = await ctx.credentials.resolve(API_KEY_REF)
        if (!cred) {
          return { ok: false, code: 'no-api-key', message: '未配置 DEEPSEEK_API_KEY 凭证' }
        }
        const res = await fetch(balanceApi, {
          headers: { authorization: `Bearer ${cred.value}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) {
          return { ok: false, code: `http-${res.status}`, message: `DeepSeek API HTTP ${res.status}` }
        }
        const data = await res.json()
        const payload = { ok: true, data, topUpUrl, fetchedAt: Date.now() }
        cache = { payload, at: Date.now() }
        return payload
      } catch (err) {
        return { ok: false, code: 'fetch-failed', message: String((err && err.message) || err) }
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * 取价格：命中缓存直接返回；否则抓取官网价格页并解析。
   * 解析失败不缓存（下次重试）。
   * @returns {Promise<object>} 统一的响应信封。
   */
  async function fetchPricing() {
    if (pricingCache && Date.now() - pricingCache.at < pricingCacheMs) return pricingCache.payload
    pricingInflight ??= (async () => {
      try {
        const res = await fetch(pricingUrl, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
            'accept-language': 'zh-CN,zh;q=0.9',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) {
          return { ok: false, code: `http-${res.status}`, message: `价格页 HTTP ${res.status}` }
        }
        const html = await res.text()
        const { models, peakSlots, weekendFlat, weekendFlatStart } = parsePricingHtml(html)
        const payload = {
          ok: true,
          models,
          peakSlots,
          weekendFlat,
          weekendFlatStart,
          currentPeriod: currentPeriod(peakSlots, weekendFlat, weekendFlatStart),
          fetchedAt: Date.now(),
          source: pricingUrl,
        }
        pricingCache = { payload, at: Date.now() }
        return payload
      } catch (err) {
        return { ok: false, code: 'pricing-fetch-failed', message: String((err && err.message) || err) }
      } finally {
        pricingInflight = null
      }
    })()
    return pricingInflight
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-balance/balance',
    handler: async (_req, res) => {
      json(res, await fetchBalance())
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-balance/pricing',
    handler: async (_req, res) => {
      json(res, await fetchPricing())
    },
  }))
}
