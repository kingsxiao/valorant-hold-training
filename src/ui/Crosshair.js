import { crosshairColor, sanitizeCrosshair } from './crosshairCode.js'

// ============================================================================
// 准星：canvas 绘制，参数模型与游戏设置 1:1（见 crosshairCode.js）。
// 动态误差分两路（移动/开火），内外线各自按"开关 + 倍率"扩张——默认形态即游戏
// 原味：跑动外线张开（移动误差）、扫射内线张开（开火误差）；"开火时淡出"等
// Advanced 选项同样支持。帮助建立"急停-开枪"的时机感：收束完成才是出手时机。
//
// 渲染几何对齐游戏：
//  - 间距 offset = 中心到线段内缘的距离；带开火误差的线组静止时再 +4px 底距
//    （未开"误差叠加在间距上"时；这是游戏里开火误差线组的起始扩张位）
//  - 轮廓为逐元素方形框（thickness 0-6），所有框并成一条路径一次填充——
//    框与框相邻/重叠处不叠加加深（等价游戏 UI 的恒定不透明度行为）
//  - 中心点是边长 = dotSize 的正方形（游戏即方块，非圆点）
// ============================================================================

const SIZE = 640 // CSS px。半径 320 覆盖极端组合：offset20+length20+轮廓6+3倍跳跃误差
const DPR = typeof devicePixelRatio === 'number' ? Math.min(2, devicePixelRatio) : 1

// 把一组准星设置画到已就位的 2D 上下文（主准星与菜单预览共用）。
// 所有元素坐标相对 (cx,cy)；alphaScale 为整体淡出系数（开火/移动淡出用）
export function paintCrosshair(ctx, s, { movePx = 0, firePx = 0, alphaScale = 1, color, cx = 0, cy = 0 } = {}) {
  color ??= crosshairColor(s)
  const els = [] // {x,y,w,h,alpha}：中心点 + 内外线各四条
  if (s.dot && s.dotOpacity > 0 && s.dotSize > 0) {
    const z = s.dotSize
    els.push({ x: -z / 2, y: -z / 2, w: z, h: z, alpha: s.dotOpacity })
  }
  for (const name of ['inner', 'outer']) {
    const g = s[name]
    if (!g.show || g.opacity <= 0 || g.thickness <= 0) continue
    const gap = g.offset
      + (g.fireErr && !s.overrideFireOffset ? 4 : 0)
      + (g.moveErr ? movePx * g.moveMult : 0)
      + (g.fireErr ? firePx * g.fireMult : 0)
    const l = g.length, vl = g.linked ? g.length : g.vlength, t = g.thickness
    els.push({ x: -gap - l, y: -t / 2, w: l, h: t, alpha: g.opacity }) // 左
    els.push({ x: gap, y: -t / 2, w: l, h: t, alpha: g.opacity })      // 右
    els.push({ x: -t / 2, y: -gap - vl, w: t, h: vl, alpha: g.opacity }) // 上
    els.push({ x: -t / 2, y: gap, w: t, h: vl, alpha: g.opacity })     // 下
  }
  const sw = s.outlines ? s.outlineThickness : 0
  if (sw > 0 && s.outlineOpacity > 0) {
    ctx.globalAlpha = s.outlineOpacity * alphaScale
    ctx.fillStyle = '#000'
    ctx.beginPath()
    for (const e of els) {
      const x = cx + e.x, y = cy + e.y
      ctx.rect(x - sw, y - sw, sw, e.h + sw * 2)
      ctx.rect(x + e.w, y - sw, sw, e.h + sw * 2)
      ctx.rect(x, y - sw, e.w, sw)
      ctx.rect(x, y + e.h, e.w, sw)
    }
    ctx.fill()
  }
  ctx.fillStyle = color
  for (const e of els) {
    ctx.globalAlpha = e.alpha * alphaScale
    ctx.fillRect(cx + e.x, cy + e.y, e.w, e.h)
  }
  ctx.globalAlpha = 1
}

export class Crosshair {
  constructor(root) {
    this.el = document.createElement('canvas')
    this.el.id = 'crosshair'
    root.appendChild(this.el)
    this.el.width = SIZE * DPR
    this.el.height = SIZE * DPR
    this.el.style.width = this.el.style.height = SIZE + 'px'
    this.ctx = this.el.getContext('2d')
    this.ctx.scale(DPR, DPR)
    this.settings = sanitizeCrosshair({})
    this._sm = { move: 0, fire: 0, fadeF: 1, fadeM: 1 } // 平滑后的显示状态
    this._ads = { x: 0, y: 0 } // ADS 准星跟随（后坐弹道表偏移）平滑值
    this._lastT = 0
    this._lastSig = ''
    this._lastAdsSig = ''
    this.flashUntil = 0
    this._draw(true)
  }

  apply(patch) {
    this.settings = sanitizeCrosshair({ ...this.settings, ...patch })
    this._draw(true)
  }

  // 每帧喂入当前误差（度）：moveDeg=移动超额散布，fireDeg=连射增长散布。
  // 扩张瞬时可见（一开打/一动就亮"打不准"，信号不能迟滞）；收束缓 ~0.15s
  // 归位——停火重置的瞬间四线"啪"地合拢读作卡顿，缓动才读作精度恢复。
  // 淡出（Advanced 选项）：误差一激活整体趋向透明、恢复时渐显，各自 ~70ms
  update({ moveDeg = 0, fireDeg = 0 } = {}, fovVDeg, viewH) {
    const toPx = (deg) => Math.tan(deg * Math.PI / 360)
      / Math.max(1e-6, Math.tan(fovVDeg * Math.PI / 360)) * viewH * 0.5
    const tMove = toPx(moveDeg), tFire = toPx(fireDeg)
    const now = performance.now()
    const dt = Math.min(0.05, Math.max(0, (now - this._lastT) / 1000))
    this._lastT = now
    const ease = (cur, target, k) => target >= cur
      ? target // 只缓"收缩/恢复"方向
      : cur + (target - cur) * Math.min(1, dt * k)
    this._sm.move = ease(this._sm.move, tMove, 18)
    this._sm.fire = ease(this._sm.fire, tFire, 18)
    this._sm.fadeF = ease(this._sm.fadeF, this.settings.fadeFire && fireDeg > 0.04 ? 0 : 1, 14)
    this._sm.fadeM = ease(this._sm.fadeM, this.settings.fadeMove && moveDeg > 0.05 ? 0 : 1, 14)
    this._draw()
  }

  // ADS 准星跟随（维基 ADS 注记 "Crosshair follows recoil"）：WeaponSystem 把
  // 最近一发弹道表累计偏移按缩放后 FOV 投影成 px 喂进来，这里平移整个准星元素。
  // 平滑与误差扩张同款：外扩瞬时可见（跟上弹道不迟滞）、回中缓动（复位读作
  // 弹道恢复）。腰射喂 {0,0} —— 准星钉屏心（游戏腰射即如此）
  setAdsOffset({ x = 0, y = 0 }) {
    const now = performance.now()
    const dt = Math.min(0.05, Math.max(0, (now - this._lastT) / 1000))
    // 跟随方向瞬时、回中缓动（k=16 ≈ 60ms 级收拢）
    const ease = (cur, target) => Math.abs(target) >= Math.abs(cur)
      ? target
      : cur + (target - cur) * Math.min(1, dt * 16)
    this._ads.x = ease(this._ads.x, x)
    this._ads.y = ease(this._ads.y, y)
    const sig = this._ads.x.toFixed(1) + ',' + this._ads.y.toFixed(1)
    if (sig === this._lastAdsSig) return
    this._lastAdsSig = sig
    this.el.style.transform = `translate(calc(-50% + ${this._ads.x.toFixed(1)}px), calc(-50% + ${this._ads.y.toFixed(1)}px))`
  }

  _draw(force = false) {
    const flashK = Math.max(0, Math.min(1, (this.flashUntil - performance.now()) / 280))
    const sig = this._sm.move.toFixed(2) + ',' + this._sm.fire.toFixed(2) + ','
      + (this._sm.fadeF * this._sm.fadeM).toFixed(2) + ',' + flashK.toFixed(2)
    if (!force && sig === this._lastSig) return // 状态无变化不重绘
    this._lastSig = sig
    this.ctx.clearRect(0, 0, SIZE, SIZE)
    paintCrosshair(this.ctx, this.settings, {
      movePx: this._sm.move,
      firePx: this._sm.fire,
      alphaScale: this._sm.fadeF * this._sm.fadeM,
      color: flashK > 0 ? '#FFFFFF' : crosshairColor(this.settings), // 击杀闪白
      cx: SIZE / 2, cy: SIZE / 2,
    })
  }

  // 击杀瞬间准星闪白（命中确认；闪 280ms 后自然回落）
  flashKill() {
    this.flashUntil = performance.now() + 280
    this._draw()
  }
}
