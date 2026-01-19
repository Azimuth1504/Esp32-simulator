require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

/* ================== CORS ================== */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

/* ================== MIDDLEWARE ================== */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ================== CẤU HÌNH MÃ HOÁ ================== */

const DATA_SECRET = process.env.DATA_SECRET || '165743';
const DEFAULT_ENC_ALGO = (process.env.ENC_ALGO === 'DES') ? 'DES' : 'AES';

const ALGORITHMS = {
  AES: {
    cipher: 'aes-256-cbc',
    keyLen: 32,
    ivLen: 16
  },
  DES: {
    cipher: 'des-ede3-cbc', // 3DES
    keyLen: 24,
    ivLen: 8
  }
};

function deriveKey(secret, keyLen) {
  return crypto
    .createHash('sha256')
    .update(String(secret), 'utf8')
    .digest()
    .subarray(0, keyLen);
}

function encryptJSON(data, algoName, secret) {
  const algo = ALGORITHMS[algoName];
  if (!algo) {
    throw new Error(`Unsupported algorithm: ${algoName}`);
  }

  const key = deriveKey(secret, algo.keyLen);
  const iv = crypto.randomBytes(algo.ivLen);

  const cipher = crypto.createCipheriv(algo.cipher, key, iv);
  const json = JSON.stringify(data);

  const encrypted = Buffer.concat([
    cipher.update(json, 'utf8'),
    cipher.final()
  ]);

  return {
    algo: algoName,
    iv: iv.toString('base64'),
    data: encrypted.toString('base64')
  };
}

// Thuật toán mã hoá đang dùng runtime (có thể đổi qua /settings)
let currentEncAlgo = DEFAULT_ENC_ALGO;

/* ================== TRẠNG THÁI THIẾT BỊ ================== */

let deviceState = {
  led: false,             // false = OFF, true = ON
  fan: false,             // trạng thái quạt
  allowFanControl: true,  // cho phép điều khiển quạt (liên kết với UI Cài đặt)
  temperature: 25.0,
  humidity: 60.0,
  lastUpdate: new Date()
};

// Lịch sử cảm biến dưới dạng ĐÃ MÃ HOÁ (minh hoạ "mã hoá trước khi lưu")
const sensorHistory = [];

/* ================== HÀM SINH DỮ LIỆU MÔ PHỎNG ================== */

function generateRandomTemperature() {
  const min = parseFloat(process.env.TEMP_MIN) || 20;
  const max = parseFloat(process.env.TEMP_MAX) || 35;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRandomHumidity() {
  const min = parseFloat(process.env.HUM_MIN) || 40;
  const max = parseFloat(process.env.HUM_MAX) || 80;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Chu kỳ cập nhật cảm biến (ms)
const tempInterval = parseInt(process.env.TEMP_INTERVAL) || 5000;

// Hàm đánh giá "sức khoẻ" dữ liệu realtime
function getDataHealth() {
  if (!deviceState.lastUpdate) {
    return {
      status: 'UNKNOWN',   // chưa có dữ liệu
      ageMs: null,
      isFresh: false,
      lastUpdate: null
    };
  }

  const ageMs = Date.now() - deviceState.lastUpdate.getTime();
  // Dữ liệu được coi là "tươi" nếu mới hơn maxAge
  const maxAge = parseInt(process.env.DATA_HEALTH_MAX_AGE_MS) || (tempInterval * 2);
  const isFresh = ageMs <= maxAge;

  return {
    status: isFresh ? 'OK' : 'STALE', // OK = dữ liệu đang cập nhật đều, STALE = lâu không cập nhật
    ageMs,
    isFresh,
    lastUpdate: deviceState.lastUpdate
  };
}

// Cập nhật cảm biến định kỳ – chạy non-blocking, không chặn các request khác
function updateSensorData() {
  deviceState.temperature = generateRandomTemperature();
  deviceState.humidity = generateRandomHumidity();
  deviceState.lastUpdate = new Date();

  // Ghi lịch sử dưới dạng MÃ HOÁ (nhiệt độ + độ ẩm)
  try {
    const record = {
      timestamp: deviceState.lastUpdate.toISOString(),
      temperature: deviceState.temperature,
      humidity: deviceState.humidity
    };
    const payload = encryptJSON(
      record,
      currentEncAlgo, // dùng thuật toán hiện tại, có thể đổi qua /settings
      DATA_SECRET
    );
    sensorHistory.push(payload);
    if (sensorHistory.length > 500) sensorHistory.shift();
  } catch (err) {
    console.error('[ESP32 Simulator] Encrypt history error:', err.message);
  }

  // Gửi realtime cho UI mô phỏng (dữ liệu THUẦN)
  io.emit('temperatureUpdated', { 
    temperature: deviceState.temperature,
    humidity: deviceState.humidity,
    timestamp: deviceState.lastUpdate 
  });

  // Gửi realtime trạng thái "sức khoẻ dữ liệu"
  const health = getDataHealth();
  io.emit('dataHealthUpdated', health);

  console.log(
    `[ESP32] Sensor updated - Temp: ${deviceState.temperature}°C, Hum: ${deviceState.humidity}%, ` +
    `health=${health.status}, age=${health.ageMs}ms, algo=${currentEncAlgo}`
  );

  // Gửi dữ liệu về web chính (giữ nguyên hành vi cũ, chỉ thêm humidity)
  sendToMainServer();
}

/* ================== GỬI DỮ LIỆU VỀ WEB CHÍNH ================== */

function sendToMainServer() {
  const mainServerUrl = process.env.MAIN_SERVER_URL;
  const shouldSend = process.env.SEND_TO_MAIN_SERVER === 'true';
  
  if (!shouldSend || !mainServerUrl) {
    return;
  }
  
  const postData = JSON.stringify({
    ip: `localhost:${process.env.PORT || 4001}`,
    temperature: deviceState.temperature,
    humidity: deviceState.humidity,
    timestamp: deviceState.lastUpdate
  });
  
  const url = new URL('/api/sensor-data', mainServerUrl);
  
  const options = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 2000
  };
  
  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log(`[ESP32] ✓ Sent sensor data to main server`);
      }
    });
  });
  
  req.on('error', (error) => {
    // Silent fail - main server có thể chưa chạy
  });
  
  req.on('timeout', () => {
    req.destroy();
  });
  
  req.write(postData);
  req.end();
}

/* ================== API ĐIỀU KHIỂN & ĐỌC TRẠNG THÁI ================== */

// Điều khiển LED (giữ nguyên hành vi & logging cũ)
app.post('/led', (req, res) => {
  const { state } = req.body; // state: "ON" hoặc "OFF"
  
  console.log(`[ESP32 Simulator] ========== LED CONTROL REQUEST ==========`);
  console.log(`[ESP32 Simulator] Time: ${new Date().toISOString()}`);
  console.log(`[ESP32 Simulator] From IP: ${req.ip}`);
  console.log(`[ESP32 Simulator] Headers:`, req.headers);
  console.log(`[ESP32 Simulator] Body:`, req.body);
  console.log(`[ESP32 Simulator] State received: ${state}`);
  
  if (state === 'ON' || state === 1 || state === true) {
    deviceState.led = true;
    console.log('[ESP32 Simulator] ✅ LED turned ON');
  } else if (state === 'OFF' || state === 0 || state === false) {
    deviceState.led = false;
    console.log('[ESP32 Simulator] ✅ LED turned OFF');
  }
  
  deviceState.lastUpdate = new Date();
  
  console.log(`[ESP32 Simulator] Broadcasting ledStateChanged to all clients:`, { led: deviceState.led });
  io.emit('ledStateChanged', { 
    led: deviceState.led,
    timestamp: deviceState.lastUpdate 
  });
  
  console.log(`[ESP32 Simulator] Sending response: { success: true, led: ${deviceState.led} }`);
  console.log(`[ESP32 Simulator] ================================================`);
  res.json({
    success: true,
    led: deviceState.led,
    message: `LED ${deviceState.led ? 'ON' : 'OFF'}`
  });
});

// Điều khiển QUẠT
app.post('/fan', (req, res) => {
  const { state } = req.body;

  console.log(`[ESP32 Simulator] ========== FAN CONTROL REQUEST ==========`);
  console.log(`[ESP32 Simulator] Time: ${new Date().toISOString()}`);
  console.log(`[ESP32 Simulator] Body:`, req.body);

  if (!deviceState.allowFanControl) {
    console.log('[ESP32 Simulator] ❌ Fan control is disabled by settings');
    return res.status(403).json({
      success: false,
      message: 'Fan control is disabled'
    });
  }

  if (state === 'ON' || state === 1 || state === true) {
    deviceState.fan = true;
    console.log('[ESP32 Simulator] ✅ Fan turned ON');
  } else if (state === 'OFF' || state === 0 || state === false) {
    deviceState.fan = false;
    console.log('[ESP32 Simulator] ✅ Fan turned OFF');
  } else {
    return res.status(400).json({
      success: false,
      message: 'Invalid fan state'
    });
  }

  deviceState.lastUpdate = new Date();

  io.emit('fanStateChanged', {
    fan: deviceState.fan,
    timestamp: deviceState.lastUpdate
  });

  res.json({
    success: true,
    fan: deviceState.fan,
    message: `FAN ${deviceState.fan ? 'ON' : 'OFF'}`
  });
});

// API đọc cảm biến (thuần: temp + hum)
app.get('/sensor', (req, res) => {
  res.json({
    temperature: deviceState.temperature,
    humidity: deviceState.humidity,
    timestamp: deviceState.lastUpdate
  });
});

// API lấy toàn bộ trạng thái + thuật toán mã hoá + sức khoẻ dữ liệu
app.get('/status', (req, res) => {
  res.json({
    ...deviceState,
    encAlgo: currentEncAlgo,
    dataHealth: getDataHealth()
  });
});

// API riêng để check "sức khoẻ dữ liệu" realtime
app.get('/data-health', (req, res) => {
  res.json(getDataHealth());
});

/* ================== API DỮ LIỆU MÃ HOÁ ================== */

// Dữ liệu nhiệt độ + độ ẩm mã hoá (cho server chính)
app.get('/sensor_encrypted', (req, res) => {
  const algoName = (req.query.algo && ALGORITHMS[req.query.algo])
    ? req.query.algo
    : currentEncAlgo;

  const data = {
    timestamp: deviceState.lastUpdate.toISOString(),
    temperature: deviceState.temperature,
    humidity: deviceState.humidity
  };

  try {
    const payload = encryptJSON(data, algoName, DATA_SECRET);
    return res.json({
      encrypted: true,
      ...payload
    });
  } catch (err) {
    console.error('[ESP32 Simulator] /sensor_encrypted error:', err.message);
    return res.status(500).json({ encrypted: false, error: 'encryption error' });
  }
});

// Chỉ trả độ ẩm mã hoá (đúng yêu cầu đề tài)
app.get('/humidity_encrypted', (req, res) => {
  const algoName = (req.query.algo && ALGORITHMS[req.query.algo])
    ? req.query.algo
    : currentEncAlgo;

  const data = {
    timestamp: deviceState.lastUpdate.toISOString(),
    humidity: deviceState.humidity
  };

  try {
    const payload = encryptJSON(data, algoName, DATA_SECRET);
    return res.json({
      encrypted: true,
      ...payload
    });
  } catch (err) {
    console.error('[ESP32 Simulator] /humidity_encrypted error:', err.message);
    return res.status(500).json({ encrypted: false, error: 'encryption error' });
  }
});

/* ================== API SETTINGS (cho UI "Cài đặt") ================== */
/*  Phục vụ popup Cài đặt:
    - Bật/tắt cho phép điều khiển quạt (allowFanControl)
    - Chọn thuật toán mã hoá (AES / DES)
*/

app.post('/settings', (req, res) => {
  const { allowFanControl, algo } = req.body;

  // Cập nhật allowFanControl nếu có gửi lên
  if (typeof allowFanControl !== 'undefined') {
    const flag =
      allowFanControl === true ||
      allowFanControl === 'true' ||
      allowFanControl === 1 ||
      allowFanControl === '1';
    deviceState.allowFanControl = flag;
  }

  // Cập nhật thuật toán mã hoá nếu hợp lệ
  if (typeof algo === 'string') {
    const upper = algo.toUpperCase();
    if (ALGORITHMS[upper]) {
      currentEncAlgo = upper;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid encryption algorithm. Use AES or DES.'
      });
    }
  }

  const health = getDataHealth();

  // Phát realtime để UI cập nhật ngay lập tức
  io.emit('settingsUpdated', {
    allowFanControl: deviceState.allowFanControl,
    encAlgo: currentEncAlgo
  });

  return res.json({
    success: true,
    allowFanControl: deviceState.allowFanControl,
    encAlgo: currentEncAlgo,
    dataHealth: health
  });
});

/* ================== SOCKET.IO ================== */

io.on('connection', (socket) => {
  console.log('[ESP32] Client connected to view');
  
  // Gửi trạng thái hiện tại + thuật toán mã hoá + sức khoẻ dữ liệu
  socket.emit('initialState', {
    ...deviceState,
    encAlgo: currentEncAlgo,
    dataHealth: getDataHealth()
  });
  
  socket.on('disconnect', () => {
    console.log('[ESP32] Client disconnected');
  });
});

/* ================== LỊCH CẬP NHẬT SENSOR ================== */

setInterval(updateSensorData, tempInterval);

// Cập nhật lần đầu
updateSensorData();

/* ================== START SERVER ================== */

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log('=================================');
  console.log(`🔌 ESP32 Simulator Started`);
  console.log(`📡 Listening on: http://localhost:${PORT}`);
  console.log(`🌡️  Sensor update interval: ${tempInterval/1000}s`);
  if (process.env.SEND_TO_MAIN_SERVER === 'true') {
    console.log(`📤 Sending data to: ${process.env.MAIN_SERVER_URL}`);
  }
  console.log('=================================');
  console.log('💡 API Endpoints:');
  console.log(`   POST http://localhost:${PORT}/led                - Control LED`);
  console.log(`   POST http://localhost:${PORT}/fan                - Control FAN`);
  console.log(`   POST http://localhost:${PORT}/settings           - Update fan & encryption settings`);
  console.log(`   GET  http://localhost:${PORT}/sensor             - Read sensor data (plain)`);
  console.log(`   GET  http://localhost:${PORT}/status             - Get all status + encAlgo + dataHealth`);
  console.log(`   GET  http://localhost:${PORT}/data-health        - Check data health realtime`);
  console.log(`   GET  http://localhost:${PORT}/sensor_encrypted   - Temp+Hum encrypted (AES/DES)`);
  console.log(`   GET  http://localhost:${PORT}/humidity_encrypted - Humidity encrypted (AES/DES)`);
  console.log('=================================');
});
