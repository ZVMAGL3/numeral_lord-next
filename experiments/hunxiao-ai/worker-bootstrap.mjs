import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const requireServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { tsImport } = await import(pathToFileURL(requireServer.resolve("tsx/esm/api")).href);
await tsImport("./worker.ts", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("./tsconfig.json", import.meta.url))
});
