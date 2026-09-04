// 回合结算面板：与设置面板（Menu）分离的独立结算界面
// 回合结束 → show(stats)；「再来一局」重开 / 「调整设置」回到 Menu
import { computeStats, coachingTip, gradeFor } from '../core/stats.js'

export class ResultPanel {
  constructor({ overlay, onRestart, onSettings }) {
    this.overlay = overlay
    this.onRestart = onRestart   // () => void
    this.onSettings = onSettings // () => void
    this.build()
  }

  build() {
    const p = document.createElement('div')
    p.className = 'panel result-panel'
    p.hidden = true
    p.innerHTML = `
      <header class="panel-head">
        <div>
          <h1>回合结算 <em>ROUND RESULT</em></h1>
          <div class="tagline">本回合训练数据汇总 · 对比上局找短板，下一局保持节奏</div>
        </div>
        <div class="head-badge">VHT // RESULT<small>AIM · HOLD · WIN</small></div>
      </header>

      <div class="summary-grid"></div>

      <div class="hist-wrap" hidden><canvas class="hist" width="680" height="96"></canvas><div class="hist-cap">反应时间分布（0 – 1s+，红线 = 平均）</div></div>

      <div class="tip-box" hidden></div>

      <div class="actions">
        <button class="btn-start">再来一局</button>
        <button class="btn-ghost">调整设置</button>
      </div>
      <div class="hint">结算后可在设置中微调 Bot 延迟 / 反杀时间，针对性练习。</div>
    `
    this.overlay.appendChild(p)
    this.panel = p
    this.grid = p.querySelector('.summary-grid')
    this.tipBox = p.querySelector('.tip-box')
    this.histWrap = p.querySelector('.hist-wrap')
    this.hist = p.querySelector('.hist')
    p.querySelector('.btn-start').onclick = () => this.onRestart?.()
    p.querySelector('.btn-ghost').onclick = () => this.onSettings?.()
  }

  show(summary) {
    const cell = (num, lbl, suffix = '') => `<div class="sum-cell"><div class="num">${num}${suffix}</div><div class="lbl">${lbl}</div></div>`
    // 对比上局的增减角标：invert=true 表示越小越好（如平均反应）
    const p = summary.prevRound
    const delta = (now, before, invert = false) => {
      if (before == null || now == null || p == null) return ''
      const d = now - before
      if (d === 0) return '<span class="delta zero">–</span>'
      const good = invert ? d < 0 : d > 0
      return `<span class="delta ${good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`
    }
    const c = computeStats(summary)
    // 得分（击杀 100 + 爆头 50 + 连杀 ×25）与个人最佳 —— 破纪录绿色高亮
    const scoreRow = summary.score != null
      ? cell(`<span class="${summary.newBest ? 'new-best' : ''}">${summary.score}</span>`, summary.newBest ? '新纪录！' : '本局得分', delta(summary.score, p?.score)) +
        cell(summary.best ?? 0, '个人最佳')
      : ''
    // 评级：按得分/分钟分档（S 金 / A 绿 / B 蓝）
    const g = summary.minutes != null ? gradeFor(summary.score ?? 0, summary.minutes) : null
    const gradeCell = g
      ? cell(`<span class="grade grade-${g}">${g}</span>`, '本局评级')
      : ''
    this.grid.innerHTML =
      gradeCell +
      scoreRow +
      cell(c.kills, '击杀', delta(c.kills, p?.kills)) +
      cell(c.duelsLost, '对枪败') +
      cell(c.accuracy + '%', '命中率', delta(c.accuracy, p?.accuracy)) +
      cell(c.headshotRate + '%', '爆头率') +
      cell(c.maxStreak > 1 ? '×' + c.maxStreak : '—', '最长连杀') +
      cell(c.avgReactionMs ? c.avgReactionMs + 'ms' : '—', '平均反应', delta(c.avgReactionMs || null, p?.avgReactionMs || null, true)) +
      cell(c.bestReactionMs ? c.bestReactionMs + 'ms' : '—', '最快反应')
    // 反应时间直方图（样本足够才有分布意义）
    const rs = summary.reactions ?? []
    this.histWrap.hidden = rs.length < 5
    if (rs.length >= 5) this._drawHist(rs, c.avgReactionMs)
    // 训练建议：按短板挑一条可执行的（没有明显短板则不显示）
    const tip = coachingTip(c)
    this.tipBox.textContent = tip ?? ''
    this.tipBox.hidden = !tip
    this.panel.hidden = false
    this.overlay.classList.add('visible')
  }

  // 反应时间直方图：0–1000ms 十个桶，红线标平均
  _drawHist(rs, avgMs) {
    const g = this.hist.getContext('2d')
    const W = this.hist.width, H = this.hist.height
    const bins = new Array(10).fill(0)
    for (const r of rs) bins[Math.min(9, Math.floor(r / 100))]++
    const max = Math.max(...bins, 1)
    g.clearRect(0, 0, W, H)
    const bw = W / 10
    for (let i = 0; i < 10; i++) {
      const h = bins[i] / max * (H - 30)
      g.fillStyle = i <= 3 ? 'rgba(125, 255, 154, 0.55)' : i <= 5 ? 'rgba(236, 232, 225, 0.35)' : 'rgba(255, 70, 85, 0.5)'
      g.fillRect(i * bw + 5, H - 20 - h, bw - 10, h)
      if (bins[i] > 0) {
        g.fillStyle = 'rgba(236, 232, 225, 0.8)'
        g.font = '600 11px Rajdhani, sans-serif'
        g.textAlign = 'center'
        g.fillText(bins[i], i * bw + bw / 2, H - 24 - h)
      }
      if (i % 2 === 0) {
        g.fillStyle = 'rgba(236, 232, 225, 0.4)'
        g.font = '10px Rajdhani, sans-serif'
        g.fillText(i * 100 + (i === 9 ? '+' : ''), i * bw + bw / 2, H - 6)
      }
    }
    if (avgMs > 0 && avgMs < 1000) {
      const x = Math.min(9.99, avgMs / 100) / 10 * W
      g.strokeStyle = '#ff4655'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(x, 4)
      g.lineTo(x, H - 20)
      g.stroke()
    }
  }

  hide() {
    this.panel.hidden = true
    this.overlay.classList.remove('visible')
  }
}
