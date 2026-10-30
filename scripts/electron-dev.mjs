import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const port = Number(process.env.TRIBE_ELECTRON_VITE_PORT || 5176);
const devUrl = `http://127.0.0.1:${port}`;
const dataDir = process.env.TRIBE_ELECTRON_DATA_DIR || "/tmp/tribe-browser-system-data";
const runtimePort = await reserveLocalPort();
const browserApiPort = await reserveLocalPort();
const browserApiToken = crypto.randomBytes(32).toString("hex");
const env = {
  ...process.env,
  TRIBE_DATA_DIR: dataDir,
  TRIBE_ELECTRON_DATA_DIR: join(dataDir, "electron-user-data"),
  TRIBE_PORT: String(runtimePort),
  TRIBE_DEV_URL: devUrl,
  TRIBE_DEV_ORIGIN: devUrl,
};
delete env.TRIBE_BROWSER_API_TOKEN;
delete env.TRIBE_BROWSER_API_PORT;
env.TRIBE_BROWSER_API_PORT = String(browserApiPort);

const dev = spawn(process.execPath, ["scripts/dev.mjs", "--port", String(port), "--strictPort"], {
  cwd: process.cwd(), env, stdio: ["pipe", "inherit", "inherit"],
});
dev.stdin.end(`${browserApiToken}\n`);
let desktop;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (desktop && !desktop.killed) desktop.kill();
  if (!dev.killed) dev.kill();
  process.exit(code);
}

dev.on("error", (error) => {
  console.error(`Tribe development services could not start: ${error.message}`);
  stop(1);
});
dev.on("exit", (code) => {
  if (!stopping) stop(code || 0);
});
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !stopping) {
  try {
    const response = await fetch(devUrl);
    if (response.ok) break;
  } catch { /* Vite is still starting. */ }
  await delay(250);
}

if (stopping) process.exit(1);
if (Date.now() >= deadline) {
  console.error("Tribe's local preview did not start in time.");
  stop(1);
}

const electronCli = resolve("node_modules/electron/cli.js");
desktop = spawn(process.execPath, [electronCli, "."], { cwd: process.cwd(), env, stdio: ["pipe", "inherit", "inherit"] });
desktop.stdin.end(`${browserApiToken}\n`);
desktop.on("error", (error) => {
  console.error(`Tribe desktop could not start: ${error.message}`);
  stop(1);
});
desktop.on("exit", (code) => stop(code || 0));

async function reserveLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port: assignedPort } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return assignedPort;
}
