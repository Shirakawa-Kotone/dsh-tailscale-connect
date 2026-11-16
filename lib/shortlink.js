/**
 * The fixed short link: `GET /t/<code>` redirects a tailnet device to the
 * current process's tokenized DSH URL, which mints the browser cookie and then
 * lands on the clean application URL.
 *
 * Two properties matter:
 * - The code is stable and short enough to bookmark; the launch token it
 *   resolves to changes every restart, so the link never goes stale.
 * - The redirect origin is chosen from an allowlist, never straight from the
 *   `Host` header. A tailnet peer that sends an arbitrary Host must not be able
 *   to turn the short link into a token leak to that host.
 *
 * @module dsh-tailscale-connect/shortlink
 */

import { accessCodeMatches } from './access-code.js'

/** Default route prefix. */
export const DEFAULT_SHORTLINK_PATH = '/t'

/** Wrong-code responses allowed per client per minute before 429. */
const DEFAULT_FAILURE_LIMIT = 30

/**
 * Normalize one configured route prefix.
 * @param {unknown} value - raw config value.
 * @returns {string} `/something` with no trailing slash, or the default.
 */
export function normalizeShortlinkPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_SHORTLINK_PATH
  const trimmed = value.trim()
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const normalized = withSlash.replace(/\/+$/, '')
  if (normalized === '' || normalized === '/') return DEFAULT_SHORTLINK_PATH
  return normalized
}

/**
 * The origin one request's Host and forwarded protocol describe.
 * @param {import('node:http').IncomingMessage} request - inbound request.
 * @param {'http:' | 'https:'} [protocol] - listener protocol fallback.
 * @returns {string | undefined} origin such as `https://host:port`.
 */
export function originFromRequest(request, protocol = 'http:') {
  const host = request.headers.host
  if (typeof host !== 'string' || host.trim() === '') return undefined
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  const scheme = forwarded === 'https' || forwarded === 'http'
    ? forwarded
    : protocol.replace(':', '') === 'https'
      ? 'https'
      : 'http'
  try {
    return new URL(`${scheme}://${host.trim()}`).origin
  } catch {
    return undefined
  }
}

/**
 * Choose the public base URL a short-link redirect should target.
 *
 * Only an origin this activation published, or a loopback origin, may be used
 * verbatim; anything else falls back to the advertised base URL, so a forged
 * Host cannot redirect the process token to an attacker. The public path prefix
 * (`''` or `/dsh`) is kept because a Serve install may mount DSH below one.
 * @param {import('node:http').IncomingMessage} request - inbound request.
 * @param {Set<string>} allowedOrigins - origins this activation serves.
 * @param {string} fallbackBase - advertised base URL used for anything else.
 * @param {string} [publicPath] - path prefix of the application, no trailing slash.
 * @param {'http:' | 'https:'} [protocol] - listener protocol fallback.
 * @returns {string} redirect base URL, no trailing slash.
 */
export function pickRedirectBase(request, allowedOrigins, fallbackBase, publicPath = '', protocol = 'http:') {
  const origin = originFromRequest(request, protocol)
  if (origin !== undefined && allowedOrigins.has(origin)) return `${origin}${publicPath}`
  return fallbackBase.replace(/\/+$/, '')
}

/**
 * Build the origins a short link may redirect to: every published URL plus the
 * loopback listener.
 * @param {string[]} urls - public URLs from the access plan.
 * @param {{ host?: string, port?: number, protocol?: string }} server - bound web server.
 * @returns {Set<string>} normalized origins.
 */
export function allowedOriginsFor(urls, server) {
  const origins = new Set()
  for (const url of urls) {
    try {
      origins.add(new URL(url).origin)
    } catch {
      // not a URL
    }
  }
  const port = server?.port
  if (Number.isInteger(port) && port > 0) {
    const protocol = String(server?.protocol ?? 'http:').startsWith('https') ? 'https' : 'http'
    for (const host of ['127.0.0.1', 'localhost']) {
      origins.add(`${protocol}://${host}:${String(port)}`)
    }
    const bound = server?.host
    if (typeof bound === 'string' && bound !== '' && bound !== '0.0.0.0') {
      const formatted = bound.includes(':') ? `[${bound}]` : bound
      origins.add(`${protocol}://${formatted}:${String(port)}`)
    }
  }
  return origins
}

/**
 * A tiny per-client failure limiter for wrong codes.
 * @param {{ limit?: number, windowMs?: number }} [options] - limiter options.
 * @returns {(key: string) => { allowed: boolean, retryAfter: number }} checker.
 */
export function createFailureLimiter(options = {}) {
  const limit = options.limit ?? DEFAULT_FAILURE_LIMIT
  const windowMs = options.windowMs ?? 60_000
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const entries = new Map()
  return (key) => {
    const now = Date.now()
    const current = entries.get(key)
    if (current === undefined || now >= current.resetAt) {
      entries.set(key, { count: 1, resetAt: now + windowMs })
      if (entries.size > 1000) {
        for (const [k, v] of entries) if (now >= v.resetAt) entries.delete(k)
      }
      return { allowed: true, retryAfter: 0 }
    }
    current.count += 1
    if (current.count > limit) {
      return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) }
    }
    return { allowed: true, retryAfter: 0 }
  }
}

/**
 * The client key used for failure limiting.
 * @param {import('node:http').IncomingMessage} request - inbound request.
 * @returns {string} forwarded chain's first hop, or the socket address.
 */
export function clientKeyOf(request) {
  // Use the LAST hop: a direct tailnet client cannot spoof the address our own
  // proxy appends, while a Serve-fronted request still lands on one stable key.
  const chain = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (chain.length > 0) return chain[chain.length - 1]
  return request.socket.remoteAddress ?? 'unknown'
}

/**
 * Build the short-link request handler.
 * @param {object} options - handler options.
 * @param {string} options.code - the accepted access code.
 * @param {string} options.path - normalized route prefix.
 * @param {{ authenticatedUrl?: (url: string) => string } | undefined} options.connection - DSH connection service.
 * @param {string} options.baseUrl - advertised public base including any path prefix.
 * @param {Set<string>} options.allowedOrigins - origins allowed verbatim.
 * @param {string} [options.publicPath] - application path prefix, no trailing slash.
 * @param {'http:' | 'https:'} [options.protocol] - listener protocol.
 * @param {(message: string) => void} [options.log] - message sink.
 * @param {(key: string) => { allowed: boolean, retryAfter: number }} [options.limiter] - failure limiter.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler.
 */
export function createShortlinkHandler(options) {
  const prefix = `${options.path.replace(/\/+$/, '')}/`
  const limiter = options.limiter ?? createFailureLimiter()
  const log = options.log ?? (() => {})

  return (request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
      response.end()
      return
    }
    let pathname
    try {
      pathname = new URL(request.url ?? '/', 'http://shortlink.invalid').pathname
    } catch {
      pathname = ''
    }
    if (!pathname.startsWith(prefix)) {
      notFound(response)
      return
    }
    let presented
    try {
      presented = decodeURIComponent(pathname.slice(prefix.length)).replace(/\/+$/, '')
    } catch {
      notFound(response)
      return
    }
    if (!accessCodeMatches(presented, options.code)) {
      const key = clientKeyOf(request)
      const verdict = limiter(key)
      if (!verdict.allowed) {
        response.writeHead(429, {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': String(verdict.retryAfter),
          'cache-control': 'no-store',
        })
        response.end('too many attempts\n')
        return
      }
      log(`short link rejected from ${key}`)
      notFound(response)
      return
    }

    // Success: hand the browser the current process token through the origin
    // this activation actually serves.
    const base = pickRedirectBase(
      request,
      options.allowedOrigins,
      options.baseUrl,
      options.publicPath ?? '',
      options.protocol ?? 'http:',
    )
    const clean = `${base.replace(/\/+$/, '')}/`
    let target = clean
    try {
      if (typeof options.connection?.authenticatedUrl === 'function') {
        target = options.connection.authenticatedUrl(clean)
      }
    } catch {
      // fall through to the clean URL; a device with a valid cookie still works
    }
    response.writeHead(302, {
      location: target,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    })
    response.end()
  }
}

/**
 * Register the short-link route on the DSH web server.
 * @param {object} options - registration options.
 * @param {{ register: (route: { kind: 'prefix', path: string, handler: import('node:http').RequestListener }) => () => void }} options.webServer - web server service.
 * @param {string} options.path - normalized route prefix.
 * @param {Parameters<typeof createShortlinkHandler>[0]} options.handlerOptions - handler options without `path`.
 * @returns {() => void} disposer removing the route.
 */
export function registerShortlink({ webServer, path, handlerOptions }) {
  return webServer.register({
    kind: 'prefix',
    path,
    handler: createShortlinkHandler({ ...handlerOptions, path }),
  })
}

/** Write one 404 with no information about whether a code exists. */
function notFound(response) {
  const body = 'not found\n'
  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  response.end(body)
}
