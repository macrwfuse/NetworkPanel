/**
 * SpeedTestScheduler - 定时测速调度器
 * 功能：
 * 1. 完整 5 字段 Cron 表达式调度（分 时 日 月 周）
 * 2. 单次测速流量上限（默认2GB）
 * 3. 历史测速记录与平均速度计算
 * 4. 速度告警阈值检测
 * 5. 多通道告警：Slack / 钉钉(DingTalk) / 飞书(Feishu/Lark)
 * 6. Slack 告警代理转发至钉钉/飞书
 */

export interface SpeedTestRecord {
  timestamp: number
  duration: number
  bytesUsed: number
  avgSpeed: number
  avgBandwidth: number
  peakSpeed: number
  stopped: 'manual' | 'traffic_limit' | 'schedule' | 'alert'
}

export interface DingTalkConfig {
  enabled: boolean
  webhookUrl: string       // 钉钉自定义机器人 Webhook URL
  secret: string           // 加签密钥（可选，HmacSHA256）
  atMobiles: string[]      // @指定手机号
  atAll: boolean           // @所有人
}

export interface FeishuConfig {
  enabled: boolean
  webhookUrl: string       // 飞书自定义机器人 Webhook URL
  secret: string           // 加签密钥（可选）
}

export interface SlackProxyConfig {
  enabled: boolean
  /** 启用后，Slack 告警会同时转发到钉钉和/或飞书 */
  forwardToDingTalk: boolean
  forwardToFeishu: boolean
}

export interface AlertConfig {
  enabled: boolean
  minSpeed: number
  maxLatency: number
  // Slack
  slackWebhookUrl: string
  slackEnabled: boolean
  // 钉钉
  dingtalk: DingTalkConfig
  // 飞书
  feishu: FeishuConfig
  // Slack 代理转发
  slackProxy: SlackProxyConfig
  onAlert: (message: string, type: 'warning' | 'error' | 'success') => void
}

export interface SchedulerConfig {
  enabled: boolean
  cronExpression: string   // 标准 5 字段 cron: "分 时 日 月 周"
  durationMs: number       // 每次测速持续时间(毫秒)，0=无限
  trafficLimitBytes: number
  maxRounds: number
}

const TWO_GB = 2 * 1024 * 1024 * 1024

// ============================================================
//  Cron 解析器 — 支持标准 5 字段表达式
//  字段: minute hour dayOfMonth month dayOfWeek
//  支持: *  ,  -  /  特定值
// ============================================================

interface CronFields {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>()
  const parts = field.split(',')
  for (const part of parts) {
    if (part === '*') {
      for (let i = min; i <= max; i++) result.add(i)
    } else if (part.includes('/')) {
      const [range, stepStr] = part.split('/')
      const step = parseInt(stepStr, 10)
      if (isNaN(step) || step <= 0) continue
      const start = range === '*' ? min : parseInt(range, 10)
      for (let i = start; i <= max; i += step) result.add(i)
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number)
      if (!isNaN(a) && !isNaN(b)) {
        for (let i = Math.max(a, min); i <= Math.min(b, max); i++) result.add(i)
      }
    } else {
      const val = parseInt(part, 10)
      if (!isNaN(val) && val >= min && val <= max) result.add(val)
    }
  }
  return result
}

function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  try {
    return {
      minutes: parseCronField(parts[0], 0, 59),
      hours: parseCronField(parts[1], 0, 23),
      days: parseCronField(parts[2], 1, 31),
      months: parseCronField(parts[3], 1, 12),
      weekdays: parseCronField(parts[4], 0, 6), // 0=周日
    }
  } catch {
    return null
  }
}

/**
 * 计算从 now 起，下一次匹配 cron 的时间
 * @returns 延迟毫秒数，-1 表示无法计算
 */
function nextCronDelay(cron: CronFields, now: Date = new Date()): number {
  const maxSearchMinutes = 366 * 24 * 60 // 最多搜索一年
  const candidate = new Date(now)
  candidate.setSeconds(0, 0)
  // 从下一分钟开始
  candidate.setMinutes(candidate.getMinutes() + 1)

  for (let i = 0; i < maxSearchMinutes; i++) {
    const m = candidate.getMinutes()
    const h = candidate.getHours()
    const d = candidate.getDate()
    const mo = candidate.getMonth() + 1
    const wd = candidate.getDay()

    if (
      cron.minutes.has(m) &&
      cron.hours.has(h) &&
      cron.days.has(d) &&
      cron.months.has(mo) &&
      cron.weekdays.has(wd)
    ) {
      const delay = candidate.getTime() - now.getTime()
      return delay > 0 ? delay : 0
    }
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return -1
}

/** 格式化 cron 表达式的中文描述 */
export function describeCron(expr: string): string {
  const cron = parseCron(expr)
  if (!cron) return '（无效的 Cron 表达式）'

  const parts: string[] = []

  // 月份
  if (cron.months.size < 12) {
    const monthNames = ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
    parts.push([...cron.months].map(m => monthNames[m]).join(','))
  }

  // 星期
  if (cron.weekdays.size < 7) {
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    parts.push([...cron.weekdays].map(d => dayNames[d]).join(','))
  }

  // 日
  if (cron.days.size < 31) {
    parts.push(`每月${[...cron.days].join(',')}日`)
  }

  // 时
  if (cron.hours.size < 24) {
    parts.push(`${[...cron.hours].join(',')}时`)
  }

  // 分
  if (cron.minutes.size < 60) {
    parts.push(`${[...cron.minutes].join(',')}分`)
  }

  if (parts.length === 0) return '每分钟执行'

  // 检查常见模式
  if (
    cron.minutes.size === 60 &&
    cron.hours.size === 24 &&
    cron.days.size === 31 &&
    cron.months.size === 12 &&
    cron.weekdays.size === 7
  ) {
    return '每分钟执行'
  }

  return parts.join(' ')
}

// ============================================================
//  钉钉签名工具
// ============================================================

async function dingTalkSign(secret: string, timestamp: number): Promise<string> {
  const stringToSign = `${timestamp}\n${secret}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

// ============================================================
//  SpeedTestScheduler 主类
// ============================================================

export class SpeedTestScheduler {
  private records: SpeedTestRecord[] = []
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null
  private durationTimer: ReturnType<typeof setTimeout> | null = null
  private currentRound: number = 0
  private testStartTime: number = 0
  private testStartBytes: number = 0
  private peakSpeed: number = 0
  private speedSamples: number[] = []
  private isRunning: boolean = false
  private cronFields: CronFields | null = null

  private onStart: (() => void) | null = null
  private onStop: ((reason: string) => void) | null = null
  private onRecord: ((record: SpeedTestRecord) => void) | null = null

  public scheduler: SchedulerConfig = {
    enabled: false,
    cronExpression: '0 * * * *',
    durationMs: 300000,
    trafficLimitBytes: TWO_GB,
    maxRounds: 0,
  }

  public alert: AlertConfig = {
    enabled: false,
    minSpeed: 0,
    maxLatency: 0,
    slackWebhookUrl: '',
    slackEnabled: false,
    dingtalk: {
      enabled: false,
      webhookUrl: '',
      secret: '',
      atMobiles: [],
      atAll: false,
    },
    feishu: {
      enabled: false,
      webhookUrl: '',
      secret: '',
    },
    slackProxy: {
      enabled: false,
      forwardToDingTalk: true,
      forwardToFeishu: true,
    },
    onAlert: () => {},
  }

  constructor() {
    this.loadFromStorage()
    this.cronFields = parseCron(this.scheduler.cronExpression)
  }

  // === 公共方法 ===

  /**
   * 发送 Slack Webhook 通知
   */
  async sendSlackNotification(text: string, type: 'warning' | 'error' | 'success' = 'success') {
    if (!this.alert.slackEnabled || !this.alert.slackWebhookUrl) return
    const emoji = { warning: '⚠️', error: '❌', success: '✅' }[type]
    try {
      await fetch(this.alert.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${emoji} *NetworkPanel 测速告警*`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: `${emoji} 测速告警`, emoji: true }
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text }
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `🕐 ${new Date().toLocaleString()}` }]
            }
          ]
        })
      })

      // Slack 代理转发
      if (this.alert.slackProxy.enabled) {
        if (this.alert.slackProxy.forwardToDingTalk) {
          await this.sendDingTalkNotification(text, type)
        }
        if (this.alert.slackProxy.forwardToFeishu) {
          await this.sendFeishuNotification(text, type)
        }
      }
    } catch (err) {
      console.error('Slack notification failed:', err)
    }
  }

  /**
   * 发送测速结果表格到 Slack
   */
  async sendSlackTable(record: SpeedTestRecord, reason: string) {
    if (!this.alert.slackEnabled || !this.alert.slackWebhookUrl) return
    try {
      const reasonText: Record<string, string> = {
        manual: '手动停止', traffic_limit: '流量上限', schedule: '定时结束', alert: '告警触发'
      }
      await fetch(this.alert.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: '✅ *NetworkPanel 测速结果*',
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '✅ 测速结果', emoji: true }
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*停止原因*
${reasonText[reason] || reason}` },
                { type: 'mrkdwn', text: `*测速时长*
${this.formatDuration(record.duration)}` },
                { type: 'mrkdwn', text: `*使用流量*
${this.formatBytes(record.bytesUsed)}` },
                { type: 'mrkdwn', text: `*平均速度*
${this.formatSpeed(record.avgSpeed)}` },
                { type: 'mrkdwn', text: `*平均带宽*
${this.formatBandwidth(record.avgBandwidth)}` },
                { type: 'mrkdwn', text: `*峰值速度*
${this.formatSpeed(record.peakSpeed)}` }
              ]
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `🕐 ${new Date(record.timestamp).toLocaleString()}` }]
            }
          ]
        })
      })

      if (this.alert.slackProxy.enabled) {
        if (this.alert.slackProxy.forwardToDingTalk) {
          await this.sendDingTalkTable(record, reason)
        }
        if (this.alert.slackProxy.forwardToFeishu) {
          await this.sendFeishuTable(record, reason)
        }
      }
    } catch (err) {
      console.error('Slack table notification failed:', err)
    }
  }

  /**
   * 发送钉钉 Webhook 通知
   */
  async sendDingTalkNotification(text: string, type: 'warning' | 'error' | 'success' = 'success') {
    if (!this.alert.dingtalk.enabled || !this.alert.dingtalk.webhookUrl) return
    const emoji = { warning: '⚠️', error: '❌', success: '✅' }[type]
    const title = `${emoji} NetworkPanel 测速告警`

    try {
      let url = this.alert.dingtalk.webhookUrl

      // 如果配置了加签密钥，计算签名
      if (this.alert.dingtalk.secret) {
        const timestamp = Date.now()
        const sign = await dingTalkSign(this.alert.dingtalk.secret, timestamp)
        const sep = url.includes('?') ? '&' : '?'
        url = `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
      }

      const body: any = {
        msgtype: 'markdown',
        markdown: {
          title,
          text: `### ${title}\n\n${text}\n\n---\n🕐 ${new Date().toLocaleString()}`
        },
        at: {
          atMobiles: this.alert.dingtalk.atMobiles || [],
          isAtAll: this.alert.dingtalk.atAll || false,
        }
      }

      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (err) {
      console.error('DingTalk notification failed:', err)
    }
  }

  /**
   * 发送飞书 Webhook 通知
   */
  async sendFeishuNotification(text: string, type: 'warning' | 'error' | 'success' = 'success') {
    if (!this.alert.feishu.enabled || !this.alert.feishu.webhookUrl) return
    const emoji = { warning: '⚠️', error: '❌', success: '✅' }[type]
    const title = `${emoji} NetworkPanel 测速告警`

    try {
      let url = this.alert.feishu.webhookUrl

      // 飞书加签
      if (this.alert.feishu.secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const stringToSign = `${timestamp}\n${this.alert.feishu.secret}`
        const encoder = new TextEncoder()
        const key = await crypto.subtle.importKey(
          'raw', encoder.encode(stringToSign), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        )
        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign))
        const sign = btoa(String.fromCharCode(...new Uint8Array(signature)))
        const sep = url.includes('?') ? '&' : '?'
        url = `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
      }

      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'interactive',
          card: {
            header: {
              title: { tag: 'plain_text', content: title },
              template: type === 'error' ? 'red' : type === 'warning' ? 'orange' : 'green'
            },
            elements: [
              {
                tag: 'markdown',
                content: text
              },
              {
                tag: 'note',
                elements: [
                  { tag: 'plain_text', content: `🕐 ${new Date().toLocaleString()}` }
                ]
              }
            ]
          }
        })
      })
    } catch (err) {
      console.error('Feishu notification failed:', err)
    }
  }

  /**
   * 发送测速结果表格到钉钉
   */
  async sendDingTalkTable(record: SpeedTestRecord, reason: string) {
    if (!this.alert.dingtalk.enabled || !this.alert.dingtalk.webhookUrl) return
    const reasonText: Record<string, string> = {
      manual: '手动停止', traffic_limit: '流量上限', schedule: '定时结束', alert: '告警触发'
    }

    try {
      let url = this.alert.dingtalk.webhookUrl

      if (this.alert.dingtalk.secret) {
        const timestamp = Date.now()
        const sign = await dingTalkSign(this.alert.dingtalk.secret, timestamp)
        const sep = url.includes('?') ? '&' : '?'
        url = `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
      }

      const text = [
        '### ✅ 测速结果',
        '',
        '| 指标 | 数值 |',
        '| :--- | :--- |',
        `| 停止原因 | ${reasonText[reason] || reason} |`,
        `| 测速时长 | ${this.formatDuration(record.duration)} |`,
        `| 使用流量 | ${this.formatBytes(record.bytesUsed)} |`,
        `| 平均速度 | ${this.formatSpeed(record.avgSpeed)} |`,
        `| 平均带宽 | ${this.formatBandwidth(record.avgBandwidth)} |`,
        `| 峰值速度 | ${this.formatSpeed(record.peakSpeed)} |`,
        '',
        `---`,
        `🕐 ${new Date(record.timestamp).toLocaleString()}`
      ].join('\n')

      const body: any = {
        msgtype: 'markdown',
        markdown: { title: '✅ 测速结果', text },
        at: {
          atMobiles: this.alert.dingtalk.atMobiles || [],
          isAtAll: this.alert.dingtalk.atAll || false,
        }
      }

      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (err) {
      console.error('DingTalk table notification failed:', err)
    }
  }

  /**
   * 发送测速结果表格到飞书
   */
  async sendFeishuTable(record: SpeedTestRecord, reason: string) {
    if (!this.alert.feishu.enabled || !this.alert.feishu.webhookUrl) return
    const reasonText: Record<string, string> = {
      manual: '手动停止', traffic_limit: '流量上限', schedule: '定时结束', alert: '告警触发'
    }

    try {
      let url = this.alert.feishu.webhookUrl

      if (this.alert.feishu.secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const stringToSign = `${timestamp}\n${this.alert.feishu.secret}`
        const encoder = new TextEncoder()
        const key = await crypto.subtle.importKey(
          'raw', encoder.encode(stringToSign), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        )
        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign))
        const sign = btoa(String.fromCharCode(...new Uint8Array(signature)))
        const sep = url.includes('?') ? '&' : '?'
        url = `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
      }

      // 飞书卡片用 markdown 表格
      const mdTable = [
        '| 指标 | 数值 |',
        '| :--- | :--- |',
        `| 停止原因 | ${reasonText[reason] || reason} |`,
        `| 测速时长 | ${this.formatDuration(record.duration)} |`,
        `| 使用流量 | ${this.formatBytes(record.bytesUsed)} |`,
        `| 平均速度 | ${this.formatSpeed(record.avgSpeed)} |`,
        `| 平均带宽 | ${this.formatBandwidth(record.avgBandwidth)} |`,
        `| 峰值速度 | ${this.formatSpeed(record.peakSpeed)} |`,
      ].join('\n')

      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'interactive',
          card: {
            header: {
              title: { tag: 'plain_text', content: '✅ 测速结果' },
              template: 'green'
            },
            elements: [
              { tag: 'markdown', content: mdTable },
              {
                tag: 'note',
                elements: [
                  { tag: 'plain_text', content: `🕐 ${new Date(record.timestamp).toLocaleString()}` }
                ]
              }
            ]
          }
        })
      })
    } catch (err) {
      console.error('Feishu table notification failed:', err)
    }
  }

  /**
   * 统一告警广播 — 向所有已启用通道发送通知
   */
  async broadcastAlert(text: string, type: 'warning' | 'error' | 'success' = 'success') {
    const promises: Promise<void>[] = []

    if (this.alert.slackEnabled && this.alert.slackWebhookUrl) {
      promises.push(this.sendSlackNotification(text, type))
    }
    if (this.alert.dingtalk.enabled && this.alert.dingtalk.webhookUrl) {
      promises.push(this.sendDingTalkNotification(text, type))
    }
    if (this.alert.feishu.enabled && this.alert.feishu.webhookUrl) {
      promises.push(this.sendFeishuNotification(text, type))
    }

    await Promise.allSettled(promises)
  }

  /**
   * 统一表格广播 — 向所有已启用通道发送测速结果表格
   */
  async broadcastTable(record: SpeedTestRecord, reason: string) {
    const promises: Promise<void>[] = []

    if (this.alert.slackEnabled && this.alert.slackWebhookUrl) {
      promises.push(this.sendSlackTable(record, reason))
    }
    if (this.alert.dingtalk.enabled && this.alert.dingtalk.webhookUrl) {
      promises.push(this.sendDingTalkTable(record, reason))
    }
    if (this.alert.feishu.enabled && this.alert.feishu.webhookUrl) {
      promises.push(this.sendFeishuTable(record, reason))
    }

    await Promise.allSettled(promises)
  }

  setCallbacks(
    onStart: () => void,
    onStop: (reason: string) => void,
    onRecord: (record: SpeedTestRecord) => void,
  ) {
    this.onStart = onStart
    this.onStop = onStop
    this.onRecord = onRecord
  }

  /**
   * 更新 cron 表达式并重新解析
   */
  setCronExpression(expr: string): boolean {
    const parsed = parseCron(expr)
    if (!parsed) return false
    this.scheduler.cronExpression = expr
    this.cronFields = parsed
    return true
  }

  /**
   * 开始定时测速调度
   */
  startScheduler() {
    if (!this.scheduler.enabled) return
    this.cronFields = parseCron(this.scheduler.cronExpression)
    this.currentRound = 0
    this.scheduleNext()
  }

  stopScheduler() {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer)
      this.schedulerTimer = null
    }
    if (this.durationTimer) {
      clearTimeout(this.durationTimer)
      this.durationTimer = null
    }
    this.isRunning = false
  }

  onTestStart(bytesUsed: number) {
    this.testStartTime = Date.now()
    this.testStartBytes = bytesUsed
    this.peakSpeed = 0
    this.speedSamples = []
    this.isRunning = true

    if (this.scheduler.durationMs > 0 && this.scheduler.enabled) {
      this.durationTimer = setTimeout(() => {
        this.stopTest('schedule')
      }, this.scheduler.durationMs)
    }
  }

  onTick(bytesUsed: number, currentSpeed: number): boolean {
    if (!this.isRunning) return false

    if (currentSpeed > 0) {
      this.speedSamples.push(currentSpeed)
      if (currentSpeed > this.peakSpeed) {
        this.peakSpeed = currentSpeed
      }
    }

    const testBytesUsed = bytesUsed - this.testStartBytes
    if (testBytesUsed >= this.scheduler.trafficLimitBytes) {
      this.stopTest('traffic_limit')
      return true
    }

    if (this.alert.enabled && this.alert.minSpeed > 0) {
      const recentSamples = this.speedSamples.slice(-5)
      if (recentSamples.length >= 5) {
        const avgRecent = recentSamples.reduce((a, b) => a + b, 0) / recentSamples.length
        if (avgRecent < this.alert.minSpeed && avgRecent > 0) {
          const alertMsg = `⚠️ 速度告警：当前速度 ${this.formatSpeed(avgRecent)} 低于阈值 ${this.formatSpeed(this.alert.minSpeed)}`
          this.alert.onAlert(alertMsg, 'warning')
          this.broadcastAlert(
            `*速度告警*\n• 当前速度: ${this.formatSpeed(avgRecent)}\n• 阈值: ${this.formatSpeed(this.alert.minSpeed)}`,
            'warning'
          )
        }
      }
    }

    return false
  }

  onTestEnd(bytesUsed: number, reason: 'manual' | 'traffic_limit' | 'schedule' | 'alert' = 'manual') {
    if (!this.isRunning && reason === 'manual') return
    this.isRunning = false

    if (this.durationTimer) {
      clearTimeout(this.durationTimer)
      this.durationTimer = null
    }

    const duration = (Date.now() - this.testStartTime) / 1000
    const testBytes = bytesUsed - this.testStartBytes
    const avgSpeed = duration > 0 ? testBytes / duration : 0

    const record: SpeedTestRecord = {
      timestamp: this.testStartTime,
      duration,
      bytesUsed: testBytes,
      avgSpeed,
      avgBandwidth: avgSpeed * 8,
      peakSpeed: this.peakSpeed,
      stopped: reason,
    }

    this.records.push(record)
    this.saveToStorage()

    if (this.onRecord) {
      this.onRecord(record)
    }

    const reasonText: Record<string, string> = {
      manual: '手动停止',
      traffic_limit: '流量达到上限',
      schedule: '定时结束',
      alert: '告警触发',
    }

    if (this.alert.enabled) {
      const message =
        `✅ 测速完成（${reasonText[reason]}）\n` +
        `时长: ${this.formatDuration(duration)}\n` +
        `流量: ${this.formatBytes(testBytes)}\n` +
        `平均速度: ${this.formatSpeed(avgSpeed)}\n` +
        `平均带宽: ${this.formatBandwidth(avgSpeed * 8)}\n` +
        `峰值速度: ${this.formatSpeed(this.peakSpeed)}`

      this.alert.onAlert(message, 'success')
      // 发送表格格式到所有 IM 通道
      this.broadcastTable(record, reason)
    }
  }

  stopTest(reason: 'manual' | 'traffic_limit' | 'schedule' | 'alert' = 'manual') {
    if (this.onStop) {
      this.onStop(reason)
    }
  }

  getStats() {
    if (this.records.length === 0) {
      return {
        totalTests: 0,
        avgSpeed: 0,
        avgBandwidth: 0,
        avgDuration: 0,
        totalTraffic: 0,
        peakSpeed: 0,
        recentRecords: [],
      }
    }

    const totalSpeed = this.records.reduce((sum, r) => sum + r.avgSpeed, 0)
    const totalDuration = this.records.reduce((sum, r) => sum + r.duration, 0)
    const totalTraffic = this.records.reduce((sum, r) => sum + r.bytesUsed, 0)
    const peakSpeed = Math.max(...this.records.map(r => r.peakSpeed))

    return {
      totalTests: this.records.length,
      avgSpeed: totalSpeed / this.records.length,
      avgBandwidth: (totalSpeed / this.records.length) * 8,
      avgDuration: totalDuration / this.records.length,
      totalTraffic,
      peakSpeed,
      recentRecords: this.records.slice(-20).reverse(),
    }
  }

  clearRecords() {
    this.records = []
    this.saveToStorage()
  }

  getIsRunning(): boolean {
    return this.isRunning
  }

  // === 私有方法 ===

  private scheduleNext() {
    if (!this.scheduler.enabled) return

    let delay: number

    if (this.cronFields) {
      const d = nextCronDelay(this.cronFields)
      delay = d >= 0 ? d : 60000 // fallback 1 分钟
    } else {
      delay = 60000
    }

    this.schedulerTimer = setTimeout(() => {
      this.currentRound++
      if (this.scheduler.maxRounds > 0 && this.currentRound > this.scheduler.maxRounds) {
        this.stopScheduler()
        if (this.alert.enabled) {
          this.alert.onAlert(`🔔 定时测速已完成 ${this.scheduler.maxRounds} 轮`, 'success')
        }
        return
      }

      if (this.onStart) {
        this.onStart()
      }

      this.scheduleNext()
    }, delay)
  }

  private saveToStorage() {
    try {
      localStorage.setItem('speedTestRecords', JSON.stringify(this.records.slice(-100)))
      localStorage.setItem('speedTestScheduler', JSON.stringify(this.scheduler))
      localStorage.setItem('speedTestAlert', JSON.stringify({
        enabled: this.alert.enabled,
        minSpeed: this.alert.minSpeed,
        maxLatency: this.alert.maxLatency,
        slackWebhookUrl: this.alert.slackWebhookUrl,
        slackEnabled: this.alert.slackEnabled,
        dingtalk: this.alert.dingtalk,
        feishu: this.alert.feishu,
        slackProxy: this.alert.slackProxy,
      }))
    } catch (e) {
      this.records = this.records.slice(-20)
      try {
        localStorage.setItem('speedTestRecords', JSON.stringify(this.records))
      } catch (_) {}
    }
  }

  private loadFromStorage() {
    try {
      const records = localStorage.getItem('speedTestRecords')
      if (records) this.records = JSON.parse(records)

      const scheduler = localStorage.getItem('speedTestScheduler')
      if (scheduler) Object.assign(this.scheduler, JSON.parse(scheduler))

      const alert = localStorage.getItem('speedTestAlert')
      if (alert) {
        const alertData = JSON.parse(alert)
        this.alert.enabled = alertData.enabled ?? false
        this.alert.minSpeed = alertData.minSpeed ?? 0
        this.alert.maxLatency = alertData.maxLatency ?? 0
        this.alert.slackWebhookUrl = alertData.slackWebhookUrl ?? ''
        this.alert.slackEnabled = alertData.slackEnabled ?? false
        // 钉钉
        if (alertData.dingtalk) {
          this.alert.dingtalk = {
            enabled: alertData.dingtalk.enabled ?? false,
            webhookUrl: alertData.dingtalk.webhookUrl ?? '',
            secret: alertData.dingtalk.secret ?? '',
            atMobiles: alertData.dingtalk.atMobiles ?? [],
            atAll: alertData.dingtalk.atAll ?? false,
          }
        }
        // 飞书
        if (alertData.feishu) {
          this.alert.feishu = {
            enabled: alertData.feishu.enabled ?? false,
            webhookUrl: alertData.feishu.webhookUrl ?? '',
            secret: alertData.feishu.secret ?? '',
          }
        }
        // Slack 代理
        if (alertData.slackProxy) {
          this.alert.slackProxy = {
            enabled: alertData.slackProxy.enabled ?? false,
            forwardToDingTalk: alertData.slackProxy.forwardToDingTalk ?? true,
            forwardToFeishu: alertData.slackProxy.forwardToFeishu ?? true,
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load scheduler config:', e)
    }
  }

  // === 格式化工具 ===

  formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let idx = 0
    let val = bytes
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024
      idx++
    }
    return val.toFixed(idx > 1 ? 2 : 0) + units[idx]
  }

  formatSpeed(bps: number): string {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
    let idx = 0
    let val = bps
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024
      idx++
    }
    return val.toFixed(idx > 1 ? 2 : 0) + units[idx]
  }

  formatBandwidth(bps: number): string {
    const units = ['bps', 'Kbps', 'Mbps', 'Gbps']
    let idx = 0
    let val = bps
    while (val >= 1000 && idx < units.length - 1) {
      val /= 1000
      idx++
    }
    return val.toFixed(idx > 1 ? 2 : 0) + units[idx]
  }

  formatDuration(seconds: number): string {
    if (seconds < 60) return seconds.toFixed(0) + '秒'
    const mins = seconds / 60
    if (mins < 60) return mins.toFixed(1) + '分钟'
    const hours = mins / 60
    return hours.toFixed(1) + '小时'
  }
}

export default SpeedTestScheduler
