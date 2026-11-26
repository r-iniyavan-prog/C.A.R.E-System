'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
//  C.A.R.E  —  Chemical Absorption of Residual Emissions
//  Atmospheric Command Centre  |  Backend Server v1.0.0
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Registry & Store ─────────────────────────────────────────────
const registry = { browsers: new Set(), esp32: null };

const store = {
  latest: null,
  history: { mq7: [], mq135: [], efficiency: [], timestamps: [] },
  maxHistory: 120,
  esp32Connected: false,
  startTime: Date.now(),
};

// ── Simulation Engine ────────────────────────────────────────────
let simTimer = null;
let simScenario = 'normal';
let simTick = 0;
let simBaseCO = 42;

const SIM_SCENARIOS = ['normal', 'normal', 'normal', 'pollution_spike', 'cleaning'];

function pickScenario() {
  simScenario = SIM_SCENARIOS[Math.floor(Math.random() * SIM_SCENARIOS.length)];
  if (simScenario === 'pollution_spike') simBaseCO = 80 + Math.random() * 80;
  if (simScenario === 'cleaning')       simBaseCO = 80;
  if (simScenario === 'normal')         simBaseCO = 35 + Math.random() * 20;
}

function noise(amp) { return (Math.random() - 0.5) * 2 * amp; }

function generateSimData() {
  simTick++;
  if (simTick % 30 === 0) pickScenario();

  let co;
  if (simScenario === 'cleaning') {
    simBaseCO = Math.max(20, simBaseCO * 0.97);
    co = simBaseCO + noise(5);
  } else {
    co = simBaseCO + noise(8);
  }
  co = Math.max(10, Math.min(500, co));

  const eff = 72 + noise(8);
  const filtered_ppm = co * (1 - Math.max(50, Math.min(99, eff)) / 100);

  return {
    mq7:   { raw: Math.round(co * 10),           ppm: parseFloat(co.toFixed(2)) },
    mq135: { raw: Math.round(filtered_ppm * 8),  ppm: parseFloat(filtered_ppm.toFixed(2)) },
  };
}

function startSim() {
  if (simTimer) return;
  pickScenario();
  simTimer = setInterval(() => {
    const raw = generateSimData();
    const processed = processData(raw, true);
    store.latest = processed;
    pushHistory(processed);
    broadcast({ type: 'sensor_data', data: processed });
  }, 1000);
  console.log('[SIM] Simulation engine started');
}

function stopSim() {
  if (!simTimer) return;
  clearInterval(simTimer);
  simTimer = null;
  console.log('[SIM] Simulation stopped — ESP32 is live');
}

// ── Data Processing ──────────────────────────────────────────────
function coStatus(ppm) {
  if (ppm < 35)  return 'safe';
  if (ppm < 100) return 'moderate';
  if (ppm < 200) return 'warning';
  if (ppm < 400) return 'danger';
  return 'hazardous';
}

function aqiStatus(aqi) {
  if (aqi <= 50)  return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'sensitive';
  if (aqi <= 200) return 'unhealthy';
  if (aqi <= 300) return 'very_unhealthy';
  return 'hazardous';
}

function processData(raw, isSimulated) {
  const co_ppm      = raw.mq7.ppm;
  const filtered    = raw.mq135.ppm;
  const aqi         = Math.min(500, filtered * 2.8);
  const efficiency  = co_ppm > 0
    ? Math.max(0, Math.min(100, (1 - filtered / co_ppm) * 100))
    : 0;

  return {
    timestamp: new Date().toISOString(),
    simulated: isSimulated,
    mq7:    { raw: raw.mq7.raw,   ppm: co_ppm,                 status: coStatus(co_ppm) },
    mq135:  { raw: raw.mq135.raw, ppm: filtered, aqi: parseFloat(aqi.toFixed(1)), status: aqiStatus(aqi) },
    filter: { efficiency: parseFloat(efficiency.toFixed(1)), hepa: 'active', charcoal: 'active' },
    alerts: buildAlerts(co_ppm, aqi, efficiency),
  };
}

function buildAlerts(co, aqi, eff) {
  const a = [];
  if (co >= 400)      a.push({ level: 'danger',  msg: 'CRITICAL: CO hazardous! Evacuate immediately.' });
  else if (co >= 200) a.push({ level: 'warning', msg: 'WARNING: High CO detected. Increase ventilation.' });
  else if (co >= 100) a.push({ level: 'caution', msg: 'CAUTION: Elevated CO. Monitor closely.' });
  if (aqi > 200)      a.push({ level: 'danger',  msg: 'CRITICAL: AQI Very Unhealthy — avoid unfiltered air.' });
  else if (aqi > 150) a.push({ level: 'warning', msg: 'WARNING: AQI Unhealthy for sensitive groups.' });
  if (eff < 60)       a.push({ level: 'warning', msg: 'WARNING: Filter efficiency low. Consider replacement.' });
  return a;
}

function pushHistory(p) {
  const h = store.history;
  h.mq7.push(p.mq7.ppm);
  h.mq135.push(p.mq135.aqi);
  h.efficiency.push(p.filter.efficiency);
  h.timestamps.push(p.timestamp);
  if (h.mq7.length > store.maxHistory) {
    h.mq7.shift(); h.mq135.shift(); h.efficiency.shift(); h.timestamps.shift();
  }
}

// ── Broadcast ────────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  registry.browsers.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ── WebSocket ────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let clientType = 'unknown';

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'identify') {
      clientType = msg.source;
      if (clientType === 'browser') {
        registry.browsers.add(ws);
        ws.send(JSON.stringify({
          type: 'init',
          esp32Connected: store.esp32Connected,
          latest: store.latest,
          history: store.history,
          uptime: Date.now() - store.startTime,
        }));
        console.log(`[WS] Browser connected from ${ip}`);
      } else if (clientType === 'esp32') {
        if (registry.esp32 && registry.esp32 !== ws) registry.esp32.close(1000, 'Replaced');
        registry.esp32 = ws;
        store.esp32Connected = true;
        stopSim();
        broadcast({ type: 'connection_change', esp32Connected: true });
        console.log(`[WS] ESP32 connected from ${ip}`);
      }
    } else if (msg.type === 'sensor_data' && clientType === 'esp32') {
      const processed = processData(msg, false);
      store.latest = processed;
      pushHistory(processed);
      broadcast({ type: 'sensor_data', data: processed });
    }
  });

  ws.on('close', () => {
    if (clientType === 'browser') {
      registry.browsers.delete(ws);
    } else if (clientType === 'esp32') {
      registry.esp32 = null;
      store.esp32Connected = false;
      broadcast({ type: 'connection_change', esp32Connected: false });
      startSim();
      console.log('[WS] ESP32 disconnected — simulation resumed');
    }
  });

  ws.on('error', err => console.error('[WS] Error:', err.message));
});

// Heartbeat ping
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

// ── REST Endpoints ───────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    esp32Connected: store.esp32Connected,
    uptime: Date.now() - store.startTime,
    latest: store.latest,
    historyPoints: store.history.timestamps.length,
  });
});

app.get('/api/history', (_req, res) => {
  res.json({ ok: true, history: store.history });
});

app.post('/api/ai', (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string')
    return res.status(400).json({ ok: false, error: 'message required' });
  res.json({ ok: true, reply: aria(message.trim(), store.latest) });
});

// ── ARIA ─────────────────────────────────────────────────────────
function aria(input, latest) {
  const q = input.toLowerCase();

  if (/^(hi|hello|hey|greetings|howdy|sup|yo)\b/.test(q))
    return "👋 Hello! I'm **ARIA** — Atmospheric Research Intelligence Assistant. I'm here to help you understand air quality readings, sensor data, safety thresholds, and how C.A.R.E's filtration system works. What would you like to know?";

  if (/\b(help|commands|what can you|topics|menu)\b/.test(q))
    return "📋 **ARIA Help Menu** — I can answer questions about:\n\n• **Current Status** — live readings & safety levels\n• **MQ-7 Sensor** — CO detection (Chamber 1)\n• **MQ-135 Sensor** — filtered AQI (Chamber 3)\n• **Filter System** — HEPA + Charcoal efficiency\n• **CO Safety** — WHO/OSHA thresholds\n• **AQI Scale** — air quality index explained\n• **Health Effects** — exposure risks\n• **Emergency Protocol** — what to do in danger\n• **ESP32** — hardware setup help\n• **Calibration** — sensor maintenance tips\n\nJust ask naturally!";

  if (/\b(current|status|right now|readings|live|now)\b/.test(q)) {
    if (!latest) return "📡 No live data yet. The system is initializing. Please wait a moment for the first reading.";
    const sim = latest.simulated ? ' *(simulation mode)*' : ' *(ESP32 live)*';
    return `📊 **Current Readings**${sim}\n\n🔴 **Chamber 1 (MQ-7):** ${latest.mq7.ppm} ppm CO — **${latest.mq7.status.toUpperCase()}**\n🟢 **Chamber 3 (MQ-135):** AQI ${latest.mq135.aqi} — **${latest.mq135.status.toUpperCase()}**\n🔵 **Filter Efficiency:** ${latest.filter.efficiency}%\n\n${latest.alerts.length > 0 ? '⚠️ Alerts:\n' + latest.alerts.map(a => `• ${a.msg}`).join('\n') : '✅ All readings nominal.'}`;
  }

  if (/\b(mq.?7|mq7|carbon monoxide|co sensor|chamber 1|first chamber)\b/.test(q))
    return "🔴 **MQ-7 Sensor (Chamber 1)**\n\nSpecialized for **Carbon Monoxide (CO)** detection via metal oxide semiconductor technology.\n\n• **Detection Range:** 10–500 ppm\n• **Optimal Temp:** 20°C\n• **Warm-up Time:** 48h for full stability (20s minimum)\n• **Formula:** `CO ppm = 99.042 × (Rs/R0)^(−1.518)`\n• **R0 default:** 10 kΩ\n\nPlaced *before* filtration to measure raw incoming pollutant levels.";

  if (/\b(mq.?135|mq135|aqi|air quality index|chamber 3|third chamber|filtered air)\b/.test(q))
    return "🟢 **MQ-135 Sensor (Chamber 3)**\n\nBroad-spectrum sensor sensitive to NH₃, NOₓ, CO₂, alcohol, benzene, and smoke. Approximates the **AQI** of post-filtration air.\n\n• **Detection Range:** 10–300 ppm equivalent\n• **Formula:** `ppm = 116.602 × (Rs/R0)^(−2.769)`\n• **AQI Conversion:** `AQI = min(500, ppm × 2.8)`\n• **R0 default:** 76.63 kΩ\n\nComparing MQ-7 input vs MQ-135 output = filter efficiency.";

  if (/\b(hepa|charcoal|filter|filtration|chamber 2|second chamber|efficiency)\b/.test(q)) {
    const eff = latest ? latest.filter.efficiency + '%' : 'N/A';
    return `🔵 **Filtration System (Chamber 2)**\n\n1. **HEPA Filter (H13 Grade)**\n   • Captures ≥99.95% of particles ≥0.3 μm\n   • Removes dust, pollen, bacteria, PM2.5\n\n2. **Activated Charcoal Mesh**\n   • Adsorbs VOCs, chemical vapours, odours\n   • Surface area: ~1000 m²/gram\n\n📈 **Current Efficiency:** ${eff}\n\n⚠️ Replace filters when efficiency drops below 60% consistently.`;
  }

  if (/\b(co safe|carbon monoxide safe|co limit|osha|who limit|safe level|ppm safe)\b/.test(q))
    return "⚠️ **CO Safety Thresholds**\n\n| Level | CO (ppm) | Health Effect |\n|-------|----------|---------------|\n| ✅ Safe | < 35 | OSHA permissible (8-hr TWA) |\n| 🟡 Moderate | 35–100 | Headache with prolonged exposure |\n| 🟠 Warning | 100–200 | Dizziness, nausea within hours |\n| 🔴 Danger | 200–400 | Life-threatening in 3 hours |\n| 💀 Hazardous | > 400 | Immediate life-threatening risk |\n\n**WHO Guideline:** 10 mg/m³ (≈ 9 ppm) for 24-hour average.\n**OSHA PEL:** 50 ppm (8-hr TWA) | **NIOSH IDLH:** 1200 ppm";

  if (/\b(aqi scale|aqi mean|aqi explain|aqi category|what is aqi)\b/.test(q))
    return "🌬️ **AQI Scale**\n\n| AQI | Category | Health Implication |\n|-----|----------|-----------------------|\n| 0–50 | 🟢 Good | Air is satisfactory |\n| 51–100 | 🟡 Moderate | Acceptable; may affect very sensitive people |\n| 101–150 | 🟠 Unhealthy (Sensitive) | Sensitive groups may experience effects |\n| 151–200 | 🔴 Unhealthy | Everyone may begin to experience effects |\n| 201–300 | 🟣 Very Unhealthy | Health alert; serious effects |\n| 301–500 | 🟤 Hazardous | Emergency conditions |";

  if (/\b(health|effect|risk|symptom|danger|toxic|exposure)\b/.test(q))
    return "🏥 **Health Effects of CO & Poor Air Quality**\n\n**Short-term CO:**\n• 50 ppm (2h): Slight headache\n• 200 ppm (2–3h): Frontal headache, dizziness\n• 400 ppm (3h): Life-threatening\n• 1600 ppm (1h): Risk of death\n\n**PM2.5 (long-term):**\n• Cardiovascular disease risk\n• Reduced lung function\n• Elevated lung cancer risk\n\n**VOCs (charcoal protection):**\n• Benzene: carcinogenic\n• Formaldehyde: respiratory irritant";

  if (/\b(emergency|evacuate|danger protocol|what to do|high co|critical)\b/.test(q))
    return "🚨 **EMERGENCY PROTOCOL**\n\n**CO > 200 ppm:**\n1. 🚪 Evacuate immediately — leave doors open\n2. 📞 Call emergency services (119/112/911)\n3. 🏥 Seek fresh air; lie down if dizzy\n4. ❌ Do NOT re-enter until cleared\n\n**AQI > 300:**\n1. Wear N95/N99 respirator\n2. Shut down pollution sources if safe\n3. Increase mechanical ventilation\n\n*C.A.R.E will display flashing RED alerts and sound alarms automatically.*";

  if (/\b(esp32|esp 32|firmware|arduino|hardware|connect|wifi|wiring)\b/.test(q))
    return "🔌 **ESP32 Hardware Setup**\n\n**Pin Config:**\n• MQ-7  → GPIO **34** (ADC1)\n• MQ-135 → GPIO **35** (ADC1)\n• Status LED → GPIO **2** (built-in)\n\n**Steps:**\n1. Flash `CARE_Firmware.ino` to your ESP32\n2. Set WiFi SSID/password in firmware\n3. Set `SERVER_IP` to your PC's local IP\n4. Power on — ESP32 auto-connects via WebSocket\n5. Wait 30s for sensor warm-up\n\n**Troubleshooting:** Open Serial Monitor at 115200 baud for debug logs.";

  if (/\b(calibrat|maintenance|replace|clean|r0|accuracy)\b/.test(q))
    return "🔧 **Calibration & Maintenance**\n\n**Initial R0 Calibration:**\n1. Place sensor in clean outdoor air\n2. Power on and wait 24–48 hours\n3. Rs in clean air = **R0 value**\n\n**MQ-7 R0:** Default 10 kΩ\n**MQ-135 R0:** Default 76.63 kΩ\n\n**Maintenance Schedule:**\n| Component | Interval | Action |\n|-----------|----------|--------|\n| HEPA Filter | 3–6 months | Replace |\n| Charcoal Mesh | 1–3 months | Replace |\n| MQ-7 | Annually | Recalibrate |\n| MQ-135 | Annually | Recalibrate |";

  if (/\b(compar|difference|mq7 vs|versus|before after)\b/.test(q)) {
    if (!latest) return "📊 No live data to compare yet. Please wait for the first reading.";
    const red = ((latest.mq7.ppm - latest.mq135.ppm) / latest.mq7.ppm * 100).toFixed(1);
    return `📊 **Chamber 1 vs Chamber 3**\n\n| Metric | Input (MQ-7) | Output (MQ-135) | Reduction |\n|--------|-------------|-----------------|----------|\n| Gas (ppm) | ${latest.mq7.ppm} | ${latest.mq135.ppm} | **${red}%** |\n| AQI | — | ${latest.mq135.aqi} | — |\n| Status | ${latest.mq7.status} | ${latest.mq135.status} | — |\n\n**Filter Efficiency: ${latest.filter.efficiency}%**`;
  }

  if (/\b(overview|how does|explain|how it works|system|about)\b/.test(q))
    return "🏭 **C.A.R.E System Overview**\n\n**C**hemical **A**bsorption of **R**esidual **E**missions — Atmospheric Command Centre\n\n**Chamber 1 → MQ-7:** Measures raw incoming CO and combustion gases. Sets the baseline pollution level.\n\n**Chamber 2 → HEPA + Charcoal:** Passive dual-layer filtration. HEPA captures particulates; charcoal adsorbs VOCs.\n\n**Chamber 3 → MQ-135:** Measures filtered output AQI. Comparing with Chamber 1 gives filter efficiency.\n\n**ESP32:** Reads both sensors every second, streams data via WebSocket to this dashboard in real-time.";

  if (/\bppm\b/.test(q))
    return "📐 **What is PPM?**\n\nPPM = Parts Per Million — concentration of gas in air.\n• 1 ppm = 1 molecule per 1,000,000 air molecules\n• Fresh air: ~0.1–0.2 ppm CO\n• City street: 1–10 ppm CO\n• Inside a car: 5–50 ppm CO\n• OSHA safe limit: 50 ppm (8-hr)\n• IDLH (immediately dangerous): 1200 ppm";

  return "🤔 I didn't quite catch that! Try asking:\n• *\"What are the current readings?\"*\n• *\"Explain the MQ-7 sensor\"*\n• *\"What is a safe CO level?\"*\n• *\"How does the filter work?\"*\n• *\"Emergency protocol\"*\n\nOr type **help** for the full topic menu.";
}

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   C.A.R.E  —  Atmospheric Command Centre  v1.0.0        ║');
  console.log('║   Chemical Absorption of Residual Emissions              ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║   Server  →  http://localhost:${PORT}                      ║`);
  console.log('║   ARIA AI →  POST /api/ai                               ║');
  console.log('║   History →  GET  /api/history                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  startSim();
});
