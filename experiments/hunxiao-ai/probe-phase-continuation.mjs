import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const tsx = requireServer.resolve("tsx/cli");
const config = fileURLToPath(new URL("./tsconfig.json", import.meta.url));
const entry = fileURLToPath(new URL("./phase-continuation-probe.ts", import.meta.url));
const child = spawn(process.execPath, [tsx, "--tsconfig", config, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, TSX_TSCONFIG_PATH: config }
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
