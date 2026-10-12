import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { childEnv } from './timezone.mjs'

const writeAtomic = async (path, data, encoding) => {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    if (encoding) await fs.writeFile(tmp, data, encoding)
    else await fs.writeFile(tmp, data)
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export const createRealContext = () => ({
  // timeoutMs 可选:默认 30 秒适合部署/服务控制这类命令,但节点测速需要更短的上限,
  // 否则一批连不通的节点会把整轮拖成几分钟。
  // maxBuffer 可选:默认 1 MB(execFile 的默认值),取大网页(YouTube 频道页 1.3 MB)时放宽,超了按失败算
  async exec(cmd, args = [], { timeoutMs = 30_000, env, maxBuffer } = {}) {
    // sing-box 的工具子命令(rule-set compile / decompile / match、check、generate)都是短命进程,Go 默认 GOGC=100
    // 会让堆长到活数据的两倍才回收:编译 9 万多条的过滤名单峰值 140 MB。压到 25 峰值约 110 MB、慢一成,在 1 GB
    // 的路由器上值得。常驻的 sing-box run 由 init 脚本起,不经这里,不受影响
    const tool = /(^|\/)sing-box$/.test(String(cmd)) && args[0] !== 'run'
    const options = { timeout: timeoutMs, ...(maxBuffer ? { maxBuffer } : {}) }
    // 子进程不带面板给自己设的 TZ(system/timezone.mjs 的 childEnv),照旧按系统的时区设置
    options.env = childEnv({ ...(tool ? { GOGC: '25' } : {}), ...(env || {}) })
    return new Promise((resolve) => {
      execFile(cmd, args, options, (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        })
      })
    })
  },
  async sleep(ms) { await new Promise((resolve) => setTimeout(resolve, ms)) },
  async readFile(path) { return fs.readFile(path, 'utf8') },
  // 写文件一律先写临时文件再 rename:掉电 / OOM 时不会留下半截 config.json 或 .srs
  // (半截配置开机 FATAL,dnsmasq 模式下还得靠看门狗把 DNS 还回去)。rename 在同一目录内
  // 是原子的;临时文件名带 pid,和面板 / CLI 同时写也不会互相踩。
  async writeFile(path, content) { await writeAtomic(path, content, 'utf8') },
  // 规则集 .srs 是二进制,不能走上面那个 utf8 的写入——utf8 编码会把非法字节替换成
  // U+FFFD,写出来的文件 sing-box 一读就报错,而且错法很隐蔽(文件在、大小也差不多)。
  async writeFileBinary(path, data) { await writeAtomic(path, data) },
  // 原样拷一份二进制文件(热切换的旁路动态集 =「满」时就是 geoip 集合的拷贝,system/flip-files.mjs),同样先写临时文件再 rename
  async copyFile(from, to) { await writeAtomic(to, await fs.readFile(from)) },
  async exists(path) { try { await fs.access(path); return true } catch { return false } },
  async mkdirp(path) { await fs.mkdir(path, { recursive: true }) },
  async remove(path) { await fs.rm(path, { force: true, recursive: true }) },
})
