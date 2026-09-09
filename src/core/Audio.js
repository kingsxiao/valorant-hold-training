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
    this.master.gain.value = Math.pow(this.volume, 0.62) // 感知补偿曲线（见 setVolume）
    // 干声直通：空间音效（_spatial/_movingVoice）与 UI/反馈音（爆头叮、击杀
    // 确认、倒计时等）接入这里——统一过压缩器+tanh 软限幅（多声叠加不破音），
    // 且不吃 bus 的混响发送（反馈要贴耳）；曾直连 master 绕过压限，击杀瞬间
    // 枪声+叮+确认音叠加可超 tanh 上限
    this.dryBus = this.ctx.createGain()
    this.dryBus.connect(this.hpf)
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

  // 音量滑杆 → 主增益的感知补偿曲线（幂律 0.62）：人耳响度感知近似对数，
  // 线性映射会把小音量端的弱信号（脚步、落点叮、低电平尾音）压进听阈以下
  // ——v=0.1 时线性只剩 10%，补偿后 24%，脚步仍可闻；v=1 端点不变
  setVolume(v) {
    this.volume = v
    if (this.master) this.master.gain.value = Math.pow(v, 0.62)
  }

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

  // 响度归一：自有录音电平参差（可比合成枪声大/小一个数量级）——按能量归一
  // 到合成音效基准（RMS≈0.18），±12dB 限幅防极端。增益挂在 buffer 的
  // _normGain 上，_playBuffer 统一消费，调用点零改动
  _userGain(buf) {
    const d = buf.getChannelData(0)
    let sum = 0, n = 0
    const step = Math.max(1, Math.floor(d.length / 20000)) // 抽样 ≤2 万点，解码后一次性
    for (let i = 0; i < d.length; i += step) { sum += d[i] * d[i]; n++ }
    const rms = Math.sqrt(sum / Math.max(1, n))
    if (!isFinite(rms) || rms < 1e-5) return 1
    return Math.min(4, Math.max(0.25, 0.18 / rms))
  }

  async _loadUserSfx() {
    if (this._loadStarted) return
    this._loadStarted = true
    const names = ['shot_rifle', 'shot_phantom', 'shot_pistol', 'shot_ghost', 'shot_handcannon', 'shot_knife',
      'headshot', 'hit', 'kill', 'death', 'hurt', 'footstep', 'round_start']
    await Promise.all(names.map(async (name) => {
      for (const ext of ['mp3', 'wav', 'ogg']) {
        try {
          const url = new URL(`sfx/${name}.${ext}`, document.baseURI).href
          const res = await fetch(url)
          if (!res.ok) continue
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer())
          buf._normGain = this._userGain(buf)
          this.user[name] = buf
          return
        } catch { /* 换下一个扩展名/放弃 */ }
      }
    }))
  }

  // 空间化输出节点（相对听者，返回声源注入点 = Panner 输入）。
  // 距离低通：远处枪声高频衰减（厚而闷），近处全频段 —— 声音"有距离"。
  // ⚠ 返回的必须是 Panner 而非其下游的 muffle：调用方把振荡器/噪声层
  // connect 进返回节点，接 muffle 会整层旁路 HRTF 与距离衰减（只剩闷化）——
  // 该 bug 曾长期潜伏：空间音永远正中、远近一样响
  _spatial(pos, listener) {
    if (pos && listener) {
      const dx = pos.x - listener.pos.x, dz = pos.z - listener.pos.z
      const dist = Math.hypot(dx, dz)
      const { x: lx, z: lz } = worldToListener(dx, dz, listener.yaw)
      const p = this.ctx.createPanner()
      p.panningModel = 'HRTF'
      p.distanceModel = 'inverse'
      // 距离曲线（修复 Panner 旁路后首次真实生效）：10m ≈ -4dB、20m ≈ -9dB、
      // 40m ≈ -15dB——有距离感但敌枪不消失（ref 4/rolloff 1.1 在 20m 就 -15dB 偏轻）
      p.refDistance = 6
      p.rolloffFactor = 0.8
      if (p.positionX) { p.positionX.value = lx; p.positionY.value = 0; p.positionZ.value = lz }
      else p.setPosition(lx, 0, lz)
      const muffle = this.ctx.createBiquadFilter()
      muffle.type = 'lowpass'
      muffle.frequency.value = Math.max(1500, 22000 * Math.exp(-dist / 24))
      muffle.Q.value = 0.4
      p.connect(muffle).connect(this.dryBus) // dryBus：吃自己的混响发送，不走 bus 总发送
      const send = this.ctx.createGain(); send.gain.value = 0.4
      muffle.connect(send).connect(this.reverb)
      // 节点生命周期：连入常驻图的 Panner/Filter/Gain 不会被 GC，高频
      // 空间音会无限累积（音频线程 CPU 缓慢上涨）。所有 SFX 都 <2s，3s 后拆链
      setTimeout(() => { try { send.disconnect(); muffle.disconnect(); p.disconnect() } catch { /* 已断 */ } }, 3000)
      return p
    }
    return this.bus // 非空间：直接走主总线（混响发送已在 ensure 里一次性接好）
  }

  // 声画同步提前量：WebAudio 的声音要到扬声器还要走 outputLatency（常见
  // 10-30ms，随设备/缓冲波动），而画面在下个 vsync（约半帧 ~8ms）就出现 →
  // 声音系统性晚于枪口闪光。把所有调度点提前 (输出延迟 − 半帧)，让"听到"
  // 与"看到"对齐；下限 0（延迟极低的设备不抢拍）。每秒刷新一次自适应缓冲变化
  _syncLead() {
    const now = this.ctx.currentTime
    if (this._leadAt === undefined || now - this._leadAt > 1) {
      const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0
      this._lead = Math.max(0, Math.min(0.08, lat - 0.008))
      this._leadAt = now
    }
    return this._lead
  }

  _noiseBurst(dest, { dur = 0.08, freq = 1800, freqEnd = null, q = 0.8, gain = 1, type = 'bandpass', delay = 0 } = {}) {
    const t = this.ctx.currentTime + delay + this._syncLead()
    const src = this.ctx.createBufferSource()
    src.buffer = this._noise
    src.loop = true
    src.playbackRate.value = 0.8 + Math.random() * 0.4
    const f = this.ctx.createBiquadFilter()
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur)
    const g = this.ctx.createGain()
    // 2ms 线性起振：噪声起点从 0 爬升，避免瞬态"咔"声（全音效通用）
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.002)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    src.connect(f).connect(g).connect(dest)
    src.start(t); src.stop(t + dur + 0.02)
  }

  _osc(dest, { type = 'triangle', freq = 200, freqEnd = null, dur = 0.1, gain = 0.5, delay = 0 } = {}) {
    const t = this.ctx.currentTime + delay + this._syncLead()
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur)
    const g = this.ctx.createGain()
    // 4ms 线性起振：正弦/方波类音符从 0 起振，消除爆音点击感（UI 音与长尾音受益最明显）
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.004)
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
    const t = this.ctx.currentTime + delay + this._syncLead()
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = this.ctx.createGain()
    g.gain.value = gain * (buf._normGain ?? 1) // 用户音效响度归一（合成 buffer 无此标记=1）
    src.connect(g).connect(dest)
    src.start(t)
  }

  // ---- 枪声 ----
  // 自有枪声（pos=null）全频段贴耳；敌方枪声（pos）经 HRTF + 距离低通
  // heat 0..1（连射热量）：越热机械层越亮、腔体越紧——长点射听感渐变而非循环
  shot(kind, pos, listener, heat = 0) {
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
    // 热量调制：高热时高频脆层更亮、低频胸口感更紧（频率上探），
    // 且枪管过热余振（微弱金属环）只在持续射击后出现
    const hb = 1 + heat * 0.3   // 亮度
    const ht = 1 + heat * 0.12  // 腔体张力
    // 每发微抖动：连射时层与层不完全一致 → 听感是"枪"而不是"循环"
    const j = 1 + (Math.random() * 2 - 1) * 0.1
    switch (kind) {
      case 'rifle': // 炸裂脆响 + 腔体扫频 + 中频拳 + 低频胸口 + 栓机循环
        this._noiseBurst(out, { dur: 0.011, freq: 5500 * j * hb, q: 0.5, gain: 1.15 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.085, freq: 1400 * j * ht, freqEnd: 300, q: 0.7, gain: 0.9 * v })
        this._osc(out, { type: 'sawtooth', freq: 185 * j * ht, freqEnd: 58, dur: 0.055, gain: 0.5 * v })
        this._thump(out, { freq: 165 * ht, freqEnd: 46, dur: 0.08, gain: 0.62 * v })
        this._noiseBurst(out, { dur: 0.022, freq: 3000, q: 2.5, gain: 0.26 * v * hb, delay: 0.045 }) // 栓机回位
        this._osc(out, { type: 'square', freq: 620, dur: 0.012, gain: 0.06 * v, delay: 0.045 })
        if (heat > 0.65) this._metal(out, 2900, 0.16, 0.05, 0.06) // 枪管过热余振
        break
      case 'rifle_suppressed': // Phantom："噗"——无炸裂脆响，整体更轻
        this._noiseBurst(out, { dur: 0.065, freq: 1050 * j * ht, freqEnd: 260, q: 0.9, gain: 0.85 * v })
        this._noiseBurst(out, { dur: 0.008, freq: 2600 * hb, q: 0.6, gain: 0.32 * v, type: 'highpass' })
        this._thump(out, { freq: 140 * ht, freqEnd: 55, dur: 0.06, gain: 0.4 * v })
        this._noiseBurst(out, { dur: 0.018, freq: 2200, q: 3, gain: 0.18 * v, delay: 0.04 })
        break
      case 'handcannon': // Sheriff：大口径炸裂 + 深低频 + 转轮回位
        this._noiseBurst(out, { dur: 0.012, freq: 4200 * j * hb, q: 0.5, gain: 1.25 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.15, freq: 1000 * j * ht, freqEnd: 170, q: 0.6, gain: 1.1 * v })
        this._osc(out, { type: 'sawtooth', freq: 150 * j * ht, freqEnd: 40, dur: 0.11, gain: 0.8 * v })
        this._thump(out, { freq: 130 * ht, freqEnd: 38, dur: 0.13, gain: 0.8 * v })
        this._noiseBurst(out, { dur: 0.025, freq: 2600, q: 2.5, gain: 0.28 * v, delay: 0.06 })
        // 击锤待击双响（"咔-哩"）：单动转轮的招牌机械节奏，与 vmBolt 慢回的
        // 击锤动画同拍校准——动画 217ms 走完（4.6/s）：半程 ~110ms 棘轮止动、
        // ~185ms 击锤压倒到位（原 130ms 第二响偏早，音画错拍）
        this._noiseBurst(out, { dur: 0.014, freq: 3400, q: 3, gain: 0.2 * v, delay: 0.11 })
        this._noiseBurst(out, { dur: 0.02, freq: 2700, q: 2.6, gain: 0.15 * v, delay: 0.185 })
        this._osc(out, { type: 'square', freq: 520, dur: 0.014, gain: 0.05 * v, delay: 0.185 })
        break
      case 'pistol':
        this._noiseBurst(out, { dur: 0.009, freq: 4600 * j * hb, q: 0.5, gain: 0.9 * v, type: 'highpass' })
        this._noiseBurst(out, { dur: 0.055, freq: 1800 * j * ht, freqEnd: 420, q: 0.8, gain: 0.72 * v })
        this._osc(out, { type: 'square', freq: 270 * j * ht, freqEnd: 85, dur: 0.04, gain: 0.35 * v })
        this._thump(out, { freq: 170 * ht, freqEnd: 60, dur: 0.055, gain: 0.34 * v })
        this._noiseBurst(out, { dur: 0.016, freq: 3200, q: 2.5, gain: 0.18 * v * hb, delay: 0.035 }) // 套筒复位
        break
      case 'pistol_suppressed': // Ghost：闷"噗" + 轻枪机
        this._noiseBurst(out, { dur: 0.05, freq: 1200 * j * ht, freqEnd: 300, q: 1, gain: 0.68 * v })
        this._thump(out, { freq: 150 * ht, freqEnd: 60, dur: 0.045, gain: 0.3 * v })
        this._noiseBurst(out, { dur: 0.014, freq: 2600, q: 3, gain: 0.14 * v, delay: 0.035 })
        break
      case 'knife': // 挥砍破空声
        this._noiseBurst(out, { dur: 0.09, freq: 3000 * j, freqEnd: 700, q: 1.2, gain: 0.34 * v })
        break
    }
  }

  // ---- 命中反馈 ----
  // pitch：爆头击杀路径按连杀升半音（与 kill() 同阶梯）——连杀中的"叮"越叮越高
  hitMark(head, delay = 0, pitch = 1) {
    this.ensure()
    if (!this.ctx) return
    if (head) {
      if (this.user.headshot) { this._playBuffer(this.user.headshot, this.bus, { delay, rate: pitch }); return }
      // 爆头"叮"：金属瞬态 + 不谐和钟体长衰减 + 头盔"顿"感 —— 清脆、有分量、辨识度
      this._noiseBurst(this.dryBus, { dur: 0.006, freq: 7000 * pitch, q: 0.6, gain: 0.5, type: 'highpass', delay })
      this._metal(this.dryBus, 2560 * pitch, 0.3, 0.42, delay)
      this._thump(this.dryBus, { freq: 210 * pitch, freqEnd: 90, dur: 0.06, gain: 0.26, delay })
    } else {
      if (this.user.hit) { this._playBuffer(this.user.hit, this.bus, { delay }); return }
      // 身体命中："肉感"闷击 + 冲击体 + 脆点
      this._noiseBurst(this.dryBus, { dur: 0.035, freq: 850, freqEnd: 300, q: 1.1, gain: 0.5, delay })
      this._osc(this.dryBus, { type: 'sine', freq: 240, freqEnd: 130, dur: 0.045, gain: 0.3, delay })
      this._noiseBurst(this.dryBus, { dur: 0.006, freq: 5000, q: 0.7, gain: 0.16, type: 'highpass', delay })
    }
  }

  // soft=爆头击杀路径：叮（hitMark head）承载"爆头"信息先落，确认音的高频
  // 铃尾层 ×0.8 让位——两套金属分音不糊在一起，层级分明
  kill(delay = 0, pitch = 1, soft = false) {
    this.ensure()
    if (!this.ctx) return
    if (this.user.kill) { this._playBuffer(this.user.kill, this.bus, { delay, rate: pitch }); return }
    // 击杀确认：低频"分量"落点 + 撕裂脆层 + 上行铃尾（确认感）+ 高频光泽
    // pitch：连杀每级升半音（上限 +4），听觉反馈连杀节奏
    const hs = soft ? 0.8 : 1
    this._thump(this.dryBus, { freq: 170 * pitch, freqEnd: 44, dur: 0.13, gain: 0.55, delay })
    this._noiseBurst(this.dryBus, { dur: 0.09, freq: 700 * pitch, freqEnd: 170, q: 0.9, gain: 0.4, delay })
    this._noiseBurst(this.dryBus, { dur: 0.05, freq: 6500, q: 0.8, gain: 0.16 * hs, type: 'highpass', delay })
    this._osc(this.dryBus, { type: 'triangle', freq: 1568 * pitch, dur: 0.07, gain: 0.2 * hs, delay: delay + 0.045 })
    this._metal(this.dryBus, 2093 * pitch, 0.24, 0.18 * hs, delay + 0.055)
  }

  // 子弹掠过（对枪失败 Bot 朝你开火）：超音速爆裂"啪" + 下滑呼啸尾，
  // 补方向感与"这波慢了"的威胁感——纯架枪训练无受伤设定，不盖过失败提示
  whiz() {
    this.ensure()
    if (!this.ctx) return
    this._noiseBurst(this.dryBus, { dur: 0.02, freq: 6000, q: 0.6, gain: 0.5, type: 'highpass' })
    this._noiseBurst(this.dryBus, { dur: 0.28, freq: 2600, freqEnd: 350, q: 2.4, gain: 0.22, delay: 0.015 })
    this._osc(this.dryBus, { type: 'sawtooth', freq: 900, freqEnd: 180, dur: 0.22, gain: 0.1, delay: 0.02 })
  }

  // 落地闷响：与 viewmodel 颠簸弹簧同步的触地反馈（强度随下落速度）
  land(k = 1) {
    this.ensure()
    if (!this.ctx) return
    const g = Math.min(0.5, 0.15 + k * 0.06)
    this._thump(this.bus, { freq: 130, freqEnd: 42, dur: 0.12, gain: g })
    this._noiseBurst(this.bus, { dur: 0.05, freq: 900, freqEnd: 220, q: 0.8, gain: g * 0.5 })
  }

  // 玩家自己的脚步 / Bot 脚步（空间化）：鞋底蹭地高频"沙" + 落地闷推 + 低频
  // 触地，每步随机音高/增益。speed（m/s，可选）→ 连续速度分层：1.5 以下走
  // 路档、4 满跑档、中间线性过渡——加速中的脚步是渐强而非两档跳变
  footstep(pos, listener, running, speed = null) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    const j = 1 + (Math.random() * 2 - 1) * 0.15
    // k 地板 0.25：低速段（拉出起步/撤离收尾）的脚步仍轻微可闻——
    // 静默起步会让"听声辨位"在 Bot 加速的前半程失效
    const k = speed === null ? (running ? 1 : 0)
      : 0.25 + 0.75 * Math.min(1, Math.max(0, (speed - 1.5) / 2.5))
    if (this.user.footstep) {
      this._playBuffer(this.user.footstep, out, { gain: 0.2 + 0.35 * k, rate: 0.9 + Math.random() * 0.2 })
      return
    }
    this._noiseBurst(out, { dur: 0.035, freq: 2600 * j, freqEnd: 900, q: 0.7, gain: 0.06 + 0.12 * k, type: 'highpass' })
    this._noiseBurst(out, { dur: 0.05, freq: (480 + 270 * k) * j, freqEnd: 220, q: 1.1, gain: 0.16 + 0.34 * k })
    this._osc(out, { type: 'sine', freq: 95 * j, freqEnd: 55, dur: 0.05, gain: 0.08 + 0.14 * k })
  }

  roundStart() {
    this.ensure()
    if (!this.ctx) return
    if (this.user.round_start) { this._playBuffer(this.user.round_start, this.bus); return }
    this._osc(this.dryBus, { type: 'sine', freq: 880, dur: 0.1, gain: 0.35 })
    this._osc(this.dryBus, { type: 'sine', freq: 1174, dur: 0.16, gain: 0.38, delay: 0.13 })
  }

  roundEnd() { // 回合结束：下行双音与开局音呼应，落点收尾
    this.ensure()
    if (!this.ctx) return
    this._osc(this.dryBus, { type: 'sine', freq: 1174, dur: 0.12, gain: 0.3 })
    this._osc(this.dryBus, { type: 'sine', freq: 880, dur: 0.22, gain: 0.32, delay: 0.14 })
    this._osc(this.dryBus, { type: 'sine', freq: 440, dur: 0.3, gain: 0.16, delay: 0.3 })
  }

  // 倒计时：前 3 秒低音 tick，最后一声高音"开始"提示
  // （三角波代替方波：方波奇次谐波太扎耳，长时间倒计时听感发噪）
  countTick(final = false) {
    this.ensure()
    if (!this.ctx) return
    if (final) {
      this._osc(this.dryBus, { type: 'triangle', freq: 880, dur: 0.12, gain: 0.34 })
      this._osc(this.dryBus, { type: 'triangle', freq: 1760, dur: 0.2, gain: 0.24, delay: 0.02 })
      this._osc(this.dryBus, { type: 'sine', freq: 2637, dur: 0.26, gain: 0.1, delay: 0.04 })
    } else {
      this._osc(this.dryBus, { type: 'triangle', freq: 660, dur: 0.07, gain: 0.26 })
    }
  }

  // 子弹命中硬表面（弹孔位）：中频"叩"+脆屑声，空间化在命中点——
  // 打墙有落点感，也补足"这发打偏了"的听觉信息。
  // ny=命中面法线 y 分量：地面（ny>0.7）换更闷更钝的音色（材质区分）。
  // vol=总音量：消音枪开枪声压得更低，落点音同步压一档（打墙不比开枪响）。
  // delay=按弹头飞行时间延迟（Bot 子弹从身旁掠过 → 身后墙上"嗒"）
  surfaceHit(pos, listener, ny = 0, vol = 1, delay = 0) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    const j = 1 + (Math.random() * 2 - 1) * 0.15
    if (ny > 0.7) { // 地面：尘土闷"噗"，无脆屑
      this._noiseBurst(out, { dur: 0.045, freq: 520 * j, freqEnd: 160, q: 1, gain: 0.4 * vol, delay })
      this._thump(out, { freq: 210, freqEnd: 80, dur: 0.06, gain: 0.24 * vol, delay })
    } else { // 墙面/硬表面
      this._noiseBurst(out, { dur: 0.03, freq: 900 * j, freqEnd: 260, q: 1.2, gain: 0.42 * vol, delay })
      this._osc(out, { type: 'sine', freq: 300 * j, freqEnd: 120, dur: 0.05, gain: 0.22 * vol, delay })
      this._noiseBurst(out, { dur: 0.012, freq: 5200, q: 0.8, gain: 0.12 * vol, type: 'highpass', delay })
    }
  }

  // 机体拍地：Bot 倒地动画触地帧的重量反馈——深闷"咚"+薄金属壳体泛音+
  // 内部零件散响，空间化在 Bot 位置（打死多远、砸在哪只耳朵边一听便知）
  bodyDrop(pos, listener) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    const j = 0.9 + Math.random() * 0.2
    this._thump(out, { freq: 110 * j, freqEnd: 38, dur: 0.14, gain: 0.5 })
    this._noiseBurst(out, { dur: 0.08, freq: 620 * j, freqEnd: 150, q: 1, gain: 0.38 })
    this._metal(out, 720 * j, 0.18, 0.14)
    this._noiseBurst(out, { dur: 0.05, freq: 2400, q: 2.2, gain: 0.1, delay: 0.05 }) // 零件散响
  }

  // 抛壳落地"叮"：黄铜轻碰地面的高频金属泛音，音量极低（氛围细节，
  // 绝不与下一发枪声打架）；每壳随机音高/响度，连发后地上一片碎铃
  shellTink(intensity = 1) {
    this.ensure()
    if (!this.ctx) return
    const j = 0.85 + Math.random() * 0.5
    const g = 0.05 * intensity * (0.5 + Math.random() * 0.5)
    this._noiseBurst(this.bus, { dur: 0.008, freq: 7000 * j, q: 0.7, gain: g * 1.4, type: 'highpass' })
    this._metal(this.bus, 4300 * j, 0.06, g)
  }

  // 头盔落地"哐"：比弹壳低沉的中频金属磕碰（爆头击杀的余韵反馈）。
  // 传落点坐标则空间化（HRTF 方位 + 距离衰减）——头盔弹在哪个缺口一听便知
  helmetClank(intensity = 1, pos = null, listener = null) {
    this.ensure()
    if (!this.ctx) return
    const out = pos && listener ? this._spatial(pos, listener) : this.bus
    const j = 0.9 + Math.random() * 0.3
    const g = 0.12 * intensity * (0.6 + Math.random() * 0.4)
    this._noiseBurst(out, { dur: 0.02, freq: 1600 * j, freqEnd: 500, q: 1.2, gain: g })
    this._metal(out, 940 * j, 0.14, g * 0.8)
    this._thump(out, { freq: 180, freqEnd: 70, dur: 0.06, gain: g * 0.6 })
  }

  // 切枪：抽枪"沙啦"（0ms，手抓旧枪下拉）+ 上膛"咔"（新枪托起中段）。
  // 上膛时刻与托起动画相位校准：换枪前 35% 旧枪下移、后 65% 新枪托起——
  // 上膛响落在托起 ~65% 处（equipTime×0.42），原固定 90ms 还在旧枪下移段=错拍
  equip(equipTime = 0.75) {
    this.ensure()
    if (!this.ctx) return
    const j = 1 + (Math.random() * 2 - 1) * 0.08
    const chamber = equipTime * 0.42
    this._noiseBurst(this.dryBus, { dur: 0.035, freq: 2400 * j, q: 1.8, gain: 0.32 })
    this._noiseBurst(this.dryBus, { dur: 0.025, freq: 3600 * j, q: 2.2, gain: 0.28, delay: chamber })
    this._osc(this.dryBus, { type: 'square', freq: 480 * j, dur: 0.02, gain: 0.1, delay: chamber + 0.01 })
  }

  // ---- 闪光道具（敌方干扰；音色按各道具特征还原，全部合成）----
  // 飞行中的移动声源（斯凯鹰振翅 / 火男火球灼烧）：与 _spatial 的一次性 3s
  // 自动拆链不同，这里返回句柄由 FlashSystem 每帧更新位置、消亡时显式 stop
  _movingVoice(listener) {
    this.ensure()
    if (!this.ctx) return null
    const p = this.ctx.createPanner()
    p.panningModel = 'HRTF'
    p.distanceModel = 'inverse'
    p.refDistance = 6
    p.rolloffFactor = 0.8
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'; lp.frequency.value = 15000; lp.Q.value = 0.3
    const g = this.ctx.createGain()
    // 声源注入点 = Panner 输入（p→lp→g→dryBus）：接 g 会旁路 HRTF/距离衰减
    p.connect(lp).connect(g).connect(this.dryBus)
    const rev = this.ctx.createGain(); rev.gain.value = 0.3
    g.connect(rev).connect(this.reverb)
    return {
      input: p,
      setPos(x, y, z) {
        if (!listener?.pos) return
        const { x: lx, z: lz } = worldToListener(x - listener.pos.x, z - listener.pos.z, listener.yaw ?? 0)
        if (p.positionX) { p.positionX.value = lx; p.positionY.value = y; p.positionZ.value = lz }
        else p.setPosition(lx, y, lz)
      },
      stop() { try { rev.disconnect(); g.disconnect(); lp.disconnect(); p.disconnect() } catch { /* 已断 */ } },
    }
  }

  // 出手声（投掷/放鹰/点火），空间化在投掷起点（墙后敌人位置）
  flashCast(kind, pos, listener) {
    this.ensure()
    if (!this.ctx) return
    if (kind === 'yoru') return // v11.10：敌方听不到飞行中的盲侧碎片——保持完全无声
    const out = this._spatial(pos, listener)
    if (kind === 'kayo') { // 抛掷破空 + 机关展开轻响（飞行途中无声——v3.06 已移除飞行音）
      this._noiseBurst(out, { dur: 0.16, freq: 700, freqEnd: 1600, q: 1, gain: 0.3 })
      this._osc(out, { type: 'square', freq: 620, freqEnd: 380, dur: 0.045, gain: 0.06, delay: 0.02 })
    } else if (kind === 'skye') { // 鹰离手：气流上升 + 两下振翅 + 鹰啸（标志性叫声）
      this._noiseBurst(out, { dur: 0.28, freq: 900, freqEnd: 2100, q: 1.4, gain: 0.32 })
      this._noiseBurst(out, { dur: 0.05, freq: 1100, q: 2, gain: 0.16, delay: 0.16 })
      this._noiseBurst(out, { dur: 0.05, freq: 1000, q: 2, gain: 0.14, delay: 0.3 })
      this._hawkCry(out, 0.05, 1850, 0.26, 0.11)
      this._hawkCry(out, 0.36, 1600, 0.18, 0.07)
    } else if (kind === 'breach') { // 穿墙放置：闷雷般的墙体震动 + 装置锁定咔哒
      this._thump(out, { freq: 90, freqEnd: 42, dur: 0.22, gain: 0.5 })
      this._noiseBurst(out, { dur: 0.1, freq: 500, freqEnd: 220, q: 1.2, gain: 0.22, delay: 0.02 })
      this._osc(out, { type: 'square', freq: 320, freqEnd: 520, dur: 0.05, gain: 0.08, delay: 0.16 })
    } else if (kind === 'reyna') { // 凝视之眼：魂雾升腾——气声上升 + 高频魂啸拖尾
      this._noiseBurst(out, { dur: 0.4, freq: 500, freqEnd: 2400, q: 1.1, gain: 0.2 })
      this._osc(out, { type: 'sawtooth', freq: 660, freqEnd: 1320, dur: 0.5, gain: 0.05, delay: 0.1 })
    } else if (kind === 'gecko') { // Dizzy 出手：两声上扬生物啾叫
      this._osc(out, { type: 'sine', freq: 880, freqEnd: 1560, dur: 0.09, gain: 0.16 })
      this._osc(out, { type: 'sine', freq: 1180, freqEnd: 2100, dur: 0.11, gain: 0.14, delay: 0.12 })
    } else { // 火男点火出手：低频起燃 + 高频嘶响
      this._noiseBurst(out, { dur: 0.3, freq: 350, freqEnd: 1300, q: 1, gain: 0.3 })
      this._noiseBurst(out, { dur: 0.22, freq: 2600, q: 1.6, gain: 0.12, delay: 0.05 })
    }
  }

  // 鹰啸：下滑锯波 + 27Hz 颤音 + 带通收窄（猛禽嘶鸣的合成近似）
  _hawkCry(dest, delay, baseFreq, dur, gain) {
    const t = this.ctx.currentTime + delay
    const o = this.ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(baseFreq, t)
    o.frequency.exponentialRampToValueAtTime(baseFreq * 0.62, t + dur)
    const vib = this.ctx.createOscillator()
    vib.frequency.value = 27
    const vibG = this.ctx.createGain(); vibG.gain.value = baseFreq * 0.022
    vib.connect(vibG).connect(o.frequency)
    const f = this.ctx.createBiquadFilter()
    f.type = 'bandpass'; f.frequency.value = baseFreq; f.Q.value = 1.6
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(f).connect(g).connect(dest)
    o.start(t); o.stop(t + dur + 0.02)
    vib.start(t); vib.stop(t + dur + 0.02)
  }

  // KAY/O 手雷落地/撞墙弹跳：硬物"咔嗒"。n=弹跳序号：恢复系数 0.32 意味着
  // 每跳剩 ~1/3 能量——音量按 0.78^n 递减、音高微升（低速碰撞偏高频短响），
  // 连听几声即知"滚了几跳、快停了"
  flashBounce(pos, listener, n = 1) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    const decay = Math.pow(0.78, n - 1)
    this._noiseBurst(out, { dur: 0.03, freq: 2100 * (1 + 0.1 * (n - 1)), q: 3, gain: 0.4 * decay })
    this._thump(out, { freq: 160, freqEnd: 80, dur: 0.05, gain: 0.22 * decay })
  }

  // KAY/O 弹跳后的引信嗡鸣（v10.06 起的 unique audio）：双失谐锯 + 方波八度的
  // 电子充能声，音高/亮度随引信倒数爬升——dur 传"剩余引信"，结束沿恰好压在起爆上
  flashHum(dur, pos, listener) {
    this.ensure()
    if (!this.ctx || dur <= 0.05) return
    const out = this._spatial(pos, listener)
    const t = this.ctx.currentTime
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.13, t + Math.min(0.12, dur * 0.4))
    g.gain.setValueAtTime(0.13, t + dur * 0.88)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    g.connect(out)
    const f = this.ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(700, t)
    f.frequency.exponentialRampToValueAtTime(3600, t + dur)
    f.Q.value = 0.8
    f.connect(g)
    for (const [type, mul, gain] of [['sawtooth', 1, 0.5], ['sawtooth', 1.008, 0.5], ['square', 2, 0.22]]) {
      const o = this.ctx.createOscillator()
      o.type = type
      o.frequency.setValueAtTime(170 * mul, t)
      o.frequency.exponentialRampToValueAtTime(840 * mul, t + dur)
      const og = this.ctx.createGain(); og.gain.value = gain
      o.connect(og).connect(f)
      o.start(t); o.stop(t + dur + 0.02)
    }
    // 机器质感的快速颤动（13Hz 幅度脉动）
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 13
    const lfoG = this.ctx.createGain(); lfoG.gain.value = 0.035
    lfo.connect(lfoG).connect(g.gain)
    lfo.start(t); lfo.stop(t + dur + 0.02)
  }

  // 斯凯鹰充能完成提示（维基：到最大致盲时长时橙光 + 专属音频提示）
  flashCharge(pos, listener) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    this._osc(out, { type: 'sine', freq: 1750, freqEnd: 2350, dur: 0.07, gain: 0.15 })
    this._osc(out, { type: 'sine', freq: 2350, freqEnd: 2900, dur: 0.07, gain: 0.13, delay: 0.09 })
  }

  // 激活起爆预备（斯凯鹰 0.3s 起爆预备）：上扬闪亮
  flashArm(pos, listener) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    this._osc(out, { type: 'sine', freq: 900, freqEnd: 2600, dur: 0.27, gain: 0.17 })
    this._noiseBurst(out, { dur: 0.28, freq: 1600, freqEnd: 4200, q: 1.6, gain: 0.11 })
  }

  // 起爆"爆闪"：炸裂脆响 + 腔体爆音 + 深低频 + 金属余音，按道具加特征层。
  // intensity：闪中玩家时按致盲比例加响（贴脸爆闪比远处墙后爆更炸）。
  // blinded=false（背对/无视线躲过）：高频脆响 ×0.55、金属余音 ×0.8——
  // 头影遮蔽的直觉 + "这颗没闪到你"的听觉确认，背身成功听得出来
  flashPop(kind, pos, listener, intensity = 1, blinded = true) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    const v = intensity
    const hb = blinded ? 1 : 0.55 // 高频层（头影遮蔽）
    this._noiseBurst(out, { dur: 0.011, freq: 6200, q: 0.5, gain: 1.3 * v * hb, type: 'highpass' })
    this._noiseBurst(out, { dur: 0.26, freq: 850, freqEnd: 140, q: 0.7, gain: 1.12 * v })
    this._thump(out, { freq: 130, freqEnd: 36, dur: 0.16, gain: 0.85 * v })
    this._metal(out, 3600, 0.34, 0.24 * v * (blinded ? 1 : 0.8))
    if (kind === 'phoenix') { // 火光炸开：炽烈灼烧嘶响 + 高频碎焰，收尾最亮
      this._noiseBurst(out, { dur: 0.42, freq: 2400, freqEnd: 420, q: 1.8, gain: 0.4 * v, delay: 0.015 })
      this._noiseBurst(out, { dur: 0.12, freq: 7500, q: 0.8, gain: 0.3 * v, type: 'highpass' })
    } else if (kind === 'skye') { // 自然光爆：高频闪亮 + 高音铃尾 + 轻羽散落簌簌
      this._osc(out, { type: 'sine', freq: 5400, freqEnd: 3200, dur: 0.16, gain: 0.15 * v, delay: 0.01 })
      this._metal(out, 4800, 0.18, 0.1 * v, 0.03)
      this._noiseBurst(out, { dur: 0.07, freq: 2400, q: 1.2, gain: 0.08 * v, delay: 0.09 })
      this._noiseBurst(out, { dur: 0.07, freq: 2100, q: 1.2, gain: 0.06 * v, delay: 0.19 })
    } else if (kind === 'yoru') { // 维度碎裂：玻璃脆响 + 低频暗涌（冷色的"裂开"感）
      this._noiseBurst(out, { dur: 0.09, freq: 4200, q: 3, gain: 0.34 * v, delay: 0.004 })
      this._metal(out, 2900, 0.22, 0.16 * v)
      this._thump(out, { freq: 96, freqEnd: 34, dur: 0.3, gain: 0.5 * v, delay: 0.01 })
    } else if (kind === 'breach') { // 双联冲击：主爆后 90ms 追一记闷雷（穿墙震动感）
      this._thump(out, { freq: 120, freqEnd: 38, dur: 0.3, gain: 0.75 * v, delay: 0.09 })
      this._noiseBurst(out, { dur: 0.3, freq: 600, freqEnd: 130, q: 0.8, gain: 0.5 * v, delay: 0.09 })
      this._metal(out, 2200, 0.3, 0.2 * v)
    } else { // KAY/O：电子脆响叠加（机器道具的"咔-嗡"收束）
      this._osc(out, { type: 'square', freq: 1400, freqEnd: 300, dur: 0.05, gain: 0.22 * v, delay: 0.004 })
      this._noiseBurst(out, { dur: 0.03, freq: 3100, q: 4, gain: 0.3 * v, delay: 0.005 })
    }
  }

  // 飞行物撞墙熄灭（弧线球/鹰被地形阻挡）：短促泄气"嘶"
  flashFizzle(pos, listener) { // 撞墙熄灭（火男弧线球）：可听的"安全"确认——这颗不会爆
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    this._noiseBurst(out, { dur: 0.22, freq: 1900, freqEnd: 420, q: 1.6, gain: 0.26 })
    this._noiseBurst(out, { dur: 0.1, freq: 3600, freqEnd: 900, q: 2, gain: 0.12, delay: 0.04 })
  }

  // 斯凯鹰飞行循环：底层气流 + 8.5Hz 振翅（下击带通/上击高频，相位错半拍）。
  // 振翅频率与翅膀动画同源（8.5Hz、同锚定出手时刻）——看到的翅膀与听到的
  // 扑翼是同一拍；0.35Hz 轻微拍频漂移避免机械感
  hawkFlight(listener, flapHz = 8.5) {
    const v = this._movingVoice(listener)
    if (!v) return null
    const t = this.ctx.currentTime
    // 气流底噪
    const air = this.ctx.createBufferSource()
    air.buffer = this._noise; air.loop = true
    const airF = this.ctx.createBiquadFilter(); airF.type = 'bandpass'; airF.frequency.value = 600; airF.Q.value = 0.6
    const airG = this.ctx.createGain(); airG.gain.value = 0.15
    air.connect(airF).connect(airG).connect(v.input)
    // 振翅下击（低频拍打）
    const dn = this.ctx.createBufferSource()
    dn.buffer = this._noise; dn.loop = true
    const dnF = this.ctx.createBiquadFilter(); dnF.type = 'bandpass'; dnF.frequency.value = 850; dnF.Q.value = 1.5
    const dnG = this.ctx.createGain(); dnG.gain.value = 0.42
    dn.connect(dnF).connect(dnG).connect(v.input)
    // 振翅上击（翅尖切风，滞后半拍）
    const up = this.ctx.createBufferSource()
    up.buffer = this._noise; up.loop = true; up.playbackRate.value = 1.2
    const upF = this.ctx.createBiquadFilter(); upF.type = 'highpass'; upF.frequency.value = 2600
    const upG = this.ctx.createGain(); upG.gain.value = 0.1
    up.connect(upF).connect(upG).connect(v.input)
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = flapHz
    const lfoG = this.ctx.createGain(); lfoG.gain.value = 0.4
    lfo.connect(lfoG).connect(dnG.gain)
    const half = this.ctx.createDelay(0.13); half.delayTime.value = 0.5 / flapHz
    const upLfoG = this.ctx.createGain(); upLfoG.gain.value = 0.09
    lfo.connect(half).connect(upLfoG).connect(upG.gain)
    // 拍频轻微漂移（活物感）
    const drift = this.ctx.createOscillator(); drift.frequency.value = 0.35
    const driftG = this.ctx.createGain(); driftG.gain.value = 0.5
    drift.connect(driftG).connect(lfo.frequency)
    air.start(t); dn.start(t); up.start(t); lfo.start(t); drift.start(t)
    return {
      setPos: v.setPos,
      flapHz,
      stop: () => {
        try { air.stop(); dn.stop(); up.stop(); lfo.stop(); drift.stop(); v.stop() } catch { /* 已停 */ }
      },
    }
  }

  // 火男弧线球飞行循环：火焰灼烧底噪随 0.6s 引信指数渐强 + 上升"哨音"音调
  // （v1.06：音频明确提示何时该背身）——渐强终点=起爆时刻，音画同拍
  orbFlight(listener, dur = 0.6) {
    const v = this._movingVoice(listener)
    if (!v) return null
    const t = this.ctx.currentTime
    const src = this.ctx.createBufferSource()
    src.buffer = this._noise; src.loop = true; src.playbackRate.value = 0.9
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8
    bp.frequency.setValueAtTime(700, t)
    bp.frequency.exponentialRampToValueAtTime(1500, t + dur) // 越烧越亮
    const amp = this.ctx.createGain()
    amp.gain.setValueAtTime(0.1, t)
    amp.gain.exponentialRampToValueAtTime(0.32, t + dur)
    const src2 = this.ctx.createBufferSource()
    src2.buffer = this._noise; src2.loop = true; src2.playbackRate.value = 1.2
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3200
    const amp2 = this.ctx.createGain()
    amp2.gain.setValueAtTime(0.025, t)
    amp2.gain.exponentialRampToValueAtTime(0.1, t + dur)
    // 上升哨音：临爆前的音调警告
    const tone = this.ctx.createOscillator()
    tone.type = 'sine'
    tone.frequency.setValueAtTime(320, t)
    tone.frequency.exponentialRampToValueAtTime(1050, t + dur)
    const toneG = this.ctx.createGain()
    toneG.gain.setValueAtTime(0.0001, t)
    toneG.gain.exponentialRampToValueAtTime(0.06, t + dur * 0.8)
    toneG.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(bp).connect(amp).connect(v.input)
    src2.connect(hp).connect(amp2).connect(v.input)
    tone.connect(toneG).connect(v.input)
    src.start(t); src2.start(t); tone.start(t); tone.stop(t + dur + 0.02)
    return {
      setPos: v.setPos,
      stop: () => {
        try { src.stop(); src2.stop(); tone.stop(); v.stop() } catch { /* 已停 */ }
      },
    }
  }

  // Yoru 盲侧碎片显形预备（撞面后 0.6s）：维度裂隙声——失谐双音上行 + 碎裂
  // 高频嘶响，dur 传剩余预备时长，收尾压在起爆上（与 KAY/O 嗡鸣同构、音色更"裂"）
  riftWindup(dur, pos, listener) {
    this.ensure()
    if (!this.ctx || dur <= 0.05) return
    const out = this._spatial(pos, listener)
    const t = this.ctx.currentTime
    for (const [mul, type, gain] of [[1, 'sawtooth', 0.09], [1.013, 'sawtooth', 0.09], [2.02, 'triangle', 0.05]]) {
      const o = this.ctx.createOscillator()
      o.type = type
      o.frequency.setValueAtTime(240 * mul, t)
      o.frequency.exponentialRampToValueAtTime(1250 * mul, t + dur)
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.08, dur * 0.3))
      g.gain.setValueAtTime(gain, t + dur * 0.85)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      o.connect(g).connect(out)
      o.start(t); o.stop(t + dur + 0.02)
    }
    this._noiseBurst(out, { dur: dur * 0.9, freq: 2600, freqEnd: 6800, q: 2.2, gain: 0.07, type: 'highpass' })
  }

  // Reyna 凝视之眼悬停循环：失谐正弦双音低鸣 + 0.4Hz 拍频（魂雾里"睁着的眼"）
  leerHum(listener) {
    const v = this._movingVoice(listener)
    if (!v) return null
    const t = this.ctx.currentTime
    const oscs = []
    for (const [f, g] of [[310, 0.05], [318, 0.05], [636, 0.02]]) {
      const o = this.ctx.createOscillator()
      o.type = 'sine'; o.frequency.value = f
      const og = this.ctx.createGain(); og.gain.value = g
      o.connect(og).connect(v.input)
      o.start(t)
      oscs.push(o)
    }
    return {
      setPos: v.setPos,
      stop: () => {
        try { for (const o of oscs) o.stop(); v.stop() } catch { /* 已停 */ }
      },
    }
  }

  // Gekko Dizzy 悬停循环：活泼啾鸣 LFO（5Hz 颤音调制的正弦短音群）+ 轻微扑翼气声
  dizzyFlight(listener) {
    const v = this._movingVoice(listener)
    if (!v) return null
    const t = this.ctx.currentTime
    const o = this.ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(950, t)
    o.frequency.linearRampToValueAtTime(1250, t + 0.5)
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 5
    const lfoG = this.ctx.createGain(); lfoG.gain.value = 0.045
    const g = this.ctx.createGain(); g.gain.value = 0.05
    lfo.connect(lfoG).connect(g.gain)
    o.connect(g).connect(v.input)
    const air = this.ctx.createBufferSource()
    air.buffer = this._noise; air.loop = true
    const airF = this.ctx.createBiquadFilter(); airF.type = 'bandpass'; airF.frequency.value = 1200; airF.Q.value = 1.4
    const airG = this.ctx.createGain(); airG.gain.value = 0.05
    air.connect(airF).connect(airG).connect(v.input)
    o.start(t); lfo.start(t); air.start(t)
    return {
      setPos: v.setPos,
      stop: () => { try { o.stop(); lfo.stop(); air.stop(); v.stop() } catch { /* 已停 */ } },
    }
  }

  // 等离子糊屏：黏稠"啪叽"——下滑方波 + 带通甩溅 + 湿润低频
  plasmaSplat(pos, listener) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    this._osc(out, { type: 'square', freq: 1400, freqEnd: 220, dur: 0.12, gain: 0.2 })
    this._noiseBurst(out, { dur: 0.3, freq: 1900, freqEnd: 320, q: 1.1, gain: 0.34, delay: 0.01 })
    this._thump(out, { freq: 150, freqEnd: 55, dur: 0.18, gain: 0.3, delay: 0.02 })
    this._osc(out, { type: 'sine', freq: 420, freqEnd: 160, dur: 0.4, gain: 0.07, delay: 0.1 })
  }

  // 可击毁道具受击（Leer/Dizzy）：脆响按剩余血量变调（快碎时音高发紧）
  propHit(pos, listener, hpFrac = 0.5) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    const f = 1800 + (1 - hpFrac) * 900
    this._noiseBurst(out, { dur: 0.04, freq: f, q: 3, gain: 0.3 })
    this._osc(out, { type: 'triangle', freq: f * 0.5, freqEnd: f * 0.3, dur: 0.06, gain: 0.1, delay: 0.01 })
  }

  // 可击毁道具被打碎：魂晶碎裂——金属余音 + 玻璃散落 + 下滑魂啸
  propDestroyed(pos, listener) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    this._metal(out, 3400, 0.3, 0.22)
    this._noiseBurst(out, { dur: 0.22, freq: 5200, freqEnd: 1600, q: 2, gain: 0.26, type: 'highpass', delay: 0.02 })
    this._osc(out, { type: 'sawtooth', freq: 900, freqEnd: 260, dur: 0.35, gain: 0.07, delay: 0.03 })
    this._thump(out, { freq: 130, freqEnd: 50, dur: 0.14, gain: 0.25 })
  }

  // Dizzy 耗尽坠成休眠泡泡：下滑啾声 + 软着陆扑通
  globuleDrop(pos, listener) {
    this.ensure()
    if (!this.ctx) return
    const out = this._spatial(pos, listener)
    this._osc(out, { type: 'sine', freq: 1300, freqEnd: 500, dur: 0.22, gain: 0.1 })
    this._thump(out, { freq: 180, freqEnd: 80, dur: 0.08, gain: 0.16, delay: 0.24 })
  }

  // 暂停/恢复：挂起整个 AudioContext（音频时钟随游戏时钟一起冻结——长循环音
  // 与动画在 ESC 暂停后不漂移；恢复时 currentTime 连续，已排定的渐强/嗡鸣
  // 收尾仍与引信对齐）
  suspend() { this.ctx?.suspend?.().catch?.(() => {}) }
  resume() { this.ctx?.resume?.().catch?.(() => {}) }
}
