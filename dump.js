require("./env");
const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

const INVERTER_IP = process.env.INVERTER_IP || "127.0.0.1";
const PORT = Number(process.env.MODBUS_PORT) || 502;
const UNIT_ID = 1;
const RATED_AC_WATTS = Number(process.env.RATED_AC_WATTS) || 7600; // Inverter rated limit

function toSigned16(val) {
  return val > 32767 ? val - 65536 : val;
}

function scale(val, sf) {
  if (val === 0x8000 || val === 0x7fff || val === undefined) return null;
  return Number((val * Math.pow(10, sf)).toFixed(2));
}

function getFormattedDateInfo() {
  const now = new Date();

  // Day of the year calculation
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const diff = now - startOfYear;
  const oneDay = 1000 * 60 * 60 * 24;
  const dayOfYear = Math.floor(diff / oneDay);

  return {
    fullDate: now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    localTime: now.toLocaleTimeString("en-US", {
      hour12: true,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    isoUTC: now.toISOString(),
    epochSeconds: Math.floor(now.getTime() / 1000),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayOfYear: dayOfYear,
  };
}

async function getSolarDashboard() {
  try {
    await client.connectTCP(INVERTER_IP, { port: PORT });
    client.setID(UNIT_ID);
    client.setTimeout(5000);

    const res = await client.readHoldingRegisters(40069, 40);
    const d = res.data;
    const r = (addr) => d[addr - 40069];

    // Timestamp at the exact moment registers were fetched
    const dateInfo = getFormattedDateInfo();

    // Scale factors
    const pf_sf = toSigned16(r(40084)); // AC Power SF
    const dc_w_sf = toSigned16(r(40101)); // DC Power SF
    const energy_sf = toSigned16(r(40095)); // Lifetime Energy SF
    const temp_sf = toSigned16(r(40106)); // Heat Sink Temp SF
    const pf_ratio_sf = toSigned16(r(40092)); // Power Factor SF

    // Read values
    const acWatts = scale(toSigned16(r(40083)), pf_sf) || 0;
    const dcWatts = scale(toSigned16(r(40100)), dc_w_sf) || 0;
    const rawWh = ((r(40093) << 16) | r(40094)) >>> 0;
    const lifetimeKwh = Number(((rawWh * Math.pow(10, energy_sf)) / 1000).toFixed(2));
    const heatSinkC = scale(toSigned16(r(40103)), temp_sf);
    const heatSinkF = heatSinkC ? ((heatSinkC * 9) / 5 + 32).toFixed(1) : null;
    const rawPf = toSigned16(r(40091));
    const powerFactor = rawPf !== 0x7fff ? scale(rawPf, pf_ratio_sf) : 1.0;

    // Derived values
    const kw = (acWatts / 1000).toFixed(3);
    const kwhPerHourPace = kw;
    const kwhPerMinPace = (acWatts / 1000 / 60).toFixed(4);
    const utilizationPct = ((acWatts / RATED_AC_WATTS) * 100).toFixed(1);
    const efficiencyPct = dcWatts > 0 ? ((acWatts / dcWatts) * 100).toFixed(2) : "0.00";

    console.clear();
    console.log(`======================================================`);
    console.log(`            SOLAREDGE LIVE ANALYTICS                  `);
    console.log(`======================================================`);
    console.log(`--- [QUERY TIMESTAMP] ---`);
    console.log(`Date:                    ${dateInfo.fullDate}`);
    console.log(`Time:                    ${dateInfo.localTime} (${dateInfo.timezone})`);
    console.log(`UTC (ISO 8601):          ${dateInfo.isoUTC}`);
    console.log(`Unix Epoch:              ${dateInfo.epochSeconds}`);
    console.log(`Day of Year:             Day ${dateInfo.dayOfYear} of 365`);
    console.log(`------------------------------------------------------`);
    console.log(`--- [LIVE PRODUCTION & PACING] ---`);
    console.log(`Instantaneous Power:     ${kw} kW  (${acWatts} W)`);
    console.log(`Current Pace / Hour:     ${kwhPerHourPace} kWh / hr`);
    console.log(`Current Pace / Minute:   ${kwhPerMinPace} kWh / min`);
    console.log(`Inverter Utilization:    ${utilizationPct}% of 7.6 kW limit`);
    console.log(`Conversion Efficiency:   ${efficiencyPct}%`);
    console.log(`Power Factor:            ${powerFactor}`);
    console.log(`------------------------------------------------------`);
    console.log(`--- [SYSTEM TOTALS & HEALTH] ---`);
    console.log(`Operating Temp:          ${heatSinkC} °C (${heatSinkF} °F)`);
    console.log(`Lifetime Cumulative:     ${lifetimeKwh.toLocaleString()} kWh`);
    console.log(`======================================================\n`);

  } catch (err) {
    console.error("Read error:", err.message);
  } finally {
    client.close();
  }
}

getSolarDashboard();