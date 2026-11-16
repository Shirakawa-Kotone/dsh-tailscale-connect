/**
 * Tailscale fact discovery for the `tailscale-access` bundle row.
 *
 * Everything here is synchronous on purpose: the bundle patch reads
 * `ctx.tailscaleAccess.bindHost` and `.trustedHosts` while the `webserver` and
 * `connection` rows are being configured, so the service must exist with final
 * values as soon as `apply()` returns. The only external process is
 * `tailscale status --json`, capped at 3 s and best effort; without the CLI the
 * plugin still works from the OS interface table.
 *
 * @module dsh-tailscale-connect/discovery
 */

import { spawnSync } from 'node:child_process'
import { hostname as osHostname, networkInterfaces } from 'node:os'

/** First address of Tailscale's CGNAT IPv4 range. */
const CGNAT_START = '100.64.0.0'
/** Last address of Tailscale's CGNAT IPv4 range. */
const CGNAT_END = '100.127.255.255'
/** Prefix text of Tailscale's IPv6 ULA range (`fd7a:115c:a1e0::/48`). */
const TAILSCALE_ULA_PREFIX = 'fd7a:115c:a1e0:'

/**
 * Convert one dotted-quad IPv4 literal to an unsigned integer.
 * @param {string} ip - dotted quad.
 * @returns {number} numeric value.
 */
export function ipv4ToInt(ip) {
  const parts = ip.split('.')
  return (((Number(parts[0]) * 256 + Number(parts[1])) * 256 + Number(parts[2])) * 256) + Number(parts[3])
}

/**
 * Whether one IPv4 literal belongs to Tailscale's CGNAT range.
 * @param {string} ip - dotted quad.
 * @returns {boolean} true for 100.64.0.0/10.
 */
export function isTailnetIPv4(ip) {
  if (typeof ip !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false
  const value = ipv4ToInt(ip)
  return value >= ipv4ToInt(CGNAT_START) && value <= ipv4ToInt(CGNAT_END)
}

/**
 * Whether one IPv6 literal belongs to Tailscale's ULA range.
 * @param {string} ip - IPv6 literal, with or without a zone id.
 * @returns {boolean} true for fd7a:115c:a1e0::/48.
 */
export function isTailnetIPv6(ip) {
  if (typeof ip !== 'string' || ip === '') return false
  const zone = ip.indexOf('%')
  const text = (zone === -1 ? ip : ip.slice(0, zone)).toLowerCase()
  return text.startsWith(TAILSCALE_ULA_PREFIX)
}

/**
 * Whether one socket address is a Tailscale peer address.
 *
 * IPv4-mapped IPv6 (`::ffff:100.64.0.2`) is unwrapped first: Node reports a
 * dual-stack listener's IPv4 peers in that form, and the tailnet is IPv4 for
 * almost every deployment.
 * @param {string | undefined} address - `socket.remoteAddress`.
 * @returns {boolean} true for Tailscale CGNAT IPv4, Tailscale ULA IPv6, or loopback.
 */
export function isTailnetAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const lower = address.toLowerCase()
  const plain = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower
  if (plain === '127.0.0.1' || plain === '::1') return true
  return isTailnetIPv4(plain) || isTailnetIPv6(lower)
}

/**
 * Enumerate Tailscale interface addresses from the OS interface table.
 *
 * Works without the `tailscale` CLI and without privileges. Internal
 * interfaces and link-local addresses are skipped.
 * @param {ReturnType<typeof networkInterfaces>} [interfaces] - test seam.
 * @returns {{ v4: string[], v6: string[] }} Tailscale IPv4 and IPv6 literals.
 */
export function tailnetAddresses(interfaces = networkInterfaces()) {
  const v4 = []
  const v6 = []
  for (const ifaces of Object.values(interfaces ?? {})) {
    for (const iface of ifaces ?? []) {
      if (iface.internal === true) continue
      if (iface.family === 'IPv4' && isTailnetIPv4(iface.address)) v4.push(iface.address)
      else if (iface.family === 'IPv6' && isTailnetIPv6(iface.address)) v6.push(iface.address)
    }
  }
  return { v4: dedupe(v4), v6: dedupe(v6) }
}

/** De-duplicate while keeping insertion order. */
function dedupe(values) {
  return [...new Set(values)]
}

/**
 * Run one `tailscale` CLI command synchronously, best effort.
 * @param {string[]} args - CLI arguments.
 * @param {number} [timeoutMs] - spawn timeout.
 * @returns {{ status: number | null, stdout: string, stderr: string }} result.
 */
export function runTailscale(args, timeoutMs = 3000, binary = 'tailscale') {
  try {
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      status: typeof result.status === 'number' ? result.status : null,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    }
  } catch {
    return { status: null, stdout: '', stderr: '' }
  }
}

/**
 * Parse `tailscale status --json` into the few facts this plugin needs.
 * @param {unknown} data - parsed JSON, or a JSON string.
 * @returns {{ dnsName?: string, hostName?: string, suffix?: string, ipv4: string[], ipv6: string[], backendState?: string }} facts.
 */
export function parseTailscaleStatus(data) {
  let value = data
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ipv4: [], ipv6: [] }
    }
  }
  if (value === null || typeof value !== 'object') return { ipv4: [], ipv6: [] }
  const self = /** @type {Record<string, unknown>} */ (value).Self
  const record = self !== null && typeof self === 'object' ? /** @type {Record<string, unknown>} */ (self) : {}
  const dnsName = typeof record.DNSName === 'string' ? record.DNSName.replace(/\.$/, '') : undefined
  const hostName = typeof record.HostName === 'string' ? record.HostName : undefined
  const tailscaleIPs = Array.isArray(record.TailscaleIPs)
    ? record.TailscaleIPs.filter((entry) => typeof entry === 'string')
    : []
  const ipv4 = dedupe(tailscaleIPs.filter((entry) => isTailnetIPv4(entry)))
  const ipv6 = dedupe(tailscaleIPs.filter((entry) => isTailnetIPv6(entry)))
  const suffixCandidates = [
    /** @type {Record<string, unknown>} */ (value).MagicDNSSuffix,
    /** @type {Record<string, unknown>} */ (value).CurrentTailnet?.MagicDNSSuffix,
  ]
  const suffix = suffixCandidates.find((entry) => typeof entry === 'string' && entry !== '')
  const backendState = typeof record.BackendState === 'string' ? record.BackendState : undefined
  return {
    ...(dnsName === undefined || dnsName === '' ? {} : { dnsName }),
    ...(hostName === undefined || hostName === '' ? {} : { hostName }),
    ...(typeof suffix === 'string' ? { suffix } : {}),
    ipv4,
    ipv6,
    ...(backendState === undefined ? {} : { backendState }),
  }
}

/**
 * Read the live Tailscale status once.
 * @param {object} [deps] - test seams.
 * @param {(args: string[], timeoutMs?: number) => { status: number | null, stdout: string, stderr: string }} [deps.run] - CLI runner.
 * @returns {ReturnType<typeof parseTailscaleStatus> | undefined} parsed facts, or undefined when the CLI is absent.
 */
export function readTailscaleStatus(deps = {}) {
  const run = deps.run ?? runTailscale
  const binary = deps.binary ?? 'tailscale'
  const result = run(['status', '--json'], 3000, binary)
  if (result.status !== 0 || result.stdout.trim() === '') return undefined
  return parseTailscaleStatus(result.stdout)
}

/**
 * Resolve this machine's tailnet facts.
 *
 * Hostname precedence: explicit config > `tailscale status --json` DNSName >
 * `<os hostname>.<config.tailnet>`. Address precedence: OS interface table >
 * `tailscale status` TailscaleIPs > `tailscale ip -4`.
 * @param {{ hostName?: string, tailnet?: string }} [config] - plugin config.
 * @param {object} [deps] - test seams.
 * @param {ReturnType<typeof networkInterfaces>} [deps.interfaces] - interface table.
 * @param {(args: string[], timeoutMs?: number) => { status: number | null, stdout: string, stderr: string }} [deps.run] - CLI runner.
 * @returns {{ hostname?: string, ipv4: string[], ipv6: string[], backendState?: string, source: 'config' | 'tailscale' | 'interface' | 'none' }} facts.
 */
export function discover(config = {}, deps = {}) {
  const interfaces = deps.interfaces ?? networkInterfaces()
  const run = deps.run ?? runTailscale
  const binary = deps.binary ?? 'tailscale'
  const fromInterfaces = tailnetAddresses(interfaces)
  const status = readTailscaleStatus({ run, binary })
  const fromCli = status ?? { ipv4: [], ipv6: [] }

  const configured = typeof config.hostName === 'string' && config.hostName !== '' ? config.hostName : ''
  let hostname = configured
  let source = 'none'
  if (configured !== '') source = 'config'
  if (hostname === '' && status?.dnsName !== undefined) {
    hostname = status.dnsName
    source = 'tailscale'
  }
  if (hostname === '' && (fromInterfaces.v4.length > 0 || fromCli.ipv4.length > 0)
    && typeof config.tailnet === 'string' && config.tailnet !== '') {
    const short = osHostname().split('.')[0]
    if (short !== '') {
      hostname = `${short}.${config.tailnet}`
      source = 'config'
    }
  }
  if (hostname === '' && status?.suffix !== undefined) {
    const short = status.hostName ?? osHostname().split('.')[0]
    if (short !== '') {
      hostname = `${short}.${status.suffix}`
      source = 'tailscale'
    }
  }

  const ipv4 = dedupe([...fromInterfaces.v4, ...fromCli.ipv4])
  const ipv6 = dedupe([...fromInterfaces.v6, ...fromCli.ipv6])
  if (ipv4.length === 0) {
    const cliIP = run(['ip', '-4'], 3000, binary)
    if (cliIP.status === 0) {
      for (const line of cliIP.stdout.split('\n')) {
        const text = line.trim()
        if (isTailnetIPv4(text)) ipv4.push(text)
      }
    }
  }

  return {
    ...(hostname === '' ? {} : { hostname }),
    ipv4: dedupe(ipv4),
    ipv6: dedupe(ipv6),
    ...(status?.backendState === undefined ? {} : { backendState: status.backendState }),
    source: source === 'none' && (ipv4.length > 0 || ipv6.length > 0) ? 'interface' : source,
  }
}
