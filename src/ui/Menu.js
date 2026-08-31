import { MODES } from '../entities/BotManager.js'
import { CONFIG } from '../core/Config.js'

// 菜单 / 暂停 / 结算面板（DOM），设置持久化 localStorage
const LS_KEY = 'vht-settings-v1'

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) ?? {} } catch { return {} }
}
export function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch }
  localStorage.setItem(LS_KEY, JSON.stringify(s))
  return s
}

export class Menu {
  constructor({ overlay, onReady }) {
    this.overlay = overlay
    this.onReady = onReady   // (startCfg) => void
    this.cfg = {
      mode: 'hold',
      primary: 'vandal',
      secondary: 'classic',
      sens: CONFIG.mouse.defaultSens,
      roundSeconds: 60,
      delayMin: CONFIG.training.peekDelayMinMs,
      delayMax: CONFIG.training.peekDelayMaxMs,
      speedMult: 1.0,
      aimTimeMs: CONFIG.bot.aimTimeMs,
      volume: 0.7,
      showFps: true,
      shadows: CONFIG.graphics.shadows,
      resScale: 1.0,
      crosshair: {},
      ...loadSettings(),
    }
    this.build()
    this.applyAll = null // main 注入：设置实时生效
  }

  build() {
    const p = document.createElement('div')
    p.className = 'panel'
    p.innerHTML = `
      <h1>架枪训练 <em>HOLD ANGLE TRAINER</em></h1>
      <div class="tagline">WebGL 第一人称训练器 · 移速/射速/后坐力按 Valorant 公开参数调校 · 原创程序化建模</div>

      <h2>训练模式</h2>
      <div class="opt-grid" data-group="mode"></div>

      <h2>武器</h2>
      <div class="opt-grid" data-group="primary"></div>
      <div style="height:8px"></div>
      <div class="opt-grid" data-group="secondary"></div>

      <h2>参数</h2>
      <div class="slider-row"><label>灵敏度（游戏同换算）</label><input type="range" data-key="sens" min="0.05" max="1.5" step="0.01"><span class="val"></span></div>
      <div class="slider-row"><label>回合时长</label><input type="range" data-key="roundSeconds" min="0" max="180" step="30"><span class="val"></span></div>
      <div class="slider-row"><label>Bot 出现最小延迟</label><input type="range" data-key="delayMin" min="200" max="2000" step="100"><span class="val"></span></div>
      <div class="slider-row"><label>Bot 出现最大延迟</label><input type="range" data-key="delayMax" min="500" max="5000" step="100"><span class="val"></span></div>
      <div class="slider-row"><label>Bot 横移速度</label><input type="range" data-key="speedMult" min="0.4" max="1.3" step="0.05"><span class="val"></span></div>
      <div class="slider-row"><label>Bot 反杀时间</label><input type="range" data-key="aimTimeMs" min="250" max="1200" step="50"><span class="val"></span></div>
      <div class="slider-row"><label>音量</label><input type="range" data-key="volume" min="0" max="1" step="0.05"><span class="val"></span></div>

      <h2>画质</h2>
      <div class="slider-row"><label>分辨率缩放</label><input type="range" data-key="resScale" min="0.5" max="2" step="0.05"><span class="val"></span></div>
      <div class="opt-grid" data-group="gfxOpts"></div>

      <h2>准星</h2>
      <div class="slider-row"><label>线长</label><input type="range" data-ch="length" min="1" max="12" step="1"><span class="val"></span></div>
      <div class="slider-row"><label>线粗</label><input type="range" data-ch="thickness" min="1" max="4" step="1"><span class="val"></span></div>
      <div class="slider-row"><label>间距</label><input type="range" data-ch="gap" min="0" max="10" step="1"><span class="val"></span></div>
      <div class="opt-grid" data-group="chColor"></div>
      <div style="height:8px"></div>
      <div class="opt-grid" data-group="chOpts"></div>

      <div class="actions">
        <button class="btn-start">开始训练</button>
        <span class="hint" style="margin:0">点击后锁定鼠标 · ESC 暂停</span>
      </div>

      <div class="hint">
        操作：<span class="kbd">W A S D</span> 移动（全速 5.4m/s）· <span class="kbd">Shift</span> 静步（50%，无声）·
        <span class="kbd">Ctrl/C</span> 蹲 · <span class="kbd">Space</span> 跳 · <span class="kbd">R</span> 换弹 ·
        <span class="kbd">1</span> 主武器 · <span class="kbd">2</span> 副武器 · <span class="kbd">3</span> 刀（6.75m/s）·
        <span class="kbd">左键</span> 开火 · <span class="kbd">右键</span> Classic 三连发<br/>
        架枪对枪：目标从巷道缺口随机拉出，若在"反杀时间"内未击杀则判负 —— 比的就是你先开枪的能力。
      </div>
    `
    this.overlay.appendChild(p)
    this.panel = p

    // 模式按钮
    const modeBox = p.querySelector('[data-group=mode]')
    for (const [id, m] of Object.entries(MODES)) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = `${m.label} · ${m.desc}`
      b.dataset.value = id
      b.onclick = () => { this.cfg.mode = id; this.syncButtons(); saveSettings({ mode: id }); this.applyAll?.() }
      modeBox.appendChild(b)
    }

    // 武器按钮
    const wname = { vandal: 'Vandal（自动步战）', phantom: 'Phantom（消音/衰减）', sheriff: 'Sheriff（重左轮）', classic: 'Classic（手枪/右键三连发）', ghost: 'Ghost（消音手枪）' }
    for (const group of ['primary', 'secondary']) {
      const box = p.querySelector(`[data-group=${group}]`)
      for (const [id, w] of Object.entries(CONFIG.weapons)) {
        if (w.slot !== group) continue
        const b = document.createElement('button')
        b.className = 'opt-btn'
        b.textContent = wname[id] ?? w.name
        b.dataset.value = id
        b.onclick = () => { this.cfg[group] = id; this.syncButtons(); saveSettings({ [group]: id }); this.applyAll?.() }
        box.appendChild(b)
      }
    }

    // 准星颜色 / 开关
    const cBox = p.querySelector('[data-group=chColor]')
    for (const c of ['#00ffb3', '#ffffff', '#7dff00', '#ff4655', '#00c8ff', '#ffe23d']) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.innerHTML = `<span style="display:inline-block;width:14px;height:14px;background:${c};border-radius:3px;vertical-align:-2px"></span>`
      b.dataset.value = c
      b.onclick = () => { this.cfg.crosshair.color = c; this.syncButtons(); saveSettings({ crosshair: this.cfg.crosshair }); this.applyAll?.() }
      cBox.appendChild(b)
    }
    const oBox = p.querySelector('[data-group=chOpts]')
    for (const [key, label] of [['dot', '中心点'], ['tShape', 'T 形（去上线）'], ['outline', '描边']]) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = label
      b.dataset.value = key
      b.onclick = () => { this.cfg.crosshair[key] = !this.cfg.crosshair[key]; this.syncButtons(); saveSettings({ crosshair: this.cfg.crosshair }); this.applyAll?.() }
      oBox.appendChild(b)
    }

    // 画质开关（阴影 / FPS 显示）
    const gBox = p.querySelector('[data-group=gfxOpts]')
    for (const [key, label] of [['shadows', '阴影'], ['showFps', 'FPS 面板']]) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = label
      b.dataset.value = key
      b.onclick = () => { this.cfg[key] = !this.cfg[key]; this.syncButtons(); saveSettings({ [key]: this.cfg[key] }); this.applyAll?.() }
      gBox.appendChild(b)
    }

    // 滑条绑定
    this.sliders = []
    for (const inp of p.querySelectorAll('input[data-key]')) {
      const key = inp.dataset.key
      const val = inp.parentElement.querySelector('.val')
      const fmt = {
        sens: v => v.toFixed(2),
        roundSeconds: v => v === 0 ? '∞' : v + 's',
        delayMin: v => v + 'ms',
        delayMax: v => v + 'ms',
        speedMult: v => Math.round(v * 100) + '%',
        aimTimeMs: v => v + 'ms',
        volume: v => Math.round(v * 100) + '%',
        resScale: v => Math.round(v * 100) + '%',
      }[key] ?? (v => v)
      inp.value = this.cfg[key]
      val.textContent = fmt(this.cfg[key])
      inp.oninput = () => {
        this.cfg[key] = parseFloat(inp.value)
        val.textContent = fmt(this.cfg[key])
        saveSettings({ [key]: this.cfg[key] })
        this.applyAll?.()
      }
      this.sliders.push({ inp, val, fmt, key })
    }
    for (const inp of p.querySelectorAll('input[data-ch]')) {
      const key = inp.dataset.ch
      const val = inp.parentElement.querySelector('.val')
      this.cfg.crosshair[key] ??= { length: 5, thickness: 2, gap: 3 }[key]
      inp.value = this.cfg.crosshair[key]
      val.textContent = this.cfg.crosshair[key]
      inp.oninput = () => {
        this.cfg.crosshair[key] = parseInt(inp.value)
        val.textContent = inp.value
        saveSettings({ crosshair: this.cfg.crosshair })
        this.applyAll?.()
      }
    }

    p.querySelector('.btn-start').onclick = () => this.onReady?.({ ...this.cfg })
    this.syncButtons()
  }

  syncButtons() {
    for (const [group, key] of [['mode', 'mode'], ['primary', 'primary'], ['secondary', 'secondary']]) {
      for (const b of this.panel.querySelectorAll(`[data-group=${group}] .opt-btn`)) {
        b.classList.toggle('active', b.dataset.value === String(this.cfg[key]))
      }
    }
    for (const b of this.panel.querySelectorAll('[data-group=chColor] .opt-btn')) {
      b.classList.toggle('active', b.dataset.value === this.cfg.crosshair.color)
      b.style.borderColor = b.classList.contains('active') ? '' : b.dataset.value
    }
    for (const b of this.panel.querySelectorAll('[data-group=chOpts] .opt-btn')) {
      b.classList.toggle('active', !!this.cfg.crosshair[b.dataset.value])
    }
    for (const b of this.panel.querySelectorAll('[data-group=gfxOpts] .opt-btn')) {
      b.classList.toggle('active', !!this.cfg[b.dataset.value])
    }
  }

  refreshSliders() {
    for (const { inp, val, fmt, key } of this.sliders) {
      inp.value = this.cfg[key]
      val.textContent = fmt(this.cfg[key])
    }
  }

  show(summary = null) {
    this.overlay.classList.add('visible')
    const old = this.overlay.querySelector('.summary')
    if (old) old.remove()
    if (summary) {
      const s = document.createElement('div')
      s.className = 'summary'
      const cell = (num, lbl) => `<div class="sum-cell"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`
      const n = summary.reactions.length
      const avg = n ? Math.round(summary.reactions.reduce((a, b) => a + b, 0) / n) : 0
      const best = n ? Math.min(...summary.reactions) : 0
      s.innerHTML = `<h2>回合结算</h2><div class="summary-grid">
        ${cell(summary.kills, '击杀')}
        ${cell(summary.duelsLost, '对枪败')}
        ${cell((summary.shots ? Math.round(summary.hits / summary.shots * 100) : 0) + '%', '命中率')}
        ${cell((summary.hits ? Math.round(summary.headshots / summary.hits * 100) : 0) + '%', '爆头率')}
        ${cell(avg ? avg + 'ms' : '—', '平均反应')}
        ${cell(best ? best + 'ms' : '—', '最快反应')}
      </div>`
      this.panel.prepend(s)
    }
    this.refreshSliders()
    this.syncButtons()
  }

  hide() { this.overlay.classList.remove('visible') }
}
