/**
 * SpeedTestScheduler - 定时测速调度器
 * 功能：
 * 1. 定时启动/停止测速
 * 2. 单次测速流量上限（默认2GB）
 * 3. 历史测速记录与平均速度计算
 * 4. 速度告警阈值检测
 */

export interface SpeedTestRecord {
  timestamp: number        // 测速时间戳
  duration: number         // 持续时间(秒)
  bytesUsed: number        // 使用流量(字节)
  avgSpeed: number         // 平均速度(B/s)
  avgBandwidth: number     // 平均带宽(bps)
  peakSpeed: number        // 峰值速度(B/s)
  stopped: 'manual' | 'traffic_limit' | 'schedule' | 'alert'  // 停止原因
}

export interface AlertConfig {
  enabled: boolean
  minSpeed: number         // 最低速度阈值(B/s)，低于此值告警
  maxLatency: number       // 最大延迟阈值(ms)
  slackWebhookUrl: string  // Slack Incoming Webhook URL
  slackEnabled: boolean    // 是否启用 Slack 告警
  onAlert: (message: string, type: 'warning' | 'error' | 'success') => void
}

export interface SchedulerConfig {
  enabled: boolean
  intervalMs: number       // 测速间隔(毫秒)
  cronExpression: string   // cron 表达式，如 "0 */30 * * * *" 表示每30分钟
  durationMs: number       // 每次测速持续时间(毫秒)，0=无限
  trafficLimitBytes: number // 单次测速流量上限(字节)
  maxRounds: number        // 最大测速轮次，0=无限
}

const TWO_GB = 2 * 1024 * 1024 * 1024

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

  // 回调函数
  private onStart: (() => void) | null = null
  private onStop: ((reason: string) => void) | null = null
  private onRecord: ((record: SpeedTestRecord) => void) | null = null

  // 配置
  public scheduler: SchedulerConfig = {
    enabled: false,
    intervalMs: 3600000,
    cronExpression: '0 * * * *',     // 默认每小时整点
    durationMs: 300000,        // 默认5分钟
    trafficLimitBytes: TWO_GB,
    maxRounds: 0,
  }

  public alert: AlertConfig = {
    enabled: false,
    minSpeed: 0,
    maxLatency: 0,
    slackWebhookUrl: '',
    slackEnabled: false,
    onAlert: () => {},
  }

  constructor() {
    this.loadFromStorage()
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
    } catch (err) {
      console.error('Slack notification failed:', err)
    }
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
   * 开始定时测速调度
   */
  startScheduler() {
    if (!this.scheduler.enabled) return
    this.currentRound = 0
    this.scheduleNext()
  }

  /**
   * 停止定时调度
   */
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

  /**
   * 测速开始时调用 - 初始化本次测速追踪
   */
  onTestStart(bytesUsed: number) {
    this.testStartTime = Date.now()
    this.testStartBytes = bytesUsed
    this.peakSpeed = 0
    this.speedSamples = []
    this.isRunning = true

    // 如果设定了持续时间，启动定时停止
    if (this.scheduler.durationMs > 0 && this.scheduler.enabled) {
      this.durationTimer = setTimeout(() => {
        this.stopTest('schedule')
      }, this.scheduler.durationMs)
    }
  }

  /**
   * 每秒调用 - 检查流量限制和告警
   * @param bytesUsed 当前总字节数
   * @param currentSpeed 当前速度(B/s)
   * @returns 是否应该停止
   */
  onTick(bytesUsed: number, currentSpeed: number): boolean {
    if (!this.isRunning) return false

    // 记录速度样本
    if (currentSpeed > 0) {
      this.speedSamples.push(currentSpeed)
      if (currentSpeed > this.peakSpeed) {
        this.peakSpeed = currentSpeed
      }
    }

    // 检查单次流量限制
    const testBytesUsed = bytesUsed - this.testStartBytes
    if (testBytesUsed >= this.scheduler.trafficLimitBytes) {
      this.stopTest('traffic_limit')
      return true
    }

    // 检查速度告警
    if (this.alert.enabled && this.alert.minSpeed > 0) {
      // 使用最近5个样本的平均值避免抖动
      const recentSamples = this.speedSamples.slice(-5)
      if (recentSamples.length >= 5) {
        const avgRecent = recentSamples.reduce((a, b) => a + b, 0) / recentSamples.length
        if (avgRecent < this.alert.minSpeed && avgRecent > 0) {
          const alertMsg = `⚠️ 速度告警：当前速度 ${this.formatSpeed(avgRecent)} 低于阈值 ${this.formatSpeed(this.alert.minSpeed)}`
          this.alert.onAlert(alertMsg, 'warning')
          // Slack 告警
          this.sendSlackNotification(
            `*速度告警*\n• 当前速度: ${this.formatSpeed(avgRecent)}\n• 阈值: ${this.formatSpeed(this.alert.minSpeed)}`,
            'warning'
          )
        }
      }
    }

    return false
  }

  /**
   * 测速结束时调用 - 记录结果
   */
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

    // 完成通知
    const reasonText: Record<string, string> = {
      manual: '手动停止',
      traffic_limit: '流量达到上限',
      schedule: '定时结束',
      alert: '告警触发',
    }

    if (this.alert.enabled) {
      this.alert.onAlert(
        `✅ 测速完成（${reasonText[reason]}）\n` +
        `时长: ${this.formatDuration(duration)}\n` +
        `流量: ${this.formatBytes(testBytes)}\n` +
        `平均速度: ${this.formatSpeed(avgSpeed)}\n` +
        `平均带宽: ${this.formatBandwidth(avgSpeed * 8)}\n` +
        `峰值速度: ${this.formatSpeed(this.peakSpeed)}`,
        'success'
      )
      // Slack 通知
      this.sendSlackNotification(
        `*测速完成*（${reasonText[reason]}）\n` +
        `• 时长: ${this.formatDuration(duration)}\n` +
        `• 流量: ${this.formatBytes(testBytes)}\n` +
        `• 平均速度: ${this.formatSpeed(avgSpeed)}\n` +
        `• 平均带宽: ${this.formatBandwidth(avgSpeed * 8)}\n` +
        `• 峰值速度: ${this.formatSpeed(this.peakSpeed)}`,
        'success'
      )
    }
  }

  /**
   * 手动停止测速
   */
  stopTest(reason: 'manual' | 'traffic_limit' | 'schedule' | 'alert' = 'manual') {
    if (this.onStop) {
      this.onStop(reason)
    }
  }

  /**
   * 获取统计信息
   */
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

  /**
   * 清除历史记录
   */
  clearRecords() {
    this.records = []
    this.saveToStorage()
  }

  /**
   * 获取下次测速倒计时(ms)
   */
  getNextTestCountdown(): number {
    // 需要外部维护下次执行时间
    return 0
  }

  getIsRunning(): boolean {
    return this.isRunning
  }

  // === 私有方法 ===

  private scheduleNext() {
    if (!this.scheduler.enabled) return

    // Parse cron expression and calculate next fire time
    const nextDelay = this.cronToMs(this.scheduler.cronExpression)
    const delay = nextDelay > 0 ? nextDelay : this.scheduler.intervalMs

    this.schedulerTimer = setTimeout(() => {
      this.currentRound++
      if (this.scheduler.maxRounds > 0 && this.currentRound > this.scheduler.maxRounds) {
        this.stopScheduler()
        if (this.alert.enabled) {
          this.alert.onAlert(`\u{1F514} \u5b9a\u65f6\u6d4b\u901f\u5df2\u5b8c\u6210 ${this.scheduler.maxRounds} \u8f6e`, 'success')
        }
        return
      }

      if (this.onStart) {
        this.onStart()
      }

      // Schedule next round
      this.scheduleNext()
    }, delay)
  }

  /**
   * \u5c06 cron \u8868\u8fbe\u5f0f\u8f6c\u6362\u4e3a\u6beb\u79d2\u6570
   * \u652f\u6301\u6807\u51c6 5 \u4f4d cron: minute hour day month weekday
   * \u4f8b\u5982: "0 */30 * * *" = \u6bcf30\u5206\u949f
   *      "0 0 * * *" = \u6bcf\u5929\u5348\u591c
   */
  private cronToMs(cron: string): number {
    if (!cron || cron.trim() === '') return 0
    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return 0

    const [minute, hour, day, month, weekday] = parts

    // Handle */N minute intervals
    if (minute.startsWith('*/')) {
      const step = parseInt(minute.split('/')[1], 10)
      if (!isNaN(step) && step > 0 && step <= 60) {
        return step * 60 * 1000
      }
    }

    // Handle */N hour intervals
    if (hour.startsWith('*/')) {
      const step = parseInt(hour.split('/')[1], 10)
      if (!isNaN(step) && step > 0 && step <= 24) {
        return step * 60 * 60 * 1000
      }
    }

    // Default: parse as specific time
    const m = parseInt(minute, 10)
    const h = parseInt(hour, 10)
    if (!isNaN(m) && !isNaN(h) && m >= 0 && m < 60 && h >= 0 && h < 24) {
      const now = new Date()
      const next = new Date(now)
      next.setHours(h, m, 0, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      return next.getTime() - now.getTime()
    }

    return 0
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
      }))
    } catch (e) {
      // storage full, trim old records
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
