/**
 * `tailscale serve` integration for the `serve` mode.
 *
 * Serve terminates the tailnet side and proxies to a loopback service, which is
 * the right shape when the operator already uses Serve (HTTPS certificate,
 * MagicDNS name, no extra port) or wants an `https://`/`wss://` URL that a
 * phone's transport security will accept.
 *
 * The command itself is the only write. Before writing, the current Serve
 * configuration is read and classified, so this plugin never silently replaces
 * a route that belongs to another service; after writing, the mapping is read
 * back and verified. `tailscale serve --http=<port> off` removes exactly the
 * port this plugin claimed — it is the one documented way to undo a single
 * handler without `tailscale serve reset` wiping every other service.
 *
 * @module dsh-tailscale-connect/serve
 */

import { spawnSync } from 'node:child_process'
import { normalizeServePath } from './urls.js'

/**
 * Run one `tailscale` command synchronously.
 * @param {string[]} args - CLI arguments.
 * @param {number} [timeoutMs] - spawn timeout.
 * @param {string} [binary] - executable name or absolute path.
 * @returns {{ ok: boolean, status: number | null, stdout: string, stderr: string, detail?: string }} result.
 */
export function runTailscale(args, timeoutMs = 15000, binary = 'tailscale') {
  try {
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const stderr = typeof result.stderr === 'string' ? result.stderr : ''
    const status = typeof result.status === 'number' ? result.status : null
    const detail = result.error !== undefined
      ? result.error.message
      : (stderr || stdout).trim().split('\n')[0]
    return {
      ok: status === 0,
      status,
      stdout,
      stderr,
      ...(detail === '' ? {} : { detail }),
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Build the `tailscale serve` command line for one backend port.
 * @param {object} options - command options.
 * @param {number} options.port - backend (DSH web server) port.
 * @param {number} [options.servePort] - tailnet-side port, default 80.
 * @param {string} [options.servePath] - path prefix, empty for root.
 * @param {boolean} [options.secure] - use `--https` instead of `--http`.
 * @returns {string[]} arguments including the leading `serve`.
 */
export function buildServeArgs({ port, servePort = 80, servePath = '', secure = false }) {
  const normalizedPath = normalizeServePath(servePath)
  const args = ['serve', `${secure ? '--https' : '--http'}=${String(servePort)}`, '--bg', '--yes']
  if (normalizedPath !== '') args.push(`--set-path=${normalizedPath}`)
  args.push(String(port))
  return args
}

/**
 * Build the command that removes one port's Serve configuration.
 * @param {{ servePort: number, secure?: boolean }} options - port and scheme.
 * @returns {string[]} arguments including the leading `serve`.
 */
export function buildServeOffArgs({ servePort, secure = false }) {
  return ['serve', `${secure ? '--https' : '--http'}=${String(servePort)}`, 'off']
}

/**
 * Parse `tailscale serve status --json` into flat handler rows.
 * @param {unknown} input - parsed JSON or raw text.
 * @returns {{ hostPort: string, path: string, proxy: string }[]} handler rows.
 */
export function parseServeStatus(input) {
  let status = input
  if (typeof input === 'string') {
    try {
      status = JSON.parse(input)
    } catch {
      return []
    }
  }
  if (status === null || typeof status !== 'object') return []
  const web = /** @type {Record<string, unknown>} */ (status).Web
  if (web === null || typeof web !== 'object') return []
  const rows = []
  for (const [hostPort, entry] of Object.entries(web)) {
    if (entry === null || typeof entry !== 'object') continue
    const handlers = /** @type {Record<string, unknown>} */ (entry).Handlers
    if (handlers === null || typeof handlers !== 'object') continue
    for (const [path, handler] of Object.entries(handlers)) {
      if (handler === null || typeof handler !== 'object') continue
      const proxy = /** @type {Record<string, unknown>} */ (handler).Proxy
      if (typeof proxy === 'string' && proxy !== '') rows.push({ hostPort, path, proxy })
    }
  }
  return rows
}

/**
 * Whether one Serve proxy target points at a loopback port.
 * @param {string} proxy - proxy target text such as `http://127.0.0.1:3080`.
 * @param {number} port - expected backend port.
 * @returns {boolean} true when the target is loopback and uses the port.
 */
export function proxyTargetsLoopbackPort(proxy, port) {
  try {
    const url = new URL(proxy)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    return loopback && url.port === String(port)
  } catch {
    return false
  }
}

/**
 * Whether one Serve proxy target is a loopback proxy at all (any port).
 * A loopback target on another port is a stale route left by a previous DSH
 * run, which this plugin may adopt.
 * @param {string} proxy - proxy target text.
 * @returns {boolean} true for a loopback HTTP target.
 */
export function isLoopbackProxy(proxy) {
  try {
    const url = new URL(proxy)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

/**
 * The Serve mappings that answer one hostname + port, in table order.
 * @param {{ hostPort: string, path: string, proxy: string }[]} rows - parsed handlers.
 * @param {{ hostname?: string, servePort?: number }} target - expected authority.
 * @returns {{ hostPort: string, path: string, proxy: string }[]} matching rows.
 */
export function serveMappingsFor(rows, { hostname, servePort = 80 }) {
  if (typeof hostname !== 'string' || hostname === '') return []
  const hostPort = `${hostname}:${String(servePort)}`
  return rows.filter((row) => row.hostPort === hostPort)
}

/**
 * Classify the current Serve state for one port.
 *
 * `absent` — nothing owns the port, safe to create.
 * `exact` — already proxies at this DSH port; adopt it and remove it on exit.
 * `stale` — a loopback route left by an earlier DSH run; adopt and replace.
 * `conflict` — another service owns it; never overwrite.
 * @param {unknown} status - parsed `serve status --json`.
 * @param {{ servePort: number, target: string, hostname?: string }} options - expected state.
 * @returns {{ kind: 'absent' | 'exact' | 'stale' | 'conflict', authority?: string, proxy?: string, reason?: string }} classification.
 */
export function classifyServe(status, { servePort, target, hostname }) {
  if (status === null || typeof status !== 'object') {
    return { kind: 'conflict', reason: 'tailscale serve status is not readable' }
  }
  const rows = parseServeStatus(status)
  const tcp = /** @type {Record<string, unknown>} */ (status).TCP
  const tcpClaimed = tcp !== null && typeof tcp === 'object'
    && Object.prototype.hasOwnProperty.call(tcp, String(servePort))
  const matching = rows.filter((row) => row.hostPort.endsWith(`:${String(servePort)}`))
  if (matching.length === 0) {
    // A TCP forwarder on the port is a conflict; a bare TCP entry beside Web
    // handlers is just Serve's own listener bookkeeping and is not.
    if (tcpClaimed) {
      return { kind: 'conflict', reason: `TCP port ${String(servePort)} is already forwarded by Serve` }
    }
    return { kind: 'absent' }
  }
  const sameHost = hostname === undefined
    ? matching
    : matching.filter((row) => row.hostPort === `${hostname}:${String(servePort)}`)
  if (sameHost.length === 0) {
    return {
      kind: 'conflict',
      reason: `port ${String(servePort)} is already served for ${matching.map((row) => row.hostPort).join(', ')}`,
    }
  }
  const authority = sameHost[0].hostPort
  const paths = sameHost.map((row) => row.path).sort()
  if (paths.length !== 1 || paths[0] !== '/') {
    return { kind: 'conflict', authority, reason: `${authority} already has handlers at ${paths.join(', ')}` }
  }
  const proxy = sameHost[0].proxy
  const normalized = proxy.replace(/\/+$/, '')
  if (normalized === target.replace(/\/+$/, '')) return { kind: 'exact', authority, proxy }
  if (isLoopbackProxy(normalized)) return { kind: 'stale', authority, proxy }
  return { kind: 'conflict', authority, proxy, reason: `${authority}/ already proxies to ${proxy}` }
}

/**
 * Read and classify Serve state for one port.
 * @param {{ servePort: number, target: string, hostname?: string, binary?: string, run?: typeof runTailscale }} options - options.
 * @returns {{ status: unknown, classification: ReturnType<typeof classifyServe> }} state.
 */
export function readServeState(options) {
  const run = options.run ?? runTailscale
  const result = run(['serve', 'status', '--json'], 5000, options.binary)
  const status = result.ok ? safeParse(result.stdout) : undefined
  return {
    status,
    classification: classifyServe(status, options),
  }
}

/** Parse JSON without throwing. */
function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Configure Serve for one backend and verify the resulting mapping.
 * @param {object} options - configure options.
 * @param {number} options.port - backend port.
 * @param {number} [options.servePort] - tailnet-side port.
 * @param {string} [options.servePath] - path prefix.
 * @param {string} [options.hostname] - MagicDNS name for verification.
 * @param {boolean} [options.secure] - HTTPS tailnet side.
 * @param {boolean} [options.overwrite] - replace a conflicting route (explicit operator choice).
 * @param {string} [options.binary] - tailscale executable.
 * @param {typeof runTailscale} [options.run] - CLI runner seam.
 * @returns {{ ok: boolean, detail?: string, args?: string[], claimed?: boolean, existing?: boolean, mapping?: string }} outcome.
 */
export function configureServe(options) {
  const run = options.run ?? runTailscale
  const servePort = options.servePort ?? 80
  const binary = options.binary
  const target = `http://127.0.0.1:${String(options.port)}`
  const before = readServeState({ ...options, servePort, target, binary, run })
  const classification = before.classification
  if (classification.kind === 'conflict' && options.overwrite !== true) {
    return { ok: false, detail: classification.reason, conflict: true }
  }
  if (classification.kind === 'exact') {
    return { ok: true, claimed: true, existing: true, mapping: classification.proxy }
  }
  const args = buildServeArgs({ ...options, servePort })
  const result = run(args, 15000, binary)
  if (!result.ok) {
    const detail = result.detail ?? (result.stderr || result.stdout || '').trim().split('\n')[0] ?? ''
    return { ok: false, detail: detail === '' ? 'tailscale serve failed' : detail, args }
  }
  const expectedPath = normalizeServePath(options.servePath)
  const path = expectedPath === '' ? '/' : expectedPath
  const after = readServeState({ ...options, servePort, target, binary, run })
  // Compare against the authority this port owns — not the first row whose path
  // matches. Port 80 and 8099 can both have a `/` handler, and the earlier one
  // is not ours.
  const hostPort = typeof options.hostname === 'string' && options.hostname !== ''
    ? `${options.hostname}:${String(servePort)}`
    : undefined
  const mapping = parseServeStatus(after.status).find((row) => row.path === path
    && (hostPort === undefined ? row.hostPort.endsWith(`:${String(servePort)}`) : row.hostPort === hostPort))
  if (mapping === undefined) {
    // The write landed, so this plugin owns the route even though it could not
    // verify the mapping; claim it so teardown removes it.
    return { ok: false, claimed: true, detail: `serve status has no ${path} handler after configuration`, args }
  }
  if (!proxyTargetsLoopbackPort(mapping.proxy, options.port)) {
    return {
      ok: false,
      claimed: true,
      detail: `serve ${path} points at ${mapping.proxy}, not ${target}`,
      args,
      mapping: mapping.proxy,
    }
  }
  return { ok: true, args, claimed: true, mapping: mapping.proxy }
}

/**
 * Remove the Serve route this plugin claimed on one port.
 *
 * `tailscale serve --http=<port> off` is the single-handler undo; unlike
 * `tailscale serve reset` it leaves every other service alone. The returned
 * promise never rejects: teardown runs inside the Host's shutdown budget and a
 * rejected disposer would turn a clean exit into an AggregateError.
 * @param {{ servePort: number, secure?: boolean, binary?: string, run?: typeof runTailscale }} options - removal options.
 * @returns {{ ok: boolean, detail?: string }} outcome.
 */
export function removeServe(options) {
  const run = options.run ?? runTailscale
  const args = buildServeOffArgs({ servePort: options.servePort, secure: options.secure })
  const result = run(args, 4000, options.binary)
  if (result.ok) return { ok: true }
  const detail = result.detail ?? (result.stderr || result.stdout || '').trim().split('\n')[0] ?? ''
  return { ok: false, detail: detail === '' ? 'tailscale serve off failed' : detail }
}
