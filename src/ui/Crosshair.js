import { clamp } from './util.js'

// 准星：DOM 绘制（四线 + 可选中心点/去上线），参数与游戏内准星设置对应
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
    }
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
    const mk = (cls) => { const d = document.createElement('div'); d.className = cls; el.appendChild(d); return d }
    const style = (d, w, h, x, y) => {
      d.style.width = w + 'px'; d.style.height = h + 'px'
      d.style.transform = `translate(${x}px, ${y}px)`
      d.style.background = s.color
      d.style.outline = s.outline ? '1px solid rgba(0,0,0,0.85)' : 'none'
    }
    const half = s.thickness / 2
    style(mk('ln'), s.length, s.thickness, s.gap, -half)                    // 右
    style(mk('ln'), s.length, s.thickness, -s.gap - s.length, -half)        // 左
    style(mk('ln'), s.thickness, s.length, -half, s.gap)                    // 下
    if (!s.tShape) style(mk('ln'), s.thickness, s.length, -half, -s.gap - s.length) // 上
    if (s.dot) {
      const d = mk('dot')
      const ds = clamp(s.thickness, 1, 5)
      d.style.width = d.style.height = ds + 'px'
      d.style.transform = `translate(${-ds / 2}px, ${-ds / 2}px)`
      d.style.background = s.color
    }
  }
}
