// HUD FPS 曲线单 path 合并填充（hud-fps-batch-fill）：150 柱同色，逐柱 fillRect
// 曾是每帧 150 次 canvas2D 调用（每秒 ~9000 次）——改为 beginPath + rect×N +
// 一次 fill。记账桩锁绘制调用形状（HUD 构造函数需 document，这里只取原型方法）
import { describe, expect, it } from 'vitest'
import { HUD } from '../src/ui/HUD.js'

function mkHud() {
  const hud = Object.create(HUD.prototype)
  const calls = { clearRect: 0, fillRect: [], beginPath: 0, rect: [], fill: 0 }
  hud.fpsFrames = new Array(150).fill(0)
  hud.fpsIdx = 0
  hud.fpsVisible = true
  hud._fpsDpr = 1
  hud.fpsCtx = {
    setTransform() {},
    clearRect() { calls.clearRect++ },
    fillStyle: '',
    fillRect: (...a) => calls.fillRect.push(a),
    beginPath() { calls.beginPath++ },
    rect: (...a) => calls.rect.push(a),
    fill() { calls.fill++ },
  }
  return { hud, calls }
}

describe('pushFps 曲线绘制（单 path 合并）', () => {
  it('150 柱合并为单次 beginPath+fill；柱位/高度随环形缓冲推进（时间从左到右）', () => {
    const { hud, calls } = mkHud()
    for (let i = 0; i < 150; i++) hud.pushFps(16.7) // 填满 60fps 柱
    calls.clearRect = 0
    calls.rect.length = 0
    calls.fillRect.length = 0
    calls.beginPath = 0
    calls.fill = 0
    hud.pushFps(16.7) // 全缓冲有效：一帧重绘
    expect(calls.clearRect).toBe(1)
    expect(calls.beginPath).toBe(1)
    expect(calls.rect).toHaveLength(150) // 150 柱进同一 path
    expect(calls.fill).toBe(1) // 恰一次填充
    expect(calls.fillRect).toEqual([[0, 30, 150, 1]]) // 唯一的 fillRect 是参考线
    // 柱几何：h = min(34, t/33.4×34) → 16.7ms 柱高 ≈17，y = 36−h
    const [x, y, w, h] = calls.rect[0]
    expect(x).toBe(0); expect(w).toBe(1)
    expect(h).toBeCloseTo(16.7 / 33.4 * 34, 6)
    expect(y).toBeCloseTo(36 - h, 6)
  })

  it('空槽（0 值）跳过不出 rect；隐藏面板只记录不绘制但环形索引照常推进', () => {
    const { hud, calls } = mkHud()
    hud.fpsFrames.fill(0)
    hud.pushFps(20)
    expect(calls.rect).toHaveLength(1) // 仅本帧一柱
    hud.fpsVisible = false
    const idxBefore = hud.fpsIdx
    calls.rect.length = 0
    calls.fill = 0
    hud.pushFps(25)
    expect(calls.rect).toHaveLength(0) // 隐藏：不绘制
    expect(calls.fill).toBe(0)
    expect(hud.fpsIdx).toBe((idxBefore + 1) % 150) // 缓冲照常推进（恢复显示有历史）
    expect(hud.fpsFrames[idxBefore]).toBe(25)
  })

  it('高帧时长钳到 34px（33.4ms 参考顶格），柱不越面板顶', () => {
    const { hud, calls } = mkHud()
    hud.fpsFrames.fill(0)
    hud.pushFps(200) // 严重卡顿帧
    const [, y, , h] = calls.rect[0]
    expect(h).toBe(34)
    expect(y).toBe(36 - 34)
  })
})
