/**
 * dsh-balance, 服务端半区。
 *
 * 职责：把 DeepSeek 开放平台的余额查询接口代理到本机（/dsh-balance/balance），
 * 让浏览器端只拿到余额 JSON，密钥（DEEPSEEK_API_KEY）始终留在服务端，
 * 绝不进入浏览器。
 *
 * 余额接口：GET https://api.deepseek.com/user/balance
 * 返回示例：{ "is_available": true, "balance_infos": [
 *   { "currency": "CNY", "total_balance": "110.00",
 *     "granted_balance": "10.00", "topped_up_balance": "100.00" } ] }
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
/** DSH 凭证系统中 DeepSeek 密钥的引用名。 */
const API_KEY_REF = 'DEEPSEEK_API_KEY'
/** 请求 DeepSeek 接口的超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 15000

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

/**
 * 服务端入口：注册余额代理路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {object} [config] - patch 传入的配置。
 */
export function apply(ctx, config = {}) {
  const balanceApi = config.balanceApi || DEFAULT_BALANCE_API
  const topUpUrl = config.topUpUrl || DEFAULT_TOP_UP_URL
  const cacheMs = (config.cacheSeconds ?? 60) * 1000

  /** 最近一次成功响应的缓存（含时间戳）。 */
  let cache = null
  /** 进行中的请求（并发去重）。 */
  let inflight = null

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

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-balance/balance',
    handler: async (_req, res) => {
      json(res, await fetchBalance())
    },
  }))
}
