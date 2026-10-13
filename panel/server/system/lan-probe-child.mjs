// 虚拟终端里跑的探测子进程(由 lan-probe.mjs 用 `ip netns exec <ns> node 本文件 <json>` 启动)。
// 问 DHCP 发的 DNS、按解析出来的第一个地址连接，再按选择执行 GET / HEAD / TCP / TLS 探测。
// 每一步用一行 JSON 报给父进程(stdout),连接拿到响应后不立刻断——父进程要趁它还开着去
// conntrack / 内核连接表里找这条连接,找完往 stdin 写一行 close 再断。
import dns from 'node:dns'
import net from 'node:net'
import readline from 'node:readline'
import tls from 'node:tls'
import { normalizeProbeMethod } from './probe-method.mjs'

const emit = (obj) => { process.stdout.write(`${JSON.stringify(obj)}\n`) }
const errorMessage = (err) => (err instanceof Error ? err.message : String(err))

const main = async () => {
  let opts
  try {
    opts = JSON.parse(process.argv[2] || '{}')
  } catch {
    emit({ event: 'error', stage: 'args', error: 'bad args' })
    process.exit(2)
  }
  const target = String(opts.target || '')
  const method = normalizeProbeMethod(opts.method)
  const port = Number(opts.port) || 443
  const secure = method === 'TLS' || (method !== 'TCP' && (opts.secure !== undefined ? Boolean(opts.secure) : port !== 80))
  const dnsServers = Array.isArray(opts.dnsServers) ? opts.dnsServers.filter((s) => net.isIP(s)) : []
  const timeoutMs = Number(opts.timeoutMs) || 10000
  const holdMs = Number(opts.holdMs) || 20000
  const t0 = Date.now()
  const isIp = net.isIP(target) !== 0

  // 兜底:父进程忘了说 close(或者它先挂了),自己到点退出,不在命名空间里留孤儿
  setTimeout(() => process.exit(0), holdMs).unref()

  let connectTo = target
  let family = net.isIPv6(target) ? 6 : 4
  if (!isIp) {
    if (!dnsServers.length) {
      emit({ event: 'error', stage: 'dns', error: 'no dns server from lease' })
      process.exit(0)
    }
    const resolver = new dns.Resolver({ timeout: Math.min(timeoutMs, 5000), tries: 2 })
    resolver.setServers(dnsServers)
    const td = Date.now()
    let answers = []
    let error = ''
    try {
      answers = await new Promise((resolve, reject) => resolver.resolve4(target, (err, list) => (err ? reject(err) : resolve(list || []))))
    } catch (err) {
      error = errorMessage(err)
    }
    const out = { event: 'dns', server: dnsServers[0], ok: !error, answers, ms: Date.now() - td }
    if (error) out.error = error
    if (opts.resolve6) {
      try {
        out.answers6 = await new Promise((resolve, reject) => resolver.resolve6(target, (err, list) => (err ? reject(err) : resolve(list || []))))
      } catch (err) {
        out.answers6 = []
        out.error6 = errorMessage(err)
      }
    }
    emit(out)
    if (!answers.length) {
      emit({ event: 'error', stage: 'dns', error: error || 'no address', ms: Date.now() - t0 })
      process.exit(0)
    }
    connectTo = String(answers[0])
    family = 4
  }

  const tc = Date.now()
  const socket = net.connect({ host: connectTo, port, family })
  socket.setNoDelay(true)
  let responded = false
  let closing = false
  const timer = setTimeout(() => {
    if (responded) return
    emit({ event: 'error', stage: socket.connecting ? 'connect' : 'request', error: 'timeout', ms: Date.now() - tc })
    socket.destroy()
    process.exit(0)
  }, timeoutMs)
  const shutdown = () => {
    closing = true
    clearTimeout(timer)
    try { socket.destroy() } catch { /* ignore */ }
    process.exit(0)
  }
  // 父进程说 close 就断开退出
  readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim() === 'close') shutdown() })
  process.stdin.on('end', shutdown)

  socket.once('error', (err) => {
    if (closing || responded) return
    clearTimeout(timer)
    emit({ event: 'error', stage: socket.connecting ? 'connect' : 'request', error: errorMessage(err), ms: Date.now() - tc })
    process.exit(0)
  })
  socket.once('connect', () => {
    emit({ event: 'connected', localAddress: socket.localAddress, localPort: socket.localPort, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, ms: Date.now() - tc })
    const complete = (stream, status, headers) => {
      responded = true
      clearTimeout(timer)
      // GET 不下载完整正文；保持连接让父进程查 conntrack，背压限制内存和流量。
      stream.pause()
      emit({ event: 'response', method, ...(status === undefined ? {} : { status }), ...(headers ? { headers } : {}), ms: Date.now() - tc })
    }
    // 响应头里只带回判定「人机验证」要用的几个(见 system/http-challenge.mjs)
    const pickHeaders = (lines) => {
      const out = {}
      for (const line of lines) {
        const i = line.indexOf(':')
        if (i <= 0) continue
        const name = line.slice(0, i).trim().toLowerCase()
        if (['server', 'cf-mitigated', 'cf-ray'].includes(name) && !(name in out)) out[name] = line.slice(i + 1).trim().slice(0, 120)
      }
      return out
    }
    if (method === 'TCP') { complete(socket); return }
    const host = net.isIPv6(target) ? `[${target}]` : target
    const hostHeader = port === (secure ? 443 : 80) ? host : `${host}:${port}`
    const request = `${method} / HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: open-box-terminal-test\r\nConnection: keep-alive\r\n\r\n`
    const readStatus = (stream) => {
      let head = ''
      let interim = false
      let headerBytes = 0
      // 状态行读到之后继续收响应头到空行为止,空行一到才报 response;超过 16KB 见 tooLarge
      let status = undefined
      const headerLines = []
      const fail = (error) => {
        if (responded || closing) return
        responded = true
        clearTimeout(timer)
        emit({ event: 'error', stage: 'request', error, ms: Date.now() - tc })
        stream.destroy()
        process.exit(0)
      }
      // 响应头超过 16KB:状态行已经读到就按收到的状态码算(GitHub #583:gemini.google.com 的响应头约 26KB,一条安全策略头
      // 就近 20KB,浏览器照常打开,这里以前报「访问失败」);连状态行都没读到才算失败。和内核诊断(api/route-test.mjs)一样
      const tooLarge = () => {
        if (status === undefined) { fail('response headers too large'); return }
        complete(stream, status, pickHeaders(headerLines))
        head = ''
      }
      stream.on('data', (c) => {
        if (responded) return
        head += c.subarray(0, 16384).toString('latin1')
        while (!responded) {
          const i = head.indexOf('\r\n')
          if (i < 0) break
          const line = head.slice(0, i)
          head = head.slice(i + 2)
          headerBytes += i + 2
          if (headerBytes > 16384) { tooLarge(); return }
          if (interim) { if (!line) interim = false; continue }
          if (status !== undefined) {
            if (!line) { complete(stream, status, pickHeaders(headerLines)); head = ''; break }
            headerLines.push(line)
            continue
          }
          const m = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(line)
          if (!m) { fail(`bad HTTP status line`); return }
          const code = Number(m[1])
          if (code >= 100 && code < 200 && code !== 101) { interim = true; continue }
          status = code
        }
        if (!responded && (head.length + headerBytes >= 16384 || c.length > 16384)) tooLarge()
      })
      stream.once('error', (err) => {
        fail(errorMessage(err))
      })
      stream.once('close', () => {
        fail('connection closed')
      })
    }
    if (secure) {
      // SNI 只能是域名(RFC 6066),IP 目标不带
      const stream = tls.connect({ socket, ...(isIp ? {} : { servername: target }), rejectUnauthorized: false }, () => {
        if (method === 'TLS') complete(stream)
        else stream.write(request)
      })
      readStatus(stream)
    } else {
      socket.write(request)
      readStatus(socket)
    }
  })
}

main().catch((err) => {
  emit({ event: 'error', stage: 'internal', error: errorMessage(err) })
  process.exit(1)
})
