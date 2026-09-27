import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CONFIG } from '../core/Config.js'
import { blindDuration, skyeMaxBlind, kayoFuseAfterBounce, arcBezier, leerAffects, dizzyPlasmaBlind, ballisticShot } from './flashMath.js'
import { Tex } from './Textures.js'

// ============================================================================
// 闪光干扰系统：敌方从墙后施放七类闪光/致盲道具 1:1 还原（数值见 CONFIG.flash，
// 来源 Fandom 维基各技能页 + Deployment types 投掷物等级表）：
//  - KAY/O FLASH/drive：Class 2 手雷（18m/s、重力 2.94），总引信 1.6s，
//    首次弹跳改 0.8s 引信（v10.06），最大致盲 2.25s（v11.08）。出手速度口径
//    已接入弹道解算（ballisticShot，见 _spawnKayo）——主投三变体（拍地弹跳 /
//    深落点长引信 / 全引信空爆）+ 副投下手短抛（Class 0.7，6.3m/s、总引信 1s，
//    v3.06/v11.08 口径见 CONFIG.flash.kayo.alt）
//  - Skye Guiding Light：追踪鹰导弹（18m/s 无重力、最长飞 2s），最大致盲
//    1→2.25s 随飞行 0.75s 充能（充能满有橙光+提示音），激活后原地定格、
//    0.3s 起爆预备后在激活点起爆
//    ——官方模型 ability-hawk.glb（Rocklan 包 skyeHawkSimple.blend，翼骨运行时扇动；
//    充能/预备发光经 glowMats 重定向作用于官方材质 + 容器点光，见 _mountOfficial）
//  - Phoenix Curveball：Fixed 曲线导弹（无重力、左/右曲），cast→起爆 0.6s，
//    最大致盲 1.5s；撞墙即熄灭
//  - Yoru Blindside：Class 3 碎片（29m/s、重力 4.41），飞行不可见也无声
//    （v11.10）——撞面才显形 + 0.6s 预备；最大致盲 1.5s（v11.08）
//  - Breach Flashpoint：Placement 穿墙放置——charge 以 24m/s（v12.00）从本体
//    位置直线飞向放置点、穿墙到达，到位即停 + 0.5s 预备；最大致盲 2.25s
//  - Reyna Leer：近视系——导弹穿地形到 10m 部署距，0.4s 睁眼后施加近视 1.6s
//    （持续判定"瞳孔在视野内"）；世界空间 6m 视界（场景雾收束）+ 全屏品红雾罩 +
//    转开 0.3s 线性褪去；LOS 内未受近视时有屏幕预警 VFX；60HP 可击毁
//    （v11.08 口径）
//  - Gekko Dizzy：官方模型 ability-dizzy.glb——Class 2 投掷（100m/s，v7.12
//    弹速口径），急停悬停，活跃 1s 内对 45m 视线目标 0.35s 锁定喷等离子：
//    弹体飞行、命中溅射（2.5m）后全屏 2s=1s 满效+1s 渐褪（边缘可见圈随渐褪
//    从边缘向内扩张，转身不可避）；20HP 可击毁
// 白闪判定：视线(LOS) + 朝向角 + 距离（模型见 flashMath.js），到期后白屏
// 1 秒渐褪（整屏冷白——极淡冷蓝 #e9f2ff，本体口径）；近视/等离子走独立屏效（reyna 品红近视 +
// Deafened 闷音、gecko 绿紫史莱姆糊屏）。
// 投掷起点在墙后（模拟看不见的敌人），轨迹按"敌方 pop flash"设计
// ============================================================================
const rand = (a, b) => a + Math.random() * (b - a)
const clamp = THREE.MathUtils.clamp
// ballisticShot 理论不可达时的直线兜底（本场 spawn 距离对口径速度恒可达，
// 仅防御性保底：保证 vel 有限且模长 = 口径速度）
const straightVel = (a, b, sp) => {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const d = Math.hypot(dx, dy, dz) || 1
  return { x: dx / d * sp, y: dy / d * sp, z: dz / d * sp }
}
const TYPES = ['kayo', 'skye', 'phoenix', 'yoru', 'breach', 'reyna', 'gecko']
const MODES = [...TYPES, 'mix', 'off']

// ---- 程序化模型（原创近似：官方美术资产有版权，不做提取复用）----
// KAY/O 手雷：枪金属罐体 + 琥珀橙警示灯（顶灯 + 赤道灯环）——预备期内闪烁
// 加速（renderSync 的 _pulse 驱动），暖色警灯是玩家计时转身的视觉锚点
function buildKayoGrenade() {
  const g = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 0.062, 10),
    new THREE.MeshStandardMaterial({ color: 0x2b3036, metalness: 0.85, roughness: 0.35 })
  )
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x38200a, emissive: 0xffa54a, emissiveIntensity: 1.6, roughness: 0.4,
  })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.081, 0.007, 8, 28), glowMat)
  ring.rotation.x = Math.PI / 2
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.02, 10),
    new THREE.MeshStandardMaterial({ color: 0x1a1e22, metalness: 0.9, roughness: 0.3 })
  )
  cap.position.y = 0.04
  // 顶灯：罐顶的琥珀警示灯（引信倒数的主角）
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), glowMat)
  lamp.scale.y = 0.55
  lamp.position.y = 0.055
  for (const m of [body, ring, cap, lamp]) { m.castShadow = true; g.add(m) }
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
  // 点光不挂程序化模型内部：鹰/Dizzy 套容器壳后官方 GLB 会整组替换程序化根，
  // 点光挂在容器上（wrap() 创建）才能在官方模型下继续照亮周围
  return { group: g, wingL, wingR, glowMat }
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

// Reyna 凝视之眼：闭合眼茧（上下两片深紫眼睑膜包住眼球）+ 内部紫晶眼球
// （虹膜球 + 深色瞳孔，+Z 朝向）+ 魂雾光晕；到位后眼睑膜如花瓣张开（W14），
// 虹膜由暗渐亮。60HP 可击毁，命中判定以"瞳孔"（眼心）为准
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
  // 眼茧：上下两片半球壳（赤道铰链，绕 X 轴开合）——飞行段闭合态深紫球茧，
  // 到位后 0.4s 内如花瓣绽开并消散（renderSync 驱动 bloom 曲线）
  const budMat = new THREE.MeshStandardMaterial({
    color: 0x1c0630, emissive: 0x2c0a48, emissiveIntensity: 0.55, roughness: 0.5, metalness: 0.1,
    transparent: true, opacity: 1, side: THREE.DoubleSide,
  })
  const budTop = new THREE.Mesh(new THREE.SphereGeometry(0.19, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), budMat)
  const budBottom = new THREE.Mesh(new THREE.SphereGeometry(0.19, 18, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), budMat)
  // 缝光：赤道接缝的细亮环——飞行后期虹膜光从闭合缝里渗出（"中心透出亮紫
  // 虹膜光"），张开时快速熄灭
  const seam = new THREE.Mesh(
    new THREE.TorusGeometry(0.188, 0.009, 8, 32),
    new THREE.MeshBasicMaterial({ color: 0xd06cff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  )
  seam.rotation.x = Math.PI / 2
  // 透光点：茧面正前方的亮紫光斑（加法精灵）——闭合态虹膜光的"漏光"读法
  const glowSpot = new THREE.Sprite(new THREE.SpriteMaterial({
    map: Tex.spark(), color: 0xc44dff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }))
  glowSpot.position.z = 0.21
  glowSpot.scale.set(0.3, 0.3, 1)
  g.add(iris, pupil, aura, light, budTop, budBottom, seam, glowSpot)
  return { group: g, irisMat, aura, light, budTop, budBottom, budMat, seam, glowSpot }
}

// Gekko Dizzy 程序化回退（官方模型 ability-dizzy.glb 加载失败时兜底）：
// 圆身小怪兽——薰衣草圆球身 + 两只大眼 + 短尾，悬停摆尾；20HP 可击毁。
// （官方 GLB 骨链无翼骨且无烘焙动画——扇翅翼面在容器层外挂，见 buildDizzyWings）
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
  for (const m of [body, tail]) m.castShadow = true
  g.add(body, makeEye(1), makeEye(-1), tail, crest)
  return { group: g, body, glowMat }
}

// Dizzy 扇翅翼面（W16）：Dizzy 是有翼小兽（Fandom Dizzy 页/官方立绘）——官方
// GLB 无翼骨（骨链仅 Head/Spine/Tail 系）也无烘焙动画，程序化翼面挂容器层，
// 官方模型与程序化回退两条路径共用。蝙蝠膜式翼轮廓（双贝塞尔后缘凹弧），
// 半透明紫膜双面材质；肩轴在躯干后侧，扇动 = 绕前轴（Z）上下扑（renderSync）
function buildDizzyWings() {
  const shape = new THREE.Shape()
  shape.moveTo(0, 0.03)
  shape.quadraticCurveTo(0.15, 0.13, 0.32, 0.05)  // 前缘：翼根到翼尖
  shape.quadraticCurveTo(0.29, -0.04, 0.22, -0.05) // 后缘凹弧（指间膜）1
  shape.quadraticCurveTo(0.20, -0.015, 0.13, -0.055) // 凹弧 2
  shape.quadraticCurveTo(0.11, -0.012, 0.045, -0.05) // 凹弧 3（近根）
  shape.quadraticCurveTo(0.025, -0.012, 0, -0.032) // 翼根
  const geo = new THREE.ShapeGeometry(shape, 6)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7c58c8, emissive: 0x4630a0, emissiveIntensity: 0.45,
    transparent: true, opacity: 0.85, side: THREE.DoubleSide, roughness: 0.5,
  })
  const mkWing = (side) => {
    const pivot = new THREE.Group()
    pivot.position.set(side * 0.11, 0.08, -0.04)
    const mesh = new THREE.Mesh(geo, mat)
    if (side < 0) mesh.scale.x = -1 // 左翼镜像
    pivot.add(mesh)
    return pivot
  }
  return { R: mkWing(1), L: mkWing(-1), mat }
}

// 模块级临时对象：128Hz 步进 + 每渲染帧动画，避免分配
const _va = new THREE.Vector3()
const _vb = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _q = new THREE.Quaternion()
// 近视雾色插值暂存（renderSync 每帧用）
const _fogColor = new THREE.Color()
const _nsFogColor = new THREE.Color()
// _eye()/_forward() 的复用返回对象（128Hz 热路径零分配；调用点即取即用）
const _eyeOut = { x: 0, y: 0, z: 0 }
const _fwdOut = { x: 0, y: 0, z: 0 }

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
    this._nearsightUntil = -1  // Reyna 近视视界占用截止时刻（看清瞳孔期间逐步续借）
    this._nsO = 0              // 近视屏效当前透明度（线性拉满/线性褪去，renderSync 驱动）
    this._warnO = 0            // Leer LOS 预警透明度（眼球视线内但未受近视时 >0）
    this._plasma = null        // Dizzy 等离子：{ at, potencyUntil, until }（转身不可避）
    this._plasmaShot = null    // 飞行中的等离子弹体：{ fx,fy,fz, x,y,z, t, dur }（W11）
    this._boltTrailAt = 0      // 等离子弹体拖尾节拍
    this._globule = null       // Dizzy 休眠 Globule 残躯：{ x,y,z, vy, rest, until }（W15）
    this._globuleMesh = null   // Globule 网格（懒建复用）

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
    // skye/gecko 套容器壳：程序化近似与官方 GLB 互斥显示（group=容器）。
    // 点光挂容器（官方 GLB 就位后程序化根被摘除，容器常驻场景图——充能/预备期
    // 的照明在两条模型路径下都作用于实际渲染的画面）；glowMats 记录充能调色的
    // 材质目标与原色/原强度（_despawn 复位、_mountOfficial 重定向到官方材质）
    const wrap = (m, lightHex, lightIntensity, lightDist) => {
      const c = new THREE.Group()
      c.add(m.group)
      const light = new THREE.PointLight(lightHex, lightIntensity, lightDist, 2)
      c.add(light)
      return {
        ...m, group: c, proc: m.group, light,
        lightBase: { color: lightHex, intensity: lightIntensity },
        glowMats: m.glowMat
          ? [{ mat: m.glowMat, baseEmissive: m.glowMat.emissive.getHex(), baseIntensity: m.glowMat.emissiveIntensity }]
          : [],
      }
    }
    this._models.skye = wrap(this._models.skye, 0x46ffb0, 0.8, 5)
    this._models.gecko = wrap(this._models.gecko, 0xc98aff, 0.9, 5)
    // Dizzy 扇翅翼面（W16）：官方 GLB 骨链无翼骨（本轮实解析证实）且无烘焙动画
    // ——翼面挂容器层，官方模型与程序化回退两条路径共用（renderSync 驱动扇动）
    const dizzyWings = buildDizzyWings()
    this._models.gecko.group.add(dizzyWings.R, dizzyWings.L)
    this._models.gecko.wings = dizzyWings
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
    // 近视（Reyna）/等离子（Dizzy）屏效叠在白屏之上：游戏内两者都不是白闪。
    // leer-warn：眼球视线内但尚未被近视时的屏幕边缘预警（W10）
    this.nearsightEl = document.createElement('div')
    this.nearsightEl.className = 'nearsight-blind'
    hudRoot.insertBefore(this.nearsightEl, this.overlayEl.nextSibling)
    this.plasmaEl = document.createElement('div')
    this.plasmaEl.className = 'plasma-blind'
    hudRoot.insertBefore(this.plasmaEl, this.nearsightEl.nextSibling)
    this.warnEl = document.createElement('div')
    this.warnEl.className = 'leer-warn'
    hudRoot.insertBefore(this.warnEl, this.plasmaEl.nextSibling)

    // 世界空间近视的场景雾句柄：引擎已建 Fog（colors.fog, 60→170 远景霭）——
    // 近视满效时把它收束到视界半径、颜色压向暗品红，褪去后复位（renderSync）。
    // 测试场景无雾时补一个等价默认，行为与引擎场景一致
    this._fog = scene.fog ?? (scene.fog = new THREE.Fog(CONFIG.colors.fog, 60, 170))
    this._fogRest = { near: this._fog.near, far: this._fog.far, color: this._fog.color.getHex() }
  }

  // 官方 GLB 挂载：成功后隐藏程序化根、记住骨骼（鹰翼/尾骨运行时扇动），
  // 并把充能/预备期的发光目标从程序化 glowMat 重定向到官方材质（W2：旧实现
  // 在 GLB 就位后仍写已卸载的死对象——玩家看不到满充能橙光与起爆渐亮）。
  // 文件缺失/损坏静默跳过——程序化近似兜底，绝不阻塞启动
  _loadOfficial(file, entry, { scale = 1 } = {}) {
    this._loader.load(
      new URL(`models/${file}`, document.baseURI).href,
      (gltf) => { this._mountOfficial(entry, gltf.scene, scale) },
      undefined,
      () => { /* 缺文件：程序化兜底 */ },
    )
  }

  // 官方 root 挂载（_loadOfficial 的成功回调主体；独立成方法供测试直接驱动）。
  // 坐标/缩放对齐、骨骼静息姿态记录、程序化根摘除释放、发光目标重定向
  _mountOfficial(entry, root, scale = 1) {
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
    // 发光目标重定向：官方材质中凡带 emissive 的纳入调色组（记录原色/原强度，
    // _despawn 复位）——充能转橙（skye）与 arm 渐亮从此作用于实际渲染的官方
    // 模型。同一材质可能被多个网格共享，Set 去重防强度双写
    const seen = new Set()
    const glowMats = []
    root.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
      for (const mat of ms) {
        if (mat.emissive && !seen.has(mat)) {
          seen.add(mat)
          glowMats.push({ mat, baseEmissive: mat.emissive.getHex(), baseIntensity: mat.emissiveIntensity ?? 1 })
        }
      }
    })
    entry.glowMats = glowMats
    // 官方模型就位：程序化近似不再是兜底而是死重——从场景图摘除并释放
    // GPU 资源（仅隐藏虽不渲染，128Hz 的矩阵更新仍会遍历它）
    if (entry.proc) {
      entry.group.remove(entry.proc)
      entry.proc.traverse(o => {
        o.geometry?.dispose?.()
        const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
        for (const m of ms) m.dispose?.()
      })
      entry.proc = null
    }
  }

  get _listener() { return this.player } // 音频听者：{ pos, yaw } 实时读

  // 玩家眼位/视线方向：128Hz step 热路径调用——写入模块级复用对象（调用点均
  // 即取即用读分量，无跨调用持有；eye 与 fw 成对使用时是两个独立对象）
  _eye() {
    _eyeOut.x = this.player.pos.x
    _eyeOut.y = this.player.pos.y + this.player.eyeHeight
    _eyeOut.z = this.player.pos.z
    return _eyeOut
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
    this._plasmaShot = null
    if (this._plasmaBolt) this._plasmaBolt.visible = false
    if (this._globuleMesh) this._globuleMesh.group.visible = false
    this._globule = null
    this.audio.setDeafened?.(0)
    this.startAfter = countdownSec
    this.nextAt = this.mode === 'off' ? Infinity : countdownSec + rand(CONFIG.flash.firstMin, CONFIG.flash.firstMax)
  }

  // 回合结束（结算面板弹出）：清道具并立即解除白屏/近视/等离子/耳聋
  endRound() {
    this._despawn()
    this.blindUntil = -1
    this._nearsightUntil = -1
    this._plasma = null
    this._plasmaShot = null
    if (this._plasmaBolt) this._plasmaBolt.visible = false
    if (this._globuleMesh) this._globuleMesh.group.visible = false
    this._globule = null
    this.audio.setDeafened?.(0)
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
    if (this._plasmaShot) this._stepPlasmaShot(dt) // 等离子弹体独立于 Dizzy 存续（喷射后本体可到期消散）
    if (this._globule) this._stepGlobule(dt) // Globule 残躯独立存续（不占用 proj 槽位）
    if (this.mode === 'off') return // 关闭模式不出弹（nextAt=Infinity 之外的第二道闸）
    if (!this.proj && this.t >= this.startAfter && this.t >= this.nextAt) {
      this._spawn()
      this.nextAt = this.t + rand(CONFIG.flash.intervalMin, CONFIG.flash.intervalMax)
    }
  }

  _spawn() {
    if (this.mode === 'off') return
    // 归零拖尾节拍：_trailAt 只在拖尾类弹体的发射沿清零，KAY/O/Yoru/Breach
    // 飞行期与波次间隔里一路累积（长会话可达数百秒）——不清零的话下一颗弹体
    // 出膛首帧就越过发射阈值，而 vel 等字段要等首个 _stepProj 才齐（phoenix 无
    // 出膛初速就会在拖尾分支读 undefined，renderFrame 中断=玩家看到的"闪退"）
    this._trailAt = 0
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

  // KAY/O：墙后投掷，弹道解算受出手速度约束（主投 Class 2 口径 18m/s，副投
  // Class 0.7 口径 6.3m/s）：按口径速度与落点反解直射初速/飞行时间
  // （flashMath.ballisticShot）。主投三变体随机混合（节奏多样性，见 CONFIG 注释），
  // Math.random 消费顺序（tests/flash-system.test.js 按此 mock）：
  //   1) 副投 roll（< K.altChance）→ 2) lane 偏移 → 3) 变体 roll（<0.5 拍地弹跳 /
  //   <0.8 深落点长引信 / 其余全引信空爆）→ 4) 变体各自参数
  _spawnKayo(gap, gapCx) {
    const K = CONFIG.flash.kayo
    if (Math.random() < K.altChance) { this._spawnKayoAlt(gap, gapCx); return }
    // 横向走「车道」：出手与落点共用车道偏移 + 小幅瞄准抖动——低弹跳从门洞
    // （净宽 = 缺口宽度）穿过而不拍在门墙上
    const lane = clamp(gapCx + rand(-0.55, 0.55), gap.x0 + 0.6, gap.x1 - 0.6)
    const start = { x: lane, y: 1.6, z: -31.5 }
    const variant = Math.random()
    // ① 拍地弹跳 pop flash：门墙后侧（墙 z∈[-24.8,-23.2]）往里 0.8~2.4m 砸地
    // → 首跳触发 v10.06 引信规则（min(剩余, 0.8s)）→ 低弹跳穿门洞，~1.05-1.25s
    // 玩家侧半场低位起爆（cast→bounce ~0.3s 是听觉反应窗）
    let impact
    if (variant < 0.5) {
      impact = {
        x: clamp(lane + rand(-0.25, 0.25), gap.x0 + 0.5, gap.x1 - 0.5),
        y: 0,
        z: rand(-27.4, -25.6),
      }
    } else if (variant < 0.8) {
      // ② 深落点长引信：平射快球穿门洞、玩家侧 ~0.7s 才首跳——剩余引信
      // 0.85~0.9s > 0.8 被 v10.06 规则钳住（不延长剩余），总节奏 ~1.5s，
      // 是本图进深内最接近 1.6s 长引信的可达变体
      impact = {
        x: clamp(lane + rand(-0.3, 0.3), gap.x0 + 0.5, gap.x1 - 0.5),
        y: 0,
        z: rand(-19.5, -16.5),
      }
    } else {
      // ③ 全引信空爆：从走廊底（走廊 z -36..-24，取 -35 距后墙内面 0.6m 的
      // 合法站位）贴门楣（缺口顶 3.4m）平抛——1.6s 全程不落地、空中起爆
      // （~3.4m 高、越过架枪位，真实"全程飞行不弹跳"节奏；威胁域见 CONFIG 注释）
      const vy = rand(3.2, 3.75) // 门楣裕度：过墙时 y≈3.0-3.3 < 3.4
      const start3 = { x: lane, y: 1.6, z: -35 }
      this.proj = {
        type: 'kayo', pos: start3, prevPos: { ...start3 },
        vel: { x: rand(-0.12, 0.12), y: vy, z: Math.sqrt(K.speed * K.speed - vy * vy) }, // +Z 朝门墙
        t: 0, fuse: K.maxFuse, bounced: false,
        telegraph: K.telegraph, maxBlind: K.maxBlind,
      }
      this.audio.flashCast('kayo', start3, this._listener)
      return
    }
    const shot = ballisticShot(start, impact, K.speed, K.gravity)
    const vel = shot ? shot.vel : straightVel(start, impact, K.speed)
    this.proj = {
      type: 'kayo', pos: start, prevPos: { ...start }, vel, t: 0,
      fuse: K.maxFuse, bounced: false,
      telegraph: K.telegraph, maxBlind: K.maxBlind,
    }
    this.audio.flashCast('kayo', start, this._listener)
  }

  // 副投（ALT FIRE 下手短抛，Class 0.7 口径 6.3m/s、总引信 1s）：敌人贴门短抛
  // ——从墙后门洞线低位出手，6.3m/s 小弧线抛过门洞在玩家侧贴门落地，首跳后
  // 以剩余引信（0.5s 级 < 0.8 不再被钳）快速起爆——"快速短抛"节奏分支，
  // 时序上比主投弹跳闪快整整一拍
  _spawnKayoAlt(gap, gapCx) {
    const K = CONFIG.flash.kayo
    const A = K.alt
    const lane = clamp(gapCx + rand(-0.5, 0.5), gap.x0 + 0.6, gap.x1 - 0.6)
    // 出手点：门洞线正后（墙后背面 z=-24.8 再退 0.4m）、下手高度 1.5m
    const start = { x: lane, y: 1.5, z: -25.2 }
    // 落点：门墙玩家侧贴门 0.6~1.3m（短抛本义：闪在门口就地爆）
    const impact = {
      x: clamp(lane + rand(-0.2, 0.2), gap.x0 + 0.4, gap.x1 - 0.4),
      y: 0,
      z: rand(-22.5, -21.9),
    }
    const shot = ballisticShot(start, impact, A.speed, K.gravity)
    const vel = shot ? shot.vel : straightVel(start, impact, A.speed)
    this.proj = {
      type: 'kayo', pos: start, prevPos: { ...start }, vel, t: 0,
      fuse: A.fuse, bounced: false, alt: true,
      telegraph: A.telegraph, maxBlind: A.maxBlind,
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
      // 出膛初速（u=0 处贝塞尔导数 2(p1−p0) 方向 × 巡航速）：拖尾分支读 vel，
      // 字段必须出膛即存在——首个 _stepProj 前的渲染帧不能拿到 undefined
      vel: (() => {
        const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z
        const dl = Math.hypot(dx, dy, dz) || 1
        const sp = CONFIG.flash.phoenix.speed
        return { x: dx / dl * sp, y: dy / dl * sp, z: dz / dl * sp }
      })(),
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
    // 出手速度约束（Class 3 口径 29m/s）：按口径速度与撞点反解直射初速/飞行
    // 时间，替换旧的「固定 0.55s 反解初速」（旧解实际出手 18.1~20.8m/s ≈ 口径
    // 的 ~65%）。撞点不变 → 显形位置不变，撞面提前 ~0.2s、整体节奏略加快
    const shot = ballisticShot(start, target, Y.speed, Y.gravity)
    const vel = shot ? shot.vel : straightVel(start, target, Y.speed)
    this.proj = { type: 'yoru', pos: start, prevPos: { ...start }, vel, t: 0, bounced: false, windT: 0 }
    // 无 cast 音：敌方本就听不见飞行中的碎片
  }

  // Breach：Placement 穿墙放置——开火后 charge 从 Breach 本体位置（门后走廊、
  // 放置点正后方）以 2400uu/s=24m/s（v12.00）直线飞向放置点、穿墙到达另一侧，
  // 到位即停进入 0.5s 预备（v1.07）后爆 2.25s。飞行段 ~dist/24s 是出手→挂墙的
  // 时延：光体在轨迹穿过门洞可见空间时可被瞥见，预备期红橙脉冲是贴墙后的
  // 唯一转身提示
  _spawnBreach(gap, gapCx) {
    const B = CONFIG.flash.breach
    const side = Math.random() < 0.5 ? 1 : -1
    const x = clamp(side > 0 ? gap.x1 + rand(0.3, 1.0) : gap.x0 - rand(0.3, 1.0), -16.8, 16.8)
    // 放置点：墙玩家侧面（墙 z∈[-24.8,-23.2]，玩家面 -23.2）+ 盘半厚出脸 0.07
    const place = { x, y: rand(1.7, 2.7), z: -23.13 }
    // 本体位置：放置点正后（同 x）、走廊内胸口高度——charge 直线飞向放置点
    const start = { x, y: Math.min(1.5, place.y - 0.3), z: -30.5 }
    const dx = place.x - start.x, dy = place.y - start.y, dz = place.z - start.z
    const d = Math.hypot(dx, dy, dz)
    this.proj = {
      type: 'breach', pos: start, prevPos: { ...start }, place,
      vel: { x: dx / d * B.speed, y: dy / d * B.speed, z: dz / d * B.speed },
      t: 0, flyT: d / B.speed, phase: 'fly', armT: 0,
    }
    this.audio.flashCast('breach', start, this._listener)
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
      // 施法方向（部署向量的单位向量）：到位后悬停朝向沿它固定（W14）——
      // 官方 Leer 不持续追踪个体玩家，瞳孔朝施法时锁定的方向
      faceDir: (() => {
        const dx = to.x - start.x, dy = to.y - start.y, dz = to.z - start.z
        const d = Math.hypot(dx, dy, dz) || 1
        return { x: dx / d, y: dy / d, z: dz / d }
      })(),
      voice: this.audio.leerHum?.(this._listener) ?? null,
    }
    this.proj.voice?.setPos(start.x, start.y, start.z)
    this.audio.flashCast('reyna', start, this._listener)
  }

  // Gekko：Dizzy Class 2 投掷——弹速 v7.12 口径 ~100m/s（近似换算，见 CONFIG）：
  // 高速蹿出 ~0.1s 级直达悬停点急停（"send Dizzy soaring forward"），0.65s
  // 激活预备后进入活跃窗，锁定视线内玩家喷等离子
  _spawnGecko(gap, gapCx) {
    const G = CONFIG.flash.gecko
    const startX = clamp(gapCx + rand(-0.8, 0.8), gap.x0 + 0.4, gap.x1 - 0.4)
    const start = { x: startX, y: 1.6, z: -31.5 }
    const target = { x: clamp(gapCx + rand(-1.2, 1.2), gap.x0 + 0.4, gap.x1 - 0.4), y: rand(1.6, 2.4), z: rand(-21.6, -20.4) }
    // 出手速度约束（口径 ~100m/s）：按口径速度与悬停瞄准点反解直射初速——
    // 到位时间 ~0.1s 级（本图 ~10.5m 投距 ≈0.105s），到位即急停悬停（snap 到
    // 瞄准点、速度清零），残留阻尼不再承担"吃掉余速"的职责
    const shot = ballisticShot(start, target, G.speed, G.gravity)
    const vel = shot ? shot.vel : straightVel(start, target, G.speed)
    const d = Math.hypot(target.x - start.x, target.y - start.y, target.z - start.z)
    this.proj = {
      type: 'gecko', pos: start, prevPos: { ...start }, vel, t: 0,
      hover: { ...target }, flyT: shot ? shot.T : d / G.speed,
      acquire: 0, fired: false, hp: G.hp, bobPhase: rand(0, 6),
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
        // v10.06：首次弹跳后改为 0.8s 引信（不延长剩余时间）+ 专属爬升嗡鸣。
        // bounceLeft 记下嗡鸣时长——renderSync 的警灯脉冲与它同拍同长（W13：
        // 专属视觉贯穿整个弹跳 windup，而非只在末 0.3s telegraph 出现）
        if (!p.bounced) {
          p.bounced = true
          p.fuse = p.t + kayoFuseAfterBounce(p.fuse - p.t)
          p.bounceLeft = p.fuse - p.t
          this.audio.flashHum(p.bounceLeft, p.pos, this._listener)
        }
      } else {
        p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt
      }
    }
    p.t += dt
    if (p.t >= p.fuse) this._pop(p, p.maxBlind ?? K.maxBlind)
  }

  _stepSkye(p, dt) {
    const S = CONFIG.flash.skye
    // 振翅相位在逻辑步内推进：暂停时与被挂起的音频时钟一起冻结（翅膀与扑翼
    // 声永远同拍），恢复后从同一拍继续
    p.flapPhase += dt * (p.voice?.flapHz ?? 8.5)
    if (p.phase === 'arm') {
      p.armT += dt
      // 官方激活（发射后再按 FIRE）：鹰原地定格悬停，0.3s activation windup
      // （v3.06）后在激活点原地起爆——判定与表现都以定格点为基准
      // （W8：旧实现速度指数衰减继续位移，满速时 0.3s 漂移 ~2.8m，起爆点
      // 比玩家看到的激活点远 1-3m；arm 期也无撞面可言——不位移即不穿墙）
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
    // 充能完成（橙光 + 提示音，维基记载）——调色作用于 glowMats（官方模型 =
    // 官方材质，程序化 = glowMat）与容器点光，玩家实际看到的模型整体转橙
    if (!p.charged && p.flight >= S.chargeTime) {
      p.charged = true
      const m = this._models.skye
      m.light.color.setHex(0xffa040)
      for (const g of m.glowMats) g.mat.emissive.setHex(0xffb060)
      this.audio.flashCharge(p.pos, this._listener)
    }
    // 激活条件（任一）：
    //  - 充能满 且 已贴近玩家（到位后盘旋充满 → pop flash 满 2.25s 威胁）
    //  - 飞满寿命 2s（v8.01：到时自动激活）
    const dEye = Math.hypot(eye.x - p.pos.x, eye.y - p.pos.y, eye.z - p.pos.z)
    if ((p.charged && dEye <= S.popDist) || p.flight >= S.maxFlight) {
      p.phase = 'arm'
      p.armT = 0
      // 定格：记住激活瞬间的航向（姿态保持），速度清零——原地悬停等起爆
      const vl = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1
      p.armDir = { x: p.vel.x / vl, y: p.vel.y / vl, z: p.vel.z / vl }
      p.vel.x = p.vel.y = p.vel.z = 0
      this.audio.flashArm(p.pos, this._listener)
    }
  }

  _stepPhoenix(p, dt) {
    const P = CONFIG.flash.phoenix
    p.t += dt
    const s = Math.min(P.speed * p.t, p.curve.len)
    // 差分基准用标量（128Hz 步进 ×0.6s 飞行期，每步两只短命对象纯 GC churn）；
    // p.vel 就地写分量（spawn 时已初始化，消费点只有拖尾的焰丝方向）
    const px = p.pos.x, py = p.pos.y, pz = p.pos.z
    p.curve.point(s, p.pos)
    if (dt > 0) {
      p.vel.x = (p.pos.x - px) / dt
      p.vel.y = (p.pos.y - py) / dt
      p.vel.z = (p.pos.z - pz) / dt
    }
    const segX = p.pos.x - px, segY = p.pos.y - py, segZ = p.pos.z - pz
    const segLen = Math.hypot(segX, segY, segZ)
    if (segLen > 1e-6) {
      const hit = this.world.raycast(px, py, pz, segX / segLen, segY / segLen, segZ / segLen, segLen)
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

  // Breach：fly（24m/s 直线飞向放置点，穿墙不检碰撞——Placement 语义）→
  // set（到位即停，贴墙 0.5s 预备倒数；视觉脉冲在 renderSync）
  _stepBreach(p, dt) {
    p.t += dt
    if (p.phase === 'fly') {
      p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt
      if (p.t >= p.flyT) {
        p.pos.x = p.place.x; p.pos.y = p.place.y; p.pos.z = p.place.z // 到位即停（snap 防步长过冲）
        p.phase = 'set'
        p.armT = 0
      }
      return
    }
    p.armT += dt
    if (p.armT >= CONFIG.flash.breach.windup) this._pop(p, CONFIG.flash.breach.maxBlind)
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
    // 命中：逐步续借视界占用（+1.5 步，覆盖步进/渲染的相位差）——"看清瞳孔即
    // 持续命中"；转开后下一步即停止续借，屏效按 fadeTime=0.3s 线性褪去
    // （reyna-6：实现与自述口径一致，不再有 0.3s 的滞后残留窗）
    if (leerAffects(angleDeg, los)) this._nearsightUntil = this.t + dt * 1.5
    // LOS 预警（维基 Leer：warning VFX appear on their screen if they are in the
    // eye's line of sight, even if they are not affected）——眼开期内只看 LOS，
    // 与玩家朝向无关（眼盯着人，人背对也算"在视线内"）；renderSync 读此标记
    p.warn = los
    if (p.eyeT >= R.nearsight) { this._expire(p) } // 自然消散：无爆闪、不催 peek
  }

  // Gekko：抛掷段 Class 2 物理（口径 ~100m/s，到位 ~0.1s 级）——高速蹿出后
  // 急停悬停（到位 snap 到瞄准点、速度清零）；0.65s 激活预备后进入活跃 1s 窗：
  // 视线内 45m 目标锁定 0.35s → 喷等离子弹体（转身不可避），失准回退
  _stepGecko(p, dt) {
    const G = CONFIG.flash.gecko
    p.t += dt
    if (!p.slowed) {
      // 抛掷段：重力 + 撞面即停（撞到也算到位）；到飞抵时刻急停悬停
      p.vel.y -= G.gravity * dt
      const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z)
      let landed = false
      if (speed > 1e-4) {
        const dirX = p.vel.x / speed, dirY = p.vel.y / speed, dirZ = p.vel.z / speed
        const dist = speed * dt
        const hit = this.world.raycast(p.pos.x, p.pos.y, p.pos.z, dirX, dirY, dirZ, dist + 0.04)
        if (hit && hit.t <= dist + 0.04) {
          p.pos.x = hit.x + hit.nx * 0.1; p.pos.y = hit.y + hit.ny * 0.1; p.pos.z = hit.z + hit.nz * 0.1
          landed = true
        } else {
          p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt
        }
      }
      if (landed || p.t >= p.flyT) {
        // 急停悬停：snap 到瞄准点（100m/s 下每步 0.78m，snap 防过冲）、速度清零
        p.pos.x = p.hover.x; p.pos.y = Math.max(p.hover.y, 0.55); p.pos.z = p.hover.z
        p.vel.x = p.vel.y = p.vel.z = 0
        p.slowed = true
      }
    }
    // 悬停段逻辑位不动：低频浮动是 renderSync 的渲染偏移（sin 叠加）
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

  // 等离子发射：Dizzy 喷出绿色等离子弹体飞向玩家（官方 'unleashes plasma
  // blasts'，v6.05 补丁专项改进『等离子在飞行途中』的听辨性）——命中瞬间才
  // 结算糊屏。弹体全程追踪玩家眼位（糊屏转身不可避的既有口径：命中只要求
  // 喷出瞬间 LOS），飞行时长 = 距离/plasmaSpeed
  _firePlasma(p) {
    p.fired = true
    const eye = this._eye()
    const dx = eye.x - p.pos.x, dy = eye.y - p.pos.y, dz = eye.z - p.pos.z
    const d = Math.hypot(dx, dy, dz) || 1
    this._plasmaShot = {
      fx: p.pos.x, fy: p.pos.y, fz: p.pos.z,
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      t: 0, dur: Math.max(0.05, d / CONFIG.flash.gecko.plasmaSpeed),
    }
    if (!this._plasmaBolt) this._makePlasmaBolt()
  }

  // 等离子弹体步进：直线飞向实时眼位（追踪），t≥dur 命中——溅射糊屏结算 +
  // 2.5m 溅射视觉 + 命中音（命中瞬间才发生，弹体飞行期屏幕干净）
  _stepPlasmaShot(dt) {
    const s = this._plasmaShot
    s.t += dt
    const eye = this._eye()
    const k = Math.min(1, s.t / s.dur)
    s.x = s.fx + (eye.x - s.fx) * k
    s.y = s.fy + (eye.y - s.fy) * k
    s.z = s.fz + (eye.z - s.fz) * k
    if (k < 1) return
    // 命中：全屏 2s = 1s 满效 + 1s 渐褪（维基 cannot avoid by turning away）
    const total = dizzyPlasmaBlind()
    this._plasma = { at: this.t, potencyUntil: this.t + total.potency, until: this.t + total.total }
    // 命中溅射视觉：2.5m 溅射半径（game files Plasma explosion radius）——
    // 绿紫史莱姆双色（本体 goop 是绿紫外星黏液）：球面散布火花向外崩 + 大团
    // 软泡在眼位涨开（size 为世界直径，~2m 泡读作 2.5m 溅射区）
    const R = CONFIG.flash.gecko.splash
    for (let i = 0; i < 18; i++) {
      _va.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      const r = R * (0.35 + Math.random() * 0.65)
      const green = i % 2 === 0
      this.fx.sparks.emit(eye.x + _va.x * r, eye.y + _va.y * r, eye.z + _va.z * r,
        _va.x * 2.4, _va.y * 2.4 + 0.4, _va.z * 2.4,
        {
          life: 0.3 + Math.random() * 0.25, size: 0.05,
          r: green ? 0.5 : 0.72, g: green ? 0.95 : 0.42, b: green ? 0.55 : 1,
          alpha: 0.95, drag: 2,
        })
    }
    for (let i = 0; i < 6; i++) {
      this.fx.puffs.emit(eye.x + (Math.random() - 0.5) * 0.6, eye.y + (Math.random() - 0.5) * 0.5, eye.z + (Math.random() - 0.5) * 0.6,
        0, 0.3, 0, { life: 0.45 + Math.random() * 0.2, size: 0.5, sizeEnd: 1.6, r: 0.42, g: 0.85, b: 0.52, alpha: 0.4, drag: 1.2 })
    }
    this.audio.plasmaSplat?.({ x: eye.x, y: eye.y, z: eye.z }, this._listener)
    this._plasmaShot = null
    this.onPopped?.(true) // 敌方成功施放 → 催促 peek（与白闪 pop 同语义）
  }

  // 等离子弹体（懒建复用）：绿亮核心 + 加法光晕精灵 + 绿点光——来袭弹读感
  _makePlasmaBolt() {
    const g = new THREE.Group()
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x9dffb0 }),
    )
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: Tex.spark(), color: 0x6ceca0, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    halo.scale.set(0.5, 0.5, 1)
    const light = new THREE.PointLight(0x6cff9d, 1.2, 4, 2)
    g.add(core, halo, light)
    g.visible = false
    this.scene.add(g)
    this._plasmaBolt = g
  }

  // Dizzy 活跃窗耗尽：坠落地面化为休眠 Globule 泡泡残躯（W15，v12.03 存世
  // 20s），到期迸散成 droplets——装饰性残躯，不占用 this.proj（下一颗闪光
  // 不被阻塞）；回收/续用机制不实现（单人场景）
  _expireGecko(p) {
    this.fx.sparks.emit(p.pos.x, p.pos.y - 0.1, p.pos.z, 0, -1.2, 0,
      { life: 0.4, size: 0.08, sizeEnd: 0.04, r: 0.6, g: 0.5, b: 1, alpha: 0.8, drag: 0.4 })
    this.audio.globuleDrop?.(p.pos, this._listener)
    this._spawnGlobule(p.pos)
    this._despawn()
    this.onPopped?.(false)
  }

  // 休眠 Globule 残躯（懒建复用）：半透明绿紫泡泡 + 内核微光 + 弱点光；
  // 独立于 this.proj 存续
  _spawnGlobule(pos) {
    if (!this._globuleMesh) {
      const g = new THREE.Group()
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 16, 12),
        new THREE.MeshStandardMaterial({
          color: 0x9adca8, emissive: 0x3a8a55, emissiveIntensity: 0.35,
          transparent: true, opacity: 0.55, roughness: 0.15,
        }),
      )
      shell.scale.y = 0.92
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x2a5a3a, emissive: 0x66d98a, emissiveIntensity: 1.1, roughness: 0.3 }),
      )
      const light = new THREE.PointLight(0x6cd98f, 0.5, 3, 2)
      g.add(shell, core, light)
      g.visible = false
      this.scene.add(g)
      this._globuleMesh = { group: g, shell, core, light }
    }
    this._globule = { x: pos.x, y: pos.y, z: pos.z, vy: 0.6, rest: false, until: this.t + CONFIG.flash.gecko.globuleLife }
  }

  // Globule 步进：坠落（地图重力）→ 触地一次弱弹跳 → 静置；到期迸散成 droplets
  _stepGlobule(dt) {
    const s = this._globule
    if (!s.rest) {
      s.vy -= CONFIG.movement.gravity * dt
      s.y += s.vy * dt
      if (s.y <= 0.14) {
        s.y = 0.14
        s.vy = Math.abs(s.vy) > 2.2 ? -s.vy * 0.22 : 0 // 一次弱弹跳后静止
        if (s.vy === 0) {
          s.rest = true
          for (let i = 0; i < 5; i++) {
            this.fx.sparks.emit(s.x, s.y + 0.05, s.z, (Math.random() - 0.5) * 1.2, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 1.2,
              { life: 0.3, size: 0.035, sizeEnd: 0.012, r: 0.55, g: 0.9, b: 0.6, alpha: 0.85, drag: 2 })
          }
        }
      }
    }
    if (this.t >= s.until) {
      // 到期迸散：droplets 飞溅 + 轻烟，残躯消失（20s 休眠期结束）
      for (let i = 0; i < 8; i++) {
        _va.set(Math.random() - 0.5, Math.random() * 0.7, Math.random() - 0.5).normalize().multiplyScalar(1 + Math.random() * 2)
        this.fx.sparks.emit(s.x, s.y, s.z, _va.x, _va.y, _va.z,
          { life: 0.3 + Math.random() * 0.2, size: 0.04, sizeEnd: 0.012, r: 0.5, g: 0.88, b: 0.58, alpha: 0.9, drag: 2.2 })
      }
      this.fx.puffs.emit(s.x, s.y, s.z, 0, 0.3, 0, { life: 0.4, size: 0.1, sizeEnd: 0.3, r: 0.5, g: 0.72, b: 0.55, alpha: 0.3, drag: 1.4 })
      this._globule = null
      this._globuleMesh.group.visible = false
    }
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
      // 叠加口径（未验证的口径假设——Valorant 无公开叠加/刷新规则，社区共识仅
      // 「时长不叠加」；见 README 已知边界）：取「不缩短」的保守 max——已致盲
      // 剩余 2s 时再吃到背闪 0.18s 不会被截短；更强的新闪整体刷新到新时长
      // （非累加）。仅在延长时重置 _blindAt（白屏 0.06s 淡入的起点）——更弱的
      // 新闪不改截止时刻，屏效维持原状。待真机核实后如需改口径，同步改
      // tests/flash-system.test.js 里标注「假设性」的叠加用例
      if (this.t + dur > this.blindUntil) {
        this.blindUntil = this.t + dur
        this._blindAt = this.t
      }
      this.blindTotal = dur
      intensity = 1 + Math.min(0.25, (dur / maxBlind) * 0.25) // 贴脸爆闪更炸
    }
    this._popVisual(p.type, pos)
    // blinded=dur>0 传给音效：躲过（背对/无视线）时高频层压暗——"背身成功"听得出来
    this.audio.flashPop(p.type, pos, this._listener, intensity, dur > 0)
    this._despawn()
    this.onPopped?.(dur > 0)
  }

  // 起爆视觉：白色主爆闪 + 类型色冲击环/双色火花 + 稍驻留的爆闪照明——
  // 三类道具各自的"爆炸性格"（KAY/O 电蓝、斯凯翠金、火男炽焰）。
  // Breach 专属：贴墙竖直光柱（游戏内 Flashpoint 起爆是沿墙面的竖条爆闪，
  // 非球形扩散）+ 竖直定向火花
  _popVisual(type, pos) {
    const fx = this.fx
    const C = {
      kayo: { light: 0xbfeaff, ring: 0x7deaff, ringMax: 2.8, s1: [0.72, 0.96, 1], s2: [1, 1, 1] },
      skye: { light: 0xd8ffe6, ring: 0x66ffb2, ringMax: 2.4, s1: [0.55, 1, 0.72], s2: [1, 0.88, 0.5] },
      phoenix: { light: 0xffd9a8, ring: 0xff9a3c, ringMax: 2.6, s1: [1, 0.55, 0.16], s2: [1, 0.85, 0.45] },
      yoru: { light: 0xcff5ff, ring: 0x7deaff, ringMax: 2.6, s1: [0.45, 0.9, 1], s2: [1, 1, 1] },
      breach: { light: 0xd6e2ff, ring: 0x9db8ff, ringMax: 3.0, s1: [0.62, 0.72, 1], s2: [1, 1, 1] },
    }[type]
    // 爆闪照明：主场景灯在真实爆点（显式 18cd：技能糊脸爆闪刻意大亮，不受
    // 枪口基准收敛影响；驻留 0.26s），第一人称通道由 vmPopGlow 以类型色点亮
    // 枪身+手套（默认峰值已按近距约束收敛）
    fx.muzzle(pos, { scale: 7, opacity: 1, lightPeak: 18, lightDur: 0.26, color: C.light })
    fx.vmPopGlow(C.light)
    if (type === 'breach') {
      // 竖直光柱：贴墙面拔起的竖条爆闪（本体形态）——加法混合圆柱，0.32s
      // 内上冲拉伸后熄灭；柱心压在爆点、底端插地由深度测试自然裁掉
      const b = this._beam ?? this._makeBeam()
      b.t = 0
      b.mesh.position.set(pos.x, Math.max(pos.y, 2.0), pos.z - 0.07)
      b.mesh.material.opacity = 1
      b.mesh.scale.set(1, 0.6, 1)
      b.mesh.visible = true
    } else {
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
    }
    // 双色火花迸溅（Breach 竖直定向：沿光柱上下喷）
    for (let i = 0; i < 30; i++) {
      if (type === 'breach') {
        _va.set((Math.random() - 0.5) * 0.9, (Math.random() < 0.5 ? -1 : 1) * (1.6 + Math.random() * 3.4), (Math.random() - 0.5) * 0.6)
      } else {
        _va.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(1.5 + Math.random() * 3.8)
      }
      const c = i % 3 ? C.s1 : C.s2
      fx.sparks.emit(pos.x, pos.y, pos.z, _va.x, _va.y, _va.z,
        { life: 0.22 + Math.random() * 0.26, size: 0.038, r: c[0], g: c[1], b: c[2], drag: 3 })
    }
  }

  // Breach 起爆光柱网格（懒建复用）：开口圆柱 + 加法混合，专用于竖条爆闪
  _makeBeam() {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 4.6, 14, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xe4ecff, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    )
    mesh.visible = false
    this.scene.add(mesh)
    this._beam = { mesh, t: 0 }
    return this._beam
  }

  // 玩家视线方向（pitch/yaw → 单位向量；与相机姿态同式）。复用对象，同 _eye
  _forward() {
    const cy = Math.cos(this.player.yaw), sy = Math.sin(this.player.yaw)
    const cp = Math.cos(this.player.pitch), sp = Math.sin(this.player.pitch)
    _fwdOut.x = -sy * cp
    _fwdOut.y = sp
    _fwdOut.z = -cy * cp
    return _fwdOut
  }

  _despawn() {
    const p = this.proj
    if (p?.voice) p.voice.stop()
    this.proj = null
    for (const m of Object.values(this._models)) m.group.visible = false
    // skye/gecko 的充能染色复位：glowMats（官方或程序化材质组）恢复原 emissive
    // 色与原强度，容器点光恢复基准色/强度——下次生成从绿色/紫态起步
    for (const key of ['skye', 'gecko']) {
      const m = this._models[key]
      for (const g of m.glowMats) {
        g.mat.emissive.setHex(g.baseEmissive)
        g.mat.emissiveIntensity = g.baseIntensity
      }
      m.light.color.setHex(m.lightBase.color)
      m.light.intensity = m.lightBase.intensity
    }
  }

  // ---- 渲染帧：白屏/近视/等离子透明度 / 网格插值 / 模型动画 / 拖尾 / 移动声源 ----
  renderSync(alpha, dt = 0.016) {
    // 白屏：起爆后 0.06s 快速拉满（游戏同款的瞬时白），致盲期内不透明，
    // 到期后 1 秒线性渐褪（维基确认值）。冷白平铺——官方 "opaque, colored
    // screen"，真机观感白/淡蓝：极淡冷蓝 #e9f2ff（W17），无渐变边缘、无残像色
    let o = 0
    if (this.blindUntil >= 0) {
      const k = (this.t - this.blindUntil) / CONFIG.flash.fadeTime
      if (k < 0) o = Math.min(1, (this.t - this._blindAt) / 0.06)
      else if (k >= 1) this.blindUntil = -1
      else o = 1 - k
    }
    this.overlayEl.style.opacity = o.toFixed(3)

    // 近视（Reyna）：世界空间 6m 视界 + 全屏品红雾罩两层实现——
    // ① 世界空间：场景雾收束（W3 重建：旧的整屏 CSS blur 与 Nearsight 感知
    //    相反——贴脸 2m 被糊、15m 外反而清晰。雾按片元深度逐像素生效，6m 内
    //    清晰、6m 外暗品红不透明覆盖，褪去时随 _nsO 线性退回）；
    // ② 全屏品红调色：CSS 雾罩（style.css .nearsight-blind）+ 本透明度。
    // 曲线口径（reyna-6 并入）：命中 0.12s 线性拉满、转开 fadeTime=0.3s 线性
    // 褪去——实现与自述一致（旧的 4/s 指数缓动 0.3s 时仍剩 0.289，差 2.5 倍）
    this._nsO = this._nsO ?? 0
    const nsTarget = this._nearsightUntil > this.t ? 1 : 0
    const R = CONFIG.flash.reyna
    this._nsO = clamp(this._nsO + (nsTarget ? 1 : -1) * dt / (nsTarget ? R.onsetTime : R.fadeTime), 0, 1)
    this.nearsightEl.style.opacity = this._nsO.toFixed(3)
    if (this._nsO > 0.0005) {
      this._fog.near = THREE.MathUtils.lerp(this._fogRest.near, R.visionRadius * 0.75, this._nsO)
      this._fog.far = THREE.MathUtils.lerp(this._fogRest.far, R.visionRadius, this._nsO)
      _fogColor.setHex(this._fogRest.color).lerp(_nsFogColor.setHex(R.nearFogColor), this._nsO)
      this._fog.color.copy(_fogColor)
      this._fogDirty = true
    } else if (this._fogDirty) {
      this._fog.near = this._fogRest.near
      this._fog.far = this._fogRest.far
      this._fog.color.setHex(this._fogRest.color)
      this._fogDirty = false
    }
    // Deafened（维基 Status Effect：Nearsight 者同时被聋）：与近视屏效同一条
    // 透明度曲线驱动主链闷化——视野收束与听觉闷化同步起/褪
    this.audio.setDeafened?.(this._nsO)
    // Leer LOS 预警（W10）：眼球开眼期玩家在其视线内（p.warn，与玩家朝向无关）
    // 且尚未被近视 → 屏幕边缘品红呼吸预警；已被近视后预警无意义（整个屏幕
    // 都是"警报"），随 (1-_nsO) 压隐
    const wp = this.proj
    const warnOn = wp?.type === 'reyna' && wp.phase === 'active' && wp.warn && this._nearsightUntil <= this.t
    this._warnO += ((warnOn ? 1 : 0) - this._warnO) * Math.min(1, 7 * dt)
    if (this._warnO < 0.0005) this._warnO = 0
    this.warnEl.style.opacity = (this._warnO * (1 - this._nsO)).toFixed(3)
    // 等离子（Dizzy）：1s 满效 + 1s 渐褪（转身不可避）。渐褪 = 边缘可见圈从
    // 边缘向内持续扩张（W12：--plasma-hole 收小）+ 后段整体变薄——不再整屏
    // 同步变淡
    let po = 0
    let hole = CONFIG.flash.gecko.plasmaEdgeStart
    if (this._plasma) {
      const G = CONFIG.flash.gecko
      const fadeK = (this.t - this._plasma.potencyUntil) / (this._plasma.until - this._plasma.potencyUntil)
      if (fadeK <= 0) po = 1 // 满效期：浆块盖住绝大部分视野，仅边缘露一圈
      else if (fadeK < 1) {
        hole = G.plasmaEdgeStart * (1 - Math.pow(fadeK, G.plasmaEdgeCurve))
        po = fadeK <= G.plasmaAlphaHold ? 1 : 1 - (fadeK - G.plasmaAlphaHold) / (1 - G.plasmaAlphaHold)
      } else this._plasma = null
    }
    this.plasmaEl.style.opacity = po.toFixed(3)
    this.plasmaEl.style.setProperty('--plasma-hole', hole.toFixed(3))

    // 等离子弹体飞行表现（W11）：绿亮弹体 + 拖尾细缕；命中后隐藏
    if (this._plasmaBolt) {
      this._plasmaBolt.visible = !!this._plasmaShot
      if (this._plasmaShot) {
        const s = this._plasmaShot
        const pulse = 1 + Math.sin(this.t * 40) * 0.18
        this._plasmaBolt.position.set(s.x, s.y, s.z)
        this._plasmaBolt.scale.setScalar(pulse)
        this._boltTrailAt += dt
        if (this._boltTrailAt > 0.024) {
          this._boltTrailAt = 0
          this.fx.sparks.emit(s.x, s.y, s.z, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4,
            { life: 0.22, size: 0.04, sizeEnd: 0.01, r: 0.5, g: 0.95, b: 0.55, alpha: 0.9, drag: 2.4 })
        }
      }
    }

    // Globule 残躯表现（W15）：静置期慢呼吸（1.6Hz 径向脉动 + 轻微压扁呼吸）
    // + 内核微光脉动；下坠段轻微拉伸（速度感）
    if (this._globuleMesh) {
      const s = this._globule
      this._globuleMesh.group.visible = !!s
      if (s) {
        const g = this._globuleMesh
        g.group.position.set(s.x, s.y, s.z)
        if (s.rest) {
          const breathe = Math.sin(this._animT * Math.PI * 2 * 1.6)
          g.group.scale.set(1 + breathe * 0.04, 0.92 - breathe * 0.05, 1 + breathe * 0.04)
          g.core.material.emissiveIntensity = 1.1 + breathe * 0.3
          g.light.intensity = 0.5 + breathe * 0.12
        } else {
          g.group.scale.set(0.94, 1.08, 0.94) // 下坠拉伸
        }
      }
    }

    // Breach 起爆光柱：0.32s 上冲拉伸 → 熄灭（独立于投掷物存续）
    if (this._beam?.mesh.visible) {
      this._beam.t += dt
      const k = this._beam.t / 0.32
      if (k >= 1) this._beam.mesh.visible = false
      else {
        this._beam.mesh.scale.y = 0.6 + k * 0.55
        this._beam.mesh.material.opacity = 1 - k
      }
    }

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
    // 0.3s，副投/主投各自 p.telegraph）、斯凯预备期 0.3s、火男全程渐亮（与渐强
    // 音效同拍）、Yoru/Breach 预备期全程亮起、Reyna 睁眼进度、Dizzy 激活充能
    //（分母 = activationWindup - glowLead：0.2s 起亮提前量不计入分母，发光峰值
    // 恰在 0.65s 悬停/锁定起点收满——W9）
    let tele = 0
    if (p.type === 'kayo') tele = clamp(1 - (p.fuse - p.t) / (p.telegraph ?? CONFIG.flash.kayo.telegraph), 0, 1)
    else if (p.type === 'skye' && p.phase === 'arm') tele = clamp(p.armT / CONFIG.flash.skye.activationWindup, 0, 1)
    else if (p.type === 'phoenix') tele = clamp(p.t / CONFIG.flash.phoenix.windup, 0, 1)
    else if (p.type === 'yoru') tele = p.bounced ? clamp(p.windT / CONFIG.flash.yoru.windup, 0, 1) : 0
    else if (p.type === 'breach') tele = p.phase === 'set' ? clamp(p.armT / CONFIG.flash.breach.windup, 0, 1) : 0
    else if (p.type === 'reyna') tele = p.phase === 'arrive' ? clamp(p.armT / CONFIG.flash.reyna.arrivalWindup, 0, 1) : p.phase === 'active' ? 1 : 0
    else if (p.type === 'gecko') {
      const G = CONFIG.flash.gecko
      tele = clamp((p.t - G.glowLead) / (G.activationWindup - G.glowLead), 0, 1)
    }

    if (p.type === 'kayo') {
      // 翻滚随速度：出手快转，落地静止后收势（速度越低转越慢直至停住）
      const spd = Math.hypot(p.vel.x, p.vel.y, p.vel.z)
      const k = Math.min(1, spd / 6)
      m.group.rotation.y += (1.2 + 8 * k) * dt
      m.group.rotation.x += (0.6 + 4 * k) * dt
      // 琥珀警灯脉冲（v10.06 专属视觉全程化，W13）：弹跳后的 0.8s windup 内
      // 警灯即随 windup 进度脉冲（幅度/频率线性爬升，与 0.8s 爬升嗡鸣同拍同长）
      // ——警灯是玩家计时转身的视觉锚点，不能只在末 0.3s telegraph 才出现；
      // 未弹跳的飞行段（含空爆变体）仍走末 0.3s telegraph
      const windK = p.bounced && p.bounceLeft > 0
        ? clamp(1 - (p.fuse - p.t) / p.bounceLeft, 0, 1)
        : tele
      this._pulse += dt * (3 + 22 * windK)
      m.glowMat.emissiveIntensity = 1.6 + windK * 2.4 * (0.6 + 0.4 * Math.sin(this._pulse * Math.PI * 2))
    } else if (p.type === 'skye') {
      // +Z（喙向）对准航向；arm 定格期速度已清零，朝向保持激活瞬间航向
      if (p.phase === 'arm' && p.armDir) {
        m.group.lookAt(ix + p.armDir.x, iy + p.armDir.y, iz + p.armDir.z)
      } else {
        m.group.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z)
      }
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
      // 充能/预备渐亮：作用于 glowMats（官方模型 = 官方材质组，程序化 = glowMat）
      // + 容器点光——两条模型路径下"起爆渐亮预告"都在实际渲染的画面上（W2）
      for (const g of m.glowMats) g.mat.emissiveIntensity = g.baseIntensity + tele * 4.4
      m.light.intensity = 0.8 + tele * 2.2
    } else if (p.type === 'yoru') {
      // 显形后原地自旋 + 内芯亮起（0.6s 预备的视觉倒数）
      m.group.rotation.y += dt * 5
      m.group.rotation.x += dt * 2.2
      m.mat.emissiveIntensity = 0.6 + tele * 6
      m.light.intensity = tele * 2.6
      m.shell.material.opacity = 0.5 + tele * 0.5
    } else if (p.type === 'breach') {
      if (p.phase === 'fly') {
        // 飞行段：光体保持航向（盘面法线 +Z = 飞行方向）+ 轻微滚转，引擎级
        // 微光让它在穿过门洞可见空间时能被瞥见（到位后进入预备脉冲）
        m.group.rotation.z += dt * 3
        m.glowMat.emissiveIntensity = 1.6 + Math.sin(this._pulse * Math.PI * 2) * 0.5
        this._pulse += dt * 6
        m.light.intensity = 1.1
      } else {
        // 贴墙脉冲：随预备进度加速的呼吸灯（唯一的转身提示——v1.06 音画预告口径）
        this._pulse += dt * (4 + 18 * tele)
        m.glowMat.emissiveIntensity = 0.8 + tele * 3 * (0.55 + 0.45 * Math.sin(this._pulse * Math.PI * 2))
        m.light.intensity = 0.5 + tele * 2.2
      }
    } else if (p.type === 'reyna') {
      // 眼茧开合（W14）：飞行段闭合态深紫球茧（缝光渗出 + 正前透光点读作
      // "中心透出亮紫虹膜光"）；到位 0.4s 眼睑膜如花瓣张开（easeOutBack 轻过冲）
      // 并随之消散；朝向全程沿施法方向固定（faceDir），不追踪个体玩家
      const R = CONFIG.flash.reyna
      m.group.lookAt(ix + p.faceDir.x, iy + p.faceDir.y, iz + p.faceDir.z)
      m.group.position.y = iy + Math.sin(this._animT * 2.2) * 0.05
      const open = p.phase === 'fly' ? 0.7 : 0.7 + tele * 0.45
      m.group.scale.setScalar(open)
      // 绽开曲线：easeOutBack（t=1 处恰好收在 1，中段轻过冲 ~1.1 读作"花瓣
      // 弹开"）；active 恒 1
      const bt = p.phase === 'arrive' ? clamp(p.armT / R.arrivalWindup, 0, 1) : p.phase === 'active' ? 1 : 0
      const bloom = bt >= 1 ? 1 : 1 + 2.7 * Math.pow(bt - 1, 3) + 1.7 * Math.pow(bt - 1, 2)
      // 眼睑膜：张开角 ±1.9rad（上片后仰、下片前俯）+ 微缩 + 消散；全开即隐
      const lidAng = Math.max(0, bloom) * 1.9
      m.budTop.rotation.x = -lidAng
      m.budBottom.rotation.x = lidAng
      m.budMat.opacity = Math.max(0, 1 - bloom)
      const lidsGone = bloom > 0.985
      m.budTop.visible = !lidsGone
      m.budBottom.visible = !lidsGone
      // 缝光：飞行段随旅程渐亮（虹膜光从闭合缝渗出），张开瞬间快速熄灭
      const seamK = p.phase === 'fly' ? clamp(p.t / R.travel, 0, 1) : Math.max(0, 1 - bloom * 2.5)
      m.seam.material.opacity = seamK * (0.55 + Math.sin(this._animT * 7) * 0.2)
      m.glowSpot.material.opacity = seamK * (0.5 + Math.sin(this._animT * 5.3) * 0.18)
      // 虹膜由暗渐亮（tele：arrive 0.4s 睁眼进度 → active 全亮）+ 微脉动
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
      // Dizzy：悬停浮动；飞行段身体俯仰朝航向（姿态初始化，~0.1s 高速蹿出的
      // 读感），悬停段转身面对玩家；官方模型摆尾/点头，程序化回退压身
      m.group.position.y = iy + Math.sin(this._animT * 3.1 + p.bobPhase) * 0.06
      if (!p.slowed) {
        m.group.lookAt(ix + p.vel.x, iy + p.vel.y, iz + p.vel.z)
      } else {
        m.group.lookAt(this.player.pos.x, m.group.position.y, this.player.pos.z)
      }
      const wag = Math.sin(this._animT * 7) * (0.25 + tele * 0.35)
      // 扇翅（W16）：悬停 idle 主特征动画——6.5Hz 上下扑 + 幅度/膜面微光随充能
      // 渐增；飞行段高频小幅扑动（13Hz）并后掠收翼。相位取渲染时钟（与浮动/
      // 摆尾同源，无音频绑定）；翼面挂容器层，官方/程序化两路径共用
      if (m.wings) {
        const flapHz = p.slowed ? 6.5 : 13
        const flapAmp = p.slowed ? 0.55 + tele * 0.15 : 0.3
        const flap = Math.sin(this._animT * Math.PI * 2 * flapHz) * flapAmp
        const fold = (p.slowed ? 0.18 : 0.45) + Math.abs(flap) * 0.1 // 飞行段后掠更多
        m.wings.R.rotation.z = flap // 绕前轴上下扑（右翼 +θ 抬、左翼镜像）
        m.wings.L.rotation.z = -flap
        m.wings.R.rotation.y = fold // 绕立轴后掠收展
        m.wings.L.rotation.y = -fold
        m.wings.mat.emissiveIntensity = 0.45 + tele * 0.5
      }
      if (m.official && m.bones?.Tail_01) {
        this._boneFlap(m.bones.Tail_01, wag, 'y')
        if (m.bones.Head) this._boneFlap(m.bones.Head, Math.sin(this._animT * 3.1 + p.bobPhase) * 0.14, 'x')
        m.group.scale.setScalar(1 + tele * 0.12)
      } else {
        m.body.scale.y = 0.92 - tele * 0.1 + Math.sin(this._animT * 6) * 0.02
      }
      // 充能渐亮：glowMats 统一驱动（官方材质组 / 程序化 glowMat）+ 容器点光
      for (const g of m.glowMats) g.mat.emissiveIntensity = g.baseIntensity + tele * 3
      m.light.intensity = 0.9 + tele * 2
    }

    // 拖尾：鹰绿光尾迹（充能满转橙+上飘余烬，arm 定格期收停——原地悬停的鹰
    // 不再拖着飞行尾迹，粒子在身后堆云是错误读法）/ 火球双层火焰+卷曲火丝 /
    // 眼与 Dizzy 的紫雾细缕；KAY/O 无尾迹（游戏同款）、Yoru 飞行不可见、
    // Breach 贴墙静止（游戏同款均无）
    this._trailAt += dt
    if ((p.type === 'skye' || p.type === 'phoenix' || p.type === 'reyna' || p.type === 'gecko') && this._trailAt > 0.02) {
      this._trailAt = 0
      const fx = this.fx
      if (p.type === 'skye') {
        if (p.phase !== 'arm') {
          const core = p.charged ? { r: 1, g: 0.66, b: 0.3 } : { r: 0.3, g: 1, b: 0.66 }
          fx.sparks.emit(ix, iy, iz, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4,
            { life: 0.45, size: 0.05, sizeEnd: 0.012, ...core, alpha: 0.9, drag: 2.2 })
          if (Math.random() < 0.3) fx.sparks.emit(ix, iy, iz, (Math.random() - 0.5) * 0.5, 0.1 + Math.random() * 0.3, (Math.random() - 0.5) * 0.5,
            { life: 0.5, size: 0.032, r: 1, g: 0.85, b: 0.45, alpha: 0.9, drag: 2 })
          if (p.charged && Math.random() < 0.55) fx.sparks.emit(ix + (Math.random() - 0.5) * 0.2, iy, iz + (Math.random() - 0.5) * 0.2,
            (Math.random() - 0.5) * 0.3, 0.5 + Math.random() * 0.6, (Math.random() - 0.5) * 0.3,
            { life: 0.5, size: 0.028, r: 1, g: 0.5, b: 0.18, drag: 1.2 })
        }
      } else if (p.type === 'reyna') {
        if (Math.random() < 0.6) fx.sparks.emit(ix + (Math.random() - 0.5) * 0.2, iy - 0.1, iz + (Math.random() - 0.5) * 0.2,
          (Math.random() - 0.5) * 0.2, -0.3 - Math.random() * 0.3, (Math.random() - 0.5) * 0.2,
          { life: 0.55, size: 0.045, sizeEnd: 0.01, r: 0.7, g: 0.3, b: 1, alpha: 0.7, drag: 1.4 })
      } else if (p.type === 'gecko') {
        if (Math.random() < 0.5) {
          const green = Math.random() < 0.55
          fx.sparks.emit(ix + (Math.random() - 0.5) * 0.15, iy - 0.05, iz + (Math.random() - 0.5) * 0.15,
            (Math.random() - 0.5) * 0.3, -0.2 - Math.random() * 0.2, (Math.random() - 0.5) * 0.3,
            {
              life: 0.4, size: 0.04, sizeEnd: 0.012,
              r: green ? 0.5 : 0.72, g: green ? 0.9 : 0.45, b: green ? 0.55 : 1,
              alpha: 0.75, drag: 1.6,
            })
        }
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
  // 在墙/机器人取最近时夹入。只认"到位后"的目标（飞行导弹段判定点还在移动）：
  // Reyna 眼 arrive（睁眼渐亮）阶段 pos 已停在部署点且清晰可见，一并纳入——
  // 对着肉眼可见的眼开枪穿体而过，与 Gekko 悬停即可击毁的行为也不一致
  pickHit(eye, dir, lim) {
    const p = this.proj
    if (!p) return null
    const isEye = p.type === 'reyna' && (p.phase === 'arrive' || p.phase === 'active')
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
