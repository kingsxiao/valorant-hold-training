import * as THREE from 'three'
import { computeStats } from '../core/stats.js'
import { fmtMs } from './util.js'

// HUD：只在文本变化时写 DOM（避免每帧重排）；FPS 曲线用小 canvas
export class HUD {
  constructor(root) {
    this.root = root
    const el = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild }
    this.ammo = el(`<div id="hud-ammo" class="hud-block"><div class="wname">VANDAL</div><span class="mag">25</span> <span class="reserve">/ 75</span></div>`)
    this.mode = el(`<div id="hud-mode" class="hud-block"><div class="mode-title">架枪对枪</div><div class="mode-sub">60.0s</div></div>`)
    this.stats = el(`<div id="hud-stats" class="hud-block"></div>`)
    this.score = el(`<div id="hud-score" class="hud-block"><span class="lbl">SCORE</span><b class="num">0</b><span class="best">BEST 0</span></div>`)
    this.scoreFloat = el(`<div id="hud-score-float"></div>`)
    this.speed = el(`<div id="hud-speed">0.0 m/s</div>`)
    this.center = el(`<div id="hud-center"></div>`)
    this.toast = el(`<div id="hud-toast"></div>`)
    this.fpsBox = el(`<div id="hud-fps" class="hud-block"><span>-- fps</span><canvas width="150" height="36"></canvas></div>`)
    this.hitmarker = el(`<div id="hitmarker"><div class="hm" style="transform:translate(6px,6px) rotate(45deg)"></div><div class="hm" style="transform:translate(-14px,6px) rotate(-45deg)"></div><div class="hm" style="transform:translate(6px,-7px) rotate(-45deg)"></div><div class="hm" style="transform:translate(-14px,-7px) rotate(45deg)"></div></div>`)
    this.killfeed = el(`<div id="killfeed"></div>`)
    this.killBanner = el(`<div id="kill-banner"></div>`)
    for (const e of [this.ammo, this.mode, this.stats, this.score, this.scoreFloat, this.speed, this.center, this.toast, this.fpsBox, this.hitmarker, this.killfeed, this.killBanner]) root.appendChild(e)

    this.fpsCanvas = this.fpsBox.querySelector('canvas')
    // 高分屏清晰：曲线 canvas 逻辑分辨率 ×DPR（CSS 宽高固定 150×36，绘制以
    // canvas.width/height 为基准，等比放大即可）
    {
      const d = Math.min(2, devicePixelRatio || 1)
      this.fpsCanvas.width = 150 * d
      this.fpsCanvas.height = 36 * d
      this.fpsCanvas.style.width = '150px'
      this.fpsCanvas.style.height = '36px'
      this._fpsDpr = d
    }
    this.fpsCtx = this.fpsCanvas.getContext('2d')
    this.fpsFrames = new Float32Array(150)
    this.fpsIdx = 0

    this._cache = {}
    this.dmgPool = []
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div')
      d.className = 'dmg-num'
      d.style.opacity = '0'
      root.appendChild(d)
      this.dmgPool.push({ el: d, life: 0, x: 0, y: 0 })
    }
    this.hmTimer = 0
    this._lastStatsKey = ''
  }

  setText(node, key, text) {
    if (this._cache[key] !== text) { this._cache[key] = text; node.textContent = text }
  }

  setAmmo(w) {
    this.setText(this.ammo.querySelector('.wname'), 'wname', w.name.toUpperCase())
    this.setText(this.ammo.querySelector('.mag'), 'mag', '∞') // 弹药无限（架枪训练不中断节奏）
    this.setText(this.ammo.querySelector('.reserve'), 'reserve', '')
  }

  setMode(label, sub) {
    this.setText(this.mode.querySelector('.mode-title'), 'modeTitle', label)
    this.setText(this.mode.querySelector('.mode-sub'), 'modeSub', sub)
  }

  setStats(stats, engine) {
    const c = computeStats(stats)
    const rows = [
      ['击杀', c.kills],
      ['对枪败', c.duelsLost],
      ['命中率', c.accuracy + '%'],
      ['爆头率', c.headshotRate + '%'],
      ['反应均值', fmtMs(c.avgReactionMs) + 'ms'],
      ['最快反应', fmtMs(c.bestReactionMs) + 'ms'],
      ['反应波动', c.reactStdMs ? '±' + fmtMs(c.reactStdMs) + 'ms' : '—'],
      ['预瞄误差', c.aimSamples ? c.aimErrorDeg + '°' : '—'],
    ]
    const key = JSON.stringify(rows) + '|' + engine.fps + '|' + engine.low1Pct
    if (key === this._lastStatsKey) return
    this._lastStatsKey = key
    this.stats.innerHTML = rows.map(([k, v]) =>
      `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('') +
      `<div class="row" style="margin-top:4px"><span>FPS / 1%low</span><b class="accent">${engine.fps} / ${engine.low1Pct}</b></div>`
  }

  setSpeed(v) { this.setText(this.speed, 'speed', v.toFixed(1) + ' m/s') }

  // 实时分数 + 个人最佳（破纪录时高亮）
  setScore(score, best, record = false) {
    this.setText(this.score.querySelector('.num'), 'score', String(score))
    this.setText(this.score.querySelector('.best'), 'best', (record ? '★ NEW BEST ' : 'BEST ') + best)
    this.score.classList.toggle('record', record)
  }

  // 分数跳动反馈（得分瞬间）
  popScore() {
    this.score.classList.remove('pop')
    void this.score.offsetWidth
    this.score.classList.add('pop')
  }

  // 得分飘字：+N 从分数板下方升起消散
  floatScore(delta) {
    const e = this.scoreFloat
    e.textContent = '+' + delta
    e.classList.remove('go')
    void e.offsetWidth
    e.classList.add('go')
  }

  // 回合计时告急（≤10s）：变红强调
  setTimerUrgent(on) {
    if (this._cache.timerUrgent === on) return
    this._cache.timerUrgent = on
    this.mode.querySelector('.mode-sub').classList.toggle('urgent', on)
  }

  setCenter(html) {
    if (this._cache.center !== html) { this._cache.center = html; this.center.innerHTML = html }
  }

  toastMsg(text, ms = 1200) {
    this.toast.innerHTML = text
    this.toast.style.opacity = '1'
    clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => { this.toast.style.opacity = '0' }, ms)
  }

  // 命中标记：普通白 X / 爆头金红 / 击杀大红 X（旋转展开）
  showHitmarker(head, kill = false) {
    this.hitmarker.classList.remove('show', 'head', 'kill')
    void this.hitmarker.offsetWidth // 重置动画
    if (head) this.hitmarker.classList.add('head')
    if (kill) this.hitmarker.classList.add('kill')
    this.hitmarker.classList.add('show')
  }

  // 击杀横幅（屏幕中下：击杀 / 爆头 + 连杀 + 反应时长）
  showKill({ streak = 1, reaction = 0, head = false } = {}) {
    const b = this.killBanner
    const parts = [`<div class="kb-main">击杀${head ? '<span class="kb-hs">爆头</span>' : ''}</div>`]
    const subs = []
    if (streak >= 2) subs.push(`<span class="kb-streak">×${streak} 连杀</span>`)
    if (reaction > 0) subs.push(`<span class="kb-react">反应 ${reaction}ms</span>`)
    parts.push(`<div class="kb-sub">${subs.join('')}</div>`)
    b.innerHTML = parts.join('')
    b.classList.remove('show')
    void b.offsetWidth
    b.classList.add('show')
  }

  // 击杀信息流（右上角：你 → BOT-XX，爆头标记，最多 5 条，4s 后淡出）
  addKillFeed(victim, head = false, reaction = 0) {
    const e = document.createElement('div')
    e.className = 'kf' + (head ? ' head' : '')
    e.innerHTML = `<span class="kf-you">你</span>` +
      `<span class="kf-ico">${head ? '☠' : '➤'}</span>` +
      `<span class="kf-vic">${victim}</span>` +
      (reaction > 0 ? `<em>${reaction}ms</em>` : '')
    this.killfeed.prepend(e)
    while (this.killfeed.children.length > 5) this.killfeed.lastChild.remove()
    clearTimeout(e._t)
    e._t = setTimeout(() => { e.classList.add('out'); setTimeout(() => e.remove(), 400) }, 3800)
  }

  // 清空击杀信息流（新回合开始时）
  clearKillfeed() {
    this.killfeed.innerHTML = ''
  }

  // 伤害数字（世界坐标 → 屏幕投影，每帧更新存活的几个；击杀最后一段放大变红）
  spawnDamage(x, y, z, amount, head, camera, killed = false) {
    const d = this.dmgPool.reduce((a, b) => a.life < b.life ? a : b)
    d.life = 0.7
    d.x = x; d.y = y; d.z = z
    d.el.textContent = Math.round(amount)
    d.el.className = 'dmg-num' + (killed ? ' kill' : head ? ' head' : '')
    d.camera = camera
    d.el.style.opacity = '1'
  }

  updateDamage(dt) {
    const v = _v
    for (const d of this.dmgPool) {
      if (d.life <= 0) continue
      d.life -= dt
      if (d.life <= 0) { d.el.style.opacity = '0'; continue }
      v.set(d.x, d.y + (0.7 - d.life) * 0.9, d.z)
      v.project(d.camera)
      if (v.z > 1) { d.el.style.opacity = '0'; d.life = 0; continue }
      const sx = (v.x * 0.5 + 0.5) * innerWidth
      const sy = (-v.y * 0.5 + 0.5) * innerHeight
      // 出生弹跳（1.5 → 1.0）+ 击杀末段放大
      const pop = 1 + Math.max(0, (d.life - 0.55) / 0.15) * 0.5
      const end = d.el.classList.contains('kill') ? 1 + (0.7 - d.life) * 0.4 : 1
      d.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%) scale(${pop * end})`
      d.el.style.opacity = String(Math.min(1, d.life / 0.3))
    }
  }

  pushFps(frameMs) {
    this.fpsFrames[this.fpsIdx] = frameMs
    this.fpsIdx = (this.fpsIdx + 1) % this.fpsFrames.length
    const g = this.fpsCtx
    // setTransform 把 150×36 的逻辑坐标系映射到 ×DPR 的物理像素
    g.setTransform(this._fpsDpr ?? 1, 0, 0, this._fpsDpr ?? 1, 0, 0)
    g.clearRect(0, 0, 150, 36)
    g.fillStyle = 'rgba(255,255,255,0.12)'
    g.fillRect(0, 30, 150, 1) // 16.6ms 参考线（60fps）
    g.fillStyle = '#00ffb3'
    for (let i = 0; i < 150; i++) {
      const t = this.fpsFrames[(this.fpsIdx + i) % 150]
      if (!t) continue
      const h = Math.min(34, t / 33.4 * 34)
      g.fillRect(i, 36 - h, 1, h)
    }
  }

  setFpsText(txt) {
    const span = this.fpsBox.querySelector('span')
    if (this._cache.fpsText !== txt) { this._cache.fpsText = txt; span.textContent = txt }
  }
}

const _v = new THREE.Vector3()
