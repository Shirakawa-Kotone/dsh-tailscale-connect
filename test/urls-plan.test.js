import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  authoritiesFromUrls,
  normalizeConfig,
} from '../lib/index.js'
import {
  authorityOf,
  formatHost,
  httpUrl,
  normalizeServePath,
  preferredHost,
  trustedAuthorities,
  withPath,
} from '../lib/urls.js'
import { buildAccessPlan, bindHostFor, isLoopbackBind } from '../lib/plan.js'

test('formatHost brackets IPv6 only', () => {
  assert.equal(formatHost('100.64.0.1'), '100.64.0.1')
  assert.equal(formatHost('dsh-host.tailnet-example.ts.net'), 'dsh-host.tailnet-example.ts.net')
  assert.equal(formatHost('fd7a:115c:a1e0::1'), '[fd7a:115c:a1e0::1]')
  assert.equal(formatHost('[fd7a:115c:a1e0::1]'), '[fd7a:115c:a1e0::1]')
  assert.equal(formatHost(''), '')
})

test('authorityOf and httpUrl omit default ports', () => {
  assert.equal(authorityOf('100.64.0.1', 3080), '100.64.0.1:3080')
  assert.equal(httpUrl('dsh-host.tailnet-example.ts.net', 3080), 'http://dsh-host.tailnet-example.ts.net:3080')
  assert.equal(httpUrl('dsh-host.tailnet-example.ts.net', 80), 'http://dsh-host.tailnet-example.ts.net')
  assert.equal(httpUrl('dsh-host.tailnet-example.ts.net', 443, 'https'), 'https://dsh-host.tailnet-example.ts.net')
  assert.equal(httpUrl('', 3080), undefined)
})

test('trustedAuthorities includes hostname, literals and extra entries', () => {
  const values = trustedAuthorities(
    { hostname: 'dsh-host.tailnet-example.ts.net', ipv4: ['100.64.0.1'], ipv6: ['fd7a:115c:a1e0::1'] },
    ['custom.example', 'custom.example'],
  )
  assert.deepEqual(values, [
    'dsh-host.tailnet-example.ts.net',
    '100.64.0.1',
    '[fd7a:115c:a1e0::1]',
    'custom.example',
  ])
})

test('preferredHost prefers MagicDNS, then IPv4, then IPv6', () => {
  assert.equal(preferredHost({ hostname: 'a.ts.net', ipv4: ['100.1.1.1'] }), 'a.ts.net')
  assert.equal(preferredHost({ ipv4: ['100.1.1.1'], ipv6: ['fd7a::1'] }), '100.1.1.1')
  assert.equal(preferredHost({ ipv6: ['fd7a::1'] }), 'fd7a::1')
  assert.equal(preferredHost({}), undefined)
})

test('normalizeServePath and withPath normalize prefixes', () => {
  assert.equal(normalizeServePath(''), '')
  assert.equal(normalizeServePath('/'), '')
  assert.equal(normalizeServePath('dsh//'), '/dsh')
  assert.equal(normalizeServePath('/dsh/'), '/dsh')
  assert.equal(withPath('https://a.ts.net', ''), 'https://a.ts.net')
  assert.equal(withPath('https://a.ts.net/', '/dsh'), 'https://a.ts.net/dsh')
})

test('authoritiesFromUrls returns canonical host[:port] values', () => {
  assert.deepEqual(
    authoritiesFromUrls(['http://dsh-host.tailnet-example.ts.net:3080/', 'http://100.64.0.1:3080', 'bad']),
    ['dsh-host.tailnet-example.ts.net:3080', '100.64.0.1:3080'],
  )
})

test('normalizeConfig applies defaults and validates ranges', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.mode, 'proxy')
  assert.equal(defaults.port, 0)
  assert.equal(defaults.servePort, 80)
  assert.equal(defaults.serveSecure, false)
  assert.equal(defaults.publishPairOrigin, true)
  assert.equal(defaults.printUrl, true)
  assert.deepEqual(defaults.extraTrustedHosts, [])

  const custom = normalizeConfig({
    mode: 'serve',
    port: 4400,
    servePort: 8443,
    servePath: 'dsh/',
    serveSecure: true,
    overwriteServe: true,
    publishPairOrigin: false,
    extraTrustedHosts: [' a.test ', '', 3],
  })
  assert.equal(custom.mode, 'serve')
  assert.equal(custom.port, 4400)
  assert.equal(custom.servePort, 8443)
  assert.equal(custom.servePath, '/dsh')
  assert.equal(custom.serveSecure, true)
  assert.equal(custom.overwriteServe, true)
  assert.equal(custom.publishPairOrigin, false)
  assert.deepEqual(custom.extraTrustedHosts, ['a.test'])

  assert.equal(normalizeConfig({ mode: 'nonsense' }).mode, 'proxy')
  assert.equal(normalizeConfig({ servePort: 99999 }).servePort, 80)
})

test('bindHostFor and isLoopbackBind', () => {
  assert.equal(bindHostFor('proxy'), '127.0.0.1')
  assert.equal(bindHostFor('serve'), '127.0.0.1')
  assert.equal(isLoopbackBind('127.0.0.1'), true)
  assert.equal(isLoopbackBind('127.4.5.6'), true)
  assert.equal(isLoopbackBind('::1'), true)
  assert.equal(isLoopbackBind('100.64.0.1'), false)
  assert.equal(isLoopbackBind(undefined), false)
})

test('buildAccessPlan: proxy uses the tailnet IP and the web port', () => {
  const config = normalizeConfig({})
  const facts = { hostname: 'dsh-host.tailnet-example.ts.net', ipv4: ['100.64.0.1'], ipv6: [] }
  const plan = buildAccessPlan({ config, facts, server: { port: 3080, host: '127.0.0.1' } })
  assert.deepEqual(plan.listen, { host: '100.64.0.1', port: 3080 })
  assert.equal(plan.pairOrigin, 'http://dsh-host.tailnet-example.ts.net:3080')
  assert.deepEqual(plan.urls, [
    'http://dsh-host.tailnet-example.ts.net:3080',
    'http://100.64.0.1:3080',
  ])
})

test('buildAccessPlan: proxy honors an explicit port and bind address', () => {
  const config = normalizeConfig({ port: 8443, bindAddress: '100.64.0.9' })
  const facts = { ipv4: ['100.64.0.1'], ipv6: [] }
  const plan = buildAccessPlan({ config, facts, server: { port: 3080 } })
  assert.deepEqual(plan.listen, { host: '100.64.0.9', port: 8443 })
  assert.deepEqual(plan.urls, ['http://100.64.0.9:8443'])
  assert.equal(plan.pairOrigin, 'http://100.64.0.9:8443')
})

test('buildAccessPlan: serve publishes the origin only on a root path', () => {
  const facts = { hostname: 'dsh-host.tailnet-example.ts.net', ipv4: ['100.64.0.1'], ipv6: [] }
  const root = buildAccessPlan({
    config: normalizeConfig({ mode: 'serve', servePort: 80 }),
    facts,
    server: { port: 3080 },
  })
  assert.deepEqual(root.urls, ['http://dsh-host.tailnet-example.ts.net'])
  assert.equal(root.pairOrigin, 'http://dsh-host.tailnet-example.ts.net')

  const prefixed = buildAccessPlan({
    config: normalizeConfig({ mode: 'serve', servePort: 8443, serveSecure: true, servePath: '/dsh' }),
    facts,
    server: { port: 3080 },
  })
  assert.deepEqual(prefixed.urls, ['https://dsh-host.tailnet-example.ts.net:8443/dsh'])
  assert.equal(prefixed.pairOrigin, undefined)
})

test('legacy direct mode aliases the tailnet proxy', () => {
  const config = normalizeConfig({ mode: 'direct' })
  assert.equal(config.mode, 'proxy')
  assert.equal(config.legacyDirect, true)
  const facts = { hostname: 'dsh-host.tailnet-example.ts.net', ipv4: ['100.64.0.1'], ipv6: [] }
  const plan = buildAccessPlan({ config, facts, server: { port: 3080 } })
  assert.equal(plan.bindHost, '127.0.0.1')
  assert.deepEqual(plan.listen, { host: '100.64.0.1', port: 3080 })
  assert.deepEqual(plan.urls, [
    'http://dsh-host.tailnet-example.ts.net:3080',
    'http://100.64.0.1:3080',
  ])
})
