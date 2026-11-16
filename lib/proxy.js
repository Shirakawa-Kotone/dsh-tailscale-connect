/**
 * A tailnet-only HTTP + WebSocket reverse proxy in front of the loopback DSH
 * web server.
 *
 * Why a proxy instead of binding the DSH server itself:
 * - `@deepseek-ai/dsh-host-webserver` accepts exactly one concrete bind address.
 *   Binding it to the Tailscale IP would take loopback away, so the desktop
 *   browser and the CLI's own startup URL would stop working.
 * - `tailscale serve` needs a free root-path handler and external state; this
 *   listener needs neither, and it never opens the LAN interface.
 *
 * The proxy keeps the client's original `Host` authority: the `/api` fence
 * classifies it through `trustedHosts`, and `Origin` still matches. It adds
 * `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` for logging and
 * for other plugins, exactly like `tailscale serve` does.
 *
 * @module dsh-tailscale-connect/proxy
 */

import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'

/** Hop-by-hop headers never forwarded across either leg. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Strip one IPv4-mapped IPv6 prefix so tests and logs see the IPv4 form.
 * @param {string | undefined} address - socket remote address.
 * @returns {string} normalized text.
 */
export function normalizeRemoteAddress(address) {
  if (typeof address !== 'string') return ''
  return address.toLowerCase().startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

/**
 * The `X-Forwarded-For` value one hop should carry.
 * @param {string | string[] | undefined} existing - inbound header value.
 * @param {string | undefined} remoteAddress - socket address of this hop.
 * @returns {string} comma-joined chain.
 */
export function forwardedFor(existing, remoteAddress) {
  const chain = []
  const prior = Array.isArray(existing) ? existing.join(',') : existing
  if (typeof prior === 'string' && prior.trim() !== '') chain.push(prior.trim())
  const remote = normalizeRemoteAddress(remoteAddress)
  if (remote !== '') chain.push(remote)
  return chain.join(', ')
}

/**
 * Build the headers for the loopback HTTP leg.
 * @param {import('node:http').IncomingMessage} request - inbound request.
 * @returns {Record<string, string | string[]>} forwarded headers.
 */
export function forwardedHeaders(request) {
  /** @type {Record<string, string | string[]>} */
  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'x-forwarded-for' || lower === 'x-forwarded-proto' || lower === 'x-forwarded-host') continue
    headers[lower] = value
  }
  headers['x-forwarded-for'] = forwardedFor(request.headers['x-forwarded-for'], request.socket.remoteAddress)
  headers['x-forwarded-proto'] = 'http'
  if (typeof request.headers.host === 'string') headers['x-forwarded-host'] = request.headers.host
  return headers
}

/**
 * Rebuild one WebSocket handshake for the loopback leg.
 *
 * The client's own headers travel verbatim so `Sec-WebSocket-*` and any
 * subprotocol survive; only the forwarder-owned ones are replaced. The
 * original `Host` is kept, which is what the DSH fence and the remote-bridge
 * pairing route each need to see.
 * @param {import('node:http').IncomingMessage} request - upgrade request.
 * @returns {string} request head ending in a blank line.
 */
export function forwardedHandshake(request) {
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`]
  const raw = request.rawHeaders
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? ''
    const lower = name.toLowerCase()
    if (lower === 'x-forwarded-for' || lower === 'x-forwarded-proto' || lower === 'x-forwarded-host') continue
    lines.push(`${name}: ${raw[index + 1] ?? ''}`)
  }
  lines.push(`X-Forwarded-For: ${forwardedFor(request.headers['x-forwarded-for'], request.socket.remoteAddress)}`)
  lines.push('X-Forwarded-Proto: http')
  if (typeof request.headers.host === 'string') lines.push(`X-Forwarded-Host: ${request.headers.host}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

/** The response sent to a caller this proxy refuses. */
const FORBIDDEN_BODY = 'tailnet only\n'

/**
 * Create one tailnet-facing proxy. Nothing listens until {@link TailnetProxy.start}.
 * @param {object} options - proxy options.
 * @param {string} options.listenHost - tailnet IP literal to bind.
 * @param {number} options.listenPort - port to bind; 0 asks the OS.
 * @param {string} [options.upstreamHost] - loopback upstream host.
 * @param {number} options.upstreamPort - DSH web server port.
 * @param {'http:' | 'https:' | 'http' | 'https'} [options.upstreamProtocol] - upstream protocol.
 * @param {(address: string) => boolean} [options.allowSource] - source guard; defaults to allow all.
 * @param {(message: string) => void} [options.log] - message sink.
 * @returns {TailnetProxy} proxy handle.
 */
export function createTailnetProxy(options) {
  const listenHost = options.listenHost
  const listenPort = options.listenPort
  const upstreamHost = options.upstreamHost ?? '127.0.0.1'
  const upstreamPort = options.upstreamPort
  const upstreamProtocol = options.upstreamProtocol ?? 'http:'
  const allowSource = options.allowSource ?? (() => true)
  const log = options.log ?? (() => {})
  const secureUpstream = String(upstreamProtocol).startsWith('https')
  const requestUpstream = secureUpstream ? httpsRequest : httpRequest

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  /** @type {Set<import('node:http').ClientRequest>} */
  const upstreamRequests = new Set()

  const allowed = (request) => allowSource(normalizeRemoteAddress(request.socket.remoteAddress))

  const deny = (response) => {
    response.writeHead(403, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(FORBIDDEN_BODY)),
      'cache-control': 'no-store',
    })
    response.end(FORBIDDEN_BODY)
  }

  /**
   * Forward one ordinary HTTP request.
   * @param {import('node:http').IncomingMessage} request - inbound request.
   * @param {import('node:http').ServerResponse} response - inbound response.
   */
  const forwardHttp = (request, response) => {
    if (!allowed(request)) {
      deny(response)
      return
    }
    const upstream = requestUpstream({
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request),
      ...(secureUpstream ? { rejectUnauthorized: false } : {}),
    })
    upstreamRequests.add(upstream)
    const release = () => { upstreamRequests.delete(upstream) }
    upstream.on('response', (upstreamResponse) => {
      /** @type {Record<string, string | string[]>} */
      const headers = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue
        if (HOP_BY_HOP.has(name.toLowerCase())) continue
        headers[name] = value
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers)
      upstreamResponse.pipe(response)
      upstreamResponse.on('close', release)
      upstreamResponse.on('error', () => { response.destroy() })
    })
    upstream.on('error', (error) => {
      release()
      log(`proxy upstream error: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      if (!response.writableEnded) response.end('bad gateway\n')
    })
    response.on('close', () => {
      release()
      if (!upstream.writableEnded) upstream.destroy()
    })
    request.on('error', () => upstream.destroy())
    request.pipe(upstream)
  }

  /**
   * Forward one WebSocket (or other HTTP upgrade) handshake and its socket.
   * @param {import('node:http').IncomingMessage} request - upgrade request.
   * @param {import('node:stream').Duplex} socket - client socket.
   * @param {Buffer} head - bytes already read past the handshake.
   */
  const forwardUpgrade = (request, socket, head) => {
    if (!allowSource(normalizeRemoteAddress(request.socket.remoteAddress))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const upstream = netConnect({ host: upstreamHost, port: upstreamPort })
    sockets.add(upstream)
    const teardown = () => {
      sockets.delete(upstream)
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', teardown)
    socket.on('error', teardown)
    upstream.on('close', () => { socket.destroy() })
    socket.on('close', () => { upstream.destroy() })
    upstream.on('connect', () => {
      upstream.write(forwardedHandshake(request))
      if (head !== undefined && head.byteLength > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  }

  const server = createServer(forwardHttp)
  server.on('upgrade', forwardUpgrade)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })

  /** @type {{ host: string, port: number } | undefined} */
  let address

  return {
    get address() {
      return address
    },
    /**
     * Bind the listener and report the effective address.
     * @returns {Promise<{ host: string, port: number }>} the address.
     */
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          const bound = server.address()
          if (bound === null || typeof bound === 'string') {
            reject(new Error('tailnet proxy bound no TCP address'))
            return
          }
          address = { host: listenHost, port: bound.port }
          resolve(address)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        try {
          server.listen({ host: listenHost, port: listenPort, exclusive: true })
        } catch (error) {
          server.off('error', onError)
          server.off('listening', onListening)
          reject(error)
        }
      })
    },
    /**
     * Stop the listener and destroy every socket it still holds.
     * @returns {Promise<void>} resolves once the listener is closed.
     */
    stop() {
      address = undefined
      for (const upstream of upstreamRequests) {
        try {
          upstream.destroy()
        } catch {
          // already gone
        }
      }
      upstreamRequests.clear()
      for (const socket of sockets) {
        try {
          socket.destroy()
        } catch {
          // already gone
        }
      }
      sockets.clear()
      return new Promise((resolve) => {
        server.close(() => { resolve() })
      })
    },
  }
}

/**
 * @typedef {object} TailnetProxy
 * @property {{ host: string, port: number } | undefined} address - effective listen address.
 * @property {() => Promise<{ host: string, port: number }>} start - bind the listener.
 * @property {() => Promise<void>} stop - close it.
 */
