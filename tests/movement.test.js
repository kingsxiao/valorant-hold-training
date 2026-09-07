import { describe, expect, it } from 'vitest'
import { CONFIG } from '../src/core/Config.js'
import { groundStep, accelFor } from '../src/core/GroundMotion.js'

// 地面移动模型对齐公开资料的回归锚点：
//  - 分武器跑速 = Fandom 维基各武器页 infobox（2021→2026 稳定）
//  - 急停里程碑 = Riot 开发者 Riot_Classick 官方实测（Phantom、全跑 5.4 m/s 出发）：
//    61% 速度 0.055s / 25% 速度 0.104s / 停稳 0.160s
//  - 加速 18.75 m/s²（持步枪社区实测）；摩擦 28.6 m/s² + 3.3/s 阻尼（社区推导，
//    与官方里程碑互证）；counter-strafe 无额外收益
const M = CONFIG.movement
const K = { accel: M.groundAccel, decelFlat: M.groundDecelFlat, decelDrag: M.groundDecelDrag }
const DT = 1 / 128 // 128Hz 逻辑步长（与游戏服务器 tick 一致）

// 以 128Hz 步进 groundStep，返回 (speed(t), 累计时间) 序列
function simulate(v0, target, seconds) {
  let v = v0, t = 0
  const marks = []
  while (t < seconds + 1e-9) {
    marks.push({ v, t })
    v = groundStep(v, target, K, DT)
    t += DT
  }
  return marks
}

describe('分武器跑速表（Fandom 维基 infobox 口径）', () => {
  it('步枪/重左轮 5.4；副武器 5.73；刀 6.75', () => {
    expect(M.runSpeed * CONFIG.weapons.vandal.moveSpeedMult).toBeCloseTo(5.4, 2)
    expect(M.runSpeed * CONFIG.weapons.phantom.moveSpeedMult).toBeCloseTo(5.4, 2)
    expect(M.runSpeed * CONFIG.weapons.sheriff.moveSpeedMult).toBeCloseTo(5.4, 2)
    expect(M.runSpeed * CONFIG.weapons.classic.moveSpeedMult).toBeCloseTo(5.73, 2)
    expect(M.runSpeed * CONFIG.weapons.ghost.moveSpeedMult).toBeCloseTo(5.73, 2)
    expect(M.knifeSpeed).toBe(6.75)
  })

  it('静步 ≈ 3.39 m/s（62.8%；Riot_Classick 官方走路级精度门槛 61% 速度互证）', () => {
    expect(M.walkMult * M.runSpeed).toBeCloseTo(3.39, 2)
    expect(M.walkMult).toBeGreaterThan(0.58)
    expect(M.walkMult).toBeLessThan(0.66)
  })
})

describe('加速（18.75 m/s² 持步枪实测，等比缩放）', () => {
  it('0 → 5.4 m/s 耗时 ≈0.29s（5.4/18.75）', () => {
    const marks = simulate(0, M.runSpeed, 0.5)
    const reach = marks.find(m => m.v >= M.runSpeed - 1e-9)
    expect(reach).toBeDefined()
    expect(reach.t).toBeGreaterThan(0.28)
    expect(reach.t).toBeLessThan(0.30)
  })

  it('accelFor：各档位达标耗时恒 ≈0.29s（"scales with speed" 等比外推）', () => {
    for (const target of [M.runSpeed * M.walkMult, M.runSpeed * M.crouchMult, M.knifeSpeed]) {
      const k = { ...K, accel: accelFor(target, M.groundAccel, M.runSpeed) }
      let v = 0, t = 0
      while (v < target - 1e-9 && t < 2) { v = groundStep(v, target, k, DT); t += DT }
      expect(t).toBeGreaterThan(0.28)
      expect(t).toBeLessThan(0.30)
    }
  })
})

describe('急停里程碑（Riot_Classick 官方实测：61% 0.055s / 25% 0.104s / 停稳 0.160s）', () => {
  it('0.055s 内降到走路级精度速度（≤61%）', () => {
    const v = simulate(M.runSpeed, 0, 0.2).find(m => m.t >= 0.055 - 1e-9).v
    expect(v).toBeLessThanOrEqual(0.61 * M.runSpeed + 1e-9)
  })

  it('0.104s 内降到死区速度（≤25%）', () => {
    const v = simulate(M.runSpeed, 0, 0.2).find(m => m.t >= 0.104 - 1e-9).v
    expect(v).toBeLessThanOrEqual(0.25 * M.runSpeed + 1e-9)
  })

  it('全跑 5.4 → 完全停稳 ≈0.147s（官方 0.160s，不允许回到旧的 61ms 机械急停）', () => {
    const marks = simulate(M.runSpeed, 0, 0.3)
    const stop = marks.find(m => m.v <= 1e-9)
    expect(stop).toBeDefined()
    expect(stop.t).toBeGreaterThan(0.13)   // 旧模型 88 m/s² 线性减速 0.061s 停 → 锁死不回退
    expect(stop.t).toBeLessThan(0.17)      // 官方停稳 0.160s
  })

  it('counter-strafe 无额外收益：反向键停稳耗时 = 松键停稳（摩擦恒大于加速）', () => {
    const stopTime = (target) => {
      const marks = simulate(M.runSpeed, target, 0.3)
      return marks.find(m => Math.abs(m.v) <= 1e-9).t
    }
    expect(stopTime(0)).toBeCloseTo(stopTime(-M.runSpeed), 3)
  })

  it('跑 → 静步（target 3.39）快速降档：0.07s 内降到走路速度以下（官方 walk 键 0.065s）', () => {
    const walk = M.runSpeed * M.walkMult
    const marks = simulate(M.runSpeed, walk, 0.2)
    const cross = marks.find(m => m.v <= walk + 1e-9)
    expect(cross).toBeDefined()
    expect(cross.t).toBeLessThan(0.07)
    // 降档到目标后稳在静步速度（不继续滑落到 0）
    const end = marks[marks.length - 1].v
    expect(end).toBeCloseTo(walk, 3)
  })
})

describe('groundStep 边界行为', () => {
  it('不越过目标（加速与降档都不超调）', () => {
    let v = 0
    for (let i = 0; i < 100; i++) v = groundStep(v, M.runSpeed, K, DT)
    expect(v).toBeLessThanOrEqual(M.runSpeed + 1e-9)
    let d = M.runSpeed
    for (let i = 0; i < 100; i++) d = groundStep(d, -M.runSpeed, K, DT)
    expect(Math.abs(d)).toBeLessThanOrEqual(M.runSpeed + 1e-9)
  })

  it('反向穿越 0 后转入加速段（最终到达反向目标速度）', () => {
    let v = M.runSpeed
    for (let i = 0; i < 1000 && v > -M.runSpeed + 1e-9; i++) v = groundStep(v, -M.runSpeed, K, DT)
    expect(v).toBeCloseTo(-M.runSpeed, 3)
  })
})
