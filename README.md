# 🚑 Real-Time Ambulance GPS Alert & Traffic Control System

An advanced real-time ambulance tracking, GPS telemetry filtering, and smart traffic signal preemption system with ESP32 micro-controller integration.

---

## ✨ Features & Architecture

- **Real-Time GPS Telemetry & Filtering**:
  - Filters low-accuracy GPS jitter and small stationary drift.
  - Smooth animation interpolation for live ambulance movement along routes.
- **OSRM Driving Telemetry**:
  - Live driving distance and estimated time of arrival (ETA) calculation via OpenStreetMap / OSRM routing.
- **Smart ESP32 Traffic Signal Preemption**:
  - Connects to an ESP32 traffic controller via local network or cloud.
  - Automatically triggers emergency signal sequence when the ambulance enters the 750-meter approach zone.
  - Controls Red / Yellow / Green LED signaling with preemption timing (20s Red -> 15s Yellow -> Green).
  - 20x4 I2C LCD displays live distance, ETA, and approach status in real time.
- **Cross-Platform & Deployment Ready**:
  - Zero-config WebSocket and fallback broker support for sync across devices.
  - GitHub Pages workflow configured for automatic static frontend deployment.
  - Node.js Express + WebSocket backend server included for full local/server hosting.

---

## 🚀 Quick Start (Local Run)

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Start the local server**:
   ```bash
   npm start
   ```
3. Open `http://localhost:3000` (or the URL displayed in the terminal) in your browser.

---

## 🚦 ESP32 Traffic Signal Setup

1. Open `traffic_signal_esp32/traffic_signal_esp32.ino` in the **Arduino IDE**.
2. Update your Wi-Fi credentials:
   ```cpp
   const char* WIFI_SSID = "YOUR_WIFI_NAME";
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
   ```
3. **Pin Configuration**:
   - `RED_LED`: GPIO `32`
   - `YELLOW_LED`: GPIO `33`
   - `GREEN_LED`: GPIO `4`
   - `I2C LCD (20x4)`: SDA -> GPIO `21`, SCL -> GPIO `22` (I2C address `0x27`)
4. Upload to the ESP32 and open the **Serial Monitor** (115200 baud) to view the assigned IP address (e.g., `http://192.168.1.100`).
5. In the web app's **Traffic Control Center**, enter the ESP32 IP/URL and click **Connect ESP32**.

---

## 📡 Signal Sequence

When the road distance between the ambulance and the traffic junction is **<= 750 m**:
1. **LCD Display**: Turns on, showing real-time approach distance and ETA.
2. **Signal Timing**:
   - **RED**: 20 seconds clearance buffer.
   - **YELLOW**: 15 seconds preparatory state.
   - **GREEN**: Turns on to give priority passage to the ambulance.
3. Once the ambulance passes or moves beyond 750 m, the controller automatically resets to normal operation and turns off the LCD backlight.

---

## 🌐 GitHub Pages Deployment

This repository includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that automatically builds and deploys the web interface to GitHub Pages on every push to the `main` branch.
