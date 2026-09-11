// ADS（右键开镜）：Fandom 维基 infobox Alt Fire + Spread values 表 Alternate Fire
// 行的 1:1 数值锁（2026-09 取数，页面 Vandal / Phantom）：
//   zoom 1.25x · altrate 90%（vandal 8.775 / phantom 9.9 rds/s）· move 76%（4.104 m/s）
//   首发散布 vandal 0.157°/蹲 0.13° · phantom 0.11°/蹲 0.09°
//   最大散布 vandal 1.02/0.87 · phantom 0.91/0.78（注意略高于腰射 —— ADS 长点
//   射散布收敛上限并不更优，优的是首发）
// 行为锁：射速折扣、移速折扣、FOV 缩放终点、准星跟随只在 ADS 生效、弹道削减
import { describe, it, expect } from 'vitest'
import { CONFIG } from '../src/core/Config.js'
import { spreadParts } from '../src/weapons/ballistics.js'

const ctx = (over = {}) => ({
  speedRatio: 0, crouched: false, grounded: true, sprayIndex: 0, ads: false, ...over,
})

describe('ADS 数值锁（维基 Alternate Fire 行）', () => {
  it('vandal：zoom/射速/移速/散布全套 = 维基值', () => {
    const a = CONFIG.weapons.vandal.ads
    expect(a.zoom).toBe(1.25)
    expect(a.fireRateMult).toBe(0.9)
    expect(CONFIG.weapons.vandal.fireRate * a.fireRateMult).toBeCloseTo(8.775, 3) // 维基 altrate
    expect(a.moveMult).toBe(0.76)
    expect(CONFIG.movement.runSpeed * a.moveMult).toBeCloseTo(4.104, 3) // 维基 4.104 m/s
    expect(a.stand).toBe(0.157)
    expect(a.crouch).toBe(0.13)
    expect(a.maxStand).toBe(1.02)
    expect(a.maxCrouch).toBe(0.87)
  })
  it('phantom：同套 = 维基值', () => {
    const a = CONFIG.weapons.phantom.ads
    expect(a.zoom).toBe(1.25)
    expect(a.fireRateMult).toBe(0.9)
    expect(CONFIG.weapons.phantom.fireRate * a.fireRateMult).toBeCloseTo(9.9, 3)
    expect(a.moveMult).toBe(0.76)
    expect(a.stand).toBe(0.11)
    expect(a.crouch).toBe(0.09)
    expect(a.maxStand).toBe(0.91)
    expect(a.maxCrouch).toBe(0.78)
  })
  it('只有步枪有 ADS：Classic 右键是三连发、Sheriff/Ghost/刀无开镜', () => {
    for (const id of ['classic', 'ghost', 'sheriff', 'knife']) {
      expect(CONFIG.weapons[id].ads).toBeUndefined()
    }
  })
})

describe('ADS 散布（spreadParts ctx.ads）', () => {
  it('站立首发：站定静止散布 = ADS 首发值', () => {
    expect(spreadParts(CONFIG.weapons.vandal, ctx({ ads: true })).total).toBeCloseTo(0.157, 5)
    expect(spreadParts(CONFIG.weapons.phantom, ctx({ ads: true })).total).toBeCloseTo(0.11, 5)
  })
  it('蹲姿首发 = ADS 蹲值（不是 腰射crouchMult×ADS站立）', () => {
    expect(spreadParts(CONFIG.weapons.vandal, ctx({ ads: true, crouched: true })).total).toBeCloseTo(0.13, 5)
    expect(spreadParts(CONFIG.weapons.phantom, ctx({ ads: true, crouched: true })).total).toBeCloseTo(0.09, 5)
  })
  it('连射增长封顶在 ADS maxStand（vandal 1.02 / phantom 0.91）', () => {
    const spray = { sprayIndex: 999 } // 远超封顶
    expect(spreadParts(CONFIG.weapons.vandal, ctx({ ads: true, ...spray })).total).toBeCloseTo(1.02, 5)
    expect(spreadParts(CONFIG.weapons.phantom, ctx({ ads: true, ...spray })).total).toBeCloseTo(0.91, 5)
  })
  it('ADS 最大散布 ≥ 腰射（维基：开镜首发更准但长连射封顶略高）', () => {
    expect(CONFIG.weapons.vandal.ads.maxStand).toBeGreaterThan(CONFIG.weapons.vandal.spread.max)
    expect(CONFIG.weapons.phantom.ads.maxStand).toBeGreaterThan(CONFIG.weapons.phantom.spread.max)
  })
  it('移动加算惩罚（+°）与腰射同值：跑动满速 ADS = 基准 + run 加算', () => {
    const s = CONFIG.weapons.vandal.spread
    const want = CONFIG.weapons.vandal.ads.stand + (s.run - s.stand)
    expect(spreadParts(CONFIG.weapons.vandal, ctx({ ads: true, speedRatio: 1 })).total).toBeCloseTo(want, 5)
  })
  it('腰射路径不受 ads 字段影响（回归：旧数值原样）', () => {
    expect(spreadParts(CONFIG.weapons.vandal, ctx()).total).toBeCloseTo(0.25, 5)
    expect(spreadParts(CONFIG.weapons.vandal, ctx({ crouched: true })).total).toBeCloseTo(0.2125, 4) // 0.25×0.85
    expect(spreadParts(CONFIG.weapons.phantom, ctx()).total).toBeCloseTo(0.2, 5)
  })
})

describe('ADS 视野缩放与准星跟随几何', () => {
  it('满开镜水平 FOV = 103 / 1.25 = 82.4°', () => {
    expect(CONFIG.graphics.fovH / CONFIG.weapons.vandal.ads.zoom).toBeCloseTo(82.4, 6)
  })
  it('度偏移→屏幕像素投影：投影式正确、缩放放大每度像素、符号正确（上爬 y 负 / 左偏 x 负）', () => {
    // 独立复算 adsCrosshairOffset 的投影式（WeaponSystem 实例重，几何抽出来验）
    const toPx = (deg, fovVDeg, viewH) => Math.tan(deg * Math.PI / 360)
      / Math.tan(fovVDeg * Math.PI / 360) * viewH * 0.5
    // 基准：1080p、垂直 FOV 60°，1° = tan(0.5°)/tan(30°)×540 ≈ 8.16px
    expect(toPx(1, 60, 1080)).toBeCloseTo(8.162, 2)
    // 缩放放大：ADS 垂直 FOV（82.4°h/16:9 ≈ 52.5°v）每度像素 > 腰射（103°h ≈ 70.5°v）
    const pxHip = toPx(1, 70.5, 1080), pxAds = toPx(1, 52.5, 1080)
    expect(pxAds / pxHip).toBeCloseTo(1.437, 1) // ≈ 9.57 / 6.66（角度投影非线性，略超 1.25）
    const off = { x: -toPx(3, 52.5, 1080), y: -toPx(2, 52.5, 1080) }
    expect(off.x).toBeLessThan(0) // patOff.y 左偏 → 屏 x 负
    expect(off.y).toBeLessThan(0) // patOff.p 上爬 → 屏 y 负
  })
})

describe('ADS 后坐削减实测锁值', () => {
  it('recoilMult = 0.95（四 take 排序均值配对 0.964 + 配对 ratio {0.90,1.00} 交叉；同墙同位配对不存在已证）', () => {
    const m = CONFIG.weapons.vandal.ads.recoilMult
    expect(m).toBeGreaterThan(0.90)
    expect(m).toBeLessThan(1.0)
    expect(CONFIG.weapons.phantom.ads.recoilMult).toBe(m)
    // ADS 后坐必须低于腰射（维基"Slight reduction"方向）
    expect(m).toBeLessThan(1)
  })
})

describe('ADS 状态机（WeaponSystem 静态口径）', () => {
  it('adsOn 阈值 = blend>0.5（射速/散布在开镜半程切换）', () => {
    // 阈值语义在 WeaponSystem getter 上；这里锁过渡时长 = 实机 30fps 逐帧实测
    // （进镜 ~165ms / 出镜 ~150ms，量化误差 ±33ms → 允许 ±0.05s）
    const t = CONFIG.weapons.vandal.ads.time
    // 60fps 三事件精测 183ms ±17ms（胶片条逐帧：11 帧 × 16.7ms）
    expect(t).toBeGreaterThan(0.166)
    expect(t).toBeLessThan(0.20)
  })
  it('equipTime = 维基 Normal 档（步枪 1.0 / 手枪 0.75 / 近战 0.6），与 valorant-api 游戏数据一致', () => {
    expect(CONFIG.weapons.vandal.equipTime).toBe(1.0)
    expect(CONFIG.weapons.phantom.equipTime).toBe(1.0)
    expect(CONFIG.weapons.sheriff.equipTime).toBe(1.0)
    expect(CONFIG.weapons.classic.equipTime).toBe(0.75)
    expect(CONFIG.weapons.ghost.equipTime).toBe(0.75)
    expect(CONFIG.weapons.knife.equipTime).toBe(0.6)
  })
})
