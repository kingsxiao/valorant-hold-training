// WebAudio 音效系统 v2
//  - 枪声为多层合成：瞬态脆响 + 腔体低频 + 机械咔哒 + 卷积混响尾音，经主总线压缩出"打感"
//  - 爆头"叮"声：双三角波不谐和分音 + 噪声瞬态
//  - 空间定位（HRTF）+ 距离衰减：敌人脚步/枪声可听声辨位
//  - 支持用户自有音频替换：把文件放进 public/sfx/（见该目录说明），加载后优先播放
//    （本仓库不附带任何游戏原始音频，请仅使用你拥有合法权利的文件）
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
    // 主总线：压缩器出"打感"
    this.comp = this.ctx.createDynamicsCompressor()
    this.comp.threshold.value = -14
    this.comp.knee.value = 8
    this.comp.ratio.value = 4
    this.comp.attack.value = 0.003
    this.comp.release.value = 0.16
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.comp).connect(this.ctx.destination)
    // 混响（生成的脉冲响应：指数衰减噪声）
    this.reverb = this.ctx.createConvolver()
    this.reverb.buffer = this._makeIR(1.3, 3.2)
    this.revGain = this.ctx.createGain()
    this.revGain.gain.value = 0.9
    this.reverb.connect(this.revGain).connect(this.master)
    // 非空间音效的总混响发送：只建一次（每次开火重建会造成并行增益叠加+节点泄漏）
    this.drySend = this.ctx.createGain()
    this.drySend.gain.value = 0.22
    this.master.connect(this.drySend).connect(this.reverb)
    // 共享白噪声
    const len = this.ctx.sampleRate
    this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const d = this._noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    this._loadUserSfx()
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
    const names = ['shot_rifle', 'shot_pistol', 'shot_handcannon', 'shot_knife',
      'headshot', 'kill', 'death', 'hurt', 'footstep', 'reload', 'empty', 'round_start']
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

  // 空间化输出节点（相对听者，返回 { node, revSend }）
  _spatial(pos, listener) {
    if (pos && listener) {
      const dx = pos.x - listener.pos.x, dz = pos.z - listener.pos.z
      const c = Math.cos(-listener.yaw), s = Math.sin(-listener.yaw)
      const lx = dx * c - dz * s, lz = dx * s + dz * c
      const p = this.ctx.createPanner()
      p.panningModel = 'HRTF'
      p.distanceModel = 'inverse'
      p.refDistance = 4
      p.rolloffFactor = 1.1
      if (p.positionX) { p.positionX.value = lx; p.positionY.value = 0; p.positionZ.value = -lz }
      else p.setPosition(lx, 0, -lz)
      p.connect(this.master)
      const send = this.ctx.createGain(); send.gain.value = 0.35
      p.connect(send).connect(this.reverb)
      return p
    }
    return this.master // 非空间：直接走主总线（混响发送已在 ensure 里一次性接好）
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
  shot(kind, pos, listener) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    // 用户替换优先
    const userKey = { rifle: 'shot_rifle', pistol: 'shot_pistol', handcannon: 'shot_handcannon', knife: 'shot_knife' }[kind]
    if (userKey && this.user[userKey]) {
      this._playBuffer(this.user[userKey], out, { gain: pos ? 0.8 : 1 })
      return
    }
    const own = !pos
    const v = own ? 1 : 0.8
    switch (kind) {
      case 'rifle': // 脆瞬态 + 腔体 + 机械层 + 混响尾
        this._noiseBurst(out, { dur: 0.012, freq: 5200, q: 0.5, gain: 1.1 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.09, freq: 1300, freqEnd: 320, q: 0.7, gain: 0.95 * v })
        this._osc(out, { type: 'sawtooth', freq: 190, freqEnd: 62, dur: 0.06, gain: 0.55 * v })
        this._noiseBurst(out, { dur: 0.025, freq: 3000, q: 2.5, gain: 0.28 * v, delay: 0.045 }) // 栓机回位
        break
      case 'pistol':
        this._noiseBurst(out, { dur: 0.01, freq: 4200, q: 0.5, gain: 0.85 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.06, freq: 1700, freqEnd: 480, q: 0.8, gain: 0.7 * v })
        this._osc(out, { type: 'square', freq: 260, freqEnd: 90, dur: 0.04, gain: 0.35 * v })
        break
      case 'handcannon':
        this._noiseBurst(out, { dur: 0.014, freq: 3800, q: 0.5, gain: 1.2 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.16, freq: 900, freqEnd: 180, q: 0.6, gain: 1.1 * v })
        this._osc(out, { type: 'sawtooth', freq: 140, freqEnd: 45, dur: 0.12, gain: 0.8 * v })
        break
      case 'knife':
        this._noiseBurst(out, { dur: 0.05, freq: 3600, q: 1.4, gain: 0.3 * v })
        break
    }
  }

  // ---- 命中反馈 ----
  hitMark(head) {
    this.ensure()
    if (!this.ctx) return
    if (head) {
      if (this.user.headshot) { this._playBuffer(this.user.headshot, this.master); return }
      // "叮"：不谐和双分音 + 瞬态，模拟金属头盔
      this._osc(this.master, { type: 'triangle', freq: 1244, dur: 0.16, gain: 0.5 })
      this._osc(this.master, { type: 'triangle', freq: 1867, dur: 0.1, gain: 0.28 })
      this._noiseBurst(this.master, { dur: 0.008, freq: 6000, q: 0.6, gain: 0.4, type: 'highpass' })
    } else {
      this._noiseBurst(this.master, { dur: 0.03, freq: 900, q: 1.2, gain: 0.4 })
      this._osc(this.master, { type: 'sine', freq: 320, freqEnd: 190, dur: 0.05, gain: 0.22 })
    }
  }

  kill() {
    this.ensure()
    if (!this.ctx) return
    if (this.user.kill) { this._playBuffer(this.user.kill, this.master); return }
    // 上行双音（确认感）+ 高八度泛音 + 金属瞬态 + 低频落点（击杀"分量"）
    this._osc(this.master, { type: 'sine', freq: 1046, dur: 0.09, gain: 0.42 })
    this._osc(this.master, { type: 'sine', freq: 1568, dur: 0.16, gain: 0.44, delay: 0.07 })
    this._osc(this.master, { type: 'sine', freq: 2093, dur: 0.22, gain: 0.16, delay: 0.07 })
    this._noiseBurst(this.master, { dur: 0.045, freq: 5200, q: 1.2, gain: 0.2, type: 'highpass', delay: 0.02 })
    this._osc(this.master, { type: 'sine', freq: 130, freqEnd: 58, dur: 0.11, gain: 0.3 })
  }

  death() { // 你被击杀
    this.ensure()
    if (!this.ctx) return
    if (this.user.death) { this._playBuffer(this.user.death, this.master); return }
    this._osc(this.master, { type: 'triangle', freq: 130, freqEnd: 45, dur: 0.34, gain: 0.9 })
    this._noiseBurst(this.master, { dur: 0.3, freq: 700, freqEnd: 120, q: 0.5, gain: 0.5 })
  }

  hurt() {
    this.ensure()
    if (!this.ctx) return
    if (this.user.hurt) { this._playBuffer(this.user.hurt, this.master); return }
    this._osc(this.master, { type: 'triangle', freq: 210, freqEnd: 80, dur: 0.12, gain: 0.6 })
    this._noiseBurst(this.master, { dur: 0.05, freq: 2500, q: 0.7, gain: 0.25 })
  }

  reload() {
    this.ensure()
    if (!this.ctx) return
    if (this.user.reload) { this._playBuffer(this.user.reload, this.master); return }
    this._noiseBurst(this.master, { dur: 0.035, freq: 2600, q: 2, gain: 0.5 })                 // 卸弹匣
    this._noiseBurst(this.master, { dur: 0.05, freq: 1500, q: 1.5, gain: 0.6, delay: 0.35 })   // 取新弹匣
    this._osc(this.master, { type: 'square', freq: 480, dur: 0.03, gain: 0.18, delay: 0.62 })  // 插入咔哒
    this._noiseBurst(this.master, { dur: 0.06, freq: 3200, q: 1.8, gain: 0.6, delay: 1.15 })   // 拉栓
    this._osc(this.master, { type: 'square', freq: 720, dur: 0.025, gain: 0.16, delay: 1.22 })
  }

  empty() {
    this.ensure()
    if (!this.ctx) return
    if (this.user.empty) { this._playBuffer(this.user.empty, this.master); return }
    this._noiseBurst(this.master, { dur: 0.02, freq: 3800, q: 2.5, gain: 0.4 })
    this._osc(this.master, { type: 'square', freq: 900, dur: 0.02, gain: 0.12, delay: 0.045 })
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
}
