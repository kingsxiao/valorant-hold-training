// ============================================================================
// FlashSystem 实例级冒烟 + 接线层覆盖：七类闪光/致盲道具各自跑完整生命周期
// （128Hz 步进 + 每步一帧 renderSync），任一类型缺分支/字段错位都会在这里
// 抛出——第一百二十八轮加 Dizzy 时把 renderSync 的 phoenix 动画分支顶掉，火球
// 掉进 Dizzy 分支读 m.body.scale 每帧 TypeError，渲染循环中断（玩家看到的
// "闪退"）；flashMath 纯函数测试对此无感，故补一层实例级回归。
// 在此之上：可控 world/player 桩覆盖「玩家姿态→角度→时长→blindRemaining→
// 白屏渐褪」整条致盲链路与 pickHit/damage 可击毁接口（WeaponSystem 的跨系统
// 依赖）——历史上 128/129 轮两次回归都发生在这一接线层。
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

// 地面（y=0）+ 一面门墙（z=WALL_Z 竖直平面，缺口段留洞）的世界：抛射类会
// 落地弹跳/撞墙显形，穿墙类照常到位。可控开关（致盲链路测试用）：los 可关
// （模拟被墙挡）、losMaxDist 可设（lineOfSight 的生效距离上限）——每套系统
// 独立一份，测试中途可翻转。
// 门墙为何不可省（第一百三十一轮 flaky 根因）：Yoru 的撞面显形分支一半参数
// 瞄「缺口旁的墙前面」（FlashSystem._spawnYoru），无墙世界里这条路径只能靠
// 碎片越墙后落地兜住显形——旧「0.55s 反解」初速低，最晚 1.78s 落地，纯靠
// 低初速巧合成立；F5 接入 29m/s 口径速度后撞墙直射解垂直初速增大，约 14%
// 参数（撞点高者）落地超过 maxAir 2s → _fizzle 消散、全程不可见（20 万次
// 参数扫描证实）。补回门墙后该分支与真实世界一致地在墙面显形——真实几何
// 下碎片 z 向无外力、单调穿越墙平面，且穿越点 x 距缺口边缘 ≥0.26m 必在
// 缺口外，必撞墙。洞宽 = 缺口宽：穿门洞的其余弹道（kayo 弹跳/skye 直线
// 段/phoenix 贝塞尔凸包/地面分支 yoru/gecko 抛物线）x 全程钳在缺口内，不受影响
const GAP = { x0: -1.5, x1: 1.5 }
const WALL_Z = -23.6 // 墙前面（_spawnBreach 贴面基准 z=-23.53 同款）
function makeWorld({ los = true, losMaxDist = Infinity } = {}) {
  return {
    los, losMaxDist,
    raycast(x, y, z, dx, dy, dz, lim) {
      // 门墙：射线与 z=WALL_Z 平面相交、命中点 x 在缺口外 → 撞墙（法线朝来向）
      if (dz !== 0) {
        const tw = (WALL_Z - z) / dz
        if (tw > 0 && tw <= lim) {
          const hx = x + dx * tw
          if (hx < GAP.x0 || hx > GAP.x1) {
            return { t: tw, x: hx, y: y + dy * tw, z: WALL_Z, nx: 0, ny: 0, nz: dz > 0 ? -1 : 1 }
          }
        }
      }
      if (dy >= 0 || y <= 0) return null
      const t = -y / dy
      if (t > lim) return null
      return { t, x: x + dx * t, y: 0, z: z + dz * t, nx: 0, ny: 1, nz: 0 }
    },
    lineOfSight(x1, y1, z1, x2, y2, z2) {
      if (!this.los) return false
      return Math.hypot(x2 - x1, y2 - y1, z2 - z1) <= this.losMaxDist
    },
  }
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

function makeSystem({ los = true, losMaxDist = Infinity, yaw = 0, pitch = 0 } = {}) {
  const scene = new THREE.Scene()
  // 玩家桩：yaw/pitch 可直接转动（致盲链路的姿态输入）；面朝 -Z 的墙与缺口
  const player = { pos: { x: 0, y: 0, z: -8 }, yaw, pitch, eyeHeight: 1.6 }
  const world = makeWorld({ los, losMaxDist })
  const fs = new FlashSystem({
    scene, world, map: { gaps: [GAP] },
    audio: audioStub, fx: makeFx(), player, hudRoot: { firstChild: null, insertBefore() {} },
  })
  return { fs, scene, player, world }
}

// 步进 + 渲染 sec 游戏秒（致盲递减/白屏渐褪断言的时间推进器）
const advance = (fs, sec) => {
  for (let i = 0; i < Math.round(sec / DT); i++) { fs.step(DT); fs.renderSync(0.5, DT) }
}

// 以合成投掷物直接起爆：_pop 是「姿态→角度→时长→blindRemaining」链路的汇聚
// 点，绕开 spawn 随机性后链路本身仍被完整覆盖（_popVisual 只认五类白闪，合成
// 弹体只取 kayo/skye/phoenix/yoru/breach——reyna/gecko 走 _expire/_firePlasma）
const synthPop = (fs, type, pos, maxBlind) =>
  fs._pop({ type, pos: { ...pos }, prevPos: { ...pos } }, maxBlind)

// 标准起爆点：眼位 (0,1.6,-8) 正前方 ~8m（< fullDist 满时长区）、y 略高于眼
const POP = { x: 0, y: 2, z: -16 }

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

describe('出膛首帧 renderSync 安全（第一百二十九轮闪退回归）', () => {
  // 线上触发链复刻：非拖尾类（KAY/O/Yoru/Breach）飞行期 _trailAt 只增不清，
  // 长会话累积到数百；下一颗若是火男，出膛帧 renderSync 的拖尾分支在首个
  // _stepProj 之前就读 p.vel.x → TypeError 每帧中断渲染循环（玩家看到的"闪退"）
  it('_spawn 归零 _trailAt + phoenix 出膛即带 vel：armed 拖尾下首帧渲染不抛', () => {
    const { fs } = makeSystem()
    fs.setMode('yoru'); fs.resetRound(0); fs._spawn()
    for (let i = 0; i < Math.round(1.5 / DT); i++) fs.step(DT) // 只步进不渲染：出膛前拖尾节拍不被清
    fs._despawn()
    fs.setMode('phoenix'); fs._spawn()
    expect(fs._trailAt).toBe(0) // 出膛即归零：首帧不越过发射阈值
    expect(fs.proj.vel).toBeDefined()
    fs._trailAt = 0.05 // 直接武装阈值：即便归零失效/2 帧后正常发射，vel 已存在不得抛
    expect(() => fs.renderSync(0.5, DT)).not.toThrow()
  })

  it('读 vel 的弹体（kayo/skye/phoenix/yoru/gecko）出膛时速度三分量都是有限数', () => {
    const { fs } = makeSystem()
    for (const type of ['kayo', 'skye', 'phoenix', 'yoru', 'gecko']) {
      fs.setMode(type); fs.resetRound(0); fs._spawn()
      const v = fs.proj.vel
      expect(Number.isFinite(v.x + v.y + v.z)).toBe(true)
      fs._despawn()
    }
  })
})

// ============================================================================
// 致盲链路（F6 接线层覆盖）：玩家姿态 → 角度 → 时长 → blindRemaining → 白屏曲线。
// 128/129 轮两次回归都发生在这一层（renderSync/字段接线），此前冒烟桩的
// lineOfSight 恒 true、yaw 恒 0，链路在系统集成层零覆盖
// ============================================================================
describe('致盲判定链路：姿态/LOS/距离 → blindRemaining', () => {
  it('正对起爆点（yaw=0）→ 满时长致盲', () => {
    const { fs } = makeSystem()
    synthPop(fs, 'breach', POP, CONFIG.flash.breach.maxBlind)
    expect(fs.blindRemaining).toBeCloseTo(CONFIG.flash.breach.maxBlind, 3)
    expect(fs.blindTotal).toBeCloseTo(CONFIG.flash.breach.maxBlind, 6)
  })

  it('背对起爆点（yaw=π）→ backFactor 比例（<0.5×）', () => {
    const { fs } = makeSystem({ yaw: Math.PI })
    synthPop(fs, 'breach', POP, CONFIG.flash.breach.maxBlind)
    expect(fs.blindRemaining).toBeCloseTo(CONFIG.flash.breach.maxBlind * CONFIG.flash.backFactor, 3)
    expect(fs.blindRemaining).toBeLessThan(0.5 * CONFIG.flash.breach.maxBlind)
  })

  it('视线被墙挡（world.los=false）→ 不致盲', () => {
    const { fs, world } = makeSystem()
    world.los = false // 测试中途翻转：同一桩上开/关对比
    synthPop(fs, 'kayo', POP, CONFIG.flash.kayo.maxBlind)
    expect(fs.blindRemaining).toBe(0)
    expect(fs.blindUntil).toBe(-1)
  })

  it('起爆点超出 LOS 生效距离（losMaxDist）→ 不致盲', () => {
    const { fs } = makeSystem({ losMaxDist: 5 }) // 起爆点距眼 ~8m，超出 5m
    synthPop(fs, 'kayo', POP, CONFIG.flash.kayo.maxBlind)
    expect(fs.blindRemaining).toBe(0)
  })

  it('起爆后随步进按 dur 线性递减，到期归零', () => {
    const { fs } = makeSystem()
    synthPop(fs, 'kayo', POP, CONFIG.flash.kayo.maxBlind)
    const r0 = fs.blindRemaining
    advance(fs, 0.5)
    expect(fs.blindRemaining).toBeCloseTo(r0 - 0.5, 2)
    advance(fs, 1.8) // 共 2.3s > 2.25s → 过期归零
    expect(fs.blindRemaining).toBe(0)
  })

  it('breach 全链路：spawn → 0.5s 预备 → 固定点起爆 → 正对满致盲', () => {
    const { fs } = makeSystem()
    fs.setMode('breach'); fs.resetRound(0); fs._spawn()
    fs.proj.pos = { ...POP } // 固定起爆点（默认 z=-23.53 贴墙，移近便于断言）
    let t = 0
    while (fs.proj && t < 3) { fs.step(DT); t += DT }
    expect(fs.blindTotal).toBeCloseTo(CONFIG.flash.breach.maxBlind, 3)
    expect(fs.blindRemaining).toBeGreaterThan(2.2) // 起爆步内剩余 ≈ 满时长
  })
})

describe('白屏曲线：0.06s 拉满 → 致盲期不透明 → 到期 1s 线性渐褪 → 归零', () => {
  it('renderSync 的 overlayEl 透明度按 CONFIG.flash.fadeTime 渐褪并复位', () => {
    const { fs } = makeSystem()
    synthPop(fs, 'kayo', POP, CONFIG.flash.kayo.maxBlind) // 2.25s
    advance(fs, 0.1) // 过 0.06s 快速淡入 → 全白
    expect(fs.overlayEl.style.opacity).toBe('1.000')
    advance(fs, 2.2) // 致盲期内（t≈2.3，blindUntil=2.25 刚过期 0.05s）→ 仍接近全白
    const early = Number(fs.overlayEl.style.opacity)
    expect(early).toBeGreaterThan(0.9)
    expect(early).toBeLessThanOrEqual(1)
    advance(fs, 0.5) // 渐褪中段（过期 ~0.55s / fadeTime 1s）
    const mid = Number(fs.overlayEl.style.opacity)
    expect(mid).toBeGreaterThan(0.3)
    expect(mid).toBeLessThan(0.7)
    advance(fs, 0.6) // fadeTime 走完 → 归零 + blindUntil 复位
    expect(fs.overlayEl.style.opacity).toBe('0.000')
    expect(fs.blindUntil).toBe(-1)
    expect(fs.blindRemaining).toBe(0)
  })
})

// F3：叠加口径按「不缩短」的保守 max 处理——这是未验证的口径假设（Valorant
// 无公开叠加/刷新规则，社区共识仅「时长不叠加」），本组用例锁的是防回归
// 而非外部事实，口径待真机核实后如有出入应连同 src/world/FlashSystem.js 的
// _pop 注释与 README 已知边界一并改
describe('致盲叠加（口径假设：不缩短、更强刷新，待真机核实）', () => {
  it('【假设性用例】剩余 ~1.25s 时吃到背闪 0.12s：剩余不被截短', () => {
    const { fs, player } = makeSystem()
    synthPop(fs, 'kayo', POP, CONFIG.flash.kayo.maxBlind) // 正对 2.25s
    advance(fs, 1.0)
    player.yaw = Math.PI // 转身后背对起爆点
    synthPop(fs, 'yoru', POP, CONFIG.flash.yoru.maxBlind) // 背闪 1.5×0.08 = 0.12s
    expect(fs.blindRemaining).toBeCloseTo(CONFIG.flash.kayo.maxBlind - 1.0, 2) // 1.25s，而非 0.12s
    expect(fs.blindTotal).toBeCloseTo(CONFIG.flash.yoru.maxBlind * CONFIG.flash.backFactor, 3) // 诊断值 = 最近一次时长
  })

  it('【假设性用例】剩余不足时更强的闪整体刷新到新时长（非累加）', () => {
    const { fs } = makeSystem()
    synthPop(fs, 'yoru', POP, CONFIG.flash.yoru.maxBlind) // 1.5s
    advance(fs, 1.4) // 剩余 0.1s
    synthPop(fs, 'kayo', POP, CONFIG.flash.kayo.maxBlind) // 正对 2.25s
    expect(fs.blindRemaining).toBeCloseTo(CONFIG.flash.kayo.maxBlind, 2) // 刷新到 2.25s，而非 0.35s
  })
})

// ============================================================================
// F5：出手速度口径接入弹道解算——运行时初速行为断言（替代「锁死 CONFIG 字段
// 却零引用」的旧断言角色；口径数值本身仍由 tests/flash.test.js 锁维基确认值）
// ============================================================================
describe('出手速度约束（ballisticShot 解算后的运行时初速）', () => {
  for (const [type, spec] of [
    ['kayo', CONFIG.flash.kayo.speed],
    ['skye', CONFIG.flash.skye.speed],
    ['phoenix', CONFIG.flash.phoenix.speed],
    ['yoru', CONFIG.flash.yoru.speed],
    ['gecko', CONFIG.flash.gecko.speed],
  ]) {
    it(`${type} 出膛初速模长 = 口径 ${spec}m/s（不再由飞行时长反解）`, () => {
      const { fs } = makeSystem()
      fs.setMode(type); fs.resetRound(0); fs._spawn()
      const v = fs.proj.vel
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(spec, 1)
      fs._despawn()
    })
  }
})

describe('KAY/O 弹道重解（18m/s 口径 + 拍地弹跳 pop flash）', () => {
  it('门后拍地（~0.3s）→ 首跳 0.8s 引信 → 玩家侧低位起爆（1.0~1.3s）且致盲', () => {
    const { fs } = makeSystem()
    fs.setMode('kayo'); fs.resetRound(0); fs._spawn()
    let lastPos = null, t = 0, bouncedAt = -1
    while (fs.proj && t < 5) {
      fs.step(DT); t += DT
      if (fs.proj) {
        if (bouncedAt < 0 && fs.proj.bounced) bouncedAt = t
        lastPos = { ...fs.proj.pos }
      }
    }
    expect(bouncedAt).toBeGreaterThan(0.15) // 拍地在门后地面（直射 ~0.24-0.34s 到落点）
    expect(bouncedAt).toBeLessThan(0.45)
    expect(t).toBeGreaterThan(1.0) // 首跳 + 0.8s 引信 ≈ 1.05-1.15s 起爆
    expect(t).toBeLessThan(1.3)
    expect(lastPos.z).toBeGreaterThan(-23.2) // 起爆点已在门墙（z∈[-24.8,-23.2]）玩家侧
    expect(lastPos.z).toBeLessThan(-10) // 且未越过玩家（z=-8）
    expect(fs.blindTotal).toBeGreaterThan(2) // 正对 ~8-10m：满时长 2.25s
  })
})

// ============================================================================
// 可击毁道具（Reyna 眼 / Dizzy）：射线-球命中与伤害结算——WeaponSystem.js 的
// 跨系统接口（pickHit 夹入最近命中、damage 按武器伤害结算），「射掉闪光」
// 练点的核心交互，此前零用例
// ============================================================================
describe('可击毁道具：pickHit 射线-球命中边界', () => {
  const EYE = { x: 0, y: 1.6, z: -8 }
  const DIR = { x: 0, y: 0, z: -1 } // 玩家面朝 -Z
  const mkReyna = (fs, pos, extra = {}) => {
    fs.proj = {
      type: 'reyna', pos: { ...pos }, prevPos: { ...pos }, t: 0,
      phase: 'active', hp: CONFIG.flash.reyna.hp, ...extra,
    }
  }

  it('到位（active）的眼在射线上 → 命中 {t:距离}', () => {
    const { fs } = makeSystem()
    mkReyna(fs, { x: 0, y: 1.6, z: -14 }) // 正前方 6m
    expect(fs.pickHit(EYE, DIR, 10)).toEqual({ t: 6 })
  })

  it('道具在身后（t<0）/超出 lim /球心垂距超半径 → 不中', () => {
    const { fs } = makeSystem()
    mkReyna(fs, { x: 0, y: 1.6, z: -2 }) // 身后 6m
    expect(fs.pickHit(EYE, DIR, 10)).toBeNull()
    mkReyna(fs, { x: 0, y: 1.6, z: -14 })
    expect(fs.pickHit(EYE, DIR, 3)).toBeNull() // lim=3 < t=6
    mkReyna(fs, { x: 2, y: 1.6, z: -14 }) // 垂距 2m ≫ 半径 0.32
    expect(fs.pickHit(EYE, DIR, 10)).toBeNull()
  })

  it('只认到位后的目标：reyna 飞行段 / dizzy 未悬停（或已喷等离子）→ null', () => {
    const { fs } = makeSystem()
    mkReyna(fs, { x: 0, y: 1.6, z: -14 }, { phase: 'fly' })
    expect(fs.pickHit(EYE, DIR, 10)).toBeNull()
    fs.proj = { type: 'gecko', pos: { x: 0, y: 1.6, z: -14 }, prevPos: { x: 0, y: 1.6, z: -14 }, slowed: false, fired: false }
    expect(fs.pickHit(EYE, DIR, 10)).toBeNull()
    fs.proj = { type: 'gecko', pos: { x: 0, y: 1.6, z: -14 }, prevPos: { x: 0, y: 1.6, z: -14 }, slowed: true, fired: true }
    expect(fs.pickHit(EYE, DIR, 10)).toBeNull()
    fs.proj = { type: 'gecko', pos: { x: 0, y: 1.6, z: -14 }, prevPos: { x: 0, y: 1.6, z: -14 }, slowed: true, fired: false }
    expect(fs.pickHit(EYE, DIR, 10)).toEqual({ t: 6 })
  })

  it('场上无可击毁目标（无投掷物 / 非可击毁类型）→ null', () => {
    const { fs } = makeSystem()
    expect(fs.pickHit(EYE, DIR, 10)).toBeNull()
    fs.proj = { type: 'kayo', pos: { x: 0, y: 1.6, z: -14 }, prevPos: { x: 0, y: 1.6, z: -14 }, vel: { x: 0, y: 0, z: 0 } }
    expect(fs.pickHit(EYE, DIR, 10)).toBeNull()
  })
})

describe('可击毁道具：damage 伤害结算与击毁无效化', () => {
  const EYE = { x: 0, y: 1.6, z: -8 }
  const DIR = { x: 0, y: 0, z: -1 }

  it('命中减 hp 不消失；hp≤0 → _despawn + onPopped(false)，后续 pickHit 落空', () => {
    const { fs } = makeSystem()
    const popped = []
    fs.onPopped = (blinded) => popped.push(blinded)
    fs.proj = {
      type: 'reyna', pos: { x: 0, y: 1.6, z: -14 }, prevPos: { x: 0, y: 1.6, z: -14 },
      t: 0, phase: 'active', hp: CONFIG.flash.reyna.hp,
    }
    expect(fs.pickHit(EYE, DIR, 10)).toEqual({ t: 6 })
    fs.damage(40)
    expect(fs.proj.hp).toBe(CONFIG.flash.reyna.hp - 40) // 命中减血
    expect(popped).toEqual([]) // 未击毁不回调
    fs.damage(CONFIG.flash.reyna.hp - 40) // 打空剩余 hp
    expect(fs.proj).toBeNull() // _despawn
    expect(popped).toEqual([false]) // 无效化回调（无致盲）
    expect(fs.pickHit(EYE, DIR, 10)).toBeNull()
  })

  it('非可击毁类型 / 无投掷物：damage 无操作', () => {
    const { fs } = makeSystem()
    fs.proj = { type: 'kayo', pos: { x: 0, y: 1.6, z: -14 }, prevPos: { x: 0, y: 1.6, z: -14 }, vel: { x: 0, y: 0, z: 0 } }
    fs.damage(999)
    expect(fs.proj.type).toBe('kayo') // 手雷不可击毁
    fs.proj = null
    expect(() => fs.damage(999)).not.toThrow()
  })
})
