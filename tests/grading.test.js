import { describe, expect, it } from 'vitest'
import { gradeFor, coachingTip, aimBiasDirection, aimPitchDirection, aimBiasSuffix } from '../src/core/stats.js'

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
  it('系统性偏左（样本≥3 且 |偏差|≥4°）→ 带方向的纠偏建议', () => {
    const tip = coachingTip({ kills: 6, duelsLost: 1, avgReactionMs: 400, reactStdMs: 80, accuracy: 60, shots: 20, hits: 12, headshotRate: 30, maxStreak: 2, aimSamples: 5, aimYawBiasDeg: 8.2, aimPitchBiasDeg: 0.5, aimErrorDeg: 9 })
    expect(tip).toContain('偏左')
    expect(tip).toContain('右移')
  })
  it('俯仰偏差更大时给偏高/偏低建议（取偏差更大的轴）', () => {
    const tip = coachingTip({ kills: 6, duelsLost: 1, avgReactionMs: 400, reactStdMs: 80, accuracy: 60, shots: 20, hits: 12, headshotRate: 30, maxStreak: 2, aimSamples: 4, aimYawBiasDeg: 1, aimPitchBiasDeg: -6, aimErrorDeg: 6.1 })
    expect(tip).toContain('偏低')
    expect(tip).toContain('上抬')
  })
  it('|偏差|<4° 不给方向建议，大幅值回落到原幅值规则', () => {
    const tip = coachingTip({ kills: 6, duelsLost: 1, avgReactionMs: 400, reactStdMs: 80, accuracy: 60, shots: 20, hits: 12, headshotRate: 30, maxStreak: 2, aimSamples: 5, aimYawBiasDeg: 2, aimPitchBiasDeg: 0, aimErrorDeg: 15 })
    expect(tip).toContain('缺口沿')
    expect(tip).not.toContain('偏左')
  })
  it('样本<3 不判方向（两三发定不了习惯）', () => {
    // 幅值规则同样要求样本≥3：样本不足时两条预瞄建议都不给（其余规则不满足 → null）
    const tip = coachingTip({ kills: 6, duelsLost: 1, avgReactionMs: 400, reactStdMs: 80, accuracy: 60, shots: 20, hits: 12, headshotRate: 30, maxStreak: 2, aimSamples: 2, aimYawBiasDeg: 9, aimPitchBiasDeg: 0, aimErrorDeg: 15 })
    expect(tip).toBeNull()
  })
})

// 方向判定的符号链路在此上用例锁死（指反即错）：
// Bot.js 采样 dyaw = p.yaw − yawTo；Player.applyMouse 鼠标右移（dx>0）yaw 递减
// —— yaw 增大 = 左转，故正偏航均值 = 准星系统性压在目标左侧 = 偏左；
// pitch 正 = 抬头（相机 rotation.x 正角抬视线向 +Y）→ 正俯仰均值 = 偏高
describe('aimBiasDirection / aimPitchDirection 预瞄方向判定', () => {
  it('正 yaw 偏差 = 偏左，负 = 偏右，零不判方向', () => {
    expect(aimBiasDirection(8)).toBe('偏左')
    expect(aimBiasDirection(-8)).toBe('偏右')
    expect(aimBiasDirection(0)).toBeNull()
  })
  it('正 pitch 偏差 = 偏高，负 = 偏低，零不判方向', () => {
    expect(aimPitchDirection(5)).toBe('偏高')
    expect(aimPitchDirection(-5)).toBe('偏低')
    expect(aimPitchDirection(0)).toBeNull()
  })
})

describe('aimBiasSuffix 方向化后缀（HUD 与结算共用拼法）', () => {
  it('样本够且偏差过阈值 → （偏左·偏高）形态；两轴独立过滤', () => {
    expect(aimBiasSuffix({ aimSamples: 5, aimYawBiasDeg: 6.2, aimPitchBiasDeg: 4.8 })).toBe('（偏左·偏高）')
    expect(aimBiasSuffix({ aimSamples: 5, aimYawBiasDeg: -6.2, aimPitchBiasDeg: 0.5 })).toBe('（偏右）')
  })
  it('样本不足或偏差低于 4° → 空串', () => {
    expect(aimBiasSuffix({ aimSamples: 2, aimYawBiasDeg: 9, aimPitchBiasDeg: 9 })).toBe('')
    expect(aimBiasSuffix({ aimSamples: 5, aimYawBiasDeg: 3.9, aimPitchBiasDeg: -3.9 })).toBe('')
    expect(aimBiasSuffix({})).toBe('')
  })
})
