import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCurrentConfig, fetchSelections, resolveSelections, dnsClassesFlipped, firstLayerChanged } from './deploy-runner.mjs'
import { parseSubscription } from '../engine/subscription.mjs'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { configMetaPath } from '../system/deploy.mjs'

const memStore = () => {
  let snap = {}
  return { getSelectionsSnapshot: () => snap, setSelectionsSnapshot: (m) => { snap = m }, snap: () => snap }
}

test('resolveSelections:内核在跑就用它的选择并存快照;读不到就退回快照;没快照就空', () => {
  const store = memStore()
  assert.deepEqual(resolveSelections(store, { Google: '美国-手动', 其他: '香港-手动' }), { Google: '美国-手动', 其他: '香港-手动' })
  assert.deepEqual(store.snap(), { Google: '美国-手动', 其他: '香港-手动' })
  assert.deepEqual(resolveSelections(store, {}), { Google: '美国-手动', 其他: '香港-手动' })
  assert.deepEqual(resolveSelections(memStore(), {}), {})
  // 老的假 store 没有这两个方法也不会炸
  assert.deepEqual(resolveSelections({}, {}), {})
})

test('fetchSelections:内核没起来（fetch 抛错 / 非 2xx）返回空对象', async () => {
  assert.deepEqual(await fetchSelections(async () => { throw new Error('ECONNREFUSED') }, 's'), {})
  assert.deepEqual(await fetchSelections(async () => ({ ok: false }), 's'), {})
  assert.deepEqual(await fetchSelections(async () => ({ ok: true, json: async () => ({ proxies: { Google: { now: '美国-手动' }, 节点A: { type: 'VLESS' } } }) }), 's'), { Google: '美国-手动' })
})

test('withDeployLock:别的进程持锁且活着就等它释放;锁过期或进程已死就直接接管;自己用完释放', async () => {
  const { withDeployLock } = await import('./deploy-runner.mjs')
  const m = new Map()
  const store = { getRaw: (k) => (m.has(k) ? m.get(k) : null), setRaw: (k, v) => m.set(k, v), delRaw: (k) => m.delete(k) }
  let t = 1000
  const now = () => t
  const sleeps = []
  const sleep = async (ms) => { sleeps.push(ms); t += ms; if (sleeps.length === 3) m.delete('openbox/deploy-lock') }
  // 另一个活着的进程(pid 999)持锁 → 等到它释放(第 3 次 sleep 时释放)
  m.set('openbox/deploy-lock', JSON.stringify({ pid: 999, at: 1000 }))
  const r = await withDeployLock(store, async () => 'done', { sleep, now, pid: 1, alive: () => true })
  assert.equal(r, 'done')
  assert.equal(sleeps.length, 3)
  assert.ok(!m.has('openbox/deploy-lock'), '用完要释放')
  // 锁是死进程留下的 → 不等
  m.set('openbox/deploy-lock', JSON.stringify({ pid: 999, at: t }))
  const calls = []
  await withDeployLock(store, async () => calls.push(JSON.parse(m.get('openbox/deploy-lock')).pid), { sleep, now, pid: 1, alive: () => false })
  assert.deepEqual(calls, [1])
  // 等太久 → 抛错,不无限等
  m.set('openbox/deploy-lock', JSON.stringify({ pid: 999, at: t }))
  await assert.rejects(() => withDeployLock(store, async () => 'x', { sleep: async (ms) => { t += ms }, now, pid: 1, alive: () => true, waitMs: 2000 }), /另一个部署/)
})

test('选择即默认:代理页挑的出口写进档案当站点集 / 兜底的 default;内置直连按占位符存;没变化不写', async () => {
  const { persistSelectionsAsDefaults } = await import('./deploy-runner.mjs')
  const writes = []
  const profile = { routing: { fallbackName: '其他', fallbackDefault: 'proxy', policies: [
    { name: '国外', rulesets: ['geosite-gfw'] },
    { name: '国内', default: 'direct', rulesets: ['geosite-cn'] },
  ] } }
  const store = { getProfile: () => profile, getGroups: () => [], setProfile: (patch) => writes.push(patch) }
  // 国外 → 香港-手动;兜底 其他 → 直连(内置,存成 'direct');国内 已是 direct 不动
  assert.equal(persistSelectionsAsDefaults(store, { '国外': '香港-手动', '其他': '直连', '国内': '直连', '香港-手动': 'WFOS-HK | 香港-03' }), true)
  assert.equal(writes.length, 1)
  const r = writes[0].routing
  assert.equal(r.policies.find((p) => p.name === '国外').default, '香港-手动')
  assert.equal(r.policies.find((p) => p.name === '国内').default, 'direct')
  assert.deepEqual(r.policies.find((p) => p.name === '国内').rulesets, ['geosite-cn'], '其它字段原样保留')
  assert.equal(r.fallbackDefault, 'direct')
  // 再来一次同样的选择:没有变化就不写档案
  const profile2 = { routing: writes[0].routing }
  const store2 = { getProfile: () => profile2, getGroups: () => [], setProfile: (patch) => writes.push(patch) }
  assert.equal(persistSelectionsAsDefaults(store2, { '国外': '香港-手动', '其他': '直连' }), false)
  assert.equal(writes.length, 1)
  // 空选择 / 没有 setProfile 的 store 都安静返回
  assert.equal(persistSelectionsAsDefaults(store2, {}), false)
  assert.equal(persistSelectionsAsDefaults({ getProfile: () => profile2 }, { '国外': 'x' }), false)
})

test('dnsClassesFlipped:站点集在直连 / 代理之间翻面才算 DNS 规则过期,换代理线路不算', async () => {
  const paths = createPaths('/opt/open-box')
  const routing = { fallbackDefault: 'proxy', policies: [{ name: '国内', default: 'direct', rulesets: ['geosite-cn'] }] }
  const store = { getProfile: () => ({ routing }), getGroups: () => [] }
  const meta = {
    dnsMode: 'dnsmasq',
    dnsPolicyMembers: ['直连', '香港-自动', '美国-自动', '拒绝'],
    dnsPolicyClasses: { 国内: 'direct', 其他: 'proxy' },
  }
  const ctx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(meta) } })
  // 兜底从香港换到美国:两边都还是"走代理",dns.rules 照旧能用,不重新生成
  assert.equal(await dnsClassesFlipped(ctx, paths, store, { 其他: '美国-自动' }), false)
  // 兜底切到直连:翻面了,磁盘上那份 dns.rules 的 final 还指着代理侧解析器
  assert.equal(await dnsClassesFlipped(ctx, paths, store, { 其他: '直连' }), true)
  // 走直连的站点集切到节点组:同样翻面
  assert.equal(await dnsClassesFlipped(ctx, paths, store, { 国内: '香港-自动' }), true)
  // 档案里新加、还没部署过的站点集不算数(不能顺带把没生效的设置应用出去)
  const store2 = { getProfile: () => ({ routing: { ...routing, policies: [...routing.policies, { name: '新加的', default: 'direct', rulesets: ['geosite-x'] }] } }), getGroups: () => [] }
  assert.equal(await dnsClassesFlipped(ctx, paths, store2, { 其他: '香港-自动' }), false)
  // 没有元数据(还没部署过 / 老版本升上来)就不动
  assert.equal(await dnsClassesFlipped(createMockContext({}), paths, store, { 其他: '直连' }), false)
})

// 审查第 10 项:持有者活着就要一直互斥——靠心跳续租,不再"3 分钟一到谁都能进"
test('withDeployLock:持有者按心跳刷新时间戳,另一进程看到锁龄超过 3 分钟但心跳新鲜就继续等;锁带 token,PID 被复用也认得出不是自己的', async () => {
  const { withDeployLock } = await import('./deploy-runner.mjs')
  const m = new Map()
  const store = { getRaw: (k) => (m.has(k) ? m.get(k) : null), setRaw: (k, v) => m.set(k, v), delRaw: (k) => m.delete(k) }
  let t = 1000
  const now = () => t
  const beats = []
  const setIntervalImpl = (fn) => { beats.push(fn); return { unref() {} } }
  const cleared = []
  const clearIntervalImpl = (h) => cleared.push(h)
  // 持有者(pid 101)跑一个"超过 3 分钟"的部署,期间心跳两次
  let release
  const holding = withDeployLock(store, () => new Promise((r) => { release = r }), { now, pid: 101, alive: () => true, setIntervalImpl, clearIntervalImpl })
  await new Promise((r) => setImmediate(r))
  const first = JSON.parse(m.get('openbox/deploy-lock'))
  assert.equal(first.pid, 101)
  assert.ok(first.token)
  t += 200_000; beats[0]()                       // 3 分 20 秒后心跳,at 刷新
  assert.equal(JSON.parse(m.get('openbox/deploy-lock')).at, t)
  // 另一进程(pid 202)此刻来抢:锁龄从签发算已超 3 分钟,但心跳新鲜 → 必须等,等到超时报错
  const sleeps = []
  await assert.rejects(
    () => withDeployLock(store, async () => 'stolen', { sleep: async (ms) => { sleeps.push(ms); t += ms }, now, pid: 202, alive: () => true, waitMs: 2000, setIntervalImpl, clearIntervalImpl }),
    /另一个部署（pid 101）/,
  )
  assert.ok(sleeps.length > 0)
  // 持有者放手后再抢就能进;持有者退出时清了心跳、删了锁
  release('done')
  assert.equal(await holding, 'done')
  assert.equal(cleared.length, 1)
  assert.ok(!m.has('openbox/deploy-lock'))
  // PID 复用:锁上是 pid 202 的旧 token,新的 pid 202 进程不会把它当自己的——持有者已死就接管
  m.set('openbox/deploy-lock', JSON.stringify({ pid: 202, at: t, token: 'stale-token' }))
  const r = await withDeployLock(store, async () => JSON.parse(m.get('openbox/deploy-lock')).token, { now, pid: 202, alive: () => false, setIntervalImpl, clearIntervalImpl })
  assert.notEqual(r, 'stale-token')
})

// 审查第 2 项:停止 / 回滚和部署共用队列
test('runExclusive:排在部署队列里按顺序执行,前一个没完后一个不动', async () => {
  const { runExclusive } = await import('./deploy-runner.mjs')
  const order = []
  let release
  const first = runExclusive(null, () => new Promise((r) => { release = r }).then(() => order.push('first')))
  const second = runExclusive(null, async () => order.push('second'))
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(order, [])
  release()
  await first
  await second
  assert.deepEqual(order, ['first', 'second'])
})

test('firstLayerChanged:只按 IP 分流的站点集从直连切到代理,DNS 分类表看不出来,但入口旁路的集合变了 → 要重新生成（复审 R3）', async () => {
  const paths = createPaths('/opt/open-box')
  const routing = { fallbackDefault: 'direct', policies: [{ name: '国内', default: 'direct', rulesets: ['geoip-cn'] }] }
  const store = { getProfile: () => ({ routing, clientRoutes: [] }), getGroups: () => [{ id: 'g', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }] }
  const meta = {
    dnsMode: 'dnsmasq',
    dnsPolicyMembers: ['直连', '香港-自动', '拒绝'],
    dnsPolicyClasses: { 其他: 'direct' },
    firstLayer: { dnsMode: 'dnsmasq', dnsForward: 'none', dnsForwardReason: '', nativeBypass: { enabled: true, sets: ['geoip-cn'], reason: '', via: 'nft' }, dnsSourceRules: false },
  }
  const ctx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(meta) } })
  // 老判断看不出来
  assert.equal(await dnsClassesFlipped(ctx, paths, store, { 国内: '香港-自动' }), false)
  // 新判断:旁路集合从 [geoip-cn] 变成空 → 变了
  assert.equal(await firstLayerChanged(ctx, paths, store, { 国内: '香港-自动' }), true)
  // 没变(还是直连)→ 不动
  assert.equal(await firstLayerChanged(ctx, paths, store, { 国内: '直连' }), false)
  // 切回来之后再切(direct→proxy→direct):和部署时一致,不动
  assert.equal(await firstLayerChanged(ctx, paths, store, {}), false)
  // 没有元数据 / 老版本没有 firstLayer:不动
  assert.equal(await firstLayerChanged(createMockContext({}), paths, store, { 国内: '香港-自动' }), false)
  assert.equal(await firstLayerChanged(createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify({ ...meta, firstLayer: undefined }) } }), paths, store, { 国内: '香港-自动' }), false)
})

test('firstLayerChanged:屏蔽 QUIC 开着时,纯 IP 站点集翻面也要重新生成(拒绝规则按出口类别插);没开就不因为它重生成', async () => {
  const paths = createPaths('/opt/open-box')
  // 用不进入口旁路的 IP 段,免得被旁路指纹先判出来:只剩「出口类别变了」这一个理由
  const routing = { fallbackDefault: 'direct', policies: [{ name: '内网段', default: 'direct', ipCidr: ['203.0.113.0/24'] }] }
  const groups = [{ id: 'g', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }]
  const { bypassPlanKey, nativeBypassPlan } = await import('../engine/routing-model.mjs')
  const members = ['直连', '香港-自动', '拒绝']
  const planKey = bypassPlanKey(nativeBypassPlan(routing, { members, builtin: { direct: '直连', block: '拒绝', directEnabled: true, blockEnabled: true }, selections: {}, clientRoutes: [], fakeIp: false, dnsMode: 'hijack' }))
  const metaOf = (rejectQuic) => ({
    dnsMode: 'hijack', dnsPolicyMembers: members, dnsPolicyClasses: { 其他: 'direct' },
    firstLayer: { dnsMode: 'hijack', dnsForward: 'all', nativeBypass: { enabled: false, sets: [] }, nativeBypassPlanned: { sets: [], pending: [] }, nativeBypassPlanKey: planKey, policyClasses: { 内网段: 'direct', 其他: 'direct' }, ipv6: 'off', rejectQuic, dnsSourceRules: false },
  })
  const storeOf = (rejectQuic) => ({ getProfile: () => ({ routing, clientRoutes: [], rejectQuic }), getGroups: () => groups })
  const ctxOf = (rejectQuic) => createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(metaOf(rejectQuic)) } })
  assert.equal(await firstLayerChanged(ctxOf(true), paths, storeOf(true), { 内网段: '香港-自动' }), true, '开着:直连 → 代理要重生成')
  assert.equal(await firstLayerChanged(ctxOf(true), paths, storeOf(true), { 内网段: '直连' }), false, '没翻面不动')
  assert.equal(await firstLayerChanged(ctxOf(false), paths, storeOf(false), { 内网段: '香港-自动' }), false, '没开屏蔽 QUIC:路由里没有按类别插的东西,不用重生成')
})

test('firstLayerChanged / currentBypassPlan:FakeIP 下旁路结论按计划阶段（含 pending）比,不按部署核对后的结果比', async () => {
  const { currentBypassPlan } = await import('./deploy-runner.mjs')
  const paths = createPaths('/opt/open-box')
  const routing = { fallbackDefault: 'direct', policies: [
    { name: '电报', default: '香港-自动', rulesets: ['geoip-telegram'] },
    { name: '国内', default: 'direct', rulesets: ['geoip-cn'] },
  ] }
  const store = { getProfile: () => ({ routing, clientRoutes: [], dns: { split: true, fakeIpForProxy: true } }), getGroups: () => [{ id: 'g', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }], getNodes: () => [] }
  const { bypassPlanKey } = await import('../engine/routing-model.mjs')
  const plan = currentBypassPlan(store, {})
  assert.deepEqual(plan.sets, [])
  assert.deepEqual(plan.pending.map((x) => x.policy), ['国内'])
  // 部署时核对通过:实际 nativeBypass 开了 geoip-cn,但计划阶段记的是 pending(指纹相同)→ 选择没变就不重生成
  const meta = {
    dnsMode: 'dnsmasq', dnsPolicyMembers: ['直连', '香港-自动', '拒绝'], dnsPolicyClasses: { 其他: 'direct' },
    firstLayer: { dnsMode: 'dnsmasq', dnsForward: 'none', nativeBypass: { enabled: true, sets: ['geoip-cn'], reason: '', via: 'nft' }, nativeBypassPlanned: { sets: [], pending: ['国内'] }, nativeBypassPlanKey: bypassPlanKey(plan), dnsSourceRules: false },
  }
  const ctx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(meta) } })
  assert.equal(await firstLayerChanged(ctx, paths, store, {}), false)
  // 「电报」切到直连:前面没有带 IP 条件的代理站点集了,geoip-cn 不再 pending → 变了
  assert.equal(await firstLayerChanged(ctx, paths, store, { 电报: '直连' }), true)
  // 「国内」切到代理:候选没了 → 变了
  assert.equal(await firstLayerChanged(ctx, paths, store, { 国内: '香港-自动' }), true)
})

test('firstLayerChanged（第四轮 T2）:pending 的核对对象从一条变成两条（前置乙 直连 → 代理）→ 指纹不同 → 要重新生成;切回来 → 不动', async () => {
  const { currentBypassPlan } = await import('./deploy-runner.mjs')
  const { bypassPlanKey } = await import('../engine/routing-model.mjs')
  const paths = createPaths('/opt/open-box')
  const groups = [{ id: 'g', name: '任意出口甲', type: 'selector', mode: 'static', members: ['n'] }]
  const routing = { fallbackDefault: 'direct', policies: [
    { name: '前置甲', ipCidr: ['1.2.3.0/24'], default: '任意出口甲' },
    { name: '前置乙', ipCidr: ['9.9.9.0/24'], default: 'direct' },
    { name: '后置直连', rulesets: ['geoip-audit'], default: 'direct' },
  ] }
  const store = { getProfile: () => ({ routing, clientRoutes: [], dns: { split: true, mode: 'dnsmasq' } }), getGroups: () => groups, getNodes: () => [] }
  const before = currentBypassPlan(store, {})
  assert.equal(before.pending[0].against.length, 1)
  const meta = {
    dnsMode: 'dnsmasq', dnsPolicyMembers: ['直连', '任意出口甲', '拒绝'], dnsPolicyClasses: { 其他: 'direct' },
    firstLayer: { dnsMode: 'dnsmasq', dnsForward: 'none', dnsForwardPlanned: 'none', nativeBypass: { enabled: true, sets: ['geoip-audit'] }, nativeBypassPlanned: { sets: [], pending: ['后置直连'] }, nativeBypassPlanKey: bypassPlanKey(before), ipv6: 'node', dnsSourceRules: false },
  }
  const ctx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(meta) } })
  assert.equal(await dnsClassesFlipped(ctx, paths, store, { 前置乙: '任意出口甲' }), false)   // DNS 表看不出来
  assert.equal(await firstLayerChanged(ctx, paths, store, { 前置乙: '任意出口甲' }), true)   // 指纹变了
  assert.equal(await firstLayerChanged(ctx, paths, store, { 前置乙: '直连' }), false)
  assert.equal(await firstLayerChanged(ctx, paths, store, {}), false)
  // 升级前的元数据(没有指纹)+ 有 pending 的计划:光比名字看不出核对对象的变化,宁可多重生成一次(之后就带指纹)
  const oldMeta = { ...meta, firstLayer: { ...meta.firstLayer, nativeBypassPlanKey: undefined } }
  const oldCtx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(oldMeta) } })
  assert.equal(await firstLayerChanged(oldCtx, paths, store, { 前置乙: '任意出口甲' }), true)
  // 没有 pending 的老元数据照旧比集合,不多重生成
  const plainStore = { ...store, getProfile: () => ({ routing: { fallbackDefault: 'direct', policies: [routing.policies[2]] }, clientRoutes: [], dns: { split: true, mode: 'dnsmasq' } }) }
  const plainMeta = { ...meta, firstLayer: { ...meta.firstLayer, nativeBypassPlanKey: undefined, nativeBypassPlanned: { sets: ['geoip-audit'], pending: [] } } }
  assert.equal(await firstLayerChanged(createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(plainMeta) } }), paths, plainStore, {}), false)
})

test('firstLayerChanged（第四轮 T3）:代理 v6 降为 IPv4 时,纯 IP 站点集 直连 → 代理 → 直连 每次都要重新生成（v6 保护跟着变）;node 模式不看它', async () => {
  const paths = createPaths('/opt/open-box')
  const groups = [{ id: 'g', name: '任意出口甲', type: 'selector', mode: 'static', members: ['n'] }]
  const routing = { fallbackDefault: 'direct', policies: [{ name: '纯IP策略', ipCidr: ['2606:4700::/32'], default: 'direct' }] }
  const store = { getProfile: () => ({ ipv6: true, ipv6Proxy: 'ipv4', routing, clientRoutes: [], dns: { split: true, mode: 'dnsmasq' } }), getGroups: () => groups, getNodes: () => [] }
  const metaFor = (classes, ipv6) => ({
    dnsMode: 'dnsmasq', dnsPolicyMembers: ['直连', '任意出口甲', '拒绝'], dnsPolicyClasses: { 其他: 'direct' },
    firstLayer: { dnsMode: 'dnsmasq', dnsForward: 'none', dnsForwardPlanned: 'none', ipv6, nativeBypass: { enabled: false, sets: [] }, nativeBypassPlanned: { sets: [], pending: [] }, nativeBypassPlanKey: JSON.stringify({ sets: [], pending: [], fakeIp: false }), policyClasses: classes, dnsSourceRules: false },
  })
  const directCtx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(metaFor({ 纯IP策略: 'direct', 其他: 'direct' }, 'ipv4')) } })
  assert.equal(await dnsClassesFlipped(directCtx, paths, store, { 纯IP策略: '任意出口甲' }), false)
  assert.equal(await firstLayerChanged(directCtx, paths, store, { 纯IP策略: '任意出口甲' }), true)   // direct → proxy:要加 v6 拒绝
  assert.equal(await firstLayerChanged(directCtx, paths, store, {}), false)
  const proxyCtx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(metaFor({ 纯IP策略: 'proxy', 其他: 'direct' }, 'ipv4')) } })
  assert.equal(await firstLayerChanged(proxyCtx, paths, store, { 纯IP策略: '直连' }), true)        // proxy → direct:要撤 v6 拒绝
  assert.equal(await firstLayerChanged(proxyCtx, paths, store, { 纯IP策略: '任意出口甲' }), false)
  // 升级前的元数据(ipv4 模式但没有出口类别表):不知道保护落在哪,宁可多重生成一次
  const noClasses = metaFor(undefined, 'ipv4')
  assert.equal(await firstLayerChanged(createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(noClasses) } }), paths, store, {}), true)
  // node 模式(生成时没有 v6 保护):这种切换不需要重新生成
  const nodeStore = { ...store, getProfile: () => ({ ...store.getProfile(), ipv6Proxy: 'node' }) }
  const nodeCtx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(metaFor({ 纯IP策略: 'direct', 其他: 'direct' }, 'node')) } })
  assert.equal(await firstLayerChanged(nodeCtx, paths, nodeStore, { 纯IP策略: '任意出口甲' }), false)
})

test('regenerateIfPlanChanged:判断没变就什么都不做;变了就真的走 runDeploy（调用方不必再各自判断）', async () => {
  const { regenerateIfPlanChanged } = await import('./deploy-runner.mjs')
  const paths = createPaths('/opt/open-box')
  const routing = { fallbackDefault: 'direct', policies: [{ name: '国内', default: 'direct', rulesets: ['geoip-cn'] }] }
  const store = { getProfile: () => ({ routing, clientRoutes: [], dns: { split: true, mode: 'dnsmasq' } }), getGroups: () => [{ id: 'g', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }], getNodes: () => [] }
  const meta = { dnsMode: 'dnsmasq', dnsPolicyMembers: ['直连', '香港-自动', '拒绝'], dnsPolicyClasses: { 其他: 'direct' }, firstLayer: { dnsMode: 'dnsmasq', dnsForward: 'none', dnsForwardPlanned: 'none', nativeBypass: { enabled: true, sets: ['geoip-cn'] }, nativeBypassPlanned: { sets: ['geoip-cn'], pending: [] }, nativeBypassPlanKey: JSON.stringify({ sets: ['geoip-cn'], pending: [], fakeIp: false }), ipv6: 'off', dnsSourceRules: false } }
  const ctx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(meta) } })
  const logs = []
  const deployed = []
  const deploy = async (args) => { deployed.push(args); return { ok: true, stage: 'running', message: '' } }
  const same = await regenerateIfPlanChanged({ store, ctx, paths, selections: {}, log: (m) => logs.push(m), deploy })
  assert.deepEqual(same, { regenerated: false, reason: '' })
  assert.equal(deployed.length, 0)
  const changed = await regenerateIfPlanChanged({ store, ctx, paths, selections: { 国内: '香港-自动' }, log: (m) => logs.push(m), deploy })
  assert.equal(changed.regenerated, true)
  assert.match(changed.reason, /第一层计划/)
  assert.equal(deployed.length, 1)   // 判断变了之后真的执行了部署
  assert.equal(deployed[0].store, store)
  assert.ok(logs.some((m) => m.includes('重新生成配置')))
})

// 故障转移的运行映射(写进 config.meta.json,后台管理器和 App 都按它)必须和配置同一次生成:以前另调一次 emitUserGroups、
// 只传了订阅节点,页签里放了链式代理时映射说「单节点 / 空」,配置里却是子组,管理器切换就切错
test('buildCurrentConfig:故障转移页签里有链式代理时,映射和配置对得上', () => {
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  const node = parseSubscription('ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@hk.example.com:8388#香港01').nodes[0]
  store.setSubscriptions([{ id: 'sub', name: '机场', url: 'https://sub.example/x' }])
  store.setNodes([{ ...node, subscriptionId: 'sub', tag: '香港-01' }])
  store.setGroups([{ id: 'fo', name: '故转', type: 'failover', lanes: [{ id: 'm', members: ['香港-01', '链-香港'] }, { id: 'b', members: ['链-香港'] }] }])
  store.setProfile({ chainProxies: [{ id: 'c1', name: '链-香港', upstream: '香港-01', link: 'socks5://u:p@1.2.3.4:1080#x' }] })
  const { config, failover } = buildCurrentConfig(store, [], { rulesetDir: '/tmp/rs', geoDir: '/tmp/geo' })
  const lanes = failover.find((f) => f.tag === '故转').lanes
  assert.deepEqual(lanes.map((l) => [l.mode, l.ref]), [['urltest', '__fo:fo:m'], ['single', '链-香港']])
  assert.deepEqual(lanes[0].valid, ['香港-01', '链-香港'])
  const sub = config.outbounds.find((o) => o.tag === '__fo:fo:m')
  assert.deepEqual(sub.outbounds, ['香港-01', '链-香港'])
  assert.ok(config.outbounds.find((o) => o.tag === '故转').outbounds.includes('链-香港'))
})

// GitHub #518:启动时内核还不认的节点(之前存下的 / 手动加的):跳过它们照常启动,提示是哪几个、为什么
test('runDeploy:校验报出是某个节点时,把内核不认的节点都找出来、跳过它们重新部署;成功带警告,跳过名单记进生成输入', async () => {
  const { runDeploy } = await import('./deploy-runner.mjs')
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  const paths = createPaths('/opt/open-box')
  store.setGroups([])
  store.setProfile({ routing: { fallbackDefault: 'direct', policies: [{ id: 'cn', name: '国内', default: 'direct', rulesets: ['geosite-cn'] }] }, clientRoutes: [], dns: { split: true, mode: 'off' }, tun: { autoRedirect: false } })
  store.setSubscriptions([{ id: 's1', name: '机场', urls: ['https://example.com/sub'], enabled: true }])
  const node = (tag, method) => ({ tag, originalTag: tag, type: 'shadowsocks', server: 'a.example.com', server_port: 8388, fields: { method, password: 'p' }, source: 'clash', subscriptionId: 's1' })
  store.setNodes([node('好节点', 'aes-256-gcm'), node('坏节点', 'nope'), node('坏节点二', 'nope')])
  const ctx = createMockContext({ files: { [paths.singbox]: 'x', '/dev/net/tun': '', '/etc/resolv.conf': 'nameserver 223.5.5.5\n', [`${paths.geoDir}/geosite-cn.srs`]: 'SRS' }, execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } } })
  const exec = ctx.exec
  let checks = 0
  ctx.exec = async (cmd, args = []) => {
    if (cmd === paths.singbox && args[0] === 'check') {
      checks += 1
      const config = JSON.parse(ctx.files[args[2]])
      const i = (config.outbounds || []).findIndex((o) => o.method === 'nope')
      if (i >= 0) return { code: 1, stdout: '', stderr: `FATAL[0000] initialize outbound[${i}]: unknown method: nope\n` }
      return { code: 0, stdout: '', stderr: '' }
    }
    return exec(cmd, args)
  }
  const fetchImpl = async () => new Response('{}', { status: 404 })
  const r = await runDeploy({ store, ctx, paths, fetchImpl, lateWatch: false })
  assert.equal(r.ok, true, `${r.stage}: ${r.message}`)
  assert.match(r.warning, /有 2 个节点内核不认,这次启动跳过了它们:「坏节点」\(订阅「机场」\):unknown method: nope;「坏节点二」\(订阅「机场」\):unknown method: nope/)
  const config = JSON.parse(ctx.files[paths.configPath])
  const tags = config.outbounds.map((o) => o.tag)
  assert.ok(tags.includes('好节点') && !tags.includes('坏节点') && !tags.includes('坏节点二'), tags.join(','))
  const meta = JSON.parse(ctx.files[configMetaPath(paths)])
  assert.deepEqual(meta.buildInputs.skipNodes, ['坏节点', '坏节点二'], '在线更新节点时照样跳过')
  assert.ok(checks <= 6, `一次把坏节点找全,不是一个个重新部署:check ${checks} 次`)
})


// 规则库换新之后,站点集 / 前置自定义分流里引用着、随包规则库已经没有的分类(上游删掉的):跳过那几项照常启动,提示是哪几个
test('runDeploy:站点集引用的规则集随包规则库里已经没有了,跳过那几项照常启动并提示;没登记规则库清单时照旧报缺', async () => {
  const { runDeploy } = await import('./deploy-runner.mjs')
  const { setAvailableGeoTags } = await import('../engine/routing-model.mjs')
  const setup = () => {
    const m = new Map()
    const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
    const paths = createPaths('/opt/open-box')
    store.setGroups([])
    store.setProfile({
      routing: {
        fallbackDefault: 'direct',
        custom: { rules: [{ type: 'geosite', value: 'whatsapp@ads', outbound: 'block' }, { type: 'domain', value: 'a.example.com', outbound: 'direct' }] },
        policies: [
          { id: 'cn', name: '国内', default: 'direct', rulesets: ['geosite-cn', 'geosite-github@ads'] },
          { id: 'gh', name: 'GitHub 广告', default: 'block', rulesets: ['geosite-github-copilot@ads'] },
          { id: 'off', name: '停用的', enabled: false, default: 'block', rulesets: ['geosite-nope@ads'] },
        ],
      },
      clientRoutes: [], dns: { split: true, mode: 'off' }, tun: { autoRedirect: false },
    })
    store.setNodes([])
    const ctx = createMockContext({ files: { [paths.singbox]: 'x', '/dev/net/tun': '', '/etc/resolv.conf': 'nameserver 223.5.5.5\n', [`${paths.geoDir}/geosite-cn.srs`]: 'SRS' }, execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } } })
    return { store, paths, ctx }
  }
  const fetchImpl = async () => new Response('{}', { status: 404 })
  try {
    setAvailableGeoTags(['geosite-cn', 'geoip-cn'])
    const { store, paths, ctx } = setup()
    const r = await runDeploy({ store, ctx, paths, fetchImpl, lateWatch: false })
    assert.equal(r.ok, true, `${r.stage}: ${r.message}`)
    assert.match(r.warning, /规则库更新后已经没有这些规则集,用到它们的那几项这次跳过了:geosite-whatsapp@ads\(「前置自定义分流」\)、geosite-github@ads\(「国内」\)、geosite-github-copilot@ads\(「GitHub 广告」\)。/)
    assert.doesNotMatch(r.warning, /nope/, '停用的站点集不进配置,不提示')
    const text = ctx.files[paths.configPath]
    assert.doesNotMatch(text, /github|whatsapp/, '缺的规则集和只剩它的站点集都不进配置')
    const config = JSON.parse(text)
    assert.ok(config.route.rule_set.some((s) => s.tag === 'geosite-cn'))
    assert.ok(config.route.rules.some((rule) => (rule.domain || []).includes('a.example.com')), '同一个前置分流里别的行照常')
    // 没登记清单(读不到):和以前一样报缺,不悄悄改配置
    setAvailableGeoTags(null)
    const again = setup()
    const failed = await runDeploy({ store: again.store, ctx: again.ctx, paths: again.paths, fetchImpl, lateWatch: false })
    assert.equal(failed.ok, false)
    assert.match(failed.message, /安装包缺少规则集 geosite-/)
  } finally {
    setAvailableGeoTags(null)
  }
})

test('runDeploy:域名过滤名单下不来不拦内核启动(GitHub #562 #565):跳过那份、带黄色提示;过滤整体准备不好(内存不够)时这次关着过滤生成,记进生成输入', async () => {
  const { runDeploy } = await import('./deploy-runner.mjs')
  const setup = (files = {}) => {
    const m = new Map()
    const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
    const paths = createPaths('/opt/open-box')
    store.setGroups([])
    // 0.0.0.0 不用联网就被地址检查挡下:模拟「名单下不来」
    store.setProfile({ routing: { fallbackDefault: 'direct', policies: [] }, clientRoutes: [], dns: { split: true, mode: 'off', filter: { enabled: true, allowDomains: [], lists: [{ id: 'anti-ad', name: 'anti-AD', url: 'http://0.0.0.0/anti-ad.txt', enabled: true }] } }, tun: { autoRedirect: false } })
    store.setNodes([])
    const ctx = createMockContext({ files: { [paths.singbox]: 'x', '/dev/net/tun': '', '/etc/resolv.conf': 'nameserver 223.5.5.5\n', ...files }, execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } } })
    return { store, paths, ctx }
  }
  const fetchImpl = async () => new Response('{}', { status: 404 })
  const a = setup()
  const r = await runDeploy({ store: a.store, ctx: a.ctx, paths: a.paths, fetchImpl, lateWatch: false })
  assert.equal(r.ok, true, `${r.stage}: ${r.message}`)
  assert.match(r.warning, /域名过滤名单「anti-AD」没下载下来\(.+\),这次先不按它过滤,内核照常启动;能连上后在「DNS 设置」点「更新名单」/)
  assert.equal(JSON.parse(a.ctx.files[configMetaPath(a.paths)]).dnsFilter.enabled, true)

  const b = setup({ '/proc/meminfo': 'MemTotal: 997888 kB\nMemAvailable: 100000 kB\n' })
  const low = await runDeploy({ store: b.store, ctx: b.ctx, paths: b.paths, fetchImpl, lateWatch: false })
  assert.equal(low.ok, true, `${low.stage}: ${low.message}`)
  assert.match(low.warning, /域名过滤这次没开\(可用内存只有 98 MB.*\),内核照常启动/)
  const meta = JSON.parse(b.ctx.files[configMetaPath(b.paths)])
  assert.equal(meta.buildInputs.dnsFilterOff, true, '在线更新节点时照样关着生成,和运行中的一致')
  assert.equal(meta.dnsFilter.enabled, false, '右上角照常提示 DNS 设置还没生效')
  assert.doesNotMatch(b.ctx.files[b.paths.configPath], /dns-filter-/)
})
