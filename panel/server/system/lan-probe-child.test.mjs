import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import tls from 'node:tls'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const childFile = fileURLToPath(new URL('./lan-probe-child.mjs', import.meta.url))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const listen = async (t, server) => {
  const sockets = new Set()
  server.on('connection', (s) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { for (const s of sockets) s.destroy(); server.close() })
  return server.address().port
}
const probe = async (t, port, extra = {}) => {
  const child = spawn(process.execPath, [childFile, JSON.stringify({ target: '127.0.0.1', port, secure: false, timeoutMs: 1000, holdMs: 3000, ...extra })], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const events = []
  let buffer = ''
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe never settled')), 4000)
    child.on('error', reject)
    child.on('exit', () => { clearTimeout(timer); if (!events.some((e) => ['response', 'error'].includes(e.event))) reject(new Error('probe exited without result')) })
    child.stdout.on('data', (c) => {
      buffer += c
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n')
        const e = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1)
        events.push(e)
        if (['response', 'error'].includes(e.event)) { clearTimeout(timer); resolve(e) }
      }
    })
  })
  return { child, events, result }
}

test('默认 GET 可访问 HEAD 返回 404 的站点；连接保留供父进程取证', async (t) => {
  const requests = []
  const port = await listen(t, net.createServer((s) => s.once('data', (c) => {
    requests.push(c.toString())
    s.write(`HTTP/1.1 ${c.toString().startsWith('HEAD') ? '404 Not Found' : '200 OK'}\r\nContent-Length: 0\r\n\r\n`)
  })))
  const get = await probe(t, port)
  assert.equal(get.result.status, 200)
  assert.equal(get.result.method, 'GET')
  assert.equal(get.events[0].event, 'connected')
  assert.equal(get.child.exitCode, null)
  assert.match(requests[0], new RegExp(`Host: 127.0.0.1:${port}\\r\\n`))
  const head = await probe(t, port, { method: 'HEAD' })
  assert.equal(head.result.status, 404)
  get.child.stdin.end('close\n'); head.child.stdin.end('close\n')
})

test('GET 对大正文施加背压，100 / 103 临时响应后取最终状态', async (t) => {
  let sent = 0
  let finished = false
  const port = await listen(t, net.createServer((s) => s.once('data', () => {
    s.write('HTTP/1.1 103 Early Hints\r\nLink: </style.css>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 67108864\r\n\r\n')
    const chunk = Buffer.alloc(64 * 1024)
    const pump = () => {
      while (sent < 64 * 1024 * 1024) { sent += chunk.length; if (!s.write(chunk)) { s.once('drain', pump); return } }
      finished = true
    }
    pump()
  })))
  const r = await probe(t, port)
  assert.equal(r.result.status, 200)
  await pause(100)
  assert.equal(finished, false, '不得持续下载正文')
  assert.ok(sent < 64 * 1024 * 1024)
  assert.equal(r.child.exitCode, null)
})

test('TCP 只验证连接，不发送 HTTP / TLS 数据', async (t) => {
  let bytes = 0
  const port = await listen(t, net.createServer((s) => s.on('data', (c) => { bytes += c.length })))
  const r = await probe(t, port, { method: 'TCP', secure: true })
  assert.equal(r.result.method, 'TCP')
  assert.equal(r.result.status, undefined)
  await pause(30)
  assert.equal(bytes, 0)
})

test('TLS 只验证握手，不发送 HTTP 数据；TLS 失败不能报成功', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'openbox-probe-tls-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key'), '-out', join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  let bytes = 0
  const port = await listen(t, tls.createServer({ key: readFileSync(join(dir, 'key')), cert: readFileSync(join(dir, 'cert')) }, (s) => s.on('data', (c) => { bytes += c.length })))
  const r = await probe(t, port, { method: 'TLS' })
  assert.equal(r.result.method, 'TLS')
  assert.equal(r.result.status, undefined)
  await pause(30)
  assert.equal(bytes, 0)
  const bad = await listen(t, net.createServer((s) => s.end('plain text\r\n')))
  assert.equal((await probe(t, bad, { method: 'TLS' })).result.event, 'error')
})

test('异常状态行 / 超长头 / 未连接 / 非法方法都如实报错', async (t) => {
  for (const response of ['not HTTP\r\n', 'x'.repeat(20000)]) {
    const port = await listen(t, net.createServer((s) => s.once('data', () => s.write(response))))
    assert.equal((await probe(t, port)).result.event, 'error')
  }
  const invalid = await probe(t, 1, { method: 'POST' })
  assert.equal(invalid.result.event, 'error')
  assert.ok(!invalid.events.some((e) => e.event === 'connected'))
})

test('响应头读到空行才报 response,并带回 server / cf-mitigated 头（GitHub 规则页把 Cloudflare 人机验证和真 403 分开）', async (t) => {
  const port = await listen(t, net.createServer((socket) => {
    socket.once('data', () => socket.write('HTTP/1.1 403 Forbidden\r\nServer: cloudflare\r\nCF-Mitigated: challenge\r\nContent-Type: text/html\r\nContent-Length: 0\r\n\r\n'))
  }))
  const r = await probe(t, port)
  assert.equal(r.result.event, 'response'); assert.equal(r.result.status, 403)
  assert.deepEqual(r.result.headers, { server: 'cloudflare', 'cf-mitigated': 'challenge' })
  r.child.stdin.end('close\n')
})

test('响应头超过 16KB:状态行读到了就按状态码算成功(GitHub #583,Gemini 的响应头约 26KB);连状态行都没有才报失败', async (t) => {
  const csp = `Content-Security-Policy: ${'x'.repeat(20 * 1024)}\r\n`
  const big = await listen(t, net.createServer((s) => s.once('data', () => {
    s.write(`HTTP/1.1 200 OK\r\nServer: gws\r\n${csp}${'X-Pad: y\r\n'.repeat(600)}Content-Length: 0\r\n\r\n`)
  })))
  const ok = await probe(t, big)
  assert.equal(ok.result.event, 'response')
  assert.equal(ok.result.status, 200)
  assert.equal(ok.result.headers.server, 'gws', '超限前收到的响应头照样带回')
  ok.child.stdin.end('close\n')
  const junk = await listen(t, net.createServer((s) => s.once('data', () => { s.write('x'.repeat(40 * 1024)) })))
  const bad = await probe(t, junk)
  assert.equal(bad.result.event, 'error')
})
