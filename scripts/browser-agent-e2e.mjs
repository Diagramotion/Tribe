import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";

const root = process.cwd();
const packagedAppPath = process.env.TRIBE_BROWSER_E2E_PACKAGED_APP || "";
const automaticUpload = !packagedAppPath && process.env.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tribe-browser-agent-e2e-"));
const uploadFixturePath = path.join(temporaryRoot, "fixture-upload.txt");
const uploadFixtureContent = "Tribe browser upload fixture\n";
await fs.writeFile(uploadFixturePath, uploadFixtureContent, { mode: 0o600 });
if (process.env.TRIBE_BROWSER_E2E_INTERACTIVE === "1") console.log(`Disposable upload fixture: ${uploadFixturePath}`);
const browserApiToken = crypto.randomBytes(32).toString("hex");
const browserApiPort = await reserveLocalPort();
const runtimePort = await reserveLocalPort();
const devPort = await reserveLocalPort();
let blockedHostRequests = 0;
let slowRequests = 0;
let receivedPostProbe = false;
let receivedMultipartProbe = false;
let receivedUpload = Buffer.alloc(0);
let receivedUploadCount = 0;
const blockedServer = http.createServer((_request, response) => {
  blockedHostRequests += 1;
  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("This destination should remain unreachable.");
});
await new Promise((resolveListen, reject) => {
  blockedServer.once("error", reject);
  blockedServer.listen(0, "127.0.0.1", resolveListen);
});
const blockedUrl = `http://localhost:${blockedServer.address().port}/blocked`;
const embeddedServer = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html><head><title>Embedded storage fixture</title></head><body><p>Embedded storage fixture</p>
    <script>localStorage.setItem('tribe-embedded-fixture', 'present'); const request = indexedDB.open('tribe-embedded-fixture', 1); request.onupgradeneeded = () => request.result.createObjectStore('records'); request.onsuccess = () => request.result.transaction('records', 'readwrite').objectStore('records').put('x'.repeat(16000), 'payload');</script>
    </body></html>`);
});
await new Promise((resolveListen, reject) => {
  embeddedServer.once("error", reject);
  embeddedServer.listen(0, "127.0.0.1", resolveListen);
});
const embeddedUrl = `http://127.0.0.1:${embeddedServer.address().port}/embedded`;
const fixtureFavicon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/post-probe") {
    console.log(`Browser E2E POST probe reached the fixture server: ${JSON.stringify({ contentType: request.headers["content-type"] || "", contentLength: request.headers["content-length"] || "", transferEncoding: request.headers["transfer-encoding"] || "" })}`);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedPostProbe = Buffer.concat(chunks).toString("utf8") === "Browser POST probe";
      console.log(`Browser E2E POST probe body completed: ${JSON.stringify({ bytes: Buffer.concat(chunks).length, matches: receivedPostProbe })}`);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Browser POST probe received");
    });
    return;
  }
  if (request.method === "POST" && request.url === "/upload") {
    console.log(`Browser E2E fixture upload headers: ${JSON.stringify({ contentType: request.headers["content-type"] || "", contentLength: request.headers["content-length"] || "", transferEncoding: request.headers["transfer-encoding"] || "" })}`);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedUpload = Buffer.concat(chunks);
      receivedUploadCount += 1;
      console.log(`Browser E2E fixture upload received ${receivedUpload.length} bytes.`);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Fixture upload received");
    });
    return;
  }
  if (request.method === "POST" && request.url === "/multipart-probe") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const contentType = request.headers["content-type"] || "";
      const body = Buffer.concat(chunks).toString("utf8");
      receivedMultipartProbe = contentType.startsWith("multipart/form-data; boundary=") && body.includes("Browser multipart probe");
      console.log(`Browser E2E multipart probe received ${Buffer.byteLength(body)} bytes; boundary present: ${contentType.startsWith("multipart/form-data; boundary=")}; payload matches: ${receivedMultipartProbe}.`);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(receivedMultipartProbe ? "Browser multipart probe received" : "Browser multipart probe invalid");
    });
    return;
  }
  if (request.url === "/favicon.ico") {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": fixtureFavicon.length });
    response.end(fixtureFavicon);
    return;
  }
  if (request.url === "/download") {
    const download = Buffer.from("Tribe managed browser download fixture\n");
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="tribe-browser-e2e.txt"',
      "Content-Length": download.length,
    });
    response.end(download);
    return;
  }
  if (request.url === "/not-found") {
    response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Not found");
    return;
  }
  if (request.url === "/slow") {
    slowRequests += 1;
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end(Buffer.alloc(20_000, 97));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/favicon.ico"><title>Browser Bridge Fixture</title></head>
    <body><main><h1>Shared visible tab</h1><p id="count">Count: 0</p>
    <iframe title="Embedded storage fixture" src="${embeddedUrl}"></iframe>
    <button id="increment" type="button" onclick="document.querySelector('#count').textContent = 'Count: ' + (Number(document.querySelector('#count').textContent.replace('Count: ', '')) + 1)">Increment counter</button>
    <label>Plan period<select id="plan-period"><option value="" disabled selected>Choose a plan</option><option value="monthly">Monthly plan</option><option value="annual">Annual plan</option></select></label><p id="plan-result">Plan: not selected</p>
    <label>Features<select id="features" multiple><option value="analytics">Advanced analytics</option><option value="support">Priority support</option><option value="backups">Daily backups</option></select></label><p id="features-result">Features: none</p>
    <button id="client-route" type="button" onclick="history.pushState({}, '', '/client-route'); document.querySelector('#route-result').textContent = 'Route: ' + location.pathname">Navigate client route</button><p id="route-result">Route: /</p>
    <p id="fixture-record">Fixture record exists</p><button id="delete-fixture" type="button" onclick="document.querySelector('#fixture-record')?.remove()">Delete fixture record</button><a href="/download">Download test file</a>
    <label>Choose test file<input id="fixture-upload" type="file"></label><p id="upload-result">Fixture upload not started</p><p id="post-probe-result">Browser POST probe pending</p><p id="multipart-probe-result">Browser multipart probe pending</p>
    <button id="network-check" type="button" onclick="measureNetwork()">Measure network</button><p id="network-result">Network check not run</p><p id="motion-result"></p>
    <a href="${blockedUrl}">Open disallowed host</a></main>
    <script>console.error('fixture console diagnostic'); document.querySelector('#plan-period').addEventListener('change', event => document.querySelector('#plan-result').textContent = 'Plan: ' + event.target.value); document.querySelector('#features').addEventListener('change', event => document.querySelector('#features-result').textContent = 'Features: ' + [...event.target.selectedOptions].map(option => option.value).sort().join(', ')); const storageRequest = indexedDB.open('tribe-browser-fixture', 1); storageRequest.onupgradeneeded = () => storageRequest.result.createObjectStore('records'); storageRequest.onsuccess = () => storageRequest.result.transaction('records', 'readwrite').objectStore('records').put('x'.repeat(256000), 'payload'); const motionPreference = matchMedia('(prefers-reduced-motion: reduce)'); const updateMotion = () => document.querySelector('#motion-result').textContent = 'Motion: ' + (motionPreference.matches ? 'reduce' : 'no-preference'); motionPreference.addEventListener('change', updateMotion); updateMotion(); setTimeout(() => fetch('/post-probe', { method: 'POST', body: 'Browser POST probe', signal: AbortSignal.timeout(5000) }).then(response => response.text()).then(text => document.querySelector('#post-probe-result').textContent = text).catch(error => document.querySelector('#post-probe-result').textContent = 'Browser POST probe failed: ' + String(error?.message || error)), 500); document.querySelector('#fixture-upload').addEventListener('change', async (event) => { const file = event.target.files?.[0]; const result = document.querySelector('#upload-result'); result.textContent = 'Fixture upload started: ' + (file ? file.name + ' (' + file.size + ' bytes)' : 'no file selected'); if (!file) return; try { const text = await file.text(); result.textContent += ' · File readable: ' + text.length + ' characters'; const data = new FormData(); data.append('file', file); const response = await fetch('/upload', { method: 'POST', body: data, signal: AbortSignal.timeout(15000) }); result.textContent = await response.text(); } catch (error) { result.textContent += ' · Fixture upload failed: ' + String(error?.message || error); } }); async function measureNetwork() { const started = performance.now(); await fetch('/slow', { cache: 'no-store' }); document.querySelector('#network-result').textContent = 'Network check: ' + Math.round(performance.now() - started) + ' ms'; }</script>
    <script>setTimeout(() => { const data = new FormData(); data.append('field', 'Browser multipart probe'); fetch('/multipart-probe', { method: 'POST', body: data, signal: AbortSignal.timeout(5000) }).then(response => response.text()).then(text => document.querySelector('#multipart-probe-result').textContent = text).catch(error => document.querySelector('#multipart-probe-result').textContent = 'Browser multipart probe failed: ' + String(error?.message || error)); }, 750);</script>
    </body></html>`);
});
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

const safeEnv = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: process.env.HOME || os.homedir(),
  TMPDIR: process.env.TMPDIR || os.tmpdir(),
  LANG: process.env.LANG || "en_AU.UTF-8",
  USER: process.env.USER || "",
  TRIBE_DATA_DIR: path.join(temporaryRoot, "tribe-data"),
  TRIBE_ELECTRON_DATA_DIR: path.join(temporaryRoot, "electron-data"),
  TRIBE_PORT: String(runtimePort),
  TRIBE_DEV_URL: `http://127.0.0.1:${devPort}`,
  TRIBE_DEV_ORIGIN: `http://127.0.0.1:${devPort}`,
  TRIBE_ELECTRON_VITE_PORT: String(devPort),
  TRIBE_BROWSER_API_PORT: String(browserApiPort),
  TRIBE_BROWSER_E2E: "1",
  TRIBE_BROWSER_E2E_WINDOW_WIDTH: String(Math.max(800, Math.min(2400, Number(process.env.TRIBE_BROWSER_E2E_WINDOW_WIDTH) || 800))),
  TRIBE_BROWSER_E2E_SPLIT: process.env.TRIBE_BROWSER_E2E_SPLIT === "1" ? "1" : "0",
  TRIBE_BROWSER_E2E_INTERACTIVE: process.env.TRIBE_BROWSER_E2E_INTERACTIVE === "1" ? "1" : "0",
  TRIBE_BROWSER_E2E_AUTO_UPLOAD: automaticUpload ? "1" : "0",
  TRIBE_BROWSER_E2E_UPLOAD_FILE: uploadFixturePath,
  TRIBE_BROWSER_E2E_SKIP_APPROVAL: process.env.TRIBE_BROWSER_E2E_SKIP_APPROVAL === "1" ? "1" : "0",
  TRIBE_BROWSER_E2E: "1",
};
let vite;
let desktop;
let runtime;
let desktopLaunch;
let stderr = "";
let stdout = "";

function startProcess(command, args, env = safeEnv) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-1_000_000);
    if (process.env.TRIBE_BROWSER_E2E_STREAM_LOGS === "1") process.stdout.write(chunk);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-1_000_000);
    if (process.env.TRIBE_BROWSER_E2E_STREAM_LOGS === "1") process.stderr.write(chunk);
  });
  return child;
}

function launchDesktop() {
  desktop = startProcess(desktopLaunch.command, desktopLaunch.args, desktopLaunch.env);
  desktop.stdin.end(`${browserApiToken}\n`);
  return desktop;
}

async function stopDesktop() {
  if (!desktop || desktop.exitCode !== null) return;
  const child = desktop;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(15_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(2_000)]);
  }
  assert.notEqual(child.exitCode, null, "the disposable desktop app must exit before its restart");
}

function runProcess(command, args, { cwd, env, input = "", timeoutMs = 300_000 }) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProcess(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolveProcess(stdout);
      else rejectProcess(new Error(`${command} exited with ${signal || `code ${code}`}.\n${stderr || stdout}`));
    });
    child.stdin.end(input);
  });
}

async function reserveLocalPort() {
  const socket = net.createServer();
  await new Promise((resolveListen, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolveListen);
  });
  const port = socket.address().port;
  await new Promise((resolveClose, reject) => socket.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitFor(predicate, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (desktop?.exitCode !== null && desktop?.exitCode !== undefined) throw new Error(`Electron exited before ${description} (code ${desktop.exitCode}).`);
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` ${lastError.message}` : ""}`);
}

async function request(action, payload = {}, { token = browserApiToken, origin } = {}) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${browserApiPort}/v1/browser/browser-e2e/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`The browser service request at 127.0.0.1:${browserApiPort} did not complete (${error.cause?.code || error.message}).`);
  }
  const body = await response.json();
  return { status: response.status, body };
}

async function call(action, payload = {}) {
  const response = await request(action, payload);
  assert.equal(response.status, 200, `${action} failed: ${response.body.error || response.status}`);
  return response.body.result;
}

try {
  if (safeEnv.TRIBE_BROWSER_E2E_SPLIT === "1" && !packagedAppPath) {
    const repository = path.join(temporaryRoot, "split-layout-repository");
    await fs.mkdir(repository, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository], { cwd: root, env: safeEnv });
    const python = process.platform === "win32"
      ? resolve(root, "runtime/.venv/Scripts/python.exe")
      : resolve(root, "runtime/.venv/bin/python");
    const seedSource = [
      "import os",
      "from pathlib import Path",
      "from tribe_runtime.store import MissionStore",
      "store = MissionStore(Path(os.environ['TRIBE_DATA_DIR']) / 'tribe.sqlite3')",
      `project, mission = store.create_project(${JSON.stringify(repository)}, 'Browser Split Layout', 'Browser workspace layout', 'Keep the disposable browser layout fixture idle.')`,
      "store.pause_mission(mission['id'])",
    ].join("\n");
    await runProcess(python, ["-c", seedSource], {
      cwd: root,
      env: { ...safeEnv, PYTHONPATH: resolve(root, "runtime") },
      timeoutMs: 30_000,
    });
    runtime = startProcess(python, ["-m", "tribe_runtime.server"], {
      ...safeEnv,
      PYTHONPATH: resolve(root, "runtime"),
    });
    runtime.stdin.end(`${browserApiToken}\n`);
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${runtimePort}/api/health`)).ok; }
      catch { return false; }
    }, "the isolated runtime to load the split-workspace fixture");
  }
  if (packagedAppPath) {
    const packagedEnv = { ...safeEnv };
    delete packagedEnv.TRIBE_DEV_URL;
    delete packagedEnv.TRIBE_DEV_ORIGIN;
    delete packagedEnv.TRIBE_ELECTRON_VITE_PORT;
    desktopLaunch = { command: path.resolve(root, packagedAppPath), args: [], env: packagedEnv };
  } else {
    const viteCli = resolve(root, "node_modules/vite/bin/vite.js");
    const electronExecutable = resolve(root, "node_modules/electron/dist", process.platform === "win32"
      ? "electron.exe"
      : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron");
    vite = startProcess(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", String(devPort), "--strictPort"]);
    await waitFor(async () => {
      try { return (await fetch(safeEnv.TRIBE_DEV_URL)).ok; } catch { return false; }
    }, "Vite to become ready");
    desktopLaunch = { command: electronExecutable, args: ["."], env: safeEnv };
  }
  launchDesktop();

  const initial = await waitFor(async () => {
    const response = await request("state");
    return response.status === 200 && response.body.result?.activeTabId ? response.body.result : false;
  }, "the Browser workspace to expose its visible tab");
  const tabId = initial.activeTabId;
  assert.equal(initial.tabs.length, 1,
    `a fresh Browser workspace must start with exactly one page tab; received ${JSON.stringify(initial.tabs.map(({ id, active, url }) => ({ id, active, url })))}`);
  const compactLayout = await waitFor(async () => {
    const layout = await call("layout-state");
    return layout.browserToolbarClientWidth > 0 ? layout : false;
  }, "the Browser toolbar to render at the compact desktop width");
  const expectedWindowWidth = Number(safeEnv.TRIBE_BROWSER_E2E_WINDOW_WIDTH);
  assert.equal(compactLayout.windowWidth, expectedWindowWidth, "the desktop shell must honour its requested E2E width");
  assert.equal(compactLayout.innerWidth, expectedWindowWidth, "the renderer must receive the full E2E window width");
  assert.equal(compactLayout.titlebarHeight, 58, "the titlebar must retain its fixed single-row height at compact width");
  assert.equal(compactLayout.rootScrollWidth, compactLayout.rootClientWidth,
    "the compact desktop shell must not introduce horizontal overflow");
  assert.ok(compactLayout.browserToolbarScrollWidth <= compactLayout.browserToolbarClientWidth,
    "the Browser navigation row must fit the compact workspace pane");
  assert.equal(compactLayout.browserHostVisible, false,
    "an empty new tab must not show a white native Chromium surface over Tribe's styled start page");
  assert.equal(compactLayout.browserEmptyStateVisible, true,
    "the empty browser tab must expose Tribe's readable start-page content");
  if (safeEnv.TRIBE_BROWSER_E2E_SPLIT === "1") {
    console.log(`Browser E2E split layout: ${JSON.stringify(compactLayout)}`);
    assert.equal(compactLayout.splitWorkspace, true,
      "the Browser tab must remain open beside the seeded chat");
    assert.equal(compactLayout.splitTitlebar, true,
      "the split workspace must place chat controls and view tabs in the titlebar");
    assert.equal(compactLayout.splitTitlebarAligned, true,
      "chat controls and workspace view tabs must be vertically centred on the same titlebar row");
    assert.equal(compactLayout.splitTitlebarOverflow, false,
      "the split titlebar must adapt its controls without horizontal overflow");
    if (expectedWindowWidth > 1040) {
      assert.ok(compactLayout.chatPaneWidth >= 360,
        "desktop split view must preserve at least 360 pixels for chat");
      assert.ok(compactLayout.workspacePaneWidth <= compactLayout.rootClientWidth * 0.6 + 1,
        "the Browser pane must stay within sixty per cent of the desktop workspace");
      assert.equal(compactLayout.splitPaneLayout, "grid",
        "the desktop layout must keep chat and Browser side by side");
    } else if (expectedWindowWidth <= 840) {
      assert.equal(compactLayout.splitPaneLayout, "block",
        "the narrow-window layout must use the Browser overlay while retaining its chat tab");
      assert.equal(compactLayout.chatPaneWidth, 0,
        "the chat must stay hidden only while the narrow Browser overlay is open");
    }
  }

  assert.equal((await request("state", {}, { token: "wrong-token" })).status, 401, "the loopback bridge must reject invalid tokens");
  assert.equal((await request("state", {}, { origin: safeEnv.TRIBE_DEV_ORIGIN })).status, 405, "renderer-origin requests must be rejected");
  const heldAgentRequest = request("hold", { durationMs: 250 });
  await delay(30);
  assert.equal((await call("state")).agentControlActive, true, "the Browser status must report an active agent request");
  const pausedControl = await call("agent-control", { paused: true });
  assert.equal(pausedControl.agentControlPaused, true, "the user stop control must pause the shared browser agent session");
  assert.equal(pausedControl.agentControlActive, true, "the active state must remain visible until the in-flight request settles");
  assert.equal((await heldAgentRequest).status, 423, "stopping control must invalidate an in-flight agent request");
  assert.equal((await request("state")).status, 423, "paused browser control must block agent inspection and input");
  await call("agent-control", { paused: false });
  assert.equal((await call("state")).activeTabId, tabId, "resuming browser control must preserve the user's visible tab");

  const navigated = await call("navigate", { tabId, url: fixtureUrl, allowedDomains: ["127.0.0.1"] });
  assert.equal(navigated.activeTabId, tabId, "navigation must use the selected tab");
  assert.equal(navigated.url, fixtureUrl, "the visible browser state must report the navigated URL");
  const livePageLayout = await waitFor(async () => {
    const layout = await call("layout-state");
    return layout.browserHostVisible && !layout.browserEmptyStateVisible ? layout : false;
  }, "the real Chromium page to replace the styled empty-tab surface");
  assert.equal(livePageLayout.browserHostVisible, true,
    "a navigated page must show the same native Chromium surface used for user and agent control");
  if (process.platform === "darwin") {
    const nativeMenu = await call("menu-state");
    assert.equal(nativeMenu.active, true, "the native browser commands must activate with the Browser pane");
    const menuItems = new Map(nativeMenu.items.map((item) => [item.id, item]));
    assert.equal(menuItems.size, 12, "macOS must expose the browser's commands in its application menu");
    for (const id of ["tribe-browser-new-tab", "tribe-browser-close-tab", "tribe-browser-focus-address", "tribe-browser-reload", "tribe-browser-show-downloads"]) {
      assert.equal(menuItems.get(id)?.enabled, true, `${id} must be enabled while the Browser pane is active`);
      assert.ok(menuItems.get(id)?.accelerator || id === "tribe-browser-show-downloads",
        `${id} must show a keyboard equivalent when one is defined`);
    }
    await call("menu-command", { id: "tribe-browser-focus-address" });
    await waitFor(async () => (await call("layout-state")).browserAddressFocused,
      "the native Focus Address Bar command to focus Tribe's address field");
    await call("menu-command", { id: "tribe-browser-new-tab" });
    const menuCreatedTab = await waitFor(async () => {
      const state = await call("state");
      return state.tabs.length === 2 ? state : false;
    }, "the native New Browser Tab command to create a page tab");
    assert.notEqual(menuCreatedTab.activeTabId, tabId,
      "the native New Browser Tab command must activate the newly created page");
    await call("menu-command", { id: "tribe-browser-close-tab" });
    const menuClosedTab = await waitFor(async () => {
      const state = await call("state");
      return state.tabs.length === 1 ? state : false;
    }, "the native Close Browser Tab command to close the selected page");
    assert.equal(menuClosedTab.activeTabId, tabId,
      "closing the page from the native menu must restore the previous visible page");
  }
  await waitFor(() => receivedPostProbe, "a same-origin POST from the visible browser page", 7_000);
  await waitFor(() => receivedMultipartProbe, "a same-origin multipart POST from the visible browser page", 7_000);
  if (safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE === "1" || safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1") {
    const python = process.platform === "win32"
      ? resolve(root, "runtime/.venv/Scripts/python.exe")
      : resolve(root, "runtime/.venv/bin/python");
    const uploadOutput = await runProcess(python, [resolve(root, "scripts/browser-agent-e2e-upload.py")], {
      cwd: root,
      input: `${browserApiToken}\n`,
      timeoutMs: 360_000,
      env: {
        PATH: safeEnv.PATH,
        HOME: safeEnv.HOME,
        TMPDIR: safeEnv.TMPDIR,
        LANG: safeEnv.LANG,
        TRIBE_BROWSER_API_PORT: String(browserApiPort),
        TRIBE_BROWSER_FIXTURE_HOST: "127.0.0.1",
        TRIBE_BROWSER_E2E_INTERACTIVE: safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE,
        TRIBE_BROWSER_E2E_AUTO_UPLOAD: safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD,
        TRIBE_BROWSER_E2E_UPLOAD_FILE: uploadFixturePath,
        PYTHONPATH: resolve(root, "runtime"),
      },
    });
    const uploadReport = JSON.parse(uploadOutput);
    assert.equal(uploadReport.uploadTransferVerified, true,
      "the production agent browser_upload tool must transfer the selected fixture before emulation");
    await waitFor(() => receivedUploadCount >= 1, "the agent-selected fixture upload to reach the local server", 10_000);
    assert.ok(receivedUpload.includes(Buffer.from('filename="fixture-upload.txt"')));
    assert.ok(receivedUpload.includes(Buffer.from(uploadFixtureContent)));
    safeEnv.TRIBE_BROWSER_E2E_UPLOAD_PRECHECK_VERIFIED = "1";
    console.log("Browser E2E production agent browser_upload reached the local fixture before device/network emulation.");
  }
  if (safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1" && safeEnv.TRIBE_BROWSER_E2E_UPLOAD_PRECHECK_VERIFIED !== "1") {
    const initialUploadSnapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
    const initialUploadInput = initialUploadSnapshot.elements.find((element) => element.name === "Choose test file" && element.type === "file");
    assert.ok(initialUploadInput?.ref, "the initial page must expose a current file-input reference");
    const initialUpload = await call("upload", { tabId, ref: initialUploadInput.ref, allowedDomains: ["127.0.0.1"] });
    assert.equal(initialUpload.filesSelected, true, "the isolated fixture file must be selected in the visible Chromium page");
    await waitFor(() => receivedUploadCount >= 1, "the un-emulated page's multipart file upload to reach the local fixture", 10_000);
    assert.ok(receivedUpload.includes(Buffer.from('filename="fixture-upload.txt"')));
    assert.ok(receivedUpload.includes(Buffer.from(uploadFixtureContent)));
    console.log("Browser E2E pre-emulation file upload reached the local fixture with the exact disposable file bytes.");
  }
  const faviconTab = await waitFor(async () => {
    const browserState = await call("state");
    const tab = browserState.tabs?.find((item) => item.id === tabId);
    return tab?.favicon?.startsWith("data:image/png;base64,") ? tab : false;
  }, "the current page favicon in its browser tab");
  assert.ok(faviconTab.favicon.length < 2000, "the favicon should be bounded before it enters app UI state");
  const successfulPageDiagnostic = await waitFor(async () => {
    const diagnostics = await call("diagnostics", { tabId, allowedDomains: ["127.0.0.1"] });
    return diagnostics.page?.find((item) => item.event === "loaded" && item.httpStatusCode === 200) || false;
  }, "the page navigation status diagnostic");
  assert.equal(successfulPageDiagnostic.url, fixtureUrl);
  const consoleDiagnostic = await waitFor(async () => {
    const diagnostics = await call("diagnostics", { tabId, allowedDomains: ["127.0.0.1"] });
    return diagnostics.console?.find((item) => item.message.includes("fixture console diagnostic")) || false;
  }, "the page console diagnostic");
  assert.equal(consoleDiagnostic.level, "error");
  const notFoundUrl = new URL("/not-found", fixtureUrl).toString();
  await call("navigate", { tabId, url: notFoundUrl, allowedDomains: ["127.0.0.1"] });
  const notFoundDiagnostic = await waitFor(async () => {
    const diagnostics = await call("diagnostics", { tabId, allowedDomains: ["127.0.0.1"] });
    return diagnostics.page?.find((item) => item.url === notFoundUrl && item.httpStatusCode === 404) || false;
  }, "the HTTP error page diagnostic");
  assert.equal(notFoundDiagnostic.event, "loaded");
  await call("navigate", { tabId, url: fixtureUrl, allowedDomains: ["127.0.0.1"] });
  const siteStorage = await waitFor(async () => {
    const result = await call("storage", { tabId, allowedDomains: ["127.0.0.1"] });
    return result.breakdown?.some((item) => item.type === "indexeddb" && item.bytes > 0) ? result : false;
  }, "the visible site's IndexedDB usage");
  assert.equal(siteStorage.origin, new URL(fixtureUrl).origin);
  assert.ok(siteStorage.bytes > 0, `the native browser should report a non-zero site usage total (${JSON.stringify(siteStorage)})`);
  const embeddedStorage = await waitFor(async () => {
    const inventory = await call("site-inventory", { tabId, allowedDomains: ["127.0.0.1"] });
    return inventory.find((site) => site.origin === new URL(embeddedUrl).origin
      && site.breakdown?.some((item) => item.type === "indexeddb" && item.bytes > 0)) || false;
  }, "the embedded origin's IndexedDB usage in the profile inventory");
  assert.equal(embeddedStorage.origin, new URL(embeddedUrl).origin);
  const afterEmbeddedClear = await call("clear-site-data", {
    tabId, origin: embeddedStorage.origin, allowedDomains: ["127.0.0.1"],
  });
  assert.equal(afterEmbeddedClear.some((site) => site.origin === embeddedStorage.origin), false,
    "clearing an embedded origin must remove it from the visible profile inventory");
  assert.ok(afterEmbeddedClear.find((site) => site.origin === siteStorage.origin)?.bytes > 0,
    "clearing an embedded origin must preserve another site's data");

  const blocked = await request("navigate", { tabId, url: "https://example.com/", allowedDomains: ["127.0.0.1"] });
  assert.equal(blocked.status, 403, "navigation outside the project's allowed hosts must be blocked before network access");

  const beforeIncrement = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
  const incrementButton = beforeIncrement.elements.find((element) => element.name === "Increment counter");
  assert.ok(incrementButton?.ref, "the current page snapshot must expose the counter button");
  await call("click", { tabId, ref: incrementButton.ref, allowedDomains: ["127.0.0.1"] });
  if (process.env.TRIBE_BROWSER_E2E_POINTER_SCREENSHOT) {
    const pointerFrame = await call("screenshot", { tabId, allowedDomains: ["127.0.0.1"] });
    await fs.writeFile(process.env.TRIBE_BROWSER_E2E_POINTER_SCREENSHOT, Buffer.from(pointerFrame.image, "base64"));
  }
  const afterIncrement = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
  assert.match(afterIncrement.text, /Count: 1/);

  const focusAddressShortcut = await call("shortcut", {
    tabId, shortcut: "focus-address", allowedDomains: ["127.0.0.1"],
  });
  assert.equal(focusAddressShortcut.shortcutHandled, true,
    "the embedded Chromium input event must route the platform address-bar shortcut");
  assert.equal(focusAddressShortcut.focusedElement, "Browser address",
    "the platform address-bar shortcut must focus Tribe's visible address field");
  const shortcutNewTab = await call("shortcut", {
    tabId, shortcut: "new-tab", allowedDomains: ["127.0.0.1"],
  });
  assert.equal(shortcutNewTab.shortcutHandled, true,
    "the embedded Chromium input event must route the platform new-tab shortcut");
  const shortcutTabId = shortcutNewTab.state.activeTabId;
  assert.ok(shortcutTabId && shortcutTabId !== tabId,
    "the platform new-tab shortcut must create and select a distinct browser page");
  await call("navigate", { tabId: shortcutTabId, url: embeddedUrl, allowedDomains: ["127.0.0.1"] });
  const shortcutCloseTab = await call("shortcut", {
    tabId: shortcutTabId, shortcut: "close-tab", allowedDomains: ["127.0.0.1"],
  });
  assert.equal(shortcutCloseTab.shortcutHandled, true,
    "the embedded Chromium input event must route the platform close-tab shortcut");
  assert.equal(shortcutCloseTab.state.tabs.some((tab) => tab.id === shortcutTabId), false,
    "the platform close-tab shortcut must close the selected browser page");
  assert.equal(shortcutCloseTab.state.activeTabId, tabId,
    `closing the selected page by shortcut must restore the previously active page; expected ${tabId}, received ${shortcutCloseTab.state.activeTabId} among ${JSON.stringify(shortcutCloseTab.state.tabs.map((tab) => ({ id: tab.id, active: tab.active, url: tab.url })))}`);

  const secondTabState = await call("new-tab");
  const secondTabId = secondTabState.activeTabId;
  assert.ok(secondTabId && secondTabId !== tabId, "a new browser tab must receive an independent visible tab identity");
  assert.equal(secondTabState.tabs.length, 2, "the workspace must retain both browser tabs");
  assert.equal(secondTabState.tabs.find((item) => item.id === secondTabId)?.active, true);
  await call("navigate", { tabId: secondTabId, url: embeddedUrl, allowedDomains: ["127.0.0.1"] });
  const secondTabMobile = await call("viewport", { tabId: secondTabId, viewport: "iphone-15", allowedDomains: ["127.0.0.1"] });
  assert.equal(secondTabMobile.url, embeddedUrl);
  assert.equal(secondTabMobile.viewport, "iphone-15");

  const firstTabRestored = await call("select-tab", { tabId });
  assert.equal(firstTabRestored.activeTabId, tabId, "selecting the first tab must restore its own page context");
  assert.equal(firstTabRestored.url, fixtureUrl);
  assert.equal(firstTabRestored.viewport, "responsive", "viewport settings must stay with their browser tab");
  const firstTabSnapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
  assert.match(firstTabSnapshot.text, /Count: 1/, `the first tab's page state must survive switching away and back; page was: ${firstTabSnapshot.text}`);

  const secondTabRestored = await call("select-tab", { tabId: secondTabId });
  assert.equal(secondTabRestored.url, embeddedUrl, "the selected URL must follow the second browser tab");
  assert.equal(secondTabRestored.viewport, "iphone-15", "the second tab must retain its own emulated viewport");
  const afterClose = await call("close-tab", { tabId: secondTabId });
  assert.equal(afterClose.closed, true);

  const sessionTab = await call("new-tab");
  const sessionTabId = sessionTab.activeTabId;
  await call("navigate", { tabId: sessionTabId, url: embeddedUrl, allowedDomains: ["127.0.0.1"] });
  const sessionTabViewport = await call("viewport", {
    tabId: sessionTabId, viewport: "pixel-7", locale: "en-AU", network: "4g", reducedMotion: "reduce", allowedDomains: ["127.0.0.1"],
  });
  assert.equal(sessionTabViewport.viewport, "pixel-7");
  await call("select-tab", { tabId });

  const crashRequested = await call("crash", { tabId, allowedDomains: ["127.0.0.1"] });
  assert.equal(crashRequested.requested, true, "the isolated E2E harness must be able to trigger a renderer crash");
  const crashedPage = await waitFor(async () => {
    const state = await call("state", { tabId });
    return state.pageStopped ? state : false;
  }, "the browser's recoverable renderer-stopped state");
  assert.equal(crashedPage.pageStopped, true);
  await call("reload", { tabId, allowedDomains: ["127.0.0.1"] });
  const recoveredPage = await waitFor(async () => {
    const snapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
    return /Count: 0/.test(snapshot.text) ? snapshot : false;
  }, "the page after explicit renderer recovery");
  assert.match(recoveredPage.text, /Count: 0/);
  assert.equal((await call("state", { tabId })).pageStopped, false);
  assert.equal(afterClose.activeTabId, tabId, "closing the selected tab must restore another open tab");
  assert.equal(afterClose.tabs.length, 1);

  const baselineMotion = afterIncrement.text.match(/Motion: (reduce|no-preference)/)?.[1];
  assert.ok(baselineMotion, "the page must expose its system reduced-motion preference");

  const postTabLifecycleSnapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
  const downloadLink = postTabLifecycleSnapshot.elements.find((element) => element.name === "Download test file");
  assert.ok(downloadLink?.ref, "the fixture download link must be available to browser automation");
  await call("click", { tabId, ref: downloadLink.ref, allowedDomains: ["127.0.0.1"] });
  const completedDownload = await waitFor(async () => {
    const current = await call("state", { tabId });
    return current.downloads?.find((item) => item.filename === "tribe-browser-e2e.txt" && item.state === "completed") || false;
  }, "the managed browser download to complete");
  assert.ok(completedDownload.totalBytes > 0 && completedDownload.receivedBytes === completedDownload.totalBytes,
    "the completed download must report its full byte count");
  const managedDownloadPath = path.join(safeEnv.TRIBE_ELECTRON_DATA_DIR, "browser-downloads", completedDownload.filename);
  assert.equal(await fs.readFile(managedDownloadPath, "utf8"), "Tribe managed browser download fixture\n",
    "the completed file must be stored in Tribe's managed download directory");

  const blockedLinkSnapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
  const blockedLink = blockedLinkSnapshot.elements.find((element) => element.name === "Open disallowed host");
  assert.ok(blockedLink?.ref, "the disallowed link must be exposed in the current page snapshot");
  await call("click", { tabId, ref: blockedLink.ref, allowedDomains: ["127.0.0.1"] });
  await delay(250);
  const afterBlockedNavigation = await call("state", { tabId });
  assert.equal(afterBlockedNavigation.url, fixtureUrl, "the disallowed link must not leave the allowed visible page");
  assert.equal(blockedHostRequests, 0, "the denied host must receive no request");
  const afterBlockedOrigin = await call("site-inventory", { tabId, allowedDomains: ["127.0.0.1"] });
  assert.equal(afterBlockedOrigin.some((site) => site.origin === new URL(blockedUrl).origin), false,
    "a denied destination must not enter the user's browser data inventory");

  const screenshot = await call("screenshot", { tabId, allowedDomains: ["127.0.0.1"] });
  assert.equal(screenshot.mimeType, "image/jpeg");
  assert.ok(Buffer.from(screenshot.image, "base64").length > 1_000, "the visible tab must yield a real Chromium screenshot");
  assert.ok(screenshot.viewport.width > 0 && screenshot.viewport.height > 0);

  const baseline = await waitFor(async () => {
    const current = await call("state", { tabId });
    return current.viewportSize?.userAgent ? current : false;
  }, "the browser's baseline identity metrics");
  const iphone = await call("viewport", { tabId, viewport: "iphone-15", allowedDomains: ["127.0.0.1"] });
  assert.equal(iphone.viewportSize.width, 393);
  assert.equal(iphone.viewportSize.height, 852);
  assert.equal(iphone.viewportSize.maxTouchPoints, 5);
  assert.equal(iphone.viewportSize.touch, true);
  assert.equal(iphone.viewportSize.coarsePointer, true);
  assert.match(iphone.viewportSize.userAgent, /iPhone/);
  assert.equal(iphone.viewportSize.platform, "iPhone");

  const pixel = await call("viewport", {
    tabId, viewport: "pixel-7", locale: "en-AU", network: "slow-3g", reducedMotion: "reduce", allowedDomains: ["127.0.0.1"],
  });
  assert.equal(pixel.viewport, "pixel-7");
  assert.equal(pixel.viewportSize.width, 412);
  assert.equal(pixel.viewportSize.height, 915);
  assert.match(pixel.viewportSize.userAgent, /Android 14; Pixel 7/);
  assert.equal(pixel.viewportSize.userAgentData.platform, "Android");
  assert.equal(pixel.viewportSize.userAgentData.highEntropy.model, "Pixel 7");
  assert.equal(pixel.locale, "en-AU");
  assert.equal(pixel.network, "slow-3g");
  assert.equal(pixel.reducedMotion, "reduce");
  await call("reload", { tabId, allowedDomains: ["127.0.0.1"] });
  const reloadedPixel = await waitFor(async () => {
    const current = await call("state", { tabId });
    return current.viewportSize?.language === "en-AU" ? current : false;
  }, "the page to reload with its emulated locale");
  assert.equal(reloadedPixel.viewportSize.userAgentData.highEntropy.model, "Pixel 7");
  const responsive = await call("viewport", { tabId, viewport: "responsive", allowedDomains: ["127.0.0.1"] });
  assert.equal(responsive.viewport, "responsive");
  assert.ok(responsive.viewportSize.width > 412);
  assert.ok(responsive.viewportSize.height > 600);
  assert.equal(responsive.viewportSize.maxTouchPoints, baseline.viewportSize.maxTouchPoints);
  assert.equal(responsive.viewportSize.touch, false);
  const reducedMotionSnapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
  assert.match(reducedMotionSnapshot.text, /Motion: reduce/);

  const networkSnapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
  const networkButton = networkSnapshot.elements.find((element) => element.name === "Measure network");
  assert.ok(networkButton?.ref, "the network probe must be available through the visible page");
  await call("click", { tabId, ref: networkButton.ref, allowedDomains: ["127.0.0.1"] });
  let latestNetworkSnapshot = "";
  let networkElapsedMs;
  try {
    networkElapsedMs = await waitFor(async () => {
      const current = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
      latestNetworkSnapshot = current.text;
      return Number(current.text.match(/Network check: (\d+) ms/)?.[1]) || false;
    }, "the throttled network response", 15_000);
  } catch (error) {
    throw new Error(`${error.message} Fixture requests: ${slowRequests}. Latest page: ${latestNetworkSnapshot}`);
  }
  assert.ok(networkElapsedMs >= 400, `slow 3G should delay a 20 KB response (observed ${networkElapsedMs} ms)`);

  const restored = await call("viewport", {
    tabId, viewport: "responsive", locale: "", network: "unthrottled", reducedMotion: "system", allowedDomains: ["127.0.0.1"],
  });
  assert.equal(restored.activeTabId, tabId);
  assert.equal(restored.viewport, "responsive");
  assert.equal(restored.viewportSize.touch, false);
  assert.equal(restored.viewportSize.coarsePointer, false);
  assert.equal(restored.viewportSize.userAgent, baseline.viewportSize.userAgent);
  assert.equal(restored.viewportSize.platform, baseline.viewportSize.platform);
  assert.equal(restored.viewportSize.language, baseline.viewportSize.language);
  assert.equal(restored.locale, "");
  assert.equal(restored.network, "unthrottled");
  assert.equal(restored.reducedMotion, "system");

  if (safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1") {
    const postEmulationSnapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
    const postEmulationInput = postEmulationSnapshot.elements.find((element) => element.name === "Choose test file" && element.type === "file");
    assert.ok(postEmulationInput?.ref, "the reloaded page must expose a current file-input reference after emulation");
    const postEmulationSelection = await call("upload", { tabId, ref: postEmulationInput.ref, allowedDomains: ["127.0.0.1"] });
    assert.equal(postEmulationSelection.filesSelected, true, "the fixture file must remain selectable after emulation");
    await waitFor(() => receivedUploadCount >= 2, "the post-emulation file upload to reach the local fixture", 10_000);
    assert.ok(receivedUpload.includes(Buffer.from('filename="fixture-upload.txt"')));
    assert.ok(receivedUpload.includes(Buffer.from(uploadFixtureContent)));
    safeEnv.TRIBE_BROWSER_E2E_UPLOAD_PRECHECK_VERIFIED = "1";
    console.log("Browser E2E post-emulation file upload reached the local fixture with the exact disposable file bytes.");
  }

  const python = process.platform === "win32"
    ? resolve(root, "runtime/.venv/Scripts/python.exe")
    : resolve(root, "runtime/.venv/bin/python");
  const networkDiagnostics = await call("diagnostics", { tabId, allowedDomains: ["127.0.0.1"] });
  const slowRequest = networkDiagnostics.network?.find((item) => item.url?.endsWith("/slow") && item.status === 200);
  assert.ok(slowRequest?.durationMs >= 400, "network diagnostics should expose the completed, throttled response and duration");
  const runtimeReport = JSON.parse(execFileSync(python, [resolve(root, "scripts/browser-agent-e2e-runtime.py")], {
    cwd: root,
    encoding: "utf8",
    input: `${browserApiToken}\n`,
    timeout: safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE === "1" || safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1" ? 360_000 : 180_000,
    env: {
      PATH: safeEnv.PATH,
      HOME: safeEnv.HOME,
      TMPDIR: safeEnv.TMPDIR,
      LANG: safeEnv.LANG,
      TRIBE_BROWSER_API_PORT: String(browserApiPort),
      TRIBE_BROWSER_FIXTURE_URL: fixtureUrl,
      TRIBE_BROWSER_E2E_INTERACTIVE: safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE,
      TRIBE_BROWSER_E2E_AUTO_UPLOAD: safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD,
      TRIBE_BROWSER_E2E_UPLOAD_PRECHECK_VERIFIED: safeEnv.TRIBE_BROWSER_E2E_UPLOAD_PRECHECK_VERIFIED || "0",
      TRIBE_BROWSER_E2E_SKIP_APPROVAL: safeEnv.TRIBE_BROWSER_E2E_SKIP_APPROVAL,
      TRIBE_BROWSER_E2E_UPLOAD_FILE: safeEnv.TRIBE_BROWSER_E2E_UPLOAD_FILE,
      PYTHONPATH: resolve(root, "runtime"),
    },
  }));
  assert.equal(runtimeReport.activeTabId, tabId, "the Python agent wrapper must use the selected visible tab");
  assert.equal(runtimeReport.url, fixtureUrl);
  assert.equal(runtimeReport.countUpdated, true, "the Python runtime tool wrapper must mutate the same visible page");
  assert.equal(runtimeReport.storageOrigin, new URL(fixtureUrl).origin);
  assert.equal(runtimeReport.storageCategory, "indexeddb");
  assert.ok(runtimeReport.storageBytes > 0, "the project-scoped runtime wrapper must expose category byte counts");
  assert.equal(runtimeReport.structuredBrowserTool, "browser_click");
  assert.equal(runtimeReport.countAfterStructuredAgentClick, true,
    "the production Pydantic AI agent and granted browser tool must mutate the same visible Chromium page");
  assert.equal(runtimeReport.liveApprovalAndCancellation,
    safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE === "1" && safeEnv.TRIBE_BROWSER_E2E_SKIP_APPROVAL !== "1",
    "the optional live run must complete both native approval and cancellation actions");
  assert.equal(runtimeReport.liveUploadConfirmation, safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE === "1",
    "the optional live run must verify upload cancellation and explicit approval");
  assert.equal(runtimeReport.uploadTransferVerified,
    safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1" || (safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE === "1" && receivedUpload.length > 0),
    "automatic upload coverage must send the selected disposable file to the fixture endpoint");
  const clientRouteSnapshot = await call("snapshot", { tabId, allowedDomains: ["127.0.0.1"] });
  const clientRouteButton = clientRouteSnapshot.elements.find((element) => element.name === "Navigate client route");
  assert.ok(clientRouteButton?.ref, "the fixture must expose a client-side route control");
  await call("click", { tabId, ref: clientRouteButton.ref, allowedDomains: ["127.0.0.1"] });
  const clientRouteUrl = new URL("/client-route", fixtureUrl).toString();
  const clientRouteState = await waitFor(async () => {
    const current = await call("state", { tabId });
    return current.url === clientRouteUrl ? current : false;
  }, "the browser URL to follow a same-page client-side route");
  const routeDiagnostics = await call("diagnostics", { tabId, allowedDomains: ["127.0.0.1"] });
  assert.ok(routeDiagnostics.page.some((item) => item.event === "route-changed" && item.url === clientRouteUrl),
    "client-side route changes must be reflected in page diagnostics");
  assert.equal(clientRouteState.activeTabId, tabId);
  if (safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1") {
    assert.ok(receivedUploadCount >= 2, "the structured agent upload and post-emulation browser control must transfer the disposable file");
    console.log("Browser E2E agent upload and post-emulation browser transfer reached the local fixture with the exact disposable file bytes.");
  }
  if (safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE === "1" || safeEnv.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1") {
    assert.ok(receivedUpload.includes(Buffer.from('filename="fixture-upload.txt"')),
      "the selected file must reach only the local disposable fixture after approval");
    assert.ok(receivedUpload.includes(Buffer.from(uploadFixtureContent)),
      "the local fixture must receive the exact disposable upload bytes");
  }
  const beforeRestart = await call("state");
  const restoredTabExpectations = beforeRestart.tabs.map(({ url, viewport, reducedMotion }) => ({ url, viewport, reducedMotion }));
  const activeTabIndex = beforeRestart.tabs.findIndex((tab) => tab.active);
  const savedSession = JSON.parse(await fs.readFile(path.join(safeEnv.TRIBE_ELECTRON_DATA_DIR, "browser-sessions.json"), "utf8"));
  assert.equal(savedSession.sessions.workspace.tabs.length, restoredTabExpectations.length,
    "the Browser session file must contain each open tab before restart");
  const browserWorkspaceOpens = stdout.match(/Browser E2E workspace opened\./g)?.length || 0;
  await stopDesktop();
  launchDesktop();
  await waitFor(() => (stdout.match(/Browser E2E workspace opened\./g)?.length || 0) > browserWorkspaceOpens,
    "the restarted desktop to open the Browser workspace", 20_000);
  let latestRestartState;
  let restoredSession;
  try {
    restoredSession = await waitFor(async () => {
      const response = await request("state");
      const state = response.body?.result;
      latestRestartState = state ? { activeTabId: state.activeTabId, tabs: state.tabs?.map(({ url, viewport, reducedMotion, active }) => ({ url, viewport, reducedMotion, active })) } : null;
      if (response.status !== 200 || !state?.activeTabId || state.tabs?.length !== restoredTabExpectations.length) return false;
      const actual = state.tabs.map(({ url, viewport, reducedMotion }) => ({ url, viewport, reducedMotion }));
      return JSON.stringify(actual) === JSON.stringify(restoredTabExpectations) ? state : false;
    }, "open tabs and their viewport settings to return after a desktop restart", 20_000);
  } catch (error) {
    throw new Error(`${error.message} Last browser state: ${JSON.stringify(latestRestartState)}. Saved session: ${JSON.stringify(savedSession.sessions.workspace)}.`);
  }
  assert.equal(restoredSession.tabs.findIndex((tab) => tab.active), activeTabIndex);
  const restoredEmulatedTab = restoredSession.tabs.find((tab) => !tab.active);
  const restoredEmulation = await call("select-tab", { tabId: restoredEmulatedTab.id });
  assert.equal(restoredEmulation.viewport, "pixel-7");
  assert.equal(restoredEmulation.locale, "en-AU");
  assert.equal(restoredEmulation.network, "4g");
  assert.equal(restoredEmulation.reducedMotion, "reduce");
  await call("select-tab", { tabId: restoredSession.activeTabId });
  console.log("Browser E2E restored both open pages and their independent viewports after restarting the desktop app.");
  const tabsToClose = (await call("state")).tabs;
  for (const tab of tabsToClose) {
    const closed = await call("close-tab", { tabId: tab.id });
    assert.equal(closed.closed, true, "closing a browser tab must remove it from the shared session");
  }
  const emptySession = await call("state");
  assert.equal(emptySession.tabs.length, 0, "closing the final browser tab must leave the session empty");
  const reopenedSession = await call("new-tab");
  assert.equal(reopenedSession.tabs.length, 1, "the new-tab action must create a browser page on demand");
  assert.equal(reopenedSession.tabs[0].url, "", "a new browser page must start blank");
  console.log("Browser E2E closed every page tab, then created a fresh blank page with the explicit new-tab action.");
  const interactiveCoverage = safeEnv.TRIBE_BROWSER_E2E_INTERACTIVE === "1"
    ? ", live native approval/cancellation and confirmed local upload"
    : "";
  console.log(`Browser agent end-to-end passed: shared visible tab, native keyboard address/tab shortcuts, multi-tab navigation and per-tab viewport/page state, desktop restart restoration, renderer crash and reload recovery, managed downloads, guarded navigation, direct and structured Pydantic AI browser calls, click/snapshot/screenshot, single- and multi-select option discovery and selection, page/console/network diagnostics, top-level and embedded per-site IndexedDB inventory and isolated clearing, iPhone and Pixel device identity, locale and reduced-motion reset, real slow-3G throttling (${networkElapsedMs} ms)${interactiveCoverage}.`);
} catch (error) {
  const uploadLogs = stdout.split(/\r?\n/).filter((line) => /browser e2e.*upload|fixture upload received|upload body handles/i.test(line)).join("\n");
  console.error(`${error.stack || error}\nUpload diagnostics:\n${uploadLogs || "No upload-specific main-process logs were captured."}\nDesktop output:\n${stdout.split(/\r?\n/).slice(-80).join("\n")}\n${stderr}`);
  process.exitCode = 1;
} finally {
  for (const child of [desktop, vite, runtime]) {
    if (!child || child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolveClose) => child.once("exit", resolveClose)), delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  server.closeAllConnections?.();
  embeddedServer.closeAllConnections?.();
  blockedServer.closeAllConnections?.();
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  await new Promise((resolveClose) => embeddedServer.close(() => resolveClose()));
  await new Promise((resolveClose) => blockedServer.close(() => resolveClose()));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
