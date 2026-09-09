// ============================================================================
// FX 特效系统单测：枪口焰双通道（玩家 vmScene / 机器人世界）、命中点光、
// 曳光束径、枪口烟量、回合清理。Textures（canvas 2D）以桩替换 —— 逻辑与纹理解耦。
// ============================================================================
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/world/Textures.js', () => ({
  // 特效只用 map 采样，构造期不触 GPU —— 空对象即可，避免 canvas 依赖
  Tex: new Proxy({}, { get: () => () => ({}) }),
}))

import * as THREE from 'three'
import { FX } from '../src/world/FX.js'
import { vary } from '../src/core/Rng.js'

const V3 = (x, y, z) => new THREE.Vector3(x, y, z)

// 标准夹具：主场景 + vmScene 双通道引擎桩，相机在原点看 -Z
function makeFx() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 300)
  camera.position.set(0, 1.65, 0)
  camera.updateMatrixWorld(true)
  const vmScene = new THREE.Scene()
  const engine = { scene, camera, vmScene, vmFlashLight: new THREE.PointLight() }
  const fx = new FX(scene, camera, engine)
  return { fx, scene, camera, vmScene }
}

describe('FX 枪口焰双通道', () => {
  it('玩家开火（Vector3）：焰精灵挂 vmScene、世界精灵让位、点光两路点亮', () => {
    const { fx } = makeFx()
    const world = V3(0.3, 1.5, -1.2) // 相机前下方 ~1.2m（枪口典型位）
    fx.muzzle(world, { scale: 1, opacity: 0.9 })

    expect(fx.vmFlashSprite.visible).toBe(true)
    expect(fx.flash.visible).toBe(false) // 单次玩家开火只点亮 vm 份，不双画
    // 位置 = 相机本地系（vmScene 世界系），反推回世界应等于原点位
    const back = fx.vmFlashSprite.position.clone().applyMatrix4(fx.camera.matrixWorld)
    expect(back.distanceTo(world)).toBeLessThan(1e-5)
    // 尺寸落在玩家档（0.20-0.30 × scale 1）
    expect(fx.vmFlashSprite.scale.x).toBeGreaterThanOrEqual(0.19)
    expect(fx.vmFlashSprite.scale.x).toBeLessThanOrEqual(0.31)
    // 世界+第一人称两路灯都点亮（第一人称峰值按 muzzle 灯峰值折算）
    expect(fx.lightLife).toBeGreaterThan(0)
    expect(fx.vmPeak).toBeCloseTo(1.2, 5)
  })

  it('机器人开火/爆闪（普通对象）：走世界精灵，vm 精灵不被误触', () => {
    const { fx } = makeFx()
    fx.muzzle({ x: 3, y: 1.4, z: -18 }, { scale: 7, light: 3 })

    expect(fx.flash.visible).toBe(true)
    expect(fx.vmFlashSprite.visible).toBe(false)
    expect(fx.flash.scale.x).toBeGreaterThan(1.5) // 爆闪大尺寸原样保留
    // 机器人枪口位不驱动第一人称点光（映到相机系毫无意义）
    expect(fx.vmPeak ?? 0).toBe(0)
  })

  it('同帧玩家与机器人先后开火：两路精灵各自存活，互不抢占', () => {
    const { fx } = makeFx()
    fx.muzzle(V3(0.3, 1.5, -1.2))
    fx.muzzle({ x: 3, y: 1.4, z: -18 }) // 紧接着机器人开火
    // 玩家焰挂 vm 通道、机器人焰挂世界通道，共享时钟会吞掉先者的焰
    expect(fx.vmFlashSprite.visible).toBe(true)
    expect(fx.flash.visible).toBe(true)
  })

  it('寿命钟到期：两路精灵同时熄灭', () => {
    const { fx } = makeFx()
    fx.muzzle(V3(0.3, 1.5, -1.2))
    fx.muzzle({ x: 3, y: 1.4, z: -18 })
    fx.update(0.2) // > 0.045+0.008
    expect(fx.flash.visible).toBe(false)
    expect(fx.vmFlashSprite.visible).toBe(false)
  })
})

describe('FX 命中点光', () => {
  it('墙面命中点亮、按 dur 衰减、到期归零', () => {
    const { fx } = makeFx()
    fx.impact(2, 1.2, -10, 0, 0, 1)
    fx.update(0.001) // 与枪口焰灯同法：impact 只记寿命钟，强度在 update 落位
    expect(fx.impactLight.intensity).toBeGreaterThan(0)
    expect(fx.impactLight.position.z).toBeCloseTo(-10 + 0.07, 5) // 沿法线推出墙面
    fx.update(0.05)
    const mid = fx.impactLight.intensity
    expect(mid).toBeGreaterThan(0)
    fx.update(0.2)
    expect(fx.impactLight.intensity).toBe(0)
    expect(mid).toBeLessThan(fx.impactPeak) // 单调衰减
  })

  it('地面命中弱一档（与闷"噗"音色同语言）', () => {
    const { fx } = makeFx()
    fx.impact(0, 0, -5, 0, 1, 0) // 地面：ny>0.7
    expect(fx.impactPeak).toBeLessThan(4)
    const wallFx = makeFx()
    wallFx.fx.impact(0, 1.2, -5, 0, 0, 1)
    expect(wallFx.fx.impactPeak).toBe(4)
  })

  it('连发多次命中：单灯顶替（last-wins），不累积', () => {
    const { fx } = makeFx()
    fx.impact(2, 1.2, -10, 0, 0, 1)
    fx.impact(-3, 1.5, -8, 0, 0, 1)
    expect(fx.impactLight.position.x).toBeCloseTo(-3 + 0, 5)
    expect(fx.scene.children.filter(o => o === fx.impactLight).length).toBe(1)
  })
})

describe('FX 曳光与枪口烟', () => {
  it('tracer：束径吃 style.width × 视野补偿；近距钳制起端', () => {
    const { fx, camera } = makeFx()
    fx.calibrate(1600, 900, 70)
    fx.tracer(V3(0.3, 1.5, -1), V3(0, 1.2, -30), { width: 1.4 })
    const t = fx.tracers.find(x => x.life > 0)
    expect(t).toBeTruthy()
    expect(t.width).toBeCloseTo(1.4 * fx.tracerWScale, 5)
    // 起端贴相机（<2m）→ 沿束方向钳到 2m 外（相机不在束轴上，欧氏距离略小于 2）
    expect(t.from.distanceTo(camera.position)).toBeGreaterThan(1.9)
  })

  it('muzzleSmoke：热量决定烟量（heat 0 → 2 粒，heat 1 → 5 粒）', () => {
    const { fx } = makeFx()
    fx.muzzleSmoke(V3(0, 1.5, -1), V3(0, 0, -1), 0)
    expect(fx.puffs.n).toBe(2)
    fx.muzzleSmoke(V3(0, 1.5, -1), V3(0, 0, -1), 1)
    expect(fx.puffs.n).toBe(7)
  })
})

describe('FX 回合清理', () => {
  it('clearAll：特效全灭（含 vm 精灵与两路灯）', () => {
    const { fx } = makeFx()
    fx.muzzle(V3(0.3, 1.5, -1.2))
    fx.impact(2, 1.2, -10, 0, 0, 1)
    fx.tracer(V3(0.3, 1.5, -1), V3(0, 1.2, -30))
    fx.clearAll()
    expect(fx.flash.visible).toBe(false)
    expect(fx.vmFlashSprite.visible).toBe(false)
    expect(fx.flashLight.intensity).toBe(0)
    expect(fx.impactLight.intensity).toBe(0)
    expect(fx.tracers.every(t => t.life <= 0)).toBe(true)
  })
})

describe('vary 可复现噪声', () => {
  it('输出落在 [0,1)', () => {
    for (let i = 0; i < 200; i++) {
      const v = vary()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
