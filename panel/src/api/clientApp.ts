// Open-Box 客户端(手机 / 电脑 App)和「激活」相关接口的前端封装。
// 对照后端 server/api/{client-app,client-config,activation}.mjs(上游 v0.1.304)。只涉及登录后的 /api/openbox/*
// 接口;App 自己用的 /client/v1/* 公开接口不在面板里调。
//
// 和 openbox.ts 一样走 fetchServerApi,这样 401/403 的处理和面板其余部分一致。
// requestJson 在 openbox.ts 里没有导出,这里照它的行为写了一份(错误体 {error} 优先于 {message}),
// 不去改 openbox.ts,避免和以后从上游同步的内容冲突。
import { saveProfile } from '@/api/openbox'
import { fetchServerApi } from '@/store/auth'

// ---- 通用 ----

const extractErrorMessage = (data: unknown): string => {
  if (!data || typeof data !== 'object') return ''
  if ('error' in data && data.error) return String(data.error)
  if ('message' in data && data.message) return String(data.message)
  return ''
}

const requestJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const response = await fetchServerApi(input, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init?.headers,
    },
    ...init,
  })

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(extractErrorMessage(data) || `request failed: ${response.status}`)
  }

  return data as T
}

// ---- 客户端 App(server/api/client-app.mjs)----

// ---- 地区分流(档案 shareRegions,后端 engine/share-regions.mjs)----
// 共享网络的手机客户端按所在地区决定哪些流量本地直连、哪些回路由器。不进路由器自己的内核配置,改了不用重启内核。
// 没存 / 存了空数组 = 用默认三组(中国大陆 / 港澳 / 其他地区),所以「恢复默认」就是 saveShareRegions([])。

export const SHARE_REGION_RULE_TYPES = [
  'geosite',
  'geoip',
  'domain',
  'domainSuffix',
  'domainKeyword',
  'ipcidr',
  'ruleUrl',
] as const
export type OpenboxShareRuleType = (typeof SHARE_REGION_RULE_TYPES)[number]
// direct = 本地直连;proxy = 回路由器(经共享网络节点,由路由器按自己的规则出去)
export type OpenboxShareAction = 'direct' | 'proxy'

export interface OpenboxShareRule {
  type: OpenboxShareRuleType
  value: string
  action: OpenboxShareAction
}

// 一条 DNS 上游。server 是 IP,或记号 'wan'(= 手机此刻所在网络的系统 DNS,固定 UDP 53)
export interface OpenboxShareDnsUpstream {
  server: string
  protocol: string
  port: number
}

// 直连 / 代理两侧各一条主上游 + 若干备用(并发查,谁先给出 NOERROR 用谁的);设计和路由器的「DNS 上游」一致
export interface OpenboxShareGroupDns {
  direct: string
  directProtocol: string
  directPort: number
  directExtras: OpenboxShareDnsUpstream[]
  proxy: string
  proxyProtocol: string
  proxyPort: number
  proxyExtras: OpenboxShareDnsUpstream[]
}

export interface OpenboxShareRegionGroup {
  // /^[a-z0-9_-]{1,32}$/,组与组之间不能重复
  id: string
  name: string
  description?: string
  // 两位国家代码(大写)
  regions: string[]
  // 不写 = 在这些地区时用这一组;'outside' = 在这些地区之外时用(至少列一个地区)。
  // 「一个地区只能归一组」只在「在这些地区」的组之间查
  regionMatch?: 'inside' | 'outside'
  // 定位不到、或没有任何一组命中时用的组
  default?: boolean
  rules: OpenboxShareRule[]
  // 规则都没命中的流量
  catchAll: OpenboxShareAction
  dns: OpenboxShareGroupDns
}

// 后端校验的上限(engine/share-regions.mjs);后端才是权威,这里只用来在界面上提前限制输入
export const SHARE_REGION_LIMITS = {
  groups: 12,
  rulesPerGroup: 200,
  nameMax: 30,
  descriptionMax: 120,
  ruleUrlMax: 2048,
  id: /^[a-z0-9_-]{1,32}$/,
} as const

// ---- 路由器标识(档案 serverInfo,后端 engine/server-info.mjs)----
// App 里共享网络的节点卡片、本地分流的配置卡片都整张显示它。四个字段都可以空:
//   name    空 = 默认名称(接口 serverInfoDefaults.name,现在是「Open-Box」)
//   icon    图标代码,和节点组图标同一套(国家代码 / globe:* / brand:* / misc:*);空 = App 画 Open-Box 的标志
//   iconSvg 保存时存下的图标 SVG 原文(随包图标索引里没有时才用),以 <svg 开头,最大 64 KB
//   region  两位国家代码(大写);空 = 按出口 IP 自动判
export const SERVER_INFO_NAME_MAX = 40
export interface OpenboxServerInfo {
  name?: string
  icon?: string
  iconSvg?: string
  region?: string
}

// 按出口 IP 判出的国家;没判过时接口回 null
export interface OpenboxEgressCountry {
  ip: string
  country: string
  at: number
}

export interface OpenboxClientAppInfo {
  // 这台路由器的 ID:随机 32 位十六进制,第一次用到时生成,出现在「App 码」里
  routerId: string
  routerName: string
  // IPv4 在前;进 App 码,App 在家时靠它判断「到家了」
  lanAddresses: string[]
  // 家里局域网的 IPv4 网段(192.168.5.0/24 这样)。发给 App 时每组最前面自动带「这些网段 → 回路由器」,只读
  lanSubnets: string[]
  panelPort: number
  // 地区分流现值(没改过就是默认值)/ 是不是用户改过 / 默认值
  shareRegions: OpenboxShareRegionGroup[]
  shareRegionsCustomized: boolean
  defaultShareRegions: OpenboxShareRegionGroup[]
  // 路由器标识:存着的原样(空对象 = 全用默认值);serverInfoDefaults 是默认名称
  serverInfo: OpenboxServerInfo
  serverInfoDefaults: { name: string }
  egressCountry: OpenboxEgressCountry | null
}

export const fetchClientAppInfo = () =>
  requestJson<OpenboxClientAppInfo>('/api/openbox/client-app/info')

// 按出口 IP 判一次国家。出口 IP 没变就直接用上次的;内核没起 / 面板不在路由器上时后端回 503
export const detectEgressCountry = () =>
  requestJson<OpenboxEgressCountry>('/api/openbox/client-app/egress-country', { method: 'POST' })

// 保存地区分流。整份覆盖;传 [] = 恢复默认三组。校验不过后端回 400,message 是英文原因(如 'region CN is in both cn and x')
export const saveShareRegions = (shareRegions: OpenboxShareRegionGroup[]) => saveProfile({ shareRegions })

// 保存路由器标识。整份覆盖(没给的字段就是没有);传 {} = 全用默认
export const saveServerInfo = (serverInfo: OpenboxServerInfo) => saveProfile({ serverInfo })

// ---- 本地分流(客户端配置,server/api/client-config.mjs)----

// 后端的 publicDevice():不带 token 和密钥。lastSyncAt / lastSyncFrom 是后端每次被 App 同步时写的,其余字段不展开。
export interface OpenboxClientDevice {
  id?: string
  lastSyncAt?: number
  lastSyncFrom?: string
  [key: string]: unknown
}

// 出「码」要的全部材料。界面拿去拼二维码 / 复制链接 / 导出文件里的 importCode(三者是同一个码)
export interface OpenboxClientConfigIssue {
  device: OpenboxClientDevice
  // 同步开关(电源图标)。关着时 App 用的公开接口一律回 403 { error: 'disabled' }
  enabled: boolean
  token: string
  // 32 字节密钥:配置用它 AES-256-GCM 加密。属于凭据,不要写日志、不要进导出
  key: string
  routerId: string
  routerName: string
  lanAddresses: string[]
  panelPort: number
}

// 注意:没有码时这个 GET 会让后端现场生成一套(并存库),不是纯读取。
export const fetchClientConfig = () =>
  requestJson<OpenboxClientConfigIssue>('/api/openbox/client-config')

export const setClientConfigEnabled = (enabled: boolean) =>
  requestJson<{ enabled: boolean }>('/api/openbox/client-config/enabled', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })

// 导出文件:配置 + 路由器编出来的规则集(base64)。geosite / geoip 随 App 安装包带,文件里只有摘要。
// 导出文件里要再放一个 importCode(见后端头注释),让手机导入等于扫了码——码的格式由界面按 App 的约定拼,这里不管。
export type OpenboxClientBundle = Record<string, unknown>

export const fetchClientConfigFile = () =>
  requestJson<OpenboxClientBundle>('/api/openbox/client-config/file')

// ---- 内容过滤(规则集和脚本快照存在路由器上,同步到 iOS 后在手机执行)----
// 接口形态取自 v0.1.334 面板的调用。新增 / 启停 / 删除都返回整份最新列表。

export type OpenboxContentFilterDialect =
  | 'surge'
  | 'quantumultx'
  | 'loon'
  | 'shadowrocket'
  | 'stash'

export interface OpenboxContentFilterSet {
  id: string
  name: string
  dialect: OpenboxContentFilterDialect
  sourceUrl?: string
  enabled: boolean
  ruleCount: number
  scriptCount: number
  skipped?: number
  updatedAt: string
  arguments?: { values?: Record<string, unknown> }
}

export interface OpenboxContentFilterList {
  sets: OpenboxContentFilterSet[]
  sha256: string
  size: number
}

export interface OpenboxContentFilterInput {
  id?: string
  name: string
  dialect: OpenboxContentFilterDialect
  sourceUrl?: string
  text?: string
  arguments?: Record<string, unknown>
}

export const fetchContentFilter = () =>
  requestJson<OpenboxContentFilterList>('/api/openbox/content-filter')

export const fetchContentFilterSource = (id: string) =>
  requestJson<{ text: string }>(`/api/openbox/content-filter/${id}/source`)

export const saveContentFilter = (input: OpenboxContentFilterInput) =>
  requestJson<OpenboxContentFilterList>('/api/openbox/content-filter', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const setContentFilterEnabled = (id: string, enabled: boolean) =>
  requestJson<OpenboxContentFilterList>(`/api/openbox/content-filter/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })

export const deleteContentFilter = (id: string) =>
  requestJson<OpenboxContentFilterList>(`/api/openbox/content-filter/${id}`, { method: 'DELETE' })

// ---- 激活(server/api/activation.mjs)----
// 概览页顶栏默认放站点推广;输入内置激活码后顶栏左右两边换成自己填的文字(留空 = 默认的版本号)。
// 状态存在路由器上。后端用 400 回「激活码不对」{ error: 'invalid activation code' } 和「还没激活」{ error: 'not activated' }。

// 两边文字最长 60 个字符(后端 ACTIVATION_TEXT_MAX,超出的会被截掉)
export const ACTIVATION_TEXT_MAX = 60

// 后端 respond():存着的状态(没激活时 left / right 都是空串)+ defaults(两边留空时概览顶栏显示的值,
// 形如「Open-Box v1.2.3」/「sing-box 1.14.1-openbox-tcp15」)
export interface OpenboxActivation {
  activated: boolean
  left: string
  right: string
  defaults: { left: string; right: string }
}

export const fetchActivation = () => requestJson<OpenboxActivation>('/api/openbox/activation')

export const activate = (code: string, left: string, right: string) =>
  requestJson<OpenboxActivation>('/api/openbox/activation', {
    method: 'POST',
    body: JSON.stringify({ code, left, right }),
  })

// 已经激活时改两边的文字,不用再输激活码
export const updateActivationText = (left: string, right: string) =>
  requestJson<OpenboxActivation>('/api/openbox/activation', {
    method: 'PUT',
    body: JSON.stringify({ left, right }),
  })

export const deactivate = () =>
  requestJson<OpenboxActivation>('/api/openbox/activation', { method: 'DELETE' })
