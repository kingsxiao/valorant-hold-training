import { clamp } from './util.js'

// 准星：DOM 绘制（四线 + 可选中心点/去上线），参数与游戏内准星设置对应
// 动态误差（error）：随当前武器散布实时扩张间距 —— 移动/跳跃/连射时肉眼可见"打不准"，
// 帮助建立"急停-开枪"的时机感（对应游戏内"开火误差"显示选项）
export class Crosshair {
  constructor(root) {
    this.el = document.createElement('div')
    this.el.id = 'crosshair'
    root.appendChild(this.el)
    this.settings = {
      color: '#00ffb3',
      length: 5,     // 线长 px
      thickness: 2,  // 线粗 px
      gap: 3,        // 中心距 px
      outline: true,
      dot: false,
      tShape: false, // 去上线
      error: true,   // 动态误差可视化
    }
    this.spreadPx = 0
    this._appliedPx = -1
    this.render()
  }

  apply(patch) {
    Object.assign(this.settings, patch)
    this.render()
  }

  render() {
    const s = this.settings
    const el = this.el
    el.innerHTML = ''
    this.lines = []
    const mk = (cls) => { const d = document.createElement('div'); d.className = cls; el.appendChild(d); return d }
    const style = (d, w, h, x, y, dx, dy) => {
      d.style.width = w + 'px'; d.style.height = h + 'px'
      d.style.background = s.color
      d.style.outline = s.outline ? '1px solid rgba(0,0,0,0.85)' : 'none'
      d.dataset.bx = x  // 基础偏移
      d.dataset.by = y
      d.dataset.dx = dx // 扩张方向（单位向量）
      d.dataset.dy = dy
      this.lines.push(d)
    }
    const half = s.thickness / 2
    style(mk('ln'), s.length, s.thickness, s.gap, -half, 1, 0)                    // 右
    style(mk('ln'), s.length, s.thickness, -s.gap - s.length, -half, -1, 0)       // 左
    style(mk('ln'), s.thickness, s.length, -half, s.gap, 0, 1)                    // 下
    if (!s.tShape) style(mk('ln'), s.thickness, s.length, -half, -s.gap - s.length, 0, -1) // 上
    if (s.dot) {
      const d = mk('dot')
      const ds = clamp(s.thickness, 1, 5)
      d.style.width = d.style.height = ds + 'px'
      d.style.transform = `translate(${-ds / 2}px, ${-ds / 2}px)`
      d.style.background = s.color
    }
    this._appliedPx = -1
    this._applySpread(true)
  }

  // 当前散布换算成屏幕像素（main 每帧调用；spreadDeg 为锥形散布半角）
  setSpread(spreadDeg, fovVDeg, viewH) {
    this.spreadPx = (spreadDeg > 0 && this.settings.error)
      ? Math.tan(spreadDeg * Math.PI / 360) / Math.max(1e-6, Math.tan(fovVDeg * Math.PI / 360)) * viewH * 0.5
      : 0
    this._applySpread()
  }

  _applySpread(force = false) {
    const px = this.spreadPx
    if (!force && Math.abs(px - this._appliedPx) < 0.5) return // <0.5px 不写 DOM，避免每帧重排
    this._appliedPx = px
    for (const d of this.lines ?? []) {
      const bx = +d.dataset.bx, by = +d.dataset.by, dx = +d.dataset.dx, dy = +d.dataset.dy
      d.style.transform = `translate(${bx + dx * px}px, ${by + dy * px}px)`
    }
  }

  // 击杀瞬间准星闪白（命中确认；CSS 动画自带回落）
  flashKill() {
    this.el.classList.remove('kill-flash')
    void this.el.offsetWidth
    this.el.classList.add('kill-flash')
  }
}
