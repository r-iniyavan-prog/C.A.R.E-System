# C.A.R.E — Atmospheric Command Centre

**Chemical Absorption of Residual Emissions**

## ⚡ Quick Start (5 minutes)

### Step 1 — Install Node.js
Download and install from: https://nodejs.org/en/download  
Choose **LTS (Windows Installer)**. After install, restart any terminal.

### Step 2 — Install dependencies
Open PowerShell or Command Prompt, then run:
```
cd C:\Users\Nazeema\.gemini\antigravity\scratch\care-system
npm install
```

### Step 3 — Start the server
```
node server.js
```
You'll see the CARE banner appear.

### Step 4 — Open in browser
Go to: http://localhost:3001

The dashboard starts in **Demo Simulation Mode** automatically — no ESP32 needed.

---

## 🔌 ESP32 Hardware Setup

| Sensor  | ESP32 Pin | Purpose |
|---------|-----------|---------|
| MQ-7    | GPIO 34   | CO concentration (Chamber 1) |
| MQ-135  | GPIO 35   | Filtered AQI (Chamber 3) |
| LED     | GPIO 2    | Built-in status indicator |

### Firmware Setup
1. Open `esp32/CARE_Firmware.ino` in Arduino IDE
2. Install required libraries via Library Manager:
   - `ArduinoWebsockets` by Gil Maimon
   - `ArduinoJson` by Benoit Blanchon
3. Edit the config at the top of the file:
   ```cpp
   #define WIFI_SSID    "YourWiFiName"
   #define WIFI_PASS    "YourPassword"
   #define SERVER_IP    "192.168.x.x"   // your PC's IP on local network
   ```
4. Select board: **ESP32 Dev Module**
5. Upload at 115200 baud
6. ESP32 connects and the dashboard switches to **LIVE** mode automatically

---

## 📁 File Structure

```
care-system/
├── server.js           ← Node.js backend (Express + WebSocket + ARIA AI)
├── package.json        ← Dependencies (express, ws)
├── public/
│   └── index.html      ← Full frontend dashboard
└── esp32/
    └── CARE_Firmware.ino ← Arduino ESP32 firmware
```

---

## 🤖 ARIA — Ask anything about air quality
Click the robot button (🤖) in the bottom-right corner.  
Try asking: *"What is a safe CO level?"* or *"How does the filter work?"*
