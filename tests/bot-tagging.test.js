// 命中 tagging 减速（bot-tagging-slow）：damage() 写 bot.tagUntil、moveToward 消费——
// 打中未杀的 Bot 走线 ×72.5%（Valorant 3.0 补丁定值「75% slow >>> 72.5% slow」，
// Fandom Patch Notes/3.0），是「首中后补枪/跟枪提前量」训练节奏的依据
// 手法同 bot-wave.test.js：Object.create(BotManager.prototype) + 桩 Bot（真实 moveToward）
import { describe, expect, it } from 'vitest'
import { BotManager } from '../src/entities/BotManager.js'
import { Bot } from '../src/entities/Bot.js'
import { CONFIG } from '../src/core/Config.js'
import { GAP_LEFT as GAP, SPAWN_Z } from '../src/world/corridor.js' // 训练不变量单一事实源

const DT = 1 / 128

function tagBot(now = () => 0) {
  const b = { pos: { x: 0, z: 0 }, velX: 0, velZ: 0, now, tagUntil: 0 }
  b.moveToward = (vx, dt, vz = 0) => Bot.prototype.moveToward.call(b, vx, dt, vz)
  return b
}

describe('BotManager.damage() 写 tagging', () => {
  const mkMgr = () => {
    const mgr = Object.create(BotManager.prototype)
    mgr.now = () => 2
    mgr.params = { peekSide: 'left', speedMult: 1.0, rampUp: false, delayMin: 400, delayMax: 1400 }
    mgr.map = { gaps: [GAP], spawn: { z: SPAWN_Z } }
    mgr.stats = BotManager.prototype._freshStats.call(mgr)
    mgr.audio = { hitMark() {} }
    return mgr
  }
  const hitBot = (over = {}) => ({
    invulnerable: false, mode: 'peek', firstVisibleAt: -1, reactRecorded: false,
    hp: 100, flashHit() {}, startDeath() {}, slot: null, tagUntil: 0,
    ...over,
  })

  it('未杀命中：tagUntil = now + taggingTime；隔 1s 再命中按新时刻重置（不叠加）', () => {
    const mgr = mkMgr()
    const b = hitBot()
    mgr.damage(b, 40, 'body')
    expect(b.tagUntil).toBeCloseTo(2 + CONFIG.bot.taggingTime, 9)
    mgr.now = () => 3 // 第二发在 1s 后：重置为新到期时刻（不是取 max，更不是叠时长）
    mgr.damage(b, 40, 'body')
    expect(b.tagUntil).toBeCloseTo(3 + CONFIG.bot.taggingTime, 9)
  })

  it('致死弹同样写 tagUntil（倒地动画不走 moveToward，无害）；早退路径（invulnerable/dying）不写', () => {
    const mgr = mkMgr()
    const dead = hitBot()
    mgr.damage(dead, 999, 'head')
    expect(dead.tagUntil).toBeCloseTo(2 + CONFIG.bot.taggingTime, 9)
    const inv = hitBot({ invulnerable: true })
    mgr.damage(inv, 40, 'body')
    expect(inv.tagUntil).toBe(0)
    const dying = hitBot({ mode: 'dying' })
    mgr.damage(dying, 40, 'body')
    expect(dying.tagUntil).toBe(0)
  })
})

describe('Bot.moveToward tagging 减速', () => {
  const CAP = CONFIG.bot.moveSpeed * CONFIG.bot.taggingSpeed // 5.4 × 0.725 ≈ 3.92

  it('tag 生效期速度上限 = 5.4×0.725；到期后回满速 5.4', () => {
    const b = tagBot()
    b.tagUntil = 1 // t=0 < 1：tagged
    for (let i = 0; i < 128; i++) b.moveToward(5.4, DT) // 1s：足够收敛到慢档目标速
    expect(b.velX).toBeGreaterThan(CAP - 0.05)
    expect(b.velX).toBeLessThanOrEqual(CAP + 1e-9)
    b.tagUntil = 0 // 到期（0 < 0 false）：满速档
    for (let i = 0; i < 128; i++) b.moveToward(5.4, DT)
    expect(b.velX).toBeGreaterThan(5.3)
    expect(b.velX).toBeLessThanOrEqual(5.4 + 1e-9)
  })

  it('慢档下反向急停仍走摩擦第一步；tagUntil 缺省（?? 0 兜底）不减速不崩', () => {
    const b = tagBot()
    b.tagUntil = 1
    for (let i = 0; i < 64; i++) b.moveToward(5.4, DT)
    expect(b.velX).toBeLessThanOrEqual(CAP + 1e-9)
    b.moveToward(-5.4, DT)
    expect(b.velX).toBeLessThan(CAP) // 急停第一步仍减速（counter-strafe 语义不变）
    const c = tagBot()
    c.tagUntil = undefined // 老调用面/未初始化：?? 0 兜底
    c.moveToward(5.4, DT)
    expect(c.velX).toBeGreaterThan(0)
  })
})

describe('tagging 接入波次走线（BotManager._stepSlot → moveToward）', () => {
  // 手法同 bot-wave.test.js：真实 _stepSlot 驱动 cross 波，1s 后比较稳态速度——
  // 锁「波次速度必须经 moveToward 的 tag 系数」，防速度在 _stepSlot 侧另起炉灶绕过减速
  function crossBot(tagUntil) {
    const b = {
      active: true, mode: 'peek',
      peek: { style: 'cross', startX: -11.2, endX: -3.8, dir: 1 },
      pos: { x: -11.2, z: 0 }, velX: 0, velZ: 0,
      firstVisibleAt: -1, hidden: false, now: () => 0, tagUntil,
      hide() { this.hidden = true },
    }
    b.moveToward = (vx, dt, vz = 0) => Bot.prototype.moveToward.call(b, vx, dt, vz)
    return b
  }
  function drive1s(b) {
    const mgr = Object.create(BotManager.prototype)
    mgr.now = () => 0
    mgr.params = { peekSide: 'left', speedMult: 1.0, rampUp: false, delayMin: 400, delayMax: 1400 }
    mgr.map = { gaps: [GAP], spawn: { z: SPAWN_Z } }
    mgr.stats = BotManager.prototype._freshStats.call(mgr)
    const slot = { nextAt: 1e9, bot: b }
    b.slot = slot
    for (let i = 0; i < 128 && !b.hidden; i++) mgr._stepSlot(slot, DT)
    return b
  }

  it('cross 波 tagged Bot 稳态速度 ≈ 5.4×0.725（未杀中弹后走线真实减速）', () => {
    const tagged = drive1s(crossBot(10)) // t=0 < 10：全程 tagged
    expect(tagged.velX).toBeGreaterThan(CONFIG.bot.moveSpeed * CONFIG.bot.taggingSpeed - 0.05)
    expect(tagged.velX).toBeLessThanOrEqual(CONFIG.bot.moveSpeed * CONFIG.bot.taggingSpeed + 1e-9)
    const free = drive1s(crossBot(0)) // 对照组：未 tag 满速
    expect(free.velX).toBeGreaterThan(5.3)
  })
})
