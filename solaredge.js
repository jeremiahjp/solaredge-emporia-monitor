require("./env");
const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

const INVERTER_IP = process.env.INVERTER_IP || "127.0.0.1";
const PORT = Number(process.env.MODBUS_PORT) || 502;
const UNIT_ID = 1;

function toSigned16(value) {
  return value > 32767 ? value - 65536 : value;
}

function decodeString(registers) {
  const buf = Buffer.alloc(registers.length * 2);
  registers.forEach((reg, i) => buf.writeUInt16BE(reg, i * 2));
  return buf.toString("ascii").replace(/\0/g, "").trim();
}

async function readSolar() {
  try {
    // 1. Connect over TCP
    await client.connectTCP(INVERTER_IP, { port: PORT });
    client.setID(UNIT_ID);
    client.setTimeout(5000);
    console.log(`Connected to SolarEdge inverter at ${INVERTER_IP}:${PORT}`);

    // 2. Read SunSpec Common Model (registers 40000 to 40068)
    // Note: modbus-serial uses 0-based register offsets, so 40000 is address 40000
    const header = await client.readHoldingRegisters(40000, 68);
    const cId = decodeString(header.data.slice(0, 2));
    const manufacturer = decodeString(header.data.slice(4, 20));
    const model = decodeString(header.data.slice(20, 36));
    const serial = decodeString(header.data.slice(44, 60));
    console.log(`Device: ${manufacturer} ${model} (Serial: ${serial}) [ID: ${cId}]`);

    // 3. Read AC Power & Scale Factor (40083 = Power, 40084 = Scale Factor)
    let acData;
    try {
      acData = await client.readHoldingRegisters(40083, 2);
    } catch {
      // Fallback for firmware offsets
      acData = await client.readHoldingRegisters(40082, 2);
    }

    const rawWatts = toSigned16(acData.data[0]);
    const sf = toSigned16(acData.data[1]);
    const actualWatts = rawWatts * Math.pow(10, sf);
    console.log(`Current AC Power Output: ${actualWatts.toFixed(1)} W`);

    // 4. Read Lifetime Energy (40093 = Energy WH, 40095 = Scale Factor)
    const energyData = await client.readHoldingRegisters(40093, 3);
    const rawWh = (energyData.data[0] << 16) | energyData.data[1];
    const energySf = toSigned16(energyData.data[2]);
    const lifetimeKwh = (rawWh * Math.pow(10, energySf)) / 1000.0;
    console.log(`Lifetime Production: ${lifetimeKwh.toFixed(2)} kWh`);

  } catch (err) {
    console.error("Modbus read error:", err.message);
  } finally {
    // Always close the socket so the inverter's single connection slot is freed
    client.close();
  }
}

readSolar();