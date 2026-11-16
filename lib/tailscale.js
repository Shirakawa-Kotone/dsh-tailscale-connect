/**
 * Locate the `tailscale` CLI on this machine.
 *
 * `dsh` is often launched from a GUI app or a service manager whose PATH does
 * not include Homebrew's `/opt/homebrew/bin` or the macOS app bundle, so a bare
 * `tailscale` lookup is not enough. The first existing candidate wins; when
 * none exists the bare name is returned and `spawnSync` reports ENOENT, which
 * callers already treat as "CLI unavailable" instead of a crash.
 *
 * @module dsh-tailscale-connect/tailscale
 */

import { existsSync } from 'node:fs'

/** Candidate executables per platform, in probe order. */
const CANDIDATES = {
  darwin: [
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/bin/tailscale',
  ],
  linux: [
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/sbin/tailscale',
    '/snap/bin/tailscale',
  ],
  win32: [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  ],
}

/**
 * Resolve the executable this plugin should spawn.
 * @param {string} [configured] - explicit config or environment path.
 * @param {NodeJS.Platform} [platform] - platform seam for tests.
 * @param {(path: string) => boolean} [exists] - existence seam for tests.
 * @returns {string} absolute path, or the bare command name as a last resort.
 */
export function resolveTailscaleBinary(configured, platform = process.platform, exists = existsSync) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const envPath = process.env.TAILSCALE_PATH
  if (typeof envPath === 'string' && envPath.trim() !== '') return envPath.trim()
  const candidates = CANDIDATES[platform] ?? []
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return 'tailscale'
}

/**
 * Whether one candidate path exists (exported for a cheap status line).
 * @param {string} path - candidate path.
 * @returns {boolean} true when the path exists.
 */
export function tailscaleBinaryExists(path) {
  return existsSync(path)
}
