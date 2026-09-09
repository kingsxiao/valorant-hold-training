import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CONFIG } from '../core/Config.js'
import { blindDuration, skyeMaxBlind, kayoFuseAfterBounce, arcBezier, leerAffects, dizzyPlasmaBlind } from './flashMath.js'
import { Tex } from './Textures.js'

// ============================================================================
// 闪光干扰系统：敌方从墙后施放七类闪光/致盲道具 1:1 还原（数值见 CONFIG.flash，
// 来源 Fandom 维基各技能页 + Deployment types 投掷物等级表）：
//  - KAY/O FLASH/drive：Class 2 手雷（18m/s、重力 2.94），总引信 1.6s，
//    首次弹跳改 0.8s 引信（v10.06），最大致盲 2.25s（v11.08）
//  - Skye Guiding Light：追踪鹰导弹（18m/s 无重力、最长飞 2s），最大致盲
//    1→2.25s 随飞行 0.75s 充能（充能满有橙光+提示音），激活后 0.3s 起爆
//    ——官方模型 ability-hawk.glb（Rocklan 包 skyeHawkSimple.blend，翼骨运行时扇动）
//  - Phoenix Curveball：Fixed 曲线导弹（无重力、左/右曲），cast→起爆 0.6s，
//    最大致盲 1.5s；撞墙即熄灭
//  - Yoru Blindside：Class 3 碎片（29m/s、重力 4.41），飞行不可见也无声
//    （v11.10）——撞面才显形 + 0.6s 预备；最大致盲 1.5s（v11.08）
//  - Breach Flashpoint：Placement 穿墙放置在墙前面，0.5s 预备；最大致盲 2.25s
//  - Reyna Leer：近视系——导弹穿地形到 10m 部署距，0.4s 睁眼后施加近视 1.6s
//    （持续判定"瞳孔在视野内"，6m 视界）；60HP 可击毁
//  - Gekko Dizzy：官方模型 ability-dizzy.glb——Class 2 投掷，0.65s 激活后减速
//    悬停，活跃 1s 内对 45m 视线目标 0.35s 锁定喷等离子：全屏 2s=1s 满效+
//    1s 渐褪（转身不可避）；20HP 可击毁
// 白闪判定：视线(LOS) + 朝向角 + 距离（模型见 flashMath.js），到期后白屏
// 1 秒渐褪；近视/等离子走独立屏效（reyna 紫雾近视、gecko 等离子糊屏）。
// 投掷起点在墙后（模拟看不见的敌人），轨迹按"敌方 pop flash"设计
// ============================================================================
const rand = (a, b) => a + Math.random() * (b - a)
const clamp = THREE.MathUtils.clamp
const TYPES = ['kayo', 'skye', 'phoenix', 'yoru', 'breach', 'reyna', 'gecko']
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

// Yoru 盲侧碎片：暗青色维度碎片——八面体核心 + 线框外壳。飞行中整个 group
// 不可见（v11.10 敌方视角），撞面显形后 0.6s 预备内由内而外亮起
function buildYoruShard() {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0a2a30, emissive: 0x37e6ff, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.2,
  })
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), mat)
  const shell = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.13),
    new THREE.MeshBasicMaterial({ color: 0x7deaff, wireframe: true, transparent: true, opacity: 0.5 }),
  )
  const light = new THREE.PointLight(0x37e6ff, 0, 5, 2) // 0 强度：显形前无光
  g.add(core, shell, light)
  return { group: g, mat, shell, light }
}

// Breach 穿墙闪 Charge：贴墙圆盘雷体 + 环形指示灯（0.5s 预备内红橙脉冲加速）
function buildBreachCharge() {
  const g = new THREE.Group()
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.18, 0.07, 20),
    new THREE.MeshStandardMaterial({ color: 0x2e2a26, metalness: 0.7, roughness: 0.4 }),
  )
  disc.rotation.x = Math.PI / 2 // 轴向贴墙：盘面朝 +Z（墙前面法线）
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x30140a, emissive: 0xff5a2a, emissiveIntensity: 0.8, roughness: 0.5,
  })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.018, 8, 28), glowMat)
  const light = new THREE.PointLight(0xff6a30, 0.5, 6, 2)
  g.add(disc, ring, light)
  return { group: g, glowMat, light }
}

// Reyna 凝视之眼：紫晶眼球——虹膜球 + 深色瞳孔（+Z 朝向玩家）+ 魂雾光晕；
// 60HP 可击毁，命中判定以"瞳孔"（眼心）为准
function buildReynaEye() {
  const g = new THREE.Group()
  const irisMat = new THREE.MeshStandardMaterial({
    color: 0x3a1054, emissive: 0xb44dff, emissiveIntensity: 1.6, roughness: 0.35,
  })
  const iris = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 16), irisMat)
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 12), new THREE.MeshBasicMaterial({ color: 0x12002b }))
  pupil.position.z = 0.105
  const aura = new THREE.Sprite(new THREE.SpriteMaterial({
    map: Tex.spark(), color: 0xb44dff, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }))
  aura.scale.set(0.9, 0.9, 1)
  const light = new THREE.PointLight(0xb44dff, 1.0, 6, 2)
  g.add(iris, pupil, aura, light)
  return { group: g, irisMat, aura, light }
}

// Gekko Dizzy 程序化回退（官方模型 ability-dizzy.glb 加载失败时兜底）：
// 圆身小怪兽——薰衣草圆球身 + 两只大眼 + 短尾，悬停摆尾；20HP 可击毁
function buildDizzyProc() {
  const g = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x6a55c9, emissive: 0x4a3aa0, emissiveIntensity: 0.5, roughness: 0.55,
  })
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 14), bodyMat)
  body.scale.set(1, 0.92, 1.05)
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xf4f0ff, roughness: 0.25 })
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x1a1030 })
  const makeEye = (sx) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10), eyeMat)
    e.position.set(sx * 0.075, 0.06, 0.155)
    const pu = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), pupilMat)
    pu.position.set(0, 0, 0.042)
    e.add(pu)
    return e
  }
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 10), bodyMat)
  tail.rotation.x = Math.PI / 2.4
  tail.position.set(0, -0.02, -0.24)
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x231a3a, emissive: 0xc98aff, emissiveIntensity: 1.2, roughness: 0.5,
  })
  const crest = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 8), glowMat)
  crest.position.set(0, 0.2, 0.02)
  const light = new THREE.PointLight(0xc98aff, 0.9, 5, 2)
  for (const m of [body, tail]) m.castShadow = true
  g.add(body, makeEye(1), makeEye(-1), tail, crest, light)
  return { group: g, body, glowMat, light }
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
    this._nearsightUntil = -1  // Reyna 近视命中截止时刻（转开即停刷新，0.3s 内褪去）
    this._plasma = null        // Dizzy 等离子：{ at, potencyUntil, until }（转身不可避）

    // 七种模型常驻场景、按需显隐
    this._models = {
      kayo: buildKayoGrenade(),
      skye: buildSkyeHawk(),
      phoenix: buildPhoenixOrb(),
      yoru: buildYoruShard(),
      breach: buildBreachCharge(),
      reyna: buildReynaEye(),
      gecko: buildDizzyProc(),
    }
    // skye/gecko 套容器壳：程序化近似与官方 GLB 互斥显示（group=容器）
    const wrap = (m) => {
      const c = new THREE.Group()
      c.add(m.group)
      return { ...m, group: c, proc: m.group }
    }
    this._models.skye = wrap(this._models.skye)
    this._models.gecko = wrap(this._models.gecko)
    for (const m of Object.values(this._models)) { m.group.visible = false; scene.add(m.group) }

    // 官方模型（Rocklan 包 .blend→GLB，MRS 补丁见 scripts/ability-glb-patch.mjs）：
    // 异步加载、就位后与程序化近似互换（加载失败静默留在程序化）。官方导出坐标：
    // 头沿 +X、上 +Y（Blender 骨链 Tail 沿 -X）→ rotY(-π/2) 对齐本项目 +Z 喙向约定
    this._loader = new GLTFLoader()
    this._loadOfficial('ability-hawk.glb', this._models.skye, { scale: 1.35 })
    this._loadOfficial('ability-dizzy.glb', this._models.gecko, { scale: 1.6 })

    // 致盲白屏：插在 #hud 第一个子节点——准星/弹药/计分按 DOM 顺序叠在白屏
    // 之上，与游戏内"被闪时 HUD 仍可见"一致；透明度每帧直写
    this.overlayEl = document.createElement('div')
    this.overlayEl.className = 'flash-blind'
    hudRoot.insertBefore(this.overlayEl, hudRoot.firstChild)
    // 近视（Reyna）/等离子（Dizzy）屏效叠在白屏之上：游戏内两者都不是白闪
    this.nearsightEl = document.createElement('div')
    this.nearsightEl.className = 'nearsight-blind'
    hudRoot.insertBefore(this.nearsightEl, this.overlayEl.nextSibling)
    this.plasmaEl = document.createElement('div')
    this.plasmaEl.className = 'plasma-blind'
    hudRoot.insertBefore(this.plasmaEl, this.nearsightEl.nextSibling)
  }

  // 官方 GLB 挂载：成功后隐藏程序化根、记住骨骼（鹰翼/尾骨运行时扇动）。
  // 文件缺失/损坏静默跳过——程序化近似兜底，绝不阻塞启动
  _loadOfficial(file, entry, { scale = 1 } = {}) {
    this._loader.load(
      new URL(`models/${file}`, document.baseURI).href,
      (gltf) => {
        const root = gltf.scene
        root.rotation.y = -Math.PI / 2
        root.scale.setScalar(scale)
        root.visible = true
        const bones = {}
        root.traverse((o) => {
          if (o.isBone) {
            o.userData.restQuat = o.quaternion.clone() // 静息姿态：扇翅叠加其上
            bones[o.name] = o
          }
        })
        entry.group.add(root)
        entry.official = root
        entry.bones = bones
        if (entry.proc) entry.proc.visible = false
      },
      undefined,
      () => { /* 缺文件：程序化兜底 */ },
    )
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
    this._nearsightUntil = -1
    this._plasma = null
    this.startAfter = countdownSec
    this.nextAt = this.mode === 'off' ? Infinity : countdownSec + rand(CONFIG.flash.firstMin, CONFIG.flash.firstMax)
  }

  // 回合结束（结算面板弹出）：清道具并立即解除白屏/近视/等离子
  endRound() {
    this._despawn()
    this.blindUntil = -1
    this._nearsightUntil = -1
    this._plasma = null
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
    else if (type === 'phoenix') this._spawnPhoenix(gap, gapCx)
    else if (type === 'yoru') this._spawnYoru(gap, gapCx)
    else if (type === 'breach') this._spawnBreach(gap, gapCx)
    else if (type === 'reyna') this._spawnReyna(gap, gapCx)
    else this._spawnGecko(gap, gapCx)
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

  // Yoru：墙后掷出 Class 3 碎片（29m/s、重力 4.41）——飞行不可见也无声（v11.10），
  // 撞到玩家侧墙面/地面才显形，0.6s 预备后爆（反应转身的时间窗）
  _spawnYoru(gap, gapCx) {
    const Y = CONFIG.flash.yoru
    const startX = clamp(gapCx + rand(-0.8, 0.8), gap.x0 + 0.4, gap.x1 - 0.4)
    const start = { x: startX, y: 1.6, z: -31.5 }
    // 目标二选一：穿缺口砸玩家侧地面，或撞缺口旁的墙前面（z=-23.6 面）
    const target = Math.random() < 0.5
      ? { x: clamp(gapCx + rand(-1.1, 1.1), gap.x0 + 0.4, gap.x1 - 0.4), y: 0.05, z: rand(-21.6, -20.2) }
      : { x: (Math.random() < 0.5 ? gap.x0 - rand(0.3, 0.9) : gap.x1 + rand(0.3, 0.9)), y: rand(1.6, 2.6), z: -23.5 }
    const T = 0.55
    const vel = {
      x: (target.x - start.x) / T,
      y: (target.y - start.y) / T + 0.5 * Y.gravity * T,
      z: (target.z - start.z) / T,
    }
    this.proj = { type: 'yoru', pos: start, prevPos: { ...start }, vel, t: 0, bounced: false, windT: 0 }
    // 无 cast 音：敌方本就听不见飞行中的碎片
  }

  // Breach：Placement 穿墙放置——charge 直接出现在玩家侧的墙前面（穿墙到达，
  // 不飞弹道），0.5s 预备后爆 2.25s（预备期红橙脉冲是唯一的转身提示）
  _spawnBreach(gap, gapCx) {
    const side = Math.random() < 0.5 ? 1 : -1
    const x = clamp(side > 0 ? gap.x1 + rand(0.3, 1.0) : gap.x0 - rand(0.3, 1.0), -16.8, 16.8)
    const pos = { x, y: rand(1.7, 2.7), z: -23.53 } // 墙前面（厚 0.8、中心 -24）+ 盘半厚
    this.proj = { type: 'breach', pos, prevPos: { ...pos }, t: 0 }
    this.audio.flashCast('breach', pos, this._listener)
  }

  // Reyna：近视眼——Missile 从墙后直线穿地形（不撞墙！）到 10m 部署距，
  // 0.4s 睁眼后 1.6s 内持续判定"瞳孔是否在玩家视野内"→ 命中即近视
  _spawnReyna(gap, gapCx) {
    const R = CONFIG.flash.reyna
    const startX = clamp(gapCx + rand(-1.0, 1.0), gap.x0 + 0.4, gap.x1 - 0.4)
    const start = { x: startX, y: 1.55, z: -31 }
    const eye = this._eye()
    const dx = eye.x - start.x, dz = eye.z - start.z
    const dh = Math.hypot(dx, dz) || 1
    // 部署点：朝玩家方向 10m（穿墙）——高度压在眼高附近，逼玩家正面应对
    const to = {
      x: start.x + (dx / dh) * R.deployDist,
      y: clamp(eye.y + rand(-0.2, 0.5), 1.0, 2.3),
      z: start.z + (dz / dh) * R.deployDist,
    }
    this.proj = {
      type: 'reyna', pos: { ...start }, prevPos: { ...start },
      from: start, to, t: 0, phase: 'fly', armT: 0, eyeT: 0, hp: R.hp,
      voice: this.audio.leerHum?.(this._listener) ?? null,
    }
    this.proj.voice?.setPos(start.x, start.y, start.z)
    this.audio.flashCast('reyna', start, this._listener)
  }

  // Gekko：Dizzy Class 2 投掷（同 KAY/O 物理）——半空悬停点 低弹道抛过墙，
  // 0.65s 激活预备后减速悬停，活跃 1s 内锁定视线内玩家喷等离子
  _spawnGecko(gap, gapCx) {
    const G = CONFIG.flash.gecko
    const startX = clamp(gapCx + rand(-0.8, 0.8), gap.x0 + 0.4, gap.x1 - 0.4)
    const start = { x: startX, y: 1.6, z: -31.5 }
    const target = { x: clamp(gapCx + rand(-1.2, 1.2), gap.x0 + 0.4, gap.x1 - 0.4), y: rand(1.6, 2.4), z: rand(-21.6, -20.4) }
    const T = 0.6
    const vel = {
      x: (target.x - start.x) / T,
      y: (target.y - start.y) / T + 0.5 * G.gravity * T,
      z: (target.z - start.z) / T,
    }
    this.proj = {
      type: 'gecko', pos: start, prevPos: { ...start }, vel, t: 0,
      bounced: false, acquire: 0, fired: false, hp: G.hp, bobPhase: rand(0, 6),
      voice: this.audio.dizzyFlight?.(this._listener) ?? null,
    }
    this.proj.voice?.setPos(start.x, start.y, start.z)
    this.audio.flashCast('gecko', start, this._listener)
  }

  _stepProj(dt) {
    const p = this.proj
    p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y; p.prevPos.z = p.pos.z
    if (p.type === 'kayo') this._stepKayo(p, dt)
    else if (p.type === 'skye') this._stepSkye(p, dt)
    else if (p.type === 'phoenix') this._stepPhoenix(p, dt)
    else if (p.type === 'yoru') this._stepYoru(p, dt)
    else if (p.type === 'breach') this._stepBreach(p, dt)
    else if (p.type === 'reyna') this._stepReyna(p, dt)
    else this._stepGecko(p, dt)
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
        // 弹跳序号：音高逐次微升、音量按恢复系数递减（能量损失）——连跳几声
        // 就能听出"罐子在滚远/滚停"，不用看也知道手雷落在哪
        p.bounceN = (p.bounceN ?? 0) + 1
        this.audio.flashBounce(p.pos, this._listener, p.bounceN)
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

  // Yoru：飞行段 Class 3 物理 + 撞面弹起；撞面后静止原地显形，0.6s 预备倒数。
  // 飞满 2s 一直没撞到任何面 → 消散（维基：fade away，无爆闪）
  _stepYoru(p, dt) {
    const Y = CONFIG.flash.yoru
    p.t += dt
    if (p.bounced) {
      p.windT += dt
      if (p.windT >= Y.windup) this._pop(p, Y.maxBlind)
      return
    }
    if (p.t >= Y.maxAir) { this._fizzle(p, null); return } // 消散：无声无爆，安全
    p.vel.y -= Y.gravity * dt
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z)
    if (speed > 1e-4) {
      const dirX = p.vel.x / speed, dirY = p.vel.y / speed, dirZ = p.vel.z / speed
      const dist = speed * dt
      const hit = this.world.raycast(p.pos.x, p.pos.y, p.pos.z, dirX, dirY, dirZ, dist + 0.04)
      if (hit && hit.t <= dist + 0.04) {
        p.pos.x = hit.x + hit.nx * 0.06
        p.pos.y = hit.y + hit.ny * 0.06
        p.pos.z = hit.z + hit.nz * 0.06
        p.bounced = true
        p.windT = 0
        // 显形瞬间：青色迸溅 + 上升预备音（0.6s 反应窗的听觉起点）
        for (let i = 0; i < 12; i++) {
          _va.set(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(0.8 + Math.random() * 1.6)
          this.fx.sparks.emit(p.pos.x, p.pos.y, p.pos.z, _va.x, _va.y, _va.z,
            { life: 0.22 + Math.random() * 0.2, size: 0.03, r: 0.45, g: 0.9, b: 1, drag: 2.6 })
        }
        this.audio.flashBounce(p.pos, this._listener, 1)
        this.audio.riftWindup?.(Y.windup - p.windT, p.pos, this._listener)
        return
      }
      p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt
    }
  }

  // Breach：贴墙静止，0.5s 预备倒数（视觉脉冲在 renderSync）
  _stepBreach(p, dt) {
    p.t += dt
    if (p.t >= CONFIG.flash.breach.windup) this._pop(p, CONFIG.flash.breach.maxBlind)
  }

  // Reyna：三段——fly（0.55s 匀速穿墙）→ arrive（0.4s 睁眼）→ active（1.6s 施加窗：
  // 每步判 leerAffects，命中刷新近视截止时刻；被击毁在 damage()）
  _stepReyna(p, dt) {
    const R = CONFIG.flash.reyna
    p.t += dt
    if (p.phase === 'fly') {
      const k = Math.min(1, p.t / R.travel)
      p.pos.x = p.from.x + (p.to.x - p.from.x) * k
      p.pos.y = p.from.y + (p.to.y - p.from.y) * k
      p.pos.z = p.from.z + (p.to.z - p.from.z) * k
      if (k >= 1) { p.phase = 'arrive'; p.armT = 0 }
      return
    }
    if (p.phase === 'arrive') {
      p.armT += dt
      if (p.armT >= R.arrivalWindup) { p.phase = 'active'; p.eyeT = 0 }
      return
    }
    p.eyeT += dt
    const eye = this._eye()
    const dxE = p.pos.x - eye.x, dyE = p.pos.y - eye.y, dzE = p.pos.z - eye.z
    const dist = Math.hypot(dxE, dyE, dzE)
    let angleDeg = 180
    if (dist > 1e-6) {
      const fw = this._forward()
      angleDeg = Math.acos(clamp((fw.x * dxE + fw.y * dyE + fw.z * dzE) / dist, -1, 1)) * 180 / Math.PI
    }
    const los = this.world.lineOfSight(eye.x, eye.y, eye.z, p.pos.x, p.pos.y, p.pos.z)
    if (leerAffects(angleDeg, los)) this._nearsightUntil = this.t + 0.3 // 命中：刷新视界占用
    if (p.eyeT >= R.nearsight) { this._expire(p) } // 自然消散：无爆闪、不催 peek
  }

  // Gekko：抛掷段 Class 2 物理（0.65s 激活预备后强阻尼减速 → 半空悬停）；
  // 活跃 1s 窗：视线内 45m 目标锁定 0.35s → 喷等离子（转身不可避），失准回退
  _stepGecko(p, dt) {
    const G = CONFIG.flash.gecko
    p.t += dt
    if (!p.slowed && p.t >= G.activationWindup) p.slowed = true
    if (!p.slowed) {
      // 抛掷段：重力 + 撞面即停（半空目标一般撞不到，撞到也算到位）
      p.vel.y -= G.gravity * dt
      const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z)
      if (speed > 1e-4) {
        const dirX = p.vel.x / speed, dirY = p.vel.y / speed, dirZ = p.vel.z / speed
        const dist = speed * dt
        const hit = this.world.raycast(p.pos.x, p.pos.y, p.pos.z, dirX, dirY, dirZ, dist + 0.04)
        if (hit && hit.t <= dist + 0.04) {
          p.pos.x = hit.x + hit.nx * 0.1; p.pos.y = hit.y + hit.ny * 0.1; p.pos.z = hit.z + hit.nz * 0.1
          p.slowed = true; p.vel.x = p.vel.y = p.vel.z = 0
        } else {
          p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt
        }
      }
    } else {
      // 悬停段：速度阻尼到 0 + 低频浮动（renderSync 叠加正弦，逻辑位不动）
      const k = Math.exp(-6 * dt)
      p.vel.x *= k; p.vel.y *= k; p.vel.z *= k
      p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt
      if (p.pos.y < 0.55) p.pos.y = 0.55
    }
    const activeT = p.t - G.activationWindup
    if (activeT < 0) return
    if (activeT >= G.active) { this._expireGecko(p); return } // 活跃窗耗尽先判（喷过的也要收摊）
    if (p.fired) return
    const eye = this._eye()
    const dist = Math.hypot(eye.x - p.pos.x, eye.y - p.pos.y, eye.z - p.pos.z)
    const los = dist <= G.detect
      && this.world.lineOfSight(p.pos.x, p.pos.y, p.pos.z, eye.x, eye.y, eye.z)
    if (los) {
      p.acquire += dt
      if (p.acquire >= G.acquireWindup) this._firePlasma(p)
    } else {
      p.acquire = Math.max(0, p.acquire - dt * 2) // 目标丢失：锁定回退
    }
  }

  // 等离子命中：溅射 2.5m 内必中（玩家眼即溅点）——全屏 2s = 1s 满效 + 1s 渐褪，
  // 转身不可避（维基：cannot avoid by turning away），只要求喷溅瞬间 LOS
  _firePlasma(p) {
    p.fired = true
    const eye = this._eye()
    const total = dizzyPlasmaBlind()
    this._plasma = { at: this.t, potencyUntil: this.t + total.potency, until: this.t + total.total }
    // 等离子束 + 溅射糊屏的落点视觉
    const dx = eye.x - p.pos.x, dy = eye.y - p.pos.y, dz = eye.z - p.pos.z
    for (let i = 0; i < 22; i++) {
      const f = i / 22
      this.fx.sparks.emit(p.pos.x + dx * f, p.pos.y + dy * f, p.pos.z + dz * f,
        (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8,
        { life: 0.3 + Math.random() * 0.25, size: 0.05, r: 0.78, g: 0.4, b: 1, alpha: 0.95, drag: 2 })
    }
    this.fx.sparks.emit(eye.x, eye.y, eye.z, 0, 0.3, 0,
      { life: 0.5, size: 0.3, sizeEnd: 0.9, r: 0.78, g: 0.4, b: 1, alpha: 0.5, drag: 1 })
    this.audio.plasmaSplat?.({ x: eye.x, y: eye.y, z: eye.z }, this._listener)
    this.onPopped?.(true) // 敌方成功施放 → 催促 peek（与白闪 pop 同语义）
  }

  // Dizzy 活跃窗耗尽：坠落成休眠泡泡再消散（装饰性，无伤害）
  _expireGecko(p) {
    this.fx.sparks.emit(p.pos.x, p.pos.y - 0.1, p.pos.z, 0, -1.2, 0,
      { life: 0.4, size: 0.08, sizeEnd: 0.04, r: 0.6, g: 0.5, b: 1, alpha: 0.8, drag: 0.4 })
    this.audio.globuleDrop?.(p.pos, this._listener)
    this._despawn()
    this.onPopped?.(false)
  }

  // Reyna 眼自然消散：紫雾散尽（无白闪——近视眼到期不产生闪光）
  _expire(p) {
    this.fx.puffs.emit(p.pos.x, p.pos.y, p.pos.z, 0, 0.2, 0,
      { life: 0.5, size: 0.2, sizeEnd: 0.5, r: 0.45, g: 0.3, b: 0.62, alpha: 0.3, drag: 1.2 })
    this._despawn()
    this.onPopped?.(false)
  }

  // 撞墙熄灭（hit=null = 空中消散，如 Yoru 碎片飞满 2s）：小火花 + 泄气声
  // （无致盲——被墙挡掉/自然消散的闪光是无效道具）
  _fizzle(p, hit) {
    const px = hit ? hit.x + hit.nx * 0.03 : p.pos.x
    const py = hit ? hit.y + hit.ny * 0.03 : p.pos.y
    const pz = hit ? hit.z + hit.nz * 0.03 : p.pos.z
    for (let i = 0; i < 10; i++) {
      _va.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(0.6 + Math.random() * 1.4)
      this.fx.sparks.emit(px, py, pz,
        _va.x, _va.y, _va.z, { life: 0.2 + Math.random() * 0.2, size: 0.03, r: 1, g: 0.7, b: 0.4, drag: 2.5 })
    }
    this.audio.flashFizzle({ x: px, y: py, z: pz }, this._listener)
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
    // 渐褪尾段的残像色（白屏退到一半时切类型色余晖）
    this._tint = {
      kayo: '#bfeaff', skye: '#d8ffe6', phoenix: '#ffd9a8',
      yoru: '#cff5ff', breach: '#d6e2ff',
    }[p.type] ?? ''
    // blinded=dur>0 传给音效：躲过（背对/无视线）时高频层压暗——"背身成功"听得出来
    this.audio.flashPop(p.type, pos, this._listener, intensity, dur > 0)
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
      yoru: { light: 0xcff5ff, ring: 0x7deaff, ringMax: 2.6, s1: [0.45, 0.9, 1], s2: [1, 1, 1] },
      breach: { light: 0xd6e2ff, ring: 0x9db8ff, ringMax: 3.0, s1: [0.62, 0.72, 1], s2: [1, 1, 1] },
    }[type]
    // 爆闪照明：主场景灯在真实爆点（峰值 3× 步枪枪口焰、驻留 0.26s），
    // 第一人称通道由 vmPopGlow 以类型色点亮枪身+手套
    fx.muzzle(pos, { scale: 7, opacity: 1, light: 3, lightDur: 0.26, color: C.light })
    fx.vmPopGlow(C.light)
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

  // ---- 渲染帧：白屏/近视/等离子透明度 / 网格插值 / 模型动画 / 拖尾 / 移动声源 ----
  renderSync(alpha, dt = 0.016) {
    // 白屏：起爆后 0.06s 快速拉满（游戏同款的瞬时白），致盲期内不透明，
    // 到期后 1 秒线性渐褪（维基确认值）；径向渐变让边缘先透出一点视野。
    // 渐褪后半段（k>0.5）白底切道具类型色——视网膜残像式的余晖，也提示
    // 刚才那颗是什么道具
    let o = 0
    let tail = false
    if (this.blindUntil >= 0) {
      const k = (this.t - this.blindUntil) / CONFIG.flash.fadeTime
      if (k < 0) o = Math.min(1, (this.t - this._blindAt) / 0.06)
      else if (k >= 1) this.blindUntil = -1
      else { o = 1 - k; tail = k > 0.5 }
    }
    this.overlayEl.style.opacity = o.toFixed(3)
    const bg = tail && this._tint ? this._tint : ''
    if (this.overlayEl.style.background !== bg) this.overlayEl.style.background = bg

    // 近视（Reyna）：命中期不透明、转开 0.3s 内褪去；等离子（Dizzy）：1s 满效
    // + 1s 渐褪（转身不可避）。两者都不是白闪，走独立屏效
    this._nsO = this._nsO ?? 0
    const nsTarget = this._nearsightUntil > this.t ? 1 : 0
    this._nsO += (nsTarget - this._nsO) * Math.min(1, (nsTarget ? 9 : 4) * dt)
    this.nearsightEl.style.opacity = this._nsO.toFixed(3)
    let po = 0
    if (this._plasma) {
      if (this.t < this._plasma.potencyUntil) po = 1
      else if (this.t < this._plasma.until) po = 1 - (this.t - this._plasma.potencyUntil) / (this._plasma.until - this._plasma.potencyUntil)
      else this._plasma = null
    }
    this.plasmaEl.style.opacity = po.toFixed(3)

    const p = this.proj
    if (!p) return
    const m = this._models[p.type]
    // Yoru 碎片飞行中不可见（v11.10 敌方视角）——撞面显形才出现
    m.group.visible = p.type !== 'yoru' || p.bounced
    const ix = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha
    const iy = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha
    const iz = p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha
    m.group.position.set(ix, iy, iz)
    this._animT += dt

    // 各自的起爆预告（telegraph）进度 0..1：KAY/O 最后 0.3s 发亮（维基 telegraph
    // 0.3s）、斯凯预备期 0.3s、火男全程渐亮（与渐强音效同拍）、Yoru/Breach 预备期
    // 全程亮起、Reyna 睁眼进度、Dizzy 激活充能
    let tele = 0
    if (p.type === 'kayo') tele = clamp(1 - (p.fuse - p.t) / CONFIG.flash.kayo.telegraph, 0, 1)
    else if (p.type === 'skye' && p.phase === 'arm') tele = clamp(p.armT / CONFIG.flash.skye.activationWindup, 0, 1)
    else if (p.type === 'phoenix') tele = clamp(p.t / CONFIG.flash.phoenix.windup, 0, 1)
    else if (p.type === 'yoru') tele = p.bounced ? clamp(p.windT / CONFIG.flash.yoru.windup, 0, 1) : 0
    else if (p.type === 'breach') tele = clamp(p.t / CONFIG.flash.breach.windup, 0, 1)
    else if (p.type === 'reyna') tele = p.phase === 'arrive' ? clamp(p.armT / CONFIG.flash.reyna.arrivalWindup, 0, 1) : p.phase === 'active' ? 1 : 0
    else if (p.type === 'gecko') tele = clamp((p.t - 0.2) / CONFIG.flash.gecko.activationWindup, 0, 1)

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
      if (m.official && m.bones?.L_Wing1 && m.bones?.R_Wing1) {
        // 官方鹰：翼骨绕本地 X（前轴）上下扑，叠加在静息姿态上
        this._boneFlap(m.bones.L_Wing1, base + flap)
        this._boneFlap(m.bones.R_Wing1, -(base + flap))
        if (m.bones.Tail) this._boneFlap(m.bones.Tail, Math.sin(phase * 0.7) * 0.12, 'z')
      } else {
        m.wingL.rotation.z = base + flap
        m.wingR.rotation.z = -base - flap
      }
      m.glowMat.emissiveIntensity = 1.4 + tele * 4.4
      m.light.intensity = 0.8 + tele * 2.2
    } else if (p.type === 'yoru') {
      // 显形后原地自旋 + 内芯亮起（0.6s 预备的视觉倒数）
      m.group.rotation.y += dt * 5
      m.group.rotation.x += dt * 2.2
      m.mat.emissiveIntensity = 0.6 + tele * 6
      m.light.intensity = tele * 2.6
      m.shell.material.opacity = 0.5 + tele * 0.5
    } else if (p.type === 'breach') {
      // 贴墙脉冲：随预备进度加速的呼吸灯（唯一的转身提示——v1.06 音画预告口径）
      this._pulse += dt * (4 + 18 * tele)
      m.glowMat.emissiveIntensity = 0.8 + tele * 3 * (0.55 + 0.45 * Math.sin(this._pulse * Math.PI * 2))
      m.light.intensity = 0.5 + tele * 2.2
    } else if (p.type === 'reyna') {
      // 眼球盯人：+Z 瞳孔朝玩家 + 悬停浮动；睁眼期（tele）虹膜由暗转亮
      m.group.lookAt(this.player.pos.x, iy, this.player.pos.z)
      m.group.position.y = iy + Math.sin(this._animT * 2.2) * 0.05
      const open = p.phase === 'fly' ? 0.4 : 0.6 + tele * 0.55
      m.group.scale.setScalar(open)
      m.irisMat.emissiveIntensity = 0.8 + tele * 2 + Math.sin(this._animT * 6) * 0.25
      m.light.intensity = 0.6 + tele * 1.8
      m.aura.material.opacity = 0.35 + tele * 0.35
    } else if (p.type === 'phoenix') {
      // 火球：9Hz 脉动 + 光晕随预告放大 + 全程渐亮（与渐强音效同拍）
      const pulse = 1 + Math.sin(this._animT * Math.PI * 2 * 9) * 0.12
      m.group.scale.setScalar(pulse)
      const hs = (0.42 + tele * 0.3) * pulse
      m.halo.scale.set(hs, hs, 1)
      m.mat.emissiveIntensity = 2 + tele * 4.5
      m.light.intensity = 1.1 + tele * 2.5
    } else if (p.type === 'gecko') {
      // Dizzy：悬停浮动 + 身体俯仰朝向玩家；官方模型摆尾/点头，程序化回退压身
      m.group.position.y = iy + Math.sin(this._animT * 3.1 + p.bobPhase) * 0.06
      m.group.lookAt(this.player.pos.x, m.group.position.y, this.player.pos.z)
      const wag = Math.sin(this._animT * 7) * (0.25 + tele * 0.35)
      if (m.official && m.bones?.Tail_01) {
        this._boneFlap(m.bones.Tail_01, wag, 'y')
        if (m.bones.Head) this._boneFlap(m.bones.Head, Math.sin(this._animT * 3.1 + p.bobPhase) * 0.14, 'x')
        m.group.scale.setScalar(1 + tele * 0.12)
      } else {
        m.body.scale.y = 0.92 - tele * 0.1 + Math.sin(this._animT * 6) * 0.02
        m.glowMat.emissiveIntensity = 1.2 + tele * 3
      }
      m.light.intensity = 0.9 + tele * 2
    }

    // 拖尾：鹰绿光尾迹（充能满转橙+上飘余烬）/ 火球双层火焰+卷曲火丝 /
    // 眼与 Dizzy 的紫雾细缕；KAY/O 无尾迹（游戏同款）、Yoru 飞行不可见、
    // Breach 贴墙静止（游戏同款均无）
    this._trailAt += dt
    if ((p.type === 'skye' || p.type === 'phoenix' || p.type === 'reyna' || p.type === 'gecko') && this._trailAt > 0.02) {
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
      } else if (p.type === 'reyna') {
        if (Math.random() < 0.6) fx.sparks.emit(ix + (Math.random() - 0.5) * 0.2, iy - 0.1, iz + (Math.random() - 0.5) * 0.2,
          (Math.random() - 0.5) * 0.2, -0.3 - Math.random() * 0.3, (Math.random() - 0.5) * 0.2,
          { life: 0.55, size: 0.045, sizeEnd: 0.01, r: 0.7, g: 0.3, b: 1, alpha: 0.7, drag: 1.4 })
      } else if (p.type === 'gecko') {
        if (Math.random() < 0.5) fx.sparks.emit(ix + (Math.random() - 0.5) * 0.15, iy - 0.05, iz + (Math.random() - 0.5) * 0.15,
          (Math.random() - 0.5) * 0.3, -0.2 - Math.random() * 0.2, (Math.random() - 0.5) * 0.3,
          { life: 0.4, size: 0.04, sizeEnd: 0.012, r: 0.78, g: 0.45, b: 1, alpha: 0.75, drag: 1.6 })
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

  // 官方骨骼摆动：静息姿态 ⊗ 本地轴旋转（不覆盖绑定姿态）。轴按骨骼本地系：
  // 翼骨 = x（前轴上下扑）、Dizzy 尾骨 = y（左右摆）、头骨 = x（点头）
  _boneFlap(bone, angle, axis = 'x') {
    _q.setFromAxisAngle(_axis.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), angle)
    bone.quaternion.copy(bone.userData.restQuat).multiply(_q)
  }

  // 致盲剩余秒数（0 = 未致盲；调试/自动化用）
  get blindRemaining() {
    return this.blindUntil < 0 ? 0 : Math.max(0, this.blindUntil - this.t)
  }

  // ---- 可击毁道具（Leer 眼 60HP / Dizzy 20HP）：射线-球命中，供 WeaponSystem ----
  // 在墙/机器人取最近时夹入。只认"到位后"的目标（飞行导弹段判定点还在移动），
  // 返回 { t }（射线参数距离）或 null
  pickHit(eye, dir, lim) {
    const p = this.proj
    if (!p) return null
    const isEye = p.type === 'reyna' && p.phase === 'active'
    const isDizzy = p.type === 'gecko' && p.slowed && !p.fired
    if (!isEye && !isDizzy) return null
    const R = isEye ? CONFIG.flash.reyna.radius : CONFIG.flash.gecko.radius
    const cx = p.pos.x - eye.x, cy = p.pos.y - eye.y, cz = p.pos.z - eye.z
    const t = cx * dir.x + cy * dir.y + cz * dir.z
    if (t < 0 || t > lim) return null
    const d2 = cx * cx + cy * cy + cz * cz - t * t
    if (d2 > R * R) return null
    return { t }
  }

  // 对当前可击毁道具结算伤害（dmg 已是该武器该距离的伤害值）；打碎 = 紫雾迸溅 +
  // 碎裂声 + 无效化（近视/等离子都不会发生——"射掉闪光"是本训练器的新练点）
  damage(dmg) {
    const p = this.proj
    if (!p || (p.type !== 'reyna' && p.type !== 'gecko') || p.hp === undefined) return
    p.hp -= dmg
    if (p.hp > 0) {
      this.audio.propHit?.(p.pos, this._listener, p.hp / (p.type === 'reyna' ? CONFIG.flash.reyna.hp : CONFIG.flash.gecko.hp))
      for (let i = 0; i < 6; i++) {
        _va.set(Math.random() - 0.5, Math.random() * 0.7, Math.random() - 0.5).normalize().multiplyScalar(1 + Math.random() * 2)
        this.fx.sparks.emit(p.pos.x, p.pos.y, p.pos.z, _va.x, _va.y, _va.z,
          { life: 0.18 + Math.random() * 0.15, size: 0.028, r: 0.78, g: 0.5, b: 1, drag: 3 })
      }
      return
    }
    for (let i = 0; i < 24; i++) {
      _va.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(1.2 + Math.random() * 3)
      this.fx.sparks.emit(p.pos.x, p.pos.y, p.pos.z, _va.x, _va.y, _va.z,
        { life: 0.3 + Math.random() * 0.3, size: 0.04, sizeEnd: 0.01, r: 0.7, g: 0.35, b: 1, alpha: 0.9, drag: 2.4 })
    }
    this.audio.propDestroyed?.(p.pos, this._listener)
    this._despawn()
    this.onPopped?.(false)
  }
}
