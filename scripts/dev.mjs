import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

const localPython = process.platform === "win32"
  ? resolve("runtime/.venv/Scripts/python.exe")
  : resolve("runtime/.venv/bin/python");
const python = process.env.PYTHON ?? (existsSync(localPython) ? localPython : process.platform === "win32" ? "python" : "python3");
const browserApiPort = process.env.TRIBE_BROWSER_API_PORT;
const browserApiToken = browserApiPort ? await readOneLine(process.stdin) : "";
delete process.env.TRIBE_BROWSER_API_TOKEN;
delete process.env.TRIBE_BROWSER_API_PORT;
// Keep repository commands on the same Node runtime that launched the app.
// A stale system `node` earlier in PATH can reject modern flags (for example
// `node --test`) even while Vite itself works through process.execPath.
const runtimePath = [dirname(process.execPath), process.env.PATH]
  .filter(Boolean)
  .join(delimiter);
const children = [
  spawn(python, ["-m", "tribe_runtime.server"], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: runtimePath,
      ...(browserApiPort ? { TRIBE_BROWSER_API_PORT: browserApiPort } : {}),
      PYTHONPATH: `runtime${process.platform === "win32" ? ";" : ":"}${process.env.PYTHONPATH ?? ""}` },
    stdio: browserApiPort ? ["pipe", "inherit", "inherit"] : "inherit",
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
  }),
];
if (browserApiPort && browserApiToken) children[0].stdin.end(`${browserApiToken}\n`);

for (const child of children) {
  child.on("error", (error) => {
    console.error("Unable to start local runtime:", error.message);
    shutdown(1);
  });
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown(code);
  });
}

function shutdown(code = 0) {
  for (const child of children) if (!child.killed) child.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

async function readOneLine(stream) {
  let input = "";
  for await (const chunk of stream) {
    input += chunk.toString("utf8");
    const newline = input.indexOf("\n");
    if (newline >= 0) return input.slice(0, newline).trim();
  }
  return input.trim();
}
