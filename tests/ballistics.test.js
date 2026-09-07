import { describe, expect, it } from 'vitest'
import { CONFIG } from '../src/core/Config.js'
import { damageFor, spreadAt } from '../src/weapons/ballistics.js'
import { computeStats } from '../src/core/stats.js'

describe('damageFor 距离衰减', () => {
  const V = CONFIG.weapons.vandal
  const P = CONFIG.weapons.phantom

  it('Vandal 全距离不衰减', () => {
    for (const d of [1, 15, 30, 100, 249]) {
      expect(damageFor(V, 'head', d)).toBe(V.damage.head)
      expect(damageFor(V, 'body', d)).toBe(V.damage.body)
    }
  })

  it('Phantom 分段衰减命中正确档位（v9.10：20m 起 ×0.897）', () => {
    expect(damageFor(P, 'head', 10)).toBe(P.falloff[0].damage.head)   // ≤20m 原伤
    expect(damageFor(P, 'leg', 50)).toBe(P.falloff[1].damage.leg)     // ∞ 衰减档
  })

  it('档位边界（恰好 20m）取近档', () => {
    expect(damageFor(P, 'head', 20)).toBe(P.falloff[0].damage.head)
    expect(damageFor(P, 'head', 20.1)).toBe(P.falloff[1].damage.head)
  })

  it('Sheriff/Classic/Ghost 30m 起衰减档位（维基分距离伤害表）', () => {
    const S = CONFIG.weapons.sheriff, C = CONFIG.weapons.classic, G = CONFIG.weapons.ghost
    expect(damageFor(S, 'head', 29)).toBe(159)
    expect(damageFor(S, 'head', 31)).toBe(145)   // ×0.909
    expect(damageFor(S, 'body', 50)).toBe(50)
    expect(damageFor(C, 'body', 31)).toBe(22)    // ×0.846
    expect(damageFor(C, 'head', 29)).toBe(78)
    expect(damageFor(G, 'leg', 31)).toBe(21)
    expect(damageFor(G, 'leg', 29)).toBe(25)
  })

  it('未知部位回退 body 伤害', () => {
    expect(damageFor(V, 'tail', 5)).toBe(V.damage.body)
  })
})

describe('spreadAt 移动散布', () => {
  const V = CONFIG.weapons.vandal

  it('静止首发 = stand 值；全速 = run 值', () => {
    expect(spreadAt(V, { speedRatio: 0, crouched: false, grounded: true, sprayIndex: 0 })).toBeCloseTo(V.spread.stand)
    expect(spreadAt(V, { speedRatio: 1, crouched: false, grounded: true, sprayIndex: 0 })).toBeCloseTo(V.spread.run)
  })

  it('蹲下按 crouchMult 缩小；跳跃固定 jump 值（最高）', () => {
    const stand = spreadAt(V, { speedRatio: 0, crouched: false, grounded: true, sprayIndex: 0 })
    const crouch = spreadAt(V, { speedRatio: 0, crouched: true, grounded: true, sprayIndex: 0 })
    expect(crouch).toBeCloseTo(stand * V.spread.crouchMult)
    const jump = spreadAt(V, { speedRatio: 0.2, crouched: false, grounded: false, sprayIndex: 0 })
    expect(jump).toBe(V.spread.jump)
  })

  it('连射追加散布且封顶在 max（持续射击最大散布，公开表值）', () => {
    const s0 = spreadAt(V, { speedRatio: 0, crouched: false, grounded: true, sprayIndex: 0 })
    const s10 = spreadAt(V, { speedRatio: 0, crouched: false, grounded: true, sprayIndex: 10 })
    const s999 = spreadAt(V, { speedRatio: 0, crouched: false, grounded: true, sprayIndex: 999 })
    expect(s10).toBeCloseTo(s0 + 0.5)
    expect(s999).toBeCloseTo(V.spread.max)
  })

  it('走路（静步 62.8% 速）锚点精确命中 walk 值（分段曲线中间锚）', () => {
    expect(spreadAt(V, { speedRatio: CONFIG.movement.walkMult, crouched: false, grounded: true, sprayIndex: 0 })).toBeCloseTo(V.spread.walk)
  })

  it('蹲走叠加 crouchMove 惩罚：比蹲立大、比站走小', () => {
    const crouchStill = spreadAt(V, { speedRatio: 0, crouched: true, grounded: true, sprayIndex: 0 })
    const crouchMove = spreadAt(V, { speedRatio: CONFIG.movement.crouchMult, crouched: true, grounded: true, sprayIndex: 0 }) // 蹲姿满速
    const walk = spreadAt(V, { speedRatio: CONFIG.movement.walkMult, crouched: false, grounded: true, sprayIndex: 0 })
    expect(crouchMove).toBeCloseTo(V.spread.stand * V.spread.crouchMult + V.spread.crouchMove)
    expect(crouchMove).toBeGreaterThan(crouchStill)
    expect(crouchMove).toBeLessThan(walk)
  })

  it('速度比率被钳制在 [0,1]，越界不外推', () => {
    const over = spreadAt(V, { speedRatio: 5, crouched: false, grounded: true, sprayIndex: 0 })
    expect(over).toBeCloseTo(V.spread.run)
  })

  it('刀（melee）散布恒为 0', () => {
    expect(spreadAt(CONFIG.weapons.knife, { speedRatio: 1, crouched: false, grounded: false, sprayIndex: 9 })).toBe(0)
  })
})

describe('computeStats 统计口径', () => {
  it('空统计不产生 NaN，全部归零', () => {
    const c = computeStats({ shots: 0, hits: 0, headshots: 0, kills: 0, duelsLost: 0, reactions: [] })
    expect(c.accuracy).toBe(0)
    expect(c.headshotRate).toBe(0)
    expect(c.avgReactionMs).toBe(0)
    expect(c.bestReactionMs).toBe(0)
  })

  it('命中率/爆头率四舍五入为整数百分比', () => {
    const c = computeStats({ shots: 3, hits: 2, headshots: 1, kills: 1, duelsLost: 0, reactions: [212, 300, 488] })
    expect(c.accuracy).toBe(67)
    expect(c.headshotRate).toBe(50)
    expect(c.avgReactionMs).toBe(333)
    expect(c.bestReactionMs).toBe(212)
  })

  it('缺字段按 0 兜底（结算面板旧数据兼容）', () => {
    const c = computeStats({})
    expect(c.kills).toBe(0)
    expect(c.duelsLost).toBe(0)
  })
})
