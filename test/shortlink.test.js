import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_SHORTLINK_PATH,
  allowedOriginsFor,
  clientKeyOf,
  createFailureLimiter,
  createShortlinkHandler,
  normalizeShortlinkPath,
  originFromRequest,
  pickRedirectBase,
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
      this.body = body
      this.ended = true
    },
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

test('shortlink handler redirects a correct code to the tokenized URL', () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    connection: { authenticatedUrl: (url) => `${url}?token=PROCESS` },
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const res = response()
  handler(request(), res)
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'http://dsh-host.tailnet-example.ts.net:3080/?token=PROCESS')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
})

test('shortlink handler uses the request origin when it is published', () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    connection: { authenticatedUrl: (url) => `${url}?token=P` },
    baseUrl: FALLBACK,
    allowedOrigins: new Set(['http://127.0.0.1:3080']),
  })
  const res = response()
  handler(request({ headers: { host: '127.0.0.1:3080' } }), res)
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'http://127.0.0.1:3080/?token=P')
})

test('shortlink handler hides a wrong code behind 404', () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const res = response()
  handler(request({ url: '/t/wrong-code' }), res)
  assert.equal(res.status, 404)
  assert.equal(res.body, 'not found\n')
})

test('shortlink handler rejects non-GET methods', () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const res = response()
  handler(request({ method: 'POST' }), res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
})

test('shortlink handler rate-limits repeated wrong codes', () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
    limiter: createFailureLimiter({ limit: 1, windowMs: 60_000 }),
  })
  const first = response()
  handler(request({ url: '/t/nope12345' }), first)
  assert.equal(first.status, 404)
  const second = response()
  handler(request({ url: '/t/nope12345' }), second)
  assert.equal(second.status, 429)
  assert.ok(Number(second.headers['retry-after']) > 0)
})

test('shortlink handler falls back to the clean URL without a connection service', () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    baseUrl: FALLBACK,
    allowedOrigins: ALLOWED,
  })
  const res = response()
  handler(request(), res)
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'http://dsh-host.tailnet-example.ts.net:3080/')
})

test('shortlink handler supports a path prefix', () => {
  const handler = createShortlinkHandler({
    code: 'secret1234',
    path: '/t',
    connection: { authenticatedUrl: (url) => `${url}?token=P` },
    baseUrl: 'https://dsh-host.tailnet-example.ts.net:8443/dsh',
    allowedOrigins: new Set(['https://dsh-host.tailnet-example.ts.net:8443']),
    publicPath: '/dsh',
  })
  const res = response()
  handler(request({ headers: { host: 'dsh-host.tailnet-example.ts.net:8443', 'x-forwarded-proto': 'https' } }), res)
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'https://dsh-host.tailnet-example.ts.net:8443/dsh/?token=P')
})

test('clientKeyOf prefers the forwarded chain', () => {
  assert.equal(clientKeyOf(request()), '100.64.0.2')
  assert.equal(
    clientKeyOf(request({ headers: { host: 'x', 'x-forwarded-for': '100.64.0.9, 127.0.0.1' } })),
    '127.0.0.1',
  )
})
