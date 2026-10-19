// autostart.js: install or remove the macOS LaunchAgent so the app starts
// at login and restarts if it crashes.
//
// launchd realities this handles: launchd does not read your shell profile
// and its PATH is nearly empty, so the plist must contain the ABSOLUTE path
// to node (we write process.execPath, the node that ran this script).
//
// Usage: npm run install-autostart / npm run uninstall-autostart

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const LABEL = "com.internshiphunt.tracker";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const appDir = __dirname;
const logsDir = path.join(appDir, "logs");

function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function install() {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const nodePath = process.execPath; // absolute path to this exact node binary
  const serverPath = path.join(appDir, "server.js");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(serverPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(appDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logsDir, "internshiphunt.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logsDir, "internshiphunt-error.log"))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  // Reload cleanly if a previous version was loaded.
  try { execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" }); } catch { /* not loaded; fine */ }
  execFileSync("launchctl", ["load", plistPath]);
  console.log(`Autostart installed: ${plistPath}`);
  console.log("The app now starts at login and restarts itself if it crashes.");
  console.log(`Logs: ${logsDir}`);
}

function uninstall() {
  try { execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" }); } catch { /* not loaded; fine */ }
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    console.log(`Autostart removed: ${plistPath}`);
  } else {
    console.log("Autostart was not installed; nothing to remove.");
  }
}

const cmd = process.argv[2];
if (cmd === "install") install();
else if (cmd === "uninstall") uninstall();
else {
  console.error("Usage: node autostart.js install|uninstall");
  process.exit(1);
}
