/*
 * ╔══════════════════════════════════════════════════════════╗
 * ║   C.A.R.E  —  Chemical Absorption of Residual Emissions  ║
 * ║   Atmospheric Command Centre  |  ESP32 Firmware v1.0.0   ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  Hardware:                                               ║
 * ║    MQ-7  Sensor  → GPIO 34  (ADC1_CH6)                  ║
 * ║    MQ-135 Sensor → GPIO 35  (ADC1_CH7)                  ║
 * ║    Status LED    → GPIO 2   (built-in)                   ║
 * ║                                                          ║
 * ║  Libraries Required (Arduino Library Manager):          ║
 * ║    • ArduinoWebsockets (gilmaimon)                       ║
 * ║    • ArduinoJson (Benoit Blanchon)                       ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * SETUP INSTRUCTIONS:
 * 1. Install Arduino IDE with ESP32 board support
 * 2. Install libraries listed above via Library Manager
 * 3. Set WIFI_SSID, WIFI_PASS, SERVER_IP below
 * 4. Upload to ESP32 (115200 baud)
 * 5. Open Serial Monitor to see debug output
 */

#include <WiFi.h>
#include <ArduinoWebsockets.h>
#include <ArduinoJson.h>

using namespace websockets;

// ── Configuration ─────────────────────────────────────────────
#define WIFI_SSID       "YOUR_WIFI_SSID"
#define WIFI_PASS       "YOUR_WIFI_PASSWORD"
#define SERVER_IP       "192.168.1.100"   // Your PC's local IP address
#define SERVER_PORT     3001
#define WS_PATH         "/"

// ── Pin Definitions ────────────────────────────────────────────
#define PIN_MQ7         34   // ADC1_CH6 — CO sensor
#define PIN_MQ135       35   // ADC1_CH7 — AQI sensor
#define PIN_LED         2    // Built-in LED

// ── Sensor Calibration ─────────────────────────────────────────
// Adjust these after calibrating your specific sensors in clean air
#define MQ7_R0          10.0f    // kΩ — resistance in clean air
#define MQ7_RL          10.0f    // kΩ — load resistance
#define MQ135_R0        76.63f   // kΩ — resistance in clean air
#define MQ135_RL        10.0f    // kΩ — load resistance
#define ADC_REF_V       3.3f
#define ADC_RES         4095.0f  // 12-bit ADC

// ── Timing ─────────────────────────────────────────────────────
#define WARMUP_MS       30000    // 30-second sensor warm-up
#define SEND_INTERVAL   1000     // Send data every 1 second
#define RECONNECT_MS    5000     // Reconnect attempt interval

// ── Globals ────────────────────────────────────────────────────
WebsocketsClient wsClient;
bool wsConnected   = false;
bool identified    = false;
unsigned long bootTime    = 0;
unsigned long lastSend    = 0;
unsigned long lastReconn  = 0;

// ── Utility: LED ───────────────────────────────────────────────
void ledOn()  { digitalWrite(PIN_LED, HIGH); }
void ledOff() { digitalWrite(PIN_LED, LOW);  }
void ledBlink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    ledOn(); delay(ms); ledOff(); delay(ms);
  }
}

// ── Sensor: Read Raw ADC ───────────────────────────────────────
float readRawVoltage(int pin) {
  // Average 10 samples for stability
  long sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  float raw = sum / 10.0f;
  return (raw / ADC_RES) * ADC_REF_V;
}

// ── Sensor: MQ-7 → CO ppm ──────────────────────────────────────
// Using: CO ppm = 99.042 × (Rs/R0)^(−1.518)
float readMQ7_ppm() {
  float voltage = readRawVoltage(PIN_MQ7);
  if (voltage < 0.001f) voltage = 0.001f; // avoid division by zero
  float RS = MQ7_RL * (ADC_REF_V - voltage) / voltage;
  float ratio = RS / MQ7_R0;
  if (ratio <= 0) ratio = 0.001f;
  float ppm = 99.042f * pow(ratio, -1.518f);
  return constrain(ppm, 10.0f, 500.0f);
}

// ── Sensor: MQ-135 → ppm & AQI ────────────────────────────────
// Using: ppm = 116.602 × (Rs/R0)^(−2.769)
float readMQ135_ppm() {
  float voltage = readRawVoltage(PIN_MQ135);
  if (voltage < 0.001f) voltage = 0.001f;
  float RS = MQ135_RL * (ADC_REF_V - voltage) / voltage;
  float ratio = RS / MQ135_R0;
  if (ratio <= 0) ratio = 0.001f;
  float ppm = 116.602f * pow(ratio, -2.769f);
  return constrain(ppm, 0.0f, 300.0f);
}

// ── WebSocket Callbacks ────────────────────────────────────────
void onWsMessage(WebsocketsMessage msg) {
  Serial.print("[WS] Server: ");
  Serial.println(msg.data());
}

void onWsEvent(WebsocketsEvent event, String data) {
  if (event == WebsocketsEvent::ConnectionOpened) {
    Serial.println("[WS] Connected to C.A.R.E server");
    wsConnected = true;
    identified  = false;
    ledOn();

    // Send identify message
    StaticJsonDocument<64> idDoc;
    idDoc["type"]   = "identify";
    idDoc["source"] = "esp32";
    String idMsg;
    serializeJson(idDoc, idMsg);
    wsClient.send(idMsg);
    identified = true;
    Serial.println("[WS] Sent identify message");
    ledBlink(3, 100);
    ledOn();

  } else if (event == WebsocketsEvent::ConnectionClosed) {
    Serial.println("[WS] Disconnected from server");
    wsConnected = false;
    identified  = false;
    ledOff();

  } else if (event == WebsocketsEvent::GotPing) {
    wsClient.pong();
  }
}

// ── WiFi Connect ──────────────────────────────────────────────
void connectWiFi() {
  Serial.print("[WiFi] Connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    ledBlink(1, 300);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Connected! IP: ");
    Serial.println(WiFi.localIP());
    ledBlink(5, 100);
  } else {
    Serial.println("[WiFi] FAILED — check credentials. Rebooting in 5s…");
    delay(5000);
    ESP.restart();
  }
}

// ── WebSocket Connect ─────────────────────────────────────────
void connectWS() {
  Serial.print("[WS] Connecting to ws://");
  Serial.print(SERVER_IP);
  Serial.print(":");
  Serial.print(SERVER_PORT);
  Serial.println(WS_PATH);

  wsClient.onMessage(onWsMessage);
  wsClient.onEvent(onWsEvent);

  String url = String("ws://") + SERVER_IP + ":" + SERVER_PORT + WS_PATH;
  wsConnected = wsClient.connect(SERVER_IP, SERVER_PORT, WS_PATH);

  if (!wsConnected) {
    Serial.println("[WS] Connection failed — will retry…");
  }
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("╔══════════════════════════════════════════╗");
  Serial.println("║  C.A.R.E  Atmospheric Command Centre     ║");
  Serial.println("║  ESP32 Firmware v1.0.0  Booting…         ║");
  Serial.println("╚══════════════════════════════════════════╝");

  // Pin setup
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_MQ7, INPUT);
  pinMode(PIN_MQ135, INPUT);
  analogReadResolution(12); // 12-bit ADC on ESP32
  ledOff();

  // Connect WiFi
  connectWiFi();

  // Record boot time for warm-up guard
  bootTime = millis();
  Serial.print("[SENSOR] Warming up for ");
  Serial.print(WARMUP_MS / 1000);
  Serial.println(" seconds…");

  // Blink LED during warm-up
  for (int i = 0; i < WARMUP_MS / 500; i++) {
    ledBlink(1, 200);
    delay(300);
  }

  // Connect WebSocket
  connectWS();
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
  // Poll WebSocket
  if (wsConnected) {
    wsClient.poll();
  } else {
    // Try to reconnect periodically
    if (millis() - lastReconn > RECONNECT_MS) {
      lastReconn = millis();
      Serial.println("[WS] Attempting reconnect…");
      connectWS();
    }
  }

  // Check WiFi
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Lost connection — reconnecting…");
    connectWiFi();
    return;
  }

  // Send sensor data at interval
  if (wsConnected && identified && (millis() - lastSend >= SEND_INTERVAL)) {
    lastSend = millis();

    // Warm-up guard
    if (millis() - bootTime < WARMUP_MS) {
      Serial.println("[SENSOR] Still warming up…");
      return;
    }

    // Read sensors
    int raw7   = analogRead(PIN_MQ7);
    int raw135 = analogRead(PIN_MQ135);
    float co_ppm      = readMQ7_ppm();
    float filter_ppm  = readMQ135_ppm();

    // Build JSON
    StaticJsonDocument<256> doc;
    doc["type"] = "sensor_data";
    JsonObject mq7 = doc.createNestedObject("mq7");
    mq7["raw"] = raw7;
    mq7["ppm"] = co_ppm;
    JsonObject mq135 = doc.createNestedObject("mq135");
    mq135["raw"] = raw135;
    mq135["ppm"] = filter_ppm;

    String payload;
    serializeJson(doc, payload);
    wsClient.send(payload);

    // Serial debug
    Serial.print("[DATA] CO: ");
    Serial.print(co_ppm, 2);
    Serial.print(" ppm | Filtered: ");
    Serial.print(filter_ppm, 2);
    Serial.print(" ppm | Raw7: ");
    Serial.print(raw7);
    Serial.print(" | Raw135: ");
    Serial.println(raw135);

    // Brief LED flash on successful send
    ledOff();
    delay(50);
    ledOn();
  }
}
