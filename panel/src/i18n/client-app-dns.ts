// 客户端页「地区组 → DNS」页签的文案(对照上游 v0.1.334 的 shareRegionsDns* 键)。
// 自己合并进 i18n,不依赖别的文案文件;DNS 上游弹窗里的其余键沿用 dns-page.ts 里已有的 dnsUpstream*。
import { i18n } from '@/i18n'

i18n.global.mergeLocaleMessage('zh-CN', {
  shareRegionsDnsSystem: '系统 DNS',
  shareRegionsDnsSystemText: '手机当前网络的 DNS',
  shareRegionsDnsDirectNote: '解析本地直连的域名用。默认是系统 DNS。',
  shareRegionsDnsProxyNote: '回路由器的域名向它查询,经共享网络节点回路由器再查。TCP 稳妥;UDP 要节点支持 UDP。',
  shareRegionsDnsSystemProxyNote: '代理 DNS 选系统 DNS 时直接问它,不经节点',
  shareRegionsDnsSystemNotInCn: '这一组含中国大陆,代理 DNS 不能用系统 DNS:中国大陆的 DNS 对境外域名有污染',
  shareRegionsDnsLastOne: '这一组含中国大陆,代理 DNS 至少要留一个',
  shareRegionsDnsSystemLast: '这一侧至少留一条;删光了也是系统 DNS',
  shareRegionsDnsNote:
    '同一侧的第一条是主上游,后面的是备用:和主上游并发查询,谁先返回就用谁的。默认按这一组含不含中国大陆:含——直连系统 DNS、代理 TCP 1.1.1.1;不含——两侧都是系统 DNS。',
  shareRegionsDnsRestoreConfirm:
    '这一组的 DNS 恢复成默认值?含中国大陆:直连系统 DNS、代理 TCP 1.1.1.1;不含:两侧都是系统 DNS。',
})
i18n.global.mergeLocaleMessage('zh-TW', {
  shareRegionsDnsSystem: '系統 DNS',
  shareRegionsDnsSystemText: '手機目前網路的 DNS',
  shareRegionsDnsDirectNote: '解析本地直連的網域用。預設是系統 DNS。',
  shareRegionsDnsProxyNote: '回路由器的網域向它查詢,經共享網路節點回路由器再查。TCP 穩妥;UDP 要節點支援 UDP。',
  shareRegionsDnsSystemProxyNote: '代理 DNS 選系統 DNS 時直接問它,不經節點',
  shareRegionsDnsSystemNotInCn: '這一組含中國大陸,代理 DNS 不能用系統 DNS:中國大陸的 DNS 對境外網域有污染',
  shareRegionsDnsLastOne: '這一組含中國大陸,代理 DNS 至少要留一個',
  shareRegionsDnsSystemLast: '這一側至少留一條;刪光了也是系統 DNS',
  shareRegionsDnsNote:
    '同一側的第一條是主上游,後面的是備用:和主上游並行查詢,誰先回傳就用誰的。預設依這一組含不含中國大陸:含——直連系統 DNS、代理 TCP 1.1.1.1;不含——兩側都是系統 DNS。',
  shareRegionsDnsRestoreConfirm:
    '這一組的 DNS 恢復成預設值?含中國大陸:直連系統 DNS、代理 TCP 1.1.1.1;不含:兩側都是系統 DNS。',
})
i18n.global.mergeLocaleMessage('en-US', {
  shareRegionsDnsSystem: 'System DNS',
  shareRegionsDnsSystemText: "the phone's current network DNS",
  shareRegionsDnsDirectNote: 'Resolves domains that go direct. Defaults to the system DNS.',
  shareRegionsDnsProxyNote:
    'Domains that go back to the router are resolved here, through the share node and the router. TCP is safest; UDP needs a node that carries UDP.',
  shareRegionsDnsSystemProxyNote: 'With the system DNS, the proxy side asks it directly, not through the node',
  shareRegionsDnsSystemNotInCn:
    'This group includes Mainland China, so the proxy DNS cannot be the system DNS: DNS in Mainland China is polluted for foreign domains',
  shareRegionsDnsLastOne: 'This group includes Mainland China, so keep at least one proxy DNS',
  shareRegionsDnsSystemLast: 'Keep at least one per side; with none left it is the system DNS',
  shareRegionsDnsNote:
    'The first entry on each side is the primary; the rest are backups queried in parallel, and the first answer wins. Defaults depend on whether the group includes Mainland China: if it does, direct uses the system DNS and proxy uses TCP 1.1.1.1; otherwise both sides use the system DNS.',
  shareRegionsDnsRestoreConfirm:
    "Restore this group's DNS to the defaults? With Mainland China: system DNS for direct, TCP 1.1.1.1 for proxy; without: system DNS on both sides.",
})
