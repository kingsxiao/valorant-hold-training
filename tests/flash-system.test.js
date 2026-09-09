// ============================================================================
// FlashSystem 实例级冒烟：七类闪光/致盲道具各自跑完整生命周期（128Hz 步进 +
// 每步一帧 renderSync），任一类型缺分支/字段错位都会在这里抛出——第一百二十八轮
// 加 Dizzy 时把 renderSync 的 phoenix 动画分支顶掉，火球掉进 Dizzy 分支读
// m.body.scale 每帧 TypeError，渲染循环中断（玩家看到的"闪退"）；flashMath 纯函数
// 测试对此无感，故补一层实例级回归。
// 外设以桩替换：Textures（canvas 2D）/ GLTFLoader（网络）/ document（HUD 白屏节点）
// ============================================================================
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/world/Textures.js', () => ({
  Tex: new Proxy({}, { get: () => () => ({}) }),
}))
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { load() { /* 官方模型不在测试里加载：程序化近似兜底 */ } },
}))
vi.stubGlobal('document', {
  baseURI: 'http://localhost/',
  createElement: () => ({ style: {}, className: '', nextSibling: null }),
})

import * as THREE from 'three'
import { CONFIG } from '../src/core/Config.js'
import { FlashSystem } from '../src/world/FlashSystem.js'

const TYPES = ['kayo', 'skye', 'phoenix', 'yoru', 'breach', 'reyna', 'gecko']
const DT = 1 / CONFIG.sim.tickHz

// 只有地面（y=0）的世界：抛射类会落地弹跳/显形，穿墙类照常到位；视线永远通
const floorWorld = {
  raycast(x, y, z, dx, dy, dz, lim) {
    if (dy >= 0 || y <= 0) return null
    const t = -y / dy
    if (t > lim) return null
    return { t, x: x + dx * t, y: 0, z: z + dz * t, nx: 0, ny: 1, nz: 0 }
  },
  lineOfSight() { return true },
}
// 音频：任何方法可调，移动声源返回可 setPos/stop 的句柄
const voiceStub = { setPos() {}, stop() {}, flapHz: 8.5 }
const audioStub = new Proxy({}, { get: () => () => voiceStub })
// 特效：sparks/puffs 发射器 + _popVisual 用到的枪口焰/vm 染色/冲击环池
function makeFx() {
  const ring = () => ({
    mesh: new THREE.Mesh(new THREE.RingGeometry(0.1, 0.2, 8), new THREE.MeshBasicMaterial({ transparent: true })),
    life: 0, dur: 0, maxScale: 1,
  })
  return { sparks: { emit() {} }, puffs: { emit() {} }, muzzle() {}, vmPopGlow() {}, rings: [ring(), ring()], ringIdx: 0 }
}

function makeSystem() {
  const scene = new THREE.Scene()
  const player = { pos: { x: 0, y: 0, z: -8 }, yaw: 0, pitch: 0, eyeHeight: 1.6 } // 面朝 -Z 的墙与缺口
  const fs = new FlashSystem({
    scene, world: floorWorld, map: { gaps: [{ x0: -1.5, x1: 1.5 }] },
    audio: audioStub, fx: makeFx(), player, hudRoot: { firstChild: null, insertBefore() {} },
  })
  return { fs, scene, player }
}

// 强制投放一类并跑到消失（上限 capSec 游戏秒），返回该类模型是否曾显示
function runLifecycle(fs, type, capSec = 8) {
  fs.setMode(type)
  fs.resetRound(0)
  fs._spawn()
  expect(fs.proj?.type).toBe(type)
  const m = fs._models[type]
  let seenVisible = false
  let t = 0
  while (fs.proj && t < capSec) {
    fs.step(DT)
    fs.renderSync(0.5, DT)
    if (m.group.visible) seenVisible = true
    expect(Number.isFinite(m.group.position.x + m.group.position.y + m.group.position.z)).toBe(true)
    t += DT
  }
  // 消失后再走 1.5s：白屏/近视/等离子渐褪路径也不能抛
  for (let i = 0; i < 1.5 / DT; i++) { fs.step(DT); fs.renderSync(0.5, DT) }
  return { seenVisible, elapsed: t }
}

describe('FlashSystem 七类道具生命周期冒烟', () => {
  for (const type of TYPES) {
    it(`${type}：投放 → 步进/渲染到消失，不抛异常且模型曾显示`, () => {
      const { fs } = makeSystem()
      const r = runLifecycle(fs, type)
      expect(fs.proj).toBeNull()
      expect(r.elapsed).toBeLessThan(8)
      expect(r.seenVisible).toBe(true)
    })
  }

  it('mix 连续投放 20 次（随机类型）全部走完，模型显隐互斥', () => {
    const { fs } = makeSystem()
    for (let i = 0; i < 20; i++) {
      fs.setMode('mix')
      fs.resetRound(0)
      fs._spawn()
      const type = fs.proj.type
      let t = 0
      while (fs.proj && t < 8) {
        fs.step(DT); fs.renderSync(0.5, DT); t += DT
        // 同一时刻只能有当前类型的模型可见（Yoru 飞行中允许全隐）
        for (const [k, m] of Object.entries(fs._models)) {
          if (m.group.visible) expect(k).toBe(type)
        }
      }
      expect(fs.proj).toBeNull()
    }
  })
})

describe('renderSync 类型分支互不串线（第一百二十八轮回归）', () => {
  it('phoenix 走火球分支：光晕随预告缩放，Dizzy 程序化身体保持初始 scale', () => {
    const { fs } = makeSystem()
    fs.setMode('phoenix'); fs.resetRound(0); fs._spawn()
    const halo0 = fs._models.phoenix.halo.scale.x // buildPhoenixOrb 初始 0.42
    // 走到预告进度 ~50%（0.3s / 0.6s windup）
    for (let i = 0; i < Math.round(0.3 / DT); i++) { fs.step(DT); fs.renderSync(0.5, DT) }
    expect(fs.proj?.type).toBe('phoenix')
    expect(fs._models.phoenix.halo.scale.x).not.toBeCloseTo(halo0, 3)
    expect(fs._models.phoenix.mat.emissiveIntensity).toBeGreaterThan(2)
    expect(fs._models.gecko.body.scale.y).toBe(0.92)
  })

  it('gecko 走 Dizzy 分支：程序化回退压身呼吸，火球光晕不动', () => {
    const { fs } = makeSystem()
    fs.setMode('gecko'); fs.resetRound(0); fs._spawn()
    for (let i = 0; i < Math.round(0.9 / DT); i++) { fs.step(DT); fs.renderSync(0.5, DT) }
    expect(fs.proj?.type).toBe('gecko')
    expect(fs._models.gecko.body.scale.y).not.toBe(0.92)
    expect(fs._models.phoenix.halo.scale.x).toBe(0.42)
  })
})
