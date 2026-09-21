// 结算面板直方图/趋势图 DPR 绘制回归锁：canvas 物理分辨率 ×DPR 后，绘制必须
// 走逻辑坐标系（setTransform(dpr) + 逻辑常量 680/96、680/70 = HTML 属性原值），
// 字号 '11px' 即 CSS 像素——旧实现按物理 canvas.width 布局，DPR2 屏经 CSS
// width:100% 拉回后字号只剩 ~5.5px 不可读。ResultPanel 构造依赖 DOM，node
// 环境无法整量实例化——_drawHist/_drawTrend 函数体从源码原样提取（非复刻），
// 绑定假 this（假 2D 上下文记账全部绘制调用）跑真实行为（prewarm-arrival 手法）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8')
const src = read('src/ui/ResultPanel.js')

// 提取方法体为独立函数（源码原样，仅把方法简写换成 function 声明）
const extract = (name) => {
  const m = src.match(new RegExp(`^  ${name}\\([\\s\\S]*?\\n  }`, 'm'))
  expect(m, `ResultPanel.js 应包含 ${name}`).toBeTruthy()
  return new Function(`return function ${m[0].trim().replace(/^_/, '')}`)()
}
const drawHist = extract('_drawHist')
const drawTrend = extract('_drawTrend')

// 假画布：记录全部绘制调用（方法调用与属性赋值，含 font/fillStyle）
const fakeCtx = () => {
  const calls = []
  const ctx = new Proxy({}, {
    get: (t, k) => k === '_calls' ? calls : (...a) => { calls.push([k, ...a]) },
    set: (t, k, v) => { calls.push([k, v]); return true },
  })
  return { ctx, calls }
}
const run = (fn, dpr, args) => {
  const { ctx, calls } = fakeCtx()
  fn.apply({
    hist: { getContext: () => ctx }, trend: { getContext: () => ctx },
    trendCap: { textContent: '' }, _dpr: dpr,
  }, args)
  return calls
}

describe('结算面板 canvas 绘制坐标系（逻辑坐标 = CSS 像素）', () => {
  const rs = [180, 220, 260, 300, 340, 420, 480, 550, 620, 700, 810, 950]
  const trend = [300, 450, 380, 500, 620, 580, 700, 760, 720, 810]

  it('绘制前 setTransform(dpr)：物理像素缩放全部由变换承担，DPR=2 与 DPR=1 的逻辑坐标完全一致', () => {
    for (const [fn, args, name] of [[drawHist, [rs, 420], '_drawHist'], [drawTrend, [trend], '_drawTrend']]) {
      const c1 = run(fn, 1, args), c2 = run(fn, 2, args)
      expect(c1[0], `${name} 首个调用应为 setTransform`).toEqual(['setTransform', 1, 0, 0, 1, 0, 0])
      expect(c2[0]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0])
      // DPR 只进变换：其余全部绘制调用（坐标/字号）逐位一致
      expect(c2.slice(1), name).toEqual(c1.slice(1))
    }
  })

  it('布局常量为逻辑尺寸：直方图 680×96 / 趋势 680×70（不随 DPR 放大 → DPR2 不会被双重放大溢出画布）', () => {
    const h = run(drawHist, 2, [rs, 420])
    expect(h).toContainEqual(['clearRect', 0, 0, 680, 96])
    const t = run(drawTrend, 2, [trend])
    expect(t).toContainEqual(['clearRect', 0, 0, 680, 70])
    // 所有矩形/文本锚点都落在逻辑画布内（物理 backing 1360×192，若按物理 W
    // 布局会双重放大 d 倍溢出 CSS 显示区）
    for (const calls of [h, t]) {
      for (const call of calls) {
        const [op] = call
        if (op !== 'fillRect' && op !== 'fillText' && op !== 'moveTo' && op !== 'lineTo') continue
        const [x, y] = op === 'fillText' ? [call[2], call[3]] : [call[1], call[2]]
        expect(typeof x === 'number', `${op} 应带数值坐标`).toBe(true)
        expect(x).toBeLessThanOrEqual(680)
        expect(y).toBeLessThanOrEqual(96)
      }
    }
  })

  it('字号即 CSS 像素：' + '11px 在 DPR=2 下显示为 11 物理逻辑像素（不再被 CSS 拉回成 ~5.5px）', () => {
    const h = run(drawHist, 2, [rs, 420])
    const fonts = h.filter(([op]) => op === 'font').map(([, f]) => f)
    expect(fonts.length).toBeGreaterThan(0)
    for (const f of fonts) expect(f).toMatch(/(^|\s)(10|11)px /)
  })
})
