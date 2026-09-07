import { describe, expect, it } from 'vitest'
import { BotManager } from '../src/entities/BotManager.js'

// Bot 出场侧（peekSide）：固定左/右练同向预瞄，random 保留两侧随机。
// 断言口径：x 小 = 玩家视角左（与菜单"缺口 · 左/右"同一坐标约定），
// 左侧藏点必 < gap.x0，右侧藏点必 > gap.x1
const GAP = { x0: -9, x1: -6 }

// 跑一次"已到期的波次排程"拿出场 Bot：stub Math.random 控制风格抽签
// （< crossChance=0.5 → cross 跑过；否则 pull 拉出）与 random 侧抽签
function spawnOnce(peekSide, randVal) {
  const bot = { peek: null, slot: null, place(x, z, mode) { this.placed = { x, z, mode } } }
  const mgr = {
    now: () => 0,
    params: { peekSide },
    map: { gaps: [GAP], peekLineZ: -23 },
    _bot: () => bot,
  }
  const slot = { nextAt: -1, bot: null } // 已排程且到期 → 立即出人
  const orig = Math.random
  Math.random = () => randVal
  try {
    BotManager.prototype._stepSlot.call(mgr, slot, 1 / 128)
  } finally {
    Math.random = orig
  }
  return { bot, slot }
}

describe('BotManager 出场侧 peekSide', () => {
  it("固定左侧：cross 从左墙后起跑（startX = x0 - 2.2，向右贯穿）", () => {
    const { bot, slot } = spawnOnce('left', 0) // 0 < 0.5 → cross
    expect(slot.bot).toBe(bot)
    expect(bot.peek.style).toBe('cross')
    expect(bot.peek.startX).toBeCloseTo(GAP.x0 - 2.2)
    expect(bot.peek.dir).toBe(1) // 左 → 右
    expect(bot.placed.x).toBeCloseTo(GAP.x0 - 2.2)
  })

  it("固定左侧：pull 从左墙后拉出（edge = x0，dir 朝缺口内 +1）", () => {
    const { bot } = spawnOnce('left', 0.99) // ≥ 0.5 → pull
    expect(bot.peek.style).toBe('pull')
    expect(bot.peek.dir).toBe(1)
    expect(bot.peek.startX).toBeGreaterThan(GAP.x0 - 2.4)
    expect(bot.peek.startX).toBeLessThan(GAP.x0 - 1.8)
  })

  it('固定右侧：cross 从右墙后起跑（startX = x1 + 2.2，向左贯穿）', () => {
    const { bot } = spawnOnce('right', 0)
    expect(bot.peek.style).toBe('cross')
    expect(bot.peek.startX).toBeCloseTo(GAP.x1 + 2.2)
    expect(bot.peek.dir).toBe(-1) // 右 → 左
  })

  it('固定右侧：pull 从右墙后拉出（edge = x1，dir 朝缺口内 -1）', () => {
    const { bot } = spawnOnce('right', 0.99)
    expect(bot.peek.style).toBe('pull')
    expect(bot.peek.dir).toBe(-1)
    expect(bot.peek.startX).toBeGreaterThan(GAP.x1 + 1.8)
    expect(bot.peek.startX).toBeLessThan(GAP.x1 + 2.4)
  })

  it('random：两侧都会出现（保留原读局训练行为）', () => {
    const sides = new Set()
    for (const randVal of [0.99, 0, 0.99, 0]) { // 0.99→pull 左 / 0→cross 右
      const { bot } = spawnOnce('random', randVal)
      sides.add(bot.peek.startX < GAP.x0 ? 'left' : 'right')
    }
    expect(sides.has('left')).toBe(true)
    expect(sides.has('right')).toBe(true)
  })

  it('固定侧下连出多波全部同侧（不因随机数漂移）', () => {
    for (let i = 0; i <= 10; i++) {
      const { bot } = spawnOnce('left', i / 10) // 扫过整个 [0,1] 随机数域
      expect(bot.peek.startX).toBeLessThan(GAP.x0)
    }
  })
})
