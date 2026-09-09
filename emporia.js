require("./env");
const { EmporiaVue, Scale } = require('emporia-vue-lib');

const vue = new EmporiaVue();
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 1000;

async function pollOnce(deviceGids, devices) {
  try {
    // Query 1-second instant data from the Emporia cloud
    const usageDict = await vue.getDeviceListUsage(deviceGids, new Date(), Scale.SECOND);
    const timestamp = new Date().toLocaleTimeString();

    console.clear();
    console.log(`==================================================`);
    console.log(`      EMPORIA LIVE TELEMETRY (${timestamp}) `);
    console.log(`==================================================`);

    for (const [gid, deviceUsage] of Object.entries(usageDict)) {
      const device = devices.find(d => d.deviceGid == gid);

      // Main net power ('1,2,3' is the 200A main sensor channel, or 'TotalUsage')
      const mainChannel = deviceUsage.channelUsages['1,2,3'] || deviceUsage.channelUsages['TotalUsage'];
      // 1S scale returns kWh consumed in that 1 second. Watts = kWh * 3600 * 1000
      const mainNetWatts = mainChannel ? mainChannel.usage * 3600 * 1000 : 0;

      console.log(`[+] Monitor: ${device?.deviceName || 'Vue Monitor'}`);
      console.log(`    Net Power (Mains):   ${Math.round(mainNetWatts)} W`);

      // 50A branch circuits
      if (deviceUsage.channelUsages && Object.keys(deviceUsage.channelUsages).length > 0) {
        console.log(`    --- Individual Circuits ---`);
        for (const [channelNum, channel] of Object.entries(deviceUsage.channelUsages)) {
          if (['1,2,3', 'TotalUsage', 'Balance'].includes(channelNum)) continue;
          const circuitWatts = channel.usage * 3600 * 1000;
          const label = channel.name || `Circuit ${channelNum}`;
          console.log(`    ${label.padEnd(25)}: ${Math.round(circuitWatts)} W`);
        }
      }
    }
    console.log(`==================================================`);
    console.log(`[Live stream (${POLL_INTERVAL / 1000}s) | Ctrl+C to Stop]`);

  } catch (err) {
    console.log(`\n[!] Error fetching usage: ${err.message}`);
  }
}

async function startMonitor() {
  try {
    // 1. Authenticate using environment credentials
    const username = process.env.EMPORIA_USER;
    const password = process.env.EMPORIA_PASS;
    if (!username || !password) {
      throw new Error("Missing EMPORIA_USER or EMPORIA_PASS in environment or .env file");
    }
    await vue.login({ username, password });

    // 2. Discover all Vue devices linked to your account
    const devices = await vue.getDevices();
    if (devices.length === 0) {
      console.log("No devices found on this Emporia account.");
      return;
    }
    const deviceGids = devices.map(d => d.deviceGid);

    // 3. Start Sequential Polling Loop
    while (true) {
      await pollOnce(deviceGids, devices);
      await new Promise(res => setTimeout(res, POLL_INTERVAL));
    }

  } catch (err) {
    console.error("Initialization failed:", err.message);
  }
}

startMonitor();