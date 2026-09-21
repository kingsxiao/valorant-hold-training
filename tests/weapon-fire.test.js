// ============================================================================
// _fireOne 开火行为锁（实例级）：散布采样时序 / punch 增量记账。
// config.test.js 锁的是 makeSprayPattern 纯函数表值；这里锁 WeaponSystem 里
// 两条无法从纯函数读出的时序语义（2026-09-21 首发精度修复）：
//  1. sprayIndex 递增在 currentSpread() 采样之后 —— 首发散布 = 表显 stand
//     （无 +0.05° 连射增量），与弹道表首项 0 同语义；旧序先 ++ 再采样，
//     首发散布 0.30° ≠ 锁定的 0.25°
//  2. punch 无每发常数项 —— 多弹匣连发累计不随发数单调爬升（弹药无限 +
//     恒定常数会一路涨到 Player 的 0.35rad punch 钳位；曾有的 +0.002 常数
//     25 发即虚增 2.9°，与全弹匣 ≈1.0-1.5° 实测标定矛盾）
// 外设桩同 weapon-skin.test.js：Textures（canvas 2D）/ GLTFLoader（网络）/
// document（baseURI）——WeaponSystem 构造需要，行为不影响本文件断言
// ============================================================================
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/world/Textures.js', () => ({
  Tex: new Proxy({}, { get: () => () => ({}) }),
}))
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { parse(buf, path, onLoad) { onLoad(null) } },
}))
vi.stubGlobal('document', { baseURI: 'http://vht.test/' })

import * as THREE from 'three'
import { CONFIG } from '../src/core/Config.js'
import { WeaponSystem } from '../src/weapons/WeaponSystem.js'

const mkPlayer = () => {
  const punches = []
  return {
    moveSpeed: 0, crouchAmt: 0, grounded: true, pitch: 0, yaw: 0,
    pos: { x: 0, y: 0, z: 0 }, eyeHeight: 1.65,
    updateCamera() {},
    addPunch: (x, y) => punches.push([x, y]),
    punches,
  }
}
const makeWeapons = (player) => new WeaponSystem({
  camera: new THREE.PerspectiveCamera(),
  vmCamera: new THREE.PerspectiveCamera(),
  world: { raycast: () => null },
  bots: { pickHit: () => null },
  fx: new Proxy({}, { get: () => () => {} }),
  audio: new Proxy({}, { get: () => () => {} }),
  player,
  flash: null,
})
const DEG = 180 / Math.PI
const punchDeg = (player) => player.punches.reduce((s, [x]) => s + x, 0) * DEG

describe('首发精度（散布采样时序 + 弹道表首项）', () => {
  it('currentSpread() 采样时 sprayIndex 尚未递增：首发散布 = 表显 stand（0.25° 而非 0.30°）', () => {
    const w = makeWeapons(mkPlayer())
    let seen = null
    const orig = w.currentSpread.bind(w)
    vi.spyOn(w, 'currentSpread').mockImplementation(() => {
      seen = { idx: w.sprayIndex, val: orig() }
      return seen.val
    })
    w._fireOne()
    expect(seen.idx).toBe(0) // 采样先于递增（旧序先 ++：首发达里已是 1）
    expect(seen.val).toBeCloseTo(CONFIG.weapons.vandal.spread.stand, 5)
    expect(w.sprayIndex).toBe(1)
    // 第二发起连射增长照常：+0.05°/发
    w._fireOne()
    expect(seen.idx).toBe(1)
    expect(seen.val).toBeCloseTo(CONFIG.weapons.vandal.spread.stand + 0.05, 5)
  })

  it('首发无视角上踢：弹道表首项 0 且无常数项 → 第一发 punch 恰为 0（水平/垂直都为 0）', () => {
    const p = mkPlayer()
    makeWeapons(p)._fireOne()
    expect(p.punches).toHaveLength(1)
    expect(p.punches[0][0]).toBe(0) // pitch 分量
    expect(p.punches[0][1]).toBe(0) // yaw 分量
  })
})

describe('punch 增量记账（无常数项）', () => {
  it('单弹匣累计在实测带内：vandal 25 发 ≈1.45°（1.0-1.5° 阶跃保持标定）', () => {
    const p = mkPlayer()
    const w = makeWeapons(p)
    for (let i = 0; i < 25; i++) w._fireOne()
    expect(punchDeg(p)).toBeGreaterThan(1.0)
    expect(punchDeg(p)).toBeLessThan(1.8)
  })

  it('多弹匣连发累计不随发数单调爬升：100 发 ≈ 25 发（平台期增量趋零；旧 +0.002 常数路径 4× 发数涨 ~3 倍）', () => {
    const shoot = (n) => {
      const p = mkPlayer()
      const w = makeWeapons(p)
      for (let i = 0; i < n; i++) w._fireOne()
      return punchDeg(p)
    }
    const mag = shoot(25), fourMags = shoot(100)
    expect(fourMags / mag).toBeLessThan(1.1) // 纯增量口径：表封顶后 dPunch=0，只余平台微升
    expect(fourMags).toBeLessThan(2)
  })

  it('点射（停火超过 recoverTime 复位）累计 ≈0：每发都是首发、首发 punch 为 0（旧路径 100 发点射爬到 >10°）', () => {
    const p = mkPlayer()
    const w = makeWeapons(p)
    for (let i = 0; i < 100; i++) {
      w._fireOne()
      w.now += 1 // > recoverTime 0.4s
      w.step(1 / CONFIG.sim.tickHz, { mouse0: false, mouse1: false }) // 触发弹道/punch 基准复位
    }
    expect(punchDeg(p)).toBeLessThan(0.5)
  })
})
