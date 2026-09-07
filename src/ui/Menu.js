import { CONFIG } from '../core/Config.js'
import {
  PRESET_COLORS, crosshairDefaults, parseCrosshairCode, exportCrosshairCode,
  sanitizeCrosshair, isLegacyCrosshair, migrateLegacyCrosshair,
} from './crosshairCode.js'
import { paintCrosshair } from './Crosshair.js'

// 设置 / 暂停面板（DOM），设置持久化 localStorage；回合结算在 ResultPanel
const LS_KEY = 'vht-settings-v1'
const BEST_KEY = 'vht-bests-v1'

export function loadSettings() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY))
    return (typeof v === 'object' && v !== null) ? v : {}
  } catch { return {} }
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
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY))
    if (typeof v !== 'object' || v === null) return {}
    // 各模式最佳分须为有限数：字符串/NaN 会让 Math.max 与破纪录比较失真
    for (const k of Object.keys(v)) {
      if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) delete v[k]
    }
    return v
  } catch { return {} }
}
export function saveBest(mode, score) {
  const b = loadBests(); b[mode] = score
  try { localStorage.setItem(BEST_KEY, JSON.stringify(b)) } catch { /* 同上：仅本次会话生效 */ }
}

// 上一局摘要（结算面板"对比上局"用）
const LAST_KEY = 'vht-last-round-v1'
export function loadLastRound() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY))
    return (typeof v === 'object' && v !== null) ? v : null
  } catch { return null }
}
export function saveLastRound(s) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(s)) } catch { /* 同上 */ }
}

// 个人最快单次反应（跨回合持久化；样本 ≥5 才认，避免运气值）
const FAST_KEY = 'vht-fastest-v1'
export function loadFastest() {
  try {
    const v = JSON.parse(localStorage.getItem(FAST_KEY))
    return (typeof v === 'object' && v !== null && Number.isFinite(v.ms)) ? v : null
  } catch { return null }
}
export function saveFastest(ms) {
  try { localStorage.setItem(FAST_KEY, JSON.stringify({ ms })) } catch { /* 同上 */ }
}

// 近 10 局得分历史（结算面板趋势图用）。手改/半截写入可能存出非数组，
// main 的 [...loadHistory(), score] 对非可迭代值会抛错炸掉回合结算 → 类型守卫
const HIST_KEY = 'vht-history-v1'
export function loadHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(HIST_KEY))
    return Array.isArray(v) ? v.filter(x => typeof x === 'number' && Number.isFinite(x)) : []
  } catch { return [] }
}
export function saveHistory(scores) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(scores.slice(-10))) } catch { /* 同上 */ }
}

// 生涯累计击杀
const TOTAL_KEY = 'vht-total-kills-v1'
export function loadTotalKills() {
  try {
    const v = JSON.parse(localStorage.getItem(TOTAL_KEY))
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  } catch { return 0 }
}
export function saveTotalKills(n) {
  try { localStorage.setItem(TOTAL_KEY, JSON.stringify(n)) } catch { /* 同上 */ }
}

export class Menu {
  constructor({ overlay, onReady, onContinue }) {
    this.overlay = overlay
    this.onReady = onReady     // (startCfg) => void
    this.onContinue = onContinue // () => void 暂停中恢复当前回合（不重置）
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
      gapSide: 'left',      // 缺口位置：左 / 右（切换即重建静态地图）
      flash: 'off',         // 闪光干扰：off / kayo / skye / phoenix / mix（敌方道具按维基数值 1:1）
      // 出厂默认 = 游戏默认形态 + 青色（接近游戏新号默认观感）；已有存档由
      // _sanitizeCfg 迁移/清洗后覆盖
      crosshair: { ...crosshairDefaults(), colorIdx: 5 },
      ...loadSettings(),
    }
    this._sanitizeCfg()
    this.build()
    this.applyAll = null // main 注入：设置实时生效
  }

  // 持久化脏数据防线：localStorage 可能被手改/半截写入（sens:"abc"、crosshair:3、
  // 越界 sens:5）。不清洗会：字符串让 toFixed 抛错整屏菜单挂掉；crosshair 非
  // 对象让 ??= 赋值到原始值上抛错；越界值滑条显示被钳但 cfg 用原值——所见非所用
  _sanitizeCfg() {
    const c = this.cfg
    const NUM = { // 与 build() 里滑条 min/max 一一对应
      sens: [0.05, 1.5], roundSeconds: [0, 180], delayMin: [200, 2000],
      delayMax: [500, 5000], speedMult: [0.4, 1.3], aimTimeMs: [250, 1200],
      volume: [0, 1], resScale: [0.5, 2],
    }
    const DEF = {
      sens: CONFIG.mouse.defaultSens, roundSeconds: 60,
      delayMin: CONFIG.training.peekDelayMinMs, delayMax: CONFIG.training.peekDelayMaxMs,
      speedMult: 1, aimTimeMs: CONFIG.bot.aimTimeMs, volume: 0.7, resScale: 1,
    }
    for (const [k, [min, max]] of Object.entries(NUM)) {
      const v = Number(c[k])
      c[k] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : DEF[k]
    }
    const WEAPONS = Object.keys(CONFIG.weapons)
    if (!WEAPONS.includes(c.primary)) c.primary = 'vandal'
    if (!WEAPONS.includes(c.secondary)) c.secondary = 'classic'
    for (const k of ['showFps', 'shadows', 'autoRes', 'rampUp']) c[k] = !!c[k]
    c.gapSide = c.gapSide === 'right' ? 'right' : 'left' // 旧存档里的 doubleGap 一并失效忽略
    c.flash = ['kayo', 'skye', 'phoenix', 'mix'].includes(c.flash) ? c.flash : 'off'
    // 旧版简化准星模型（length/gap/tShape）→ 游戏同款模型；再全量清洗防手改
    if (isLegacyCrosshair(c.crosshair)) c.crosshair = migrateLegacyCrosshair(c.crosshair)
    c.crosshair = sanitizeCrosshair(c.crosshair)
  }

  build() {
    const p = document.createElement('div')
    p.className = 'panel'
    // 结构：设置区（panel-scroll，超高时内部滚动）+ 底部固定操作条（panel-foot）。
    // 操作条不参与滚动——任何窗口高度下"开始训练/继续训练"都完整可见可点，
    // 不会被 max-height 裁剪到点不到（按钮中心落在 overlay 上 = 点击无反应）
    const scroll = document.createElement('div')
    scroll.className = 'panel-scroll'
    scroll.innerHTML = `
      <header class="panel-head">
        <div>
          <h1>架枪训练 <em>HOLD ANGLE TRAINER</em></h1>
          <div class="tagline">WebGL 第一人称训练器 · 移速/射速/后坐力按 Valorant 公开参数调校 · 原创程序化建模</div>
        </div>
        <div class="menu-best" hidden></div>
        <div class="head-badge">VHT // 01<small>AIM · HOLD · WIN</small></div>
      </header>

      <div class="menu-live" hidden></div>

      <div class="mobile-warn" hidden>⚠ 检测到触屏设备：本训练器需要键盘 + 鼠标（指针锁定），请在桌面浏览器打开。</div>

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
        <div class="slider-row"><label>击杀时限</label><input type="range" data-key="aimTimeMs" min="250" max="1200" step="50"><span class="val"></span></div>
        <div class="slider-row"><label>音量</label><input type="range" data-key="volume" min="0" max="1" step="0.05"><span class="val"></span></div>
      </div>
      <div class="opt-grid" data-group="gapSide"></div>
      <div style="height:8px"></div>
      <div class="opt-grid" data-group="flashMode"></div>
      <div style="height:8px"></div>
      <div class="opt-grid" data-group="trainOpts"></div>

      <h2>画质</h2>
      <div class="slider-grid">
        <div class="slider-row"><label>分辨率缩放</label><input type="range" data-key="resScale" min="0.5" max="2" step="0.05"><span class="val"></span></div>
      </div>
      <div class="opt-grid" data-group="gfxOpts"></div>

      <h2>准星 <small class="h2-sub">与游戏设置 1:1 · 支持导入游戏准星代码</small></h2>
      <div class="ch-wrap">
        <div class="ch-preview"><canvas></canvas></div>
        <div class="ch-groups">
          <div class="ch-group">
            <div class="ch-group-head">准星颜色</div>
            <div class="ch-swatches"></div>
          </div>
          <div class="ch-group">
            <button class="opt-btn ch-toggle" data-chkey="outlines">轮廓</button>
            <div class="slider-grid ch-sub">
              <div class="slider-row"><label>轮廓不透明度</label><input type="range" data-chp="outlineOpacity" min="0" max="1" step="0.01"><span class="val"></span></div>
              <div class="slider-row"><label>轮廓粗细</label><input type="range" data-chp="outlineThickness" min="0" max="6" step="1"><span class="val"></span></div>
            </div>
          </div>
          <div class="ch-group">
            <button class="opt-btn ch-toggle" data-chkey="dot">中心点</button>
            <div class="slider-grid ch-sub">
              <div class="slider-row"><label>中心点不透明度</label><input type="range" data-chp="dotOpacity" min="0" max="1" step="0.01"><span class="val"></span></div>
              <div class="slider-row"><label>中心点大小</label><input type="range" data-chp="dotSize" min="1" max="6" step="1"><span class="val"></span></div>
            </div>
          </div>
          <div class="ch-group">
            <button class="opt-btn ch-toggle" data-chkey="inner.show">内线</button>
            <div class="slider-grid ch-sub">
              <div class="slider-row"><label>内线不透明度</label><input type="range" data-chp="inner.opacity" min="0" max="1" step="0.01"><span class="val"></span></div>
              <div class="slider-row"><label>内线长度</label><input type="range" data-chp="inner.length" min="0" max="20" step="1"><span class="val"></span></div>
              <div class="slider-row"><label>垂直长度</label><input type="range" data-chp="inner.vlength" min="0" max="20" step="1"><span class="val"></span><button class="ch-link" data-chlink="inner" title="水平/垂直长度联动" aria-label="水平/垂直长度联动"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M9 17H5a4 4 0 0 1 0-8h4M15 9h4a4 4 0 0 1 0 8h-4M8 13h8"/></svg></button></div>
              <div class="slider-row"><label>内线粗细</label><input type="range" data-chp="inner.thickness" min="0" max="10" step="1"><span class="val"></span></div>
              <div class="slider-row"><label>内线间距</label><input type="range" data-chp="inner.offset" min="0" max="20" step="1"><span class="val"></span></div>
              <div class="slider-row"><label>移动误差</label><button class="opt-btn ch-toggle sm" data-chkey="inner.moveErr"></button><input type="range" data-chp="inner.moveMult" min="0" max="3" step="0.1"><span class="val"></span></div>
              <div class="slider-row"><label>开火误差</label><button class="opt-btn ch-toggle sm" data-chkey="inner.fireErr"></button><input type="range" data-chp="inner.fireMult" min="0" max="3" step="0.1"><span class="val"></span></div>
            </div>
          </div>
          <div class="ch-group">
            <button class="opt-btn ch-toggle" data-chkey="outer.show">外线</button>
            <div class="slider-grid ch-sub">
              <div class="slider-row"><label>外线不透明度</label><input type="range" data-chp="outer.opacity" min="0" max="1" step="0.01"><span class="val"></span></div>
              <div class="slider-row"><label>外线长度</label><input type="range" data-chp="outer.length" min="0" max="20" step="1"><span class="val"></span></div>
              <div class="slider-row"><label>垂直长度</label><input type="range" data-chp="outer.vlength" min="0" max="20" step="1"><span class="val"></span><button class="ch-link" data-chlink="outer" title="水平/垂直长度联动" aria-label="水平/垂直长度联动"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M9 17H5a4 4 0 0 1 0-8h4M15 9h4a4 4 0 0 1 0 8h-4M8 13h8"/></svg></button></div>
              <div class="slider-row"><label>外线粗细</label><input type="range" data-chp="outer.thickness" min="0" max="10" step="1"><span class="val"></span></div>
              <div class="slider-row"><label>外线间距</label><input type="range" data-chp="outer.offset" min="0" max="20" step="1"><span class="val"></span></div>
              <div class="slider-row"><label>移动误差</label><button class="opt-btn ch-toggle sm" data-chkey="outer.moveErr"></button><input type="range" data-chp="outer.moveMult" min="0" max="3" step="0.1"><span class="val"></span></div>
              <div class="slider-row"><label>开火误差</label><button class="opt-btn ch-toggle sm" data-chkey="outer.fireErr"></button><input type="range" data-chp="outer.fireMult" min="0" max="3" step="0.1"><span class="val"></span></div>
            </div>
          </div>
          <div class="ch-group">
            <div class="ch-group-head">高级</div>
            <div class="opt-grid" data-group="chAdv"></div>
          </div>
          <div class="ch-code">
            <input class="ch-code-in" spellcheck="false" placeholder="粘贴游戏准星代码（0;P;c;5;…）" aria-label="粘贴游戏准星代码">
            <button class="btn-ghost ch-import">导入</button>
            <button class="btn-ghost ch-export">复制代码</button>
            <button class="btn-ghost ch-reset">重置默认</button>
          </div>
        </div>
      </div>
    `
    const foot = document.createElement('div')
    foot.className = 'panel-foot'
    foot.innerHTML = `
      <div class="actions">
        <button class="btn-continue btn-start" hidden>继续训练</button>
        <button class="btn-start">开始训练</button>
        <button class="btn-ghost btn-clear-records">清除纪录</button>
        <span class="hint" style="margin:0">点击后锁定鼠标 · ESC 暂停（可继续当前回合）</span>
      </div>

      <div class="hint">
        操作：<span class="kbd">W A S D</span> 移动（全速 5.4m/s）· <span class="kbd">Shift</span> 静步（50%，无声）·
        <span class="kbd">Ctrl/C</span> 蹲 · <span class="kbd">Space</span> 跳 ·
        <span class="kbd">1</span> 主武器 · <span class="kbd">2</span> 副武器 · <span class="kbd">3</span> 刀（6.75m/s）·
        <span class="kbd">左键</span> 开火（弹药无限）· <span class="kbd">右键</span> Classic 三连发<br/>
        开局 3 秒倒计时热身，GO 后才开始计时 · 准星随移动/开火实时扩张，收束时才是出手时机 ·
        Bot 移动带脚步声，听声辨位先于目视 · 两种出掩体方式：侧面跑过（顺跑向贯穿缺口）与
        横向拉出（肩peek 拉出急停对枪），部分拉出 Bot"露头即缩"，守住准星等第二拉 ·
        架枪对枪："击杀时限"内没打中，Bot 反击后跑向对面掩体，躲进墙后才出下一波（判负只记统计）；击杀得分冲击个人最佳 ★<br/>
        闪光干扰（可选）：敌方从墙后投掷 KAY/O 手雷 / 斯凯追踪鹰 / 火男弧线球（数值按游戏还原）——
        看到或听到就背身！直视起爆点满时长白屏（KAY/O 2.25s / 斯凯最高 2.25s / 火男 1.5s），背对只短暂致盲，起爆后敌人随即拉出
      </div>
    `
    p.append(scroll, foot)
    this.overlay.appendChild(p)
    this.panel = p
    this.scrollBox = scroll
    // 触屏设备提示：纯 coarse 指针（无精细指针）= 手机/平板 → 训练器不可玩，
    // 提前告知而不是让用户对着无效菜单点半天（带鼠标的二合一设备不受影响）
    if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) {
      p.querySelector('.mobile-warn').hidden = false
    }
    // 可访问性：label 未用 for/id 关联，读屏器读不到滑条用途 → 就地同步成 aria-label
    for (const row of p.querySelectorAll('.slider-row')) {
      const lab = row.querySelector('label'), inp = row.querySelector('input[type=range]')
      if (lab && inp) inp.setAttribute('aria-label', lab.textContent.trim())
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

    // 准星编辑器（与游戏设置 1:1）：色板 / 分组开关 / 滑条 / 代码导入导出
    this._buildCrosshair(p)

    // 缺口位置（左/右二选一）：切换即重建地图——纯架枪场景只留一个口
    const gsBox = p.querySelector('[data-group=gapSide]')
    for (const [v, label] of [['left', '缺口 · 左侧'], ['right', '缺口 · 右侧']]) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = label
      b.dataset.value = v
      b.onclick = () => { this.cfg.gapSide = v; this.syncButtons(); saveSettings({ gapSide: v }); this.applyAll?.() }
      gsBox.appendChild(b)
    }

    // 闪光干扰（敌方道具 1:1）：关闭 / 三选一 / 三种混合随机。
    // 投掷物从墙后袭来——听声辨位、背身躲闪是核心训练点（直视满时长致盲）
    const fBox = p.querySelector('[data-group=flashMode]')
    for (const [v, label] of [
      ['off', '闪光干扰 · 关'],
      ['kayo', 'KAY/O 闪光（弹跳手雷）'],
      ['skye', '斯凯 闪光（追踪鹰）'],
      ['phoenix', '火男 闪光（弧线球）'],
      ['mix', '三种混合（随机）'],
    ]) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = label
      b.dataset.value = v
      b.onclick = () => { this.cfg.flash = v; this.syncButtons(); saveSettings({ flash: v }); this.applyAll?.() }
      fBox.appendChild(b)
    }

    // 训练开关（渐进难度）
    const tBox = p.querySelector('[data-group=trainOpts]')
    for (const [key, label] of [
      ['rampUp', '渐进难度（击杀后 Bot 越出越快/越快横移）'],
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

    // 绑定注意：继续训练按钮复用 .btn-start 样式且排在前面，querySelector('.btn-start')
    // 会命中它——用 :not(.btn-continue) 精确匹配"开始训练"，否则 onReady 绑错按钮、
    // 点击开始无任何反应（第十四轮引入的回归）
    p.querySelector('.btn-start:not(.btn-continue)').onclick = () => this.onReady?.({ ...this.cfg })
    // 暂停中恢复当前回合（不重置分数/计时）
    p.querySelector('.btn-continue').onclick = () => this.onContinue?.()
    // 清除全部个人纪录（最佳/最快/历史/上局）——两步确认：第一次点变红要确认，
    // 3 秒内再点才真正清除（误触一次不丢生涯数据）
    const clearBtn = p.querySelector('.btn-clear-records')
    let confirmUntil = 0
    clearBtn.onclick = () => {
      if (performance.now() < confirmUntil) {
        for (const k of ['vht-bests-v1', 'vht-fastest-v1', 'vht-history-v1', 'vht-last-round-v1', 'vht-total-kills-v1']) {
          try { localStorage.removeItem(k) } catch { /* 忽略 */ }
        }
        confirmUntil = 0
        clearBtn.textContent = '已清除'
        setTimeout(() => { clearBtn.textContent = '清除纪录'; clearBtn.classList.remove('danger') }, 1200)
        this.show(this._live ?? null) // 刷新徽标
        return
      }
      confirmUntil = performance.now() + 3000
      clearBtn.textContent = '确认清除？（再点一次）'
      clearBtn.classList.add('danger')
      setTimeout(() => {
        if (performance.now() >= confirmUntil) { clearBtn.textContent = '清除纪录'; clearBtn.classList.remove('danger') }
      }, 3100)
    }
    this.syncButtons()
  }

  // ---- 准星编辑器 ----
  // 改动统一走 _chMutate：改模型 → 存档 → 实时生效 → 刷新编辑器 UI。
  // 滑条 path 形如 "inner.length"（顶层键无点号）；开关 data-chkey 同一 path 语法
  _chMutate(fn) {
    fn(this.cfg.crosshair)
    saveSettings({ crosshair: this.cfg.crosshair })
    this.applyAll?.()
    this.refreshChUI()
  }

  _buildCrosshair(p) {
    // 色板：8 预设 + 自定义（input[type=color] 盖在色块上，点色块即弹选色器）
    const swBox = p.querySelector('.ch-swatches')
    PRESET_COLORS.forEach((c, i) => {
      const b = document.createElement('button')
      b.className = 'ch-swatch'
      b.style.background = '#' + c.hex
      b.dataset.idx = i
      b.setAttribute('aria-label', `准星颜色 ${c.name}`) // 色块无文字，读屏器需要名称
      b.onclick = () => this._chMutate((s) => { s.colorIdx = i; s.custom = c.hex })
      swBox.appendChild(b)
    })
    const custom = document.createElement('label')
    custom.className = 'ch-swatch ch-custom'
    custom.setAttribute('aria-label', '自定义准星颜色')
    const colorIn = document.createElement('input')
    colorIn.type = 'color'
    colorIn.oninput = () => this._chMutate((s) => {
      s.colorIdx = 8
      s.custom = colorIn.value.slice(1).toUpperCase()
    })
    custom.appendChild(colorIn)
    swBox.appendChild(custom)

    // 高级开关（开火淡出 / 移动淡出 / 误差叠加间距）
    const advBox = p.querySelector('[data-group=chAdv]')
    for (const [key, label] of [
      ['fadeFire', '开火时准星淡出（游戏默认开）'],
      ['fadeMove', '移动时准星淡出'],
      ['overrideFireOffset', '开火误差叠加在准星间距上'],
    ]) {
      const b = document.createElement('button')
      b.className = 'opt-btn'
      b.textContent = label
      b.dataset.value = key
      b.onclick = () => this._chMutate((s) => { s[key] = !s[key] })
      advBox.appendChild(b)
    }

    // 开关（data-chkey）：分组头（轮廓/中心点/内线/外线）与行内（移动/开火误差）
    for (const b of p.querySelectorAll('[data-chkey]')) {
      const rowLabel = b.closest('.slider-row')?.querySelector('label')?.textContent.trim()
      if (rowLabel) b.setAttribute('aria-label', rowLabel + ' 开关')
      b.onclick = () => {
        const [a, c] = b.dataset.chkey.split('.')
        this._chMutate((s) => { if (c) s[a][c] = !s[a][c]; else s[a] = !s[a] })
      }
    }
    // 长度联动开关：合上时垂直长度回跟水平长度
    for (const b of p.querySelectorAll('[data-chlink]')) {
      const g = b.dataset.chlink
      b.setAttribute('aria-label', '水平/垂直长度联动')
      b.onclick = () => this._chMutate((s) => {
        s[g].linked = !s[g].linked
        if (s[g].linked) s[g].vlength = s[g].length
      })
    }

    // 滑条（data-chp）：step=1 的字段按整数写回，其余（不透明度/倍率）保留小数
    this._chSliders = []
    for (const inp of p.querySelectorAll('input[data-chp]')) {
      const path = inp.dataset.chp
      this._chSliders.push({ inp, val: inp.parentElement.querySelector('.val'), path })
      inp.oninput = () => {
        const [a, c] = path.split('.')
        const v = inp.step === '1' ? Math.round(parseFloat(inp.value)) : parseFloat(inp.value)
        this._chMutate((s) => { if (c) s[a][c] = v; else s[a] = v })
      }
    }

    // 准星代码：导入（游戏内复制的分享代码原样可粘）/ 复制导出 / 重置默认
    const codeIn = p.querySelector('.ch-code-in')
    p.querySelector('.ch-import').onclick = () => {
      const s = parseCrosshairCode(codeIn.value)
      if (!s) { // 无效代码：输入框红闪一下，不动现有设置
        codeIn.classList.remove('err'); void codeIn.offsetWidth; codeIn.classList.add('err')
        return
      }
      this.cfg.crosshair = s
      codeIn.value = exportCrosshairCode(s) // 回显规范化代码（导入成功即有反馈）
      saveSettings({ crosshair: s })
      this.applyAll?.()
      this.refreshChUI()
    }
    p.querySelector('.ch-export').onclick = (e) => {
      const code = exportCrosshairCode(this.cfg.crosshair)
      codeIn.value = code
      navigator.clipboard?.writeText(code).catch(() => { /* 剪贴板不可用：代码已回显，手动复制 */ })
      e.target.textContent = '已复制'
      setTimeout(() => { e.target.textContent = '复制代码' }, 1200)
    }
    p.querySelector('.ch-reset').onclick = () => {
      this.cfg.crosshair = crosshairDefaults()
      saveSettings({ crosshair: this.cfg.crosshair })
      this.applyAll?.()
      this.refreshChUI()
    }

    // 预览画布（双倍 backing 保锐利；暗底渐变近似游戏预览的地图背景）
    const cv = p.querySelector('.ch-preview canvas')
    const PW = 240, PH = 140
    cv.width = PW * 2; cv.height = PH * 2
    cv.style.width = PW + 'px'; cv.style.height = PH + 'px'
    const ctx = cv.getContext('2d')
    ctx.scale(2, 2)
    this._chPrev = { ctx, PW, PH }
    this.refreshChUI()
  }

  // 编辑器全量刷新：滑条取值/填充、开关态、分组灰显、色板选中、预览重绘
  refreshChUI() {
    const s = this.cfg.crosshair
    const get = (path) => { const [a, b] = path.split('.'); return b ? s[a][b] : s[a] }
    const fmt = (path, v) => /Opacity$/.test(path) || path.endsWith('.opacity') ? Math.round(v * 100) + '%'
      : /Mult$/.test(path) ? '×' + Number(v).toFixed(1)
      : String(Math.round(v))
    for (const { inp, val, path } of this._chSliders ?? []) {
      const g = path.split('.')[0]
      const linked = path.endsWith('.vlength') && s[g]?.linked
      inp.value = linked ? s[g].length : get(path)
      inp.disabled = !!linked
      val.textContent = fmt(path, parseFloat(inp.value))
      const min = parseFloat(inp.min), max = parseFloat(inp.max)
      inp.style.setProperty('--p', ((parseFloat(inp.value) - min) / (max - min) * 100).toFixed(2) + '%')
    }
    for (const b of this.panel.querySelectorAll('[data-chkey]')) {
      const v = !!get(b.dataset.chkey)
      b.classList.toggle('active', v)
      if (b.classList.contains('sm')) b.textContent = v ? '开' : '关'
      // 灰显只由分组头开关控制（轮廓/中心点/内线/外线显示）——误差行开关同前缀，
      // 不能跟着灰显整组
      if (['outlines', 'dot', 'inner.show', 'outer.show'].includes(b.dataset.chkey)) {
        b.closest('.ch-group')?.classList.toggle('off', !v)
      }
    }
    for (const b of this.panel.querySelectorAll('[data-chlink]')) {
      b.classList.toggle('active', !!s[b.dataset.chlink]?.linked)
    }
    for (const b of this.panel.querySelectorAll('.ch-swatch[data-idx]')) {
      b.classList.toggle('active', +b.dataset.idx === s.colorIdx)
    }
    const customSw = this.panel.querySelector('.ch-custom')
    customSw.classList.toggle('active', s.colorIdx === 8)
    customSw.style.background = '#' + s.custom
    customSw.querySelector('input').value = '#' + s.custom
    for (const b of this.panel.querySelectorAll('[data-group=chAdv] .opt-btn')) {
      b.classList.toggle('active', !!s[b.dataset.value])
    }
    // 预览：静止形态（游戏设置面板的预览即静止准星）
    const { ctx, PW, PH } = this._chPrev ?? {}
    if (!ctx) return
    const grad = ctx.createLinearGradient(0, 0, 0, PH)
    grad.addColorStop(0, '#3a4a58')
    grad.addColorStop(1, '#161d26')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, PW, PH)
    ctx.globalAlpha = 0.25
    ctx.fillStyle = '#8fa3b5'
    ctx.fillRect(0, PH * 0.62, PW, 1) // 地平线参考线
    ctx.globalAlpha = 1
    paintCrosshair(ctx, s, { cx: PW / 2, cy: PH / 2 })
  }

  syncButtons() {
    for (const [group, key] of [['primary', 'primary'], ['secondary', 'secondary']]) {
      for (const b of this.panel.querySelectorAll(`[data-group=${group}] .opt-btn`)) {
        b.classList.toggle('active', b.dataset.value === String(this.cfg[key]))
      }
    }
    for (const b of this.panel.querySelectorAll('[data-group=gapSide] .opt-btn')) {
      b.classList.toggle('active', b.dataset.value === this.cfg.gapSide)
    }
    for (const b of this.panel.querySelectorAll('[data-group=flashMode] .opt-btn')) {
      b.classList.toggle('active', b.dataset.value === this.cfg.flash)
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
    this._live = live
    // 个人最佳徽标（有纪录才显示）；带生涯累计击杀
    const best = loadBests().hold ?? 0
    const totalKills = loadTotalKills()
    const badge = this.panel.querySelector('.menu-best')
    const hasRecord = best > 0 || totalKills > 0
    badge.hidden = !hasRecord
    if (hasRecord) {
      badge.innerHTML = (best > 0 ? `★ 最佳 <b>${best}</b>` : '') +
        (best > 0 && totalKills > 0 ? ' <span style="opacity:.4">|</span> ' : '') +
        (totalKills > 0 ? `生涯击杀 <b>${totalKills}</b>` : '')
    }
    // 暂停时的本局进行中战绩（ESC 呼出时有值；首屏/结算后为 null）
    const liveBox = this.panel.querySelector('.menu-live')
    // 有进行中的回合才显示"继续训练"（按钮置顶）
    const contBtn = this.panel.querySelector('.btn-continue')
    contBtn.hidden = !live
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
    this.refreshChUI()
    this.scrollBox.scrollTop = 0 // 每次呼出回到设置顶部（操作条固定在底部始终可见）
  }

  hide() {
    this.panel.hidden = true
    this.overlay.classList.remove('visible')
  }
}
