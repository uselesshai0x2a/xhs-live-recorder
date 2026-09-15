import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const desktop = path.join(project, "apps", "desktop");
const require = createRequire(path.join(desktop, "package.json"));
const electronViteCli = path.join(
  path.dirname(require.resolve("electron-vite/package.json")),
  "bin",
  "electron-vite.js",
);
const environment = { ...process.env };
// Codex and other Electron hosts may export this; the validation needs a real GUI.
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [electronViteCli, "dev"], {
  cwd: desktop,
  env: environment,
  shell: false,
  windowsHide: true,
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error("Unable to open browser validation:", error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
