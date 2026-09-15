import { constants } from "node:fs";
import { access, statfs } from "node:fs/promises";
import type { DiskPort, DiskStatus, Settings } from "./models";
export const GiB = 1024 ** 3;
export function spaceLevel(
  freeBytes: number,
  settings: Settings,
): DiskStatus["level"] {
  return freeBytes < settings.stopGiB * GiB
    ? "stop"
    : freeBytes < settings.warningGiB * GiB
      ? "warning"
      : "ok";
}
export class FileSystemDisk implements DiskPort {
  async probe(directory: string, settings: Settings): Promise<DiskStatus> {
    try {
      await access(directory, constants.W_OK);
      const data = await statfs(directory, { bigint: true });
      const freeBytes = Number(data.bavail * data.bsize);
      return {
        directory,
        freeBytes,
        totalBytes: Number(data.blocks * data.bsize),
        level: spaceLevel(freeBytes, settings),
        message: null,
      };
    } catch {
      return {
        directory,
        freeBytes: 0,
        totalBytes: 0,
        level: "unavailable",
        message: "磁盘不存在、不可写或无法读取容量",
      };
    }
  }
}
