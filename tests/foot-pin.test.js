// 钉固状态机单测（2026-09-29 畸形 r1 随修补齐）：Bot._stepFootPin 的
// 入带锁存/支撑钉死/提离/交还/重钉/钳制释放全链路，用最小假骨架直驱
// prototype 方法（不建场景）。官方锚曲线以合成 ik 数据注入（下落-平台-升弧-
// 摆动-回落），阈值锁值：入带 ≤0.156·s、提离 >0.19·s、交还 >0.21·s、平台
// 0.125·s。世界映射 =（psa.y, psa.z, +psa.x）×s，本测 s=1、mesh 恒等
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Bot } from '../src/entities/Bot.js'

const DT = 1 / 128
const FPS = 128

// 最小单腿假骨架：mesh(恒等) → hip(0.11,0.95,0) → knee(0,-0.45,0) → foot(0,-0.5,0)
// 腿长 0.45+0.5=0.95 = maxReach；锚源 = 单个 walk action（合成 ik 曲线，4s@128Hz）
function makeBot() {
  const mesh = new THREE.Group()
  const hip = new THREE.Bone(); hip.name = 'L_Hip_1'; hip.position.set(0.11, 0.95, 0)
  const knee = new THREE.Bone(); knee.name = 'L_Knee_1'; knee.position.set(0, -0.45, 0)
  const foot = new THREE.Bone(); foot.name = 'L_Foot_1'; foot.position.set(0, -0.5, 0)
  mesh.add(hip); hip.add(knee); knee.add(foot)
  for (const b of [hip, knee, foot]) b.userData._clipQ = new THREE.Quaternion()
  const DUR = 4
  const N = DUR * FPS
  const ikL = new Array(N * 3).fill(0)
  // 合成锚（psa 空间）：0~0.5s 下落 0.30→0.12（psa.x 恒 0.30）/ 0.5~1.5s 平台
  // 支撑（psa.x 0.30→0.00 后扫，总位移 0.30 < 0.5 防陈旧钉固兜底触发）/
  // 1.5~2.0s 升弧 0.12→0.45 / 2.0~3.0s 摆动高位 / 3.0~3.5s 回落 / 3.5~4s 二次平台
  const zAt = (t) => {
    if (t < 0.5) return 0.30 - (0.18 * t) / 0.5
    if (t < 1.5) return 0.12
    if (t < 2.0) return 0.12 + (0.33 * (t - 1.5)) / 0.5
    if (t < 3.0) return 0.45
    if (t < 3.5) return 0.45 - (0.33 * (t - 3.0)) / 0.5
    return 0.12
  }
  const xAt = (t) => (t < 0.5 ? 0.30 : t < 1.5 ? 0.30 - (0.30 * (t - 0.5)) / 1.0 : 0)
  for (let f = 0; f < N; f++) {
    ikL[f * 3] = +xAt(f / FPS).toFixed(5)     // psa x（前向）
    ikL[f * 3 + 1] = 0.05                      // psa y（侧偏 → 世界 x）
    ikL[f * 3 + 2] = +zAt(f / FPS).toFixed(5) // psa z（高 → 世界 y）
  }
  const action = {
    time: 0,
    getClip: () => ({ userData: { ik: { L: ikL, R: ikL, n: N } }, duration: DUR }),
    getEffectiveWeight: () => 1,
  }
  // 原型链挂到 Bot.prototype（_stepFootPin 内部调用 this._anchorSources 等
  // 同类方法——普通对象字面量看不到原型）
  const bot = Object.create(Bot.prototype)
  bot._officialLo = true
  bot._strafeRig = { legs: [{ side: 'L', up: hip, knee, foot, maxReach: 0.95 }] }
  bot.anim = { walk: action }
  bot.mesh = mesh
  bot._heroScale = 1
  return { bot, action, foot }
}

const step = (bot, action, n, tick = () => {}) => {
  for (let i = 0; i < n; i++) {
    action.time += DT
    Bot.prototype._stepFootPin.call(bot, DT)
    tick(i)
  }
}

describe('钉固状态机：入带锁存（阈值 = 官方支撑带上沿 0.155·s + 1mm）', () => {
  it('锚下落穿越 0.156·s 才锁存（不早于带上沿）；latch.y 钳到官方平台 0.125·s', () => {
    const { bot, action, foot } = makeBot()
    let latched = null
    step(bot, action, 96, (i) => { // 0.75s：覆盖下落段全程
      const st = foot.userData._pin
      if (st.latch && !latched) {
        latched = { tick: i }
        expect(st.latch.y).toBeCloseTo(0.125, 6) // 官方平台钳制
        expect(st.latch.x).toBeCloseTo(0.05, 6)  // 世界 x = psa.y
        expect(st.latch.z).toBeCloseTo(0.30, 6)  // 世界 z = psa.x（穿越帧值）
      }
    })
    expect(latched).toBeTruthy()
    // 穿越时刻：z(t)=0.30−0.36t ≤ 0.156 → t ≥ 0.4s（i≥51）——不早于官方带上沿
    expect(latched.tick).toBeGreaterThanOrEqual(51)
    expect(latched.tick).toBeLessThanOrEqual(54)
  })

  it('支撑平台期目标世界钉死（psa.x 后扫不带入 = 零滑步剖面）', () => {
    const { bot, action, foot } = makeBot()
    let pinned = null
    step(bot, action, 64) // 下落段预热
    step(bot, action, 96, () => { // 平台段（t 0.5→1.25s，psa.x 0.30→0.075 后扫中）
      const st = foot.userData._pin
      if (st.latch) {
        if (!pinned) pinned = { x: st.anchor.x, z: st.anchor.z, y: st.anchor.y }
        else {
          expect(st.anchor.x).toBeCloseTo(pinned.x, 6) // 水平恒冻结
          expect(st.anchor.z).toBeCloseTo(pinned.z, 6)
          expect(st.anchor.y).toBeCloseTo(pinned.y, 6)
        }
        // 平台 y = min(锁存帽 0.125, 活锚下行值)，恒不高于锁存帽
        expect(st.anchor.y).toBeLessThanOrEqual(0.125 + 1e-9)
      }
    })
    expect(pinned).toBeTruthy()
  })
})

describe('钉固状态机：提离与交还（>0.19·s 提离 / >0.21·s 交还）', () => {
  it('锚升过 0.19·s 转 lift（水平仍钉死、y 跟活锚）；过 0.21·s 交还 loose', () => {
    const { bot, action, foot } = makeBot()
    step(bot, action, 1) // 首 tick 建 _pin 状态
    const st = foot.userData._pin
    let sawLift = false, sawLoose = false
    step(bot, action, 320, () => { // 2.5s：下落+平台+升弧+摆动
      if (st.latch && st.lift && !sawLift) {
        sawLift = true
        expect(st.anchor.x).toBeCloseTo(st.latch.x, 6) // 水平仍钉固
        expect(st.anchor.z).toBeCloseTo(st.latch.z, 6)
        expect(st.anchor.y).toBeGreaterThan(0.185) // y 跟活锚（升弧过 0.19）
      }
      if (st.loose && !sawLoose) {
        sawLoose = true
        expect(st.latch).toBeNull() // 交还：锁存释放
      }
    })
    expect(sawLift).toBe(true)
    expect(sawLoose).toBe(true)
  })

  it('摆动高位全幅跟踪（锚=活锚）；回落穿越 ≤0.156·s 重钉（latch.y 仍取平台钳制）', () => {
    const { bot, action, foot } = makeBot()
    step(bot, action, 1)
    const st = foot.userData._pin
    let sawTrack = false, sawRelatch = false
    step(bot, action, 480, () => { // 3.75s：覆盖二次入带
      if (!st.latch && !st.loose && st.w > 0.9 && st.anchor.y > 0.4 && !sawTrack) {
        sawTrack = true
        expect(st.anchor.x).toBeCloseTo(0.05, 6) // 世界 x=psa.y
        expect(st.anchor.y).toBeGreaterThan(0.4) // 全幅跟曲线（首个采样点在升弧上）
      }
      if (sawTrack && st.latch && !sawRelatch) {
        sawRelatch = true
        expect(st.loose).toBeNull()
        expect(st.latch.y).toBeCloseTo(0.125, 6) // 重钉仍取平台钳制
      }
    })
    expect(sawTrack).toBe(true)
    expect(sawRelatch).toBe(true)
  })
})

describe('钉固状态机：可达钳制（提踵保持）与 clampHold 释放（畸 r1 回归锁）', () => {
  // 身体以 2m/s 掠过钉死脚：锚 psa.y 与身体同速后扫（锚世界静止，真实系统
  // 的抵消几何），dH = 髋-锚水平距随体增长越允许半径 → 钳制 → 提踵 2 tick →
  // 转 lift 且 clampHold 释放。旧 clampHold 把目标世界点钉到「髋离一整条腿」
  // 才换位 = 支撑末直腿 A 字 + 踝悬空 4~20cm 的直接来源
  function makeClampCase() {
    const { bot, action, foot } = makeBot()
    const DUR = 2, N = DUR * FPS, v = 2
    const ikL = new Array(N * 3).fill(0)
    for (let f = 0; f < N; f++) {
      const t = f / FPS
      ikL[f * 3] = 0.10                       // psa x（前向）恒定
      ikL[f * 3 + 1] = +(0.05 - v * t).toFixed(5) // psa y 后扫 = 抵消体速（世界 x 静止）
      ikL[f * 3 + 2] = 0.12                   // psa z 平台（tick 0 即入带锁存）
    }
    action.getClip = () => ({ userData: { ik: { L: ikL, R: ikL, n: N } }, duration: DUR })
    const advance = () => { bot.mesh.position.x = v * action.time }
    return { bot, action, foot, advance }
  }
  const REACH = 0.95
  const HIP_Y = 0.95

  it('触钳 2 tick 预算后转 lift 且 clampHold=null；钳后目标恒在可达球内（max 修复锁）', () => {
    const { bot, action, foot, advance } = makeClampCase()
    step(bot, action, 1) // 首 tick 建 _pin 状态（_stepFootPin 内 ??= 惰性创建）
    const st = foot.userData._pin
    let clampedTick = -1, liftedTick = -1
    const checkReachable = () => {
      if (st.clampHold) { // 钳后目标（含 yCap/max 提踵）必须落在腿长球内
        const dx = st.clampHold.x - (bot.mesh.position.x + 0.11)
        const dy = st.clampHold.y - HIP_Y
        expect(dx * dx + dy * dy).toBeLessThanOrEqual(REACH * REACH + 1e-6)
      }
    }
    step(bot, action, 192, (i) => { // 1.5s：tick0 锁存 → dH 越半径（~0.2s）→ 钳 → lift
      advance(); checkReachable()
      if (clampedTick < 0 && (st.clampW ?? 0) > 0.2) clampedTick = i
      if (clampedTick >= 0 && liftedTick < 0 && st.lift) liftedTick = i
    })
    expect(clampedTick).toBeGreaterThanOrEqual(0) // 钳制确实触发过
    expect(liftedTick).toBeGreaterThanOrEqual(clampedTick) // 提踵预算后转 lift
    step(bot, action, 4, () => { advance(); checkReachable() })
    expect(st.clampHold).toBeNull() // lift 态不进钳分支：保持点已释放且不重建
  })

  it('_pinDbg 置 null 后下一 tick 重建（探针逐场景清零修复）；undefined 恒不建', () => {
    const { bot, action } = makeBot()
    expect(bot._pinDbg).toBeUndefined()
    step(bot, action, 4)
    expect(bot._pinDbg).toBeUndefined() // 生产零开销
    bot._pinDbg = null // 探针逐场景清零
    step(bot, action, 4)
    expect(bot._pinDbg).toBeTruthy()
    expect(bot._pinDbg.latch + bot._pinDbg.swing + bot._pinDbg.loose).toBeGreaterThan(0)
  })
})
