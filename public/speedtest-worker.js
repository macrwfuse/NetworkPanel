/**
 * SpeedTest Web Worker
 * 多流并发测速：下载 / 上传 / 延迟 / 抖动
 * 
 * 通信协议：
 *   主线程 → Worker: { cmd: 'start'|'stop'|'status', settings: {...} }
 *   Worker → 主线程: { type: 'status'|'result'|'error', data: {...} }
 */

var testState = 'idle' // idle | downloading | uploading | ping | done | stopped
var xhr = []
var totalLoaded = 0
var startTime = 0
var graceTimeDone = false
var interval = null

// 测速结果
var result = {
  download: 0,    // Mbps
  upload: 0,      // Mbps
  ping: 0,        // ms
  jitter: 0,      // ms
  downloadBytes: 0,
  uploadBytes: 0,
}

// 默认设置
var settings = {
  downloadUrl: 'https://speed.cloudflare.com/__down?bytes=25000000',
  uploadUrl: 'https://speed.cloudflare.com/__up',
  pingUrl: 'https://speed.cloudflare.com/__down?bytes=0',
  streams: 6,           // 并发流数
  downloadTime: 10,     // 下载测试时长(秒)
  uploadTime: 10,       // 上传测试时长(秒)
  pingCount: 10,        // ping 次数
  graceTime: 1,         // 预热时间(秒)
  overheadFactor: 1.0,  // 开销补偿系数
}

// === 工具函数 ===

function postStatus(data) {
  try {
    self.postMessage({ type: 'status', data: data })
  } catch (e) {}
}

function postResult() {
  try {
    self.postMessage({ type: 'result', data: JSON.parse(JSON.stringify(result)) })
  } catch (e) {}
}

function postError(msg) {
  try {
    self.postMessage({ type: 'error', data: { message: msg } })
  } catch (e) {}
}

function clearRequests() {
  for (var i = 0; i < xhr.length; i++) {
    try { xhr[i].abort() } catch (e) {}
  }
  xhr = []
  if (interval) { clearInterval(interval); interval = null }
}

// === 下载测速 ===

function startDownloadTest() {
  testState = 'downloading'
  totalLoaded = 0
  startTime = Date.now()
  graceTimeDone = false
  xhr = []
  result.downloadBytes = 0

  var streamStartTime = []
  var streamLoaded = []

  function startStream(streamId, delay) {
    setTimeout(function () {
      if (testState !== 'downloading') return
      streamStartTime[streamId] = Date.now()
      streamLoaded[streamId] = 0

      var req = new XMLHttpRequest()
      xhr[streamId] = req

      var url = settings.downloadUrl + (settings.downloadUrl.indexOf('?') >= 0 ? '&' : '?') + '_nocache=' + Math.random()

      req.onprogress = function (e) {
        if (testState !== 'downloading') { try { req.abort() } catch (x) {} return }
        var delta = e.loaded - streamLoaded[streamId]
        if (delta > 0 && !isNaN(delta) && isFinite(delta)) {
          totalLoaded += delta
          streamLoaded[streamId] = e.loaded
        }
      }

      req.onload = function () {
        if (testState === 'downloading') startStream(streamId, 0)
      }

      req.onerror = function () {
        if (testState === 'downloading') startStream(streamId, 1000)
      }

      req.open('GET', url, true)
      req.send()
    }, delay)
  }

  // 启动并发流
  for (var i = 0; i < settings.streams; i++) {
    startStream(i, i * 100)
  }

  // 每200ms计算速度
  interval = setInterval(function () {
    var elapsed = Date.now() - startTime

    if (!graceTimeDone) {
      if (elapsed > settings.graceTime * 1000) {
        if (totalLoaded > 0) {
          startTime = Date.now()
          totalLoaded = 0
        }
        graceTimeDone = true
      }
      postStatus({ phase: 'download', progress: 0, speed: 0, bytes: 0 })
      return
    }

    var bytesPerSec = totalLoaded / ((Date.now() - startTime) / 1000)
    var mbps = bytesPerSec * 8 * settings.overheadFactor / 1000000
    var progress = Math.min((Date.now() - startTime) / (settings.downloadTime * 1000), 1)

    result.downloadBytes = totalLoaded
    postStatus({ phase: 'download', progress: progress, speed: mbps.toFixed(2), bytes: totalLoaded })

    if (progress >= 1) {
      clearRequests()
      result.download = parseFloat(mbps.toFixed(2))
      testState = 'idle'
      postResult()
    }
  }, 200)
}

// === 上传测速 ===

function startUploadTest() {
  testState = 'uploading'
  var totalSent = 0
  startTime = Date.now()
  graceTimeDone = false
  xhr = []
  result.uploadBytes = 0

  // 生成随机数据块 (128KB)
  var chunkSize = 128 * 1024
  var chunk = new ArrayBuffer(chunkSize)
  var view = new Uint8Array(chunk)
  for (var i = 0; i < chunkSize; i++) view[i] = Math.floor(Math.random() * 256)

  var streamSent = []

  function startStream(streamId, delay) {
    setTimeout(function () {
      if (testState !== 'uploading') return
      streamSent[streamId] = 0

      function doUpload() {
        if (testState !== 'uploading') return

        var req = new XMLHttpRequest()
        xhr[streamId] = req
        var url = settings.uploadUrl + (settings.uploadUrl.indexOf('?') >= 0 ? '&' : '?') + '_nocache=' + Math.random()

        req.onload = function () {
          if (testState === 'uploading') doUpload()
        }

        req.onerror = function () {
          if (testState === 'uploading') setTimeout(doUpload, 1000)
        }

        // 发送 2MB 数据
        var blob = new Blob([chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk,
                             chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk])
        totalSent += blob.size
        streamSent[streamId] += blob.size

        req.open('POST', url, true)
        req.setRequestHeader('Content-Type', 'application/octet-stream')
        req.send(blob)
      }

      doUpload()
    }, delay)
  }

  for (var i = 0; i < settings.streams; i++) {
    startStream(i, i * 100)
  }

  interval = setInterval(function () {
    var elapsed = Date.now() - startTime

    if (!graceTimeDone) {
      if (elapsed > settings.graceTime * 1000) {
        startTime = Date.now()
        totalSent = 0
        graceTimeDone = true
      }
      postStatus({ phase: 'upload', progress: 0, speed: 0, bytes: 0 })
      return
    }

    var bytesPerSec = totalSent / ((Date.now() - startTime) / 1000)
    var mbps = bytesPerSec * 8 * settings.overheadFactor / 1000000
    var progress = Math.min((Date.now() - startTime) / (settings.uploadTime * 1000), 1)

    result.uploadBytes = totalSent
    postStatus({ phase: 'upload', progress: progress, speed: mbps.toFixed(2), bytes: totalSent })

    if (progress >= 1) {
      clearRequests()
      result.upload = parseFloat(mbps.toFixed(2))
      testState = 'idle'
      postResult()
    }
  }, 200)
}

// === 延迟/抖动测速 ===

var pingResults = []

function startPingTest() {
  testState = 'ping'
  pingResults = []
  var count = 0

  function doPing() {
    if (testState !== 'ping' || count >= settings.pingCount) {
      // 计算结果
      if (pingResults.length > 0) {
        result.ping = Math.round(pingResults.reduce(function (a, b) { return a + b }, 0) / pingResults.length)
        // 抖动 = 延迟标准差
        var mean = result.ping
        var variance = pingResults.reduce(function (sum, v) { return sum + (v - mean) * (v - mean) }, 0) / pingResults.length
        result.jitter = Math.round(Math.sqrt(variance))
      }
      testState = 'idle'
      postResult()
      return
    }

    var pingStart = Date.now()
    var req = new XMLHttpRequest()
    var url = settings.pingUrl + (settings.pingUrl.indexOf('?') >= 0 ? '&' : '?') + '_ping=' + Math.random()

    req.onload = function () {
      var latency = Date.now() - pingStart
      pingResults.push(latency)
      count++
      postStatus({ phase: 'ping', progress: count / settings.pingCount, latency: latency, avg: Math.round(pingResults.reduce(function (a, b) { return a + b }, 0) / pingResults.length) })
      setTimeout(doPing, 200)
    }

    req.onerror = function () {
      count++
      setTimeout(doPing, 500)
    }

    req.open('GET', url, true)
    req.send()
  }

  doPing()
}

// === 消息处理 ===

self.addEventListener('message', function (event) {
  var msg = event.data

  if (msg.cmd === 'start') {
    // 合并设置
    if (msg.settings) {
      for (var key in msg.settings) {
        if (msg.settings.hasOwnProperty(key)) {
          settings[key] = msg.settings[key]
        }
      }
    }

    result = { download: 0, upload: 0, ping: 0, jitter: 0, downloadBytes: 0, uploadBytes: 0 }

    var order = msg.order || 'P_D_U' // P=ping, D=download, U=upload, _=间隔
    var steps = order.split('_')
    var stepIdx = 0

    function runNextStep() {
      if (testState === 'stopped') return
      if (stepIdx >= steps.length) {
        testState = 'done'
        postStatus({ phase: 'done', progress: 1 })
        postResult()
        return
      }

      var step = steps[stepIdx++]

      if (step === 'P') {
        postStatus({ phase: 'ping', progress: 0 })
        startPingTest()
        // 等待 ping 完成
        var checkPing = setInterval(function () {
          if (testState !== 'ping') { clearInterval(checkPing); runNextStep() }
        }, 200)
      } else if (step === 'D') {
        postStatus({ phase: 'download', progress: 0, speed: 0 })
        startDownloadTest()
        var checkDl = setInterval(function () {
          if (testState !== 'downloading') { clearInterval(checkDl); runNextStep() }
        }, 200)
      } else if (step === 'U') {
        postStatus({ phase: 'upload', progress: 0, speed: 0 })
        startUploadTest()
        var checkUl = setInterval(function () {
          if (testState !== 'uploading') { clearInterval(checkUl); runNextStep() }
        }, 200)
      } else if (step === '') {
        // 间隔
        setTimeout(runNextStep, 1000)
      } else {
        runNextStep()
      }
    }

    runNextStep()

  } else if (msg.cmd === 'stop') {
    testState = 'stopped'
    clearRequests()
    postStatus({ phase: 'stopped', progress: 0 })

  } else if (msg.cmd === 'status') {
    postStatus({ phase: testState })
  }
})
