import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require("electron"),
  [fileURLToPath(new URL("./desktop-smoke.cjs", import.meta.url))],
  {
    env,
    windowsHide: true,
    stdio: "inherit",
    shell: false,
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
