import { describe, expect, it } from 'vitest'
import { defaultSettings, type Target } from '@xhs-live-recorder/core'
import { isTargetDue, randomRequestGap } from './scheduling'

const settings = { ...defaultSettings('D:/recordings'), intervalMs: 30000 }
const target = {
  enabled: true,
  state: 'offline',
  checkedAt: new Date(1000000).toISOString()
} as Target
describe('per-target polling', () => {
  it('waits 120 seconds after each offline check regardless of live interval', () => {
    expect(isTargetDue(target, settings, 1119999)).toBe(false)
    expect(isTargetDue(target, settings, 1120000)).toBe(true)
    expect(
      isTargetDue({ ...target, checkedAt: new Date(1120000).toISOString() }, settings, 1120001)
    ).toBe(false)
  })
  it('keeps independent deadlines and skips disabled targets', () => {
    expect(isTargetDue({ ...target, state: 'live' }, settings, 1030000)).toBe(true)
    expect(isTargetDue({ ...target, checkedAt: null }, settings, 1000000)).toBe(true)
    expect(isTargetDue({ ...target, enabled: false }, settings, 2000000)).toBe(false)
  })
  it('draws different bounded random delays without reducing the minimum', () => {
    expect(randomRequestGap(5000, () => 0)).toBe(5000)
    expect(randomRequestGap(5000, () => 0.5)).toBe(10000)
    expect(randomRequestGap(5000, () => 0.99999)).toBe(15000)
    expect(randomRequestGap(1000, () => 0)).toBe(5000)
  })
  it('uses five minutes only for live targets with an active recording', () => {
    const live = { ...target, state: 'live' } as Target
    expect(isTargetDue(live, settings, 1299999, true)).toBe(false)
    expect(isTargetDue(live, settings, 1300000, true)).toBe(true)
    expect(isTargetDue(live, settings, 1120000, false)).toBe(true)
    expect(isTargetDue(target, settings, 1120000, true)).toBe(true)
    expect(
      isTargetDue({ ...live, archivedAt: new Date().toISOString() }, settings, 2000000, true)
    ).toBe(false)
  })
})
