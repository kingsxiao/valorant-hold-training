// 开火视觉时序：实机 1080p60 逐帧标定锁值（all-recoil 专集帧差剖面，2026-09-11）
//  - 枪口焰 ≈1 帧 @60fps（418→419→420 帧亮度剖面：+11k px → 回落）
//  - 命中尘闪 2-3 帧（33-50ms）
//  - 曳光与弹着增亮同帧 → 10-15m 内一帧完成（≥600m/s 下限），30m 外 2 帧可观测
import { describe, it, expect } from 'vitest'
import { FX_TIMING } from '../src/world/FX.js'

describe('FX_TIMING 实测锁值（开火视觉时序）', () => {
  it('枪口焰寿命 = 1 帧 @60fps（17ms，允许 ±半帧）', () => {
    expect(FX_TIMING.muzzleFlash).toBeGreaterThan(0.012)
    expect(FX_TIMING.muzzleFlash).toBeLessThan(0.025)
  })
  it('曳光速度 ≥600m/s（同帧到达下限）且 30m 飞行 ≈2 帧', () => {
    expect(FX_TIMING.tracerSpeed).toBeGreaterThanOrEqual(600)
    expect(FX_TIMING.tracerSpeed).toBe(900)
    // 30m 飞行时长 2 帧级（27-50ms）；近距最短 28ms 快闪
    const t30 = 30 / FX_TIMING.tracerSpeed
    expect(t30).toBeGreaterThan(0.027)
    expect(t30).toBeLessThan(0.05)
    expect(FX_TIMING.tracerMinDur).toBeGreaterThan(0.02)
    expect(FX_TIMING.tracerMinDur).toBeLessThan(0.04)
  })
  it('枪口点光时长：步枪 28ms / 大口径 38ms / 消音 25ms（与焰同帧级， Sheriff 略长）', () => {
    expect(FX_TIMING.lightRifle).toBeGreaterThan(0.02)
    expect(FX_TIMING.lightRifle).toBeLessThan(0.04)
    expect(FX_TIMING.lightHeavy).toBeGreaterThan(FX_TIMING.lightRifle)
    expect(FX_TIMING.lightSuppressed).toBeLessThan(FX_TIMING.lightRifle)
  })
  it('命中白闪爆芯寿命落在实测 33-50ms 带（均值+扰动上界）', () => {
    expect(FX_TIMING.hitCore).toBeGreaterThan(0.033)
    expect(FX_TIMING.hitCore).toBeLessThan(0.05)
    expect(FX_TIMING.hitCore + FX_TIMING.hitCoreVary).toBeLessThanOrEqual(0.062)
  })
})
