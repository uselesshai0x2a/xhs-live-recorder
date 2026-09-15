import { createHash } from "node:crypto";
export function taskId(keyword: string, roomId: string): string {
  return createHash("sha256")
    .update(`xhs\0${keyword}\0${roomId}`)
    .digest("hex")
    .slice(0, 24);
}
export function safeName(value: string): string {
  const safe = [...value.normalize("NFKC")]
    .map((character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return !safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)
    ? `recording_${safe}`
    : safe;
}
export function streamUrl(roomId: string): string {
  return `https://live-source-play-hw.xhscdn.com/live/${encodeURIComponent(roomId)}.flv`;
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
