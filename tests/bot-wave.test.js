// BotManager 波次推进状态机 + Bot.step/place 的行为用例（167 轮补测）：
//  - pull out→leave 换向 / cross 走到终点 finishWave / 漏杀（duelsLost）计数口径
//  - damage() 击杀清槽重排 / jiggle 折返点几何不变量 / dying→corpse 时序
//  - moveToward 地面模型集成 / place() 池复用归零（死代码删除的安全网）
// 手法同 peek-delay.test.js：Object.create(BotManager.prototype) + stub Math.random
// 队列（原型 getter 链可达）；Bot 侧只桩状态机依赖的面，moveToward/place 直接
// 调原型方法（真实实现）
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { BotManager } from '../src/entities/BotManager.js'
import { Bot } from '../src/entities/Bot.js'
import { CONFIG } from '../src/core/Config.js'

const GAP = { x0: -9, x1: -6 } // 训练不变量：左缺口（MapBuilder 锁死）
const DT = 1 / 128

// 桩 Bot：波次推进只依赖这些面；moveToward 默认走真实地面模型（速度积分出 pos）
function waveBot(over = {}) {
  const b = {
    active: true, mode: 'peek', peek: null, slot: null,
    pos: { x: 0, z: 0 }, velX: 0, velZ: 0,
    firstVisibleAt: -1, hidden: false,
    hide() { this.hidden = true; this.active = false; this.mode = 'idle' },
    ...over,
  }
  b.moveToward = (vx, dt, vz = 0) => Bot.prototype.moveToward.call(b, vx, dt, vz)
  return b
}

function mgrStub() {
  const mgr = Object.create(BotManager.prototype)
  mgr.now = () => 0
  mgr.params = { peekSide: 'left', speedMult: 1.0, rampUp: false, delayMin: 400, delayMax: 1400 }
  mgr.map = { gaps: [GAP], peekLineZ: -30 }
  mgr.stats = BotManager.prototype._freshStats.call(mgr)
  mgr._bot = () => waveBot()
  return mgr
}

// 推进槽位直到条件成立（步数上限防死循环）
function drive(mgr, slot, until, maxSteps = 20000) {
  let steps = 0
  while (!until() && steps++ < maxSteps) mgr._stepSlot(slot, DT)
  return steps
}

describe('BotManager 波次推进：pull 拉出即缩', () => {
  it('out 拉到折返点 → leave 反向缩回原掩体 → finishWave 计漏杀、清槽重排', () => {
    const b = waveBot()
    b.peek = { style: 'pull', startX: -11, turnX: -7.5, endX: -11, dir: 1, phase: 'out', jiggleAt: 0, crouchWalk: false }
    b.pos.x = -11
    b.firstVisibleAt = 2.5 // 进过玩家视野 → 走完计漏杀
    const mgr = mgrStub()
    const slot = { nextAt: 1e9, bot: b }
    b.slot = slot
    drive(mgr, slot, () => b.peek.phase !== 'out')
    expect(b.peek.phase).toBe('leave')
    expect(b.peek.exitX).toBe(-11) // 缩回起点（藏进原掩体）
    expect(b.pos.x).toBeGreaterThanOrEqual(-7.5) // 折返点即换向点
    // 反向：leave 段目标速度翻号——第一步即摩擦减速（counter-strafe 不越零），
    // 随后过零反向加速回到藏点
    const vBefore = b.velX
    mgr._stepSlot(slot, DT)
    expect(b.velX).toBeLessThan(vBefore)
    expect(b.velX).toBeGreaterThan(0)
    drive(mgr, slot, () => b.hidden)
    expect(b.hidden).toBe(true)
    expect(b.velX).toBeLessThan(0)
    expect(b.pos.x).toBeLessThanOrEqual(-11 + 0.05) // 回到藏点（≤一 tick 步进余量）
    expect(mgr.stats.duelsLost).toBe(1)
    expect(slot.bot).toBeNull()
    expect(slot.nextAt).toBe(0) // 主槽重掷下一波延迟
  })

  it('漏杀可见性门槛：整波从未进过玩家视野（firstVisibleAt=-1）不计漏杀', () => {
    const b = waveBot()
    b.peek = { style: 'pull', startX: -11, turnX: -7.5, endX: -11, dir: 1, phase: 'out', jiggleAt: 0, crouchWalk: false }
    b.pos.x = -11
    b.firstVisibleAt = -1 // 玩家站远/走开：整波 0% 可见
    const mgr = mgrStub()
    const slot = { nextAt: 1e9, bot: b }
    drive(mgr, slot, () => b.hidden)
    expect(b.hidden).toBe(true)
    expect(mgr.stats.duelsLost).toBe(0) // 口径与 reactions/aimErrors 同源（F9）
  })
})

describe('BotManager 波次推进：cross 贯穿跑过', () => {
  it('cross 走到终点 finishWave（可见波计漏杀、hide、主槽重排）', () => {
    const b = waveBot()
    b.peek = { style: 'cross', startX: -11.2, endX: -3.8, dir: 1 }
    b.pos.x = -11.2
    b.firstVisibleAt = 1
    const mgr = mgrStub()
    const slot = { nextAt: 1e9, bot: b }
    drive(mgr, slot, () => b.hidden)
    expect(b.hidden).toBe(true)
    expect(b.pos.x).toBeGreaterThanOrEqual(-3.8) // 完整走完横移线
    expect(b.pos.x).toBeLessThanOrEqual(-3.8 + 0.05)
    expect(mgr.stats.duelsLost).toBe(1)
    expect(slot.bot).toBeNull()
    expect(slot.nextAt).toBe(0)
  })
})

describe('BotManager damage() 击杀清槽重排', () => {
  const mkKillMgr = () => {
    const mgr = mgrStub()
    mgr.now = () => 2
    mgr.audio = { hitMark() {} }
    return mgr
  }
  const killBot = (over = {}) => ({
    invulnerable: false, mode: 'peek', firstVisibleAt: 1.0, reactRecorded: false,
    hp: 100, flashHit() {}, startDeath() {}, slot: { nextAt: 12345, bot: {}, partner: false },
    ...over,
  })

  it('击杀：kills+1、flashHit→startDeath、主槽清空重排（nextAt=0 重掷）、不计漏杀', () => {
    const mgr = mkKillMgr()
    const slot = { nextAt: 12345, bot: {}, partner: false }
    const bot = killBot({ slot })
    const death = []
    bot.startDeath = () => { death.push(mgr.now()) }
    expect(mgr.damage(bot, 999, 'head')).toBe(true)
    expect(death).toEqual([2])
    expect(mgr.stats.kills).toBe(1)
    expect(mgr.stats.headshots).toBe(1)
    expect(mgr.stats.duelsLost).toBe(0) // 击杀走清槽路径，不进漏杀
    expect(slot.bot).toBeNull()
    expect(slot.nextAt).toBe(0) // 从击杀时刻重掷下一波延迟（不沿用旧 nextAt）
    expect(mgr.stats.reactions).toEqual([1000]) // now−firstVisibleAt = 1s
  })

  it('副槽击杀：nextAt=Infinity 回休眠（不自主排程）', () => {
    const mgr = mkKillMgr()
    const slot = { nextAt: 12345, bot: {}, partner: true }
    const bot = killBot({ slot })
    mgr.damage(bot, 999, 'body')
    expect(slot.nextAt).toBe(Infinity)
  })

  it('反应样本每次出场只记一条：多发击杀的第二发不再计入', () => {
    const mgr = mkKillMgr()
    const bot = killBot({ hp: 200 })
    mgr.damage(bot, 100, 'body') // 未致死
    mgr.damage(bot, 100, 'body') // 致死
    expect(mgr.stats.reactions).toHaveLength(1)
    expect(bot.reactRecorded).toBe(true)
  })

  it('不可见命中不记反应（firstVisibleAt=-1）；未致死返回 false 并响 hitMark', () => {
    const mgr = mkKillMgr()
    let hitMarks = 0
    mgr.audio = { hitMark() { hitMarks++ } }
    const bot = killBot({ firstVisibleAt: -1 })
    expect(mgr.damage(bot, 40, 'body')).toBe(false)
    expect(mgr.stats.kills).toBe(0)
    expect(mgr.stats.reactions).toHaveLength(0)
    expect(hitMarks).toBe(1)
  })
})

describe('BotManager pull 掷定几何不变量', () => {
  // 队列：0.99→pull；藏点 rand(1.8,2.4)、折返 rand(0,0.9)、jiggle 掷骰（<0.3 掷中）、
  // 蹲走掷骰（桩无 anim.crouchWalk → F8 起不消耗）、双拉掷骰（默认 0.99 不掷中）
  function spawnPull(queue, peekSide = 'left') {
    const b = { peek: null, slot: null, place() {} } // 无 anim：蹲走掷骰短路
    const mgr = Object.create(BotManager.prototype)
    mgr.now = () => 0
    mgr.params = { peekSide }
    mgr.map = { gaps: [GAP], peekLineZ: -30 }
    mgr._bot = () => b
    const slot = { nextAt: -1, bot: null, lastStyles: [] }
    mgr.hold = { slots: [slot, { nextAt: Infinity, bot: null, partner: true }] }
    const orig = Math.random
    Math.random = () => queue.shift() ?? 0.99
    try {
      mgr._stepSlot(slot, DT)
    } finally {
      Math.random = orig
    }
    return b
  }

  it('折返点 turnX 落在缺口窗内；jiggle 折返点严格位于藏点与折返点之间（0.5~0.72 段）', () => {
    for (const side of ['left', 'right']) {
      for (const rHide of [0, 0.5, 0.99]) {
        for (const rTurn of [0, 0.99]) {
          for (const rJig of [0, 0.29]) { // < pullJiggleChance(0.3) → 掷中 jiggle
            const b = spawnPull([0.99, rHide, rTurn, rJig, 0.99], side)
            const pk = b.peek
            expect(pk.style).toBe('pull')
            expect(pk.turnX).toBeGreaterThanOrEqual(GAP.x0)
            expect(pk.turnX).toBeLessThanOrEqual(GAP.x1)
            expect(pk.jiggleAt).not.toBe(0)
            const span = Math.abs(pk.turnX - pk.startX)
            const frac = (pk.jiggleAt - pk.startX) * Math.sign(pk.turnX - pk.startX) / span
            // 「露头即缩」：折返必在出墙之后、正常折返点之前（中段 0.5~0.72）
            expect(frac).toBeGreaterThan(0.5 - 1e-9)
            expect(frac).toBeLessThan(0.72 + 1e-9)
            expect(Math.abs(pk.jiggleAt - pk.startX)).toBeLessThan(span)
          }
        }
      }
    }
  })

  it('非 jiggle 波（掷骰 ≥0.3）jiggleAt 保持 0 哨兵', () => {
    const b = spawnPull([0.99, 0.5, 0.5, 0.99])
    expect(b.peek.jiggleAt).toBe(0)
    expect(b.peek.crouchWalk).toBe(false) // 无官方蹲走 clip 的模型不进蹲走波（F8）
  })
})

describe('Bot.step dying→corpse 时序（刚体倒地路径）', () => {
  function dyingBot() {
    const bot = Object.create(Bot.prototype)
    bot.pos = new THREE.Vector3()
    bot.prevPos = new THREE.Vector3()
    bot.active = true
    bot.mode = 'dying'
    bot.deathT = 0
    bot.deathRoll = 0.2
    bot._landed = false
    bot._skelDeath = false // 无 mixer/烘焙：整体刚体后仰倒地（程序化假人路径）
    bot._officialDeath = false
    bot._drop = null
    bot.gun = null
    bot.mesh = { rotation: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } }
    return bot
  }

  it('1.2s 倒地后转 corpse 定格（active=false、corpseAt=游戏时钟）；触地闷响只响一次', () => {
    const bot = dyingBot()
    let now = 0
    const lands = []
    bot.now = () => now
    bot.onDeathLand = () => lands.push(now)
    const ctx = { player: null, alpha: 1 }
    let steps = 0
    while (bot.mode !== 'corpse' && steps++ < 1000) {
      now += DT
      Bot.prototype.step.call(bot, DT, ctx)
    }
    expect(bot.mode).toBe('corpse')
    expect(bot.active).toBe(false)
    expect(bot.corpseAt).toBeCloseTo(now, 6)
    expect(now).toBeGreaterThanOrEqual(1.2) // 非官方死亡 clip 的定格时长
    expect(lands).toHaveLength(1) // ease-out 0.63 处的拍地帧，只响一次
    expect(lands[0]).toBeGreaterThanOrEqual(CONFIG.bot.deathTime * 0.63)
    expect(bot.mesh.rotation.x).toBeGreaterThan(1.2) // 倒地后仰已到位（~85°）
    // corpse 定格：继续 step 不再演化（零 CPU 静态网格）
    const rx = bot.mesh.rotation.x
    const py = bot.mesh.position.y
    Bot.prototype.step.call(bot, DT, ctx)
    expect(bot.mesh.rotation.x).toBe(rx)
    expect(bot.mesh.position.y).toBe(py)
  })
})

describe('Bot.moveToward 地面模型集成', () => {
  it('恒定加速逼近目标速度、位置积分；反向目标先摩擦减速过零再反向加速', () => {
    const b = waveBot()
    for (let i = 0; i < 64; i++) b.moveToward(5.4, DT) // 0.5s
    expect(b.velX).toBeGreaterThan(5.3)
    expect(b.velX).toBeLessThanOrEqual(5.4 + 1e-9)
    expect(b.pos.x).toBeGreaterThan(1) // 积分位移
    // counter-strafe：反向输入只走摩擦（28.6 恒大于加速 18.75）
    const v0 = b.velX
    b.moveToward(-5.4, DT)
    expect(b.velX).toBeLessThan(v0) // 第一步即减速、不越过 0
    expect(b.velX).toBeGreaterThan(0)
    for (let i = 0; i < 64; i++) b.moveToward(-5.4, DT) // 再 0.5s
    expect(b.velX).toBeLessThan(-5.3) // 已反向加速到接近满速
    expect(b.velZ).toBe(0) // 单轴调用不改 z（walkout 波才用两轴）
  })
})

describe('Bot.place() 池复用归零（安全网：复用 Bot 不带上一条命）', () => {
  function reuseBot() {
    const bot = Object.create(Bot.prototype)
    bot.pos = new THREE.Vector3()
    bot.prevPos = new THREE.Vector3()
    bot.hp = 1
    bot.active = false
    bot.mode = 'corpse'
    bot.velX = 3
    bot.velZ = 0
    bot.mesh = { visible: true, rotation: { set() {} }, position: { copy() {} } }
    bot.blob = { visible: false }
    bot.blobMat = { opacity: 0 }
    bot.mats = {}
    bot.now = () => 0
    // mixer 分支归零段需要的最小桩：mixer 存在 + walk 动作可复位
    bot.mixer = { update() {} }
    bot.anim = { walk: { time: 0, setEffectiveWeight() {}, getClip: () => ({ duration: 1 }) } }
    return bot
  }

  it('蹲走/横移权重、蹲走相位与侧别、播放头、可见性/受击残留全部归零', () => {
    const bot = reuseBot()
    // 预置上一条命的脏状态（蹲走波死亡后复用的典型残留）
    bot._crouchW = 1
    bot._crouchWW = 1
    bot._cwPhase = 2.5
    bot._cwSide = 'W'
    bot._moveW = 1
    bot._runW = 1
    bot._strafeW = 1
    bot.anim.walk.time = 0.4
    bot._animAcc = 0.009
    bot.flinch = 1
    bot.hitFlash = 1
    bot.firstVisibleAt = 3
    bot.reactRecorded = true
    bot.walkPhase = 2
    Bot.prototype.place.call(bot, -8, -30, 'peek')
    expect(bot.active).toBe(true)
    expect(bot.mode).toBe('peek')
    expect(bot.hp).toBe(CONFIG.bot.health)
    // ⚠ _crouchW 是活机制蹲走波的 place() 归零项（BotManager 掷、_setAnimWeights/
    // _anchorSources 消费）：删 place() 里这一行会让蹲走中死亡的复用 Bot 带着深蹲
    // 权重出场——本用例正是死代码清理时这行不被误删的安全网
    expect(bot._crouchW).toBe(0)
    expect(bot._crouchWW).toBe(0)
    expect(bot._cwPhase).toBe(0)
    expect(bot._cwSide).toBeNull()
    expect(bot._moveW).toBe(0)
    expect(bot._runW).toBe(0)
    expect(bot._strafeW).toBe(0)
    expect(bot.anim.walk.time).toBe(0)
    expect(bot._animAcc).toBe(0)
    expect(bot.flinch).toBe(0)
    expect(bot.firstVisibleAt).toBe(-1)
    expect(bot.reactRecorded).toBe(false)
    expect(bot.walkPhase).toBe(0)
    expect(bot.velX).toBe(0)
    expect(bot.pos.x).toBe(-8)
    expect(bot.pos.z).toBe(-30)
  })
})
