import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CONFIG, makeSprayPattern } from '../core/Config.js'
import { Tex } from '../world/Textures.js'

// 武器系统：命中判定（射线）+ 散布 + 后坐力弹道 + 换弹/切枪 + 第一人称持枪模型
// 手感要点（对齐游戏机制）：
//  - 射线从眼睛出发；子弹偏移 = 后坐力弹道表（累计值）+ 随机散布锥
//  - 静止首发精度高；移动/跳跃散布剧增；蹲下小幅加成
//  - 停火 recoverTime 后弹道立即重置（鼓励点射/急停）
const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _muzzle = new THREE.Vector3()
const _eject = new THREE.Vector3()
const _hitP = new THREE.Vector3()

export class WeaponSystem {
  constructor({ camera, world, bots, fx, audio, player }) {
    this.camera = camera; this.world = world; this.bots = bots
    this.fx = fx; this.audio = audio; this.player = player

    // 当前武器与副武器（菜单可改）
    this.primaryId = 'vandal'
    this.secondaryId = 'classic'
    this.currentId = 'vandal'
    this.baseVmScale = 0.55 // 视角模型基础缩放（宽 FOV 下控制占屏比例）
    this.state = {}    // 每把枪独立弹匣状态
    this.lastShotAt = -10
    this.lastFireTime = -10
    this.sprayIndex = 0
    this.nextShotAt = 0
    this.burstLeft = 0 // Classic 右键三连发
    this.equipUntil = 0
    this.reloadEnd = 0
    this.now = 0

    // 事件回调（main 注入）
    this.onHitBot = null    // (bot, zone, dmg, killed)
    this.onShotFired = null // () → 统计
    this.onAmmoChange = null

    this._buildViewmodel()
    this.switchTo(this.currentId, true)
  }

  get weapon() { return CONFIG.weapons[this.currentId] }

  // ---- 第一人称持枪模型：按武器类型分别建模（原创程序化几何，-Z 朝前）----
  // 支持 public/models/viewmodel.glb 用户自有模型整体替换（见 setCustomViewmodel）
  _buildViewmodel() {
    // 共享 PBR 材质（拉丝金属/聚合物/木纹贴图 + 法线/粗糙度）
    const metalMaps = Tex.metal()
    const woodMaps = Tex.wood()
    const polyMaps = Tex.polymer()
    this.vmMats = {
      steel: new THREE.MeshStandardMaterial({ color: 0x868e99, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, normalMap: metalMaps.normalMap, roughness: 0.42, metalness: 0.82 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x565c66, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, normalMap: metalMaps.normalMap, roughness: 0.55, metalness: 0.6 }),
      wood: new THREE.MeshStandardMaterial({ color: 0xb08a5e, map: woodMaps.map, normalMap: woodMaps.normalMap, roughness: 0.55, metalness: 0.05 }),
      poly: new THREE.MeshStandardMaterial({ color: 0xcfd4da, map: polyMaps.map, roughnessMap: polyMaps.roughnessMap, normalMap: polyMaps.normalMap, roughness: 0.82, metalness: 0.08 }),
      silver: new THREE.MeshStandardMaterial({ color: 0xc9d2da, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, roughness: 0.3, metalness: 0.95 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xe0b53c, roughness: 0.3, metalness: 0.9, emissive: 0x332200 }),
      dot: new THREE.MeshStandardMaterial({ color: 0x7dff9a, emissive: 0x2fbf62, emissiveIntensity: 2.2, roughness: 0.4 }),
    }
    // 第一人称手臂材质：战术袖料（浅灰纯色，避免贴图乘色过暗）+ 战术手套（所有武器共享）
    this.armMats = {
      sleeve: new THREE.MeshStandardMaterial({ color: 0x99a0a8, roughness: 0.93, metalness: 0 }),
      glove: new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.88, metalness: 0.05 }),
    }
    this.viewmodels = {
      vandal: this._buildRifleAK(),
      phantom: this._buildRifleSuppressed(),
      sheriff: this._buildRevolver(),
      classic: this._buildPistol(false),
      ghost: this._buildPistol(true),
      knife: this._buildKnife(),
    }
    // 静态持枪手臂跟随各武器（继承位置/缩放/后坐摆动，本身不做独立动画）
    const armFor = { vandal: 'rifle', phantom: 'rifle', sheriff: 'pistol', classic: 'pistol', ghost: 'pistol', knife: 'knife' }
    for (const [id, kind] of Object.entries(armFor)) this.viewmodels[id].add(this._buildArms(kind))
    const holder = new THREE.Group()
    for (const vm of Object.values(this.viewmodels)) holder.add(vm)
    holder.position.set(0.17, -0.15, -0.22) // 右下、贴近相机（Valorant 风格取景）
    holder.scale.setScalar(this.baseVmScale)
    this.camera.add(holder)
    this.vmHolder = holder
    this.vmBase = holder.position.clone()
    this.vmKick = 0
    this.swayX = 0; this.swayY = 0; this.bobT = 0
    this.muzzleOffset = new THREE.Vector3()
    this.customVm = null
    this.customHands = null
  }

  _vmHelpers() {
    const M = this.vmMats
    return {
      M,
      box: (g, mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
        m.position.set(x, y, z); m.rotation.set(rx, ry, rz)
        g.add(m)
        return m
      },
      cyl: (g, mat, r, len, x, y, z, seg = 14) => { // 沿 Z 轴（枪管方向）
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat)
        m.rotation.x = Math.PI / 2
        m.position.set(x, y, z)
        g.add(m)
        return m
      },
    }
  }

  // AK 型自动步枪（Vandal 定位）：机匣/防尘盖/导气管/木质护木/四段弧形弹匣/斜托/光纤准星
  _buildRifleAK() {
    const g = new THREE.Group()
    const { M, box, cyl } = this._vmHelpers()
    box(g, M.steel, 0.05, 0.065, 0.26, 0, 0, -0.04)                 // 机匣
    box(g, M.steel, 0.046, 0.018, 0.14, 0, 0.043, 0.01)             // 防尘盖
    box(g, M.dark, 0.028, 0.02, 0.045, 0, 0.058, -0.09)             // 表尺座
    box(g, M.dot, 0.006, 0.006, 0.006, 0, 0.072, -0.09)             // 表尺发光点
    cyl(g, M.dark, 0.011, 0.13, 0, 0.048, -0.3)                     // 导气管
    box(g, M.dark, 0.026, 0.03, 0.035, 0, 0.042, -0.38)             // 导气箍
    cyl(g, M.steel, 0.009, 0.2, 0, 0.012, -0.5, 6)                  // 六角枪管
    box(g, M.dark, 0.02, 0.03, 0.03, 0, 0.03, -0.6)                 // 准星座
    box(g, M.gold, 0.006, 0.028, 0.006, 0, 0.062, -0.6)             // 准星
    box(g, M.dot, 0.005, 0.005, 0.005, 0, 0.078, -0.6)              // 光纤点
    cyl(g, M.dark, 0.014, 0.055, 0, 0.012, -0.645)                  // 消焰器
    box(g, M.wood, 0.046, 0.042, 0.15, 0, -0.002, -0.31)            // 上护木
    box(g, M.wood, 0.04, 0.018, 0.15, 0, -0.032, -0.31)             // 下护木
    const magSeg = (y, z, rx) => box(g, M.dark, 0.034, 0.052, 0.05, 0, y, z, rx) // 四段弧形弹匣
    magSeg(-0.058, -0.025, 0.08)
    magSeg(-0.104, -0.008, 0.24)
    magSeg(-0.146, 0.018, 0.42)
    magSeg(-0.182, 0.052, 0.6)
    box(g, M.dark, 0.028, 0.005, 0.06, 0, -0.035, 0.03)             // 扳机护圈
    box(g, M.dark, 0.006, 0.018, 0.008, 0, -0.028, 0.018)           // 扳机
    box(g, M.wood, 0.034, 0.085, 0.045, 0, -0.06, 0.085, 0.3)       // 握把
    box(g, M.wood, 0.038, 0.05, 0.2, 0, -0.002, 0.26, -0.06)        // 枪托
    box(g, M.dark, 0.04, 0.06, 0.02, 0, -0.012, 0.36)               // 托底板
    cyl(g, M.dark, 0.006, 0.03, 0.034, 0.01, -0.06, 8)              // 拉机柄
    box(g, M.dark, 0.007, 0.026, 0.055, 0.0265, 0.012, -0.03)       // 抛壳口（右侧面暗槽）
    box(g, M.dark, 0.005, 0.02, 0.012, 0.0255, 0.012, -0.062)       // 抛壳口后导向
    for (const pz of [0.028, 0.072]) {                              // 机匣固定销 ×2
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.054, 8), M.dark)
      pin.rotation.z = Math.PI / 2
      pin.position.set(0, 0.008, pz)
      g.add(pin)
    }
    for (const rz of [-0.615, -0.655]) cyl(g, M.steel, 0.0155, 0.008, 0, 0.012, rz, 10) // 消焰器散热环
    this._orientVm(g, { muzzle: new THREE.Vector3(0, 0.012, -0.68), eject: new THREE.Vector3(0.035, 0.02, -0.03) })
    return g
  }

  // 消音步枪（Phantom 定位）：一体式消音管 + 平直弹匣 + 战术托
  _buildRifleSuppressed() {
    const g = new THREE.Group()
    const { M, box, cyl } = this._vmHelpers()
    box(g, M.poly, 0.05, 0.06, 0.3, 0, 0, -0.05)                    // 机匣
    box(g, M.dark, 0.016, 0.01, 0.42, 0, 0.038, -0.12)              // 全长导轨
    for (let i = 0; i < 9; i++) box(g, M.dark, 0.018, 0.006, 0.013, 0, 0.047, -0.24 + i * 0.045) // 导轨齿
    cyl(g, M.dark, 0.023, 0.28, 0, 0.012, -0.48)                    // 消音外管
    cyl(g, M.silver, 0.024, 0.012, 0, 0.012, -0.625)                // 管口银环
    box(g, M.poly, 0.044, 0.05, 0.16, 0, -0.004, -0.26)             // 护木
    box(g, M.dark, 0.03, 0.024, 0.02, 0, 0.03, -0.2)                // 前准星
    box(g, M.dark, 0.032, 0.022, 0.025, 0, 0.056, 0.06)             // 后照门
    box(g, M.dark, 0.032, 0.11, 0.05, 0, -0.075, -0.02, 0.08)       // 直弹匣
    box(g, M.poly, 0.034, 0.08, 0.045, 0, -0.055, 0.08, 0.25)       // 握把
    box(g, M.poly, 0.036, 0.055, 0.14, 0, -0.005, 0.19)             // 枪托
    box(g, M.poly, 0.04, 0.07, 0.03, 0, -0.012, 0.27)               // 托腮板
    box(g, M.dark, 0.024, 0.005, 0.055, 0, -0.032, 0.02)            // 护圈
    box(g, M.dark, 0.006, 0.022, 0.05, 0.0235, 0.01, -0.02)         // 抛壳口
    this._orientVm(g, { muzzle: new THREE.Vector3(0, 0.012, -0.64), eject: new THREE.Vector3(0.032, 0.015, -0.02) })
    return g
  }

  // 重左轮（Sheriff 定位）：转轮 + 六角枪管 + 木质握把
  _buildRevolver() {
    const g = new THREE.Group()
    const { M, box, cyl } = this._vmHelpers()
    box(g, M.steel, 0.032, 0.05, 0.15, 0, 0.005, -0.02)             // 枪身框架
    cyl(g, M.steel, 0.027, 0.05, 0, -0.002, -0.06)                  // 转轮
    cyl(g, M.dark, 0.006, 0.052, 0, -0.002, -0.06, 6)               // 转轮中心栓
    cyl(g, M.steel, 0.013, 0.17, 0, 0.014, -0.16, 6)                // 六角枪管
    box(g, M.dark, 0.012, 0.014, 0.16, 0, 0.033, -0.15)             // 准星肋
    box(g, M.gold, 0.005, 0.018, 0.008, 0, 0.05, -0.225)            // 前准星
    box(g, M.dark, 0.01, 0.022, 0.02, 0, 0.036, 0.05)               // 击锤
    box(g, M.wood, 0.03, 0.08, 0.042, 0, -0.05, 0.055, 0.38)        // 木质握把
    box(g, M.dark, 0.024, 0.005, 0.05, 0, -0.028, 0.0)              // 护圈
    box(g, M.dark, 0.006, 0.016, 0.008, 0, -0.02, -0.005)           // 扳机
    cyl(g, M.dark, 0.006, 0.13, 0, -0.008, -0.15, 8)                // 排壳杆外壳
    this._orientVm(g, {
      muzzle: new THREE.Vector3(0, 0.014, -0.25),
      pos: new THREE.Vector3(0.13, -0.125, -0.24),
      scale: 0.92,
      eject: new THREE.Vector3(0.024, 0.01, -0.05),
    })
    return g
  }

  // 手枪（Classic / Ghost）：套筒 + 握把，（Ghost）加消音管
  _buildPistol(suppressed) {
    const g = new THREE.Group()
    const { M, box, cyl } = this._vmHelpers()
    const slide = suppressed ? M.steel : M.silver
    box(g, slide, 0.028, 0.038, 0.17, 0, 0.02, -0.06)               // 套筒
    box(g, M.poly, 0.026, 0.03, 0.15, 0, -0.008, -0.04)             // 下机匣
    box(g, M.poly, 0.03, 0.082, 0.044, 0, -0.05, 0.04, 0.28)        // 握把
    box(g, M.dark, 0.022, 0.005, 0.05, 0, -0.026, -0.015)           // 护圈
    box(g, M.dark, 0.005, 0.014, 0.007, 0, -0.018, -0.02)           // 扳机
    box(g, M.dark, 0.006, 0.008, 0.01, 0, 0.045, -0.135)            // 前准星
    box(g, M.dark, 0.022, 0.008, 0.012, 0, 0.046, 0.015)            // 后照门
    for (let i = 0; i < 3; i++) box(g, M.dark, 0.03, 0.026, 0.0035, 0, 0.02, 0.0 + i * 0.009) // 套筒后部防滑纹
    if (suppressed) {
      cyl(g, M.dark, 0.015, 0.1, 0, 0.02, -0.2)                     // 消音管
      this._orientVm(g, { muzzle: new THREE.Vector3(0, 0.02, -0.26), pos: new THREE.Vector3(0.13, -0.125, -0.24), scale: 0.95, eject: new THREE.Vector3(0.018, 0.024, -0.05) })
    } else {
      cyl(g, M.dark, 0.009, 0.02, 0, 0.02, -0.155)                  // 枪口
      this._orientVm(g, { muzzle: new THREE.Vector3(0, 0.02, -0.17), pos: new THREE.Vector3(0.13, -0.125, -0.24), scale: 0.95, eject: new THREE.Vector3(0.018, 0.024, -0.02) })
    }
    return g
  }

  _buildKnife() {
    const k = new THREE.Group()
    const { M } = this._vmHelpers()
    const steel = new THREE.MeshStandardMaterial({ color: 0xaab4bd, roughness: 0.28, metalness: 0.92 })
    const gripM = new THREE.MeshStandardMaterial({ color: 0x1f2227, roughness: 0.85 })
    const bladeGeo = new THREE.BoxGeometry(0.018, 0.045, 0.24)
    bladeGeo.translate(0, 0, -0.14)
    const blade = new THREE.Mesh(bladeGeo, steel)
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.07, 4), steel)
    tip.rotation.x = -Math.PI / 2; tip.rotation.y = Math.PI / 4
    tip.position.set(0, 0, -0.29)
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.014, 0.016), M.dark)
    guard.position.set(0, 0, -0.015)
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.04, 0.12), gripM)
    grip.position.set(0, 0, 0.055)
    k.add(blade, tip, guard, grip)
    this._orientVm(k, { muzzle: new THREE.Vector3(0, 0, -0.3), pos: new THREE.Vector3(0.15, -0.13, -0.22), scale: 0.95 })
    return k
  }

  // 记录每把枪的枪口/抛壳口位置/持枪偏移/缩放（userData）
  _orientVm(g, { muzzle, eject = null, pos = new THREE.Vector3(0.15, -0.12, -0.27), scale = 1 }) {
    g.userData.muzzle = muzzle
    g.userData.eject = eject
    g.userData.pos = pos
    g.userData.scale = scale
    g.position.copy(pos)
    g.scale.setScalar(scale)
  }

  // ---- 第一人称持枪手臂（静态姿势）：袖臂圆柱 + 关节球 + 手指，全部合并成 2 个网格 ----
  // 坐标为各武器本地系（-Z 朝前），随武器继承持枪位置/缩放/后坐摆动，不做独立动画
  _buildArms(kind) {
    const sleeve = [], glove = []
    const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3()
    const UP = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3()
    const ball = (bk, x, y, z, r, sx = 1, sy = 1, sz = 1) => {
      _m4.compose(_p.set(x, y, z), _q.identity(), _s.set(sx, sy, sz))
      bk.push(new THREE.SphereGeometry(r, 12, 9).applyMatrix4(_m4))
    }
    const tube = (bk, ax, ay, az, bx, by, bz, r1, r2 = r1) => { // r1 近端 → r2 远端
      _d.set(bx - ax, by - ay, bz - az)
      const len = _d.length()
      const geo = new THREE.CylinderGeometry(r2, r1, len, 10)
      geo.translate(0, len / 2, 0)
      _q.setFromUnitVectors(UP, _d.normalize())
      _m4.compose(_p.set(ax, ay, az), _q, _s.set(1, 1, 1))
      bk.push(geo.applyMatrix4(_m4))
    }
    // 右臂（握把）：掌 + 指扣握 + 拇指 + 小臂/上臂探出画面右下（fingerZ 为绝对 Z 坐标）
    const rightArm = (gx, gy, gz, gripW, fingerZ, thumbZ) => {
      ball(glove, gx + 0.028, gy - 0.012, gz + 0.01, 0.04, 0.85, 1.25, 1.35)          // 右掌
      for (const fz of fingerZ) tube(glove, gx + gripW, gy + 0.015, fz, gx - gripW, gy - 0.002, fz - 0.006, 0.0088) // 四指
      ball(glove, gx + 0.036, gy + 0.035, thumbZ, 0.013, 0.8, 1, 1.7)                 // 拇指
      ball(sleeve, gx + 0.052, gy - 0.045, gz + 0.06, 0.036)                          // 腕
      tube(sleeve, gx + 0.056, gy - 0.05, gz + 0.07, gx + 0.13, gy - 0.13, gz + 0.26, 0.043, 0.052) // 小臂
      tube(sleeve, gx + 0.13, gy - 0.13, gz + 0.26, gx + 0.26, gy - 0.26, gz + 0.46, 0.052, 0.058)  // 上臂（出画）
    }
    // 左臂（护木/握把下）：掌 + 指扣压 + 拇指 + 小臂/上臂探出画面左下（fingerZ 为绝对 Z 坐标）
    const leftArm = (gx, gy, gz, gripW, fingerZ) => {
      ball(glove, gx - 0.004, gy - 0.016, gz, 0.042, 1.25, 0.9, 1.55)                 // 左掌（托底）
      for (const fz of fingerZ) tube(glove, gx - gripW, gy + 0.012, fz, gx + gripW - 0.004, gy + 0.03, fz + 0.005, 0.0085) // 四指扣顶
      ball(glove, gx + gripW + 0.004, gy + 0.008, gz - 0.03, 0.014, 0.75, 0.9, 2.0)   // 拇指（贴近侧）
      ball(sleeve, gx - 0.052, gy - 0.055, gz + 0.11, 0.035)                          // 腕
      tube(sleeve, gx - 0.056, gy - 0.06, gz + 0.12, gx - 0.15, gy - 0.16, gz + 0.3, 0.043, 0.052) // 小臂
      tube(sleeve, gx - 0.15, gy - 0.16, gz + 0.3, gx - 0.27, gy - 0.28, gz + 0.52, 0.052, 0.058)  // 上臂（出画）
    }

    if (kind === 'rifle') {
      rightArm(-0.068, -0.068, 0.086, 0.04, [0.064, 0.086, 0.108], 0.106)             // 右手握木握把（掌贴近侧面）
      leftArm(-0.036, -0.032, -0.31, 0.028, [-0.26, -0.3, -0.34, -0.37])              // 左手托下护木
    } else if (kind === 'pistol') {
      ball(glove, -0.03, -0.058, 0.048, 0.037, 0.82, 1.2, 1.3)                        // 右掌（贴近侧面外）
      for (const dz of [0.028, 0.048, 0.068]) tube(glove, 0.034, -0.028, dz, -0.028, -0.045, dz, 0.008)  // 右四指
      ball(glove, -0.05, -0.064, 0.036, 0.034, 0.8, 1.1, 1.2)                         // 左掌（托底）
      for (const dz of [0.03, 0.05, 0.07]) tube(glove, -0.056, -0.048, dz, 0.026, -0.058, dz, 0.008)     // 左指扣右指
      ball(sleeve, 0.048, -0.092, 0.1, 0.036)
      tube(sleeve, 0.052, -0.096, 0.11, 0.12, -0.175, 0.29, 0.043, 0.052)
      tube(sleeve, 0.12, -0.175, 0.29, 0.24, -0.3, 0.49, 0.052, 0.058)
      ball(sleeve, -0.05, -0.098, 0.085, 0.035)
      tube(sleeve, -0.054, -0.102, 0.095, -0.125, -0.18, 0.27, 0.042, 0.051)
      tube(sleeve, -0.125, -0.18, 0.27, -0.24, -0.3, 0.47, 0.051, 0.057)
    } else if (kind === 'knife') {
      ball(glove, -0.026, -0.026, 0.055, 0.038, 0.85, 1.3, 1.5)                       // 掌（贴近侧面外）
      for (const dz of [0.03, 0.06, 0.09]) tube(glove, 0.024, -0.002, dz, -0.022, -0.018, dz, 0.0085)
      ball(glove, -0.02, 0.008, 0.02, 0.011, 0.8, 1, 1.4)
      ball(sleeve, 0.042, -0.058, 0.12, 0.036)
      tube(sleeve, 0.046, -0.062, 0.13, 0.12, -0.15, 0.29, 0.043, 0.052)
      tube(sleeve, 0.12, -0.15, 0.29, 0.24, -0.27, 0.49, 0.052, 0.058)
    } else { // custom：用户自有枪模（customArms 原点=模型包围盒中心，-Z 朝枪口；经投影校准）
      // 手掌贴在枪身近侧（-X 面）外，手指穿过侧面 → 可见的"包握"
      rightArm(-0.12, 0.03, 0.126, 0.05, [0.1, 0.13, 0.16], 0.13)                     // 右手握握把（枪身后段）
      leftArm(-0.095, 0.1, -0.21, 0.035, [-0.26, -0.22, -0.18, -0.14])                // 左手包护木（枪身前段）
    }

    const g = new THREE.Group()
    g.add(new THREE.Mesh(mergeGeometries(sleeve, false), this.armMats.sleeve))
    g.add(new THREE.Mesh(mergeGeometries(glove, false), this.armMats.glove))
    return g
  }

  weaponMeshFor(id) {
    this.currentVmId = id
    for (const [vid, vm] of Object.entries(this.viewmodels)) vm.visible = vid === id
    const vm = this.viewmodels[id]
    this.muzzleOffset.copy(vm.userData.muzzle)
    if (this.customVm) { // 用户自有枪模：替换一切步枪/手枪显示
      for (const v of Object.values(this.viewmodels)) v.visible = false
      this.customVm.visible = true
      this.muzzleOffset.copy(this.customVm.userData.muzzle)
    }
    if (this.customArms) this.customArms.visible = !!this.customVm && !this.customHands // 自有枪模手臂随其显隐
    if (this.customHands) this.customHands.visible = !!this.customVm // GLB 手臂随自定义枪模显隐
  }

  // 用户自有 GLB 手臂（public/models/hands.glb）：按"左手/右手"骨骼位置做刚性对位 ——
  // 缩放到目标双手间距 → 模型手轴对齐目标轴 → 滚转使肘部朝画面后下方 → 双手中点对准目标中点 →
  // 手腕下压成持握姿势。tL/tR 为 holder 系落点（经截图迭代校准，使双手贴合枪身握把/护木）。
  // 注意：hands 需为未经本方法处理过的新实例（loadUserAssets 每次返回新场景）。
  setCustomHands(hands, tL = new THREE.Vector3(0.15, -0.17, -1.0), tR = new THREE.Vector3(0.15, -0.19, -0.5)) {
    hands.updateMatrixWorld(true)
    const byName = {}
    hands.traverse(o => { if (o.name) byName[o.name] = o })
    const find = (re) => Object.keys(byName).find(k => re.test(k))
    const handR = byName[find(/^HandR/)]      // GLTFLoader 会清理点号：Hand.R.001 → HandR001
    const handL = byName[find(/^HandL/)]
    const elbowL = byName[find(/^UpperArmL/)]
    if (handL && handR) {
      const pL = handL.getWorldPosition(new THREE.Vector3())
      const pR = handR.getWorldPosition(new THREE.Vector3())
      // 缩放：模型双手间距 → 目标双手间距
      const span = pR.distanceTo(pL)
      hands.scale.multiplyScalar(tR.distanceTo(tL) / Math.max(1e-4, span))
      hands.updateMatrixWorld(true)
      // 轴对齐：左手→右手方向
      const modelDir = handR.getWorldPosition(new THREE.Vector3()).sub(handL.getWorldPosition(new THREE.Vector3())).normalize()
      const targetDir = tR.clone().sub(tL).normalize()
      hands.quaternion.setFromUnitVectors(modelDir, targetDir)
      hands.updateMatrixWorld(true)
      // 滚转：绕手轴旋转，使"手→肘"指向画面后下方（臂膀出画）
      if (elbowL) {
        const elbowDir = elbowL.getWorldPosition(new THREE.Vector3()).sub(handL.getWorldPosition(new THREE.Vector3())).applyQuaternion(hands.quaternion).normalize()
        const want = new THREE.Vector3(0, -0.85, 0.53).normalize()
        const a = elbowDir.sub(targetDir.clone().multiplyScalar(elbowDir.dot(targetDir))).normalize()
        const b = want.clone().sub(targetDir.clone().multiplyScalar(want.dot(targetDir))).normalize()
        const sign = Math.sign(a.cross(b).dot(targetDir)) || 1
        const angle = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)) * sign
        hands.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(targetDir, angle))
        hands.updateMatrixWorld(true)
      }
      // 平移：双手中点 → 目标中点
      const mid = handL.getWorldPosition(new THREE.Vector3()).add(handR.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5)
      hands.position.add(tL.clone().add(tR).multiplyScalar(0.5).sub(mid))
      // 手腕下压：内置模型静息姿势手指朝上（与前臂同轴），绕世界 -X 轴弯腕 ~137°
      // 手指从"前伸"转为"下扣"在枪身上（旋转手骨，手掌位置不变，蒙皮随动）
      const bendWrist = (hand, angle) => {
        if (!hand) return
        hands.updateMatrixWorld(true)
        const dW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(-1, 0, 0), angle)
        const parentQ = hand.parent.getWorldQuaternion(new THREE.Quaternion())
        hand.quaternion.premultiply(parentQ.clone().invert().multiply(dW).multiply(parentQ))
      }
      bendWrist(handL, -2.4)
      bendWrist(handR, -2.4)
      hands.updateMatrixWorld(true)
    }
    hands.traverse(o => { if (o.isMesh) o.frustumCulled = false }) // 蒙皮包围盒不随骨骼更新
    if (this.customHands && this.customHands !== hands) this.vmHolder.remove(this.customHands) // 替换旧手臂
    this.customHands = hands
    this.vmHolder.add(hands)
    if (this.customArms) this.customArms.visible = false
    this.weaponMeshFor(this.currentVmId)
  }

  // 用户自有 GLB 枪模（public/models/viewmodel.glb）：加载成功后替换所有武器外观
  setCustomViewmodel(scene) {
    scene.userData.muzzle ??= new THREE.Vector3(0, 0, -0.45)
    scene.userData.pos ??= new THREE.Vector3(0.15, -0.13, -0.5) // 整枪前移：枪托不怼到相机
    scene.userData.scale ??= 1
    scene.position.copy(scene.userData.pos) // 应用持枪位置（内部模型已归一化居中）
    // 自有枪模手臂：挂 holder（保证 -Z 朝枪口的坐标系），按模型包围盒中心对齐持握姿势
    if (!this.customArms) {
      this.customArms = this._buildArms('custom')
      this.vmHolder.add(this.customArms)
    }
    const center = new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3())
    this.customArms.position.copy(center)
    this.customVm = scene
    this.vmHolder.add(scene)
    this.weaponMeshFor(this.currentVmId)
  }

  // ---- 弹匣/切枪/换弹 ----
  _st(id) {
    const w = CONFIG.weapons[id]
    if (!this.state[id]) this.state[id] = { mag: w.magSize, reserve: w.reserve ?? Infinity }
    return this.state[id]
  }

  switchTo(id, instant = false) {
    if (id === this.currentId && !instant) return
    this.currentId = id
    this.reloadEnd = 0
    this.burstLeft = 0
    this.equipUntil = this.now + CONFIG.weapons[id].equipTime * (instant ? 0 : 1)
    this.sprayIndex = 0
    if (!this._knife) this._buildKnife()
    this.weaponMeshFor(id)
    this.onAmmoChange?.(this)
  }

  startReload() {
    const w = this.weapon, st = this._st(this.currentId)
    if (w.slot === 'melee' || st.mag >= w.magSize || st.reserve <= 0) return
    if (this.reloadEnd > this.now) return
    this.reloadEnd = this.now + w.reloadTime
    this.audio.reload()
  }

  // ---- 散布（度）----
  currentSpread() {
    const w = this.weapon
    if (w.slot === 'melee') return 0
    const M = CONFIG.movement
    const s = w.spread
    const speedRatio = Math.min(1, this.player.moveSpeed / (M.runSpeed * (w.moveSpeedMult ?? 1)))
    let sp = THREE.MathUtils.lerp(s.stand, s.run, Math.pow(speedRatio, 1.4))
    if (this.player.crouchAmt > 0.5) sp *= s.crouchMult
    if (!this.player.grounded) sp = s.jump
    // 连射追加散布（小值，主要偏差由弹道表决定）
    sp += Math.min(this.sprayIndex * 0.05, 0.8)
    return sp
  }

  // ---- 开火 ----
  tryFire(triggerEdge, triggerHeld, altEdge) {
    const w = this.weapon
    if (this.now < this.equipUntil || this.reloadEnd > this.now) return

    if (w.slot === 'melee') {
      if (triggerEdge && this.now >= this.nextShotAt) {
        this.nextShotAt = this.now + 1 / w.fireRate
        this._meleeSwing()
      }
      return
    }

    // Classic 右键三连发
    if (w.burst && altEdge && this.now >= this.nextShotAt) {
      const st = this._st(this.currentId)
      if (st.mag > 0) { this.burstLeft = Math.min(3, st.mag); this.nextShotAt = this.now }
    }

    const wantFire = w.auto ? triggerHeld : triggerEdge || this.burstLeft > 0
    if (!wantFire) return
    if (this.now < this.nextShotAt) return

    const st = this._st(this.currentId)
    if (st.mag <= 0) {
      if (triggerEdge) { this.audio.empty(); this.startReload() }
      return
    }
    if (this.burstLeft > 0) this.burstLeft--

    this._fireOne()
    this.nextShotAt = Math.max(this.nextShotAt + 1 / w.fireRate, this.now)
    if (st.mag === 0 && !w.auto) this.startReload()
  }

  _fireOne() {
    const w = this.weapon
    const st = this._st(this.currentId)
    st.mag--
    this.onShotFired?.()

    // 弹道表（累计偏移）+ 散布锥
    const pattern = this.pattern ??= makeSprayPattern(30)
    const pi = Math.min(this.sprayIndex, pattern.length - 1)
    const pat = pattern[pi]
    this.sprayIndex++

    const spreadDeg = this.currentSpread()
    const p = this.player
    _dir.set(0, 0, -1).applyEuler(_euler.set(p.pitch, p.yaw, 0))
    // 弹道偏移
    _right.set(1, 0, 0).applyEuler(_euler)
    _dir.applyAxisAngle(UP, THREE.MathUtils.degToRad(pat.y))
    _dir.applyAxisAngle(_right, THREE.MathUtils.degToRad(pat.p))
    // 随机散布（圆盘均匀 → 锥面）
    if (spreadDeg > 0) {
      const r = Math.sqrt(Math.random()) * spreadDeg
      const az = Math.random() * Math.PI * 2
      const rx = _rx.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw))
      _dir.applyAxisAngle(rx, THREE.MathUtils.degToRad(r * Math.cos(az)))
      _dir.applyAxisAngle(UP, THREE.MathUtils.degToRad(r * Math.sin(az)))
    }

    // 视觉上踢（不影响弹道，弹道由表驱动 —— 与游戏一致）
    p.addPunch(THREE.MathUtils.degToRad(pat.p) * w.recoil.viewPunch * 0.25 + 0.002, THREE.MathUtils.degToRad(pat.y) * w.recoil.viewPunch * 0.12)

    // 命中判定：世界 vs 机器人取最近
    const eye = this.camera.position
    const maxDist = 250
    const wallHit = this.world.raycast(eye.x, eye.y, eye.z, _dir.x, _dir.y, _dir.z, maxDist)
    const botHit = this.bots.pickHit(eye, _dir, wallHit ? wallHit.t : maxDist)

    // 枪口焰（含动态点光）+ 抛壳 + 曳光
    _muzzle.copy(this.muzzleOffset)
    this.vmHolder.localToWorld(_muzzle)
    this.fx.muzzle(_muzzle)
    const vm = this.customVm ?? this.viewmodels[this.currentVmId]
    if (vm.userData.eject) {
      _eject.copy(vm.userData.eject)
      this.vmHolder.localToWorld(_eject)
      this.fx.shell(_eject)
    }
    const end = _hitP.copy(_dir)
    if (botHit) end.multiplyScalar(botHit.t).add(eye)
    else if (wallHit) end.set(wallHit.x, wallHit.y, wallHit.z)
    else end.multiplyScalar(maxDist).add(eye)
    this.fx.tracer(_muzzle, end)

    // 声音
    this.audio.shot(w.sound, null, { pos: eye, yaw: p.yaw })

    if (botHit) {
      const dmg = this._damageFor(botHit.bot, botHit.zone, botHit.t)
      const killed = this.bots.damage(botHit.bot, dmg, botHit.zone)
      this.onHitBot?.(botHit.bot, botHit.zone, dmg, killed, botHit.point)
    } else if (wallHit) {
      this.fx.decal(wallHit.x, wallHit.y, wallHit.z, wallHit.nx, wallHit.ny, wallHit.nz)
      this.fx.impact(wallHit.x, wallHit.y, wallHit.z, wallHit.nx, wallHit.ny, wallHit.nz)
    }

    // 持枪模型后坐
    this.vmKick = Math.min(this.vmKick + 0.035, 0.08)
    this.lastFireTime = this.now
    this.onAmmoChange?.(this)
  }

  _meleeSwing() {
    const w = this.weapon
    this.audio.shot(w.sound, null, { pos: this.camera.position, yaw: this.player.yaw })
    this.vmKick = 0.09
    const eye = this.camera.position
    const hit = this.bots.pickHit(eye, _dir.set(0, 0, -1).applyEuler(_euler.set(this.player.pitch, this.player.yaw, 0)), w.range)
    if (hit) {
      const killed = this.bots.damage(hit.bot, w.damage.body, 'body')
      this.onHitBot?.(hit.bot, 'body', w.damage.body, killed, hit.point)
    }
  }

  _damageFor(bot, zone, dist) {
    const w = this.weapon
    const base = w.damage[zone] ?? w.damage.body
    if (!w.falloff) return base
    for (const tier of w.falloff) {
      if (dist <= tier.maxDist) return tier.damage[zone] ?? tier.damage.body
    }
    return base
  }

  // ---- 固定步长更新 ----
  step(dt, input) {
    this.now += dt
    // 鼠标边沿由渲染帧 queueEdges 喂入，这里消费
    const edges = this.pendingEdges ?? (this.pendingEdges = { fireEdge: false, altEdge: false })
    this.tryFire(edges.fireEdge, input.mouse0, edges.altEdge)
    edges.fireEdge = edges.altEdge = false

    // 换弹完成
    if (this.reloadEnd > 0 && this.now >= this.reloadEnd) {
      const w = this.weapon, st = this._st(this.currentId)
      const need = w.magSize - st.mag
      const take = Math.min(need, st.reserve)
      st.mag += take
      if (st.reserve !== Infinity) st.reserve -= take
      this.reloadEnd = 0
      this.sprayIndex = 0
      this.onAmmoChange?.(this)
    }
    // 停火重置弹道（刀无后坐力参数）
    const rec = this.weapon.recoil
    if (!rec || this.now - this.lastFireTime > rec.recoverTime) this.sprayIndex = 0
  }

  queueEdges(fireEdge, altEdge) {
    const edges = this.pendingEdges ?? (this.pendingEdges = { fireEdge: false, altEdge: false })
    if (fireEdge) edges.fireEdge = true
    if (altEdge) edges.altEdge = true
  }

  // ---- 渲染帧：持枪模型摆动 ----
  // 基础持枪姿势对齐 Valorant：枪在右下、贴近相机，枪身向内偏转使枪口朝准星汇聚
  static vmBaseYaw = 0.18     // 向内偏航（枪口指向屏幕中心）
  static vmBaseRoll = -0.06   // 轻微侧倾（露出枪顶）

  updateViewmodel(dt, mouseDx, mouseDy) {
    const p = this.player
    this.vmKick = Math.max(0, this.vmKick - dt * 0.5)
    // 视角摆动（惯性延迟）
    this.swayX += (-mouseDx * 0.00012 - this.swayX) * Math.min(1, dt * 12)
    this.swayY += (-mouseDy * 0.00012 - this.swayY) * Math.min(1, dt * 12)
    // 移动起伏
    const speedRatio = Math.min(1, p.moveSpeed / CONFIG.movement.runSpeed)
    this.bobT += dt * (6 + speedRatio * 6)
    const bob = p.grounded ? Math.sin(this.bobT) * 0.006 * speedRatio : 0
    const bobX = p.grounded ? Math.cos(this.bobT * 0.5) * 0.004 * speedRatio : 0
    // 换弹/切枪动作下沉
    const reloading = this.reloadEnd > this.now
    const equipping = this.now < this.equipUntil
    const lower = reloading ? 0.1 : equipping ? 0.14 : 0
    const crouchDrop = p.crouchAmt * 0.02
    this.vmHolder.position.set(
      this.vmBase.x + this.swayX + bobX,
      this.vmBase.y + this.swayY + bob - lower - crouchDrop,
      this.vmBase.z + this.vmKick,
    )
    this.vmHolder.rotation.set(
      this.vmKick * 2.2 + this.swayY * 2 + 0.04,
      WeaponSystem.vmBaseYaw + this.swayX * 2,
      WeaponSystem.vmBaseRoll + (reloading ? 0.3 : 0),
    )
  }
}

const UP = new THREE.Vector3(0, 1, 0)
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _rx = new THREE.Vector3()
