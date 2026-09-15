import { describe, expect, it } from 'vitest'
import { BotManager } from '../src/entities/BotManager.js'

// Bot 出场间隔三段式掷法（166 轮）：快速补拉 [bMin,bMax] 十八成 + 短段
// [dMin,mid] 五十七成 + 长段 [mid,dMax] 二十五成——补拉段模拟队友即刻跟上
// （双拉/补位节奏），且随 dMin 缩放，不越权推翻拖慢的滑条。
// 断言口径：nextAt - nowMs = 下一波出场延迟；stub Math.random 定值控制段选与
// 段内位置（同值复用于段选与 rand 内部：< 0.18 补拉 / < 0.75 短段 / 其余长段）
const D_MIN = 400, D_MAX = 1400, MID = D_MIN + (D_MAX - D_MIN) * 0.45 // 850
const B_MIN = Math.max(150, D_MIN * 0.45), B_MAX = Math.max(B_MIN + 80, D_MIN * 0.7) // 180/280

// stub 必须走 Object.create(BotManager.prototype)：_rampDelay/_rampKills 是原型
// getter，普通字面量对象链上找不到 → undefined → nextAt=NaN（排程永不触发）
function scheduleDelay(randVal, params = {}, stats = null) {
  const mgr = Object.create(BotManager.prototype)
  mgr.now = () => 12.5
  mgr.params = { delayMin: D_MIN, delayMax: D_MAX, ...params }
  if (stats) mgr.stats = stats
  mgr._bot = () => { throw new Error('排程步不应出场') }
  const slot = { nextAt: 0, bot: null } // 未排程 → 走掷法分支
  const orig = Math.random
  Math.random = () => randVal
  try {
    mgr._stepSlot(slot, 1 / 128)
  } finally {
    Math.random = orig
  }
  return slot.nextAt - 12500
}

describe('BotManager 出场间隔三段式掷法', () => {
  it('快速补拉段（<0.18）：延迟在 [bMin,bMax]，比 dMin 更短（双拉/补位节奏）', () => {
    expect(scheduleDelay(0)).toBeCloseTo(B_MIN, 6)
    expect(scheduleDelay(0.1)).toBeCloseTo(B_MIN + 0.1 * (B_MAX - B_MIN), 6)
    expect(scheduleDelay(0.17)).toBeLessThan(B_MAX)
    expect(B_MAX).toBeLessThan(D_MIN) // 补拉段确实落在 dMin 之下
  })

  it('随机数落短段（0.18-0.75）：延迟在 [dMin, mid]，段内随随机数连续变化', () => {
    expect(scheduleDelay(0.18)).toBeCloseTo(D_MIN + 0.18 * (MID - D_MIN), 6)
    expect(scheduleDelay(0.5)).toBeCloseTo(D_MIN + 0.5 * (MID - D_MIN), 6)
    expect(scheduleDelay(0.74)).toBeGreaterThan(D_MIN)
    expect(scheduleDelay(0.74)).toBeLessThan(MID)
  })

  it('随机数落长段（≥0.75）：延迟在 [mid, dMax]，最长不超过 dMax（不干等）', () => {
    expect(scheduleDelay(0.75)).toBeCloseTo(MID + 0.75 * (D_MAX - MID), 6)
    expect(scheduleDelay(0.99)).toBeLessThan(D_MAX)
    expect(scheduleDelay(0.99)).toBeGreaterThan(MID)
  })

  it('三段都可达（非固定间隔）：不同随机数产出不同延迟且都在 [bMin, dMax]', () => {
    const delays = new Set([0, 0.1, 0.3, 0.5, 0.74, 0.8, 0.99].map(r => Math.round(scheduleDelay(r))))
    expect(delays.size).toBe(7)
    for (const d of delays) { expect(d).toBeGreaterThanOrEqual(B_MIN); expect(d).toBeLessThanOrEqual(D_MAX) }
  })

  it('渐进难度缩短区间但 250ms 保底仍在（补拉段随 dMin 同步缩到 150 保底）', () => {
    // 10 杀 ×0.93 → 系数 ~0.484：dMin 触 250 保底，dMax = 1400×0.484 ≈ 677
    expect(scheduleDelay(0, { rampUp: true }, { kills: 10 })).toBeCloseTo(150, 6)
    const dShort = scheduleDelay(0.5, { rampUp: true }, { kills: 10 })
    expect(dShort).toBeGreaterThanOrEqual(250)
    const dLong = scheduleDelay(0.99, { rampUp: true }, { kills: 10 })
    const dMax = Math.max(250 + 100, D_MAX * Math.pow(0.93, 10))
    expect(dLong).toBeLessThanOrEqual(dMax + 1e-6)
  })

  it('滑条拖慢（delayMin 升到 1000）：补拉段随 dMin 缩放（450-700），不是固定 180', () => {
    expect(scheduleDelay(0, { delayMin: 1000, delayMax: 1000 })).toBeCloseTo(450, 6)
    const bMax = Math.max(450 + 80, 1000 * 0.7)
    expect(scheduleDelay(0.17, { delayMin: 1000, delayMax: 1000 })).toBeLessThan(bMax)
    // delayMax ≤ delayMin 退化：主段仍有 ≥100ms 随机展布
    expect(scheduleDelay(0.5, { delayMin: 1000, delayMax: 1000 })).toBeCloseTo(1000 + 0.5 * 45, 6)
    expect(scheduleDelay(0.99, { delayMin: 1000, delayMax: 1000 })).toBeLessThanOrEqual(1100)
  })
})
