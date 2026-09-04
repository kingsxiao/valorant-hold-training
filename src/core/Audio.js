// WebAudio 音效系统 v3 —— 对标无畏契约的"打感"混音
//  - 主总线：HPF 去次声 → 压缩器 → tanh 软限幅 → 音量。软限幅让每层瞬态可以
//    堆得更满而不破音，是"枪声有力但不炸"的核心
//  - 枪声多层合成：超快脆瞬态(高频) + 腔体扫频(中频) + 低频"胸口感" + 机械循环层
//    + 干混响尾音；每发随机抖动增益/音高，全自动连射不像采样循环
//  - 消音武器（Phantom/Ghost）独立音色：去炸裂脆响、压低音量，保留闷"噗"与枪机轻响
//  - 敌方枪声按距离低通闷化（远处的枪声"厚而闷"），配合 HRTF 可听声辨位
//  - 爆头"叮"：不谐和钟体分音 + 金属瞬态 + 头盔"顿"感；击杀确认：分量低频 + 高频铃尾
//  - 支持用户自有音频替换：把文件放进 public/sfx/（见该目录说明），加载后优先播放
//    （本仓库不附带任何游戏原始音频，请仅使用你拥有合法权利的文件）

// 世界水平偏移 → 听者本地坐标（WebAudio 听者默认朝 -Z、无俯仰）。
// 玩家 yaw 遵循 three.js 约定：yaw=0 面向世界 -Z，正向 yaw 向左转。
// 本地系 = 世界系绕 Y 旋 -yaw：前方声源 z<0、右方声源 x>0。
export function worldToListener(dx, dz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  return { x: dx * c - dz * s, z: dx * s + dz * c }
}
export class AudioSys {
  constructor() {
    this.ctx = null
    this.master = null
    this.reverb = null
    this.revGain = null
    this.volume = 0.7
    this._noise = null
    this.user = {}       // 用户替换音效：name → AudioBuffer
    this._loadStarted = false
  }

  ensure() {
    if (this.ctx) { this.ctx.resume?.().catch?.(() => {}); return }
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    this.ctx = new Ctx()
    // 干声总线：所有音效先汇入 bus，再走总线处理链
    this.bus = this.ctx.createGain()
    // 1) 30Hz 高通：去掉无意义的次声能量，防止压缩器被低频"泵"
    this.hpf = this.ctx.createBiquadFilter()
    this.hpf.type = 'highpass'
    this.hpf.frequency.value = 30
    // 2) 压缩器：把多层瞬态"焊"在一起出打感
    this.comp = this.ctx.createDynamicsCompressor()
    this.comp.threshold.value = -13
    this.comp.knee.value = 10
    this.comp.ratio.value = 5
    this.comp.attack.value = 0.002
    this.comp.release.value = 0.12
    // 3) tanh 软限幅：峰值削平为谐波饱和 —— 更响、更紧、不破音
    this.clip = this.ctx.createWaveShaper()
    this.clip.curve = this._makeClipCurve()
    this.clip.oversample = '2x'
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    this.bus.connect(this.hpf).connect(this.comp).connect(this.clip).connect(this.master)
      .connect(this.ctx.destination)
    // 混响（生成的脉冲响应：指数衰减噪声）→ 并入压缩器前，不回流 bus（避免反馈回路）
    this.reverb = this.ctx.createConvolver()
    this.reverb.buffer = this._makeIR(1.2, 3.4)
    this.revGain = this.ctx.createGain()
    this.revGain.gain.value = 0.85
    this.reverb.connect(this.revGain).connect(this.comp)
    // 非空间音效的总混响发送：只建一次（每次开火重建会造成并行增益叠加+节点泄漏）
    this.drySend = this.ctx.createGain()
    this.drySend.gain.value = 0.16 // 自有枪声偏干（游戏内开火声很"贴耳"）
    this.bus.connect(this.drySend).connect(this.reverb)
    // 共享白噪声
    const len = this.ctx.sampleRate
    this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const d = this._noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    this._loadUserSfx()
  }

  _makeClipCurve() {
    const n = 1024
    const curve = new Float32Array(n)
    const k = 1.7
    const norm = Math.tanh(k)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(x * k) / norm
    }
    return curve
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v }

  _makeIR(seconds, decay) {
    const rate = this.ctx.sampleRate
    const len = Math.floor(rate * seconds)
    const buf = this.ctx.createBuffer(2, len, rate)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      let lp = 0
      for (let i = 0; i < len; i++) {
        const n = Math.random() * 2 - 1
        lp += (n - lp) * 0.18 // 简单一极低通，让尾音偏暗
        d[i] = lp * Math.pow(1 - i / len, decay)
      }
    }
    return buf
  }

  // ---- 用户自有音效加载（可选，404 时静默回退合成）----
  async _loadUserSfx() {
    if (this._loadStarted) return
    this._loadStarted = true
    const names = ['shot_rifle', 'shot_phantom', 'shot_pistol', 'shot_ghost', 'shot_handcannon', 'shot_knife',
      'headshot', 'kill', 'death', 'hurt', 'footstep', 'round_start']
    await Promise.all(names.map(async (name) => {
      for (const ext of ['mp3', 'wav', 'ogg']) {
        try {
          const url = new URL(`sfx/${name}.${ext}`, document.baseURI).href
          const res = await fetch(url)
          if (!res.ok) continue
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer())
          this.user[name] = buf
          return
        } catch { /* 换下一个扩展名/放弃 */ }
      }
    }))
  }

  // 空间化输出节点（相对听者，返回 { node, revSend }）。
  // 距离低通：远处枪声高频衰减（厚而闷），近处全频段 —— 声音"有距离"
  _spatial(pos, listener) {
    if (pos && listener) {
      const dx = pos.x - listener.pos.x, dz = pos.z - listener.pos.z
      const dist = Math.hypot(dx, dz)
      const { x: lx, z: lz } = worldToListener(dx, dz, listener.yaw)
      const p = this.ctx.createPanner()
      p.panningModel = 'HRTF'
      p.distanceModel = 'inverse'
      p.refDistance = 4
      p.rolloffFactor = 1.1
      if (p.positionX) { p.positionX.value = lx; p.positionY.value = 0; p.positionZ.value = lz }
      else p.setPosition(lx, 0, lz)
      const muffle = this.ctx.createBiquadFilter()
      muffle.type = 'lowpass'
      muffle.frequency.value = Math.max(1500, 22000 * Math.exp(-dist / 24))
      muffle.Q.value = 0.4
      p.connect(muffle).connect(this.bus)
      const send = this.ctx.createGain(); send.gain.value = 0.4
      muffle.connect(send).connect(this.reverb)
      return muffle
    }
    return this.bus // 非空间：直接走主总线（混响发送已在 ensure 里一次性接好）
  }

  _noiseBurst(dest, { dur = 0.08, freq = 1800, freqEnd = null, q = 0.8, gain = 1, type = 'bandpass', delay = 0 } = {}) {
    const t = this.ctx.currentTime + delay
    const src = this.ctx.createBufferSource()
    src.buffer = this._noise
    src.loop = true
    src.playbackRate.value = 0.8 + Math.random() * 0.4
    const f = this.ctx.createBiquadFilter()
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    src.connect(f).connect(g).connect(dest)
    src.start(t); src.stop(t + dur + 0.02)
  }

  _osc(dest, { type = 'triangle', freq = 200, freqEnd = null, dur = 0.1, gain = 0.5, delay = 0 } = {}) {
    const t = this.ctx.currentTime + delay
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(g).connect(dest)
    o.start(t); o.stop(t + dur + 0.02)
  }

  // 低频"分量"层：正弦速降（开火胸口感 / 击杀落点），频率微抖避免每发一样
  _thump(dest, { freq = 160, freqEnd = 48, dur = 0.08, gain = 0.5, delay = 0 } = {}) {
    const jitter = 1 + (Math.random() * 2 - 1) * 0.08
    this._osc(dest, { type: 'sine', freq: freq * jitter, freqEnd, dur, gain })
  }

  // 不谐和金属钟体：f / 1.5f / 2.5f 分音指数衰减（爆头叮 / 击杀铃尾共用）
  _metal(dest, freq, dur, gain, delay = 0) {
    const det = 1 + (Math.random() * 2 - 1) * 0.006
    this._osc(dest, { type: 'sine', freq: freq * det, dur: dur, gain })
    this._osc(dest, { type: 'sine', freq: freq * det * 1.504, dur: dur * 0.66, gain: gain * 0.44 })
    this._osc(dest, { type: 'sine', freq: freq * det * 2.51, dur: dur * 0.42, gain: gain * 0.22 })
  }

  _playBuffer(buf, dest, { gain = 1, rate = 1, delay = 0 } = {}) {
    const t = this.ctx.currentTime + delay
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = this.ctx.createGain()
    g.gain.value = gain
    src.connect(g).connect(dest)
    src.start(t)
  }

  // ---- 枪声 ----
  // 自有枪声（pos=null）全频段贴耳；敌方枪声（pos）经 HRTF + 距离低通
  shot(kind, pos, listener) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    // 用户替换优先（消音武器有专属替换则用，否则回退通用步枪/手枪替换）
    const userKey = {
      rifle: 'shot_rifle', rifle_suppressed: 'shot_phantom',
      pistol: 'shot_pistol', pistol_suppressed: 'shot_ghost',
      handcannon: 'shot_handcannon', knife: 'shot_knife',
    }[kind]
    const userBuf = this.user[userKey] ?? (kind === 'rifle_suppressed' ? this.user.shot_rifle
      : kind === 'pistol_suppressed' ? this.user.shot_pistol : null)
    if (userBuf) { this._playBuffer(userBuf, out, { gain: pos ? 0.8 : 1 }); return }

    const own = !pos
    const v = own ? 1 : 0.8
    // 每发微抖动：连射时层与层不完全一致 → 听感是"枪"而不是"循环"
    const j = 1 + (Math.random() * 2 - 1) * 0.1
    switch (kind) {
      case 'rifle': // 炸裂脆响 + 腔体扫频 + 中频拳 + 低频胸口 + 栓机循环
        this._noiseBurst(out, { dur: 0.011, freq: 5500 * j, q: 0.5, gain: 1.15 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.085, freq: 1400 * j, freqEnd: 300, q: 0.7, gain: 0.9 * v })
        this._osc(out, { type: 'sawtooth', freq: 185 * j, freqEnd: 58, dur: 0.055, gain: 0.5 * v })
        this._thump(out, { freq: 165, freqEnd: 46, dur: 0.08, gain: 0.62 * v })
        this._noiseBurst(out, { dur: 0.022, freq: 3000, q: 2.5, gain: 0.26 * v, delay: 0.045 }) // 栓机回位
        this._osc(out, { type: 'square', freq: 620, dur: 0.012, gain: 0.06 * v, delay: 0.045 })
        break
      case 'rifle_suppressed': // Phantom："噗"——无炸裂脆响，整体更轻
        this._noiseBurst(out, { dur: 0.065, freq: 1050 * j, freqEnd: 260, q: 0.9, gain: 0.85 * v })
        this._noiseBurst(out, { dur: 0.008, freq: 2600, q: 0.6, gain: 0.32 * v, type: 'highpass' })
        this._thump(out, { freq: 140, freqEnd: 55, dur: 0.06, gain: 0.4 * v })
        this._noiseBurst(out, { dur: 0.018, freq: 2200, q: 3, gain: 0.18 * v, delay: 0.04 })
        break
      case 'handcannon': // Sheriff：大口径炸裂 + 深低频 + 转轮回位
        this._noiseBurst(out, { dur: 0.012, freq: 4200 * j, q: 0.5, gain: 1.25 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.15, freq: 1000 * j, freqEnd: 170, q: 0.6, gain: 1.1 * v })
        this._osc(out, { type: 'sawtooth', freq: 150 * j, freqEnd: 40, dur: 0.11, gain: 0.8 * v })
        this._thump(out, { freq: 130, freqEnd: 38, dur: 0.13, gain: 0.8 * v })
        this._noiseBurst(out, { dur: 0.025, freq: 2600, q: 2.5, gain: 0.28 * v, delay: 0.06 })
        break
      case 'pistol':
        this._noiseBurst(out, { dur: 0.009, freq: 4600 * j, q: 0.5, gain: 0.9 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.055, freq: 1800 * j, freqEnd: 420, q: 0.8, gain: 0.72 * v })
        this._osc(out, { type: 'square', freq: 270 * j, freqEnd: 85, dur: 0.04, gain: 0.35 * v })
        this._thump(out, { freq: 170, freqEnd: 60, dur: 0.055, gain: 0.34 * v })
        this._noiseBurst(out, { dur: 0.016, freq: 3200, q: 2.5, gain: 0.18 * v, delay: 0.035 }) // 套筒复位
        break
      case 'pistol_suppressed': // Ghost：闷"噗" + 轻枪机
        this._noiseBurst(out, { dur: 0.05, freq: 1200 * j, freqEnd: 300, q: 1, gain: 0.68 * v })
        this._thump(out, { freq: 150, freqEnd: 60, dur: 0.045, gain: 0.3 * v })
        this._noiseBurst(out, { dur: 0.014, freq: 2600, q: 3, gain: 0.14 * v, delay: 0.035 })
        break
      case 'knife': // 挥砍破空声
        this._noiseBurst(out, { dur: 0.09, freq: 3000 * j, freqEnd: 700, q: 1.2, gain: 0.34 * v })
        break
    }
  }

  // ---- 命中反馈 ----
  hitMark(head, delay = 0) {
    this.ensure()
    if (!this.ctx) return
    if (head) {
      if (this.user.headshot) { this._playBuffer(this.user.headshot, this.master, { delay }); return }
      // 爆头"叮"：金属瞬态 + 不谐和钟体长衰减 + 头盔"顿"感 —— 清脆、有分量、辨识度
      this._noiseBurst(this.master, { dur: 0.006, freq: 7000, q: 0.6, gain: 0.5, type: 'highpass', delay })
      this._metal(this.master, 2560, 0.3, 0.42, delay)
      this._thump(this.master, { freq: 210, freqEnd: 90, dur: 0.06, gain: 0.26, delay })
    } else {
      if (this.user.hit) { this._playBuffer(this.user.hit, this.master, { delay }); return }
      // 身体命中："肉感"闷击 + 冲击体 + 脆点
      this._noiseBurst(this.master, { dur: 0.035, freq: 850, freqEnd: 300, q: 1.1, gain: 0.5, delay })
      this._osc(this.master, { type: 'sine', freq: 240, freqEnd: 130, dur: 0.045, gain: 0.3, delay })
      this._noiseBurst(this.master, { dur: 0.006, freq: 5000, q: 0.7, gain: 0.16, type: 'highpass', delay })
    }
  }

  kill(delay = 0, pitch = 1) {
    this.ensure()
    if (!this.ctx) return
    if (this.user.kill) { this._playBuffer(this.user.kill, this.master, { delay, rate: pitch }); return }
    // 击杀确认：低频"分量"落点 + 撕裂脆层 + 上行铃尾（确认感）+ 高频光泽
    // pitch：连杀每级升半音（上限 +4），听觉反馈连杀节奏
    this._thump(this.master, { freq: 170 * pitch, freqEnd: 44, dur: 0.13, gain: 0.55, delay })
    this._noiseBurst(this.master, { dur: 0.09, freq: 700 * pitch, freqEnd: 170, q: 0.9, gain: 0.4, delay })
    this._noiseBurst(this.master, { dur: 0.05, freq: 6500, q: 0.8, gain: 0.16, type: 'highpass', delay })
    this._osc(this.master, { type: 'triangle', freq: 1568 * pitch, dur: 0.07, gain: 0.2, delay: delay + 0.045 })
    this._metal(this.master, 2093 * pitch, 0.24, 0.18, delay + 0.055)
  }

  death() { // 你被击杀
    this.ensure()
    if (!this.ctx) return
    if (this.user.death) { this._playBuffer(this.user.death, this.master); return }
    this._osc(this.master, { type: 'triangle', freq: 130, freqEnd: 42, dur: 0.36, gain: 0.9 })
    this._noiseBurst(this.master, { dur: 0.32, freq: 700, freqEnd: 110, q: 0.5, gain: 0.5 })
    this._thump(this.master, { freq: 90, freqEnd: 30, dur: 0.3, gain: 0.5, delay: 0.02 })
  }

  hurt() {
    this.ensure()
    if (!this.ctx) return
    if (this.user.hurt) { this._playBuffer(this.user.hurt, this.master); return }
    this._osc(this.master, { type: 'triangle', freq: 210, freqEnd: 80, dur: 0.12, gain: 0.6 })
    this._noiseBurst(this.master, { dur: 0.05, freq: 2500, q: 0.7, gain: 0.25 })
  }

  footstep(pos, listener, running) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    if (this.user.footstep) {
      this._playBuffer(this.user.footstep, out, { gain: running ? 0.55 : 0.2, rate: 0.9 + Math.random() * 0.2 })
      return
    }
    this._noiseBurst(out, { dur: 0.05, freq: running ? 750 : 480, freqEnd: 220, q: 1.1, gain: running ? 0.5 : 0.16 })
    this._osc(out, { type: 'sine', freq: 95, freqEnd: 55, dur: 0.05, gain: running ? 0.22 : 0.08 })
  }

  roundStart() {
    this.ensure()
    if (!this.ctx) return
    if (this.user.round_start) { this._playBuffer(this.user.round_start, this.master); return }
    this._osc(this.master, { type: 'sine', freq: 880, dur: 0.1, gain: 0.35 })
    this._osc(this.master, { type: 'sine', freq: 1174, dur: 0.16, gain: 0.38, delay: 0.13 })
  }

  // 倒计时：前 3 秒低音 tick，最后一声高音"开始"提示
  countTick(final = false) {
    this.ensure()
    if (!this.ctx) return
    if (final) {
      this._osc(this.master, { type: 'square', freq: 880, dur: 0.12, gain: 0.3 })
      this._osc(this.master, { type: 'square', freq: 1760, dur: 0.2, gain: 0.22, delay: 0.02 })
    } else {
      this._osc(this.master, { type: 'square', freq: 660, dur: 0.07, gain: 0.22 })
    }
  }

  // 切枪：短促机械"咔啦"声（抽枪 + 上膛提示）
  equip() {
    this.ensure()
    if (!this.ctx) return
    this._noiseBurst(this.master, { dur: 0.035, freq: 2400, q: 1.8, gain: 0.32 })
    this._noiseBurst(this.master, { dur: 0.025, freq: 3600, q: 2.2, gain: 0.28, delay: 0.09 })
    this._osc(this.master, { type: 'square', freq: 480, dur: 0.02, gain: 0.1, delay: 0.1 })
  }
}
