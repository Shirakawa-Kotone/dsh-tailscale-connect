import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import {
  DEFAULT_SHORTLINK_PATH,
  allowedOriginsFor,
  clientKeyOf,
  createFailureLimiter,
  createShortlinkHandler,
  fetchPairingUrl,
  isLoopbackAddress,
  isLoopbackRequest,
  mintSessionCookie,
  normalizeShortlinkPath,
  originFromRequest,
  pickRedirectBase,
  qrSvg,
} from '../lib/shortlink.js'

/** Build one fake request. */
function request(overrides = {}) {
  return {
    method: 'GET',
    url: '/t/secret1234',
    headers: { host: 'dsh-host.tailnet-example.ts.net:3080' },
    socket: { remoteAddress: '100.64.0.2' },
    ...overrides,
  }
}

/** Build one fake response. */
function response() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : body
      this.ended = true
    },
  }
}

/** A connection service that mints a fake cookie from the current token. */
function fakeConnection({ token = 'PROCESS', mint = true } = {}) {
  return {
    authenticatedUrl: (url) => `${url}?token=${token}`,
    ...(mint
      ? {
          authorizeIndex(req, res) {
            const presented = new URL(req.url, 'http://fake/').searchParams.get('token')
            res.writeHead(303, { 'set-cookie': `dsh=${presented}; Path=/` })
            res.end()
          },
        }
      : {}),
  }
}

const FALLBACK = 'http://dsh-host.tailnet-example.ts.net:3080'
const ALLOWED = new Set([FALLBACK])

test('normalizeShortlinkPath produces a clean prefix', () => {
  assert.equal(normalizeShortlinkPath(''), DEFAULT_SHORTLINK_PATH)
  assert.equal(normalizeShortlinkPath('/'), DEFAULT_SHORTLINK_PATH)
  assert.equal(normalizeShortlinkPath('t/'), '/t')
  assert.equal(normalizeShortlinkPath('/gate/'), '/gate')
  assert.equal(normalizeShortlinkPath(undefined), DEFAULT_SHORTLINK_PATH)
})

test('originFromRequest honors forwarded proto and Host', () => {
  assert.equal(
    originFromRequest(request(), 'http:'),
    'http://dsh-host.tailnet-example.ts.net:3080',
  )
  assert.equal(
    originFromRequest(request({ headers: { host: 'dsh-host.tailnet-example.ts.net', 'x-forwarded-proto': 'https' } }), 'http:'),
    'https://dsh-host.tailnet-example.ts.net',
  )
  assert.equal(originFromRequest(request({ headers: {} })), undefined)
})

test('pickRedirectBase only trusts published origins', () => {
  assert.equal(
    pickRedirectBase(request(), ALLOWED, FALLBACK, ''),
    'http://dsh-host.tailnet-example.ts.net:3080',
  )
  assert.equal(
    pickRedirectBase(request({ headers: { host: 'evil.example' } }), ALLOWED, FALLBACK, ''),
    FALLBACK,
  )
  assert.equal(
    pickRedirectBase(
      request({ headers: { host: 'dsh-host.tailnet-example.ts.net', 'x-forwarded-proto': 'https' } }),
      new Set(['https://dsh-host.tailnet-example.ts.net']),
      'https://dsh-host.tailnet-example.ts.net/dsh',
      '/dsh',
    ),
    'https://dsh-host.tailnet-example.ts.net/dsh',
  )
})

test('allowedOriginsFor includes published URLs and loopback', () => {
  const origins = allowedOriginsFor(
    ['http://dsh-host.tailnet-example.ts.net:3080', 'http://100.64.0.1:3080'],
    { host: '127.0.0.1', port: 3080, protocol: 'http:' },
  )
  assert.equal(origins.has('http://dsh-host.tailnet-example.ts.net:3080'), true)
  assert.equal(origins.has('http://100.64.0.1:3080'), true)
  assert.equal(origins.has('http://127.0.0.1:3080'), true)
  assert.equal(origins.has('http://localhost:3080'), true)
})

test('isLoopbackAddress and isLoopbackRequest distinguish local from proxied', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('100.64.0.2'), false)
  assert.equal(isLoopbackRequest(request({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } })), true)
  assert.equal(
    isLoopbackRequest(request({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3080', 'x-forwarded-for': '100.64.0.2' },
    })),
    false,
  )
})

test('qrSvg renders an inline SVG', () => {
  const svg = qrSvg('http://example.test/t/code')
  assert.match(svg, /^<svg/)
  assert.match(svg, /viewBox="0 0 /)
})

test('mintSessionCookie calls authorizeIndex with the current token', () => {
  let seen
  const connection = {
    authenticatedUrl: () => 'http://shortlink.invalid/?token=TOK',
    authorizeIndex(req, res) {
      seen = req.url
      res.writeHead(303, { 'set-cookie': 'dsh=COOKIE; Path=/' })
      res.end()
    },
  }
  const cookies = mintSessionCookie(connection, FALLBACK, 'http:')
  assert.deepEqual(cookies, ['dsh=COOKIE; Path=/'])
  assert.equal(seen, '/?token=TOK')
})

test('mintSessionCookie returns undefined without a minting host', () => {
  assert.equal(mintSessionCookie({ authenticatedUrl: () => 'http://x/?token=T' }, FALLBACK), undefined)
})

test('shortlink handler mints a cookie and redirects to the clean URL', async () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    connection: fakeConnection({ token: 'PROCESS' }),
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const res = response()
  await handler(request(), res)
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, 'http://dsh-host.tailnet-example.ts.net:3080/')
  assert.deepEqual(res.headers['set-cookie'], ['dsh=PROCESS; Path=/'])
  assert.match(res.headers['cache-control'], /no-store/)
  assert.match(res.headers['cache-control'], /no-cache/)
  assert.equal(res.headers.pragma, 'no-cache')
})

test('repeat visits mint a fresh cookie from the current token', async () => {
  const connection = fakeConnection({ token: 'FIRST' })
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    connection,
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const first = response()
  await handler(request(), first)
  connection.authenticatedUrl = (url) => `${url}?token=SECOND`
  const second = response()
  await handler(request(), second)
  assert.deepEqual(first.headers['set-cookie'], ['dsh=FIRST; Path=/'])
  assert.deepEqual(second.headers['set-cookie'], ['dsh=SECOND; Path=/'])
})

test('shortlink handler falls back to the token redirect without minting', async () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    connection: fakeConnection({ mint: false }),
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const res = response()
  await handler(request(), res)
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'http://dsh-host.tailnet-example.ts.net:3080/?token=PROCESS')
})

test('shortlink handler uses the request origin when it is published', async () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    connection: fakeConnection(),
    baseUrl: FALLBACK,
    allowedOrigins: new Set(['http://127.0.0.1:3080']),
  })
  const res = response()
  await handler(request({ headers: { host: '127.0.0.1:3080' } }), res)
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, 'http://127.0.0.1:3080/')
})

test('shortlink handler hides a wrong code behind a short error page', async () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const res = response()
  await handler(request({ url: '/t/wrong-code' }), res)
  assert.equal(res.status, 404)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /短链无效/)
})

test('shortlink handler rejects non-GET methods', async () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const res = response()
  await handler(request({ method: 'POST' }), res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
})

test('shortlink handler rate-limits repeated wrong codes', async () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
    limiter: createFailureLimiter({ limit: 1, windowMs: 60_000 }),
  })
  const first = response()
  await handler(request({ url: '/t/nope12345' }), first)
  assert.equal(first.status, 404)
  const second = response()
  await handler(request({ url: '/t/nope12345' }), second)
  assert.equal(second.status, 429)
  assert.ok(Number(second.headers['retry-after']) > 0)
})

test('bare /t serves the onboarding page to loopback only', async () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    baseUrl: FALLBACK,
    landingBaseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const local = response()
  await handler(request({
    url: '/t',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
  }), local)
  assert.equal(local.status, 200)
  assert.match(local.headers['content-type'], /text\/html/)
  assert.match(local.body, /http:\/\/dsh-host\.tailnet-example\.ts\.net:3080\/t\/secret1234/)
  assert.match(local.body, /<svg/)
  assert.match(local.body, /手机浏览器/)

  const remote = response()
  await handler(request({
    url: '/t',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'x-forwarded-for': '100.64.0.2' },
  }), remote)
  assert.equal(remote.status, 404)
})

test('shortlink handler supports a path prefix', async () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    connection: fakeConnection({ mint: false }),
    baseUrl: 'https://dsh-host.tailnet-example.ts.net:8443/dsh',
    allowedOrigins: new Set(['https://dsh-host.tailnet-example.ts.net:8443']),
    publicPath: '/dsh',
  })
  const res = response()
  await handler(request({ headers: { host: 'dsh-host.tailnet-example.ts.net:8443', 'x-forwarded-proto': 'https' } }), res)
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'https://dsh-host.tailnet-example.ts.net:8443/dsh/?token=PROCESS')
})

test('fetchPairingUrl reads the local pairing token endpoint', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/remote-bridge/pair/token') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ pairingUrl: 'ws://example.test/ios/v1?token=T' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const url = await fetchPairingUrl(`http://127.0.0.1:${address.port}`)
  assert.equal(url, 'ws://example.test/ios/v1?token=T')
})

test('fetchPairingUrl returns undefined when the bridge is absent', async () => {
  assert.equal(await fetchPairingUrl('http://127.0.0.1:1', 300), undefined)
})

test('clientKeyOf prefers the nearest forwarded hop', () => {
  assert.equal(clientKeyOf(request()), '100.64.0.2')
  assert.equal(
    clientKeyOf(request({ headers: { host: 'x', 'x-forwarded-for': '100.64.0.9, 127.0.0.1' } })),
    '127.0.0.1',
  )
})
