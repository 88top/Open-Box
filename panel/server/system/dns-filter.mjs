import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import { assertPublicUrl, pinnedLookup } from '../api/net-guard.mjs'
import { allowDomainCondition, contentKey, DNS_FILTER_RUNTIME, DNS_FILTER_RULESET_PREFIX, filterKey, filterSettings, validateDnsFilter } from '../engine/dns-filter.mjs'
import { parseListInWorker } from './dns-filter-parse.mjs'
import { fetchRuleList } from './rule-lists.mjs'

export const FILTER_LIST_STATE = 'openbox/dns-filter-lists'
const readRaw = (store, key, fallback = {}) => { try { return JSON.parse(store.getRaw(key) || 'null') || fallback } catch { return fallback } }
export const readFilterArtifact = (store) => readRaw(store, DNS_FILTER_RUNTIME, null)
export const readFilterListState = (store) => readRaw(store, FILTER_LIST_STATE)

export const cleanupDnsFilterCache = async ({ store, ctx, paths }) => {
  const dir = `${paths.dataDir}/dns-filter`
  const ids = new Set(filterSettings(store.getProfile()).lists.map((l) => l.id))
  const state = Object.fromEntries(Object.entries(readFilterListState(store)).filter(([id]) => ids.has(id)))
  store.setRaw(FILTER_LIST_STATE, JSON.stringify(state))
  const keep = new Set(Object.values(state).map((s) => s.path).filter(Boolean))
  for (const set of readFilterArtifact(store)?.sets || []) keep.add(set.path)
  // Include the running configuration even when settings / prepared artifacts are newer.
  try { for (const set of JSON.parse(await ctx.readFile(paths.configPath)).route?.rule_set || []) if (set.path) keep.add(set.path) }
  catch { return }
  let files
  try { files = await fs.readdir(dir) } catch { return }
  for (const name of files) {
    const file = `${dir}/${name}`
    if (/^[A-Za-z0-9_-]+\.(txt|json|srs)$/.test(name) && !keep.has(file)) await fs.rm(file, { force: true })
  }
}

// Same address policy as subscriptions, with normal TLS verification and pinned DNS per hop.
const guardedFetch = async (input, init) => {
  let url = input
  for (let hop = 0; hop <= 3; hop++) {
    const target = await assertPublicUrl(url, { allowPrivate: true })
    if (target.username || target.password) throw new Error('名单重定向不能包含用户名或密码')
    const response = await new Promise((resolve, reject) => {
      const req = (target.protocol === 'https:' ? https : http).get(target, {
        signal: init.signal, lookup: pinnedLookup(target.validatedRecords),
        headers: { 'user-agent': 'Open-Box DNS Filter', 'accept-encoding': 'identity' },
      }, (res) => {
        const body = [204, 205, 304].includes(res.statusCode) ? null : Readable.toWeb(res)
        if (!body) res.resume()
        try { resolve(new Response(body, { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) })) }
        catch (error) { res.destroy(); reject(error) }
      })
      req.on('error', reject)
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!location) throw new Error('名单重定向缺少地址')
    url = new URL(location, target).href
  }
  throw new Error('名单重定向次数过多')
}

export const fetchDnsFilterList = async (url, fetchImpl = guardedFetch) =>
  (await fetchRuleList(fetchImpl, url)).toString('utf8')

// 每份集合一个固定的名字和路径(名单 id + 类别 + 第几份):名单内容更新只换文件,内核盯着本地规则集文件自己重新加载,
// 不重启内核(用户 2026-09-30:没必要重启内核的都不重启)。先编到临时文件、编过才原子地换上去:下载 / 编译失败不会
// 动正在用的那份。以前按内容寻址起名,内容一变名字就变、配置跟着变,每次更新都得重启
// 更新名单要临时多占内存:解析在工作线程里(峰值约 100 MB,做完即还),内核编译一份最多 2.5 万条的集合约 90 MB
// (GOGC=25),再加重启内核。可用内存不到这个数就不动手——2026-09-18 正式路由器(1 GB,可用约 340 MB,面板已涨到
// 230 MB)点更新直接把整机内存耗尽,面板被 OOM 杀掉,名单反而没更新成。读不到 /proc/meminfo(测试、别的系统)就不判
export const MIN_AVAILABLE_MB = 160
export const memAvailableMb = async (ctx) => {
  try {
    const m = /^MemAvailable:\s+(\d+)/m.exec(await ctx.readFile('/proc/meminfo'))
    return m ? Number(m[1]) / 1024 : null
  } catch {
    return null
  }
}

// 部署时名单下不来、本地又没有(第一次开、换了链接):不让整次部署失败——以前内核就因为这个起不来(GitHub #562 #565)。
// 这份先不过滤、记进产物的 missing(启动后弹黄色提示),其余名单照常;之后的部署隔这么久才再试一次(每次部署都等满
// 下载超时太久),「更新名单」按钮随时可以重试
export const MISSING_RETRY_MS = 10 * 60 * 1000

export const prepareDnsFilter = async ({ store, ctx, paths, force = false, fetchImpl = guardedFetch, now = Date.now }) => {
  const settings = filterSettings(store.getProfile())
  if (!settings.enabled && !force) return null
  const error = validateDnsFilter(settings)
  if (error) throw new Error(error)
  const previous = readFilterArtifact(store)
  const state = readFilterListState(store)
  const retryDue = (m) => !(state[m.id]?.failedAt && now() - Number(state[m.id].failedAt) < MISSING_RETRY_MS)
  const previousOk = previous?.key === filterKey(settings) && previous.hashes && (await Promise.all(previous.sets.map((s) => ctx.exists(s.path)))).every(Boolean)
  // 老版本的产物(按内容起名、没有 hashes)在部署时顺手重编成固定名字:用本地缓存的名单,不联网。以后名单更新就只换文件
  if (!force && previousOk && !(previous.missing || []).some(retryDue)) return previous
  const available = await memAvailableMb(ctx)
  if (available !== null && available < MIN_AVAILABLE_MB) {
    // 部署时只是到点重试没下下来的名单:内存不够就接着用现有的
    if (!force && previousOk) return previous
    throw new Error(`可用内存只有 ${Math.round(available)} MB,更新过滤名单要临时占用约 ${MIN_AVAILABLE_MB} MB（内核编译名单）,这次没有更新;等内存空一些再试,现有名单照常生效`)
  }
  const dir = `${paths.dataDir}/dns-filter`
  await ctx.mkdirp(dir)
  // 上一份各集合的内容摘要:内容没变、文件还在就不重编
  const hashes = {}
  const previousHashes = (previous && previous.hashes) || {}
  // 编译一份集合。compile 只把正则当字符串序列化,match 才真正实例化 RE2,所以带正则的集合编完再 match 一次空域名当校验。
  // 临时文件的名字带点(x.new.srs),不会被当成正式文件(cleanupDnsFilterCache 只认不带点的名字);失败就删掉、把原因抛给调用方
  const compile = async (label, source, regex) => {
    const tag = `${DNS_FILTER_RULESET_PREFIX}${label}`
    const path = `${dir}/${tag}.srs`
    const hash = contentKey(source)
    hashes[tag] = hash
    if (previousHashes[tag] === hash && await ctx.exists(path)) return { type: 'local', tag, format: 'binary', path }
    const tmpJson = `${dir}/${tag}.new.json`
    const tmpSrs = `${dir}/${tag}.new.srs`
    await ctx.writeFile(tmpJson, source)
    const compiled = await ctx.exec(paths.singbox, ['rule-set', 'compile', '--output', tmpSrs, tmpJson])
    await ctx.remove(tmpJson)
    if (compiled.code !== 0) { await ctx.remove(tmpSrs).catch(() => {}); throw new Error(`名单规则无效: ${(compiled.stderr || '').slice(0, 300)}`) }
    if (regex) {
      const validate = await ctx.exec(paths.singbox, ['rule-set', 'match', '--format', 'binary', tmpSrs, ''])
      if (validate.code !== 0) { await ctx.remove(tmpSrs).catch(() => {}); throw new Error(`名单正则无效: ${(validate.stderr || '').slice(0, 250)}`) }
    }
    // copyFile 是先写临时文件再改名的原子替换(system/context-real.mjs):内核看到的一直是一份完整的集合
    await ctx.copyFile(tmpSrs, path)
    await ctx.remove(tmpSrs)
    return { type: 'local', tag, format: 'binary', path }
  }
  // 一份名单四类集合:拦截、强制拦截、放行、强制放行,每类按条目数切成若干份(见 chunkRules)。以前放行是把所有名单
  // 合起来编一份,而每份名单又先单独编一遍再 match 一遍做校验——9 万条的名单要起两次内核编译进程(各 150 MB)。
  // 现在每份只编一次,编译本身就是校验;放行按名单分开,规则里 rule_set 本来就能列多个标签,效果不变
  const compileList = async (list, parsed) => {
    const compiled = { sets: [], blocks: [], allow: [], allowImportant: [] }
    for (const [kind, label] of [['blockImportant', 'important'], ['block', 'block'], ['allow', 'allow'], ['allowImportant', 'allow-important']]) {
      for (const [index, { source, regex }] of parsed.sources[kind].entries()) {
        const set = await compile(`${list.id}-${label}${index ? `-${index + 1}` : ''}`, source, regex)
        compiled.sets.push(set)
        if (kind.startsWith('block')) compiled.blocks.push({ tag: set.tag, listId: list.id, name: list.name, important: kind === 'blockImportant' })
        else compiled[kind].push(set.tag)
      }
    }
    return compiled
  }
  const parsed = []
  const missing = []
  const forceAll = force === true
  const forceListId = typeof force === 'string' ? force : ''
  let total = 0
  for (const list of settings.lists.filter((l) => l.enabled)) {
    let entry = state[list.id]
    let body
    const refresh = forceAll || list.id === forceListId
    try {
      if (!refresh && entry?.url === list.url && entry.path && await ctx.exists(entry.path)) body = await ctx.readFile(entry.path)
      else if (!refresh && entry?.failedUrl === list.url && !retryDue({ id: list.id })) {
        missing.push({ id: list.id, name: list.name, error: entry.error || '' })
        continue
      } else body = (await fetchRuleList(fetchImpl, list.url)).toString('utf8')
      const result = await parseListInWorker(body)
      if (!result.count) throw new Error('名单没有可用的 DNS 规则（不接受网页或空正文）')
      total += result.count
      if (total > 400000) throw new Error('过滤规则总数超过 40 万条,请减少名单')
      const hash = contentKey(body)
      // 先编译(即校验)再落盘、记状态:编不过的名单不会顶掉上一份
      const compiled = await compileList(list, result)
      const path = `${dir}/${list.id}-${hash}.txt`
      await ctx.writeFile(path, body)
      entry = { url: list.url, path, hash, count: result.count, unsupported: result.unsupported, unsupportedExamples: result.unsupportedExamples, updatedAt: !refresh && entry?.hash === hash ? entry.updatedAt : now(), error: '' }
      state[list.id] = entry
      parsed.push({ count: result.count, compiled })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state[list.id] = { ...entry, error: message, failedAt: now(), failedUrl: list.url }
      store.setRaw(FILTER_LIST_STATE, JSON.stringify(state))
      // Keep the last known good data. 本地也没有的:点名更新的(「更新名单」按钮、定时更新)报错给人看;部署时的先跳过(见 MISSING_RETRY_MS)
      if (entry?.url !== list.url || !entry.path || !(await ctx.exists(entry.path))) {
        if (refresh) throw new Error(`${list.name}: ${message}`)
        missing.push({ id: list.id, name: list.name, error: message })
        continue
      }
      const result = await parseListInWorker(await ctx.readFile(entry.path))
      parsed.push({ count: result.count, compiled: await compileList(list, result) })
    }
  }
  if (parsed.reduce((sum, p) => sum + p.count, 0) > 400000) throw new Error('过滤规则总数超过 40 万条,请减少名单')
  const artifact = { key: filterKey(settings), sets: [], blocks: [], allow: [], allowImportant: [], userAllow: [], hashes, builtAt: now(), ...(missing.length ? { missing } : {}) }
  for (const { compiled } of parsed) for (const kind of ['sets', 'blocks', 'allow', 'allowImportant']) artifact[kind].push(...compiled[kind])
  if (settings.allowDomains.length) {
    const userAllow = await compile('user-allow', JSON.stringify({ version: 4, rules: settings.allowDomains.map(allowDomainCondition) }), false)
    artifact.sets.push(userAllow)
    artifact.userAllow.push(userAllow.tag)
  }
  store.setRaw(FILTER_LIST_STATE, JSON.stringify(state))
  store.setRaw(DNS_FILTER_RUNTIME, JSON.stringify(artifact))
  return artifact
}
