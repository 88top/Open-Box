import { LANG } from '@/constant'

// 概览页对齐 v0.1.308 新增的文案(在 i18n/index.ts 里合并进各语言)
const overviewMessages = {
  [LANG.ZH_CN]: {
    overviewPanelTitle: '面板概览',
    overviewAutoTest: '打开概览自动测速',
    siteLatencyAutoTestHint: '打开概览页时自动测一遍这四个站点的延时。和面板设置里的「自动检查连接」是同一个开关。',
    siteLatencyTestAll: '重测这四个站点',
    statConnections: '连接数',
    statDownloadTotal: '进站流量',
    statUploadTotal: '出站流量',
    trafficInsight: '流量洞察',
    siteUnreachable: '不通',
  },
  [LANG.ZH_TW]: {
    overviewPanelTitle: '面板概覽',
    overviewAutoTest: '開啟概覽自動測速',
    siteLatencyAutoTestHint: '開啟概覽頁時自動測一遍這四個站點的延遲。和面板設定裡的「自動檢查連線」是同一個開關。',
    siteLatencyTestAll: '重測這四個站點',
    statConnections: '連線數',
    statDownloadTotal: '進站流量',
    statUploadTotal: '出站流量',
    trafficInsight: '流量洞察',
    siteUnreachable: '不通',
  },
  [LANG.EN_US]: {
    overviewPanelTitle: 'Panel overview',
    overviewAutoTest: 'Auto speed test on open',
    siteLatencyAutoTestHint: 'Test these four sites automatically when the overview opens. Same switch as "Auto connection check" in the panel settings.',
    siteLatencyTestAll: 'Test these four sites again',
    statConnections: 'Connections',
    statDownloadTotal: 'Inbound traffic',
    statUploadTotal: 'Outbound traffic',
    trafficInsight: 'Traffic insights',
    siteUnreachable: 'Unreachable',
  },
}

export default overviewMessages
