<template>
  <el-dialog style="width: 90%;max-width: 700px;" v-model="visible" title="📊 测速统计与告警">
    <!-- 统计概览 -->
    <div class="stats-overview">
      <el-row :gutter="12">
        <el-col :span="8">
          <div class="stat-card">
            <div class="stat-value">{{ stats.totalTests }}</div>
            <div class="stat-label">总测速次数</div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="stat-card highlight">
            <div class="stat-value">{{ formatSpeed(stats.avgSpeed) }}</div>
            <div class="stat-label">历史平均速度</div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="stat-card">
            <div class="stat-value">{{ formatBandwidth(stats.avgBandwidth) }}</div>
            <div class="stat-label">历史平均带宽</div>
          </div>
        </el-col>
      </el-row>
      <el-row :gutter="12" style="margin-top: 10px;">
        <el-col :span="8">
          <div class="stat-card">
            <div class="stat-value">{{ formatBytes(stats.totalTraffic) }}</div>
            <div class="stat-label">累计流量</div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="stat-card">
            <div class="stat-value">{{ formatSpeed(stats.peakSpeed) }}</div>
            <div class="stat-label">历史峰值速度</div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="stat-card">
            <div class="stat-value">{{ formatDuration(stats.avgDuration) }}</div>
            <div class="stat-label">平均测速时长</div>
          </div>
        </el-col>
      </el-row>
    </div>

    <!-- 定时测速配置 -->
    <el-divider content-position="left">⏰ 定时测速配置</el-divider>
    <el-form label-width="100px" size="small">
      <el-form-item label="启用定时测速">
        <el-switch v-model="schedulerConfig.enabled" @change="onSchedulerChange" />
      </el-form-item>
      <template v-if="schedulerConfig.enabled">
        <el-form-item label="测速间隔">
          <el-input-number v-model="intervalValue" :min="1" :max="999" style="width: 120px;" />
          <el-select v-model="intervalUnit" style="width: 80px; margin-left: 8px;">
            <el-option label="秒" value="s" />
            <el-option label="分钟" value="m" />
            <el-option label="小时" value="h" />
          </el-select>
        </el-form-item>
        <el-form-item label="单次时长">
          <el-input-number v-model="durationValue" :min="0" :max="999" style="width: 120px;" />
          <el-select v-model="durationUnit" style="width: 80px; margin-left: 8px;">
            <el-option label="秒" value="s" />
            <el-option label="分钟" value="m" />
            <el-option label="不限" value="unlimited" />
          </el-select>
          <span style="margin-left: 8px; color: #909399; font-size: 12px;">0 = 不限制</span>
        </el-form-item>
        <el-form-item label="流量上限">
          <el-tag type="warning">单次 5 GB</el-tag>
          <span style="margin-left: 8px; color: #909399; font-size: 12px;">达到后自动停止</span>
        </el-form-item>
        <el-form-item label="最大轮次">
          <el-input-number v-model="schedulerConfig.maxRounds" :min="0" :max="9999" style="width: 120px;" />
          <span style="margin-left: 8px; color: #909399; font-size: 12px;">0 = 无限循环</span>
        </el-form-item>
      </template>
    </el-form>

    <!-- 告警配置 -->
    <el-divider content-position="left">🔔 告警设置</el-divider>
    <el-form label-width="100px" size="small">
      <el-form-item label="启用告警">
        <el-switch v-model="alertConfig.enabled" @change="onAlertChange" />
      </el-form-item>
      <template v-if="alertConfig.enabled">
        <el-form-item label="最低速度">
          <el-input-number v-model="minSpeedValue" :min="0" :max="99999" :step="1" style="width: 120px;" />
          <el-select v-model="minSpeedUnit" style="width: 80px; margin-left: 8px;">
            <el-option label="KB/s" value="KB" />
            <el-option label="MB/s" value="MB" />
          </el-select>
          <span style="margin-left: 8px; color: #909399; font-size: 12px;">低于此速度触发告警</span>
        </el-form-item>
      </template>
    </el-form>

    <!-- Slack 告警配置 -->
    <el-divider content-position="left">💬 Slack Webhook 告警</el-divider>
    <el-form label-width="100px" size="small">
      <el-form-item label="启用 Slack">
        <el-switch v-model="alertConfig.slackEnabled" @change="onAlertChange" />
      </el-form-item>
      <template v-if="alertConfig.slackEnabled">
        <el-form-item label="Webhook URL">
          <el-input v-model="alertConfig.slackWebhookUrl" placeholder="https://hooks.slack.com/services/..." @change="onAlertChange" />
        </el-form-item>
        <el-form-item>
          <el-alert type="info" :closable="false">
            在 Slack 中创建 Incoming Webhook：设置 → 应用 → Incoming Webhooks → 添加新 Webhook 到工作区
          </el-alert>
        </el-form-item>
      </template>
    </el-form>

    <!-- 告警历史 & 测速记录 -->
    <el-divider content-position="left">📋 最近测速记录</el-divider>
    <el-table :data="stats.recentRecords" size="small" max-height="300" stripe>
      <el-table-column label="时间" width="150">
        <template #default="scope">
          {{ new Date(scope.row.timestamp).toLocaleString() }}
        </template>
      </el-table-column>
      <el-table-column label="时长" width="80">
        <template #default="scope">
          {{ formatDuration(scope.row.duration) }}
        </template>
      </el-table-column>
      <el-table-column label="流量" width="90">
        <template #default="scope">
          {{ formatBytes(scope.row.bytesUsed) }}
        </template>
      </el-table-column>
      <el-table-column label="平均速度" width="100">
        <template #default="scope">
          {{ formatSpeed(scope.row.avgSpeed) }}
        </template>
      </el-table-column>
      <el-table-column label="平均带宽" width="100">
        <template #default="scope">
          {{ formatBandwidth(scope.row.avgBandwidth) }}
        </template>
      </el-table-column>
      <el-table-column label="峰值速度" width="100">
        <template #default="scope">
          {{ formatSpeed(scope.row.peakSpeed) }}
        </template>
      </el-table-column>
      <el-table-column label="停止原因" width="90">
        <template #default="scope">
          <el-tag :type="stopReasonType(scope.row.stopped)" size="small">
            {{ stopReasonText(scope.row.stopped) }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <div style="display: flex; justify-content: space-between;">
        <el-button type="danger" size="small" @click="clearRecords">清除记录</el-button>
        <el-button @click="visible = false">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessageBox } from 'element-plus'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  stats: {
    type: Object,
    default: () => ({
      totalTests: 0,
      avgSpeed: 0,
      avgBandwidth: 0,
      avgDuration: 0,
      totalTraffic: 0,
      peakSpeed: 0,
      recentRecords: [],
    }),
  },
  schedulerConfig: {
    type: Object,
    default: () => ({
      enabled: false,
      intervalMs: 3600000,
      durationMs: 300000,
      trafficLimitBytes: 5 * 1024 * 1024 * 1024,
      maxRounds: 0,
    }),
  },
  alertConfig: {
    type: Object,
    default: () => ({
      enabled: false,
      minSpeed: 0,
    }),
  },
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'scheduler-change', config: any): void
  (e: 'alert-change', config: any): void
  (e: 'clear-records'): void
}>()

const visible = ref(props.modelValue)
watch(() => props.modelValue, (v) => { visible.value = v })
watch(visible, (v) => { emit('update:modelValue', v) })

// 定时配置本地状态
const schedulerConfig = ref({ ...props.schedulerConfig })
watch(() => props.schedulerConfig, (v) => { schedulerConfig.value = { ...v } }, { deep: true })

const intervalUnit = ref('m')
const intervalValue = ref(60)
const durationUnit = ref('m')
const durationValue = ref(5)

// 从ms还原显示值
const restoreInterval = () => {
  const ms = schedulerConfig.value.intervalMs
  if (ms >= 3600000 && ms % 3600000 === 0) {
    intervalValue.value = ms / 3600000
    intervalUnit.value = 'h'
  } else if (ms >= 60000 && ms % 60000 === 0) {
    intervalValue.value = ms / 60000
    intervalUnit.value = 'm'
  } else {
    intervalValue.value = ms / 1000
    intervalUnit.value = 's'
  }
}
const restoreDuration = () => {
  const ms = schedulerConfig.value.durationMs
  if (ms <= 0) {
    durationValue.value = 0
    durationUnit.value = 'unlimited'
  } else if (ms >= 60000 && ms % 60000 === 0) {
    durationValue.value = ms / 60000
    durationUnit.value = 'm'
  } else {
    durationValue.value = ms / 1000
    durationUnit.value = 's'
  }
}
restoreInterval()
restoreDuration()

const toMs = (val: number, unit: string) => {
  if (unit === 's') return val * 1000
  if (unit === 'm') return val * 60000
  if (unit === 'h') return val * 3600000
  return 0
}

const onSchedulerChange = () => {
  schedulerConfig.value.intervalMs = toMs(intervalValue.value, intervalUnit.value)
  schedulerConfig.value.durationMs = durationUnit.value === 'unlimited' ? 0 : toMs(durationValue.value, durationUnit.value)
  emit('scheduler-change', { ...schedulerConfig.value })
}

// 告警配置
const alertConfig = ref({ ...props.alertConfig })
watch(() => props.alertConfig, (v) => { alertConfig.value = { ...v } }, { deep: true })

const minSpeedUnit = ref('MB')
const minSpeedValue = ref(1)

const onAlertChange = () => {
  const bytesPerSec = minSpeedUnit.value === 'MB'
    ? minSpeedValue.value * 1024 * 1024
    : minSpeedValue.value * 1024
  alertConfig.value.minSpeed = bytesPerSec
  emit('alert-change', { ...alertConfig.value })
}

const clearRecords = () => {
  ElMessageBox.confirm('确定清除所有测速记录？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning',
  }).then(() => {
    emit('clear-records')
  }).catch(() => {})
}

const stopReasonText = (reason: string) => {
  const map: Record<string, string> = {
    manual: '手动',
    traffic_limit: '流量上限',
    schedule: '定时结束',
    alert: '告警触发',
  }
  return map[reason] || reason
}

const stopReasonType = (reason: string) => {
  const map: Record<string, string> = {
    manual: 'info',
    traffic_limit: 'warning',
    schedule: 'success',
    alert: 'danger',
  }
  return map[reason] || 'info'
}

const formatBytes = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let idx = 0, val = bytes
  while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++ }
  return val.toFixed(idx > 1 ? 2 : 0) + units[idx]
}
const formatSpeed = (bps: number) => {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let idx = 0, val = bps
  while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++ }
  return val.toFixed(idx > 1 ? 2 : 0) + units[idx]
}
const formatBandwidth = (bps: number) => {
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps']
  let idx = 0, val = bps
  while (val >= 1000 && idx < units.length - 1) { val /= 1000; idx++ }
  return val.toFixed(idx > 1 ? 2 : 0) + units[idx]
}
const formatDuration = (seconds: number) => {
  if (seconds < 60) return seconds.toFixed(0) + '秒'
  const mins = seconds / 60
  if (mins < 60) return mins.toFixed(1) + '分钟'
  return (mins / 60).toFixed(1) + '小时'
}
</script>

<style scoped>
.stats-overview {
  margin-bottom: 10px;
}
.stat-card {
  text-align: center;
  padding: 12px 8px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  background: #fafafa;
}
.stat-card.highlight {
  border-color: #409eff;
  background: #ecf5ff;
}
.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: #303133;
}
.stat-label {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
@media (prefers-color-scheme: dark) {
  .stat-card {
    background: #1d1e1f;
    border-color: #4c4d4f;
  }
  .stat-card.highlight {
    background: #18222c;
    border-color: #409eff;
  }
  .stat-value {
    color: #e5eaf3;
  }
}
</style>
