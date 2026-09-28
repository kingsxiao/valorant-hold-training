import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BotManager } from '../src/entities/BotManager.js'
import { CONFIG } from '../src/core/Config.js'

// 「Bot 距离」botDistance（单位米，绝对距离非倍率）：玩家出生架枪位（map.spawn.z）
// 到 Bot 出场横移线 z 的距离——z = spawn.z − botDistance，再钳走廊硬域
// [−35.2, −25.2]（门墙远面 −24.8 / 后墙内面 −35.6 + 模型余量）。
// 锁五件事（测试计划 a-f）：
//  (a)(b)(c) 距离→z 换算 / 走廊硬钳 / 与旧 peekLineZ 字段解耦（单一事实源迁移）
//  (d) 藏点楔形外扩 _hideOff：可见楔形半宽 = hw·D/7.8，藏点在楔形外留 0.5m
//  (e) 双拉同线 + cross 副 Bot 终点回贴主 Bot 终点（副端点楔形不变量）
//  (f) 接线锁：滑条 → applyAll → params → place 全链，旧消费点不得恢复
const GAP = { x0: -9, x1: -6 }  // 左窄口（MapBuilder 训练不变量，hw=1.5）
const GAP_R = { x0: 3, x1: 7 }  // 右宽口（hw=2：楔形外扩最先起效的口）
const SPAWN_Z = -17             // 出生架枪位（MapBuilder.js:284 固定）
const TO_WALL = SPAWN_Z - -24.8 // spawn.z − 门墙远面 = 7.8（楔形投影分母）

// 楔形几何：深度 D 处玩家透过缺口看到的可见楔形横向半宽 / 两端外余量（带方向）
const gapCx = (gap) => (gap.x0 + gap.x1) / 2
const gapHw = (gap) => (gap.x1 - gap.x0) / 2
const wedgeHw = (gap, D) => gapHw(gap) * D / TO_WALL
const hideOff = (gap, D) => Math.max(2.2, gapHw(gap) * (D - TO_WALL) / TO_WALL + 0.5)
// cross 波终点余量：dir>0 终点在右楔形边外侧，dir<0 镜像到左楔形边
const endMargin = (pk, gap, D) => pk.dir > 0
  ? pk.endX - (gapCx(gap) + wedgeHw(gap, D))
  : (gapCx(gap) - wedgeHw(gap, D)) - pk.endX
// cross 波起点余量：起点在出发侧楔形边外侧（与终点对侧）
const startMargin = (pk, gap, D) => pk.dir > 0
  ? (gapCx(gap) - wedgeHw(gap, D)) - pk.startX
  : pk.startX - (gapCx(gap) + wedgeHw(gap, D))

// 跑一次"已到期的波次排程"拿出场 Bot（peek-side.test.js spawnOnce 同款模板）：
// stub Math.random 常数控制风格抽签（<0.5 cross / ≥0.5 pull）；无 hold → 双拉分支
// 不触发（partner undefined）。stub 必须走原型链（peek-delay.test.js 纪律）：
// _stepSlot 调 this._peekZ()/_hideOff() 原型方法，字面量对象链上找不到。
// peekSide 决定出发侧（右宽口楔形外扩场景从右墙后出）；mapExtra 用于喂死键
// peekLineZ 验证解耦
function spawnOnce(gap, D, randVal, peekSide = 'left', mapExtra = {}) {
  const bot = { peek: null, slot: null, place(x, z, mode) { this.placed = { x, z, mode } } }
  const mgr = Object.create(BotManager.prototype)
  mgr.now = () => 0
  mgr.params = { peekSide, botDistance: D }
  mgr.map = { gaps: [gap], spawn: { z: SPAWN_Z }, ...mapExtra }
  mgr._bot = () => bot
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

// 出一波双拉（peek-double.test.js spawnWave 同款模板）：Math.random 用队列喂——
// cross 波两发（风格抽签 + 双拉掷骰）、pull 波五发（风格/藏点/折返/jiggle/双拉，
// 桩无 anim → 蹲走掷骰短路不消耗）。peekSide 决定出发侧
function spawnDouble(gap, D, queue, peekSide = 'left') {
  const bots = []
  const mgr = Object.create(BotManager.prototype)
  mgr.now = () => 0
  mgr.params = { peekSide, botDistance: D }
  mgr.map = { gaps: [gap], spawn: { z: SPAWN_Z } }
  mgr._bot = () => {
    const b = { peek: null, slot: null, place(x, z, mode) { this.placed = { x, z, mode } } }
    bots.push(b); return b
  }
  const slot = { nextAt: -1, bot: null, lastStyles: [] }
  const partner = { nextAt: Infinity, bot: null, partner: true }
  mgr.hold = { slots: [slot, partner] }
  const orig = Math.random
  Math.random = () => queue.shift() ?? 0.99
  try {
    mgr._stepSlot(slot, 1 / 128)
  } finally {
    Math.random = orig
  }
  return { bots, slot, partner, mgr }
}

// ---- (a) 距离 → z 换算 ----
describe('botDistance → 横移线 z 换算', () => {
  it('D=16（新默认）→ z=−33：cross 与 pull 两种风格同一条横移线', () => {
    expect(spawnOnce(GAP, 16, 0).bot.placed.z).toBe(SPAWN_Z - 16)    // rand 0<0.5 → cross
    expect(spawnOnce(GAP, 16, 0.99).bot.placed.z).toBe(SPAWN_Z - 16) // rand ≥0.5 → pull
  })

  it('滑杆两端：D=9 → z=−26（门墙侧近距离快反）；D=18 → z=−35（贴走廊底）', () => {
    expect(spawnOnce(GAP, 9, 0).bot.placed.z).toBe(-26)
    expect(spawnOnce(GAP, 18, 0.99).bot.placed.z).toBe(-35)
  })
})

// ---- (b) 走廊硬钳（运行时层；菜单 NUM [9,18] 之外的兜底）----
describe('走廊硬钳（运行时层）', () => {
  it('D=30（远越界）钳到后墙侧 −35.2；D=5（近越界）钳到门墙侧 −25.2', () => {
    expect(spawnOnce(GAP, 30, 0).bot.placed.z).toBe(-35.2)
    expect(spawnOnce(GAP, 5, 0).bot.placed.z).toBe(-25.2)
  })
})

// ---- (c) 与旧 peekLineZ 字段解耦（单一事实源迁移完成）----
describe('与旧 peekLineZ 字段解耦', () => {
  it('map 残留死键 peekLineZ 时 z 仍 = spawn.z − D（旧字段不再被消费）', () => {
    const { bot } = spawnOnce(GAP, 16, 0, { peekLineZ: -23 })
    expect(bot.placed.z).toBe(SPAWN_Z - 16)
  })
})

// ---- (d) 藏点楔形外扩 _hideOff ----
describe('藏点楔形外扩 _hideOff', () => {
  it('D=13 右宽口（从右墙后出）：外扩不触发，cross 起点 = x1+2.2（旧固定常量口径原值保留）', () => {
    const { bot } = spawnOnce(GAP_R, 13, 0, 'right')
    expect(bot.peek.startX).toBeCloseTo(GAP_R.x1 + 2.2, 9)
    expect(hideOff(GAP_R, 13)).toBe(2.2) // 13m 下 max(2.2, 1.833) 仍取旧常量
  })

  it('D=18 右宽口（从右墙后出）：起点外扩到 ≈x1+3.115，楔形外余量恒 ≈0.5（设计余量勿改小）', () => {
    const { bot } = spawnOnce(GAP_R, 18, 0, 'right')
    expect(bot.peek.startX).toBeCloseTo(GAP_R.x1 + hideOff(GAP_R, 18), 9)
    expect(hideOff(GAP_R, 18)).toBeCloseTo(3.115, 3)
    // 不变量：startX − (gapCx + hw·D/7.8) ≈ 0.5（楔形边外余量恒定）
    expect(bot.peek.startX - (gapCx(GAP_R) + wedgeHw(GAP_R, 18))).toBeCloseTo(0.5, 6)
  })

  it('pull 任意随机数下起点 ≥ 出发侧楔形外（offset floor 生效，藏点不落楔形内）', () => {
    for (const r of [0.5, 0.66, 0.99]) {
      // 13m 右宽口：hide=2.2 抬住 rand 窗下段（r=0.5 的 rand=2.1 必被抬到 2.2）
      const a = spawnOnce(GAP_R, 13, r, 'right').bot
      expect(a.peek.startX).toBeGreaterThanOrEqual(GAP_R.x1 + hideOff(GAP_R, 13) - 1e-9)
      // 18m 右宽口：hide=3.115 > 窗上限 2.4，起点恒在楔形外 0.5m
      const b = spawnOnce(GAP_R, 18, r, 'right').bot
      expect(b.peek.startX).toBeCloseTo(GAP_R.x1 + hideOff(GAP_R, 18), 9)
      expect(b.peek.startX - (gapCx(GAP_R) + wedgeHw(GAP_R, 18))).toBeGreaterThanOrEqual(0.5 - 1e-9)
    }
  })
})

// ---- (e) 双拉同线 + 副 Bot 端点楔形不变量 ----
describe('双拉同线 + 副端点楔形不变量', () => {
  it('cross 双拉：两人同一条横移线（placed.z 相同且 = spawn.z − D）', () => {
    const { bots } = spawnDouble(GAP, 16, [0, 0]) // 风格 0→cross / 双拉 0<0.18 掷中
    expect(bots.length).toBe(2)
    expect(bots[0].placed.z).toBe(SPAWN_Z - 16)
    expect(bots[1].placed.z).toBe(SPAWN_Z - 16)
  })

  it('cross 双拉副 Bot：终点回贴主 Bot 终点，且两端都在楔形外 ≥0.5m（D=16/18 × 左窄/右宽口）', () => {
    // 本次评审缺口的回归锁：沿行进方向平移 −0.9 会把副端点推进楔形
    // （右宽口从右出 16m 时不回贴余量恰 −0.400、13m −0.033 贴边）→ 终点共享主
    // Bot 终点。右宽口用 peekSide right 复现该最坏场景
    for (const [gap, side] of [[GAP, 'left'], [GAP_R, 'right']]) {
      for (const D of [16, 18]) {
        const { bots } = spawnDouble(gap, D, [0, 0], side)
        const [b1, b2] = bots
        expect(b2.peek.endX).toBe(b1.peek.endX) // 终点回贴（不随 −LANE 平移）
        expect(endMargin(b2.peek, gap, D)).toBeGreaterThanOrEqual(0.5 - 1e-9)
        expect(startMargin(b2.peek, gap, D)).toBeGreaterThanOrEqual(0.5 - 1e-9)
      }
    }
  })

  it('pull 双拉：副位起点/折返/终点同差 −LANE（沿 −dir 深入藏侧，楔形外无需改）', () => {
    // 队列：0.99→pull；藏点 rand(1.8,2.4)=2.394；折返 rand(0,0.9)=0.891；
    // 0.99≥0.3 无 jiggle（桩无 anim → 蹲走掷骰短路不消耗）；0→双拉掷中
    const { bots } = spawnDouble(GAP, 16, [0.99, 0.99, 0.99, 0.99, 0])
    expect(bots.length).toBe(2)
    const [b1, b2] = bots
    expect(b2.peek.style).toBe('pull')
    expect(b2.peek.startX).toBeCloseTo(b1.peek.startX - 0.9, 9)
    expect(b2.peek.turnX).toBeCloseTo(b1.peek.turnX - 0.9, 9)
    expect(b2.peek.endX).toBeCloseTo(b1.peek.endX - 0.9, 9)
    expect(b1.placed.z).toBe(b2.placed.z)
  })
})

// ---- (f) 接线锁（readFileSync 手法同 weapon-skin.test.js）----
describe('botDistance 接线锁（滑条 → applyAll → params → place）', () => {
  const read = (p) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8')

  it('Menu 滑条：data-key="botDistance"，域 min=9 max=18 step=0.5', () => {
    const src = read('src/ui/Menu.js')
    expect(src).toContain('data-key="botDistance"')
    expect(src).toContain('min="9" max="18" step="0.5"')
  })

  it('main applyAll：bots.params.botDistance = cfg.botDistance（实时生效链）', () => {
    const src = read('src/main.js')
    const applyAll = src.slice(src.indexOf('menu.applyAll = () => {'), src.indexOf('menu.applyAll()'))
    expect(applyAll).toContain('bots.params.botDistance = cfg.botDistance')
  })

  it('BotManager：params 同源初值 + spawn.z 换算在位；旧 peekLineZ 消费点不得恢复', () => {
    const src = read('src/entities/BotManager.js')
    expect(src).toContain('botDistance: CONFIG.training.botDistance')
    expect(src).toContain('this.map.spawn.z')
    expect(src, '旧横移线字段已删（单一事实源=botDistance），恢复需同步改本锁').not.toContain('this.map.peekLineZ')
  })

  it('CONFIG 默认 16 与菜单滑条域自洽（默认值落在 [9,18] 内、步进 0.5 可精确表达）', () => {
    const d = CONFIG.training.botDistance
    expect(d).toBeGreaterThanOrEqual(9)
    expect(d).toBeLessThanOrEqual(18)
    expect((d * 2) % 1).toBe(0) // 0.5 步进的整数倍
  })
})
