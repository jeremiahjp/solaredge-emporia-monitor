// ============================================================================
//  UNIFIED HOME ENERGY DAEMON (Home Assistant Local Add-on)
//  Continuously polls SolarEdge (Modbus) + Emporia Vue (Cloud),
//  logs persistent energy accumulation to /data, and publishes to Home Assistant (MQTT).
// ============================================================================
const ModbusRTU = require("modbus-serial");
const { EmporiaVue, Scale } = require("emporia-vue-lib");
const fs = require("fs");
const path = require("path");
const HaMqttPublisher = require("./ha-mqtt");

// --- Read Home Assistant Add-on Options (/data/options.json) ---
let haOptions = {};
const OPTIONS_PATH = "/data/options.json";
if (fs.existsSync(OPTIONS_PATH)) {
  try {
    haOptions = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
    console.log("[Config] Loaded Home Assistant add-on options from /data/options.json");
  } catch (err) {
    console.warn("[Config] Failed to parse options.json, using defaults:", err.message);
  }
}

// --- Configuration ---
const INVERTER_IP = haOptions.inverter_ip || process.env.INVERTER_IP || "127.0.0.1";
const MODBUS_PORT = Number(haOptions.modbus_port || process.env.MODBUS_PORT) || 502;
const UNIT_ID = 1;
const IMPORT_RATE_KWH = haOptions.import_rate_kwh !== undefined
  ? Number(haOptions.import_rate_kwh)
  : (process.env.IMPORT_RATE_KWH !== undefined ? Number(process.env.IMPORT_RATE_KWH) : 0.14);
const EXPORT_RATE_KWH = haOptions.export_rate_kwh !== undefined
  ? Number(haOptions.export_rate_kwh)
  : (process.env.EXPORT_RATE_KWH !== undefined ? Number(process.env.EXPORT_RATE_KWH) : 0.01);

const EMPORIA_USER = haOptions.emporia_user || process.env.EMPORIA_USER || "";
const EMPORIA_PASS = haOptions.emporia_pass || process.env.EMPORIA_PASS || "";

const POLL_INTERVAL = Number(haOptions.poll_interval_ms || process.env.POLL_INTERVAL_MS) || 2000;

// Persistent energy log file (/data directory is preserved across HA container restarts)
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const ENERGY_LOG_FILE = path.join(DATA_DIR, "energy-log.json");

// --- Home Assistant MQTT Integration ---
const HA_MQTT_BROKER = haOptions.mqtt_broker || process.env.HA_MQTT_BROKER || "mqtt://core-mosquitto:1883";
const HA_MQTT_USER = haOptions.mqtt_user || process.env.HA_MQTT_USER || "solar";
const HA_MQTT_PASS = haOptions.mqtt_pass || process.env.HA_MQTT_PASS || "";

// --- Clients ---
let modbus = new ModbusRTU();
const vue = new EmporiaVue();
const haMqtt = new HaMqttPublisher({
  brokerUrl: HA_MQTT_BROKER,
  username: HA_MQTT_USER,
  password: HA_MQTT_PASS,
});

let emporiaReady = false;
let emporiaDeviceGids = [];
let lastPollTime = null;

// --- Daemon Error Tracking & Diagnostics ---
const recentErrors = [];
let totalErrorCount = 0;
let lastErrorString = "None";
const lastLoggedErrorByKey = new Map();

function recordDaemonError(source, err) {
  const time = new Date().toLocaleTimeString();
  const rawMsg = err && err.message ? err.message : String(err || "Unknown error");
  const msg = rawMsg.replace(/\r?\n/g, " ").trim();
  const key = `${source}:${msg}`;
  const now = Date.now();

  // Deduplicate identical errors within 30 seconds to avoid log flooding
  const prevTime = lastLoggedErrorByKey.get(key) || 0;
  if (now - prevTime < 30000) {
    return;
  }
  lastLoggedErrorByKey.set(key, now);

  totalErrorCount++;
  lastErrorString = `[${time}] [${source}] ${msg}`;

  recentErrors.unshift({
    time,
    source,
    message: msg.slice(0, 180),
  });
  if (recentErrors.length > 10) {
    recentErrors.pop();
  }
  console.warn(`[Daemon Error][${source}] ${msg}`);
}

// --- Energy Log Persistence ---
function loadEnergyLog() {
  try {
    if (fs.existsSync(ENERGY_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(ENERGY_LOG_FILE, "utf8"));
    }
  } catch (err) {
    console.error("[Log] Error reading log file:", err.message);
  }
  return {};
}

function saveEnergyLog(logData) {
  try {
    fs.writeFileSync(ENERGY_LOG_FILE, JSON.stringify(logData, null, 2), "utf8");
  } catch (err) {
    console.error("[Log] Error writing log file:", err.message);
  }
}

const energyLog = loadEnergyLog();

function getTodayEntry(logData) {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (!logData[dateKey]) {
    logData[dateKey] = {
      solarKwh: 0,
      consumptionKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      peakSolarW: 0,
      peakConsumptionW: 0,
      lastUpdated: now.toISOString(),
    };
  }
  return logData[dateKey];
}

function toSigned16(val) { return val > 32767 ? val - 65536 : val; }
function scaleSE(val, sf) {
  if (val === 0x8000 || val === 0x7fff || val === 0xffff || val === undefined) return null;
  return Number((val * Math.pow(10, sf)).toFixed(2));
}

async function ensureModbusConnection() {
  if (modbus && modbus.isOpen) return true;
  try {
    if (modbus) {
      try { modbus.close(); } catch { }
    }
    modbus = new ModbusRTU();
    await modbus.connectTCP(INVERTER_IP, { port: MODBUS_PORT });
    modbus.setID(UNIT_ID);
    modbus.setTimeout(5000);
    return true;
  } catch (err) {
    recordDaemonError("SolarEdge Modbus", `Connection failed (${INVERTER_IP}:${MODBUS_PORT}): ${err.message}`);
    return false;
  }
}

async function fetchSolarEdge() {
  const connected = await ensureModbusConnection();
  if (!connected) return null;

  try {
    const raw = await modbus.readHoldingRegisters(40069, 40);
    const d = raw.data;

    const acPowerRaw = toSigned16(d[14]);
    const acPowerSf = toSigned16(d[15]);
    const acWatts = scaleSE(acPowerRaw, acPowerSf) || 0;

    const energyWh = (d[24] << 16) | d[25];
    const energySf = toSigned16(d[26]);
    const lifetimeKwh = (energyWh * Math.pow(10, energySf)) / 1000.0;

    const dcWatts = scaleSE(toSigned16(d[31]), toSigned16(d[32])) || 0;
    const heatSinkC = scaleSE(toSigned16(d[34]), toSigned16(d[37])) || 0;

    return {
      acWatts: Math.max(0, acWatts),
      dcWatts: Math.max(0, dcWatts),
      lifetimeKwh: Number(lifetimeKwh.toFixed(2)),
      heatSinkC,
    };
  } catch (err) {
    recordDaemonError("SolarEdge Modbus", `Register read failed: ${err.message}`);
    try { modbus.close(); } catch { }
    return null;
  }
}

async function fetchEmporia() {
  if (!emporiaReady || emporiaDeviceGids.length === 0) return null;

  try {
    const usageDict = await vue.getDeviceListUsage(emporiaDeviceGids, new Date(), Scale.SECOND);
    let mainNetWatts = 0;
    const circuits = [];

    for (const [gid, deviceUsage] of Object.entries(usageDict)) {
      const channels = deviceUsage.channelUsages || {};
      const mainCh = channels["1,2,3"] || channels["TotalUsage"];
      if (mainCh) {
        mainNetWatts += (mainCh.usage || 0) * 3600 * 1000;
      }

      for (const [chNum, ch] of Object.entries(channels)) {
        if (["1,2,3", "TotalUsage", "Balance"].includes(chNum)) continue;
        circuits.push({
          name: ch.name || `Circuit ${chNum}`,
          watts: Math.round((ch.usage || 0) * 3600 * 1000),
        });
      }
    }

    return {
      mainNetWatts: Math.round(mainNetWatts),
      circuits,
    };
  } catch (err) {
    recordDaemonError("Emporia Vue", `Cloud fetch failed: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`[${new Date().toLocaleTimeString()}] Starting Solar & Energy Daemon (HA Add-on)...`);
  console.log(`[Config] Inverter: ${INVERTER_IP}:${MODBUS_PORT} | Polling: ${POLL_INTERVAL}ms`);
  console.log(`[Config] MQTT: ${HA_MQTT_BROKER} (User: ${HA_MQTT_USER})`);
  console.log(`[Config] Persistence path: ${ENERGY_LOG_FILE}`);

  // Connect to Home Assistant MQTT
  haMqtt.connect();

  // Authenticate Emporia Vue
  try {
    await vue.login({ username: EMPORIA_USER, password: EMPORIA_PASS });
    const devices = await vue.getDevices();
    emporiaDeviceGids = devices.map(d => d.deviceGid);
    emporiaReady = true;
    console.log(`[${new Date().toLocaleTimeString()}] Emporia authenticated (${devices.length} devices).`);
  } catch (err) {
    console.warn(`[${new Date().toLocaleTimeString()}] Emporia login failed:`, err.message);
  }

  // Modbus check
  const mbOk = await ensureModbusConnection();
  console.log(`[${new Date().toLocaleTimeString()}] Modbus TCP connected: ${mbOk}`);

  let lastSolar = null;
  let lastEmporia = null;

  while (true) {
    try {
      const now = new Date();
      const [solar, emporia] = await Promise.all([
        fetchSolarEdge(),
        emporiaReady ? fetchEmporia() : Promise.resolve(null),
      ]);

      if (solar) lastSolar = solar;
      if (emporia) lastEmporia = emporia;

      const solarProdW = lastSolar ? lastSolar.acWatts : 0;
      const houseConsumptionW = lastEmporia ? lastEmporia.mainNetWatts : 0;
      const gridNetW = houseConsumptionW - solarProdW;
      const selfPoweredPct = houseConsumptionW > 0
        ? Math.min((solarProdW / houseConsumptionW) * 100, 100)
        : (solarProdW > 0 ? 100 : 0);

      // Accumulation
      const today = getTodayEntry(energyLog);
      if (lastPollTime !== null) {
        const elapsedHrs = (now.getTime() - lastPollTime) / 3600000;
        if (elapsedHrs > 0 && elapsedHrs < 30 / 3600) {
          today.solarKwh += (solarProdW / 1000) * elapsedHrs;
          today.consumptionKwh += (houseConsumptionW / 1000) * elapsedHrs;
          if (gridNetW > 0) {
            today.gridImportKwh += (gridNetW / 1000) * elapsedHrs;
          } else {
            today.gridExportKwh += (Math.abs(gridNetW) / 1000) * elapsedHrs;
          }
        }
      }
      if (solarProdW > today.peakSolarW) today.peakSolarW = solarProdW;
      if (houseConsumptionW > today.peakConsumptionW) today.peakConsumptionW = houseConsumptionW;
      today.lastUpdated = now.toISOString();
      lastPollTime = now.getTime();

      saveEnergyLog(energyLog);

      const lifetimeKwh = lastSolar ? lastSolar.lifetimeKwh : 0;
      const heatSinkF = lastSolar ? (lastSolar.heatSinkC * 9) / 5 + 32 : 0;

      if (haMqtt.connected) {
        haMqtt.publishData({
          solarProdW,
          houseConsumptionW,
          gridNetW,
          selfPoweredPct,
          dcWatts: lastSolar ? lastSolar.dcWatts : 0,
          heatSinkF,
          solarTodayKwh: today.solarKwh,
          houseTodayKwh: today.consumptionKwh,
          gridImportTodayKwh: today.gridImportKwh,
          gridExportTodayKwh: today.gridExportKwh,
          lifetimeKwh,
          importCostToday: today.gridImportKwh * IMPORT_RATE_KWH,
          exportCreditToday: today.gridExportKwh * EXPORT_RATE_KWH,
          netCostToday: (today.gridImportKwh * IMPORT_RATE_KWH) - (today.gridExportKwh * EXPORT_RATE_KWH),
          circuits: lastEmporia ? lastEmporia.circuits : [],
          uptimeHours: process.uptime() / 3600,
          memoryMb: process.memoryUsage().rss / 1024 / 1024,
          errorCount: totalErrorCount,
          lastError: lastErrorString,
          errorLog: recentErrors,
        });
      }
    } catch (err) {
      recordDaemonError("Poll Cycle", err);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

process.on("uncaughtException", (err) => {
  recordDaemonError("Uncaught Exception", err);
});

process.on("unhandledRejection", (reason) => {
  recordDaemonError("Unhandled Rejection", reason);
});

main();
