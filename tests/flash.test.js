import { describe, it, expect } from 'vitest'
import { CONFIG } from '../src/core/Config.js'
import { angleFactor, distFactor, blindDuration, skyeMaxBlind, kayoFuseAfterBounce, arcBezier, leerAffects, dizzyPlasmaBlind } from '../src/world/flashMath.js'

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

// ---- 第七类扩容（2026-09-09）：Yoru/Breach/Reyna/Gekko —— 口径 =
// Fandom 维基 2026-09 各技能页 + Deployment types 投掷物等级表 ----
describe('新闪光类型：维基确认值锁死', () => {
  it('Yoru Blindside：Class 3（29m/s、重力 0.45×9.8）、显形预备 0.6s、致盲 1.5s', () => {
    expect(F.yoru.speed).toBe(29) // 2900uu/s（Class 3）
    expect(F.yoru.gravity).toBeCloseTo(4.41, 2) // 重力系数 0.45 × 9.8
    expect(F.yoru.maxAir).toBe(2) // 未撞面消散（未确认值）
    expect(F.yoru.windup).toBe(0.6) // v2.06
    expect(F.yoru.maxBlind).toBe(1.5) // v11.08
  })

  it('Breach Flashpoint：穿墙放置预备 0.5s（v1.07）、致盲 2.25s（v11.08）', () => {
    expect(F.breach.windup).toBe(0.5)
    expect(F.breach.maxBlind).toBe(2.25)
  })

  it('Reyna Leer：10m 部署距、到位 0.4s 预备（v5.07）、近视 1.6s、60HP 可击毁', () => {
    expect(F.reyna.deployDist).toBe(10)
    expect(F.reyna.travel).toBe(0.55) // 未确认值（维基 0.55s@10m）
    expect(F.reyna.arrivalWindup).toBe(0.4)
    expect(F.reyna.nearsight).toBe(1.6)
    expect(F.reyna.visionRadius).toBe(6)
    expect(F.reyna.hp).toBe(60)
  })

  it('Gekko Dizzy：Class 2 物理、激活 0.65s、锁定 0.35s（v7.12）、活跃 1s（v9.08）、等离子 1+1s', () => {
    expect(F.gecko.speed).toBe(18) // Class 2 同 KAY/O
    expect(F.gecko.gravity).toBeCloseTo(2.94, 2)
    expect(F.gecko.activationWindup).toBe(0.65) // 未确认值
    expect(F.gecko.acquireWindup).toBe(0.35) // v7.12
    expect(F.gecko.active).toBe(1) // v9.08
    expect(F.gecko.detect).toBe(45)
    expect(F.gecko.splash).toBe(2.5)
    expect(F.gecko.blindPotency).toBe(1)
    expect(F.gecko.blindFade).toBe(1)
    expect(F.gecko.hp).toBe(20)
  })
})

describe('Reyna Leer 近视命中条件（看清瞳孔 = LOS + 视野锥）', () => {
  it('LOS 内 + 视野内 = 命中；转出视野/被遮挡 = 不命中', () => {
    expect(leerAffects(0, true)).toBe(true)
    expect(leerAffects(F.fovHalf, true)).toBe(true)
    expect(leerAffects(F.fovHalf + 1, true)).toBe(false)
    expect(leerAffects(180, true)).toBe(false)
    expect(leerAffects(0, false)).toBe(false) // 视线被墙挡：眼在但看不到瞳孔
  })
})

describe('Gekko Dizzy 等离子致盲时长（game files：1s 满效 + 1s 渐褪）', () => {
  it('总 2s，转身不可避——纯 LOS 判定后固定时长，不做角度/距离衰减', () => {
    const b = dizzyPlasmaBlind()
    expect(b.potency).toBe(1)
    expect(b.fade).toBe(1)
    expect(b.total).toBe(2)
  })
})
