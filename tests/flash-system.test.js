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
// 屏效元素桩：style 除直写属性外还要支持 CSS 自定义属性（--plasma-hole 扩边
// 曲线走 setProperty/getPropertyValue）
const makeHudEl = () => {
  const vars = {}
  return {
    style: {
      setProperty: (k, v) => { vars[k] = v },
      getPropertyValue: (k) => vars[k] ?? '',
    },
    className: '', nextSibling: null,
  }
}
vi.stubGlobal('document', {
  baseURI: 'http://localhost/',
  createElement: makeHudEl,
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
// 特效：sparks/puffs 发射器（记录发射供粒子断言）+ _popVisual 用的枪口焰/vm 染色/冲击环池
function makeFx() {
  const emits = [] // [x, y, z, vx, vy, vz, opts]
  const ring = () => ({
    mesh: new THREE.Mesh(new THREE.RingGeometry(0.1, 0.2, 8), new THREE.MeshBasicMaterial({ transparent: true })),
    life: 0, dur: 0, maxScale: 1,
  })
  return {
    emits,
    sparks: { emit: (...a) => emits.push(a) },
    puffs: { emit: (...a) => emits.push(a) },
    muzzle() {}, vmPopGlow() {}, rings: [ring(), ring()], ringIdx: 0,
  }
}

function makeSystem({ los = true, losMaxDist = Infinity, yaw = 0, pitch = 0 } = {}) {
  const scene = new THREE.Scene()
  // 玩家桩：yaw/pitch 可直接转动（致盲链路的姿态输入）；面朝 -Z 的墙与缺口
  const player = { pos: { x: 0, y: 0, z: -8 }, yaw, pitch, eyeHeight: 1.6 }
  const world = makeWorld({ los, losMaxDist })
  const fx = makeFx()
  const fs = new FlashSystem({
    scene, world, map: { gaps: [GAP] },
    audio: audioStub, fx, player, hudRoot: { firstChild: null, insertBefore() {} },
  })
  return { fs, scene, player, world, fx }
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

  it('breach 全链路：spawn → 24m/s 飞行 → 0.5s 预备 → 固定点起爆 → 正对满致盲', () => {
    const { fs } = makeSystem()
    fs.setMode('breach'); fs.resetRound(0); fs._spawn()
    fs.proj.place = { ...POP } // 固定放置点（默认贴墙 z=-23.13，移近便于断言）
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
      fs.setMode(type); fs.resetRound(0)
      // kayo 固定走主投分支（0.9 > altChance 0.4）——副投 6.3m/s 口径另测。
      // spy 在 resetRound 之后装：mock 序列恰好对齐 _spawn 的 Math.random 消费
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9)
      fs._spawn()
      spy.mockRestore()
      const v = fs.proj.vel
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(spec, 1)
      fs._despawn()
    })
  }
})

// KAY/O 主投/副投的 Math.random 消费顺序见 _spawnKayo 注释：
// 1) 副投 roll → 2) lane → 3) 变体 roll（<0.5 拍地弹跳 / <0.8 深落点长引信 /
// 其余全引信空爆）→ 4) 变体参数。用例按此序列 mock，逐变体钉住官方节奏
describe('KAY/O 主投变体①：拍地弹跳 pop flash（18m/s 口径）', () => {
  it('门后拍地（~0.3s）→ 首跳 0.8s 引信 → 玩家侧低位起爆（1.0~1.3s）且致盲', () => {
    const { fs } = makeSystem()
    fs.setMode('kayo'); fs.resetRound(0)
    // spy 在 resetRound 之后装：mock 序列恰好对齐 _spawnKayo 的消费顺序
    //（1 副投 roll → 2 lane → 3 变体 → 4+ 落点参数，见 _spawnKayo 注释）
    const spy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.9) // 主投（> altChance）
      .mockReturnValueOnce(0.5) // lane 居中
      .mockReturnValueOnce(0.2) // 变体①：拍地弹跳
      .mockReturnValueOnce(0.5).mockReturnValueOnce(0.5) // 落点参数
    fs._spawn()
    spy.mockRestore()
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

describe('KAY/O 主投变体②③（W7：长引信/空中爆节奏）', () => {
  it('② 深落点长引信：玩家侧 ~0.75s 首跳，剩余 0.85s 被 v10.06 钳到 0.8 → ~1.55s 起爆', () => {
    const { fs } = makeSystem()
    fs.setMode('kayo'); fs.resetRound(0)
    const spy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.9) // 主投
      .mockReturnValueOnce(0.5) // lane
      .mockReturnValueOnce(0.6) // 变体②：深落点长引信
      .mockReturnValueOnce(0.5).mockReturnValueOnce(0.5)
    fs._spawn()
    spy.mockRestore()
    let t = 0, bouncedAt = -1
    while (fs.proj && t < 5) {
      fs.step(DT); t += DT
      if (fs.proj && bouncedAt < 0 && fs.proj.bounced) bouncedAt = t
    }
    expect(bouncedAt).toBeGreaterThan(0.6) // 玩家侧深落点（直射 ~0.7s）
    expect(bouncedAt).toBeLessThan(0.9)
    expect(t - bouncedAt).toBeCloseTo(CONFIG.flash.kayo.bounceFuse, 1) // 剩余 >0.8 → 钳到 0.8s
    expect(t).toBeGreaterThan(1.35) // 总节奏 ~1.55s：本图可达的最长主投引信
    expect(t).toBeLessThan(1.6)
  })

  it('③ 全引信空爆：1.6s 全程不弹跳、空中起爆（爆点悬空 ~3.4m）', () => {
    const { fs } = makeSystem()
    fs.setMode('kayo'); fs.resetRound(0)
    const spy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.9) // 主投
      .mockReturnValueOnce(0.5) // lane
      .mockReturnValueOnce(0.95) // 变体③：全引信空爆
      .mockReturnValueOnce(0.5) // vy
    fs._spawn()
    spy.mockRestore()
    let lastPos = null, t = 0, bouncedAt = -1
    while (fs.proj && t < 5) {
      fs.step(DT); t += DT
      if (fs.proj) {
        if (bouncedAt < 0 && fs.proj.bounced) bouncedAt = t
        lastPos = { ...fs.proj.pos }
      }
    }
    expect(bouncedAt).toBe(-1) // 全程不弹跳
    expect(t).toBeGreaterThanOrEqual(1.55) // 总引信 1.6s 走满（空中起爆）
    expect(t).toBeLessThan(1.7)
    expect(lastPos.y).toBeGreaterThan(2.5) // 悬空爆点（非拍地低位）
    expect(lastPos.y).toBeLessThan(4.5)
    // 场地几何注记（CONFIG.flash.kayo 注释）：18m/s×1.6s≈28.8m 弹道程长下，
    // 本图不弹跳的 1.6s 起爆点只能落在架枪位身后——威胁性由变体①②承担
    expect(lastPos.z).toBeGreaterThan(-10)
  })
})

describe('KAY/O 副投下手短抛（W1：Class 0.7——6.3m/s、总引信 1s、致盲 2.25s）', () => {
  it('副投分支：口径速度 6.3m/s、引信 1s、贴门短抛 ~1.0s 起爆且满致盲', () => {
    const { fs } = makeSystem()
    fs.setMode('kayo'); fs.resetRound(0)
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2) // < altChance 0.4 → 副投
    fs._spawn()
    spy.mockRestore()
    const p = fs.proj
    expect(p.alt).toBe(true)
    expect(p.fuse).toBe(CONFIG.flash.kayo.alt.fuse) // 总引信 1s
    expect(p.telegraph).toBe(CONFIG.flash.kayo.alt.telegraph) // 0.3s（v3.06）
    expect(Math.hypot(p.vel.x, p.vel.y, p.vel.z)).toBeCloseTo(CONFIG.flash.kayo.alt.speed, 1) // 6.3m/s
    let lastPos = null, t = 0, bouncedAt = -1
    while (fs.proj && t < 3) {
      fs.step(DT); t += DT
      if (fs.proj) {
        if (bouncedAt < 0 && fs.proj.bounced) bouncedAt = t
        lastPos = { ...fs.proj.pos }
      }
    }
    expect(bouncedAt).toBeGreaterThan(0.35) // ~0.5s 短弧飞行后贴门落地
    expect(bouncedAt).toBeLessThan(0.7)
    expect(t).toBeGreaterThan(0.85) // 首跳后按剩余引信（~0.5s < 0.8 不再钳）快速起爆
    expect(t).toBeLessThan(1.15)
    expect(lastPos.z).toBeGreaterThan(-23.2) // 落在门墙玩家侧（贴门短抛）
    expect(fs.blindTotal).toBeCloseTo(CONFIG.flash.kayo.alt.maxBlind, 6) // 2.25s（v11.08 副投同值）
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

// ============================================================================
// 第一轮对齐批（W2-W5 / W8-W12）：动画/视觉/世界空间口径的实例级回归——
// 每条用例把官方数值或表现曲线钉进断言，口径出处见 CONFIG.flash 各段注释
// ============================================================================
describe('Breach charge 飞行动画（W4：v12.00，2400uu/s = 24m/s）', () => {
  it('出手→挂墙存在 ~dist/24s 飞行时延：直线飞行、到位即停、随后 0.5s 预备', () => {
    const { fs } = makeSystem()
    fs.setMode('breach'); fs.resetRound(0); fs._spawn()
    const p = fs.proj
    expect(p.phase).toBe('fly')
    expect(Math.hypot(p.vel.x, p.vel.y, p.vel.z)).toBeCloseTo(CONFIG.flash.breach.speed, 1) // 24m/s
    const startZ = p.pos.z
    advance(fs, 0.15) // 飞行中：24m/s × 0.15s ≈ 3.6m 位移（朝 +Z 飞向墙）
    expect(fs.proj.phase).toBe('fly')
    expect(fs.proj.pos.z - startZ).toBeGreaterThan(3.3)
    const flyT = fs.proj.flyT
    expect(flyT).toBeGreaterThan(0.25) // 本体（z≈-30.5）→ 墙面 ~7.4m
    expect(flyT).toBeLessThan(0.4)
    // 到位即停（snap 到放置点、贴墙玩家侧），0.5s 预备后起爆
    let sawSet = false, popT = -1, t = 0.15
    while (fs.proj && t < 3) {
      fs.step(DT); t += DT
      if (fs.proj && fs.proj.phase === 'set') {
        if (!sawSet) {
          sawSet = true
          expect(fs.proj.pos.z).toBe(fs.proj.place.z) // snap 无过冲
          expect(fs.proj.pos.z).toBeGreaterThan(-23.2) // 门墙玩家侧
        }
      }
      if (!fs.proj && popT < 0) popT = t
    }
    expect(sawSet).toBe(true)
    expect(popT - flyT).toBeCloseTo(CONFIG.flash.breach.windup, 1) // 到位后恰好 0.5s 预备
    expect(fs.blindTotal).toBeCloseTo(CONFIG.flash.breach.maxBlind, 3)
  })
})

describe('Dizzy 弹速与急停悬停（W5：v7.12 弹速 7000→10000uu/s ≈ 100m/s）', () => {
  it('飞行段 ~0.1s 级：到位即急停（snap 到悬停点、速度清零），活跃窗仍从 0.65s 起算', () => {
    const { fs } = makeSystem()
    fs.setMode('gecko'); fs.resetRound(0); fs._spawn()
    const p = fs.proj
    const flyT = p.flyT
    expect(flyT).toBeGreaterThan(0.05) // ~10.5m ÷ 100m/s ≈ 0.105s
    expect(flyT).toBeLessThan(0.2)
    advance(fs, 0.3)
    expect(fs.proj.slowed).toBe(true) // 急停远早于 0.65s 激活点（旧 18m/s 时两者糊在一起）
    expect(fs.proj.pos.x).toBeCloseTo(fs.proj.hover.x, 6)
    expect(fs.proj.pos.y).toBeCloseTo(fs.proj.hover.y, 6)
    expect(fs.proj.pos.z).toBeCloseTo(fs.proj.hover.z, 6)
    expect(Math.hypot(fs.proj.vel.x, fs.proj.vel.y, fs.proj.vel.z)).toBe(0)
    advance(fs, 0.4) // t≈0.7 > 0.65：活跃窗已开，正对 LOS → 锁定进行中
    expect(fs.proj.acquire).toBeGreaterThan(0)
  })
})

describe('Dizzy 充能 telegraph 分母（W9：发光峰值与 0.65s 悬停/锁定起点对齐）', () => {
  it('t=0.453s → tele≈0.56；t=0.656s → 恰好收满（0.2s 起亮提前量不计入分母）', () => {
    const { fs } = makeSystem()
    fs.setMode('gecko'); fs.resetRound(0); fs._spawn()
    const G = CONFIG.flash.gecko
    const n1 = Math.round(0.45 / DT)
    for (let i = 0; i < n1; i++) { fs.step(DT); fs.renderSync(0.5, DT) }
    const tele1 = (n1 * DT - G.glowLead) / (G.activationWindup - G.glowLead)
    expect(fs._models.gecko.light.intensity).toBeCloseTo(0.9 + tele1 * 2, 6) // 0.9 + tele×2
    const n2 = Math.ceil(G.activationWindup / DT) // 84 步 = 0.65625s ≥ 0.65
    for (let i = n1; i < n2; i++) { fs.step(DT); fs.renderSync(0.5, DT) }
    expect(fs._models.gecko.light.intensity).toBeCloseTo(2.9, 6) // 0.9 + 1×2：峰值收满
  })
})

describe('Skye 激活点定格起爆（W8：v3.06 activation windup 0.3s）', () => {
  it('arm 期原地定格零漂移、拖尾收停、0.3s 后在激活点原地起爆', () => {
    const { fs, fx } = makeSystem()
    fs.setMode('skye'); fs.resetRound(0); fs._spawn()
    const p = fs.proj
    // 置于充能满 + 贴脸（dEye < popDist）状态：下一步即激活
    p.pos = { x: 0, y: 1.8, z: -11 }; p.prevPos = { ...p.pos }
    p.vel = { x: 0, y: 0, z: 18 }
    p.flight = CONFIG.flash.skye.chargeTime
    fs.step(DT)
    expect(p.phase).toBe('arm')
    expect(Math.hypot(p.vel.x, p.vel.y, p.vel.z)).toBe(0) // 定格：速度清零
    const frozen = { ...p.pos }
    const emitsBefore = fx.emits.length
    advance(fs, 0.25)
    expect(p.pos.x).toBe(frozen.x) // 0.25s 内零漂移（旧 e^(-5t) 衰减位移满速时 ~2.8m）
    expect(p.pos.y).toBe(frozen.y)
    expect(p.pos.z).toBe(frozen.z)
    expect(fx.emits.length).toBe(emitsBefore) // 拖尾收停：定格期零粒子发射
    // 0.3s windup 走满 → 在定格点原地起爆
    let popPos = null
    const origPop = fs._pop.bind(fs)
    fs._pop = (pp, mb) => { popPos = { ...pp.pos }; origPop(pp, mb) }
    while (fs.proj) fs.step(DT)
    expect(popPos.x).toBeCloseTo(frozen.x, 6)
    expect(popPos.y).toBeCloseTo(frozen.y, 6)
    expect(popPos.z).toBeCloseTo(frozen.z, 6)
    expect(fs.blindTotal).toBeCloseTo(CONFIG.flash.skye.maxBlind, 3) // 充能满 2.25s
  })
})

describe('Skye/Dizzy 官方模型充能发光重定向（W2：GLB 就位后不再写死对象）', () => {
  it('_mountOfficial 后发光目标切到官方材质 + 容器点光；充能转橙/arm 渐亮/收摊复位全链路', () => {
    const { fs } = makeSystem()
    const mat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x00ff00, emissiveIntensity: 0.5 })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), mat))
    fs._mountOfficial(fs._models.skye, root, 1.35)
    const m = fs._models.skye
    expect(m.official).toBe(root)
    expect(m.proc).toBeNull() // 程序化根已摘除
    expect(m.group.children).toContain(m.light) // 容器点光仍在场景图（渲染可见）
    expect(m.glowMats.some(g => g.mat === mat)).toBe(true) // 官方材质纳入调色组
    fs.setMode('skye'); fs.resetRound(0); fs._spawn()
    advance(fs, 0.8) // 充能 0.75s 满 → 转橙（作用于实际渲染的官方材质与点光）
    expect(fs.proj.charged).toBe(true)
    expect(mat.emissive.getHex()).toBe(0xffb060)
    expect(m.light.color.getHex()).toBe(0xffa040)
    fs.proj.phase = 'arm'; fs.proj.armT = 0.2 // arm 渐亮：0.2/0.3 → 官方材质强度抬升
    fs.renderSync(0.5, DT)
    expect(mat.emissiveIntensity).toBeCloseTo(0.5 + (0.2 / 0.3) * 4.4, 3)
    fs._despawn() // 收摊复位：原色/原强度/点光回绿
    expect(mat.emissive.getHex()).toBe(0x00ff00)
    expect(mat.emissiveIntensity).toBe(0.5)
    expect(m.light.color.getHex()).toBe(0x46ffb0)
    expect(m.light.intensity).toBe(0.8)
  })
})

describe('Reyna 近视世界空间重建（W3：6m 视界雾收束 + 0.3s 线性褪去）', () => {
  it('命中 0.12s 线性拉满：雾 near/far 收束到视界半径；转开 0.15s 时恰好褪到一半（线性）', () => {
    const { fs, player } = makeSystem()
    fs.setMode('reyna'); fs.resetRound(0); fs._spawn()
    player.yaw = Math.PI // 全程背对眼球：不受近视，但仍在 LOS 内 → 预警（W10）
    advance(fs, 1.0) // fly 0.55 + arrive 0.4 → 眼开
    expect(fs.proj.phase).toBe('active')
    advance(fs, 0.05)
    expect(Number(fs.nearsightEl.style.opacity)).toBe(0)
    expect(Number(fs.warnEl.style.opacity)).toBeGreaterThan(0.2)
    player.yaw = 0 // 转回正面：命中
    advance(fs, 0.3) // onset 0.12s 线性拉满
    expect(fs.nearsightEl.style.opacity).toBe('1.000')
    const R = CONFIG.flash.reyna
    expect(fs._fog.near).toBeCloseTo(R.visionRadius * 0.75, 5) // 世界空间：4.5m 起雾
    expect(fs._fog.far).toBeCloseTo(R.visionRadius, 5) // 6m 外全覆盖
    expect(fs._fog.color.getHex()).toBe(R.nearFogColor) // 暗品红不透明覆盖
    expect(Number(fs.warnEl.style.opacity)).toBe(0) // 已被近视：预警压隐
    player.yaw = Math.PI // 转开视线
    advance(fs, 0.15)
    const mid = Number(fs.nearsightEl.style.opacity)
    expect(mid).toBeGreaterThan(0.4) // 线性褪去：0.15s/0.3s → ~0.5（指数曲线此处为 0.61）
    expect(mid).toBeLessThan(0.6)
    advance(fs, 0.2) // +0.2s（0.3s 褪去 + 1.5 步续借残留）→ 归零
    expect(fs.nearsightEl.style.opacity).toBe('0.000')
    expect(fs._fog.near).toBeCloseTo(60, 5) // 雾复位（引擎默认 60→170）
    expect(fs._fog.far).toBeCloseTo(170, 5)
  })
})

describe('等离子弹体飞行与 2.5m 溅射（W11）', () => {
  it('锁定满 → 弹体飞行期不结算；命中瞬间溅射糊屏 + 2.5m 半径溅射视觉', () => {
    const { fs, fx } = makeSystem()
    fs.setMode('gecko'); fs.resetRound(0); fs._spawn()
    advance(fs, 0.7) // 急停悬停 + 活跃窗已开（0.65s），正对 LOS 锁定中
    const p = fs.proj
    expect(p.slowed).toBe(true)
    expect(p.fired).toBe(false) // 锁定 0.05s < 0.35s：尚未喷
    p.acquire = CONFIG.flash.gecko.acquireWindup - DT / 2 // 差半步锁满
    const popped = []
    fs.onPopped = (b) => popped.push(b)
    advance(fs, DT * 2) // 锁满 → 发射弹体
    expect(p.fired).toBe(true)
    expect(fs._plasmaShot).not.toBeNull() // 弹体在飞（v6.05『等离子在飞行途中』）
    expect(fs._plasma).toBeNull() // 命中前不结算
    expect(popped).toEqual([])
    let guard = 0
    while (fs._plasmaShot && guard < 500) { fs.step(DT); guard++ } // 飞完（~13m ÷ 40m/s ≈ 0.33s）→ 命中
    // 命中 step 的 24 发溅射粒子（18 火花 + 6 软泡）恰为 emits 末尾一段——
    // 先取窗口再渲染：其后的 renderSync 可能发 Dizzy 拖尾（悬停位距眼 ~13m），不能混入
    const splashEmits = fx.emits.slice(-24)
    fs.renderSync(0.5, DT)
    expect(fs._plasmaShot).toBeNull()
    expect(fs._plasma).not.toBeNull()
    expect(fs._plasma.until - fs._plasma.at).toBeCloseTo(2, 5) // 1s 满效 + 1s 渐褪
    expect(popped[0]).toBe(true)
    // 溅射视觉落在 2.5m 溅射半径内（game files Plasma explosion radius；眼位 (0,1.6,-8)）
    const EYE = { x: 0, y: 1.6, z: -8 }
    expect(splashEmits.length).toBe(24)
    for (const [x, y, z] of splashEmits) {
      expect(Math.hypot(x - EYE.x, y - EYE.y, z - EYE.z)).toBeLessThan(CONFIG.flash.gecko.splash + 0.5)
    }
  })
})

describe('KAY/O 弹跳 windup 警灯全程化（W13：v10.06 unique audio and visuals）', () => {
  it('弹跳后整个 0.8s windup 警灯持续脉冲（与爬升嗡鸣同拍），未弹跳飞行段保持静态 1.6', () => {
    const { fs } = makeSystem()
    fs.setMode('kayo'); fs.resetRound(0)
    const spy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.9).mockReturnValueOnce(0.5).mockReturnValueOnce(0.2) // 主投变体①：拍地弹跳
      .mockReturnValueOnce(0.5).mockReturnValueOnce(0.5)
    fs._spawn()
    spy.mockRestore()
    const m = fs._models.kayo
    fs.renderSync(0.5, DT)
    expect(m.glowMat.emissiveIntensity).toBe(1.6) // 飞行段（未弹跳）警灯静态
    let bounced = false
    let t = 0
    while (!bounced && t < 2) { fs.step(DT); t += DT; bounced = !!fs.proj?.bounced }
    expect(bounced).toBe(true)
    // 弹跳 windup 前 ~0.35s（旧实现此段与普通飞行无异）逐帧采样：警灯全程 >基准
    const samples = []
    for (let i = 0; i < Math.round(0.35 / DT); i++) {
      fs.step(DT); fs.renderSync(0.5, DT)
      samples.push(m.glowMat.emissiveIntensity)
    }
    for (const v of samples) expect(v).toBeGreaterThan(1.6)
    // 包络随进度爬升：段内峰值已达 windK≈0.44 的包络上限（1.6+0.44×2.4≈2.66）附近
    expect(Math.max(...samples)).toBeGreaterThan(2.3)
  })
})

describe('Leer 眼茧开合与固定朝向（W14）', () => {
  it('飞行段闭合茧（缝光渗出）；到位 0.4s 花瓣绽开消散；朝向沿施法方向固定不追踪玩家', () => {
    const { fs, player } = makeSystem()
    fs.setMode('reyna'); fs.resetRound(0); fs._spawn()
    const m = fs._models.reyna
    advance(fs, 0.3) // 飞行中段
    expect(m.budTop.rotation.x).toBeCloseTo(0, 8) // 眼茧闭合
    expect(m.budBottom.rotation.x).toBeCloseTo(0, 8)
    expect(m.budMat.opacity).toBeCloseTo(1, 6) // 眼茧膜完全不透明
    expect(m.seam.material.opacity).toBeGreaterThan(0.2) // 缝光：虹膜光渗出
    expect(m.glowSpot.material.opacity).toBeGreaterThan(0.2) // 正前透光点
    advance(fs, 0.4) // fly 0.55 结束 → arrive 中段（0.15s/0.4s）
    expect(fs.proj.phase).toBe('arrive')
    expect(m.budTop.rotation.x).toBeLessThan(-0.5) // 上片后仰绽放（easeOutBack 快速张开）
    expect(m.budMat.opacity).toBeLessThan(0.5) // 膜面随张开消散
    advance(fs, 0.3) // arrive 完成 → active
    expect(fs.proj.phase).toBe('active')
    expect(m.budTop.visible).toBe(false) // 花瓣全开消散
    expect(m.budMat.opacity).toBe(0)
    // 朝向固定：active 期挪动玩家位置，模型姿态不变（不持续追踪个体玩家）
    const q0 = m.group.quaternion.clone()
    player.pos.x += 6
    player.pos.z += 4
    advance(fs, 0.1)
    expect(m.group.quaternion.angleTo(q0)).toBeCloseTo(0, 6)
  })
})

describe('Dizzy 坠落残躯 Globule（W15：v12.03 存世 20s）', () => {
  it('活跃窗耗尽 → 坠落触地静置 20s（不占用 proj 槽位），到期迸散清除', () => {
    const { fs } = makeSystem()
    fs.setMode('gecko'); fs.resetRound(0); fs._spawn()
    advance(fs, 1.8) // 活跃窗 0.65+1.0=1.65s 耗尽 → 坠落
    expect(fs.proj).toBeNull()
    expect(fs._globule).not.toBeNull()
    expect(fs._globuleMesh.group.visible).toBe(true)
    expect(fs._globule.until - fs.t).toBeGreaterThan(CONFIG.flash.gecko.globuleLife - 0.15) // 刚投放：存世 ~20s
    expect(fs._globule.until - fs.t).toBeLessThanOrEqual(CONFIG.flash.gecko.globuleLife)
    advance(fs, 0.6) // 触地（地图重力坠落 + 一次弱弹跳）→ 静置
    expect(fs._globule.rest).toBe(true)
    expect(fs._globule.y).toBeCloseTo(0.14, 5)
    expect(fs._globuleMesh.group.visible).toBe(true) // 残躯停留
    fs.setMode('off') // 关闭投放：advance 跨越 20s 期间不生成新 Dizzy 顶替残躯
    advance(fs, CONFIG.flash.gecko.globuleLife) // 存世期满 → 迸散
    expect(fs._globule).toBeNull()
    expect(fs._globuleMesh.group.visible).toBe(false)
    // 残躯不阻塞下一颗闪光（Globule 独立于 proj 槽位）：重新开启投放立即成功
    fs.setMode('gecko')
    fs.nextAt = fs.t
    fs.step(DT)
    expect(fs.proj).not.toBeNull()
  })
})

describe('Dizzy 扇翅动画（W16）', () => {
  it('悬停期双翼镜像持续扇动（6.5Hz），飞行段高频小幅；翼面挂容器层', () => {
    const { fs } = makeSystem()
    fs.setMode('gecko'); fs.resetRound(0); fs._spawn()
    const m = fs._models.gecko
    expect(m.wings).toBeTruthy()
    expect(m.group.children).toContain(m.wings.R) // 容器层：官方/程序化两路径共用
    expect(m.group.children).toContain(m.wings.L)
    advance(fs, 0.3) // 飞行段（13Hz 小幅）
    const flightR = m.wings.R.rotation.z
    expect(Math.abs(flightR)).toBeGreaterThan(0.05)
    advance(fs, 0.4) // 进入悬停（6.5Hz 主特征）
    expect(fs.proj.slowed).toBe(true)
    const samples = [m.wings.R.rotation.z]
    for (let i = 0; i < 8; i++) { fs.renderSync(0.5, DT); samples.push(m.wings.R.rotation.z) }
    expect(new Set(samples).size).toBeGreaterThan(2) // 持续扇动（逐帧相位推进）
    expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(0.15) // 振幅包络 0.55 内
    expect(m.wings.L.rotation.z).toBeCloseTo(-m.wings.R.rotation.z, 6) // 双翼镜像
    expect(m.wings.R.rotation.y).toBeGreaterThan(0) // 悬停微收展（后掠角为正）
  })
})

describe('等离子糊屏边缘可见圈（W12：--plasma-hole 扩边曲线）', () => {
  it('满效仅边缘露一圈（hole=0.82）；渐褪期可见圈从边缘向内持续扩大，alpha 后段才变薄', () => {
    const { fs } = makeSystem()
    fs.t = 10 // 固定时基（advance 经 step 推时，DT=2^-7 二进制精确）
    fs._plasma = { at: 9, potencyUntil: 10, until: 11 }
    fs.renderSync(0.5, DT)
    expect(fs.plasmaEl.style.opacity).toBe('1.000') // 满效期全不透明
    expect(fs.plasmaEl.style.getPropertyValue('--plasma-hole')).toBe('0.820')
    advance(fs, 0.5) // 渐褪 k=0.5
    expect(fs.plasmaEl.style.opacity).toBe('1.000') // alphaHold 0.55：前半段仍不透明
    const holeMid = Number(fs.plasmaEl.style.getPropertyValue('--plasma-hole'))
    expect(holeMid).toBeCloseTo(0.82 * (1 - Math.pow(0.5, CONFIG.flash.gecko.plasmaEdgeCurve)), 3) // 0.450
    expect(holeMid).toBeLessThan(0.82) // 可见圈已从边缘向内扩张
    advance(fs, 0.25) // k=0.75
    expect(fs.plasmaEl.style.opacity).toBe('0.556') // 1-(0.75-0.55)/0.45
    expect(Number(fs.plasmaEl.style.getPropertyValue('--plasma-hole'))).toBeLessThan(holeMid)
    advance(fs, 0.25) // k=1 → 收摊
    expect(fs.plasmaEl.style.opacity).toBe('0.000')
    expect(fs.plasmaEl.style.getPropertyValue('--plasma-hole')).toBe('0.820') // 复位
    expect(fs._plasma).toBeNull()
  })
})
