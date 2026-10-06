import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const requireServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const cli = requireServer.resolve("tsx/cli");
const args = process.argv.slice(2);
const config = fileURLToPath(new URL("./tsconfig.json", import.meta.url));
const targetArgs = args[0] === "--test"
  ? ["--test", ...readdirSync(here).filter((name) => name.endsWith(".test.ts")).map((name) => here + name)]
  : [fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args];
const child = spawn(process.execPath, [cli, "--tsconfig", config, ...targetArgs], {
  stdio: "inherit",
  env: { ...process.env, TSX_TSCONFIG_PATH: config }
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
