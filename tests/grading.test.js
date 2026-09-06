import { describe, expect, it } from 'vitest'
import { gradeFor, coachingTip } from '../src/core/stats.js'

// 评级与训练建议的边界用例（锁定 gradeFor 分档线与 coachingTip 优先级）
describe('gradeFor 得分/分钟评级', () => {
  it('零分或非法分钟 → 不评级', () => {
    expect(gradeFor(0, 1)).toBe('—')
    expect(gradeFor(500, 0)).toBe('—')
    expect(gradeFor(500, -1)).toBe('—')
  })
  it('分档线含边界值', () => {
    expect(gradeFor(350, 1)).toBe('C')
    expect(gradeFor(349, 1)).toBe('D')
    expect(gradeFor(1000, 1)).toBe('S')
    expect(gradeFor(999, 1)).toBe('A')
  })
})

describe('coachingTip 训练建议', () => {
  it('零数据不给建议', () => {
    expect(coachingTip({ kills: 0, duelsLost: 0 })).toBeNull()
  })
  it('对枪败多于击杀 → 预瞄建议优先', () => {
    expect(coachingTip({ kills: 1, duelsLost: 3 })).toContain('准星预先')
  })
  it('反应波动大（≥160ms）→ 波动建议', () => {
    const tip = coachingTip({ kills: 5, duelsLost: 1, avgReactionMs: 400, reactStdMs: 200, accuracy: 60, shots: 20, hits: 12, headshotRate: 30, aimSamples: 0, maxStreak: 2 })
    expect(tip).toContain('波动')
  })
  it('反应与命中都在线 → 进阶建议', () => {
    const tip = coachingTip({ kills: 8, duelsLost: 1, avgReactionMs: 300, reactStdMs: 60, accuracy: 60, shots: 30, hits: 18, headshotRate: 40, aimSamples: 0, maxStreak: 4 })
    expect(tip).toContain('上限')
  })
})
