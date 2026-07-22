import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("package:win currently supports only Windows x64");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "..");
const applicationDirectory = path.join(repositoryDirectory, "apps", "recorder");
const releaseDirectory = path.join(
  repositoryDirectory,
  "release",
  "windows-x64",
);
const expectedReleaseParent = path.join(repositoryDirectory, "release");
if (path.dirname(releaseDirectory) !== expectedReleaseParent) {
  throw new Error(
    `Refusing to clean unexpected release path: ${releaseDirectory}`,
  );
}

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(path.join(releaseDirectory, "config"), { recursive: true });

const executablePath = path.join(releaseDirectory, "xhs-live-recorder.exe");
const seaConfigPath = path.join(
  applicationDirectory,
  "dist",
  "sea-config.json",
);
await writeFile(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: path.join(applicationDirectory, "dist", "index.js"),
      mainFormat: "module",
      output: executablePath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const seaBuild = spawnSync(process.execPath, ["--build-sea", seaConfigPath], {
  cwd: repositoryDirectory,
  encoding: "utf8",
  stdio: "inherit",
  windowsHide: true,
});
await rm(seaConfigPath, { force: true });
if (seaBuild.status !== 0) {
  throw new Error(
    `Node SEA build failed with exit code ${seaBuild.status ?? "unknown"}`,
  );
}

const applicationRequire = createRequire(
  path.join(applicationDirectory, "package.json"),
);
const ffmpegEntry = applicationRequire.resolve("ffmpeg-static");
await Promise.all([
  copyFile(
    path.join(path.dirname(ffmpegEntry), "ffmpeg.exe"),
    path.join(releaseDirectory, "ffmpeg.exe"),
  ),
  copyFile(
    path.join(applicationDirectory, "src", "config", "target.json"),
    path.join(releaseDirectory, "config", "target.json"),
  ),
  copyFile(
    path.join(applicationDirectory, "src", "config", "recording.json"),
    path.join(releaseDirectory, "config", "recording.json"),
  ),
  copyFile(
    path.join(applicationDirectory, "src", "config", "auth.example.json"),
    path.join(releaseDirectory, "config", "auth.json"),
  ),
  copyFile(
    path.join(applicationDirectory, "package", "README.txt"),
    path.join(releaseDirectory, "README.txt"),
  ),
  copyFile(
    path.join(applicationDirectory, "package", "start.cmd"),
    path.join(releaseDirectory, "start.cmd"),
  ),
]);

console.log(`Windows package created: ${releaseDirectory}`);
