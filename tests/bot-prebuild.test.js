// Bot 池倒计时预建（bot-pool-lazy-build）：Bot 构造（骨架克隆+死亡烘焙+握点
// 顶点扫描）是几十 ms 级同步长帧，波次出场懒构建 = 每局前 ~cap 波各吃一次、
// 污染对枪期 1% low。现在 resetRound 排程、_stepHold 倒计时分支每 PREBUILD_GAP
// 分帧建满（含双拉余量），出场只做 place/_bot 复用。测试桩 _newBot 隔离真实
// 构造（Bot 构造需 three 场景），只锁预建的调度面
import { describe, expect, it } from 'vitest'
import { BotManager } from '../src/entities/BotManager.js'
import { Bot } from '../src/entities/Bot.js'
import { GAP_LEFT, SPAWN_Z } from '../src/world/corridor.js'

const DT = 1 / 128

// 预建调度桩：_newBot 记账不构造（记录构造时刻 mgr.t）；模板池临时改写（静态字段）用完还原
function mkMgr({ templates = null } = {}) {
  const mgr = Object.create(BotManager.prototype)
  const built = []
  mgr.t = 0
  mgr.now = () => mgr.t
  mgr.bots = []
  mgr.params = { roundSeconds: 0 } // resetRound 读 roundSeconds（0 = 无限局）
  mgr.audio = { roundStart() {} }
  mgr._newBot = () => { const b = { active: false, mode: 'idle', peek: { stale: 1 } }; built.push({ bot: b, at: mgr.t }); mgr.bots.push(b); return b }
  const saved = Bot.customTemplates
  Bot.customTemplates = templates
  return { mgr, built, restore: () => { Bot.customTemplates = saved } }
}

describe('倒计时窗口分帧预建 Bot 池', () => {
  it('resetRound 排程后：倒计时内每 ~0.4s 建一只，3s 窗口建满 cap=4（4 英雄池）', () => {
    const { mgr, built, restore } = mkMgr({ templates: [{}, {}, {}, {}] })
    try {
      mgr.resetRound()
      expect(mgr.countdownUntil).toBe(3)
      while (mgr.t < 3) { mgr.t += DT; mgr.step(DT, 1) }
      expect(built).toHaveLength(4) // 池满即停，双拉副槽在 cap=4 内够用
      expect(built[0].at).toBeGreaterThanOrEqual(0.3 - DT - 1e-9) // 首建避开 roundStart 同帧
      for (let k = 1; k < built.length; k++) {
        // 分帧不聚首：相邻构造间隔 ≥ PREBUILD_GAP−1 tick（尖峰摊进整个倒计时）
        expect(built[k].at - built[k - 1].at).toBeGreaterThanOrEqual(0.4 - DT - 1e-9)
      }
    } finally { restore() }
  })

  it('单模板/程序化假人（cap=1）也备到 2 只：双拉波第二人不懒建', () => {
    const { mgr, built, restore } = mkMgr({ templates: null })
    try {
      mgr.resetRound()
      while (mgr.t < 3) { mgr.t += DT; mgr.step(DT, 1) }
      expect(built).toHaveLength(2)
    } finally { restore() }
  })

  it('池满后不再建；倒计时结束（GO 后）预建停止——对枪期绝不构造', () => {
    const { mgr, built, restore } = mkMgr({ templates: [{}, {}] })
    try {
      mgr.resetRound()
      while (mgr.t < 3) { mgr.t += DT; mgr.step(DT, 1) }
      const n = built.length
      expect(n).toBe(2)
      mgr.t = 3.5 // GO：倒计时结束
      mgr.step(DT, 1)
      mgr.step(DT, 1)
      expect(built).toHaveLength(n) // 出场期零构造（波次出场走 _bot 复用预建）
      expect(mgr.hold).not.toBeNull() // GO 后正常进波次调度
    } finally { restore() }
  })

  it('出场 _bot() 复用预建 Bot（清 peek 脏状态）；池空仍可懒建（模板中途扩容路径）', () => {
    const { mgr, built, restore } = mkMgr({ templates: [{}] })
    try {
      mgr.resetRound()
      while (mgr.t < 3) { mgr.t += DT; mgr.step(DT, 1) }
      expect(built).toHaveLength(2)
      const reused = mgr._bot()
      expect(built).toHaveLength(2) // 池有休眠 → 不新建
      expect(reused.peek).toBeNull() // 上一条命的管理器状态已清
      // 模板中途扩容：cap 2→3，池满不预建、出场 _bot() 惰性补第 3 只
      Bot.customTemplates = [{}, {}, {}]
      mgr.params = { peekSide: 'left', botDistance: 13 }
      mgr.map = { gaps: [GAP_LEFT], spawn: { z: SPAWN_Z } }
      mgr.hold = { slots: [{ nextAt: 1e9, bot: null }] } // 不进波次，只测 _bot
      const extra = mgr._bot()
      expect(built).toHaveLength(3)
      expect(mgr.bots).toContain(extra)
    } finally { restore() }
  })
})
