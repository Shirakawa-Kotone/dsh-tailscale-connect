/**
 * Publish the tailnet origin a phone should dial for remote control.
 *
 * `@linxin666/dsh-remote-bridge` resolves the pairing origin in this order:
 * its own live relay lease / tunnel, then `DSH_REMOTE_PUBLIC_BASE_URL`, then the
 * LAN forwarder. A loopback-bound DSH host has no lease and no LAN forwarder, so
 * without this variable the pairing panel reports that it found no public
 * address and the QR carries a bare token — a phone that has never paired then
 * has nothing to dial. The variable is read again on every pairing-token
 * request, so setting it after boot is enough.
 *
 * Only the origin is published: the bridge keeps `new URL(value).origin`, so a
 * path prefix would be dropped and the phone would dial `/ios/v1` on an origin
 * that does not serve it. A non-root Serve install therefore must not publish.
 *
 * @module dsh-tailscale-connect/pairing
 */

/** The environment contract the remote bridge reads. */
export const PAIR_ORIGIN_ENV = 'DSH_REMOTE_PUBLIC_BASE_URL'

/**
 * The origin of one absolute URL, or undefined when the value is not a URL.
 * @param {unknown} value - candidate URL.
 * @returns {string | undefined} canonical origin without a trailing slash.
 */
export function originOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return new URL(value.trim()).origin
  } catch {
    return undefined
  }
}

/**
 * Publish one tailnet origin unless the environment already names one.
 *
 * An explicit value always wins: the operator may have a Cloudflare tunnel or a
 * custom public hostname configured, and this plugin must not overwrite a
 * deliberate deployment fact.
 * @param {string | undefined} url - tailnet URL whose origin should be published.
 * @param {NodeJS.ProcessEnv} [env] - environment to write; defaults to `process.env`.
 * @param {(message: string) => void} [log] - message sink.
 * @returns {{ published: boolean, value?: string, reason?: 'invalid' | 'already-set', existing?: string }} outcome.
 */
export function publishPairOrigin(url, env = process.env, log = () => {}) {
  const origin = originOf(url)
  if (origin === undefined) return { published: false, reason: 'invalid' }
  const existing = typeof env[PAIR_ORIGIN_ENV] === 'string' ? env[PAIR_ORIGIN_ENV].trim() : ''
  if (existing !== '') return { published: false, reason: 'already-set', existing }
  env[PAIR_ORIGIN_ENV] = origin
  log(`${PAIR_ORIGIN_ENV}=${origin}`)
  return { published: true, value: origin }
}
