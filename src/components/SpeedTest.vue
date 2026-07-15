<template>
  <el-dialog style="width: 90%;max-width: 500px;" v-model="visible" title="🚀 一键测速">
    <div style="text-align: center;">
      <!-- 测速仪表盘 -->
      <div ref="chartRef" style="width: 100%; height: 280px;"></div>

      <!-- 测速结果 -->
      <div v-if="phase === 'done'" style="margin-top: -20px;">
        <el-row :gutter="12">
          <el-col :span="6">
            <div class="result-item">
              <div class="result-value">{{ result.download || '-' }}</div>
              <div class="result-unit">Mbps ↓</div>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="result-item">
              <div class="result-value">{{ result.upload || '-' }}</div>
              <div class="result-unit">Mbps ↑</div>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="result-item">
              <div class="result-value">{{ result.ping || '-' }}</div>
              <div class="result-unit">ms 延迟</div>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="result-item">
              <div class="result-value">{{ result.jitter || '-' }}</div>
              <div class="result-unit">ms 抖动</div>
            </div>
          </el-col>
        </el-row>
      </div>

      <!-- 当前状态 -->
      <div style="margin-top: 16px;">
        <el-text v-if="phase === 'idle'" type="info">点击开始测速</el-text>
        <el-text v-if="phase === 'ping'" type="warning">正在测试延迟... {{ currentLatency }}ms</el-text>
        <el-text v-if="phase === 'download'" type="primary">下载测速中... {{ currentSpeed }} Mbps</el-text>
        <el-text v-if="phase === 'upload'" type="success">上传测速中... {{ currentSpeed }} Mbps</el-text>
        <el-text v-if="phase === 'done'" type="success">✅ 测速完成</el-text>
      </div>

      <!-- 节点选择 -->
      <div style="margin-top: 16px;">
        <el-select v-model="selectedNode" style="width: 100%;" :disabled="testing">
          <el-option label="Cloudflare 全球节点" value="cloudflare" />
          <el-option label="字节CDN 节点" value="bytecdn" />
          <el-option label="自定义节点" value="custom" />
        </el-select>
      </div>

      <!-- 操作按钮 -->
      <div style="margin-top: 20px;">
        <el-button v-if="!testing" type="primary" size="large" @click="startTest" round>
          {{ phase === 'done' ? '再次测速' : '一键测速' }}
        </el-button>
        <el-button v-else type="danger" size="large" @click="stopTest" round>
          停止测速
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const visible = ref(props.modelValue)
watch(() => props.modelValue, (v) => { visible.value = v })
watch(visible, (v) => { emit('update:modelValue', v) })

const chartRef = ref<HTMLElement | null>(null)
const phase = ref('idle')
const testing = ref(false)
const currentSpeed = ref('0.00')
const currentLatency = ref(0)
const selectedNode = ref('cloudflare')

const result = ref({
  download: 0,
  upload: 0,
  ping: 0,
  jitter: 0,
})

let chart: echarts.ECharts | null = null
let worker: Worker | null = null

const NODES: Record<string, any> = {
  cloudflare: {
    downloadUrl: 'https://speed.cloudflare.com/__down?bytes=25000000',
    uploadUrl: 'https://speed.cloudflare.com/__up',
    pingUrl: 'https://speed.cloudflare.com/__down?bytes=0',
    streams: 6,
    downloadTime: 10,
    uploadTime: 10,
  },
  bytecdn: {
    downloadUrl: 'https://lf9-apk.ugapk.cn/package/apk/aweme/5072_340301/aweme_douyin-huidu-gw-aweme-3430_v5072_340301_eea8_1747058635.apk',
    uploadUrl: 'https://speed.cloudflare.com/__up',
    pingUrl: 'https://lf3-cdn-tos.bytecdntp.com/',
    streams: 4,
    downloadTime: 10,
    uploadTime: 10,
  },
}

function initChart() {
  if (!chartRef.value) return
  chart = echarts.init(chartRef.value)
  chart.setOption({
    series: [{
      type: 'gauge',
      startAngle: 220,
      endAngle: -40,
      min: 0,
      max: 1000,
      progress: { show: true, width: 18, itemStyle: { color: '#409eff' } },
      axisLine: { lineStyle: { width: 18, color: [[1, '#e4e7ed']] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      detail: {
        valueAnimation: true,
        fontSize: 36,
        fontWeight: 'bold',
        formatter: '{value}',
        offsetCenter: [0, '10%'],
        color: '#303133',
      },
      title: {
        fontSize: 14,
        offsetCenter: [0, '45%'],
        color: '#909399',
      },
      data: [{ value: 0, name: 'Mbps' }],
    }],
  })
}

function updateGauge(value: number, label: string) {
  if (!chart) return
  // 自动调整刻度
  var max = 100
  if (value > 100) max = 500
  if (value > 500) max = 1000
  if (value > 1000) max = 5000
  if (value > 5000) max = 10000

  chart.setOption({
    series: [{
      max: max,
      data: [{ value: parseFloat(value.toFixed(1)), name: label }],
      axisLine: {
        lineStyle: {
          color: [
            [0.3, '#67c23a'],
            [0.7, '#e6a23c'],
            [1, '#f56c6c'],
            [1, '#e4e7ed'],
          ]
        }
      },
    }]
  })
}

function startTest() {
  if (testing.value) return
  testing.value = true
  phase.value = 'idle'
  result.value = { download: 0, upload: 0, ping: 0, jitter: 0 }
  currentSpeed.value = '0.00'
  currentLatency.value = 0
  updateGauge(0, 'Mbps')

  const nodeConfig = NODES[selectedNode.value] || NODES.cloudflare

  worker = new Worker('/speedtest-worker.js')
  worker.onmessage = function (e) {
    const msg = e.data
    if (msg.type === 'status') {
      const d = msg.data
      phase.value = d.phase

      if (d.phase === 'download' || d.phase === 'upload') {
        currentSpeed.value = d.speed || '0.00'
        updateGauge(parseFloat(d.speed) || 0, d.phase === 'download' ? '下载 Mbps' : '上传 Mbps')
      }
      if (d.phase === 'ping') {
        currentLatency.value = d.latency || 0
      }
      if (d.phase === 'done') {
        testing.value = false
      }
    } else if (msg.type === 'result') {
      result.value = msg.data
      updateGauge(msg.data.download || 0, '下载 Mbps')
    } else if (msg.type === 'error') {
      console.error('SpeedTest error:', msg.data.message)
      testing.value = false
      phase.value = 'idle'
    }
  }

  worker.postMessage({
    cmd: 'start',
    order: 'P_D_U',
    settings: nodeConfig,
  })
}

function stopTest() {
  if (worker) {
    worker.postMessage({ cmd: 'stop' })
    worker.terminate()
    worker = null
  }
  testing.value = false
  phase.value = 'idle'
}

watch(visible, (v) => {
  if (v) {
    nextTick(() => {
      initChart()
    })
  }
})

onMounted(() => {
  if (visible.value) initChart()
})
</script>

<style scoped>
.result-item {
  text-align: center;
  padding: 8px 4px;
}
.result-value {
  font-size: 24px;
  font-weight: 700;
  color: #303133;
}
.result-unit {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
@media (prefers-color-scheme: dark) {
  .result-value {
    color: #e5eaf3;
  }
}
</style>
