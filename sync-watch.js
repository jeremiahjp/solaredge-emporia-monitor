// ============================================================================
//  Real-Time Auto-Sync to Home Assistant Add-on
//  Watches the local add-on directory and automatically pushes any saved file
//  directly to the Home Assistant Samba share
// ============================================================================
require("./env");
const fs = require("fs");
const path = require("path");

const SOURCE_DIR = path.join(__dirname, "ha-addon", "solar_energy_monitor");
const TARGET_DIR = process.env.HA_SAMBA_PATH || "\\\\homeassistant.local\\addons\\ha-addon\\solar_energy_monitor";

console.log("==================================================");
console.log("  🚀 Home Assistant Add-on Live Sync Watcher");
console.log(`  Source: ${SOURCE_DIR}`);
console.log(`  Target: ${TARGET_DIR}`);
console.log("==================================================");

let debounceTimers = new Map();

function copyFile(filename) {
  const src = path.join(SOURCE_DIR, filename);
  const dest = path.join(TARGET_DIR, filename);

  try {
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dest);
      const time = new Date().toLocaleTimeString();
      console.log(`[${time}] ⚡ Pushed ${filename} -> Home Assistant!`);
    }
  } catch (err) {
    console.warn(`[Sync Error] Failed to push ${filename}:`, err.message);
  }
}

// Initial full sync on start
try {
  const files = fs.readdirSync(SOURCE_DIR);
  for (const f of files) {
    copyFile(f);
  }
  console.log("✅ Initial sync complete. Watching for changes... (Press Ctrl+C to stop)\n");
} catch (err) {
  console.error("Failed initial sync:", err.message);
}

// Watch directory for changes
fs.watch(SOURCE_DIR, (eventType, filename) => {
  if (!filename) return;

  // Debounce rapid editor write events (e.g. VS Code / Antigravity temp writes)
  if (debounceTimers.has(filename)) {
    clearTimeout(debounceTimers.get(filename));
  }

  debounceTimers.set(
    filename,
    setTimeout(() => {
      copyFile(filename);
      debounceTimers.delete(filename);
    }, 200)
  );
});
