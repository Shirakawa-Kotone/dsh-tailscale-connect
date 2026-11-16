/**
 * One-shot reachability probe used after a listener is configured.
 *
 * A tailnet URL can be configured perfectly and still be useless — the
 * interface disappeared, Serve refused the route, another process holds the
 * port — so the plugin checks the URL it is about to print. Any HTTP status
 * proves the transport and the DSH route answered; only a connection error or
 * a 5xx gateway answer is reported. The body is never read.
 *
 * @module dsh-tailscale-connect/probe
 */

import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'

/**
 * Probe one absolute HTTP(S) URL.
 * @param {string} url - URL to request.
 * @param {number} [timeoutMs] - total budget.
 * @returns {Promise<{ ok: boolean, status?: number, detail?: string }>} outcome.
 */
export function probeUrl(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      resolve({ ok: false, detail: `invalid URL: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve({ ok: false, detail: `unsupported scheme ${target.protocol}` })
      return
    }
    const getter = target.protocol === 'https:' ? httpsGet : httpGet
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const request = getter(target, {
      // `tailscale serve` presents a publicly trusted certificate; a local
      // reverse proxy may present a self-signed one. The probe is a local
      // liveness check, never a trust decision.
      ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      headers: { 'user-agent': 'dsh-tailscale-connect/probe' },
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 0
      response.destroy()
      settle(status >= 500 ? { ok: false, status, detail: `HTTP ${String(status)}` } : { ok: true, status })
    })
    request.on('timeout', () => {
      request.destroy()
      settle({ ok: false, detail: `timed out after ${String(timeoutMs)}ms` })
    })
    request.on('error', (error) => {
      settle({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    })
    request.end()
  })
}
