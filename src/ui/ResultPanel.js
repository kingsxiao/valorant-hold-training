// 回合结算面板：与设置面板（Menu）分离的独立结算界面
// 回合结束 → show(stats)；「再来一局」重开 / 「调整设置」回到 Menu
import { computeStats } from '../core/stats.js'

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

      <div class="actions">
        <button class="btn-start">再来一局</button>
        <button class="btn-ghost">调整设置</button>
      </div>
      <div class="hint">结算后可在设置中微调 Bot 延迟 / 反杀时间，针对性练习。</div>
    `
    this.overlay.appendChild(p)
    this.panel = p
    this.grid = p.querySelector('.summary-grid')
    p.querySelector('.btn-start').onclick = () => this.onRestart?.()
    p.querySelector('.btn-ghost').onclick = () => this.onSettings?.()
  }

  show(summary) {
    const cell = (num, lbl) => `<div class="sum-cell"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`
    const c = computeStats(summary)
    this.grid.innerHTML =
      cell(c.kills, '击杀') +
      cell(c.duelsLost, '对枪败') +
      cell(c.accuracy + '%', '命中率') +
      cell(c.headshotRate + '%', '爆头率') +
      cell(c.avgReactionMs ? c.avgReactionMs + 'ms' : '—', '平均反应') +
      cell(c.bestReactionMs ? c.bestReactionMs + 'ms' : '—', '最快反应')
    this.panel.hidden = false
    this.overlay.classList.add('visible')
  }

  hide() {
    this.panel.hidden = true
    this.overlay.classList.remove('visible')
  }
}
