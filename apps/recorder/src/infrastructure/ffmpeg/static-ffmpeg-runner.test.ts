import { describe, expect, it } from "vitest";
import { StaticFfmpegBinaryProvider } from "./static-ffmpeg-runner";

describe("StaticFfmpegBinaryProvider", () => {
  it("does not fall back to a system executable", () => {
    expect(() => new StaticFfmpegBinaryProvider(null).getPath()).toThrow(
      "Project-owned FFmpeg binary is unavailable",
    );
  });

  it("resolves the executable installed in the project", () => {
    expect(new StaticFfmpegBinaryProvider().getPath()).toMatch(
      /ffmpeg(?:\.exe)?$/,
    );
  });
});
