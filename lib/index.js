/**
 * dsh-tailscale-connect — expose the DeepSeek Harness Web GUI and its remote
 * control surface to devices on a Tailscale tailnet.
 *
 * Two modes:
 * - `proxy` (default): bind one Tailscale IPv4 and reverse-proxy HTTP plus
 *   WebSocket upgrades to the loopback DSH web server. Tailnet-only, no
 *   external command, no LAN exposure, no TLS certificate required.
 * - `serve`: keep the loopback bind and let `tailscale serve` publish it. Use
 *   this when the operator wants the MagicDNS name without a port suffix, an
 *   HTTPS/WSS URL for a phone app with strict transport security, or already
 *   runs Serve for this host.
 *
 * The old `direct` name is accepted but aliases `proxy`: `dsh-host-webserver`
 * 0.2.x rejects the 0.0.0.0 bind that mode used.
 *
 * In every mode the plugin also publishes the tailnet origin as
 * `DSH_REMOTE_PUBLIC_BASE_URL`, which is where `@linxin666/dsh-remote-bridge`
 * looks for the address a phone should dial when it has no relay lease of its
 * own. Without it the pairing panel reports no public address and the QR
 * carries a bare token.
 *
 * The service is provided synchronously because the bundle patch reads
 * `bindHost` while the `webserver` row is configured. The asynchronous half
 * runs inside `ctx.inject`, so it starts only once the web server has bound.
 *
 * @module dsh-tailscale-connect
 */

import { discover, isTailnetAddress } from './discovery.js'
import { resolveAccessCode } from './access-code.js'
import { publishPairOrigin, PAIR_ORIGIN_ENV } from './pairing.js'
import { buildAccessPlan, bindHostFor, isLoopbackBind } from './plan.js'
import { probeUrl } from './probe.js'
import { createTailnetProxy } from './proxy.js'
import { resolveTailscaleBinary } from './tailscale.js'
import { configureServe, removeServe } from './serve.js'
import {
  DEFAULT_SHORTLINK_PATH,
  allowedOriginsFor,
  normalizeShortlinkPath,
  registerShortlink,
} from './shortlink.js'
import { httpUrl, normalizeServePath, preferredHost, trustedAuthorities } from './urls.js'

/** Stable Cordis plugin name (matches the row id in cordis.patch.yml). */
export const name = 'tailscale-access'

/** Services required before this plugin applies (none — it only provides). */
export const inject = []

/** Retry cadence while Tailscale is unavailable or the proxy cannot bind. */
const RETRY_MS = 15_000

/** Re-check cadence while the proxy is active (Tailscale can restart). */
const WATCH_MS = 60_000

/** How long to wait for `webServer.port` after the service appears. */
const PORT_TIMEOUT_MS = 8_000

/** Every console line this plugin prints starts with this prefix. */
const LOG_PREFIX = 'dsh tailscale:'

/**
 * Log one operator-facing line.
 * @param {'log' | 'warn'} level - console method.
 * @param {string} message - message body.
 */
function say(level, message) {
  // Deliberately console, not ctx.logger: these are startup lines the operator
  // reads next to `dsh web:`, and a new row's logger prefix would bury them.
  const line = `${LOG_PREFIX} ${message}`
  if (level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * Normalize one row config.
 * @param {unknown} raw - config from the loader.
 * @returns {{
 *   mode: 'proxy' | 'serve',
 *   legacyDirect: boolean,
 *   port: number,
 *   bindAddress: string,
 *   hostName: string,
 *   tailnet: string,
 *   extraTrustedHosts: string[],
 *   servePort: number,
 *   servePath: string,
 *   serveSecure: boolean,
 *   overwriteServe: boolean,
 *   publishPairOrigin: boolean,
 *   printUrl: boolean,
 *   verify: boolean,
 *   watch: boolean,
 *   binaryPath: string,
 *   shortlink: boolean,
 *   shortlinkPath: string,
 *   accessCode: string,
 *   accessCodeFile: string,
 *   accessCodeLength: number,
 *   rotateAccessCode: boolean,
 *   shortlinkLanding: boolean,
 *   cookieMaxAgeDays: number,
 * }} normalized config.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  // `direct` named the old 0.0.0.0 bind. dsh-host-webserver 0.2.x rejects a
  // wildcard address at load, so the name now aliases the tailnet proxy and the
  // operator gets one warning instead of a boot failure.
  const legacyDirect = source.mode === 'direct'
  const mode = source.mode === 'serve' ? 'serve' : 'proxy'
  const port = Number.isInteger(source.port) && source.port >= 0 && source.port <= 65535 ? source.port : 0
  const servePort = Number.isInteger(source.servePort) && source.servePort > 0 && source.servePort <= 65535
    ? source.servePort
    : 80
  return {
    mode,
    legacyDirect,
    port,
    bindAddress: typeof source.bindAddress === 'string' ? source.bindAddress.trim() : '',
    hostName: typeof source.hostName === 'string' ? source.hostName.trim() : '',
    tailnet: typeof source.tailnet === 'string' ? source.tailnet.trim() : '',
    extraTrustedHosts: Array.isArray(source.extraTrustedHosts)
      ? source.extraTrustedHosts.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
      : [],
    servePort,
    servePath: normalizeServePath(source.servePath),
    serveSecure: source.serveSecure === true,
    overwriteServe: source.overwriteServe === true,
    publishPairOrigin: source.publishPairOrigin !== false,
    printUrl: source.printUrl !== false,
    verify: source.verify !== false,
    watch: source.watch !== false,
    binaryPath: typeof source.binaryPath === 'string' ? source.binaryPath.trim() : '',
    shortlink: source.shortlink !== false,
    shortlinkPath: normalizeShortlinkPath(source.shortlinkPath ?? DEFAULT_SHORTLINK_PATH),
    accessCode: typeof source.accessCode === 'string' ? source.accessCode.trim() : '',
    accessCodeFile: typeof source.accessCodeFile === 'string' ? source.accessCodeFile.trim() : '',
    accessCodeLength: Number.isInteger(source.accessCodeLength) && source.accessCodeLength >= 6 && source.accessCodeLength <= 64
      ? source.accessCodeLength
      : 10,
    rotateAccessCode: source.rotateAccessCode === true,
    shortlinkLanding: source.shortlinkLanding !== false,
    cookieMaxAgeDays: Number.isInteger(source.cookieMaxAgeDays) && source.cookieMaxAgeDays > 0 && source.cookieMaxAgeDays <= 3650
      ? source.cookieMaxAgeDays
      : 0,
  }
}

/**
 * Wait until the web server reports its listening port.
 *
 * `WebServer` provides its service in the constructor, but `port` is assigned
 * after the asynchronous `listen`; a plugin that activates in the same tick
 * would otherwise read `undefined`.
 * @param {{ port?: number } | undefined} server - web server service.
 * @param {number} [timeoutMs] - maximum wait.
 * @returns {Promise<number | undefined>} the port, or undefined on timeout.
 */
export async function waitForPort(server, timeoutMs = PORT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const port = server?.port
    if (Number.isInteger(port) && port > 0) return port
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
}

/**
 * The `host[:port]` authorities a set of public URLs will carry.
 * @param {string[]} urls - public URLs.
 * @returns {string[]} canonical authorities, no duplicates.
 */
export function authoritiesFromUrls(urls) {
  const values = []
  for (const url of urls) {
    try {
      values.push(new URL(url).host)
    } catch {
      // not a URL — ignore
    }
  }
  return [...new Set(values.filter((entry) => entry !== ''))]
}

/**
 * Add the remote-facing authorities to `connection.trustedHosts` at runtime.
 *
 * The `/api` fence reads this array on every request
 * (`@deepseek-ai/dsh-client-connection`), so a push here takes effect without
 * patching the `connection` row — which keeps this bundle independent of that
 * row's config schema. A missing service is not fatal: only the browser RPC
 * will be refused, and the phone protocol does not use `/api`.
 * @param {import('@deepseek-ai/cordis').Context} scope - injected scope.
 * @param {string[]} urls - public URLs reachable from the tailnet.
 * @param {{ pushed: string[] }} undo - rollback list.
 * @returns {boolean} true when at least one authority was accepted.
 */
function addRuntimeTrustedHosts(scope, urls, undo) {
  const connection = scope.get('connection', false)
  const trusted = connection?.trustedHosts
  if (!Array.isArray(trusted)) return false
  let added = false
  for (const authority of authoritiesFromUrls(urls)) {
    if (trusted.includes(authority)) continue
    trusted.push(authority)
    undo.pushed.push(authority)
    added = true
  }
  return added
}

/**
 * Remove the authorities this activation pushed.
 * @param {import('@deepseek-ai/cordis').Context} scope - injected scope.
 * @param {{ pushed: string[] }} undo - rollback list.
 */
function removeRuntimeTrustedHosts(scope, undo) {
  if (undo.pushed.length === 0) return
  const trusted = scope.get('connection', false)?.trustedHosts
  if (!Array.isArray(trusted)) return
  for (const authority of undo.pushed) {
    const at = trusted.indexOf(authority)
    if (at !== -1) trusted.splice(at, 1)
  }
  undo.pushed = []
}

/**
 * Mount the tailscale-access service and start the selected exposure mode.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - row config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const binary = resolveTailscaleBinary(config.binaryPath)
  let facts = discover(config, { binary })
  const trustedHosts = trustedAuthorities(facts, config.extraTrustedHosts)
  const access = config.shortlink
    ? resolveAccessCode({
      explicit: config.accessCode,
      file: config.accessCodeFile,
      length: config.accessCodeLength,
      rotate: config.rotateAccessCode,
      dshHome: process.env.DSH_HOME,
    })
    : { source: 'disabled', file: '' }
  const shortlinkEnabled = config.shortlink && typeof access.code === 'string'
  if (config.shortlink && access.error !== undefined) {
    say('warn', `short link disabled: ${access.error}`)
  }

  /** @type {Record<string, unknown>} */
  const service = {
    mode: config.mode,
    bindHost: bindHostFor(config.mode),
    hostname: facts.hostname,
    ipv4: facts.ipv4,
    ipv6: facts.ipv6,
    servePort: config.servePort,
    servePath: config.servePath,
    trustedHosts,
    urls: [],
    pairOrigin: undefined,
    proxy: undefined,
    serve: undefined,
    status: 'pending',
    detail: undefined,
    shortlink: {
      enabled: shortlinkEnabled,
      path: config.shortlinkPath,
      file: access.file,
      landing: config.shortlinkLanding,
    },
  }
  ctx.provide('tailscaleAccess', service)

  /** @type {{ pushed: string[], proxy?: ReturnType<typeof createTailnetProxy>, key?: string, serveClaimed: boolean, publishedEnv?: string, retry?: NodeJS.Timeout, watch?: NodeJS.Timeout, disposed: boolean, scope?: import('@deepseek-ai/cordis').Context, shortlink: { dispose?: () => void, key?: string, printedLink?: string }, cookieMaxAge?: number }} */
  const undo = {
    pushed: [],
    serveClaimed: false,
    disposed: false,
    shortlink: {},
  }

  say('log', `mode=${config.mode} host=${facts.hostname ?? '(unknown)'} ipv4=${facts.ipv4.join(',') || '(none)'}`)
  if (config.legacyDirect) {
    say('warn', 'mode: direct is no longer supported: dsh-host-webserver rejects the 0.0.0.0 bind it used. ' +
      'Falling back to mode: proxy (tailnet-only). Use mode: serve for the MagicDNS name without a port.')
  }

  /** Stop the proxy listener, if any. */
  const stopProxy = async () => {
    const proxy = undo.proxy
    undo.proxy = undefined
    undo.key = undefined
    if (proxy !== undefined) {
      try {
        await proxy.stop()
      } catch {
        // already closed
      }
    }
  }

  /**
   * Register (or re-register) the fixed short-link route for one plan.
   * @param {import('@deepseek-ai/cordis').Context} scope - injected scope.
   * @param {{ urls: string[], pairOrigin?: string }} plan - access plan.
   * @param {{ port: number, host?: string, protocol?: string }} server - bound web server.
   */
  const ensureShortlink = (scope, plan, server) => {
    if (!shortlinkEnabled) return
    const baseUrl = plan.pairOrigin ?? plan.urls[0]
      ?? (Number.isInteger(server.port)
        ? `${String(server.protocol ?? 'http:').replace(/:$/, '')}://127.0.0.1:${String(server.port)}`
        : undefined)
    if (baseUrl === undefined) {
      say('warn', 'short link is enabled but no public URL is known yet')
      return
    }
    let publicPath = ''
    try {
      publicPath = new URL(baseUrl).pathname.replace(/\/+$/, '')
    } catch {
      publicPath = ''
    }
    const allowedOrigins = allowedOriginsFor(plan.urls, server)
    const localHost = typeof server.host === 'string' && server.host !== '' && server.host !== '0.0.0.0'
      ? (server.host.includes(':') ? `[${server.host}]` : server.host)
      : '127.0.0.1'
    const localOrigin = Number.isInteger(server.port)
      ? `${String(server.protocol ?? 'http:').replace(/:$/, '')}://${localHost}:${String(server.port)}`
      : undefined
    const key = `${baseUrl}|${publicPath}|${String(config.shortlinkLanding)}|${localOrigin ?? ''}|${[...allowedOrigins].sort().join(',')}`
    if (undo.shortlink.dispose !== undefined && undo.shortlink.key === key) return
    if (undo.shortlink.dispose !== undefined) undo.shortlink.dispose()
    const route = registerShortlink({
      webServer: scope.get('webServer'),
      path: config.shortlinkPath,
      handlerOptions: {
        code: /** @type {string} */ (access.code),
        connection: scope.get('connection', false),
        baseUrl,
        allowedOrigins,
        publicPath,
        protocol: /** @type {'http:' | 'https:'} */ (server.protocol ?? 'http:'),
        landing: config.shortlinkLanding,
        landingBaseUrl: baseUrl,
        ...(localOrigin === undefined ? {} : { localOrigin }),
        log: (message) => say('warn', message),
      },
    })
    undo.shortlink.dispose = route
    undo.shortlink.key = key
  }

  /** Clear both timers. */
  const clearTimers = () => {
    if (undo.retry !== undefined) clearTimeout(undo.retry)
    if (undo.watch !== undefined) clearInterval(undo.watch)
    undo.retry = undefined
    undo.watch = undefined
  }

  /**
   * Publish the tailnet origin and print the operator-facing links.
   * @param {{ urls: string[], pairOrigin?: string }} plan - access plan.
   * @param {unknown} scope - injected scope.
   */
  const finish = (plan, scope) => {
    service.urls = plan.urls
    if (config.publishPairOrigin && plan.pairOrigin !== undefined) {
      const published = publishPairOrigin(plan.pairOrigin, process.env, (line) => {
        say('log', `pairing origin published: ${line}`)
      })
      if (published.published) {
        service.pairOrigin = published.value
        undo.publishedEnv = published.value
      } else if (published.reason === 'already-set') {
        service.pairOrigin = published.existing
        say('log', `pairing origin left as ${published.existing} (already set in the environment)`)
      } else {
        say('warn', 'could not publish the pairing origin (invalid URL)')
      }
    }
    if (!config.printUrl) return
    const primary = plan.urls[0]
    for (const url of plan.urls) {
      if (url === primary) {
        const connection = /** @type {{ authenticatedUrl?: (url: string) => string } | undefined} */ (
          typeof scope?.get === 'function' ? scope.get('connection', false) : undefined
        )
        let open = url
        try {
          if (typeof connection?.authenticatedUrl === 'function') open = connection.authenticatedUrl(url)
        } catch {
          // fall back to the bare URL
        }
        say('log', `open ${open}`)
      } else {
        say('log', `open ${url}`)
      }
    }
    if (plan.urls.length === 0) say('warn', 'no tailnet URL is available for this mode yet')
    if (shortlinkEnabled) {
      const base = plan.pairOrigin ?? plan.urls[0]
      if (base !== undefined) {
        const link = `${base.replace(/\/+$/, '')}${config.shortlinkPath}/${String(access.code)}`
        if (undo.shortlink.printedLink !== link) {
          say('log', `fixed link ${link}`)
          undo.shortlink.printedLink = link
        }
      }
    } else if (config.shortlink) {
      say('warn', 'short link is disabled; configure a valid accessCode or clear accessCodeFile')
    }
  }

  /**
   * Start (or validate) the selected mode once the web server is bound.
   * @param {import('@deepseek-ai/cordis').Context} scope - injected scope.
   */
  const start = async (scope) => {
    if (undo.disposed) return
    undo.scope = scope
    try {
      if (config.mode === 'proxy') {
        const fresh = discover(config, { binary })
        if (fresh.ipv4[0] !== facts.ipv4[0] && fresh.ipv4[0] !== undefined) {
          say('log', `tailnet address is ${fresh.ipv4[0]}`)
        }
        facts = fresh
        service.ipv4 = fresh.ipv4
        service.ipv6 = fresh.ipv6
        service.hostname = fresh.hostname
      }
      const server = scope.get('webServer')
      const port = await waitForPort(server)
      if (port === undefined) {
        service.status = 'error'
        service.detail = 'the web server never reported a port'
        say('warn', 'the web server never reported a port; tailnet access is not active')
        return
      }
      const plan = buildAccessPlan({ config, facts, server: { port, host: server.host, protocol: server.protocol } })
      service.urls = plan.urls
      ensureShortlink(scope, plan, { port, host: server.host, protocol: server.protocol })
      if (config.cookieMaxAgeDays > 0) {
        const auth = scope.get('connection', false)?.browserAuth
        const maxAge = config.cookieMaxAgeDays * 86_400_000
        if (auth !== undefined && Number.isSafeInteger(maxAge) && Number.isSafeInteger(Date.now() + maxAge)) {
          if (undo.cookieMaxAge === undefined) undo.cookieMaxAge = auth.maxAgeMilliseconds
          auth.maxAgeMilliseconds = maxAge
        }
      }
      const trustedAdded = addRuntimeTrustedHosts(scope, plan.urls, undo)
      if (trustedAdded) {
        service.trustedHosts = [...new Set([...trustedHosts, ...authoritiesFromUrls(plan.urls)])]
      } else if (scope.get('connection', false) === undefined) {
        say('warn', 'connection service is not available; tailnet browser RPC may be refused with 403')
      }

      if (config.mode === 'serve') {
        await startServe(scope, port, plan)
        return
      }
      await startProxy(scope, port, plan)
    } catch (error) {
      service.status = 'error'
      service.detail = error instanceof Error ? error.message : String(error)
      say('warn', `access setup failed: ${service.detail}`)
    }
  }

  /**
   * `serve` mode: configure the Serve route, verify it, then publish links.
   * @param {import('@deepseek-ai/cordis').Context} scope - injected scope.
   * @param {number} port - DSH web server port.
   * @param {ReturnType<typeof buildAccessPlan>} plan - access plan.
   */
  const startServe = async (scope, port, plan) => {
    const outcome = configureServe({
      port,
      servePort: config.servePort,
      servePath: config.servePath,
      hostname: facts.hostname,
      secure: config.serveSecure,
      overwrite: config.overwriteServe,
      binary,
    })
    service.serve = outcome
    if (!outcome.ok) {
      service.status = 'error'
      service.detail = outcome.detail
      say('warn', `tailscale serve is not active: ${outcome.detail ?? 'unknown error'}`)
      if (outcome.conflict === true) {
        say('warn', `another Serve handler owns port ${String(config.servePort)}; refusing to replace it. ` +
          'Use mode: proxy, choose another servePort, or set overwriteServe: true to replace it explicitly.')
      }
      say('log', `manual command: tailscale serve ${config.serveSecure ? '--https' : '--http'}=${String(config.servePort)} --bg ${String(port)}`)
      return
    }
    if (outcome.claimed === true) undo.serveClaimed = true
    service.status = 'active'
    const url = plan.urls[0]
    if (url !== undefined && config.verify) {
      const result = await probeUrl(url)
      if (!result.ok) say('warn', `self-check of ${url} failed: ${result.detail ?? 'unreachable'}`)
    }
    finish(plan, scope)
  }

  /**
   * `proxy` mode: bind the tailnet address and forward to loopback.
   * @param {import('@deepseek-ai/cordis').Context} scope - injected scope.
   * @param {number} port - DSH web server port.
   * @param {ReturnType<typeof buildAccessPlan>} plan - access plan.
   */
  const startProxy = async (scope, port, plan) => {
    if (plan.listen === undefined) {
      service.status = 'inactive'
      service.detail = 'no Tailscale IPv4 address is present'
      say('warn', 'no Tailscale IPv4 address found (is Tailscale running?); retrying in 15s')
      scheduleRetry(scope)
      return
    }
    if (!isLoopbackBind(scope.get('webServer')?.host)) {
      service.status = 'error'
      service.detail = 'the DSH web server is not bound to loopback'
      say('warn', `mode: proxy needs the DSH web server on loopback, but it is bound to ${String(scope.get('webServer')?.host)}; ` +
        'use mode: serve for that bind, or run without --host')
      return
    }
    const key = `${plan.listen.host}:${String(plan.listen.port)}->${String(port)}`
    if (undo.proxy !== undefined && undo.key === key) {
      service.status = 'active'
      finish(plan, scope)
      return
    }
    await stopProxy()
    const proxy = createTailnetProxy({
      listenHost: plan.listen.host,
      listenPort: plan.listen.port,
      upstreamPort: port,
      upstreamProtocol: scope.get('webServer')?.protocol ?? 'http:',
      allowSource: isTailnetAddress,
      log: (message) => say('warn', message),
    })
    try {
      const bound = await proxy.start()
      undo.proxy = proxy
      undo.key = key
      service.proxy = bound
      service.status = 'active'
      service.detail = undefined
      say('log', `tailnet listener on ${bound.host}:${String(bound.port)} -> http://127.0.0.1:${String(port)}`)
    } catch (error) {
      service.status = 'error'
      service.detail = error instanceof Error ? error.message : String(error)
      say('warn', `could not bind ${plan.listen.host}:${String(plan.listen.port)}: ${service.detail}`)
      try {
        await proxy.stop()
      } catch {
        // already closed
      }
      scheduleRetry(scope)
      return
    }
    const url = plan.urls[0]
    if (url !== undefined && config.verify) {
      const result = await probeUrl(url)
      if (!result.ok) say('warn', `self-check of ${url} failed: ${result.detail ?? 'unreachable'}`)
    }
    finish(plan, scope)
    armWatch(scope)
  }

  /**
   * Retry setup later; only proxy mode has a transient condition worth retrying.
   * @param {import('@deepseek-ai/cordis').Context} scope - injected scope.
   */
  function scheduleRetry(scope) {
    if (undo.disposed || config.mode !== 'proxy' || undo.retry !== undefined) return
    undo.retry = setTimeout(() => {
      undo.retry = undefined
      void start(scope)
    }, RETRY_MS)
    undo.retry.unref?.()
  }

  /**
   * Re-discover the tailnet address periodically so a Tailscale restart or an
   * address change does not leave a listener on a dead interface.
   * @param {import('@deepseek-ai/cordis').Context} scope - injected scope.
   */
  function armWatch(scope) {
    if (undo.disposed || !config.watch || undo.watch !== undefined) return
    undo.watch = setInterval(() => {
      if (undo.disposed) return
      const fresh = discover(config, { binary })
      const next = fresh.ipv4[0]
      const current = undo.key?.split(':')[0]
      if (next === undefined || next === current) return
      say('log', `tailnet address changed (${current ?? 'none'} -> ${next}); rebinding`)
      void start(scope)
    }, WATCH_MS)
    undo.watch.unref?.()
  }

  /** Roll everything back. Idempotent; never rejects. */
  const teardown = async () => {
    if (undo.disposed) return
    undo.disposed = true
    clearTimers()
    try {
      if (undo.scope !== undefined) removeRuntimeTrustedHosts(undo.scope, undo)
    } catch {
      // scope already torn down
    }
    try {
      if (undo.cookieMaxAge !== undefined && undo.scope !== undefined) {
        const auth = undo.scope.get('connection', false)?.browserAuth
        if (auth !== undefined) auth.maxAgeMilliseconds = undo.cookieMaxAge
        undo.cookieMaxAge = undefined
      }
    } catch {
      // connection already torn down
    }
    try {
      if (undo.shortlink.dispose !== undefined) {
        undo.shortlink.dispose()
        undo.shortlink.dispose = undefined
      }
    } catch {
      // the route is already gone with its fiber
    }
    try {
      if (undo.serveClaimed) {
        undo.serveClaimed = false
        const removed = removeServe({ servePort: config.servePort, secure: config.serveSecure, binary })
        if (removed.ok) say('log', `removed the Serve route on ${String(config.servePort)}`)
        else say('warn', `could not remove the Serve route: ${removed.detail ?? 'unknown error'}`)
      }
    } catch {
      // teardown must never reject
    }
    try {
      await stopProxy()
    } catch {
      // already closed
    }
    try {
      if (undo.publishedEnv !== undefined && process.env[PAIR_ORIGIN_ENV] === undo.publishedEnv) {
        delete process.env[PAIR_ORIGIN_ENV]
        undo.publishedEnv = undefined
      }
    } catch {
      // environment not writable — nothing to undo
    }
  }

  ctx.effect(() => () => teardown())

  // `webServer` and `connection` have no activation order relative to this row;
  // the callback runs once both are available.
  ctx.inject(['webServer', 'connection'], (scope) => {
    if (undo.disposed) return
    const server = scope.get('webServer')
    // Small status endpoint for the operator and for verification scripts.
    scope.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-tailscale/status',
      handler: (_req, res) => {
        const body = JSON.stringify({
          mode: service.mode,
          status: service.status,
          hostname: service.hostname,
          ipv4: service.ipv4,
          urls: service.urls,
          pairOrigin: service.pairOrigin,
          proxy: service.proxy,
          serve: service.serve,
          shortlink: service.shortlink,
          detail: service.detail,
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    }))
    void start(scope)
  })
}

/**
 * The current tailnet URL list, for tests and for a future status card.
 * @param {Record<string, unknown>} service - the provided service.
 * @returns {string[]} public URLs.
 */
export function urlsOf(service) {
  return Array.isArray(service.urls) ? service.urls.filter((entry) => typeof entry === 'string') : []
}

/**
 * One URL for the tailnet, preferring MagicDNS over a raw IP.
 * @param {{ hostname?: string, ipv4?: string[] }} facts - discovery result.
 * @param {number} port - public port.
 * @returns {string | undefined} URL.
 */
export function primaryUrl(facts, port) {
  return httpUrl(preferredHost(facts) ?? '', port)
}
