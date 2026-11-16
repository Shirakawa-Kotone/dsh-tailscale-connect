import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { test } from 'node:test'

import {
  createTailnetProxy,
  forwardedFor,
  forwardedHandshake,
  forwardedHeaders,
  normalizeRemoteAddress,
} from '../lib/proxy.js'

/** Start one server and return its port. */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

/** Start the upstream DSH stand-in: echoes request facts, upgrades WebSockets. */
async function startUpstream() {
  const sockets = new Set()
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' })
      response.end(JSON.stringify({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        forwardedFor: request.headers['x-forwarded-for'],
        forwardedProto: request.headers['x-forwarded-proto'],
        forwardedHost: request.headers['x-forwarded-host'],
        custom: request.headers['x-custom'],
        body,
      }))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })
  server.on('upgrade', (request, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + 'X-Upstream: yes\r\n'
      + '\r\n',
    )
    socket.write('hello')
    socket.on('data', (chunk) => { socket.write(chunk) })
  })
  const port = await listen(server)
  return { server, port, sockets }
}

/** Issue one HTTP request and return status, headers and body. */
function requestThrough(port, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      agent: false,
      host: '127.0.0.1',
      port,
      path: options.path ?? '/',
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/** Buffer socket text and wait until it contains a marker. */
function bufferedReader(socket) {
  let buffer = ''
  socket.on('data', (chunk) => { buffer += chunk.toString('latin1') })
  return async (marker, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs
    while (!buffer.includes(marker)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${marker}; got ${JSON.stringify(buffer)}`)
      await new Promise((resolve) => { setTimeout(resolve, 10) })
    }
    return buffer
  }
}

test('normalizeRemoteAddress unwraps IPv4-mapped peers', () => {
  assert.equal(normalizeRemoteAddress('::ffff:100.64.0.2'), '100.64.0.2')
  assert.equal(normalizeRemoteAddress('100.64.0.2'), '100.64.0.2')
  assert.equal(normalizeRemoteAddress(undefined), '')
})

test('forwardedFor appends this hop to an existing chain', () => {
  assert.equal(forwardedFor(undefined, '100.64.0.2'), '100.64.0.2')
  assert.equal(forwardedFor('10.0.0.1', '100.64.0.2'), '10.0.0.1, 100.64.0.2')
  assert.equal(forwardedFor(['10.0.0.1', '10.0.0.2'], '100.64.0.2'), '10.0.0.1,10.0.0.2, 100.64.0.2')
})

test('forwardedHeaders keeps Host and drops hop-by-hop headers', () => {
  const headers = forwardedHeaders({
    headers: {
      host: 'dsh-host.tailnet-example.ts.net:3080',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'x-custom': 'v',
      'x-forwarded-for': '10.0.0.1',
    },
    socket: { remoteAddress: '100.64.0.2' },
  })
  assert.equal(headers.host, 'dsh-host.tailnet-example.ts.net:3080')
  assert.equal(headers['x-custom'], 'v')
  assert.equal(headers.connection, undefined)
  assert.equal(headers['transfer-encoding'], undefined)
  assert.equal(headers['x-forwarded-for'], '10.0.0.1, 100.64.0.2')
  assert.equal(headers['x-forwarded-proto'], 'http')
  assert.equal(headers['x-forwarded-host'], 'dsh-host.tailnet-example.ts.net:3080')
})

test('forwardedHandshake rebuilds the request line and adds forwarding headers', () => {
  const head = forwardedHandshake({
    method: 'GET',
    url: '/ios/v1?token=abc',
    rawHeaders: ['Host', 'dsh-host.tailnet-example.ts.net:3080', 'Upgrade', 'websocket', 'Sec-WebSocket-Key', 'k'],
    headers: { host: 'dsh-host.tailnet-example.ts.net:3080' },
    socket: { remoteAddress: '100.64.0.2' },
  })
  assert.match(head, /^GET \/ios\/v1\?token=abc HTTP\/1\.1\r\n/)
  assert.match(head, /Host: dsh-host\.tailnet-example\.ts\.net:3080/)
  assert.match(head, /Upgrade: websocket/)
  assert.match(head, /X-Forwarded-For: 100\.64\.0\.2/)
  assert.match(head, /X-Forwarded-Proto: http/)
  assert.ok(head.endsWith('\r\n\r\n'))
})

test('proxy forwards HTTP and preserves the client Host', async (t) => {
  const upstream = await startUpstream()
  const proxy = createTailnetProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamPort: upstream.port,
    allowSource: () => true,
  })
  t.after(async () => {
    await proxy.stop()
    for (const socket of upstream.sockets ?? []) socket.destroy()
    upstream.server.closeAllConnections()
    await new Promise((resolve) => { upstream.server.close(resolve) })
  })
  const address = await proxy.start()
  const response = await requestThrough(address.port, {
    path: '/api/session/list?x=1',
    headers: {
      host: 'dsh-host.tailnet-example.ts.net:3080',
      'x-custom': 'value',
      'x-forwarded-for': '10.0.0.1',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers['x-upstream'], 'yes')
  const echoed = JSON.parse(response.body)
  assert.equal(echoed.url, '/api/session/list?x=1')
  assert.equal(echoed.host, 'dsh-host.tailnet-example.ts.net:3080')
  assert.equal(echoed.custom, 'value')
  assert.equal(echoed.forwardedFor, '10.0.0.1, 127.0.0.1')
  assert.equal(echoed.forwardedProto, 'http')
  assert.equal(echoed.forwardedHost, 'dsh-host.tailnet-example.ts.net:3080')
})

test('proxy forwards a POST body unchanged', async (t) => {
  const upstream = await startUpstream()
  const proxy = createTailnetProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamPort: upstream.port,
  })
  t.after(async () => {
    await proxy.stop()
    for (const socket of upstream.sockets ?? []) socket.destroy()
    upstream.server.closeAllConnections()
    await new Promise((resolve) => { upstream.server.close(resolve) })
  })
  const address = await proxy.start()
  const response = await requestThrough(address.port, {
    method: 'POST',
    path: '/api/echo',
    headers: { host: '100.64.0.1:3080', 'content-type': 'text/plain' },
    body: 'payload',
  })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).body, 'payload')
})

test('proxy refuses a source the guard rejects without touching upstream', async (t) => {
  let upstreamHits = 0
  const upstream = http.createServer((_request, response) => {
    upstreamHits += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const proxy = createTailnetProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamPort,
    allowSource: () => false,
  })
  t.after(async () => {
    await proxy.stop()
    upstream.closeAllConnections()
    await new Promise((resolve) => { upstream.close(resolve) })
  })
  const address = await proxy.start()
  const response = await requestThrough(address.port, { headers: { host: '100.64.0.1:3080' } })
  assert.equal(response.status, 403)
  assert.equal(upstreamHits, 0)
})

test('proxy relays a WebSocket upgrade and its bytes', async (t) => {
  const upstream = await startUpstream()
  const proxy = createTailnetProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamPort: upstream.port,
    allowSource: () => true,
  })
  t.after(async () => {
    await proxy.stop()
    for (const socket of upstream.sockets ?? []) socket.destroy()
    upstream.server.closeAllConnections()
    await new Promise((resolve) => { upstream.server.close(resolve) })
    console.log('DBG upstream closed')
  })
  const address = await proxy.start()
  const socket = net.connect({ host: '127.0.0.1', port: address.port })
  const readUntil = bufferedReader(socket)
  t.after(() => socket.destroy())
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(
    'GET /ios/v1?token=abc HTTP/1.1\r\n'
    + 'Host: dsh-host.tailnet-example.ts.net:3080\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
    + 'Sec-WebSocket-Version: 13\r\n'
    + '\r\n',
  )
  const opened = await readUntil('hello')
  assert.match(opened, /HTTP\/1\.1 101 Switching Protocols/)
  assert.match(opened, /X-Upstream: yes/i)
  assert.match(opened, /hello$/)
  socket.write('ping')
  const echoed = await readUntil('ping')
  assert.match(echoed, /ping$/)
})
