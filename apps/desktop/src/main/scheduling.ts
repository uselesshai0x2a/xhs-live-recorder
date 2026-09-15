import type { Settings, Target } from '@xhs-live-recorder/core'

export function isTargetDue(
  target: Target,
  settings: Settings,
  now: number,
  recording = false
): boolean {
  if (!target.enabled || target.archivedAt) return false
  const checked = Date.parse(target.checkedAt ?? '')
  const interval =
    target.state === 'offline'
      ? 120000
      : target.state === 'live' && recording
        ? 300000
        : settings.intervalMs
  return !Number.isFinite(checked) || now - checked >= interval
}

export function randomRequestGap(minimum: number, random: () => number): number {
  const floor = Math.max(5000, minimum)
  return floor + Math.floor(random() * (2 * floor + 1))
}
