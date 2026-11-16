import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildServeArgs,
  buildServeOffArgs,
  classifyServe,
  configureServe,
  isLoopbackProxy,
  parseServeStatus,
  proxyTargetsLoopbackPort,
  removeServe,
  runTailscale,
} from '../lib/serve.js'
import { resolveTailscaleBinary } from '../lib/tailscale.js'

const STATUS = {
  TCP: { '80': { HTTP: true } },
  Web: {
    'dsh-host.tailnet-example.ts.net:80': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:3080' } },
    },
    'dsh-host.tailnet-example.ts.net:7259': {
      Handlers: { '/': { Proxy: 'https://127.0.0.1:4321' } },
    },
    'dsh-host.tailnet-example.ts.net:8443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:4100' },
        '/api': { Proxy: 'http://127.0.0.1:4100/api' },
      },
    },
  },
}

test('buildServeArgs produces the non-interactive HTTP command', () => {
  assert.deepEqual(buildServeArgs({ port: 3080 }), [
    'serve', '--http=80', '--bg', '--yes', '3080',
  ])
  assert.deepEqual(buildServeArgs({ port: 3080, servePort: 8443, servePath: '/dsh', secure: true }), [
    'serve', '--https=8443', '--bg', '--yes', '--set-path=/dsh', '3080',
  ])
})

test('buildServeOffArgs removes exactly one port', () => {
  assert.deepEqual(buildServeOffArgs({ servePort: 80 }), ['serve', '--http=80', 'off'])
  assert.deepEqual(buildServeOffArgs({ servePort: 8443, secure: true }), ['serve', '--https=8443', 'off'])
})

test('parseServeStatus flattens Web handlers', () => {
  const rows = parseServeStatus(STATUS)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows[0], {
    hostPort: 'dsh-host.tailnet-example.ts.net:80',
    path: '/',
    proxy: 'http://127.0.0.1:3080',
  })
  assert.deepEqual(parseServeStatus('not json'), [])
  assert.deepEqual(parseServeStatus({}), [])
})

test('proxyTargetsLoopbackPort accepts loopback targets only', () => {
  assert.equal(proxyTargetsLoopbackPort('http://127.0.0.1:3080', 3080), true)
  assert.equal(proxyTargetsLoopbackPort('http://localhost:3080/', 3080), true)
  assert.equal(proxyTargetsLoopbackPort('http://127.0.0.1:3081', 3080), false)
  assert.equal(proxyTargetsLoopbackPort('http://10.0.0.2:3080', 3080), false)
  assert.equal(proxyTargetsLoopbackPort('not a url', 3080), false)
})

test('isLoopbackProxy recognizes stale loopback routes', () => {
  assert.equal(isLoopbackProxy('http://127.0.0.1:4101'), true)
  assert.equal(isLoopbackProxy('https://localhost:8443/'), true)
  assert.equal(isLoopbackProxy('http://10.0.0.2:4101'), false)
  assert.equal(isLoopbackProxy('unix:/tmp/sock'), false)
})

test('classifyServe distinguishes absent, exact, stale and conflict', () => {
  const target = 'http://127.0.0.1:3080'
  assert.deepEqual(
    classifyServe({ Web: {}, TCP: {} }, { servePort: 9000, target }),
    { kind: 'absent' },
  )
  assert.equal(
    classifyServe(STATUS, { servePort: 80, target, hostname: 'dsh-host.tailnet-example.ts.net' }).kind,
    'exact',
  )
  assert.equal(
    classifyServe(STATUS, { servePort: 7259, target, hostname: 'dsh-host.tailnet-example.ts.net' }).kind,
    'stale',
  )
  assert.equal(
    classifyServe(STATUS, { servePort: 8443, target, hostname: 'dsh-host.tailnet-example.ts.net' }).kind,
    'conflict',
  )
  assert.equal(
    classifyServe({ TCP: { '80': { HTTP: true } }, Web: {} }, { servePort: 80, target }).kind,
    'conflict',
  )
  assert.equal(classifyServe(undefined, { servePort: 80, target }).kind, 'conflict')
})

test('classifyServe reports the hostname that owns a conflicting port', () => {
  const result = classifyServe(STATUS, {
    servePort: 8443,
    target: 'http://127.0.0.1:3080',
    hostname: 'other.tailnet-example.ts.net',
  })
  assert.equal(result.kind, 'conflict')
  assert.match(result.reason, /dsh-host\.tailnet-example\.ts\.net:8443/)
})

test('configureServe refuses to replace a conflicting route', () => {
  const calls = []
  const run = (args) => {
    calls.push(args)
    if (args[0] === 'serve' && args[1] === 'status') {
      return { ok: true, status: 0, stdout: JSON.stringify(STATUS), stderr: '' }
    }
    return { ok: true, status: 0, stdout: '', stderr: '' }
  }
  const outcome = configureServe({
    port: 3080,
    servePort: 8443,
    hostname: 'dsh-host.tailnet-example.ts.net',
    run,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.conflict, true)
  assert.equal(calls.filter((args) => args[1] !== 'status').length, 0)
})

test('configureServe claims an exact existing route without writing', () => {
  const calls = []
  const run = (args) => {
    calls.push(args)
    if (args[0] === 'serve' && args[1] === 'status') {
      return { ok: true, status: 0, stdout: JSON.stringify(STATUS), stderr: '' }
    }
    return { ok: true, status: 0, stdout: '', stderr: '' }
  }
  const outcome = configureServe({
    port: 3080,
    servePort: 80,
    hostname: 'dsh-host.tailnet-example.ts.net',
    run,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.existing, true)
  assert.equal(outcome.claimed, true)
  assert.equal(calls.filter((args) => args[1] !== 'status').length, 0)
})

test('configureServe writes a missing route and verifies it', () => {
  let written = false
  const run = (args) => {
    if (args[0] === 'serve' && args[1] === 'status') {
      if (!written) return { ok: true, status: 0, stdout: JSON.stringify({ Web: {}, TCP: {} }), stderr: '' }
      return {
        ok: true,
        status: 0,
        stdout: JSON.stringify({
          Web: { 'dsh-host.tailnet-example.ts.net:8090': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3080' } } } },
          TCP: {},
        }),
        stderr: '',
      }
    }
    written = true
    return { ok: true, status: 0, stdout: 'ok', stderr: '' }
  }
  const outcome = configureServe({
    port: 3080,
    servePort: 8090,
    hostname: 'dsh-host.tailnet-example.ts.net',
    run,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.claimed, true)
  assert.deepEqual(outcome.args, ['serve', '--http=8090', '--bg', '--yes', '3080'])
})

test('configureServe reports a write failure verbatim', () => {
  const run = (args) => {
    if (args[0] === 'serve' && args[1] === 'status') {
      return { ok: true, status: 0, stdout: JSON.stringify({ Web: {}, TCP: {} }), stderr: '' }
    }
    return { ok: false, status: 1, stdout: '', stderr: 'cannot enable HTTPS\nmore detail' }
  }
  const outcome = configureServe({ port: 3080, servePort: 80, run })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.detail, 'cannot enable HTTPS')
})

test('removeServe runs the single-port off command', () => {
  const calls = []
  const run = (args) => {
    calls.push(args)
    return { ok: true, status: 0, stdout: '', stderr: '' }
  }
  assert.deepEqual(removeServe({ servePort: 7259, secure: true, run }), { ok: true })
  assert.deepEqual(calls, [['serve', '--https=7259', 'off']])
})

test('runTailscale reports a missing binary instead of throwing', () => {
  const result = runTailscale(['serve', 'status', '--json'], 1000, '/definitely/not/a/binary')
  assert.equal(result.ok, false)
  assert.equal(typeof result.detail, 'string')
})

test('resolveTailscaleBinary prefers config, then TAILSCALE_PATH, then candidates', () => {
  const original = process.env.TAILSCALE_PATH
  try {
    assert.equal(resolveTailscaleBinary('/custom/tailscale', 'darwin', () => false), '/custom/tailscale')
    process.env.TAILSCALE_PATH = '/env/tailscale'
    assert.equal(resolveTailscaleBinary('', 'darwin', () => false), '/env/tailscale')
    delete process.env.TAILSCALE_PATH
    assert.equal(
      resolveTailscaleBinary(undefined, 'darwin', (candidate) => candidate === '/opt/homebrew/bin/tailscale'),
      '/opt/homebrew/bin/tailscale',
    )
    assert.equal(resolveTailscaleBinary(undefined, 'darwin', () => false), 'tailscale')
  } finally {
    if (original === undefined) delete process.env.TAILSCALE_PATH
    else process.env.TAILSCALE_PATH = original
  }
})
