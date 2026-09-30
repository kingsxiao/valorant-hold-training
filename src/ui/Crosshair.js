import { crosshairColor, sanitizeCrosshair } from './crosshairCode.js'

// ============================================================================
// 准星：canvas 绘制，参数模型与游戏设置 1:1（见 crosshairCode.js）。
// 动态误差分两路（移动/开火），内外线各自按"开关 + 倍率"扩张——默认形态即游戏
// 原味：跑动外线张开（移动误差）、扫射内线张开（开火误差）；"开火时淡出"等
// Advanced 选项同样支持。帮助建立"急停-开枪"的时机感：收束完成才是出手时机。
//
// 渲染几何对齐游戏：
//  - 间距 offset = 中心到线段内缘的距离（所见即所得，0 = 四线贴住中心）
//  - 轮廓为逐元素方形框（thickness 0-6），所有框并成一条路径一次填充——
//    框与框相邻/重叠处不叠加加深（等价游戏 UI 的恒定不透明度行为）
//  - 中心点是边长 = dotSize 的正方形（游戏即方块，非圆点）
//  - 主画布每帧只清「上一帧 ∪ 本帧」笔迹包围盒（脏矩形），元素桶与包围盒用
//    模块级 scratch 复用——动态散布期每帧重绘也是零分配、小面积清屏
// ============================================================================

const SIZE = 640 // CSS px。半径 320 覆盖极端组合：offset20+length20+轮廓6+3倍跳跃误差
const DPR = typeof devicePixelRatio === 'number' ? Math.min(2, devicePixelRatio) : 1

// ---- paintCrosshair 的模块级暂存（主准星每帧调，128Hz 热路径同款零分配标准）----
// 元素桶：中心点 1 + 内外线各 4 = 最多 9 个，留余量到 12；包围盒随 _addEl 顺带累计
const _els = Array.from({ length: 12 }, () => ({ x: 0, y: 0, w: 0, h: 0, alpha: 0 }))
let _n = 0
let _bx0 = 0, _by0 = 0, _bx1 = 0, _by1 = 0 // 本帧笔迹包围盒（绝对坐标，含轮廓外扩）

function _addEl(x, y, w, h, alpha, cx, cy, sw) {
  const e = _els[_n++]
  e.x = x; e.y = y; e.w = w; e.h = h; e.alpha = alpha
  const l = cx + x - sw, t = cy + y - sw, r = cx + x + w + sw, b = cy + y + h + sw
  if (l < _bx0) _bx0 = l
  if (t < _by0) _by0 = t
  if (r > _bx1) _bx1 = r
  if (b > _by1) _by1 = b
}

// 把一组准星设置画到已就位的 2D 上下文（主准星与菜单预览共用）。
// 所有元素坐标相对 (cx,cy)；alphaScale 为整体淡出系数（开火/移动淡出用）。
// dirty（可选，调用者持有的 {x0,y0,x1,y1,has}）：落笔前只清「上一帧笔迹 ∪ 本帧
// 笔迹」的脏矩形并写回本帧包围盒——动态散布期笔迹只在中心百余像素内，避免 640²
// 全量 clearRect+整层合成；不传则不清屏（菜单预览自行铺背景）
export function paintCrosshair(ctx, s, { movePx = 0, firePx = 0, alphaScale = 1, color, cx = 0, cy = 0, dirty = null } = {}) {
  color ??= crosshairColor(s)
  const sw = s.outlines ? s.outlineThickness : 0
  _n = 0
  // 包围盒以中心点零面积初始化（准星恒中心对称 → 不影响有元素帧）：全关准星的
  // 零元素帧 bbox 不退化为 Infinity——上一帧笔迹才清得掉
  _bx0 = _bx1 = cx
  _by0 = _by1 = cy
  if (s.dot && s.dotOpacity > 0 && s.dotSize > 0) {
    const z = s.dotSize
    _addEl(-z / 2, -z / 2, z, z, s.dotOpacity, cx, cy, sw)
  }
  for (const name of ['inner', 'outer']) {
    const g = s[name]
    if (!g.show || g.opacity <= 0 || g.thickness <= 0) continue
    // 间距即所见：offset=0 时线内缘贴住中心（用户设置的间距就是真实间距——
    // 不再叠开火误差线组的隐藏底距，"间隔为零还有缝"曾由此而来）；误差扩张
    // （移动/开火）从 offset 之上按像素展开
    const gap = g.offset
      + (g.moveErr ? movePx * g.moveMult : 0)
      + (g.fireErr ? firePx * g.fireMult : 0)
    const l = g.length, vl = g.linked ? g.length : g.vlength, t = g.thickness
    // 长度为 0 的线整条不参与绘制（本体与轮廓一起消失）：社区点准心代码用
    // 0l;0 关线，只隐本体会在线位残留两侧轮廓竖条——游戏内该代码渲染为
    // 干净带边点准心（宽度/高度为 0 的矩形无面积，无渲染语义）
    if (l > 0) {
      _addEl(-gap - l, -t / 2, l, t, g.opacity, cx, cy, sw) // 左
      _addEl(gap, -t / 2, l, t, g.opacity, cx, cy, sw)      // 右
    }
    if (vl > 0) {
      _addEl(-t / 2, -gap - vl, t, vl, g.opacity, cx, cy, sw) // 上
      _addEl(-t / 2, gap, t, vl, g.opacity, cx, cy, sw)     // 下
    }
  }
  if (dirty) {
    // 脏矩形 = 上一帧 ∪ 本帧包围盒，外扩 2px 盖住 fillRect 半像素边界的抗锯齿
    // 溢出；写回本帧 bbox 供下一帧并集
    const x0 = Math.floor(Math.min(_bx0, dirty.has ? dirty.x0 : _bx0)) - 2
    const y0 = Math.floor(Math.min(_by0, dirty.has ? dirty.y0 : _by0)) - 2
    const x1 = Math.ceil(Math.max(_bx1, dirty.has ? dirty.x1 : _bx1)) + 2
    const y1 = Math.ceil(Math.max(_by1, dirty.has ? dirty.y1 : _by1)) + 2
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0)
    dirty.x0 = _bx0; dirty.y0 = _by0; dirty.x1 = _bx1; dirty.y1 = _by1
    dirty.has = true
  }
  if (sw > 0 && s.outlineOpacity > 0) {
    ctx.globalAlpha = s.outlineOpacity * alphaScale
    ctx.fillStyle = '#000'
    ctx.beginPath()
    for (let i = 0; i < _n; i++) {
      const e = _els[i]
      const x = cx + e.x, y = cy + e.y
      ctx.rect(x - sw, y - sw, sw, e.h + sw * 2)
      ctx.rect(x + e.w, y - sw, sw, e.h + sw * 2)
      ctx.rect(x, y - sw, e.w, sw)
      ctx.rect(x, y + e.h, e.w, sw)
    }
    ctx.fill()
  }
  ctx.fillStyle = color
  for (let i = 0; i < _n; i++) {
    const e = _els[i]
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
    this._dirty = { x0: 0, y0: 0, x1: 0, y1: 0, has: false } // 上一帧笔迹包围盒（脏矩形清屏，paintCrosshair 写回）
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
    // 淡入淡出双向缓动（k=14 ≈ 70ms）：ease 的 target>=cur 分支会让恢复（0→1）
    // 瞬跳回满不透明，与上方"恢复时渐显"的自述相反——停火准星"啪"地闪回
    const fade = (cur, target) => cur + (target - cur) * Math.min(1, dt * 14)
    this._sm.fadeF = fade(this._sm.fadeF, this.settings.fadeFire && fireDeg > 0.04 ? 0 : 1)
    this._sm.fadeM = fade(this._sm.fadeM, this.settings.fadeMove && moveDeg > 0.05 ? 0 : 1)
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
    // 清屏走脏矩形（paintCrosshair 内做：bbox 只有元素构建处知道）——只清「上帧
    // ∪ 本帧」笔迹区，不再 640² 全量 clearRect（动态散布期每帧全清是大头开销）
    paintCrosshair(this.ctx, this.settings, {
      movePx: this._sm.move,
      firePx: this._sm.fire,
      alphaScale: this._sm.fadeF * this._sm.fadeM,
      color: flashK > 0 ? '#FFFFFF' : crosshairColor(this.settings), // 击杀闪白
      cx: SIZE / 2, cy: SIZE / 2,
      dirty: this._dirty,
    })
  }

  // 击杀瞬间准星闪白（命中确认；闪 280ms 后自然回落）
  flashKill() {
    this.flashUntil = performance.now() + 280
    this._draw()
  }
}
