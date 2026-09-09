require("./env");
const ModbusRTU = require("modbus-serial");
const readline = require("readline");
const client = new ModbusRTU();

const INVERTER_IP = process.env.INVERTER_IP || "127.0.0.1";
const PORT = Number(process.env.MODBUS_PORT) || 502;
const UNIT_ID = 1;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 2000;
const RATED_AC_WATTS = Number(process.env.RATED_AC_WATTS) || 7600;
const RATE_KWH = process.env.IMPORT_RATE_KWH !== undefined ? Number(process.env.IMPORT_RATE_KWH) : 0.14;

// --- ANSI UI Color Codes ---
const C = {
  RST: "\x1b[0m", BLD: "\x1b[1m", DIM: "\x1b[2m",
  GRN: "\x1b[32m", YEL: "\x1b[33m", CYN: "\x1b[36m",
  RED: "\x1b[31m", WHT: "\x1b[37m", BBL: "\x1b[44m"
};

// --- Format Helpers ---
function toSigned16(val) { return val > 32767 ? val - 65536 : val; }

function scale(val, sf) {
  if (val === 0x8000 || val === 0x7fff || val === 0xffff || val === undefined) return null;
  return Number((val * Math.pow(10, sf)).toFixed(2));
}

function stripAnsi(str) { return str.replace(/\x1b\[[0-9;]*m/g, ""); }

// --- Dashboard Layout Generators ---
function boxHeader(title) {
  const cleanTitle = stripAnsi(title);
  const dashCount = 34 - cleanTitle.length - 1; 
  return ` ${C.DIM}┌─${C.RST} ${title} ${C.DIM}${"─".repeat(Math.max(0, dashCount))}─┐${C.RST}`;
}

function boxRow(content) {
  const cleanContent = stripAnsi(content);
  const spaceCount = 36 - cleanContent.length;
  return ` ${C.DIM}│${C.RST} ${content}${" ".repeat(Math.max(0, spaceCount))}${C.DIM}│${C.RST}`;
}

function buildDualPanel(titleL, contentL, titleR, contentR) {
  let out = boxHeader(titleL) + "   " + boxHeader(titleR) + "\n";
  const maxRows = Math.max(contentL.length, contentR.length);
  for (let i = 0; i < maxRows; i++) {
    const cL = contentL[i] || "";
    const cR = contentR[i] || "";
    out += boxRow(cL) + "   " + boxRow(cR) + "\n";
  }
  out += ` ${C.DIM}└${"─".repeat(37)}┘   └${"─".repeat(37)}┘${C.RST}\n`;
  return out;
}

function getAsciiBar(current, max, width = 14) {
  const ratio = Math.min(Math.max(current / max, 0), 1);
  const filledCount = Math.round(ratio * width);
  const emptyCount = width - filledCount;
  const bar = `${C.CYN}${"█".repeat(filledCount)}${C.DIM}${"-".repeat(emptyCount)}${C.RST}`;
  return `[${bar}] ${(ratio * 100).toFixed(1)}%`;
}

// --- Data Maps ---
const STATUS_MAP = {
  1: "OFF", 2: "SLEEPING", 3: "WAKING / GRID CHECK",
  4: "PRODUCING / MPPT", 5: "THROTTLED", 6: "SHUTTING DOWN",
  7: "FAULT ACTIVE", 8: "STANDBY"
};

const EVENT_FLAGS = [
  { bit: 0, desc: "Ground Fault" }, { bit: 1, desc: "DC Overvoltage" },
  { bit: 4, desc: "Grid Overvolt" }, { bit: 6, desc: "Freq High" },
  { bit: 10, desc: "Thermal Derating" }, { bit: 12, desc: "DC Arc Fault" }
];

function parseEventBits(mask) {
  if (!mask || mask === 0) return `${C.GRN}Clean (0x0)${C.RST}`;
  const faults = EVENT_FLAGS.filter(f => (mask & (1 << f.bit)) !== 0).map(f => f.desc);
  const text = faults.length > 0 ? faults[0] + (faults.length > 1 ? "..." : "") : `Fault 0x${mask.toString(16)}`;
  return `${C.RED}${text}${C.RST}`;
}

// --- Persistent State ---
let peakWattsToday = 0;
let midnightBaseKwh = null;
let currentDay = new Date().getDate();

// --- Main Loop ---
async function ensureConnection() {
  while (!client.isOpen) {
    try {
      await client.connectTCP(INVERTER_IP, { port: PORT });
      client.setID(UNIT_ID);
      client.setTimeout(3500);
      return;
    } catch (err) {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      console.log(`\n[${new Date().toLocaleTimeString()}] Retrying connection to ${INVERTER_IP}... `);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
}

async function startDashboard() {
  // Hide terminal cursor for a clean UI
  process.stdout.write('\x1B[?25l'); 
  console.clear(); // One-time hard clear on startup

  await ensureConnection();

  setInterval(async () => {
    try {
      if (!client.isOpen) await ensureConnection();

      const res = await client.readHoldingRegisters(40069, 42);
      const r = (addr) => res.data[addr - 40069];

      // Time tracking
      const now = new Date();
      if (now.getDate() !== currentDay) {
        currentDay = now.getDate();
        midnightBaseKwh = null;
        peakWattsToday = 0;
      }
      const localTime = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const fullDate = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

      // Scaling and Math
      const power_sf = toSigned16(r(40084));
      const energy_sf = toSigned16(r(40095));
      const dc_w_sf = toSigned16(r(40101));
      
      const acWatts = scale(toSigned16(r(40083)), power_sf) || 0;
      const dcWatts = scale(toSigned16(r(40100)), dc_w_sf) || 0;
      const dcVolts = scale(r(40098), toSigned16(r(40099))) || 0;
      const gridVolts = scale(r(40076), toSigned16(r(40082))) || 0;
      const gridFreq = scale(r(40085), toSigned16(r(40086))) || 0;
      
      const rawWh = ((r(40093) << 16) | r(40094)) >>> 0;
      const lifetimeKwh = Number(((rawWh * Math.pow(10, energy_sf)) / 1000).toFixed(2));
      const heatSinkC = scale(toSigned16(r(40103)), toSigned16(r(40106))) || 0;
      const heatSinkF = ((heatSinkC * 9) / 5 + 32).toFixed(1);
      
      const statusRaw = r(40107);
      
      // FIXED: Only read the primary SunSpec event register to avoid vendor bit collisions
      const eventMask = r(40108);

      // Derived Metrics
      if (acWatts > peakWattsToday) peakWattsToday = acWatts;
      if (midnightBaseKwh === null && lifetimeKwh > 0) midnightBaseKwh = lifetimeKwh;
      
      const todayKwh = midnightBaseKwh !== null ? (lifetimeKwh - midnightBaseKwh).toFixed(2) : "0.00";
      const dollarsPerHour = ((acWatts / 1000) * RATE_KWH).toFixed(2);
      const efficiencyPct = dcWatts > 0 ? ((acWatts / dcWatts) * 100).toFixed(1) : "0.0";
      const isClipping = acWatts >= 7580 && dcWatts > acWatts + 100;
      
      const dcBusStatus = (dcVolts >= 340 && dcVolts <= 400) ? `${C.GRN}Optimal${C.RST}` : (dcVolts > 0 ? `${C.YEL}Off-Target${C.RST}` : `${C.DIM}Inactive${C.RST}`);

      // --- UI Render Phase (Flicker-Free) ---
      // Move cursor to 0,0 and clear everything below it, then print
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);

      // Title
      const mainTitle = " ".repeat(26) + "SOLAREDGE SE7600 LIVE DASHBOARD" + " ".repeat(26);
      console.log(`\n${C.BBL}${C.WHT}${C.BLD}${mainTitle}${C.RST}\n`);

      // Time & Status Header
      const headerL = `  [ ${localTime} | ${fullDate} ]`;
      const statusStr = STATUS_MAP[statusRaw] || `CODE ${statusRaw}`;
      const headerR = `Status: ${C.GRN}${statusStr}${C.RST}  `;
      const spaces = Math.max(0, 83 - headerL.length - (8 + statusStr.length + 2)); 
      console.log(headerL + " ".repeat(spaces) + headerR + "\n");

      // Panel 1: Generation & Electrical
      const genL = [
        `Real-Time AC:    ${C.GRN}${(acWatts / 1000).toFixed(3)} kW${C.RST}`,
        `Generation Rate: ${C.YEL}$${dollarsPerHour} / hr${C.RST}`,
        ``,
        `Peak Today:      ${C.CYN}${(peakWattsToday / 1000).toFixed(3)} kW${C.RST}`,
        `Load: ${getAsciiBar(acWatts, RATED_AC_WATTS)}`
      ];
      
      const elecR = [
        `DC Array:        ${C.CYN}${(dcWatts / 1000).toFixed(3)} kW${C.RST}`,
        `Efficiency:      ${efficiencyPct}%`,
        ``,
        `AC Voltage:      ${gridVolts} V`,
        `Grid Frequency:  ${gridFreq} Hz`
      ];
      console.log(buildDualPanel(`${C.BLD}GENERATION${C.RST}`, genL, `${C.BLD}ELECTRICAL${C.RST}`, elecR));

      // Panel 2: Accumulation & Vitals
      const accL = [
        `Today's Yield:   ${C.GRN}${todayKwh} kWh${C.RST}`,
        `Est. Earnings:   ${C.YEL}$${(todayKwh * RATE_KWH).toFixed(2)}${C.RST}`,
        ``,
        `Lifetime Total:  ${lifetimeKwh.toLocaleString()} kWh`
      ];
      
      const vitalsR = [
        `Heat Sink Temp:  ${heatSinkC}°C (${heatSinkF}°F)`,
        `Clipping Active: ${isClipping ? C.RED + "YES" + C.RST : C.GRN + "No" + C.RST}`,
        ``,
        `Fault State:     ${parseEventBits(eventMask)}`,
        `DC Bus:          ${dcVolts} V (${dcBusStatus})`
      ];
      console.log(buildDualPanel(`${C.BLD}ACCUMULATION${C.RST}`, accL, `${C.BLD}VITALS & HEALTH${C.RST}`, vitalsR));

      // Footer
      const footerText = `[ Modbus TCP: ${INVERTER_IP}:${PORT} | Refresh: ${POLL_INTERVAL / 1000}s | Ctrl+C to Exit ]`;
      const fPad = Math.max(0, 83 - footerText.length) / 2;
      console.log(C.DIM + " ".repeat(Math.floor(fPad)) + footerText + C.RST + "\n");

    } catch (err) {
      try { client.close(); } catch {}
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      console.log(`\n[${new Date().toLocaleTimeString()}] Communication dropped. Retrying...`);
    }
  }, POLL_INTERVAL);
}

// Clean exit hook: close socket, restore cursor, clear screen
process.on("SIGINT", () => {
  process.stdout.write('\x1B[?25h'); // Restore terminal cursor
  console.clear();
  console.log("Closing TCP Socket and exiting. Goodbye!");
  try { client.close(); } catch {}
  process.exit();
});

startDashboard();