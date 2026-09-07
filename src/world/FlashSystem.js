import * as THREE from 'three'
import { CONFIG } from '../core/Config.js'
import { blindDuration, skyeMaxBlind, kayoFuseAfterBounce, arcBezier } from './flashMath.js'
import { Tex } from './Textures.js'

// ============================================================================
// 闪光干扰系统：敌方从墙后投掷三类闪光道具 1:1 还原（数值见 CONFIG.flash，
// 来源 Fandom 维基各技能页 + Deployment types 投掷物等级表）：
//  - KAY/O FLASH/drive：Class 2 手雷（18m/s、重力 2.94），总引信 1.6s，
//    首次弹跳改 0.8s 引信（v10.06），最大致盲 2.25s（v11.08）
//  - Skye Guiding Light：追踪鹰导弹（18m/s 无重力、最长飞 2s），最大致盲
//    1→2.25s 随飞行 0.75s 充能（充能满有橙光+提示音），激活后 0.3s 起爆
//  - Phoenix Curveball：Fixed 曲线导弹（无重力、左/右曲），cast→起爆 0.6s，
//    最大致盲 1.5s；撞墙即熄灭
// 致盲判定：视线(LOS) + 朝向角 + 距离（模型见 flashMath.js），到期后白屏
// 1 秒渐褪。投掷起点在墙后（模拟看不见的敌人），轨迹按"敌方 pop flash"
// 设计：穿缺口或越墙顶起爆在玩家视野内
// ============================================================================
const rand = (a, b) => a + Math.random() * (b - a)
const clamp = THREE.MathUtils.clamp
const TYPES = ['kayo', 'skye', 'phoenix']
const MODES = [...TYPES, 'mix', 'off']

// ---- 程序化模型（原创近似：官方美术资产有版权，不做提取复用）----
// KAY/O 手雷：八棱"智能雷"造型——枪金属棱柱体 + 青色发光环 + 两侧翼片
function buildKayoGrenade() {
  const g = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 0.062, 8),
    new THREE.MeshStandardMaterial({ color: 0x2b3036, metalness: 0.85, roughness: 0.35 })
  )
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x083038, emissive: 0x4fe3ff, emissiveIntensity: 1.8, roughness: 0.4,
  })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.008, 8, 28), glowMat)
  ring.rotation.x = Math.PI / 2
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.02, 8),
    new THREE.MeshStandardMaterial({ color: 0x1a1e22, metalness: 0.9, roughness: 0.3 })
  )
  cap.position.y = 0.04
  const finGeo = new THREE.BoxGeometry(0.012, 0.004, 0.07)
  for (const sx of [-1, 1]) {
    const fin = new THREE.Mesh(finGeo, glowMat)
    fin.position.set(sx * 0.092, 0, 0)
    g.add(fin)
  }
  for (const m of [body, ring, cap]) { m.castShadow = true; g.add(m) }
  return { group: g, glowMat }
}

// 斯凯鹰：黄铜构造的鹰形护身符——流线身躯 + 后掠双翼（可扑动）+ 绿光翼缘；
// 充能满后光环与点光转橙（维基：max duration 时橙色 aura + 音频提示）
function buildSkyeHawk() {
  const g = new THREE.Group()
  const brass = new THREE.MeshStandardMaterial({ color: 0xb98a44, metalness: 0.9, roughness: 0.35 })
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x062d1c, emissive: 0x46ffb0, emissiveIntensity: 1.4, roughness: 0.4,
  })
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), brass)
  body.scale.set(0.7, 0.6, 2.0)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), brass)
  head.position.set(0, 0.012, 0.115)
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.04, 8), glowMat)
  beak.rotation.x = Math.PI / 2
  beak.position.set(0, 0.005, 0.155)
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.13), brass)
  tail.position.set(0, 0, -0.12)
  tail.rotation.x = -0.18
  // 双翼：转轴在翼根（group），扑动 = rotation.z 摆动；翼展 ~0.9m（游戏中鹰很显眼）
  const makeWing = (side) => {
    const pivot = new THREE.Group()
    pivot.position.set(side * 0.03, 0.01, 0)
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.006, 0.13), brass)
    wing.position.set(side * 0.21, 0, -0.02)
    wing.rotation.y = -side * 0.42 // 后掠
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.008, 0.018), glowMat)
    edge.position.set(side * 0.21, -0.004, 0.045)
    pivot.add(wing, edge)
    return pivot
  }
  const wingL = makeWing(1), wingR = makeWing(-1)
  for (const m of [body, head, beak, tail]) { m.castShadow = true; g.add(m) }
  g.add(wingL, wingR)
  const light = new THREE.PointLight(0x46ffb0, 0.8, 5, 2)
  g.add(light)
  return { group: g, wingL, wingR, glowMat, light }
}

// 火男弧线球：炽热火球——高自发光核心 + 加法混合光晕精灵 + 橙色点光
function buildPhoenixOrb() {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a1204, emissive: 0xff8c2a, emissiveIntensity: 2.4, roughness: 0.6,
  })
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 12), mat)
  core.castShadow = true
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: Tex.spark(), color: 0xffa040, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }))
  halo.scale.set(0.42, 0.42, 1)
  const light = new THREE.PointLight(0xff9440, 1.1, 6, 2)
  g.add(core, halo, light)
  return { group: g, mat, halo, light }
}

// 模块级临时对象：128Hz 步进 + 每渲染帧动画，避免分配
const _va = new THREE.Vector3()
const _vb = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _q = new THREE.Quaternion()

export class FlashSystem {
  constructor({ scene, world, map, audio, fx, player, hudRoot }) {
    this.scene = scene; this.world = world; this.map = map
    this.audio = audio; this.fx = fx; this.player = player
    this.mode = 'off'
    this.t = 0                 // 游戏时钟（只在 step 累加 → 暂停冻结）
    this.proj = null           // 场上投掷物（同一时刻最多 1 个）
    this.nextAt = Infinity
    this.startAfter = 0
    this.blindUntil = -1       // 致盲截止时刻；-1 = 未致盲
    this.blindTotal = 0        // 最近一次致盲时长（调试/测试读）
    this.onPopped = null       // (blinded) => void：起爆回调（main 用于催促 peek）
    this._animT = 0
    this._trailAt = 0
    this._pulse = 0            // KAY/O 引信脉冲相位（频率随预告进度加速）
    this._wispSide = 1         // 火男卷曲火丝的左右交替
    this._blindAt = 0          // 最近一次致盲开始时刻（白屏快速淡入用）

    // 三种模型常驻场景、按需显隐
    this._models = { kayo: buildKayoGrenade(), skye: buildSkyeHawk(), phoenix: buildPhoenixOrb() }
    for (const m of Object.values(this._models)) { m.group.visible = false; scene.add(m.group) }

    // 致盲白屏：插在 #hud 第一个子节点——准星/弹药/计分按 DOM 顺序叠在白屏
    // 之上，与游戏内"被闪时 HUD 仍可见"一致；透明度每帧直写
    this.overlayEl = document.createElement('div')
    this.overlayEl.className = 'flash-blind'
    hudRoot.insertBefore(this.overlayEl, hudRoot.firstChild)
  }

  get _listener() { return this.player } // 音频听者：{ pos, yaw } 实时读

  _eye() {
    return { x: this.player.pos.x, y: this.player.pos.y + this.player.eyeHeight, z: this.player.pos.z }
  }

  // ---- 模式与回合 ----
  setMode(mode) {
    this.mode = MODES.includes(mode) ? mode : 'off'
    this._despawn()
    if (this.mode === 'off') { this.nextAt = Infinity; return }
    // 菜单切类型（暂停中）：场上道具清掉，从当前时刻起一个间隔后再来
    this.nextAt = this.t + rand(CONFIG.flash.intervalMin, CONFIG.flash.intervalMax)
  }

  resetRound(countdownSec = 3) {
    this.t = 0
    this._despawn()
    this.blindUntil = -1
    this.startAfter = countdownSec
    this.nextAt = this.mode === 'off' ? Infinity : countdownSec + rand(CONFIG.flash.firstMin, CONFIG.flash.firstMax)
  }

  // 回合结束（结算面板弹出）：清道具并立即解除白屏
  endRound() {
    this._despawn()
    this.blindUntil = -1
  }

  // 地图重建（缺口左右切换）：旧轨迹作废，清道具重排
  onMapRebuilt() {
    this._despawn()
    if (this.mode !== 'off') this.nextAt = this.t + rand(CONFIG.flash.intervalMin, CONFIG.flash.intervalMax)
  }

  // ---- 固定步长（128Hz，与 Bot 同游戏时钟）----
  step(dt) {
    this.t += dt
    if (this.proj) this._stepProj(dt)
    if (this.mode === 'off') return // 关闭模式不出弹（nextAt=Infinity 之外的第二道闸）
    if (!this.proj && this.t >= this.startAfter && this.t >= this.nextAt) {
      this._spawn()
      this.nextAt = this.t + rand(CONFIG.flash.intervalMin, CONFIG.flash.intervalMax)
    }
  }

  _spawn() {
    if (this.mode === 'off') return
    const type = this.mode === 'mix' ? TYPES[(Math.random() * TYPES.length) | 0] : this.mode
    const gap = this.map.gaps[0]
    const gapCx = (gap.x0 + gap.x1) / 2
    if (type === 'kayo') this._spawnKayo(gap, gapCx)
    else if (type === 'skye') this._spawnSkye(gap, gapCx)
    else this._spawnPhoenix(gap, gapCx)
  }

  // KAY/O：墙后投掷，二选一弹道——越墙顶高位爆（经典过墙闪）或穿缺口低位爆。
  // 弹道解算：固定速度 Class 2 + 1.6s 引信，反解初速使 T 时刻恰好到目标点
  _spawnKayo(gap, gapCx) {
    const K = CONFIG.flash.kayo
    const startX = clamp(gapCx + rand(-0.8, 0.8), gap.x0 + 0.4, gap.x1 - 0.4)
    const start = { x: startX, y: 1.6, z: -31.5 }
    const high = Math.random() < 0.45 // 过墙高位爆（越过 4m 墙顶在玩家侧上空）
    const target = high
      ? { x: startX + rand(-0.6, 0.6), y: rand(4.8, 5.6), z: rand(-22.6, -21.4) }
      : { x: clamp(gapCx + rand(-0.9, 0.9), gap.x0 + 0.4, gap.x1 - 0.4), y: rand(1.9, 2.6), z: rand(-21.8, -20.4) }
    const T = K.maxFuse
    const vel = {
      x: (target.x - start.x) / T,
      y: (target.y - start.y) / T + 0.5 * K.gravity * T,
      z: (target.z - start.z) / T,
    }
    this.proj = {
      type: 'kayo', pos: start, prevPos: { ...start }, vel, t: 0,
      fuse: K.maxFuse, bounced: false,
    }
    this.audio.flashCast('kayo', start, this._listener)
  }

  // 斯凯：墙后放鹰，先飞向缺口上方，过墙后追踪"瞄点"（实时跟在玩家视线前方
  // 一点——敌方把鹰开到你脸上）。急转自然减速 → 到位后绕人盘旋等充能，
  // 充满且贴近 → 0.3s 起爆预备 → 起爆（满 2.25s 威胁）；飞满 2s 寿命自动激活（v8.01）
  _spawnSkye(gap, gapCx) {
    const S = CONFIG.flash.skye
    const startX = clamp(gapCx + rand(-1.0, 1.0), gap.x0 + 0.4, gap.x1 - 0.4)
    const start = { x: startX, y: 1.5, z: -31 }
    const gapAim = { x: gapCx, y: 2.2, z: -23.3 }
    const d = Math.hypot(gapAim.x - start.x, gapAim.y - start.y, gapAim.z - start.z)
    this.proj = {
      type: 'skye', pos: start, prevPos: { ...start },
      vel: { x: (gapAim.x - start.x) / d * S.speed, y: (gapAim.y - start.y) / d * S.speed, z: (gapAim.z - start.z) / d * S.speed },
      flight: 0, phase: 'fly', armT: 0, charged: false, gapAim, aim: null, bank: 0, flapPhase: 0,
      voice: this.audio.hawkFlight?.(this._listener) ?? null,
    }
    this.proj.voice?.setPos(start.x, start.y, start.z)
    this.audio.flashCast('skye', start, this._listener)
  }

  // 火男：墙后向缺口一侧甩出弧线球，绕墙角划弧到玩家侧起爆（二次贝塞尔弧长
  // 参数化，恒定速度）；撞墙即熄灭
  _spawnPhoenix(gap, gapCx) {
    const side = Math.random() > 0.5 ? 1 : -1 // 左曲 / 右曲
    const edge = side > 0 ? gap.x1 : gap.x0
    const p0 = { x: clamp(gapCx - side * rand(0.2, 1.0), gap.x0 + 0.3, gap.x1 - 0.3), y: 1.7, z: rand(-31.5, -30.5) }
    const p1 = { x: edge + side * rand(1.2, 1.6), y: rand(2.2, 2.6), z: -23.4 }
    const p2 = { x: clamp(gapCx - side * rand(0.2, 0.9), gap.x0 + 0.4, gap.x1 - 0.4), y: rand(2.3, 2.8), z: rand(-21.0, -20.2) }
    this.proj = {
      type: 'phoenix', pos: { ...p0 }, prevPos: { ...p0 }, t: 0,
      curve: arcBezier(p0, p1, p2),
      voice: this.audio.orbFlight?.(this._listener, CONFIG.flash.phoenix.windup) ?? null,
    }
    this.proj.voice?.setPos(p0.x, p0.y, p0.z)
    this.audio.flashCast('phoenix', p0, this._listener)
  }

  _stepProj(dt) {
    const p = this.proj
    p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y; p.prevPos.z = p.pos.z
    if (p.type === 'kayo') this._stepKayo(p, dt)
    else if (p.type === 'skye') this._stepSkye(p, dt)
    else this._stepPhoenix(p, dt)
  }

  _stepKayo(p, dt) {
    const K = CONFIG.flash.kayo
    p.vel.y -= K.gravity * dt
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z)
    if (speed > 1e-4) {
      const dirX = p.vel.x / speed, dirY = p.vel.y / speed, dirZ = p.vel.z / speed
      const dist = speed * dt
      const hit = this.world.raycast(p.pos.x, p.pos.y, p.pos.z, dirX, dirY, dirZ, dist + 0.04)
      if (hit && hit.t <= dist + 0.04) {
        p.pos.x = hit.x + hit.nx * 0.05
        p.pos.y = hit.y + hit.ny * 0.05
        p.pos.z = hit.z + hit.nz * 0.05
        // 反弹：法向按恢复系数弹回、切向摩擦衰减
        const vn = p.vel.x * hit.nx + p.vel.y * hit.ny + p.vel.z * hit.nz
        if (vn < 0) {
          const tvx = p.vel.x - vn * hit.nx, tvy = p.vel.y - vn * hit.ny, tvz = p.vel.z - vn * hit.nz
          p.vel.x = tvx * 0.72 - vn * hit.nx * K.restitution
          p.vel.y = tvy * 0.72 - vn * hit.ny * K.restitution
          p.vel.z = tvz * 0.72 - vn * hit.nz * K.restitution
          if (p.vel.x * p.vel.x + p.vel.y * p.vel.y + p.vel.z * p.vel.z < 0.09) p.vel.x = p.vel.y = p.vel.z = 0
        }
        this.audio.flashBounce(p.pos, this._listener)
        // v10.06：首次弹跳后改为 0.8s 引信（不延长剩余时间）+ 专属爬升嗡鸣
        if (!p.bounced) {
          p.bounced = true
          p.fuse = p.t + kayoFuseAfterBounce(p.fuse - p.t)
          this.audio.flashHum(p.fuse - p.t, p.pos, this._listener)
        }
      } else {
        p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt
      }
    }
    p.t += dt
    if (p.t >= p.fuse) this._pop(p, K.maxBlind)
  }

  _stepSkye(p, dt) {
    const S = CONFIG.flash.skye
    // 振翅相位在逻辑步内推进：暂停时与被挂起的音频时钟一起冻结（翅膀与扑翼
    // 声永远同拍），恢复后从同一拍继续
    p.flapPhase += dt * (p.voice?.flapHz ?? 8.5)
    if (p.phase === 'arm') {
      p.armT += dt
      const k = Math.exp(-5 * dt)
      p.vel.x *= k; p.vel.y *= k; p.vel.z *= k
      p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt
      if (p.armT >= S.activationWindup) this._pop(p, skyeMaxBlind(p.flight))
      return
    }
    p.flight += dt
    // 瞄点：过墙前指缺口上方；过墙后实时跟在玩家视线前方（敌方把鹰开向你的脸）
    const eye = this._eye()
    if (p.pos.z > -23.8) {
      const fw = this._forward()
      p.aim = {
        x: eye.x + fw.x * S.aimAhead,
        y: Math.max(1.0, eye.y + fw.y * S.aimAhead),
        z: eye.z + fw.z * S.aimAhead,
      }
    }
    const tgt = p.aim ?? p.gapAim
    _va.set(p.vel.x, p.vel.y, p.vel.z).normalize()
    const dirBeforeX = _va.x, dirBeforeZ = _va.z // 转弯侧倾要用：转向前后方向的叉积符号
    _vb.set(tgt.x - p.pos.x, tgt.y - p.pos.y, tgt.z - p.pos.z).normalize()
    const ang = Math.acos(clamp(_va.dot(_vb), -1, 1))
    const maxTurn = S.turnRate * dt
    if (ang > 1e-4) {
      _axis.crossVectors(_va, _vb)
      if (_axis.lengthSq() > 1e-10) {
        _axis.normalize()
        _q.setFromAxisAngle(_axis, Math.min(ang, maxTurn))
        _va.applyQuaternion(_q)
      } else _va.copy(_vb) // 共线（反向罕见）：直接对准
    }
    // 转弯侧倾（banking）：向转向一侧压坡，平滑跟随
    const turnY = dirBeforeZ * _va.x - dirBeforeX * _va.z
    const bankTgt = clamp(turnY * 30, -0.85, 0.85)
    p.bank += (bankTgt - p.bank) * Math.min(1, 9 * dt)
    // 急转减速：航向与目标夹角越大速度越低（近距盘旋的转弯半径随之收窄）
    const align = Math.max(0, _va.dot(_vb))
    const spd = S.speed * (0.35 + 0.65 * Math.pow(align, 0.7))
    p.vel.x = _va.x * spd; p.vel.y = _va.y * spd; p.vel.z = _va.z * spd
    // 撞墙/撞箱：鹰被地形阻挡即熄灭（v5.07 起不可被射毁，但地形照挡）
    const segX = p.vel.x * dt, segY = p.vel.y * dt, segZ = p.vel.z * dt
    const segLen = Math.hypot(segX, segY, segZ)
    const hit = segLen > 1e-6
      ? this.world.raycast(p.pos.x, p.pos.y, p.pos.z, segX / segLen, segY / segLen, segZ / segLen, segLen + 0.05)
      : null
    if (hit && hit.t <= segLen + 0.05) { this._fizzle(p, hit); return }
    p.pos.x += segX; p.pos.y += segY; p.pos.z += segZ
    // 充能完成（橙光 + 提示音，维基记载）
    if (!p.charged && p.flight >= S.chargeTime) {
      p.charged = true
      const m = this._models.skye
      m.light.color.setHex(0xffa040)
      m.glowMat.emissive.setHex(0xffb060)
      this.audio.flashCharge(p.pos, this._listener)
    }
    // 激活条件（任一）：
    //  - 充能满 且 已贴近玩家（到位后盘旋充满 → pop flash 满 2.25s 威胁）
    //  - 飞满寿命 2s（v8.01：到时自动激活）
    const dEye = Math.hypot(eye.x - p.pos.x, eye.y - p.pos.y, eye.z - p.pos.z)
    if ((p.charged && dEye <= S.popDist) || p.flight >= S.maxFlight) {
      p.phase = 'arm'
      p.armT = 0
      this.audio.flashArm(p.pos, this._listener)
    }
  }

  _stepPhoenix(p, dt) {
    const P = CONFIG.flash.phoenix
    p.t += dt
    const s = Math.min(P.speed * p.t, p.curve.len)
    const prev = { x: p.pos.x, y: p.pos.y, z: p.pos.z }
    p.curve.point(s, p.pos)
    // 切向速度（拖尾的焰丝方向要用）：弧长参数化贝塞尔的位置差分
    if (dt > 0) {
      p.vel = { x: (p.pos.x - prev.x) / dt, y: (p.pos.y - prev.y) / dt, z: (p.pos.z - prev.z) / dt }
    }
    const segX = p.pos.x - prev.x, segY = p.pos.y - prev.y, segZ = p.pos.z - prev.z
    const segLen = Math.hypot(segX, segY, segZ)
    if (segLen > 1e-6) {
      const hit = this.world.raycast(prev.x, prev.y, prev.z, segX / segLen, segY / segLen, segZ / segLen, segLen)
      if (hit) { this._fizzle(p, hit); return }
    }
    if (p.t >= P.windup) this._pop(p, P.maxBlind)
  }

  // 撞墙熄灭：小火花 + 泄气声（无致盲——被墙挡掉的闪光是无效道具）
  _fizzle(p, hit) {
    for (let i = 0; i < 10; i++) {
      _va.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(0.6 + Math.random() * 1.4)
      this.fx.sparks.emit(hit.x + hit.nx * 0.03, hit.y + hit.ny * 0.03, hit.z + hit.nz * 0.03,
        _va.x, _va.y, _va.z, { life: 0.2 + Math.random() * 0.2, size: 0.03, r: 1, g: 0.7, b: 0.4, drag: 2.5 })
    }
    this.audio.flashFizzle({ x: hit.x, y: hit.y, z: hit.z }, this._listener)
    this._despawn()
    this.onPopped?.(false)
  }

  // 起爆：视觉爆闪 + 音效（闪中玩家加响）+ 致盲判定（LOS/朝向/距离）+ 白屏
  _pop(p, maxBlind) {
    const pos = { x: p.pos.x, y: p.pos.y, z: p.pos.z }
    // 致盲判定
    const eye = this._eye()
    const los = this.world.lineOfSight(eye.x, eye.y, eye.z, pos.x, pos.y, pos.z)
    let angleDeg = 180
    const dxE = pos.x - eye.x, dyE = pos.y - eye.y, dzE = pos.z - eye.z
    const dist = Math.hypot(dxE, dyE, dzE)
    if (dist > 1e-6) {
      const fw = this._forward()
      const dot = clamp((fw.x * dxE + fw.y * dyE + fw.z * dzE) / dist, -1, 1)
      angleDeg = Math.acos(dot) * 180 / Math.PI
    }
    const dur = blindDuration(maxBlind, dist, angleDeg, los)
    let intensity = 1
    if (dur > 0) {
      this.blindUntil = this.t + dur
      this._blindAt = this.t
      this.blindTotal = dur
      intensity = 1 + Math.min(0.25, (dur / maxBlind) * 0.25) // 贴脸爆闪更炸
    }
    this._popVisual(p.type, pos)
    this.audio.flashPop(p.type, pos, this._listener, intensity)
    this._despawn()
    this.onPopped?.(dur > 0)
  }

  // 起爆视觉：白色主爆闪 + 类型色冲击环/双色火花 + 稍驻留的爆闪照明——
  // 三类道具各自的"爆炸性格"（KAY/O 电蓝、斯凯翠金、火男炽焰）
  _popVisual(type, pos) {
    const fx = this.fx
    const C = {
      kayo: { light: 0xbfeaff, ring: 0x7deaff, ringMax: 2.8, s1: [0.72, 0.96, 1], s2: [1, 1, 1] },
      skye: { light: 0xd8ffe6, ring: 0x66ffb2, ringMax: 2.4, s1: [0.55, 1, 0.72], s2: [1, 0.88, 0.5] },
      phoenix: { light: 0xffd9a8, ring: 0xff9a3c, ringMax: 2.6, s1: [1, 0.55, 0.16], s2: [1, 0.85, 0.45] },
    }[type]
    fx.muzzle(pos, { scale: 7, opacity: 1, light: 3, color: C.light })
    fx.lightLife = fx.lightDur = 0.26 // 爆闪照明驻留一瞬（比枪口焰长）
    // 冲击环：一圈类型色的扩散光波
    const r = fx.rings[fx.ringIdx]
    fx.ringIdx = (fx.ringIdx + 1) % fx.rings.length
    r.mesh.position.set(pos.x, pos.y, pos.z)
    r.mesh.material.color.setHex(C.ring)
    r.mesh.material.opacity = 0.95
    r.mesh.scale.setScalar(0.3)
    r.mesh.visible = true
    r.life = r.dur = 0.34
    r.maxScale = C.ringMax
    // 双色火花迸溅
    for (let i = 0; i < 30; i++) {
      _va.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(1.5 + Math.random() * 3.8)
      const c = i % 3 ? C.s1 : C.s2
      fx.sparks.emit(pos.x, pos.y, pos.z, _va.x, _va.y, _va.z,
        { life: 0.22 + Math.random() * 0.26, size: 0.038, r: c[0], g: c[1], b: c[2], drag: 3 })
    }
  }

  // 玩家视线方向（pitch/yaw → 单位向量；与相机姿态同式）
  _forward() {
    const cy = Math.cos(this.player.yaw), sy = Math.sin(this.player.yaw)
    const cp = Math.cos(this.player.pitch), sp = Math.sin(this.player.pitch)
    return { x: -sy * cp, y: sp, z: -cy * cp }
  }

  _despawn() {
    const p = this.proj
    if (p?.voice) p.voice.stop()
    this.proj = null
    for (const m of Object.values(this._models)) m.group.visible = false
    // 斯凯鹰的充能染色复位（下次生成时重置为绿色）
    const skye = this._models.skye
    skye.light.color.setHex(0x46ffb0)
    skye.glowMat.emissive.setHex(0x46ffb0)
  }

  // ---- 渲染帧：白屏透明度 / 网格插值 / 模型动画 / 拖尾 / 移动声源 ----
  renderSync(alpha, dt = 0.016) {
    // 白屏：起爆后 0.06s 快速拉满（游戏同款的瞬时白），致盲期内不透明，
    // 到期后 1 秒线性渐褪（维基确认值）；径向渐变让边缘先透出一点视野
    let o = 0
    if (this.blindUntil >= 0) {
      const k = (this.t - this.blindUntil) / CONFIG.flash.fadeTime
      if (k < 0) o = Math.min(1, (this.t - this._blindAt) / 0.06)
      else if (k >= 1) this.blindUntil = -1
      else o = 1 - k
    }
    this.overlayEl.style.opacity = o.toFixed(3)

    const p = this.proj
    if (!p) return
    const m = this._models[p.type]
    m.group.visible = true
    const ix = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha
    const iy = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha
    const iz = p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha
    m.group.position.set(ix, iy, iz)
    this._animT += dt

    // 各自的起爆预告（telegraph）进度 0..1：KAY/O 最后 0.3s 发亮（维基 telegraph
    // 0.3s）、斯凯预备期 0.3s、火男全程渐亮（与渐强音效同拍）
    let tele = 0
    if (p.type === 'kayo') tele = clamp(1 - (p.fuse - p.t) / CONFIG.flash.kayo.telegraph, 0, 1)
    else if (p.type === 'skye' && p.phase === 'arm') tele = clamp(p.armT / CONFIG.flash.skye.activationWindup, 0, 1)
    else if (p.type === 'phoenix') tele = clamp(p.t / CONFIG.flash.phoenix.windup, 0, 1)

    if (p.type === 'kayo') {
      // 翻滚随速度：出手快转，落地静止后收势（速度越低转越慢直至停住）
      const spd = Math.hypot(p.vel.x, p.vel.y, p.vel.z)
      const k = Math.min(1, spd / 6)
      m.group.rotation.y += (1.2 + 8 * k) * dt
      m.group.rotation.x += (0.6 + 4 * k) * dt
      // 引信脉冲发光：越接近起爆，脉冲越快越亮（v10.06 弹跳预告的视觉节奏）
      this._pulse += dt * (3 + 22 * tele)
      m.glowMat.emissiveIntensity = 1.6 + tele * 2.4 * (0.6 + 0.4 * Math.sin(this._pulse * Math.PI * 2))
    } else if (p.type === 'skye') {
      m.group.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z) // +Z（喙向）对准航向
      m.group.rotateZ(p.bank) // 转弯侧倾：压坡入弯
      // 振翅与音频同拍：相位在逻辑步推进（与音频 LFO 同时起振、同时冻结），
      // 振幅缓变（活物感）；预备期翅膀上扬大展、扑动收停
      const phase = p.flapPhase
      const armed = p.phase === 'arm'
      const amp = armed ? 0.55 * (1 - tele) : 0.5 + 0.08 * Math.sin(phase * 0.13)
      const flap = armed ? 0 : Math.sin(phase * Math.PI * 2) * amp
      const base = 0.22 + (armed ? tele * 0.5 : 0) // 预备期翅膀上扬定格
      m.wingL.rotation.z = base + flap
      m.wingR.rotation.z = -base - flap
      m.glowMat.emissiveIntensity = 1.4 + tele * 4.4
      m.light.intensity = 0.8 + tele * 2.2
    } else {
      const pulse = 1 + Math.sin(this._animT * Math.PI * 2 * 9) * 0.12
      m.group.scale.setScalar(pulse)
      const hs = (0.42 + tele * 0.3) * pulse
      m.halo.scale.set(hs, hs, 1)
      m.mat.emissiveIntensity = 2 + tele * 4.5
      m.light.intensity = 1.1 + tele * 2.5
    }

    // 拖尾：鹰绿光尾迹（充能满转橙+上飘余烬）/ 火球双层火焰+卷曲火丝；
    // KAY/O 手雷无尾迹（游戏同款）
    this._trailAt += dt
    if (p.type !== 'kayo' && this._trailAt > 0.02) {
      this._trailAt = 0
      const fx = this.fx
      if (p.type === 'skye') {
        const core = p.charged ? { r: 1, g: 0.66, b: 0.3 } : { r: 0.3, g: 1, b: 0.66 }
        fx.sparks.emit(ix, iy, iz, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4,
          { life: 0.45, size: 0.05, sizeEnd: 0.012, ...core, alpha: 0.9, drag: 2.2 })
        if (Math.random() < 0.3) fx.sparks.emit(ix, iy, iz, (Math.random() - 0.5) * 0.5, 0.1 + Math.random() * 0.3, (Math.random() - 0.5) * 0.5,
          { life: 0.5, size: 0.032, r: 1, g: 0.85, b: 0.45, alpha: 0.9, drag: 2 })
        if (p.charged && Math.random() < 0.55) fx.sparks.emit(ix + (Math.random() - 0.5) * 0.2, iy, iz + (Math.random() - 0.5) * 0.2,
          (Math.random() - 0.5) * 0.3, 0.5 + Math.random() * 0.6, (Math.random() - 0.5) * 0.3,
          { life: 0.5, size: 0.028, r: 1, g: 0.5, b: 0.18, drag: 1.2 })
      } else {
        // 白热芯（贴核快熄）+ 橙红焰（外层缓淡）
        fx.sparks.emit(ix, iy, iz, -p.vel.x * 0.03 + (Math.random() - 0.5) * 0.3, -p.vel.y * 0.03 + 0.2 + Math.random() * 0.3, -p.vel.z * 0.03 + (Math.random() - 0.5) * 0.3,
          { life: 0.26 + Math.random() * 0.16, size: 0.05, sizeEnd: 0.014, r: 1, g: 0.8, b: 0.45, alpha: 0.95, drag: 1.6 })
        fx.sparks.emit(ix, iy, iz, (Math.random() - 0.5) * 0.5, 0.25 + Math.random() * 0.35, (Math.random() - 0.5) * 0.5,
          { life: 0.4, size: 0.065, sizeEnd: 0.02, r: 1, g: 0.42, b: 0.12, alpha: 0.8, drag: 1.4 })
        // 卷曲火丝：垂直于航向左右交替甩出 → 螺旋焰尾
        const vl = Math.hypot(p.vel.x, p.vel.z) || 1
        this._wispSide = -this._wispSide
        fx.sparks.emit(ix, iy, iz,
          (p.vel.z / vl) * this._wispSide * 0.9 - p.vel.x * 0.06, 0.15 + Math.random() * 0.25, (-p.vel.x / vl) * this._wispSide * 0.9 - p.vel.z * 0.06,
          { life: 0.34, size: 0.045, sizeEnd: 0.01, r: 1, g: 0.6, b: 0.2, alpha: 0.85, drag: 1.6 })
        if (Math.random() < 0.3) {
          fx.puffs.emit(ix, iy, iz, 0, 0.25, 0,
            { life: 0.5, size: 0.05, sizeEnd: 0.2, r: 0.4, g: 0.36, b: 0.34, alpha: 0.22, drag: 1.5 })
        }
      }
    }

    p.voice?.setPos(ix, iy, iz)
  }

  // 致盲剩余秒数（0 = 未致盲；调试/自动化用）
  get blindRemaining() {
    return this.blindUntil < 0 ? 0 : Math.max(0, this.blindUntil - this.t)
  }
}
