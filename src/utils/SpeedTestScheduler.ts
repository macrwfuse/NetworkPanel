/**
 * SpeedTestScheduler - 定时测速调度器
 * 功能：
 * 1. 完整 5 字段 Cron 表达式调度（分 时 日 月 周）
 * 2. 单次测速流量上限（默认2GB）
 * 3. 历史测速记录与平均速度计算
 * 4. 速度告警阈值检测
 * 5. 多通道告警：Slack / 钉钉(DingTalk) / 飞书(Feishu/Lark)
 * 6. 通过 /proxy 代理解决浏览器 CORS 限制
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
  webhookUrl: string
  secret: string
  atMobiles: string[]
  atAll: boolean
}

export interface FeishuConfig {
  enabled: boolean
  webhookUrl: string
  secret: string
}

export interface SlackProxyConfig {
  enabled: boolean
  forwardToDingTalk: boolean
  forwardToFeishu: boolean
}

export interface AlertConfig {
  enabled: boolean
  minSpeed: number
  maxLatency: number
  slackWebhookUrl: string
  slackEnabled: boolean
  dingtalk: DingTalkConfig
  feishu: FeishuConfig
  slackProxy: SlackProxyConfig
  onAlert: (message: string, type: 'warning' | 'error' | 'success') => void
}

export interface SchedulerConfig {
  enabled: boolean
  cronExpression: string
  durationMs: number
  trafficLimitBytes: number
  maxRounds: number
}

const TWO_GB = 2 * 1024 * 1024 * 1024

// ============================================================
//  代理请求 — 解决浏览器 CORS 限制
// ============================================================

async function proxyFetch(targetUrl: string, body: string): Promise<any> {
  const proxyUrl = `/proxy?url=${encodeURIComponent(targetUrl)}`
  const resp = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return { _raw: text, _status: resp.status } }
}

// ============================================================
//  Cron 解析器
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
      weekdays: parseCronField(parts[4], 0, 6),
    }
  } catch { return null }
}

function nextCronDelay(cron: CronFields, now: Date = new Date()): number {
  const maxSearch = 366 * 24 * 60
  const candidate = new Date(now)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)
  for (let i = 0; i < maxSearch; i++) {
    if (
      cron.minutes.has(candidate.getMinutes()) &&
      cron.hours.has(candidate.getHours()) &&
      cron.days.has(candidate.getDate()) &&
      cron.months.has(candidate.getMonth() + 1) &&
      cron.weekdays.has(candidate.getDay())
    ) {
      return Math.max(candidate.getTime() - now.getTime(), 0)
    }
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return -1
}

export function describeCron(expr: string): string {
  const cron = parseCron(expr)
  if (!cron) return '（无效的 Cron 表达式）'
  const parts: string[] = []
  if (cron.months.size < 12) {
    const mn = ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
    parts.push([...cron.months].map(m => mn[m]).join(','))
  }
  if (cron.weekdays.size < 7) {
    const dn = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    parts.push([...cron.weekdays].map(d => dn[d]).join(','))
  }
  if (cron.days.size < 31) parts.push(`每月${[...cron.days].join(',')}日`)
  if (cron.hours.size < 24) parts.push(`${[...cron.hours].join(',')}时`)
  if (cron.minutes.size < 60) parts.push(`${[...cron.minutes].join(',')}分`)
  if (parts.length === 0) return '每分钟执行'
  return parts.join(' ')
}

// ============================================================
//  钉钉签名
// ============================================================

async function dingTalkSign(secret: string, timestamp: number): Promise<string> {
  const str = `${timestamp}\n${secret}`
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(str))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// ============================================================
//  消息格式化
// ============================================================

const STOP_REASONS: Record<string, string> = {
  manual: '手动停止', traffic_limit: '流量上限', schedule: '定时结束', alert: '告警触发',
}

function buildResultText(record: SpeedTestRecord, reason: string, fmt: SpeedTestScheduler): string {
  return [
    `✅ 检测状态：${STOP_REASONS[reason] || reason}`,
    `🕐 检测时间：${new Date(record.timestamp).toLocaleString()}`,
    `⏱ 测速耗时：${fmt.formatDuration(record.duration)}`,
    '',
    `⬇ 平均速度：${fmt.formatSpeed(record.avgSpeed)}`,
    `⬆ 峰值速度：${fmt.formatSpeed(record.peakSpeed)}`,
    `📡 平均带宽：${fmt.formatBandwidth(record.avgBandwidth)}`,
    '',
    `📊 使用流量：${fmt.formatBytes(record.bytesUsed)}`,
  ].join('\n')
}

// ============================================================
//  SpeedTestScheduler 主类
// ============================================================

export class SpeedTestScheduler {
  private records: SpeedTestRecord[] = []
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null
  private durationTimer: ReturnType<typeof setTimeout> | null = null
  private currentRound = 0
  private testStartTime = 0
  private testStartBytes = 0
  private peakSpeed = 0
  private speedSamples: number[] = []
  private isRunning = false
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
    dingtalk: { enabled: false, webhookUrl: '', secret: '', atMobiles: [], atAll: false },
    feishu: { enabled: false, webhookUrl: '', secret: '' },
    slackProxy: { enabled: false, forwardToDingTalk: true, forwardToFeishu: true },
    onAlert: () => {},
  }

  constructor() {
    this.loadFromStorage()
    this.cronFields = parseCron(this.scheduler.cronExpression)
  }

  // === 通知方法（全部通过 /proxy 代理） ===

  async sendSlackNotification(text: string, type: 'warning' | 'error' | 'success' = 'success') {
    if (!this.alert.slackEnabled || !this.alert.slackWebhookUrl) return
    const emoji = { warning: '⚠️', error: '❌', success: '✅' }[type]
    try {
      await proxyFetch(this.alert.slackWebhookUrl, JSON.stringify({
        text: `${emoji} *NetworkPanel 测速告警*`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `${emoji} 测速告警`, emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `🕐 ${new Date().toLocaleString()}` }] },
        ]
      }))
      if (this.alert.slackProxy.enabled) {
        if (this.alert.slackProxy.forwardToDingTalk) await this.sendDingTalkNotification(text, type)
        if (this.alert.slackProxy.forwardToFeishu) await this.sendFeishuNotification(text, type)
      }
    } catch (err) { console.error('Slack notification failed:', err) }
  }

  async sendSlackTable(record: SpeedTestRecord, reason: string) {
    if (!this.alert.slackEnabled || !this.alert.slackWebhookUrl) return
    try {
      const r = STOP_REASONS[reason] || reason
      await proxyFetch(this.alert.slackWebhookUrl, JSON.stringify({
        text: '✅ *NetworkPanel 测速结果*',
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '✅ 测速结果', emoji: true } },
          { type: 'section', fields: [
            { type: 'mrkdwn', text: `*停止原因*\n${r}` },
            { type: 'mrkdwn', text: `*测速时长*\n${this.formatDuration(record.duration)}` },
            { type: 'mrkdwn', text: `*使用流量*\n${this.formatBytes(record.bytesUsed)}` },
            { type: 'mrkdwn', text: `*平均速度*\n${this.formatSpeed(record.avgSpeed)}` },
            { type: 'mrkdwn', text: `*平均带宽*\n${this.formatBandwidth(record.avgBandwidth)}` },
            { type: 'mrkdwn', text: `*峰值速度*\n${this.formatSpeed(record.peakSpeed)}` },
          ]},
          { type: 'context', elements: [{ type: 'mrkdwn', text: `🕐 ${new Date(record.timestamp).toLocaleString()}` }] },
        ]
      }))
      if (this.alert.slackProxy.enabled) {
        if (this.alert.slackProxy.forwardToDingTalk) await this.sendDingTalkTable(record, reason)
        if (this.alert.slackProxy.forwardToFeishu) await this.sendFeishuTable(record, reason)
      }
    } catch (err) { console.error('Slack table notification failed:', err) }
  }

  async sendDingTalkNotification(text: string, type: 'warning' | 'error' | 'success' = 'success') {
    if (!this.alert.dingtalk.enabled || !this.alert.dingtalk.webhookUrl) return
    const emoji = { warning: '⚠️', error: '❌', success: '✅' }[type]
    const title = `${emoji} NetworkPanel 测速告警`
    try {
      let url = this.alert.dingtalk.webhookUrl
      if (this.alert.dingtalk.secret) {
        const ts = Date.now()
        const sign = await dingTalkSign(this.alert.dingtalk.secret, ts)
        url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(sign)}`
      }
      const fullText = `${title}\n\n${text}\n\n🕐 ${new Date().toLocaleString()}`
      const at = { atMobiles: this.alert.dingtalk.atMobiles || [], isAtAll: this.alert.dingtalk.atAll || false }
      const result = await proxyFetch(url, JSON.stringify({ msgtype: 'markdown', markdown: { title, text: fullText }, at }))
      if (result.errcode && result.errcode !== 0) {
        await proxyFetch(url, JSON.stringify({ msgtype: 'text', text: { content: fullText }, at }))
      }
    } catch (err) { console.error('DingTalk notification failed:', err) }
  }

  async sendFeishuNotification(text: string, type: 'warning' | 'error' | 'success' = 'success') {
    if (!this.alert.feishu.enabled || !this.alert.feishu.webhookUrl) return
    const emoji = { warning: '⚠️', error: '❌', success: '✅' }[type]
    const title = `${emoji} NetworkPanel 测速告警`
    try {
      let url = this.alert.feishu.webhookUrl
      if (this.alert.feishu.secret) {
        const ts = Math.floor(Date.now() / 1000).toString()
        const str = `${ts}\n${this.alert.feishu.secret}`
        const enc = new TextEncoder()
        const key = await crypto.subtle.importKey('raw', enc.encode(str), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(str))
        const sign = btoa(String.fromCharCode(...new Uint8Array(sig)))
        url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(sign)}`
      }
      const fullText = `${title}\n\n${text}\n\n🕐 ${new Date().toLocaleString()}`
      const result = await proxyFetch(url, JSON.stringify({
        msg_type: 'interactive',
        card: { header: { title: { tag: 'plain_text', content: title }, template: type === 'error' ? 'red' : type === 'warning' ? 'orange' : 'green' }, elements: [{ tag: 'markdown', content: fullText }] }
      }))
      if (result.code && result.code !== 0) {
        await proxyFetch(url, JSON.stringify({ msg_type: 'text', content: { text: fullText } }))
      }
    } catch (err) { console.error('Feishu notification failed:', err) }
  }

  async sendDingTalkTable(record: SpeedTestRecord, reason: string) {
    if (!this.alert.dingtalk.enabled || !this.alert.dingtalk.webhookUrl) return
    try {
      let url = this.alert.dingtalk.webhookUrl
      if (this.alert.dingtalk.secret) {
        const ts = Date.now()
        const sign = await dingTalkSign(this.alert.dingtalk.secret, ts)
        url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(sign)}`
      }
      const title = '✅ NetworkPanel 测速结果'
      const text = buildResultText(record, reason, this)
      const at = { atMobiles: this.alert.dingtalk.atMobiles || [], isAtAll: this.alert.dingtalk.atAll || false }
      const result = await proxyFetch(url, JSON.stringify({ msgtype: 'markdown', markdown: { title, text }, at }))
      if (result.errcode && result.errcode !== 0) {
        await proxyFetch(url, JSON.stringify({ msgtype: 'text', text: { content: text }, at }))
      }
    } catch (err) { console.error('DingTalk table failed:', err) }
  }

  async sendFeishuTable(record: SpeedTestRecord, reason: string) {
    if (!this.alert.feishu.enabled || !this.alert.feishu.webhookUrl) return
    try {
      let url = this.alert.feishu.webhookUrl
      if (this.alert.feishu.secret) {
        const ts = Math.floor(Date.now() / 1000).toString()
        const str = `${ts}\n${this.alert.feishu.secret}`
        const enc = new TextEncoder()
        const key = await crypto.subtle.importKey('raw', enc.encode(str), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(str))
        const sign = btoa(String.fromCharCode(...new Uint8Array(sig)))
        url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(sign)}`
      }
      const content = buildResultText(record, reason, this)
      const result = await proxyFetch(url, JSON.stringify({
        msg_type: 'interactive',
        card: { header: { title: { tag: 'plain_text', content: '✅ NetworkPanel 测速结果' }, template: 'green' }, elements: [{ tag: 'markdown', content }] }
      }))
      if (result.code && result.code !== 0) {
        await proxyFetch(url, JSON.stringify({ msg_type: 'text', content: { text: content } }))
      }
    } catch (err) { console.error('Feishu table failed:', err) }
  }

  async broadcastAlert(text: string, type: 'warning' | 'error' | 'success' = 'success') {
    await Promise.allSettled([
      this.alert.slackEnabled && this.alert.slackWebhookUrl ? this.sendSlackNotification(text, type) : null,
      this.alert.dingtalk.enabled && this.alert.dingtalk.webhookUrl ? this.sendDingTalkNotification(text, type) : null,
      this.alert.feishu.enabled && this.alert.feishu.webhookUrl ? this.sendFeishuNotification(text, type) : null,
    ].filter(Boolean))
  }

  async broadcastTable(record: SpeedTestRecord, reason: string) {
    await Promise.allSettled([
      this.alert.slackEnabled && this.alert.slackWebhookUrl ? this.sendSlackTable(record, reason) : null,
      this.alert.dingtalk.enabled && this.alert.dingtalk.webhookUrl ? this.sendDingTalkTable(record, reason) : null,
      this.alert.feishu.enabled && this.alert.feishu.webhookUrl ? this.sendFeishuTable(record, reason) : null,
    ].filter(Boolean))
  }

  setCallbacks(onStart: () => void, onStop: (reason: string) => void, onRecord: (record: SpeedTestRecord) => void) {
    this.onStart = onStart; this.onStop = onStop; this.onRecord = onRecord
  }

  setCronExpression(expr: string): boolean {
    const parsed = parseCron(expr)
    if (!parsed) return false
    this.scheduler.cronExpression = expr; this.cronFields = parsed; return true
  }

  startScheduler() {
    if (!this.scheduler.enabled) return
    this.cronFields = parseCron(this.scheduler.cronExpression)
    this.currentRound = 0; this.scheduleNext()
  }

  stopScheduler() {
    if (this.schedulerTimer) { clearTimeout(this.schedulerTimer); this.schedulerTimer = null }
    if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null }
    this.isRunning = false
  }

  onTestStart(bytesUsed: number) {
    this.testStartTime = Date.now(); this.testStartBytes = bytesUsed
    this.peakSpeed = 0; this.speedSamples = []; this.isRunning = true
    if (this.scheduler.durationMs > 0 && this.scheduler.enabled) {
      this.durationTimer = setTimeout(() => this.stopTest('schedule'), this.scheduler.durationMs)
    }
  }

  onTick(bytesUsed: number, currentSpeed: number): boolean {
    if (!this.isRunning) return false
    if (currentSpeed > 0) { this.speedSamples.push(currentSpeed); if (currentSpeed > this.peakSpeed) this.peakSpeed = currentSpeed }
    if (bytesUsed - this.testStartBytes >= this.scheduler.trafficLimitBytes) { this.stopTest('traffic_limit'); return true }
    if (this.alert.enabled && this.alert.minSpeed > 0) {
      const recent = this.speedSamples.slice(-5)
      if (recent.length >= 5) {
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length
        if (avg < this.alert.minSpeed && avg > 0) {
          const msg = `⚠️ 速度告警：当前速度 ${this.formatSpeed(avg)} 低于阈值 ${this.formatSpeed(this.alert.minSpeed)}`
          this.alert.onAlert(msg, 'warning')
          this.broadcastAlert(`*速度告警*\n• 当前速度: ${this.formatSpeed(avg)}\n• 阈值: ${this.formatSpeed(this.alert.minSpeed)}`, 'warning')
        }
      }
    }
    return false
  }

  onTestEnd(bytesUsed: number, reason: 'manual' | 'traffic_limit' | 'schedule' | 'alert' = 'manual') {
    if (!this.isRunning && reason === 'manual') return
    this.isRunning = false
    if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null }
    const duration = (Date.now() - this.testStartTime) / 1000
    const testBytes = bytesUsed - this.testStartBytes
    const avgSpeed = duration > 0 ? testBytes / duration : 0
    const record: SpeedTestRecord = { timestamp: this.testStartTime, duration, bytesUsed: testBytes, avgSpeed, avgBandwidth: avgSpeed * 8, peakSpeed: this.peakSpeed, stopped: reason }
    this.records.push(record); this.saveToStorage()
    if (this.onRecord) this.onRecord(record)
    if (this.alert.enabled) {
      const msg = `✅ 测速完成（${STOP_REASONS[reason]}）\n时长: ${this.formatDuration(duration)}\n流量: ${this.formatBytes(testBytes)}\n平均速度: ${this.formatSpeed(avgSpeed)}\n平均带宽: ${this.formatBandwidth(avgSpeed * 8)}\n峰值速度: ${this.formatSpeed(this.peakSpeed)}`
      this.alert.onAlert(msg, 'success')
      this.broadcastTable(record, reason)
    }
  }

  stopTest(reason: 'manual' | 'traffic_limit' | 'schedule' | 'alert' = 'manual') { if (this.onStop) this.onStop(reason) }

  getStats() {
    if (this.records.length === 0) return { totalTests: 0, avgSpeed: 0, avgBandwidth: 0, avgDuration: 0, totalTraffic: 0, peakSpeed: 0, recentRecords: [] }
    const ts = this.records.reduce((s, r) => s + r.avgSpeed, 0)
    const td = this.records.reduce((s, r) => s + r.duration, 0)
    const tt = this.records.reduce((s, r) => s + r.bytesUsed, 0)
    const ps = Math.max(...this.records.map(r => r.peakSpeed))
    return { totalTests: this.records.length, avgSpeed: ts / this.records.length, avgBandwidth: (ts / this.records.length) * 8, avgDuration: td / this.records.length, totalTraffic: tt, peakSpeed: ps, recentRecords: this.records.slice(-20).reverse() }
  }

  clearRecords() { this.records = []; this.saveToStorage() }
  getIsRunning() { return this.isRunning }

  private scheduleNext() {
    if (!this.scheduler.enabled) return
    const delay = this.cronFields ? (nextCronDelay(this.cronFields) || 60000) : 60000
    this.schedulerTimer = setTimeout(() => {
      this.currentRound++
      if (this.scheduler.maxRounds > 0 && this.currentRound > this.scheduler.maxRounds) { this.stopScheduler(); if (this.alert.enabled) this.alert.onAlert(`🔔 定时测速已完成 ${this.scheduler.maxRounds} 轮`, 'success'); return }
      if (this.onStart) this.onStart()
      this.scheduleNext()
    }, delay)
  }

  private saveToStorage() {
    try {
      localStorage.setItem('speedTestRecords', JSON.stringify(this.records.slice(-100)))
      localStorage.setItem('speedTestScheduler', JSON.stringify(this.scheduler))
      localStorage.setItem('speedTestAlert', JSON.stringify({ enabled: this.alert.enabled, minSpeed: this.alert.minSpeed, maxLatency: this.alert.maxLatency, slackWebhookUrl: this.alert.slackWebhookUrl, slackEnabled: this.alert.slackEnabled, dingtalk: this.alert.dingtalk, feishu: this.alert.feishu, slackProxy: this.alert.slackProxy }))
    } catch { this.records = this.records.slice(-20); try { localStorage.setItem('speedTestRecords', JSON.stringify(this.records)) } catch {} }
  }

  private loadFromStorage() {
    try {
      const r = localStorage.getItem('speedTestRecords'); if (r) this.records = JSON.parse(r)
      const s = localStorage.getItem('speedTestScheduler'); if (s) Object.assign(this.scheduler, JSON.parse(s))
      const a = localStorage.getItem('speedTestAlert')
      if (a) {
        const d = JSON.parse(a)
        this.alert.enabled = d.enabled ?? false; this.alert.minSpeed = d.minSpeed ?? 0; this.alert.maxLatency = d.maxLatency ?? 0
        this.alert.slackWebhookUrl = d.slackWebhookUrl ?? ''; this.alert.slackEnabled = d.slackEnabled ?? false
        if (d.dingtalk) this.alert.dingtalk = { enabled: d.dingtalk.enabled ?? false, webhookUrl: d.dingtalk.webhookUrl ?? '', secret: d.dingtalk.secret ?? '', atMobiles: d.dingtalk.atMobiles ?? [], atAll: d.dingtalk.atAll ?? false }
        if (d.feishu) this.alert.feishu = { enabled: d.feishu.enabled ?? false, webhookUrl: d.feishu.webhookUrl ?? '', secret: d.feishu.secret ?? '' }
        if (d.slackProxy) this.alert.slackProxy = { enabled: d.slackProxy.enabled ?? false, forwardToDingTalk: d.slackProxy.forwardToDingTalk ?? true, forwardToFeishu: d.slackProxy.forwardToFeishu ?? true }
      }
    } catch (e) { console.warn('Failed to load config:', e) }
  }

  formatBytes(bytes: number): string { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = bytes; while (v >= 1024 && i < 4) { v /= 1024; i++ } return v.toFixed(i > 1 ? 2 : 0) + u[i] }
  formatSpeed(bps: number): string { const u = ['B/s', 'KB/s', 'MB/s', 'GB/s']; let i = 0, v = bps; while (v >= 1024 && i < 4) { v /= 1024; i++ } return v.toFixed(i > 1 ? 2 : 0) + u[i] }
  formatBandwidth(bps: number): string { const u = ['bps', 'Kbps', 'Mbps', 'Gbps']; let i = 0, v = bps; while (v >= 1000 && i < 4) { v /= 1000; i++ } return v.toFixed(i > 1 ? 2 : 0) + u[i] }
  formatDuration(seconds: number): string { if (seconds < 60) return seconds.toFixed(0) + '秒'; const m = seconds / 60; if (m < 60) return m.toFixed(1) + '分钟'; return (m / 60).toFixed(1) + '小时' }
}

export default SpeedTestScheduler
