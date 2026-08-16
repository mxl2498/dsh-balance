/**
 * dsh-balance：悬浮显示 DeepSeek 账户余额。
 * 服务端代理余额接口（lib/index.js）；浏览器端悬浮球 UI（lib/client.js）。
 */

export declare const name = 'balance'

export declare const inject: readonly string[]

export declare function apply(
  ctx: import('@deepseek-ai/cordis').Context,
  config?: {
    balanceApi?: string
    topUpUrl?: string
    cacheSeconds?: number
  },
): void
