import { describe, expect, it } from 'vitest'
import { BotManager, shiftPeek } from '../src/entities/BotManager.js'

// 双拉波（166 轮）：主槽掷中 doublePeekChance 时第二人同帧拉出——同侧同风格，
// 整条横移线路沿行进方向后退 doublePeekLane → 场上锁步跟随。副槽平时休眠
// （nextAt=Infinity），只随双拉波唤醒，不自主排程、不被闪拉催单飞
const GAP = { x0: -9, x1: -6 }
const LANE = 0.9

describe('shiftPeek 双拉第二人线路平移', () => {
  it('cross：startX/endX 一起平移，dir/style 保留', () => {
    const s = shiftPeek({ style: 'cross', startX: -11.2, endX: -3.8, dir: 1 }, -LANE)
    expect(s.startX).toBeCloseTo(-11.2 - LANE, 9)
    expect(s.endX).toBeCloseTo(-3.8 - LANE, 9)
    expect(s.dir).toBe(1); expect(s.style).toBe('cross')
  })

  it('pull：startX/turnX/endX/jiggleAt 一起平移，crouchWalk 等其余字段照抄', () => {
    const s = shiftPeek({ style: 'pull', startX: -11.1, turnX: -7.5, endX: -11.1, dir: 1,
      phase: 'out', jiggleAt: -9.2, crouchWalk: true }, -LANE)
    expect(s.startX).toBeCloseTo(-11.1 - LANE, 9)
    expect(s.turnX).toBeCloseTo(-7.5 - LANE, 9)
    expect(s.endX).toBeCloseTo(-11.1 - LANE, 9)
    expect(s.jiggleAt).toBeCloseTo(-9.2 - LANE, 9)
    expect(s.crouchWalk).toBe(true); expect(s.phase).toBe('out')
  })

  it('pull 无 jiggle（jiggleAt=0 哨兵）不被误平移成 -0.9；原对象不被修改', () => {
    const pk = { style: 'pull', startX: -11.1, turnX: -7.5, endX: -11.1, dir: 1, jiggleAt: 0 }
    const s = shiftPeek(pk, -LANE)
    expect(s.jiggleAt).toBe(0)
    expect(pk.startX).toBeCloseTo(-11.1, 9) // 入参未动（波次各自改写 phase/exitX）
  })
})

// 出一波并返回主/副槽与出场 Bot 列表：Math.random 用队列喂——固定侧别下
// 第一发是风格抽签（<0.5 cross），随后 pull 分支内部各掷、最后一发是双拉掷骰
function spawnWave(queue) {
  const bots = []
  const mgr = Object.create(BotManager.prototype)
  mgr.now = () => 0
  mgr.params = { peekSide: 'left' }
  mgr.map = { gaps: [GAP], peekLineZ: -23 }
  mgr._bot = () => {
    const b = { peek: null, slot: null, place(x, z, mode) { this.placed = { x, z, mode } } }
    bots.push(b); return b
  }
  const slot = { nextAt: -1, bot: null, lastStyles: [] } // 已排程且到期 → 立即出人
  const partner = { nextAt: Infinity, bot: null, partner: true }
  mgr.hold = { slots: [slot, partner] }
  const orig = Math.random
  Math.random = () => queue.shift() ?? 0.5
  try {
    mgr._stepSlot(slot, 1 / 128)
  } finally {
    Math.random = orig
  }
  return { bots, slot, partner, mgr }
}

describe('BotManager 双拉波', () => {
  it('cross 掷中双拉：第二人同帧出场，线路后退一个身位（startX = x0-2.2-LANE）', () => {
    const { bots, partner } = spawnWave([0, 0]) // 风格 0→cross / 双拉 0<0.18 → 掷中
    expect(bots.length).toBe(2)
    const [, b2] = bots
    expect(partner.bot).toBe(b2)
    expect(b2.slot).toBe(partner)
    expect(b2.peek.style).toBe('cross')
    expect(b2.peek.dir).toBe(1)
    expect(b2.peek.startX).toBeCloseTo(GAP.x0 - 2.2 - LANE, 6)
    expect(b2.peek.endX).toBeCloseTo(GAP.x1 + 2.2 - LANE, 6)
    expect(b2.placed.x).toBeCloseTo(GAP.x0 - 2.2 - LANE, 6) // place 用平移后的起点
  })

  it('双拉未掷中：只出一只，副槽保持休眠', () => {
    const { bots, partner } = spawnWave([0, 0.99]) // cross / 双拉 0.99 ≥ 0.18
    expect(bots.length).toBe(1)
    expect(partner.bot).toBeNull()
    expect(partner.nextAt).toBe(Infinity)
  })

  it('pull 掷中双拉：第二人同风格锁步（startX/turnX 同差 -LANE，crouchWalk 照抄）', () => {
    // 队列：0.99→pull；0.5/0.5→藏点 rand(1.8,2.4) 与折返 rand(0,0.9)；
    // 0.5≥0.3 无 jiggle；0.5≥0.2 不蹲走；0→双拉掷中
    const { bots, partner } = spawnWave([0.99, 0.5, 0.5, 0.5, 0.5, 0])
    expect(bots.length).toBe(2)
    const [b1, b2] = bots
    expect(b2.peek.style).toBe('pull')
    expect(b2.peek.crouchWalk).toBe(b1.peek.crouchWalk)
    expect(b2.peek.startX).toBeCloseTo(b1.peek.startX - LANE, 6)
    expect(b2.peek.turnX).toBeCloseTo(b1.peek.turnX - LANE, 6)
    expect(partner.bot).toBe(b2)
  })
})

describe('BotManager 双拉副槽休眠纪律', () => {
  const mk = () => {
    const mgr = Object.create(BotManager.prototype)
    mgr.now = () => 10
    mgr.params = { delayMin: 400, delayMax: 1400 }
    mgr.stats = { kills: 0 }
    mgr._bot = () => { throw new Error('休眠副槽不应出场') }
    return mgr
  }

  it('休眠副槽（nextAt=Infinity）步进后保持休眠，不自主排程不出场', () => {
    const mgr = mk()
    const slot = { nextAt: Infinity, bot: null, partner: true }
    mgr._stepSlot(slot, 1 / 128)
    expect(slot.nextAt).toBe(Infinity)
    expect(slot.bot).toBeNull()
  })

  it('击杀清槽后副槽 nextAt=0（旧状态）→ 下一步自动回休眠，不触发出场', () => {
    const mgr = mk()
    const slot = { nextAt: 0, bot: null, partner: true }
    mgr._stepSlot(slot, 1 / 128)
    expect(slot.nextAt).toBe(Infinity)
  })

  it('damage() 击杀副槽 Bot：副槽直接回 Infinity（主槽则回 0 重掷）', () => {
    const mgr = mk()
    mgr.audio = { hitMark() {} }
    mgr.stats = { shots: 0, hits: 0, headshots: 0, kills: 0, duelsLost: 0,
      reactions: [], lastReaction: 0, maxStreak: 0, aimErrors: [] }
    const bot = { invulnerable: false, mode: 'peek', firstVisibleAt: 0, reactRecorded: false,
      hp: 1, flashHit() {}, startDeath() {}, slot: { nextAt: 12345, bot: {}, partner: true } }
    mgr.damage(bot, 100, 'body')
    expect(bot.slot.nextAt).toBe(Infinity)
    const bot2 = { ...bot, slot: { nextAt: 12345, bot: {}, partner: false } }
    mgr.damage(bot2, 100, 'body')
    expect(bot2.slot.nextAt).toBe(0)
  })

  it('urgeNextPeek 闪拉只催主槽：休眠副槽不被唤醒单飞', () => {
    const mgr = mk()
    mgr.countdownUntil = 0
    const primary = { nextAt: 999990, bot: null }
    const partner = { nextAt: Infinity, bot: null, partner: true }
    mgr.hold = { slots: [primary, partner] }
    mgr.urgeNextPeek(0.8)
    expect(primary.nextAt).toBeCloseTo(10800, 6) // (10+0.8)s
    expect(partner.nextAt).toBe(Infinity)
  })
})
