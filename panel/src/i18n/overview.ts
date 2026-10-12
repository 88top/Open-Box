import { LANG } from '@/constant'

// 概览页对齐 v0.1.308 新增的文案(在 i18n/index.ts 里合并进各语言)
const overviewMessages = {
  [LANG.ZH_CN]: {
    overviewPanelTitle: '面板概览',
    overviewAutoTest: '打开概览自动测速',
    statConnections: '连接数',
    statDownloadTotal: '进站流量',
    statUploadTotal: '出站流量',
    trafficInsight: '流量洞察',
    siteUnreachable: '不通',
  },
  [LANG.ZH_TW]: {
    overviewPanelTitle: '面板概覽',
    overviewAutoTest: '開啟概覽自動測速',
    statConnections: '連線數',
    statDownloadTotal: '進站流量',
    statUploadTotal: '出站流量',
    trafficInsight: '流量洞察',
    siteUnreachable: '不通',
  },
  [LANG.EN_US]: {
    overviewPanelTitle: 'Panel overview',
    overviewAutoTest: 'Auto speed test on open',
    statConnections: 'Connections',
    statDownloadTotal: 'Inbound traffic',
    statUploadTotal: 'Outbound traffic',
    trafficInsight: 'Traffic insights',
    siteUnreachable: 'Unreachable',
  },
}

export default overviewMessages
