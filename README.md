# ☀️ SolarEdge + Emporia Vue Unified Energy Monitor

[![Node.js](https://img.shields.io/badge/Node.js-20+-brightgreen.svg)](https://nodejs.org/)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-Add--on%20%7C%20MQTT-blue.svg)](https://www.home-assistant.io/)
[![SolarEdge](https://img.shields.io/badge/SolarEdge-SunSpec%20Modbus%20TCP-orange.svg)](https://www.solaredge.com/)
[![Emporia Vue](https://img.shields.io/badge/Emporia-Vue%202%2F3%20Cloud-yellow.svg)](https://www.emporiaenergy.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

A high-performance real-time home energy monitoring bridge that unifies local **SolarEdge SunSpec Modbus TCP** telemetry with **Emporia Vue branch-circuit submetering**. 

Provides sub-second net production, consumption, and financial pacing analytics published directly to **Home Assistant via MQTT Auto-Discovery**, paired with futuristic Lovelace dashboards and terminal live viewers.

---

## 🚀 Key Features

* **⚡ Ultra-Low Latency Solar Telemetry:** Reads instantaneous AC/DC power, lifetime production, scale factors, and inverter heat sink temperatures directly from your SolarEdge inverter over local Modbus TCP (Port 502). No cloud API rate limits or delays.
* **📊 Whole-Home & Branch Circuit Monitoring:** Pulls 1-second interval telemetry from Emporia Vue (mains 200A sensors + up to 16 individual 50A branch circuits: HVAC, EV chargers, range, dryer, etc.).
* **🧮 Real-Time Energy Math:** Computes net grid import/export, self-sufficiency percentages, instantaneous pacing ($/hr and kWh/min), and lifetime accumulators with persistent storage.
* **📡 Zero-Config MQTT Auto-Discovery:** Publishes standard Home Assistant discovery payloads so all solar, grid, and circuit sensors appear automatically with appropriate device classes, state classes, and units (`W`, `kW`, `kWh`, `°C`, `$`).
* **📱 Stunning Lovelace Dashboards:** Includes production-ready dashboard configurations (`solar-hub.yaml` and `solar-dashboard.yaml`) featuring animated energy flow nodes, card-mod micro-animations, and circuit consumption breakdowns.
* **📦 Flexible Deployment:** Runs either as a native **Home Assistant Local Add-on** (Docker) or as a **standalone Node.js CLI daemon / terminal dashboard**.

---

## 🏛️ Architecture Overview

```
 ┌───────────────────────────┐         ┌───────────────────────────┐
 │   SolarEdge Inverter      │         │   Emporia Vue 2 / 3       │
 │   (SunSpec Modbus TCP)    │         │   (AWS IoT Cloud API)     │
 └─────────────┬─────────────┘         └─────────────┬─────────────┘
               │ (LAN Port 502)                      │ (1-Sec Live Stream)
               ▼                                     ▼
       ┌─────────────────────────────────────────────────────┐
       │     Unified Energy Monitor (Daemon / Add-on)        │
       │  - Net power & self-consumption engine              │
       │  - Financial import/export calculator               │
       │  - Persistent /data energy accumulator              │
       └─────────────────────────┬───────────────────────────┘
                                 │ MQTT (Port 1883)
                                 ▼
       ┌─────────────────────────────────────────────────────┐
       │             Home Assistant Core                     │
       │  - Mosquitto Broker + Auto-Discovery Entities       │
       │  - Energy Management & History Stats                │
       │  - Solar Hub & Celestial Theme Dashboards           │
       └─────────────────────────────────────────────────────┘
```

---

## 📁 Repository Structure

```
modbus-solaredge/
├── ha-addon/
│   └── solar_energy_monitor/   # Home Assistant Local Add-on
│       ├── Dockerfile          # Alpine Node.js container build recipe
│       ├── config.yaml         # HA add-on manifest & options schema
│       ├── package.json        # Container dependency lock
│       ├── service.js          # Add-on daemon entrypoint
│       └── ha-mqtt.js          # Add-on MQTT auto-discovery engine
├── dashboards/
│   ├── solar-hub.yaml          # Flagship comprehensive Solar & Energy Hub
│   ├── solar-dashboard.yaml    # Streamlined solar & circuit monitor
│   ├── lights-dashboard.yaml   # Modern glassmorphism lighting dashboard
│   ├── celestial-theme.yaml    # Curated dark/deep-space Lovelace theme
│   └── ha-configuration.yaml   # Reference configuration includes
├── service.js                  # Standalone background daemon
├── dashboard.js                # Full-featured interactive terminal dashboard
├── monitor-live.js             # Compact ANSI live box monitor
├── dump.js                     # One-shot SunSpec register inspection tool
├── solaredge.js                # Minimal Modbus TCP connection test
├── emporia.js                  # Minimal Emporia Vue authentication test
├── sync-watch.js               # Auto-sync watcher for HA Samba share
├── env.js                      # Zero-dependency environment loader
├── .env.example                # Sanitized configuration template
└── package.json                # Project dependencies and scripts
```

---

## ⚙️ Quick Start (Standalone Node.js Daemon)

### 1. Prerequisites
* Node.js v18.0.0 or higher
* npm or pnpm
* SolarEdge inverter with Modbus TCP enabled (Port 502)
* Emporia Vue account credentials

### 2. Installation
```bash
git clone https://github.com/jeremiahjp/solaredge-emporia-monitor.git
cd solaredge-emporia-monitor
npm install
```

### 3. Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Edit `.env` with your network and account details:
```env
# SolarEdge Inverter (Modbus TCP)
INVERTER_IP=192.168.1.100
MODBUS_PORT=502
RATED_AC_WATTS=7600

# Emporia Vue Cloud Credentials
EMPORIA_USER=your_email@example.com
EMPORIA_PASS=your_emporia_password

# Energy Rates ($/kWh)
IMPORT_RATE_KWH=0.14
EXPORT_RATE_KWH=0.01

# Polling Interval
POLL_INTERVAL_MS=2000

# Home Assistant & MQTT Broker
HA_IP=192.168.1.50
HA_MQTT_BROKER=mqtt://192.168.1.50:1883
HA_MQTT_USER=solar
HA_MQTT_PASS=your_mqtt_password
HA_SAMBA_PATH=\\homeassistant.local\addons\ha-addon\solar_energy_monitor
```

### 4. Running
* **Production Daemon (background service + MQTT publisher):**
  ```bash
  node service.js
  ```
* **Interactive Terminal Dashboard:**
  ```bash
  node dashboard.js
  ```
* **Live Inverter Telemetry Viewer:**
  ```bash
  node monitor-live.js
  ```
* **SunSpec Register Diagnostic Dump:**
  ```bash
  node dump.js
  ```

---

## 🏠 Home Assistant Add-on Installation

To run this as a native Home Assistant Add-on managed by Home Assistant OS / Supervised:

1. **Deploy Add-on Files:**
   Copy the `ha-addon/solar_energy_monitor` directory directly to your Home Assistant `/addons` folder (via Samba, SSH, or `npm run deploy`).
2. **Install Add-on:**
   * Go to **Settings → Add-ons → Add-on Store**.
   * Click the three dots (top right) → **Check for updates**.
   * Scroll down to the **Local Add-ons** section and select **Solar & Energy Monitor**.
   * Click **Install**.
3. **Configure Options:**
   Navigate to the **Configuration** tab of the add-on and provide:
   * Inverter IP (`192.168.x.x`)
   * Emporia Vue email & password
   * MQTT broker address (`mqtt://core-mosquitto:1883`) and credentials
4. **Start the Add-on:**
   Enable **Start on boot** and click **Start**. Check the **Log** tab to verify connection to both Modbus TCP and Emporia cloud.

---

## 📊 Home Assistant Dashboards

Pre-built dashboards are provided in the `dashboards/` folder:

* **`solar-hub.yaml`:** Complete command center featuring hero solar cards, real-time power distribution nodes, financial pacing calculators, circuit consumption breakdowns, and system diagnostics.
* **`celestial-theme.yaml`:** Sleek, high-contrast dark theme optimized for glassmorphic cards and dynamic glow effects.

### Recommended HACS Frontend Integrations
For full visual fidelity of the dashboards, install the following via [HACS](https://hacs.xyz/):
* `lovelace-card-mod`
* `mushroom`
* `sankey-chart` (optional, for flow visualization)

---

## 🔒 Security & Privacy

* **Strictly Environment-Driven:** No credentials, API tokens, or local LAN IP addresses are hardcoded.
* **Local First:** Solar telemetry communicates strictly over your local network without hitting external cloud servers.
* **Safe Template:** Git tracks only `.env.example`; runtime `.env` and persistent state (`energy-log.json`) are permanently gitignored.

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for details.
