// 客户端配置(Open-Box App 的「导入全部配置」,方案 docs/superpowers/specs/2026-09-27-client-apps-design.md §5):
// 手机按这台路由器的节点和分流规则自己上网,不经路由器。
//
// 不另写一套生成器:部署用的那个入口(api/deploy-runner.mjs 的 buildCurrentConfig)带上 clientProfilePatch 生成一份,
// 再用 toClientTemplate 改写成客户端模板。路由器自己的配置代码一行没动,路由器配置逐字不变由构造保证。
// 模板里没有入站 / experimental / log:这些由客户端按平台补(clients/core/obclient 的 BuildFullConfig)。
import { isFlipBypassTag, isFlipNeedTag, isFlipTag } from './flip.mjs'
import { isNodeDirectTag } from './direct-hosts.mjs'

// 客户端的 FakeIP 段:不能和路由器的 198.19.0.0/16 重叠(和 A 模式同一个段,见 clients/core/obclient)
export const CLIENT_FAKEIP_V4 = '198.18.0.0/16'
// 客户端内核工作目录下的相对路径:规则集、热切换开关文件
export const CLIENT_RULESET_DIR = 'rulesets'
export const CLIENT_FLIP_DIR = 'flip'
export const CLIENT_CACHE_FILE = 'cache.db'

// 生成前盖在档案上的补丁(浅合并,嵌套的对象整份给):关掉只在路由器上成立的东西
export const clientProfilePatch = (profile = {}) => {
  const dns = (profile && profile.dns) || {}
  return {
    // 手机上没有局域网终端:终端分流、共享网络入站、入口旁路都不要
    clientRoutes: [],
    servers: [],
    directBypass: false,
    // IPv6 先一律关(手机的 v6 由系统管,v4 进隧道),和 A 模式一样
    ipv6: false,
    // 没有 nft:不开 auto_redirect,配置里就不会出现入口旁路 / 白名单那几份动态集
    tun: { ...((profile && profile.tun) || {}), autoRedirect: false },
    dns: {
      ...dns,
      // 路由器的 dnsmasq 转发、「禁用」模式在手机上都没有意义:手机上的查询一律进内核
      mode: 'hijack',
      // DNS 重写靠面板进程在 127.0.0.1:7854 开的服务,手机上没有;域名过滤的名单编在路由器上,先不带
      rewrite: { ...(dns.rewrite || { rules: [] }), enabled: false },
      filter: { ...(dns.filter || {}), enabled: false },
    },
  }
}

// 路由器配置 → 客户端模板。
//   selections:路由器此刻各 selector 的选择(客户端的默认值跟它走,之后客户端自己的选择由 cache_file 记住)
//   flagState:热切换开关此刻开没开({ tag: bool },system/flip-files.mjs 的 flipTargetState)
//   flagSelectors:开关 tag → 站点集名字(客户端切站点集出口后按出口是不是直连改写开关文件)
// 返回 { config, flags: [{ tag, selector, on }], ruleSets: [tag] }
export const toClientTemplate = (config, { selections = {}, flagState = {}, flagSelectors = {} } = {}) => {
  const out = structuredClone(config)
  delete out.inbounds
  delete out.experimental
  delete out.log

  for (const outbound of out.outbounds || []) {
    const chosen = selections[outbound.tag]
    if (outbound.type === 'selector' && Array.isArray(outbound.outbounds) && outbound.outbounds.includes(chosen)) outbound.default = chosen
  }

  // DNS:直连侧改用手机当前网络的系统 DNS(路由器那边填的直连上游可能是局域网地址,出门就不通);
  // FakeIP 换成客户端的段
  const dns = out.dns || {}
  dns.servers = (dns.servers || []).map((server) => {
    if (server && server.tag === 'dns-direct') return { type: 'local', tag: 'dns-direct' }
    if (server && server.type === 'fakeip') return { ...server, inet4_range: CLIENT_FAKEIP_V4 }
    return server
  })

  const route = out.route || {}
  route.auto_detect_interface = true
  // 入站上面整段删了:只认路由器入站的规则(劫持模式下 dns-in 收到的一律当 DNS,GitHub #550)在手机上永远不命中,一起去掉
  const routerInbounds = new Set((config.inbounds || []).map((i) => i && i.tag).filter(Boolean))
  if (Array.isArray(route.rules)) {
    route.rules = route.rules.filter((r) => !(r && Array.isArray(r.inbound) && r.inbound.length && !r.invert && r.inbound.every((t) => routerInbounds.has(t))))
  }
  const flags = []
  const ruleSets = []
  for (const entry of route.rule_set || []) {
    if (isFlipBypassTag(entry.tag) || isFlipNeedTag(entry.tag)) {
      // 入口旁路 / 白名单的动态集只在 auto_redirect 下生成;补丁关掉了它,出现就是补丁漏了
      throw new Error(`客户端配置里不该有入口动态集:${entry.tag}`)
    }
    if (isFlipTag(entry.tag)) {
      entry.path = `${CLIENT_FLIP_DIR}/${entry.tag}.json`
      flags.push({ tag: entry.tag, selector: flagSelectors[entry.tag] || '', on: Boolean(flagState[entry.tag]) })
    } else if (isNodeDirectTag(entry.tag)) {
      // 订阅和节点站点直连的两份(source 格式 JSON):App 按节点自己写(engine/client-build.mjs 回的 ruleFiles),不从路由器下载
      entry.path = `${CLIENT_RULESET_DIR}/${entry.tag}.json`
    } else if (entry.type === 'local') {
      entry.path = `${CLIENT_RULESET_DIR}/${entry.tag}.srs`
      ruleSets.push(entry.tag)
    }
  }
  return { config: out, flags, ruleSets }
}
