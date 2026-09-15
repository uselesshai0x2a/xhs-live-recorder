import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const child = spawn(
  require("electron"),
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.native.config.ts",
  ],
  {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
