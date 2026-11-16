/**
 * Pure URL and authority helpers for the tailscale-access bundle.
 *
 * Kept separate from discovery so the same strings can be unit-tested without a
 * network interface table or a `tailscale` binary.
 *
 * @module dsh-tailscale-connect/urls
 */

/**
 * Format one host for use inside an authority (IPv6 gets brackets).
 * @param {string} host - IPv4/IPv6 literal or MagicDNS name.
 * @returns {string} URL-safe host text.
 */
export function formatHost(host) {
  if (typeof host !== 'string' || host === '') return ''
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * Join a host and port into one authority.
 * @param {string} host - host literal or name.
 * @param {number} port - TCP port.
 * @returns {string} `host:port`, with IPv6 bracketed.
 */
export function authorityOf(host, port) {
  return `${formatHost(host)}:${String(port)}`
}

/**
 * Build one HTTP(S) URL.
 * @param {string} host - host literal or MagicDNS name.
 * @param {number | undefined} port - TCP port; omitted or standard for the scheme.
 * @param {'http' | 'https'} [scheme] - URL scheme.
 * @returns {string | undefined} the URL, or undefined for an empty host.
 */
export function httpUrl(host, port, scheme = 'http') {
  const formatted = formatHost(host)
  if (formatted === '') return undefined
  const defaultPort = scheme === 'https' ? 443 : 80
  const portPart = port === undefined || port === defaultPort ? '' : `:${String(port)}`
  return `${scheme}://${formatted}${portPart}`
}

/**
 * Authorities the DSH `/api` Host fence must accept for tailnet clients.
 *
 * The fence takes a bare `host` or `host:port`; a port-less entry matches every
 * port, which is what a plugin cannot know before the web server binds. The
 * MagicDNS name comes first so logs read naturally, then every tailnet literal.
 * @param {{ hostname?: string, ipv4?: string[], ipv6?: string[] }} facts - discovery result.
 * @param {string[]} [extra] - user-supplied authorities.
 * @returns {string[]} canonical, de-duplicated trusted authorities.
 */
export function trustedAuthorities(facts = {}, extra = []) {
  const values = [
    facts.hostname,
    ...(facts.ipv4 ?? []),
    ...(facts.ipv6 ?? []).map((ip) => `[${ip}]`),
    ...(Array.isArray(extra) ? extra : []),
  ]
  return [...new Set(values.filter((entry) => typeof entry === 'string' && entry !== ''))]
}

/**
 * Pick the host a remote client should dial when several are known.
 * @param {{ hostname?: string, ipv4?: string[], ipv6?: string[] }} facts - discovery result.
 * @returns {string | undefined} MagicDNS name first, then IPv4, then IPv6.
 */
export function preferredHost(facts = {}) {
  if (typeof facts.hostname === 'string' && facts.hostname !== '') return facts.hostname
  if (Array.isArray(facts.ipv4) && facts.ipv4.length > 0) return facts.ipv4[0]
  if (Array.isArray(facts.ipv6) && facts.ipv6.length > 0) return facts.ipv6[0]
  return undefined
}

/**
 * Normalize one configured serve path: leading slash, no trailing slash,
 * empty string for the root.
 * @param {unknown} value - raw config value.
 * @returns {string} normalized path.
 */
export function normalizeServePath(value) {
  if (typeof value !== 'string' || value === '' || value === '/') return ''
  const withSlash = value.startsWith('/') ? value : `/${value}`
  return withSlash.replace(/\/+$/, '')
}

/**
 * Append a path prefix to a URL.
 * @param {string} url - base URL without trailing slash.
 * @param {string} [path] - normalized prefix, empty for root.
 * @returns {string} the joined URL.
 */
export function withPath(url, path = '') {
  if (path === '') return url
  return `${url.replace(/\/+$/, '')}${path}`
}
