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

describe('扫射会话弹道表缓存（水平逐次随机化的机制侧）', () => {
  // 随机性本身的数值锁在 config.test.js（rng 注入）；这里锁 WeaponSystem 的缓存
  // 会话语义：同一次扫射沿用同一随机序列，停火/切枪归零后才重掷
  it('连发沿用同一会话表；sprayIndex 归零（停火/切枪路径）后下一发重掷新表', () => {
    const w = makeWeapons(mkPlayer())
    w._fireOne()
    const session = w.patterns.vandal
    w._fireOne()
    w._fireOne()
    expect(w.patterns.vandal).toBe(session) // 会话内不重掷（同一 dir/amp 贯穿本次扫射）
    w.sprayIndex = 0 // 停火超 recoverTime / 切枪的归零路径
    w._fireOne()
    expect(w.patterns.vandal).not.toBe(session) // 新会话重掷（dir/amp 重抽）
  })
})

describe('Classic 右键三连发（Alt Fire：近同帧霰弹式扇出 + 组间冷却）', () => {
  const mkClassic = () => { const p = mkPlayer(); const w = makeWeapons(p); w.switchTo('classic', true); return { p, w } }

  it('altEdge 同帧击发 3 发（全走 alt 支线）；组后冷却 0.45s；冷却内再按不发', () => {
    const { w } = mkClassic()
    const fired = []
    vi.spyOn(w, '_fireOne').mockImplementation((alt) => fired.push(!!alt))
    w.tryFire(false, false, true)
    expect(fired).toEqual([true, true, true]) // 三发同帧、全走 alt 支线
    expect(w.nextShotAt).toBeCloseTo(w.now + 0.45, 9) // 组间冷却（非逐发射速间隔）
    const n = fired.length
    w.tryFire(false, false, true) // 冷却内再按：不发
    expect(fired).toHaveLength(n)
    w.now += 0.45
    w.tryFire(false, false, true)
    expect(fired).toHaveLength(n + 3) // 冷却过：新一组
  })

  it('burst 不推进 sprayIndex、不消费左键弹道表；左键路径不受影响', () => {
    const { w } = mkClassic()
    w.tryFire(false, false, true) // 一组 burst
    expect(w.sprayIndex).toBe(0) // burst 非「扫射」：连射计数不动
    expect(w.patterns?.classic).toBeUndefined() // 霰弹式不走 climb 表（_patternAt 未被调）
    w.now += 0.45 // burst 组间冷却同锁左键（游戏语义：burst 后有恢复），过冷却再按左键
    w.tryFire(true, false, false) // 左键单发照常
    expect(w.sprayIndex).toBe(1)
    expect(w.patterns.classic).toBeDefined() // 左键路径弹道表照常生成
  })

  it('_altSpread 口径：站 1.9°/蹲 ×0.9；移动/跳跃惩罚不放宽（取 max）', () => {
    const { p, w } = mkClassic() // currentSpread 走 this.weapon：必须真在 classic 上
    const classic = CONFIG.weapons.classic
    expect(w._altSpread(classic)).toBeCloseTo(1.9, 9) // 站定 = 维基首发散布
    p.crouchAmt = 1
    expect(w._altSpread(classic)).toBeCloseTo(1.9 * 0.9, 9) // 蹲 ×0.9
    p.crouchAmt = 0
    p.moveSpeed = CONFIG.movement.runSpeed * classic.moveSpeedMult // 全速跑：左键口径 2.7 > 1.9
    expect(w._altSpread(classic)).toBeCloseTo(classic.spread.run, 9)
    p.moveSpeed = 0
    p.grounded = false // 跳跃全额 jump 散布
    expect(w._altSpread(classic)).toBeCloseTo(classic.spread.jump, 9)
  })
})

describe('刀 Alt Fire 与背刺 ×2（knife-alt-backstab）', () => {
  // Bot 桩：pos/mesh.rotation.y/mixer 三元决定背刺 dot（朝向轴符号与 startDeath 同口径）
  function mkKnife(botYaw, { mixer = null } = {}) {
    const p = mkPlayer()
    const w = makeWeapons(p)
    w.switchTo('knife', true)
    const hits = []
    const dmgLog = []
    const bot = { pos: { x: 0, y: 0, z: -1 }, mesh: { rotation: { y: botYaw } }, mixer }
    w.bots = {
      pickHit: (eye, dir, maxDist) => { hits.push(maxDist); return { bot, zone: 'body', t: 1, point: { x: 0, y: 1, z: -1 } } },
      damage: (b, dmg, zone) => { dmgLog.push(dmg); return false },
    }
    return { p, w, hits, dmgLog, bot }
  }

  it('左键正面 50 / 背刺 ×2 = 100（dot ≤ 0 判背，朝向轴符号随 mixer 有无切换）', () => {
    const front = mkKnife(Math.PI) // GLB 桩 mixer=null → f=-1：yaw=π 时正面朝玩家
    front.w.tryFire(true, false, false)
    expect(front.dmgLog).toEqual([50])
    const back = mkKnife(0) // 背对玩家
    back.w.tryFire(true, false, false)
    expect(back.dmgLog).toEqual([100]) // 50 × backstabMult
    // 官方 GLB（mixer 在场 → f=+1）：同 yaw 语义翻转
    const glbFront = mkKnife(0, { mixer: {} })
    glbFront.w.tryFire(true, false, false)
    expect(glbFront.dmgLog).toEqual([50])
  })

  it('右键重刺：正面 75 / 背刺 150；射速间隔 2s（1/0.5）且范围收窄 1.9→1.7', () => {
    const { w, hits, dmgLog } = mkKnife(Math.PI)
    w.tryFire(false, false, true) // Alt Fire
    expect(dmgLog).toEqual([75])
    expect(w.nextShotAt - w.now).toBeCloseTo(1 / CONFIG.weapons.knife.alt.fireRate, 9)
    expect(hits[0]).toBe(1.7) // alt 范围
    w.now = w.nextShotAt
    w.tryFire(true, false, false) // 左键回到主档
    expect(dmgLog).toEqual([75, 50])
    expect(hits[1]).toBe(1.9)
    expect(w.nextShotAt - w.now).toBeCloseTo(1 / CONFIG.weapons.knife.fireRate, 9)
    const back = mkKnife(0)
    back.w.tryFire(false, false, true)
    expect(back.dmgLog).toEqual([150]) // 75 × backstabMult
  })

  it('重刺恢复期内左键同锁 nextShotAt（共享冷却）；冷却过左键射速 1/1.33', () => {
    const { w, dmgLog } = mkKnife(Math.PI)
    w.tryFire(false, false, true)
    const locked = w.nextShotAt
    w.tryFire(true, false, false) // 恢复期内左键：不发（log 仍只有重刺那一发）
    expect(dmgLog).toEqual([75])
    expect(w.nextShotAt).toBe(locked)
    w.now = locked
    w.tryFire(true, false, false)
    expect(w.nextShotAt - w.now).toBeCloseTo(1 / CONFIG.weapons.knife.fireRate, 9)
  })
})
