// ============================================================================
//  UNIFIED HOME ENERGY DASHBOARD
//  Combines SolarEdge Inverter (Modbus TCP) + Emporia Vue (AWS Cloud)
//  to compute real-time net production, consumption, and self-sufficiency.
// ============================================================================
require("./env");
const ModbusRTU = require("modbus-serial");
const { EmporiaVue, Scale } = require("emporia-vue-lib");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// --- Configuration ---
const INVERTER_IP = process.env.INVERTER_IP || "127.0.0.1";
const MODBUS_PORT = Number(process.env.MODBUS_PORT) || 502;
const UNIT_ID = 1;
const RATED_AC_WATTS = Number(process.env.RATED_AC_WATTS) || 7600;
const IMPORT_RATE_KWH = process.env.IMPORT_RATE_KWH !== undefined ? Number(process.env.IMPORT_RATE_KWH) : 0.14;  // Rate per kWh imported
const EXPORT_RATE_KWH = process.env.EXPORT_RATE_KWH !== undefined ? Number(process.env.EXPORT_RATE_KWH) : 0.01;  // Rate per kWh exported

const EMPORIA_USER = process.env.EMPORIA_USER || "";
const EMPORIA_PASS = process.env.EMPORIA_PASS || "";

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 2000;
const ENERGY_LOG_FILE = path.join(__dirname, "energy-log.json");

// --- Home Assistant MQTT Integration ---
const HaMqttPublisher = require("./ha-mqtt");
const HA_MQTT_ENABLED = process.env.HA_MQTT_ENABLED !== "false";
const HA_MQTT_BROKER = process.env.HA_MQTT_BROKER || "mqtt://localhost:1883";
const HA_MQTT_USER = process.env.HA_MQTT_USER || "solar";
const HA_MQTT_PASS = process.env.HA_MQTT_PASS || "";

// --- Clients ---
const modbus = new ModbusRTU();
const vue = new EmporiaVue();
const haMqtt = HA_MQTT_ENABLED
  ? new HaMqttPublisher({ brokerUrl: HA_MQTT_BROKER, username: HA_MQTT_USER, password: HA_MQTT_PASS })
  : null;

// --- ANSI Color Codes ---
const C = {
  RST: "\x1b[0m", BLD: "\x1b[1m", DIM: "\x1b[2m",
  GRN: "\x1b[32m", YEL: "\x1b[33m", CYN: "\x1b[36m",
  RED: "\x1b[31m", WHT: "\x1b[37m", MAG: "\x1b[35m",
  BGD: "\x1b[44m", // Blue background
  BGB: "\x1b[42m", // Green background
  BGR: "\x1b[41m", // Red background
};

// --- Format Helpers ---
function toSigned16(val) { return val > 32767 ? val - 65536 : val; }

function scaleSE(val, sf) {
  if (val === 0x8000 || val === 0x7fff || val === 0xffff || val === undefined) return null;
  return Number((val * Math.pow(10, sf)).toFixed(2));
}

function stripAnsi(str) { return str.replace(/\x1b\[[0-9;]*m/g, ""); }

function fmtW(watts) {
  const abs = Math.abs(watts);
  if (abs >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  return `${Math.round(watts)} W`;
}

function fmtWColored(watts, positiveColor = C.GRN, negativeColor = C.RED) {
  return `${watts >= 0 ? positiveColor : negativeColor}${fmtW(watts)}${C.RST}`;
}

// --- Box Drawing Helpers (adapted from monitor-live.js) ---
function boxHeader(title, width = 36) {
  const cleanTitle = stripAnsi(title);
  const dashCount = width - cleanTitle.length - 1;
  return ` ${C.DIM}┌─${C.RST} ${title} ${C.DIM}${"─".repeat(Math.max(0, dashCount))}─┐${C.RST}`;
}

function boxRow(content, width = 36) {
  const cleanContent = stripAnsi(content);
  const spaceCount = width - cleanContent.length;
  return ` ${C.DIM}│${C.RST} ${content}${" ".repeat(Math.max(0, spaceCount))}${C.DIM}│${C.RST}`;
}

function boxFooter(width = 36) {
  return ` ${C.DIM}└${"─".repeat(width + 1)}┘${C.RST}`;
}

function buildDualPanel(titleL, contentL, titleR, contentR) {
  let out = boxHeader(titleL) + "   " + boxHeader(titleR) + "\n";
  const maxRows = Math.max(contentL.length, contentR.length);
  for (let i = 0; i < maxRows; i++) {
    const cL = contentL[i] || "";
    const cR = contentR[i] || "";
    out += boxRow(cL) + "   " + boxRow(cR) + "\n";
  }
  out += boxFooter() + "   " + boxFooter() + "\n";
  return out;
}

function buildSinglePanel(title, content, width = 78) {
  const cleanTitle = stripAnsi(title);
  const dashCount = width - cleanTitle.length - 1;
  let out = ` ${C.DIM}┌─${C.RST} ${title} ${C.DIM}${"─".repeat(Math.max(0, dashCount))}─┐${C.RST}\n`;
  for (const line of content) {
    const cleanLine = stripAnsi(line);
    const spaceCount = width - cleanLine.length;
    out += ` ${C.DIM}│${C.RST} ${line}${" ".repeat(Math.max(0, spaceCount))}${C.DIM}│${C.RST}\n`;
  }
  out += ` ${C.DIM}└${"─".repeat(width + 1)}┘${C.RST}\n`;
  return out;
}

function getAsciiBar(current, max, width = 14, color = C.CYN) {
  const ratio = Math.min(Math.max(current / max, 0), 1);
  const filledCount = Math.round(ratio * width);
  const emptyCount = width - filledCount;
  const bar = `${color}${"█".repeat(filledCount)}${C.DIM}${"─".repeat(emptyCount)}${C.RST}`;
  return `[${bar}] ${(ratio * 100).toFixed(1)}%`;
}

function getFlowArrow(watts, label, leftToRight = true) {
  if (Math.abs(watts) < 5) return `${C.DIM}── ${label}: 0 W ──${C.RST}`;
  const arrow = leftToRight ? "►" : "◄";
  const color = watts > 0 ? C.GRN : C.RED;
  return `${color}${arrow}${arrow} ${label}: ${fmtW(Math.abs(watts))} ${arrow}${arrow}${C.RST}`;
}

// --- Status Map ---
const STATUS_MAP = {
  1: "OFF", 2: "SLEEPING", 3: "WAKING / GRID CHECK",
  4: "PRODUCING / MPPT", 5: "THROTTLED", 6: "SHUTTING DOWN",
  7: "FAULT ACTIVE", 8: "STANDBY"
};

const EVENT_FLAGS = [
  { bit: 0, desc: "Ground Fault" }, { bit: 1, desc: "DC Overvolt" },
  { bit: 4, desc: "Grid Overvolt" }, { bit: 6, desc: "Freq High" },
  { bit: 10, desc: "Thermal Derating" }, { bit: 12, desc: "DC Arc Fault" }
];

function parseEventBits(mask) {
  if (!mask || mask === 0) return `${C.GRN}Clean (0x0)${C.RST}`;
  const faults = EVENT_FLAGS.filter(f => (mask & (1 << f.bit)) !== 0).map(f => f.desc);
  const text = faults.length > 0 ? faults[0] + (faults.length > 1 ? "..." : "") : `0x${mask.toString(16)}`;
  return `${C.RED}${text}${C.RST}`;
}

// --- Persistent Energy Log (disk-backed) ---
function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadEnergyLog() {
  try {
    if (fs.existsSync(ENERGY_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(ENERGY_LOG_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveEnergyLog(log) {
  try {
    fs.writeFileSync(ENERGY_LOG_FILE, JSON.stringify(log, null, 2));
  } catch {}
}

function getTodayEntry(log) {
  const key = getTodayKey();
  if (!log[key]) {
    log[key] = {
      solarKwh: 0,
      consumptionKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      peakSolarW: 0,
      peakConsumptionW: 0,
      lastUpdated: new Date().toISOString(),
    };
  }
  return log[key];
}

let energyLog = loadEnergyLog();
let lastPollTime = null; // Tracks time between polls for energy accumulation

// --- Runtime State ---
let emporiaDeviceGids = [];
let emporiaDevices = [];
let emporiaReady = false;
let lastEmporiaData = null;
let lastSolarData = null;
let consecutiveEmporiaErrors = 0;
let consecutiveModbusErrors = 0;

// --- Data Fetchers ---
async function ensureModbusConnection() {
  if (modbus.isOpen) return true;
  try {
    await modbus.connectTCP(INVERTER_IP, { port: MODBUS_PORT });
    modbus.setID(UNIT_ID);
    modbus.setTimeout(3500);
    consecutiveModbusErrors = 0;
    return true;
  } catch {
    consecutiveModbusErrors++;
    return false;
  }
}

async function fetchSolarEdge() {
  try {
    if (!await ensureModbusConnection()) return null;

    const res = await modbus.readHoldingRegisters(40069, 42);
    const r = (addr) => res.data[addr - 40069];

    const power_sf = toSigned16(r(40084));
    const energy_sf = toSigned16(r(40095));
    const dc_w_sf = toSigned16(r(40101));

    const acWatts = scaleSE(toSigned16(r(40083)), power_sf) || 0;
    const dcWatts = scaleSE(toSigned16(r(40100)), dc_w_sf) || 0;
    const dcVolts = scaleSE(r(40098), toSigned16(r(40099))) || 0;
    const gridVolts = scaleSE(r(40076), toSigned16(r(40082))) || 0;
    const gridFreq = scaleSE(r(40085), toSigned16(r(40086))) || 0;
    const rawWh = ((r(40093) << 16) | r(40094)) >>> 0;
    const lifetimeKwh = Number(((rawWh * Math.pow(10, energy_sf)) / 1000).toFixed(2));
    const heatSinkC = scaleSE(toSigned16(r(40103)), toSigned16(r(40106))) || 0;
    const statusRaw = r(40107);
    const eventMask = r(40108);

    consecutiveModbusErrors = 0;
    return { acWatts, dcWatts, dcVolts, gridVolts, gridFreq, lifetimeKwh, heatSinkC, statusRaw, eventMask };
  } catch {
    consecutiveModbusErrors++;
    try { modbus.close(); } catch {}
    return null;
  }
}

async function fetchEmporia() {
  try {
    const usageDict = await vue.getDeviceListUsage(emporiaDeviceGids, new Date(), Scale.SECOND);
    const result = { mainNetWatts: 0, circuits: [] };

    for (const [gid, deviceUsage] of Object.entries(usageDict)) {
      const mainChannel = deviceUsage.channelUsages["1,2,3"] || deviceUsage.channelUsages["TotalUsage"];
      result.mainNetWatts = mainChannel ? mainChannel.usage * 3600 * 1000 : 0;

      for (const [channelNum, channel] of Object.entries(deviceUsage.channelUsages)) {
        if (["1,2,3", "TotalUsage", "Balance"].includes(channelNum)) continue;
        result.circuits.push({
          name: channel.name || `Circuit ${channelNum}`,
          watts: channel.usage * 3600 * 1000,
        });
      }
    }

    consecutiveEmporiaErrors = 0;
    return result;
  } catch {
    consecutiveEmporiaErrors++;
    return null;
  }
}

// --- Render Dashboard ---
function render(solar, emporia) {
  const buf = []; // Build entire frame into a buffer, then write all at once

  const now = new Date();
  const localTime = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fullDate = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  // --- Compute Energy Balance ---
  const solarProdW = solar ? solar.acWatts : 0;
  // Emporia mains (1,2,3 / TotalUsage) = total house consumption
  const houseConsumptionW = emporia ? emporia.mainNetWatts : 0;
  // Grid Net = what the house needs beyond solar. Negative = exporting surplus.
  const gridNetW = houseConsumptionW - solarProdW;
  const selfPoweredPct = houseConsumptionW > 0 ? Math.min((solarProdW / houseConsumptionW) * 100, 100) : (solarProdW > 0 ? 100 : 0);
  const isExporting = gridNetW < 0;

  // --- Accumulate energy (Watts × elapsed hours → kWh) and persist ---
  const today = getTodayEntry(energyLog);
  if (lastPollTime !== null) {
    const elapsedHrs = (now.getTime() - lastPollTime) / 3600000;
    // Only accumulate if elapsed time is reasonable (< 30s, to skip stale gaps)
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

  // Save to disk every render (file is small, writes are fast)
  saveEnergyLog(energyLog);

  // Solar-derived values
  const lifetimeKwh = solar ? solar.lifetimeKwh : 0;
  const efficiencyPct = solar && solar.dcWatts > 0 ? ((solar.acWatts / solar.dcWatts) * 100).toFixed(1) : "0.0";
  const heatSinkF = solar ? ((solar.heatSinkC * 9) / 5 + 32).toFixed(1) : "0.0";

  // Publish real-time data to Home Assistant via MQTT
  if (haMqtt && haMqtt.connected) {
    haMqtt.publishData({
      solarProdW,
      houseConsumptionW,
      gridNetW,
      selfPoweredPct,
      dcWatts: solar ? solar.dcWatts : 0,
      heatSinkF: Number(heatSinkF),
      solarTodayKwh: today.solarKwh,
      houseTodayKwh: today.consumptionKwh,
      gridImportTodayKwh: today.gridImportKwh,
      gridExportTodayKwh: today.gridExportKwh,
      lifetimeKwh,
      importCostToday: today.gridImportKwh * IMPORT_RATE_KWH,
      exportCreditToday: today.gridExportKwh * EXPORT_RATE_KWH,
      netCostToday: (today.gridImportKwh * IMPORT_RATE_KWH) - (today.gridExportKwh * EXPORT_RATE_KWH),
      circuits: emporia ? emporia.circuits : [],
    });
  }

  // --- Build the UI into buffer ---

  // Title Bar
  const titleText = " ".repeat(18) + "⚡ UNIFIED HOME ENERGY DASHBOARD ⚡" + " ".repeat(18);
  buf.push(`\n${C.BGD}${C.WHT}${C.BLD}${titleText}${C.RST}\n`);

  // Timestamp & Status
  const statusStr = solar ? (STATUS_MAP[solar.statusRaw] || `CODE ${solar.statusRaw}`) : "NO MODBUS";
  const statusColor = solar && solar.statusRaw === 4 ? C.GRN : C.YEL;
  const haStatus = haMqtt && haMqtt.connected ? `${C.GRN}HA: CONNECTED${C.RST}` : `${C.DIM}HA: OFF${C.RST}`;
  const headerL = `  [ ${localTime} | ${fullDate} ]`;
  const headerR = `${haStatus}  |  Inverter: ${statusColor}${statusStr}${C.RST}  `;
  const spaces = Math.max(0, 83 - headerL.length - stripAnsi(headerR).length);
  buf.push(headerL + " ".repeat(spaces) + headerR + "\n");

  // ═══════════════════════════════════════════════════════════════
  // ENERGY FLOW DIAGRAM
  // ═══════════════════════════════════════════════════════════════
  const flowLines = [];

  // Line 1: Visual flow
  const solarIcon = `${C.YEL}☀ SOLAR${C.RST}`;
  const houseIcon = `${C.CYN}🏠 HOUSE${C.RST}`;
  const gridIcon = isExporting ? `${C.GRN}⚡ GRID${C.RST}` : `${C.RED}⚡ GRID${C.RST}`;
  const solarToHouse = solarProdW > 5 ? `${C.GRN}══► ${fmtW(solarProdW)} ══►${C.RST}` : `${C.DIM}─── 0 W ───${C.RST}`;
  const gridFlow = isExporting
    ? `${C.GRN}◄══ ${fmtW(Math.abs(gridNetW))} ══►${C.RST}`
    : (gridNetW > 5 ? `${C.RED}◄══ ${fmtW(gridNetW)} ══►${C.RST}` : `${C.DIM}─── 0 W ───${C.RST}`);

  flowLines.push(`    ${solarIcon}  ${solarToHouse}  ${houseIcon}  ${gridFlow}  ${gridIcon}`);
  flowLines.push(``);

  // Line 2: Summary stats
  const prodLabel = `Producing: ${C.YEL}${fmtW(solarProdW)}${C.RST}`;
  const consumeLabel = `Consuming: ${C.CYN}${fmtW(houseConsumptionW)}${C.RST}`;
  const gridLabel = isExporting
    ? `Exporting: ${C.GRN}${fmtW(Math.abs(gridNetW))}${C.RST}`
    : `Importing: ${C.RED}${fmtW(gridNetW)}${C.RST}`;
  flowLines.push(`    ${prodLabel}       ${consumeLabel}       ${gridLabel}`);

  // Self-powered bar
  const spBar = getAsciiBar(selfPoweredPct, 100, 20, selfPoweredPct >= 100 ? C.GRN : (selfPoweredPct > 50 ? C.YEL : C.RED));
  flowLines.push(``);
  flowLines.push(`    Self-Powered: ${spBar}  ${selfPoweredPct >= 100 ? C.GRN + "NET ZERO+" + C.RST : ""}`);

  buf.push(buildSinglePanel(`${C.BLD}${C.YEL}ENERGY FLOW${C.RST}`, flowLines));

  // ═══════════════════════════════════════════════════════════════
  // DUAL PANEL: SOLAR PRODUCTION & GRID / CONSUMPTION
  // ═══════════════════════════════════════════════════════════════
  const solarPanel = [
    `AC Output:       ${C.GRN}${fmtW(solarProdW)}${C.RST}`,
    `DC Array:        ${C.CYN}${fmtW(solar ? solar.dcWatts : 0)}${C.RST}`,
    `Efficiency:      ${efficiencyPct}%`,
    ``,
    `Peak Today:      ${C.CYN}${fmtW(today.peakSolarW)}${C.RST}`,
    `Load: ${getAsciiBar(solarProdW, RATED_AC_WATTS)}`
  ];

  const consumptionPanel = [
    `House Total:     ${C.CYN}${fmtW(houseConsumptionW)}${C.RST}`,
    `Grid Net:        ${isExporting ? C.GRN : C.RED}${fmtW(gridNetW)} ${isExporting ? "(export)" : "(import)"}${C.RST}`,
    `Self-Powered:    ${selfPoweredPct.toFixed(1)}%`,
    ``,
    `Peak Demand:     ${C.YEL}${fmtW(today.peakConsumptionW)}${C.RST}`,
    `Import Rate:     $${((Math.max(gridNetW, 0) / 1000) * IMPORT_RATE_KWH).toFixed(2)} / hr`,
  ];

  buf.push(buildDualPanel(`${C.BLD}${C.YEL}☀ SOLAR PRODUCTION${C.RST}`, solarPanel, `${C.BLD}${C.CYN}🏠 GRID & CONSUMPTION${C.RST}`, consumptionPanel));

  // ═══════════════════════════════════════════════════════════════
  // DUAL PANEL: ACCUMULATION & INVERTER VITALS
  // ═══════════════════════════════════════════════════════════════
  const isClipping = solar && solar.acWatts >= 7580 && solar.dcWatts > solar.acWatts + 100;
  const dcBusStatus = solar
    ? ((solar.dcVolts >= 340 && solar.dcVolts <= 400) ? `${C.GRN}Optimal${C.RST}` : (solar.dcVolts > 0 ? `${C.YEL}Off-Target${C.RST}` : `${C.DIM}Inactive${C.RST}`))
    : `${C.DIM}N/A${C.RST}`;

  // Cost / earnings math
  const importCost = today.gridImportKwh * IMPORT_RATE_KWH;   // You paid CPS
  const exportEarnings = today.gridExportKwh * EXPORT_RATE_KWH; // CPS pays you
  const netCost = importCost - exportEarnings; // Positive = you owe, negative = you earned

  const accumPanel = [
    `Solar Produced:  ${C.GRN}${today.solarKwh.toFixed(2)} kWh${C.RST}`,
    `House Consumed:  ${C.CYN}${today.consumptionKwh.toFixed(2)} kWh${C.RST}`,
    `Grid Imported:   ${C.RED}${today.gridImportKwh.toFixed(2)} kWh${C.RST}  ${C.DIM}($${importCost.toFixed(2)})${C.RST}`,
    `Grid Exported:   ${C.GRN}${today.gridExportKwh.toFixed(2)} kWh${C.RST}  ${C.DIM}(+$${exportEarnings.toFixed(2)})${C.RST}`,
    ``,
    `Net Today:       ${netCost >= 0 ? C.RED + "-$" + netCost.toFixed(2) : C.GRN + "+$" + Math.abs(netCost).toFixed(2)}${C.RST}`,
    `Lifetime Solar:  ${lifetimeKwh.toLocaleString()} kWh`,
  ];

  const vitalsPanel = [
    `Heat Sink:       ${solar ? solar.heatSinkC : 0}°C (${heatSinkF}°F)`,
    `Clipping:        ${isClipping ? C.RED + "YES" + C.RST : C.GRN + "No" + C.RST}`,
    `Faults:          ${solar ? parseEventBits(solar.eventMask) : C.DIM + "N/A" + C.RST}`,
    `DC Bus:          ${solar ? solar.dcVolts : 0} V (${dcBusStatus})`,
    `Grid:            ${solar ? solar.gridVolts : 0} V @ ${solar ? solar.gridFreq : 0} Hz`,
  ];

  buf.push(buildDualPanel(`${C.BLD}ACCUMULATION${C.RST}`, accumPanel, `${C.BLD}INVERTER VITALS${C.RST}`, vitalsPanel));

  // ═══════════════════════════════════════════════════════════════
  // CIRCUIT BREAKDOWN (from Emporia Vue)
  // ═══════════════════════════════════════════════════════════════
  if (emporia && emporia.circuits.length > 0) {
    const circuitLines = [];
    // Sort by wattage descending
    const sorted = [...emporia.circuits].sort((a, b) => b.watts - a.watts);
    const maxCircuitW = Math.max(...sorted.map(c => c.watts), 1);

    for (const circuit of sorted) {
      const w = Math.round(circuit.watts);
      const bar = getAsciiBar(circuit.watts, maxCircuitW, 10, circuit.watts > 500 ? C.YEL : C.CYN);
      const pctOfTotal = houseConsumptionW > 0 ? ((circuit.watts / houseConsumptionW) * 100).toFixed(1) : "0.0";
      circuitLines.push(`${circuit.name.padEnd(25)} ${String(w + " W").padStart(7)}  ${bar}  ${pctOfTotal}%`);
    }

    // Add a "Balance / Unmonitored" row
    const monitoredTotal = sorted.reduce((sum, c) => sum + c.watts, 0);
    const unmonitored = houseConsumptionW - monitoredTotal;
    if (Math.abs(unmonitored) > 5) {
      const uBar = getAsciiBar(Math.abs(unmonitored), maxCircuitW, 10, C.DIM);
      const uPct = houseConsumptionW > 0 ? ((Math.abs(unmonitored) / houseConsumptionW) * 100).toFixed(1) : "0.0";
      circuitLines.push(`${"(unmonitored circuits)".padEnd(25)} ${String(Math.round(unmonitored) + " W").padStart(7)}  ${uBar}  ${uPct}%`);
    }

    buf.push(buildSinglePanel(`${C.BLD}${C.MAG}⚡ CIRCUIT BREAKDOWN${C.RST}  ${C.DIM}(Emporia Vue)${C.RST}`, circuitLines));
  }

  // ═══════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════
  const modbusStatus = consecutiveModbusErrors === 0 ? `${C.GRN}●${C.RST}` : `${C.RED}●(${consecutiveModbusErrors})${C.RST}`;
  const emporiaStatus = consecutiveEmporiaErrors === 0 ? `${C.GRN}●${C.RST}` : `${C.RED}●(${consecutiveEmporiaErrors})${C.RST}`;
  const footerText = `Modbus ${modbusStatus} ${INVERTER_IP}  |  Emporia ${emporiaStatus} AWS Cloud  |  Refresh: ${POLL_INTERVAL / 1000}s  |  Ctrl+C to Exit`;
  const fPad = Math.max(0, 83 - stripAnsi(footerText).length) / 2;
  buf.push(C.DIM + " ".repeat(Math.floor(fPad)) + footerText + C.RST + "\n");

  // --- Write entire frame at once: cursor home + clear to end + frame ---
  const frame = buf.join("\n");
  process.stdout.write("\x1b[H\x1b[J" + frame);
}

// --- Main Loop ---
async function main() {
  process.stdout.write("\x1B[?25l"); // Hide cursor
  console.clear();
  console.log(`\n${C.BLD}Initializing connections...${C.RST}`);

  // 0. Connect to Home Assistant MQTT
  if (haMqtt) {
    console.log(`  ${C.DIM}[0/3]${C.RST} Connecting to Home Assistant MQTT at ${HA_MQTT_BROKER}...`);
    haMqtt.connect();
  }

  // 1. Authenticate with Emporia Vue Cloud
  console.log(`  ${C.DIM}[1/3]${C.RST} Authenticating with Emporia Cloud...`);
  try {
    const loginOk = await vue.login({ username: EMPORIA_USER, password: EMPORIA_PASS });
    if (!loginOk) throw new Error("Login returned false");
    const devices = await vue.getDevices();
    emporiaDevices = devices;
    emporiaDeviceGids = devices.map(d => d.deviceGid);
    emporiaReady = true;
    console.log(`  ${C.GRN}✓${C.RST} Emporia authenticated. Found ${devices.length} device(s).`);
  } catch (err) {
    console.log(`  ${C.RED}✗${C.RST} Emporia login failed: ${err.message}`);
    console.log(`  ${C.DIM}  Dashboard will run without Emporia data.${C.RST}`);
  }

  // 2. Connect to SolarEdge Inverter
  console.log(`  ${C.DIM}[2/3]${C.RST} Connecting to SolarEdge at ${INVERTER_IP}:${MODBUS_PORT}...`);
  const modbusOk = await ensureModbusConnection();
  if (modbusOk) {
    console.log(`  ${C.GRN}✓${C.RST} Modbus TCP connected.`);
  } else {
    console.log(`  ${C.RED}✗${C.RST} Modbus connection failed. Will retry in loop.`);
  }

  // 3. Start polling loop
  console.log(`\n  ${C.DIM}[3/3]${C.RST} Starting live dashboard (every ${POLL_INTERVAL / 1000}s)...\n`);
  await new Promise(r => setTimeout(r, 1500));

  // Switch to alternate screen buffer (like vim/htop) so the dashboard
  // doesn't pollute terminal scrollback history
  process.stdout.write("\x1b[?1049h"); // Enter alternate screen
  process.stdout.write("\x1B[?25l");   // Hide cursor again in alt screen

  while (true) {
    // Fire both data fetches in parallel
    const [solar, emporia] = await Promise.all([
      fetchSolarEdge(),
      emporiaReady ? fetchEmporia() : Promise.resolve(null),
    ]);

    if (solar) lastSolarData = solar;
    if (emporia) lastEmporiaData = emporia;

    // Render with the freshest data we have
    render(lastSolarData, lastEmporiaData);

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// --- Clean Exit ---
process.on("SIGINT", () => {
  process.stdout.write("\x1b[?1049l"); // Leave alternate screen (restores previous terminal)
  process.stdout.write("\x1B[?25h");   // Restore cursor
  console.log("Closing connections. Goodbye!");
  try { modbus.close(); } catch {}
  if (haMqtt) haMqtt.close();
  process.exit();
});

main().catch(err => {
  process.stdout.write("\x1b[?1049l");
  process.stdout.write("\x1B[?25h");
  console.error("Fatal error:", err);
  process.exit(1);
});
