/**
 * Persistent short access code: one stable, human-friendly bearer secret that a
 * tailnet device can bookmark and reuse across DSH restarts.
 *
 * The DSH launch token changes with every process, so the tokenized startup URL
 * cannot be a bookmark. This code is generated once, stored in
 * `$DSH_HOME/tailscale-access.json` with mode `0600`, and read again on every
 * boot; the short route exchanges it for the current process's tokenized URL,
 * which is what actually mints the browser cookie.
 *
 * @module dsh-tailscale-connect/access-code
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Characters used for generated codes: lowercase, no `l/o/0/1` look-alikes. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** Accepted shape for an operator-supplied code. */
const CODE_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

/**
 * Generate one URL-safe code.
 * @param {number} [length] - requested length, clamped to 6..64.
 * @returns {string} generated code.
 */
export function randomAccessCode(length = 10) {
  const size = Number.isInteger(length) && length >= 6 && length <= 64 ? length : 10
  const bytes = randomBytes(size)
  let code = ''
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]
  return code
}

/**
 * Whether an operator-supplied code is a usable URL path segment.
 * @param {unknown} code - candidate.
 * @returns {boolean} true for 6–64 URL-safe characters.
 */
export function isValidAccessCode(code) {
  return typeof code === 'string' && CODE_PATTERN.test(code)
}

/**
 * Resolve the DSH home directory the way the Host does.
 *
 * The Host process usually does not carry `DSH_HOME` in its environment (the
 * variable is injected for shell calls), so `~/.dsh` is the reliable default.
 * @param {string | undefined} [fromEnv] - `process.env.DSH_HOME` for a seam.
 * @returns {string} home directory.
 */
export function resolveDshHome(fromEnv = process.env.DSH_HOME) {
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * Resolve the code file for one config.
 * @param {string} [configured] - explicit `accessCodeFile`.
 * @param {string | undefined} [fromEnv] - DSH_HOME seam.
 * @returns {string} absolute file path.
 */
export function resolveAccessCodeFile(configured, fromEnv = process.env.DSH_HOME) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(resolveDshHome(fromEnv), 'tailscale-access.json')
}

/**
 * Read a stored code; a missing or malformed file returns undefined.
 * @param {string} file - state file path.
 * @returns {{ code: string, createdAt?: string } | undefined} stored record.
 */
export function readAccessCodeFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const code = parsed.code
    if (!isValidAccessCode(code)) return undefined
    return {
      code,
      ...(typeof parsed.createdAt === 'string' ? { createdAt: parsed.createdAt } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Persist one code atomically with owner-only permissions.
 * @param {string} file - state file path.
 * @param {string} code - code to store.
 * @returns {boolean} true when written.
 */
export function writeAccessCodeFile(file, code) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.tmp-${String(process.pid)}`
    const record = JSON.stringify({ version: 1, code, createdAt: new Date().toISOString() }, null, 2)
    writeFileSync(temporary, `${record}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the effective short code for one activation.
 *
 * Precedence: explicit config (validated, never persisted) > stored file >
 * generated + persisted. `rotate` ignores the stored code once and replaces it.
 * @param {object} [options] - resolution options.
 * @param {string} [options.explicit] - `accessCode` from config.
 * @param {string} [options.file] - explicit state file.
 * @param {number} [options.length] - generated code length.
 * @param {boolean} [options.rotate] - replace the stored code.
 * @param {string} [options.dshHome] - DSH home seam.
 * @returns {{ code?: string, source: 'config' | 'file' | 'generated' | 'disabled', file: string, error?: string }} result.
 */
export function resolveAccessCode(options = {}) {
  const file = resolveAccessCodeFile(options.file, options.dshHome)
  if (typeof options.explicit === 'string' && options.explicit.trim() !== '') {
    const code = options.explicit.trim()
    if (!isValidAccessCode(code)) {
      return { source: 'disabled', file, error: 'accessCode must be 6–64 URL-safe characters' }
    }
    return { code, source: 'config', file }
  }
  if (options.rotate !== true) {
    const stored = readAccessCodeFile(file)
    if (stored !== undefined) return { code: stored.code, source: 'file', file }
  }
  const code = randomAccessCode(options.length)
  writeAccessCodeFile(file, code)
  return { code, source: 'generated', file }
}

/**
 * Compare one presented code with the expected code in constant time.
 * @param {unknown} presented - code from the request path.
 * @param {string} expected - the configured code.
 * @returns {boolean} true when they match.
 */
export function accessCodeMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || expected === '') return false
  // Hash first so the comparison is length-independent and always runs over
  // the same number of bytes.
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}
