import assert from 'node:assert/strict'
import { test } from 'node:test'

import { originOf, PAIR_ORIGIN_ENV, publishPairOrigin } from '../lib/pairing.js'

test('originOf returns the canonical origin or undefined', () => {
  assert.equal(originOf('http://dsh-host.tailnet-example.ts.net:3080'), 'http://dsh-host.tailnet-example.ts.net:3080')
  assert.equal(originOf('https://dsh-host.tailnet-example.ts.net:8443/dsh/'), 'https://dsh-host.tailnet-example.ts.net:8443')
  assert.equal(originOf('not a url'), undefined)
  assert.equal(originOf(''), undefined)
  assert.equal(originOf(undefined), undefined)
})

test('publishPairOrigin writes the origin when the environment is empty', () => {
  const env = {}
  const lines = []
  const outcome = publishPairOrigin('http://dsh-host.tailnet-example.ts.net:3080', env, (line) => lines.push(line))
  assert.deepEqual(outcome, { published: true, value: 'http://dsh-host.tailnet-example.ts.net:3080' })
  assert.equal(env[PAIR_ORIGIN_ENV], 'http://dsh-host.tailnet-example.ts.net:3080')
  assert.deepEqual(lines, [`${PAIR_ORIGIN_ENV}=http://dsh-host.tailnet-example.ts.net:3080`])
})

test('publishPairOrigin leaves an explicit value untouched', () => {
  const env = { [PAIR_ORIGIN_ENV]: 'https://tunnel.example' }
  const outcome = publishPairOrigin('http://100.64.0.1:3080', env)
  assert.deepEqual(outcome, { published: false, reason: 'already-set', existing: 'https://tunnel.example' })
  assert.equal(env[PAIR_ORIGIN_ENV], 'https://tunnel.example')
})

test('publishPairOrigin treats whitespace as unset and rejects invalid URLs', () => {
  const env = { [PAIR_ORIGIN_ENV]: '   ' }
  const outcome = publishPairOrigin('http://100.64.0.1:3080', env)
  assert.equal(outcome.published, true)
  assert.equal(env[PAIR_ORIGIN_ENV], 'http://100.64.0.1:3080')

  const invalid = publishPairOrigin('not a url', {})
  assert.deepEqual(invalid, { published: false, reason: 'invalid' })
})
