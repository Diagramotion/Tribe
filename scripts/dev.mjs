import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

const localPython = process.platform === "win32"
  ? resolve("runtime/.venv/Scripts/python.exe")
  : resolve("runtime/.venv/bin/python");
const python = process.env.PYTHON ?? (existsSync(localPython) ? localPython : process.platform === "win32" ? "python" : "python3");
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
      PYTHONPATH: `runtime${process.platform === "win32" ? ";" : ":"}${process.env.PYTHONPATH ?? ""}` },
    stdio: "inherit",
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
  }),
];

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
