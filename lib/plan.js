/**
 * Pure projection of one tailnet-access configuration into the facts the
 * bundle patch and the operator-facing log need.
 *
 * Kept free of Cordis, sockets and child processes so every branch can be
 * unit-tested without booting the harness.
 *
 * @module dsh-tailscale-connect/plan
 */

import { httpUrl, normalizeServePath, withPath } from './urls.js'

/**
 * Bind address the DSH web server should use for one mode.
 *
 * Both supported modes keep the DSH listener on loopback: `dsh-host-webserver`
 * rejects wildcard addresses on 0.2.x, and the proxy/serve ingress is what
 * faces the tailnet. The value is still exposed as `tailscaleAccess.bindHost`
 * for diagnostics and for a future composition that wants to assert it.
 * @param {'proxy' | 'serve'} mode - access mode.
 * @returns {string} bind address.
 */
export function bindHostFor(mode) {
  return '127.0.0.1'
}

/**
 * Whether a bind address is loopback (any 127/8 address or ::1).
 * @param {string | undefined} host - bind address.
 * @returns {boolean} true for loopback.
 */
export function isLoopbackBind(host) {
  if (typeof host !== 'string') return false
  return host === '::1' || host === '[::1]' || host === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * Build one access plan.
 * @param {object} input - plan input.
 * @param {ReturnType<import('./index.js').normalizeConfig>} input.config - normalized config.
 * @param {{ hostname?: string, ipv4: string[], ipv6: string[] }} input.facts - tailnet discovery.
 * @param {{ port: number, host?: string, protocol?: string }} input.server - bound DSH web server.
 * @returns {{ mode: string, bindHost: string, urls: string[], pairOrigin?: string, listen?: { host: string, port: number } }} plan.
 */
export function buildAccessPlan({ config, facts, server }) {
  const mode = config.mode

  if (mode === 'serve') {
    const servePath = normalizeServePath(config.servePath)
    const scheme = config.serveSecure ? 'https' : 'http'
    const hostname = typeof facts.hostname === 'string' ? facts.hostname : ''
    const base = httpUrl(hostname, config.servePort, scheme)
    const url = base === undefined ? undefined : withPath(base, servePath)
    const rootPath = servePath === ''
    return {
      mode,
      bindHost: bindHostFor(mode),
      urls: url === undefined ? [] : [url],
      // remote-bridge keeps only the URL origin; a prefix cannot be published.
      ...(url === undefined || !rootPath ? {} : { pairOrigin: url }),
    }
  }

  const listenHost = config.bindAddress !== '' ? config.bindAddress : facts.ipv4[0]
  const listenPort = config.port === 0 ? server.port : config.port
  // Advertise only the hostnames that actually land on this listener: MagicDNS
  // (resolves to the tailnet IP) plus the bound literal itself. Advertising
  // every discovered IPv4 would print URLs for addresses this process does not
  // listen on.
  const urlHosts = [
    ...new Set([
      ...(typeof facts.hostname === 'string' && facts.hostname !== '' ? [facts.hostname] : []),
      ...(listenHost === undefined || listenHost === '' ? [] : [listenHost]),
    ]),
  ]
  const urls = urlHosts
    .map((host) => httpUrl(host, listenPort))
    .filter((url) => url !== undefined)
  // The phone must dial the listener this activation actually owns: MagicDNS
  // when known, otherwise the bound literal (an explicit bindAddress wins over
  // a discovered address because that is where the socket really is).
  const pairHost = typeof facts.hostname === 'string' && facts.hostname !== ''
    ? facts.hostname
    : listenHost
  return {
    mode: 'proxy',
    bindHost: bindHostFor('proxy'),
    urls,
    ...(listenHost === undefined || listenHost === ''
      ? {}
      : { listen: { host: listenHost, port: listenPort } }),
    ...(pairHost === undefined || pairHost === '' ? {} : { pairOrigin: httpUrl(pairHost, listenPort) }),
  }
}
