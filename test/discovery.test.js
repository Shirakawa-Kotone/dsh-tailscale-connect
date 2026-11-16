import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  discover,
  isTailnetAddress,
  isTailnetIPv4,
  isTailnetIPv6,
  parseTailscaleStatus,
  tailnetAddresses,
} from '../lib/discovery.js'

const STATUS = {
  Self: {
    DNSName: 'dsh-host.tailnet-example.ts.net.',
    HostName: 'dsh-host',
    TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
    BackendState: 'Running',
  },
  MagicDNSSuffix: 'tailnet-example.ts.net',
}

test('isTailnetIPv4 accepts exactly 100.64.0.0/10', () => {
  assert.equal(isTailnetIPv4('100.64.0.0'), true)
  assert.equal(isTailnetIPv4('100.127.255.255'), true)
  assert.equal(isTailnetIPv4('100.63.255.255'), false)
  assert.equal(isTailnetIPv4('100.128.0.0'), false)
  assert.equal(isTailnetIPv4('192.168.1.2'), false)
  assert.equal(isTailnetIPv4('not-an-ip'), false)
})

test('isTailnetIPv6 accepts the Tailscale ULA prefix and tolerates zones', () => {
  assert.equal(isTailnetIPv6('fd7a:115c:a1e0::1'), true)
  assert.equal(isTailnetIPv6('FD7A:115C:A1E0:0:0:0:0:1'), true)
  assert.equal(isTailnetIPv6('fd7a:115c:a1e0::1%utun3'), true)
  assert.equal(isTailnetIPv6('fd00::1'), false)
  assert.equal(isTailnetIPv6('::1'), false)
})

test('isTailnetAddress unwraps IPv4-mapped peers and accepts loopback', () => {
  assert.equal(isTailnetAddress('::ffff:100.64.0.2'), true)
  assert.equal(isTailnetAddress('100.64.0.2'), true)
  assert.equal(isTailnetAddress('127.0.0.1'), true)
  assert.equal(isTailnetAddress('::1'), true)
  assert.equal(isTailnetAddress('192.168.1.5'), false)
  assert.equal(isTailnetAddress('8.8.8.8'), false)
  assert.equal(isTailnetAddress(undefined), false)
})

test('tailnetAddresses filters the OS interface table', () => {
  const interfaces = {
    lo0: [{ internal: true, family: 'IPv4', address: '127.0.0.1' }],
    utun3: [
      { internal: false, family: 'IPv4', address: '100.64.0.1' },
      { internal: false, family: 'IPv6', address: 'fd7a:115c:a1e0::1' },
      { internal: false, family: 'IPv6', address: 'fe80::1' },
    ],
    en0: [{ internal: false, family: 'IPv4', address: '192.168.1.5' }],
  }
  assert.deepEqual(tailnetAddresses(interfaces), { v4: ['100.64.0.1'], v6: ['fd7a:115c:a1e0::1'] })
})

test('parseTailscaleStatus reads DNSName, IPs and the suffix', () => {
  const parsed = parseTailscaleStatus(JSON.stringify(STATUS))
  assert.equal(parsed.dnsName, 'dsh-host.tailnet-example.ts.net')
  assert.equal(parsed.hostName, 'dsh-host')
  assert.equal(parsed.suffix, 'tailnet-example.ts.net')
  assert.equal(parsed.backendState, 'Running')
  assert.deepEqual(parsed.ipv4, ['100.64.0.1'])
  assert.deepEqual(parsed.ipv6, ['fd7a:115c:a1e0::1'])
})

test('parseTailscaleStatus survives malformed input', () => {
  assert.deepEqual(parseTailscaleStatus('not json').ipv4, [])
  assert.deepEqual(parseTailscaleStatus(null).ipv4, [])
})

test('discover merges interface and CLI facts, MagicDNS first', () => {
  const interfaces = {
    utun3: [{ internal: false, family: 'IPv4', address: '100.64.0.1' }],
  }
  const calls = []
  const run = (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify(STATUS), stderr: '' }
    return { status: 0, stdout: '100.64.0.1\n', stderr: '' }
  }
  const facts = discover({ tailnet: 'ignored.example' }, { interfaces, run })
  assert.equal(facts.hostname, 'dsh-host.tailnet-example.ts.net')
  assert.deepEqual(facts.ipv4, ['100.64.0.1'])
  assert.equal(facts.source, 'tailscale')
  assert.ok(calls.some((call) => call === 'status --json'))
})

test('discover falls back to <hostname>.<tailnet> when the CLI is absent', () => {
  const interfaces = {
    utun3: [{ internal: false, family: 'IPv4', address: '100.64.0.1' }],
  }
  const run = () => ({ status: 127, stdout: '', stderr: 'not found' })
  const facts = discover({ tailnet: 'tailnet-example.ts.net' }, { interfaces, run })
  assert.match(facts.hostname, /\.tailnet-example\.ts\.net$/)
  assert.equal(facts.source, 'config')
})

test('discover honors an explicit hostName over discovery', () => {
  const interfaces = {}
  const run = () => ({ status: 0, stdout: JSON.stringify(STATUS), stderr: '' })
  const facts = discover({ hostName: 'override.example.ts.net' }, { interfaces, run })
  assert.equal(facts.hostname, 'override.example.ts.net')
  assert.equal(facts.source, 'config')
})
