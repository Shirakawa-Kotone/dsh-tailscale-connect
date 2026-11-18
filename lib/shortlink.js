/**
 * The fixed short link and its loopback-only onboarding page.
 *
 * `GET /t/<code>` used to redirect to the current process's tokenized DSH URL.
 * That worked, but a browser that cached or replayed the redirect could keep a
 * token from an earlier process and land on a blank 401 page after a restart.
 * The handler now mints the browser-session cookie itself through the DSH
 * connection service and redirects (303) straight to the clean application URL;
 * the token fallback remains only for hosts that expose no `authorizeIndex`.
 *
 * `GET /t` (no code) is a small phone-onboarding page, visible from loopback
 * only: it shows a QR for the fixed link and, when the remote bridge is
 * installed, a fresh pairing QR for the DSH phone app.
 *
 * @module dsh-tailscale-connect/shortlink
 */

import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'

import qrcodeFactory from 'qrcode-generator'

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
 * Render one QR symbol as an inline SVG.
 * @param {string} text - text to encode.
 * @param {{ margin?: number }} [options] - QR options.
 * @returns {string} SVG markup.
 */
export function qrSvg(text, options = {}) {
  const qr = qrcodeFactory(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ scalable: true, margin: options.margin ?? 2 })
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
 * Host cannot redirect a fresh session cookie to an attacker.
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
 * Whether one socket address names this machine.
 * @param {string | undefined} address - socket or forwarded address.
 * @returns {boolean} true for 127/8, ::1, and IPv4-mapped loopback.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const text = address.toLowerCase().startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return text === '::1' || /^127(?:\.\d{1,3}){3}$/.test(text)
}

/**
 * Whether one request reached this process directly from the machine itself.
 *
 * The proxy and `tailscale serve` both connect from loopback, so the socket
 * address alone is not enough: any non-loopback hop in `X-Forwarded-For`
 * marks a remote visitor and hides the onboarding page (which contains the
 * bearer code).
 * @param {import('node:http').IncomingMessage} request - inbound request.
 * @returns {boolean} true only for a purely local request.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const chain = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return chain.every((entry) => isLoopbackAddress(entry))
}

/**
 * Mint the DSH browser-session cookie for one public authority.
 *
 * DSH's own index route is the only supported way to turn the process launch
 * token into a cookie. We call it with a synthetic request and capture the
 * `Set-Cookie` it writes, then send our own redirect to the clean URL. The
 * `secure` flag mirrors `webServer.protocol` (the loopback listener), not the
 * external scheme, because that is what later requests will use to derive the
 * cookie audience.
 * @param {{ authenticatedUrl?: (url: string) => string, authorizeIndex?: (req: object, res: object, secure?: boolean) => unknown } | undefined} connection - DSH connection service.
 * @param {string} baseUrl - public base URL whose host is the cookie authority.
 * @param {'http:' | 'https:'} [protocol] - bound web server protocol.
 * @returns {string[] | undefined} Set-Cookie values, or undefined when the host cannot mint one.
 */
export function mintSessionCookie(connection, baseUrl, protocol = 'http:') {
  if (typeof connection?.authenticatedUrl !== 'function' || typeof connection?.authorizeIndex !== 'function') {
    return undefined
  }
  let token
  try {
    const tokenUrl = new URL(connection.authenticatedUrl('http://shortlink.invalid/'))
    token = tokenUrl.searchParams.get('token')
  } catch {
    return undefined
  }
  if (typeof token !== 'string' || token === '') return undefined
  let authority
  try {
    authority = new URL(baseUrl).host
  } catch {
    return undefined
  }
  if (authority === '') return undefined
  /** @type {{ status?: number, headers?: Record<string, unknown> }[]} */
  const captured = []
  const fakeResponse = {
    writeHead(status, headers) {
      captured.push({ status, headers })
    },
    end() {},
  }
  const fakeRequest = {
    url: `/?token=${encodeURIComponent(token)}`,
    method: 'GET',
    headers: { host: authority },
    socket: { remoteAddress: '127.0.0.1' },
  }
  try {
    connection.authorizeIndex(fakeRequest, fakeResponse, String(protocol).startsWith('https'))
  } catch {
    return undefined
  }
  const last = captured[captured.length - 1]
  const cookie = last?.headers?.['set-cookie']
  if (last?.status !== 303 || cookie === undefined) return undefined
  return Array.isArray(cookie) ? cookie : [String(cookie)]
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
 * @returns {string} the nearest hop, or the socket address.
 */
export function clientKeyOf(request) {
  const chain = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (chain.length > 0) return chain[chain.length - 1]
  return request.socket.remoteAddress ?? 'unknown'
}

/**
 * Ask a local remote-bridge instance for a fresh pairing URL.
 * @param {string | undefined} localOrigin - loopback origin of the DSH web server.
 * @param {number} [timeoutMs] - request timeout.
 * @returns {Promise<string | undefined>} the `pairingUrl`, or undefined when absent.
 */
export function fetchPairingUrl(localOrigin, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (typeof localOrigin !== 'string' || localOrigin === '') {
      resolve(undefined)
      return
    }
    let target
    try {
      target = new URL('/remote-bridge/pair/token', localOrigin)
    } catch {
      resolve(undefined)
      return
    }
    const getter = target.protocol === 'https:' ? httpsGet : httpGet
    const request = getter(target, {
      timeout: timeoutMs,
      ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      headers: { accept: 'application/json' },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { if (body.length < 65_536) body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve(undefined)
          return
        }
        try {
          const parsed = JSON.parse(body)
          resolve(typeof parsed?.pairingUrl === 'string' && parsed.pairingUrl !== '' ? parsed.pairingUrl : undefined)
        } catch {
          resolve(undefined)
        }
      })
    })
    request.on('timeout', () => {
      request.destroy()
      resolve(undefined)
    })
    request.on('error', () => { resolve(undefined) })
    request.end()
  })
}

/**
 * Render the loopback-only phone onboarding page.
 * @param {{ fixedLink: string, pairingUrl?: string, pairingError?: string }} options - page data.
 * @returns {string} HTML.
 */
export function renderLandingPage({ fixedLink, pairingUrl, pairingError }) {
  const fixed = escapeHtml(fixedLink)
  const pairSection = typeof pairingUrl === 'string' && pairingUrl !== ''
    ? `<div class="qr">${qrSvg(pairingUrl)}</div>
       <p class="muted">用 DSH App 扫码配对，约 30 秒内有效；刷新本页可换一张。</p>`
    : `<p class="muted">${escapeHtml(pairingError ?? '没有检测到 remote-bridge，或暂时无法生成配对码。')}</p>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DSH 手机访问</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #f5f7fb; color: #162033; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  p { margin: 8px 0; }
  .muted { color: #5b687d; font-size: 14px; }
  .card { background: #fff; border: 1px solid #dce3ef; border-radius: 14px; padding: 18px; margin-top: 18px;
          box-shadow: 0 1px 2px rgba(16, 30, 54, .05); }
  .qr { display: flex; justify-content: center; padding: 10px; background: #fff; border-radius: 10px; }
  .qr svg { width: min(64vw, 260px); height: auto; }
  code, .link { display: block; margin: 10px 0; padding: 10px 12px; background: #f0f4fa; border-radius: 8px;
               font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  button { appearance: none; border: 1px solid #2f6df6; background: #2f6df6; color: #fff; border-radius: 9px;
           padding: 9px 14px; font-size: 15px; cursor: pointer; }
  button.secondary { background: transparent; color: #2f6df6; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  footer { margin-top: 28px; font-size: 13px; color: #6a778c; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1521; color: #e7eefc; }
    .card { background: #161e2d; border-color: #29364b; box-shadow: none; }
    .qr { background: #fff; }
    code, .link { background: #0e1624; }
    .muted, footer { color: #9aabc4; }
  }
</style>
</head>
<body>
<main>
  <h1>DSH 手机访问</h1>
  <p class="muted">这个页面只在本机回环可见。固定短链等于登录凭据，不要发给别人。</p>

  <section class="card">
    <h2>用手机浏览器打开</h2>
    <div class="qr">${qrSvg(fixedLink)}</div>
    <code id="link">${fixed}</code>
    <div class="row">
      <button id="copy" type="button">复制链接</button>
      <button id="open" class="secondary" type="button">在本机打开</button>
    </div>
    <p class="muted">扫码或打开一次后，手机会记住 30 天；短链本身不会随 DSH 重启变化。</p>
  </section>

  <section class="card">
    <h2>用 DSH App 配对</h2>
    ${pairSection}
  </section>

  <footer>只在 DSH Host 本机可以打开本页；tailnet 访问请直接用上面的固定短链。</footer>
</main>
<script>
  const link = document.getElementById('link');
  document.getElementById('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.textContent.trim());
      document.getElementById('copy').textContent = '已复制';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(link);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.getElementById('copy').textContent = '请手动复制';
    }
  });
  document.getElementById('open').addEventListener('click', () => { location.href = link.textContent.trim(); });
</script>
</body>
</html>`
}

/** Escape one string for HTML text and attribute contexts. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]))
}

/**
 * Build the short-link request handler.
 * @param {object} options - handler options.
 * @param {string} options.code - the accepted access code.
 * @param {string} options.path - normalized route prefix.
 * @param {{ authenticatedUrl?: (url: string) => string, authorizeIndex?: (req: object, res: object, secure?: boolean) => unknown } | undefined} options.connection - DSH connection service.
 * @param {string} options.baseUrl - advertised public base including any path prefix.
 * @param {Set<string>} options.allowedOrigins - origins allowed verbatim.
 * @param {string} [options.publicPath] - application path prefix, no trailing slash.
 * @param {'http:' | 'https:'} [options.protocol] - listener protocol.
 * @param {boolean} [options.landing] - serve the onboarding page at the bare prefix.
 * @param {string} [options.landingBaseUrl] - tailnet base used by the onboarding page.
 * @param {string} [options.localOrigin] - loopback origin for the pairing-token probe.
 * @param {(message: string) => void} [options.log] - message sink.
 * @param {(key: string) => { allowed: boolean, retryAfter: number }} [options.limiter] - failure limiter.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createShortlinkHandler(options) {
  const path = options.path.replace(/\/+$/, '')
  const prefix = `${path}/`
  const limiter = options.limiter ?? createFailureLimiter()
  const log = options.log ?? (() => {})
  const landing = options.landing !== false

  return async (request, response) => {
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

    if (pathname === path || pathname === prefix) {
      if (!landing || !isLoopbackRequest(request)) {
        notFound(response)
        return
      }
      const base = (options.landingBaseUrl ?? options.baseUrl ?? '').replace(/\/+$/, '')
      const fixedLink = `${base}${path}/${options.code}`
      const pairingUrl = await fetchPairingUrl(options.localOrigin)
      writeHtml(response, 200, renderLandingPage({
        fixedLink,
        ...(pairingUrl === undefined ? {} : { pairingUrl }),
      }))
      return
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
      writeHtml(response, 404, renderShortlinkError())
      return
    }

    const base = pickRedirectBase(
      request,
      options.allowedOrigins,
      options.baseUrl,
      options.publicPath ?? '',
      options.protocol ?? 'http:',
    )
    const clean = `${base.replace(/\/+$/, '')}/`
    const headers = {
      location: clean,
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
      expires: '0',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    }

    // Preferred path: mint DSH's own session cookie and land on the clean URL.
    // Nothing token-shaped enters the address bar or a redirect cache.
    const cookies = mintSessionCookie(options.connection, base, options.protocol ?? 'http:')
    if (cookies !== undefined) {
      headers['set-cookie'] = cookies
      response.writeHead(303, headers)
      response.end()
      return
    }

    // Compatibility fallback for a host whose connection service exposes only
    // the tokenized URL: redirect through it, still without caching.
    try {
      if (typeof options.connection?.authenticatedUrl === 'function') {
        headers.location = options.connection.authenticatedUrl(clean)
      }
    } catch {
      // fall through to the clean URL; an existing cookie may still work
    }
    response.writeHead(302, headers)
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

/** One small page for an expired or wrong code. */
function renderShortlinkError() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>链接无效</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px 20px;background:#f5f7fb;color:#162033}main{max-width:560px;margin:0 auto}h1{font-size:22px}p{color:#4d5a6e}</style>
</head><body><main><h1>这个短链无效或已轮换</h1>
<p>请在运行 DSH 的那台机器上打开 <code>/t</code> 页面获取最新的固定短链，然后重新扫码或打开。</p>
<p>如果 DSH 重启过，短链本身不变；如果重启后仍打不开，请检查 shortlink 的状态和 access code 是否被轮换。</p>
</main></body></html>`
}

/** Write one HTML response with no caching. */
function writeHtml(response, status, html) {
  const body = Buffer.from(html, 'utf8')
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  })
  response.end(body)
}

/** Write one plain 404 with no information about whether a code exists. */
function notFound(response) {
  const body = 'not found\n'
  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  response.end(body)
}
