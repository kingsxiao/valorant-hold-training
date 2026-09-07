import { describe, it, expect } from 'vitest'
import { CONFIG } from '../src/core/Config.js'
import { angleFactor, distFactor, blindDuration, skyeMaxBlind, kayoFuseAfterBounce, arcBezier } from '../src/world/flashMath.js'

// 闪光干扰数值回归：口径 = Fandom 维基 2026-09（FLASH/drive / Guiding Light /
// Curveball 各技能页 + Deployment types 投掷物等级表 + Status Effect#Flash）
// 详见 README"闪光干扰"节与"已知边界"——改这里先改口径出处
const F = CONFIG.flash

describe('闪光数值：维基确认值锁死', () => {
  it('KAY/O FLASH/drive：18m/s（Class 2）、引信 1.6s、弹跳 0.8s、致盲 2.25s', () => {
    expect(F.kayo.speed).toBe(18)
    expect(F.kayo.gravity).toBeCloseTo(2.94, 2) // 重力系数 0.3 × 9.8
    expect(F.kayo.maxFuse).toBe(1.6)
    expect(F.kayo.bounceFuse).toBe(0.8)
    expect(F.kayo.telegraph).toBe(0.3)
    expect(F.kayo.maxBlind).toBe(2.25)
  })

  it('Skye Guiding Light：18m/s、最长飞 2s、1→2.25s 随 0.75s 充能、激活 0.3s', () => {
    expect(F.skye.speed).toBe(18)
    expect(F.skye.maxFlight).toBe(2)
    expect(F.skye.chargeTime).toBe(0.75)
    expect(F.skye.minBlind).toBe(1)
    expect(F.skye.maxBlind).toBe(2.25)
    expect(F.skye.activationWindup).toBe(0.3)
  })

  it('Phoenix Curveball：起爆 0.6s（v11.00）、致盲 1.5s（v5.01）', () => {
    expect(F.phoenix.windup).toBe(0.6)
    expect(F.phoenix.maxBlind).toBe(1.5)
  })

  it('白屏渐褪 1 秒（Status Effect#Flash 确认值）', () => {
    expect(F.fadeTime).toBe(1)
  })
})

describe('朝向因子（直视满时长 / 背对轻微短暂）', () => {
  it('起爆点在视野内 = 直视（半水平 FOV 103°/2）', () => {
    expect(angleFactor(0)).toBe(1)
    expect(angleFactor(45)).toBe(1)
    expect(angleFactor(F.fovHalf)).toBe(1)
  })

  it('视野外随角度衰减，完全背对落到 backFactor', () => {
    const mid = angleFactor(90)
    expect(mid).toBeGreaterThan(F.backFactor)
    expect(mid).toBeLessThan(1)
    expect(angleFactor(180)).toBe(F.backFactor)
    // 单调不增
    expect(angleFactor(120)).toBeLessThanOrEqual(angleFactor(80))
  })
})

describe('距离因子（越远越短 / 超远免疫）', () => {
  it('满时长距离内 = 1，其后线性衰减到归零', () => {
    expect(distFactor(3)).toBe(1)
    expect(distFactor(F.fullDist)).toBe(1)
    expect(distFactor(F.fullDist + 10)).toBeLessThan(1)
    expect(distFactor((F.fullDist + F.zeroDist) / 2)).toBeCloseTo(0.5, 6)
    expect(distFactor(F.zeroDist)).toBe(0)
    expect(distFactor(F.zeroDist + 100)).toBe(0)
  })
})

describe('致盲时长判定', () => {
  it('无视线（被墙挡）→ 不致盲', () => {
    expect(blindDuration(2.25, 5, 0, false)).toBe(0)
  })

  it('近距离直视起爆点 = 满时长', () => {
    expect(blindDuration(2.25, 5, 0, true)).toBeCloseTo(2.25, 6)
    expect(blindDuration(1.5, 12, 30, true)).toBeCloseTo(1.5, 6)
  })

  it('背对起爆点 = 轻微短暂（backFactor 比例）', () => {
    expect(blindDuration(2.25, 5, 180, true)).toBeCloseTo(2.25 * F.backFactor, 6)
    expect(blindDuration(2.25, 5, 180, true)).toBeLessThan(0.5)
  })

  it('超远距离直视也不致盲（维基：especially large distances）', () => {
    expect(blindDuration(2.25, F.zeroDist, 0, true)).toBe(0)
  })

  it('时长不足 50ms 视为未致盲（过滤边缘噪声）', () => {
    expect(blindDuration(2.25 * 0.01, 5, 0, true)).toBe(0)
  })
})

describe('Skye 鹰：致盲随飞行充能（v5.07：1s→2.25s over 0.75s）', () => {
  it('即时起爆 = 1s；飞行 0.375s = 中值；≥0.75s = 2.25s', () => {
    expect(skyeMaxBlind(0)).toBe(1)
    expect(skyeMaxBlind(0.375)).toBeCloseTo(1.625, 6)
    expect(skyeMaxBlind(0.75)).toBe(2.25)
    expect(skyeMaxBlind(1.5)).toBe(2.25) // 封顶
  })
})

describe('KAY/O 弹跳引信（v10.06：0.8s，不延长剩余）', () => {
  it('剩余充足 → 缩到 0.8s；剩余不足 → 保持', () => {
    expect(kayoFuseAfterBounce(1.2)).toBe(0.8)
    expect(kayoFuseAfterBounce(0.5)).toBe(0.5)
    expect(kayoFuseAfterBounce(0.8)).toBe(0.8)
  })
})

describe('Curveball 弧长参数化贝塞尔（恒速 Fixed 导弹）', () => {
  const p0 = { x: 0, y: 0, z: -31 }
  const p1 = { x: 2, y: 2, z: -24 }
  const p2 = { x: 0, y: 2, z: -20 }
  const curve = arcBezier(p0, p1, p2)
  const out = { x: 0, y: 0, z: 0 }

  it('端点精确、共线退化为直线（长度 = 两段之和）', () => {
    const straight = arcBezier({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 5 }, { x: 2, y: 0, z: 10 })
    expect(straight.len).toBeCloseTo(Math.hypot(2, 10), 5)
    straight.point(0, out)
    expect(out.z).toBeCloseTo(0, 5)
    straight.point(straight.len, out)
    expect(out.x).toBeCloseTo(2, 5)
    expect(out.z).toBeCloseTo(10, 5)
    straight.point(straight.len / 2, out)
    expect(out.x).toBeCloseTo(1, 5)
    expect(out.z).toBeCloseTo(5, 5)
  })

  it('弧长落在起点/终点上', () => {
    curve.point(0, out)
    expect(out.z).toBeCloseTo(p0.z, 5)
    curve.point(curve.len, out)
    expect(out.z).toBeCloseTo(p2.z, 5)
    expect(out.y).toBeCloseTo(p2.y, 5)
  })

  it('等弧长采样 → 等距落点（恒速弹道的前提）', () => {
    const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 }, c = { x: 0, y: 0, z: 0 }
    const n = 8
    const prev = { x: 0, y: 0, z: 0 }
    curve.point(0, prev)
    let minD = Infinity, maxD = 0
    for (let i = 1; i <= n; i++) {
      curve.point(curve.len * i / n, out)
      const d = Math.hypot(out.x - prev.x, out.y - prev.y, out.z - prev.z)
      minD = Math.min(minD, d); maxD = Math.max(maxD, d)
      prev.x = out.x; prev.y = out.y; prev.z = out.z
    }
    expect(minD).toBeGreaterThan(0)
    expect(maxD / minD).toBeLessThan(1.02) // 弧长表线性插值误差内近似等距
    expect(a.x + b.x + c.x).toBe(0) // 引用避免未用告警
  })
})
