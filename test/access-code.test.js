import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  accessCodeMatches,
  isValidAccessCode,
  randomAccessCode,
  readAccessCodeFile,
  resolveAccessCode,
  resolveAccessCodeFile,
  writeAccessCodeFile,
} from '../lib/access-code.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-tailscale-code-'))
}

test('randomAccessCode generates URL-safe codes with no look-alike letters', () => {
  for (let index = 0; index < 20; index += 1) {
    const code = randomAccessCode(10)
    assert.equal(code.length, 10)
    assert.match(code, /^[a-z2-9]+$/)
    assert.doesNotMatch(code, /[lo01]/)
  }
  assert.equal(randomAccessCode(4).length, 10)
  assert.equal(randomAccessCode(80).length, 10)
})

test('isValidAccessCode accepts 6–64 URL-safe characters', () => {
  assert.equal(isValidAccessCode('abc234'), true)
  assert.equal(isValidAccessCode('abc-234_xyz'), true)
  assert.equal(isValidAccessCode('abc23'), false)
  assert.equal(isValidAccessCode('a'.repeat(65)), false)
  assert.equal(isValidAccessCode('abc 234'), false)
  assert.equal(isValidAccessCode(''), false)
  assert.equal(isValidAccessCode(undefined), false)
})

test('resolveAccessCode generates, persists and reuses a code', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'state.json')
    const first = resolveAccessCode({ file, length: 12, dshHome: dir })
    assert.equal(first.source, 'generated')
    assert.equal(first.code.length, 12)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const second = resolveAccessCode({ file, dshHome: dir })
    assert.equal(second.source, 'file')
    assert.equal(second.code, first.code)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccessCode rotates an existing code', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'state.json')
    const first = resolveAccessCode({ file, dshHome: dir })
    const rotated = resolveAccessCode({ file, rotate: true, dshHome: dir })
    assert.equal(rotated.source, 'generated')
    assert.notEqual(rotated.code, first.code)
    assert.equal(readAccessCodeFile(file).code, rotated.code)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccessCode prefers an explicit code and never writes it', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'state.json')
    const result = resolveAccessCode({ explicit: 'fixed-code-123', file, dshHome: dir })
    assert.deepEqual(result, { code: 'fixed-code-123', source: 'config', file })
    assert.throws(() => readFileSync(file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccessCode rejects an invalid explicit code', () => {
  const dir = tempDir()
  try {
    const result = resolveAccessCode({ explicit: 'bad code!', file: join(dir, 'state.json'), dshHome: dir })
    assert.equal(result.source, 'disabled')
    assert.match(result.error, /6–64/)
    assert.equal(result.code, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAccessCodeFile ignores malformed and invalid records', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'state.json')
    writeFileSync(file, 'not json')
    assert.equal(readAccessCodeFile(file), undefined)
    writeFileSync(file, JSON.stringify({ code: 'x' }))
    assert.equal(readAccessCodeFile(file), undefined)
    writeFileSync(file, JSON.stringify({ code: 'valid-code-1', createdAt: '2026-01-01T00:00:00Z' }))
    assert.deepEqual(readAccessCodeFile(file), { code: 'valid-code-1', createdAt: '2026-01-01T00:00:00Z' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeAccessCodeFile is atomic and owner-only', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'nested', 'state.json')
    assert.equal(writeAccessCodeFile(file, 'atomic-code-9'), true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).code, 'atomic-code-9')
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccessCodeFile prefers an explicit path over DSH_HOME', () => {
  assert.equal(resolveAccessCodeFile('/tmp/explicit.json', '/tmp/home'), '/tmp/explicit.json')
  assert.equal(resolveAccessCodeFile('', '/tmp/home'), '/tmp/home/tailscale-access.json')
})

test('accessCodeMatches compares without leaking length', () => {
  assert.equal(accessCodeMatches('abc123', 'abc123'), true)
  assert.equal(accessCodeMatches('abc124', 'abc123'), false)
  assert.equal(accessCodeMatches('abc123', 'abc1234'), false)
  assert.equal(accessCodeMatches('', 'abc123'), false)
  assert.equal(accessCodeMatches(undefined, 'abc123'), false)
})
