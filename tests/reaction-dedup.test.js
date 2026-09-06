import { describe, expect, it } from 'vitest'
import { BotManager } from '../src/entities/BotManager.js'

// 反应时间统计去重：多发击杀只记第一发的反应（回归：曾把 3 发击杀记 3 条
// 几乎相同的样本，把均值拖慢、最快反应刷假纪录）
describe('BotManager.damage 反应样本去重', () => {
  function managerWithBot() {
    const mgr = { now: () => 1.5, audio: { hitMark: () => {} }, stats: { reactions: [], lastReaction: 0, hits: 0, headshots: 0, kills: 0 } }
    // 只用到 damage() 依赖的字段；bot 模拟"已可见 0.5s"的状态
    const bot = { firstVisibleAt: 1.0, reactRecorded: false, hp: 100, invulnerable: false,
      flashHit: () => {}, startDeath: () => {} }
    return { mgr, bot }
  }

  it('同一 Bot 多次命中只记一条反应样本', () => {
    const { mgr, bot } = managerWithBot()
    const proto = BotManager.prototype
    proto.damage.call(mgr, bot, 40, 'body')
    proto.damage.call(mgr, bot, 40, 'body')
    const killed = proto.damage.call(mgr, bot, 40, 'body') // 致命一击
    expect(killed).toBe(true)
    expect(mgr.stats.hits).toBe(3)
    expect(mgr.stats.reactions).toHaveLength(1)
    expect(mgr.stats.reactions[0]).toBe(500) // (1.5 - 1.0) * 1000
  })

  it('Bot 重新出场后（reactRecorded 复位）可再记新样本', () => {
    const { mgr, bot } = managerWithBot()
    const proto = BotManager.prototype
    proto.damage.call(mgr, bot, 999, 'head')
    expect(mgr.stats.reactions).toHaveLength(1)
    bot.reactRecorded = false // place() 里的复位
    bot.firstVisibleAt = 1.2
    proto.damage.call(mgr, bot, 999, 'head')
    expect(mgr.stats.reactions).toHaveLength(2)
    expect(mgr.stats.reactions[1]).toBe(300)
  })

  it('不可见（firstVisibleAt=-1）命中不记反应', () => {
    const { mgr, bot } = managerWithBot()
    bot.firstVisibleAt = -1
    BotManager.prototype.damage.call(mgr, bot, 999, 'head')
    expect(mgr.stats.reactions).toHaveLength(0)
  })
})
