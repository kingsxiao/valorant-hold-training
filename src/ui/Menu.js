import { CONFIG } from '../core/Config.js'

// 设置 / 暂停面板（DOM），设置持久化 localStorage；回合结算在 ResultPanel
const LS_KEY = 'vht-settings-v1'
const BEST_KEY = 'vht-bests-v1'

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) ?? {} } catch { return {} }
}
export function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch { /* 隐私模式/配额满：设置不持久化，仅本次会话生效 */ }
  return s
}
// 个人最佳成绩（按模式持久化，破纪录才有训练意义）
export function loadBests() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY)) ?? {} } catch { return {} }
}
export function saveBest(mode, score) {
  const b = loadBests(); b[mode] = score
  try { localStorage.setItem(BEST_KEY, JSON.stringify(b)) } catch { /* 同上：仅本次会话生效 */ }
}

// 上一局摘要（结算面板"对比上局"用）
const LAST_KEY = 'vht-last-round-v1'
export function loadLastRound() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY)) ?? null } catch { return null }
}
export function saveLastRound(s) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(s)) } catch { /* 同上 */ }
}

// 个人最快单次反应（跨回合持久化；样本 ≥5 才认，避免运气值）
const FAST_KEY = 'vht-fastest-v1'
export function loadFastest() {
  try { return JSON.parse(localStorage.getItem(FAST_KEY)) ?? null } catch { return null }
}
export function saveFastest(ms) {
  try { localStorage.setItem(FAST_KEY, JSON.stringify({ ms })) } catch { /* 同上 */ }
}

// 近 10 局得分历史（结算面板趋势图用）
const HIST_KEY = 'vht-history-v1'
export function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)) ?? [] } catch { return [] }
}
export function saveHistory(scores) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(scores.slice(-10))) } catch { /* 同上 */ }
}

export class Menu {
  constructor({ overlay, onReady }) {
    this.overlay = overlay
    this.onReady = onReady   // (startCfg) => void
    this.cfg = {
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
      autoRes: true,
      rampUp: false,
      doubleGap: false,
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
      <header class="panel-head">
        <div>
          <h1>架枪训练 <em>HOLD ANGLE TRAINER</em></h1>
          <div class="tagline">WebGL 第一人称训练器 · 移速/射速/后坐力按 Valorant 公开参数调校 · 原创程序化建模</div>
        </div>
        <div class="menu-best" hidden></div>
        <div class="head-badge">VHT // 01<small>AIM · HOLD · WIN</small></div>
      </header>

      <div class="menu-live" hidden></div>

      <h2>武器</h2>
      <div class="opt-grid" data-group="primary"></div>
      <div style="height:8px"></div>
      <div class="opt-grid" data-group="secondary"></div>

      <h2>参数</h2>
      <div class="slider-grid">
        <div class="slider-row"><label>灵敏度（游戏同换算）</label><input type="range" data-key="sens" min="0.05" max="1.5" step="0.01"><span class="val"></span></div>
        <div class="slider-row"><label>回合时长</label><input type="range" data-key="roundSeconds" min="0" max="180" step="30"><span class="val"></span></div>
        <div class="slider-row"><label>Bot 出现最小延迟</label><input type="range" data-key="delayMin" min="200" max="2000" step="100"><span class="val"></span></div>
        <div class="slider-row"><label>Bot 出现最大延迟</label><input type="range" data-key="delayMax" min="500" max="5000" step="100"><span class="val"></span></div>
        <div class="slider-row"><label>Bot 横移速度</label><input type="range" data-key="speedMult" min="0.4" max="1.3" step="0.05"><span class="val"></span></div>
        <div class="slider-row"><label>Bot 反杀时间</label><input type="range" data-key="aimTimeMs" min="250" max="1200" step="50"><span class="val"></span></div>
        <div class="slider-row"><label>音量</label><input type="range" data-key="volume" min="0" max="1" step="0.05"><span class="val"></span></div>
      </div>
      <div class="opt-grid" data-group="trainOpts"></div>

      <h2>画质</h2>
      <div class="slider-grid">
        <div class="slider-row"><label>分辨率缩放</label><input type="range" data-key="resScale" min="0.5" max="2" step="0.05"><span class="val"></span></div>
      </div>
      <div class="opt-grid" data-group="gfxOpts"></div>

      <h2>准星</h2>
      <div class="slider-grid">
        <div class="slider-row"><label>线长</label><input type="range" data-ch="length" min="1" max="12" step="1"><span class="val"></span></div>
        <div class="slider-row"><label>线粗</label><input type="range" data-ch="thickness" min="1" max="4" step="1"><span class="val"></span></div>
        <div class="slider-row"><label>间距</label><input type="range" data-ch="gap" min="0" max="10" step="1"><span class="val"></span></div>
      </div>
      <div class="opt-grid" data-group="chColor"></div>
      <div style="height:8px"></div>
      <div class="opt-grid" data-group="chOpts"></div>

      <div class="actions">
        <button class="btn-start">开始训练</button>
        <span class="hint" style="margin:0">点击后锁定鼠标 · ESC 暂停</span>
      </div>

      <div class="hint">
        操作：<span class="kbd">W A S D</span> 移动（全速 5.4m/s）· <span class="kbd">Shift</span> 静步（50%，无声）·
        <span class="kbd">Ctrl/C</span> 蹲 · <span class="kbd">Space</span> 跳 ·
        <span class="kbd">1</span> 主武器 · <span class="kbd">2</span> 副武器 · <span class="kbd">3</span> 刀（6.75m/s）·
        <span class="kbd">左键</span> 开火（弹药无限）· <span class="kbd">右键</span> Classic 三连发<br/>
        开局 3 秒倒计时热身，GO 后才开始计时 · 准星随移动/开火实时扩张，收束时才是出手时机 ·
        Bot 横移带脚步声，听声辨位先于目视 · 部分 Bot"露头即缩"，守住准星等第二拉 ·
        架枪对枪：在"反杀时间"内未击杀则判负；击杀得分冲击个人最佳 ★
      </div>
    `
    this.overlay.appendChild(p)
    this.panel = p

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
    for (const [key, label] of [['dot', '中心点'], ['tShape', 'T 形（去上线）'], ['outline', '描边'], ['error', '动态误差（移动/开火扩张）']]) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = label
      b.dataset.value = key
      b.onclick = () => { this.cfg.crosshair[key] = !this.cfg.crosshair[key]; this.syncButtons(); saveSettings({ crosshair: this.cfg.crosshair }); this.applyAll?.() }
      oBox.appendChild(b)
    }

    // 训练开关（渐进难度 / 双缺口压力）
    const tBox = p.querySelector('[data-group=trainOpts]')
    for (const [key, label] of [
      ['rampUp', '渐进难度（击杀后 Bot 越出越快/越快横移）'],
      ['doubleGap', '双缺口压力（A/B 同时出人）'],
    ]) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = label
      b.dataset.value = key
      b.onclick = () => { this.cfg[key] = !this.cfg[key]; this.syncButtons(); saveSettings({ [key]: this.cfg[key] }); this.applyAll?.() }
      tBox.appendChild(b)
    }

    // 画质开关（自适应分辨率 / 阴影 / FPS 显示）
    const gBox = p.querySelector('[data-group=gfxOpts]')
    for (const [key, label] of [['autoRes', '自适应分辨率（掉帧自动降）'], ['shadows', '阴影'], ['showFps', 'FPS 面板']]) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = label
      b.dataset.value = key
      b.onclick = () => { this.cfg[key] = !this.cfg[key]; this.syncButtons(); saveSettings({ [key]: this.cfg[key] }); this.applyAll?.() }
      gBox.appendChild(b)
    }

    // 滑条绑定（--p 驱动轨道已填充部分）
    const setFill = (inp) => {
      const min = parseFloat(inp.min), max = parseFloat(inp.max)
      inp.style.setProperty('--p', ((parseFloat(inp.value) - min) / (max - min) * 100).toFixed(2) + '%')
    }
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
      setFill(inp)
      inp.oninput = () => {
        this.cfg[key] = parseFloat(inp.value)
        val.textContent = fmt(this.cfg[key])
        setFill(inp)
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
      setFill(inp)
      inp.oninput = () => {
        this.cfg.crosshair[key] = parseInt(inp.value)
        val.textContent = inp.value
        setFill(inp)
        saveSettings({ crosshair: this.cfg.crosshair })
        this.applyAll?.()
      }
    }

    p.querySelector('.btn-start').onclick = () => this.onReady?.({ ...this.cfg })
    this.syncButtons()
  }

  syncButtons() {
    for (const [group, key] of [['primary', 'primary'], ['secondary', 'secondary']]) {
      for (const b of this.panel.querySelectorAll(`[data-group=${group}] .opt-btn`)) {
        b.classList.toggle('active', b.dataset.value === String(this.cfg[key]))
      }
    }
    for (const b of this.panel.querySelectorAll('[data-group=chColor] .opt-btn')) {
      b.classList.toggle('active', b.dataset.value === this.cfg.crosshair.color)
      // 非选中时用同色内描边标识色板
      b.style.boxShadow = b.classList.contains('active') ? '' : `inset 0 0 0 1px ${b.dataset.value}66`
    }
    for (const b of this.panel.querySelectorAll('[data-group=chOpts] .opt-btn')) {
      b.classList.toggle('active', !!this.cfg.crosshair[b.dataset.value])
    }
    for (const b of this.panel.querySelectorAll('[data-group=gfxOpts] .opt-btn, [data-group=trainOpts] .opt-btn')) {
      b.classList.toggle('active', !!this.cfg[b.dataset.value])
    }
  }

  refreshSliders() {
    for (const { inp, val, fmt, key } of this.sliders) {
      inp.value = this.cfg[key]
      val.textContent = fmt(this.cfg[key])
    }
  }

  show(live = null) {
    this.overlay.classList.add('visible')
    this.panel.hidden = false
    // 个人最佳徽标（有纪录才显示）
    const best = loadBests().hold ?? 0
    const badge = this.panel.querySelector('.menu-best')
    badge.hidden = !(best > 0)
    if (best > 0) badge.innerHTML = `★ 个人最佳 <b>${best}</b>`
    // 暂停时的本局进行中战绩（ESC 呼出时有值；首屏/结算后为 null）
    const liveBox = this.panel.querySelector('.menu-live')
    if (live) {
      liveBox.innerHTML = `<span class="ml-title">本局进行中</span>` +
        `<b>${live.score ?? 0}</b><i>分</i>` +
        `<b>${live.kills ?? 0}</b><i>击杀</i>` +
        `<b>${live.duelsLost ?? 0}</b><i>对枪败</i>` +
        (live.maxStreak > 1 ? `<b>×${live.maxStreak}</b><i>连杀</i>` : '') +
        (live.aimError != null ? `<b>${live.aimError}°</b><i>预瞄误差</i>` : '')
      liveBox.hidden = false
    } else {
      liveBox.hidden = true
    }
    this.refreshSliders()
    this.syncButtons()
  }

  hide() {
    this.panel.hidden = true
    this.overlay.classList.remove('visible')
  }
}
