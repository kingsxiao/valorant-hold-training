// Engine.js 纯数值逻辑锁（engine-numeric-logic-untested）：33 个测试文件此前
// 无一 import Engine.js（唯一触点是 prewarm-arrival.test.js 的源码文本锁）——
// 构造函数 new WebGLRenderer 在 node 必抛是零覆盖根因。三段手写数值已抽纯函数
// （渲染装配不动）：固定步长过载保护 / fps+1% low 六槽部分选择 / 自适应分辨率
// 滞回——算错直接错 HUD 读数或来回抖分辨率
import { describe, expect, it } from 'vitest'
import { fixedStepRun, frameRateStats, adaptiveScaleNext } from '../src/core/Engine.js'

describe('fixedStepRun 固定步长循环', () => {
  it('整除消耗：余数保留、步数与 stepFn 参数（=fixedDt）正确', () => {
    const calls = []
    const { acc, steps } = fixedStepRun(0.05, 1 / 60, 8, (dt) => calls.push(dt))
    expect(steps).toBe(3)
    expect(acc).toBeCloseTo(0.05 - 3 / 60, 12)
    expect(calls).toEqual([1 / 60, 1 / 60, 1 / 60])
  })

  it('欠账不足一步：零步推进、accumulator 原样保留（renderFrame 插值不跳）', () => {
    const { acc, steps } = fixedStepRun(0.01, 1 / 60, 8, () => { throw new Error('不该跑') })
    expect(steps).toBe(0)
    expect(acc).toBeCloseTo(0.01, 12)
  })

  it('过载保护：跑满 maxSteps 仍欠账 → accumulator 清零（不跨帧快进追赶）', () => {
    const { acc, steps } = fixedStepRun(1, 1 / 60, 5, () => {})
    expect(steps).toBe(5)
    expect(acc).toBe(0)
  })

  it('maxSteps=0 退化配置：零步且 accumulator 清零（与原内联行为逐分支一致）', () => {
    const { acc, steps } = fixedStepRun(0.5, 1 / 60, 0, () => {})
    expect(steps).toBe(0)
    expect(acc).toBe(0)
  })
})

describe('frameRateStats 帧率与 1% low（六槽部分选择）', () => {
  it('fps = 有效帧均值倒数取整；无效帧（0=未填充槽）两口径都不计', () => {
    const s = frameRateStats([16.667, 16.667, 16.667, 0, 0])
    expect(s.n).toBe(3)
    expect(s.fps).toBe(60)
  })

  it('1% low 取最差 6 帧均值：600 帧 16.667ms 混 6 帧 100ms → fps 57 / 1% low 10', () => {
    const frames = Array.from({ length: 600 }, () => 16.667)
    for (const i of [5, 100, 200, 300, 400, 500]) frames[i] = 100
    const s = frameRateStats(frames)
    expect(s.fps).toBe(57) // 均值含 6 帧 100ms：1000/17.5 = 57.1
    expect(s.low1Pct).toBe(10)
  })

  it('部分选择与整段排序取尾部等价（乱序 600 帧对照参考实现）', () => {
    const frames = Array.from({ length: 600 }, (_, i) => 8 + ((i * 37) % 25)) // 8..32ms 伪随机
    const sorted = [...frames].sort((a, b) => b - a)
    const ref = Math.round(1000 / (sorted.slice(0, 6).reduce((a, b) => a + b, 0) / 6))
    expect(frameRateStats(frames).low1Pct).toBe(ref)
  })

  it('有效帧不足 6 槽：按实际帧数取均值（不虚拉低 1% low）；全空窗口三项归零', () => {
    const s = frameRateStats(Array.from({ length: 600 }, (_, i) => (i < 2 ? 50 : 0)))
    expect(s.low1Pct).toBe(20) // 仅 2 帧 50ms：1000/50
    const empty = frameRateStats(new Array(600).fill(0))
    expect(empty).toEqual({ n: 0, fps: 0, low1Pct: 0 })
  })

  it('平稳帧率不被惩罚：600 帧全 16.667ms → fps 与 1% low 同为 60', () => {
    const s = frameRateStats(Array.from({ length: 600 }, () => 16.667))
    expect(s.fps).toBe(60)
    expect(s.low1Pct).toBe(60)
  })
})

describe('adaptiveScaleNext 自适应分辨率滞回', () => {
  it('滞回带：fps 47 降档 / 48~57 不动 / 已满档不再升——写反阈值会来回抖分辨率（锁方向）', () => {
    expect(adaptiveScaleNext(1, 47)).toBeCloseTo(0.9, 9)
    expect(adaptiveScaleNext(1, 48)).toBe(1)
    expect(adaptiveScaleNext(1, 57)).toBe(1)
    expect(adaptiveScaleNext(1, 58)).toBe(1) // 满档无升幅
    expect(adaptiveScaleNext(0.9, 58)).toBeCloseTo(0.95, 9)
  })

  it('降档步长 0.10、0.6 下限不穿；低于步长的余量一步触底（0.65→0.6）', () => {
    expect(adaptiveScaleNext(0.75, 30)).toBeCloseTo(0.65, 9)
    expect(adaptiveScaleNext(0.65, 30)).toBe(0.6) // 0.55 < 下限 → 钳回 0.6（原实现既有语义）
    expect(adaptiveScaleNext(0.6, 20)).toBe(0.6)
    expect(adaptiveScaleNext(1, 10)).toBeCloseTo(0.9, 9)
  })

  it('升档步长 0.05、上限 1 不穿；fps=0（尚无结算帧）不动', () => {
    expect(adaptiveScaleNext(0.98, 60)).toBe(1)
    expect(adaptiveScaleNext(0.95, 120)).toBe(1)
    expect(adaptiveScaleNext(0.7, 0)).toBe(0.7)
  })
})
