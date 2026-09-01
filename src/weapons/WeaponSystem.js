import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
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
  constructor({ camera, vmCamera, world, bots, fx, audio, player }) {
    this.camera = camera; this.vmCamera = vmCamera; this.world = world; this.bots = bots
    this.vmScene = vmCamera?.parent // 级联刷新矩阵用（vmCamera 固定挂 vmScene 下）
    this.fx = fx; this.audio = audio; this.player = player

    // 当前武器与副武器（菜单可改）
    this.primaryId = 'vandal'
    this.secondaryId = 'classic'
    this.currentId = 'vandal'
    this.baseVmScale = 0.43 // 视角模型基础缩放（独立窄 FOV pass 下的占屏比例）
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
    this.onDryRefill = null // 备弹耗尽自动补给时通知（HUD 提示）
    this.drySince = 0       // 当前武器彻底打空的时刻（自动补给倒计时）

    this._buildViewmodel()
    this.switchTo(this.currentId, true)
  }

  get weapon() { return CONFIG.weapons[this.currentId] }

  // 持枪模型本地点 → 世界坐标：vmCamera 固定原点无旋转，其世界系 == 主相机本地系，
  // 故 holder.localToWorld 得到相机本地坐标，再过主相机矩阵落进世界（FX 都在世界场景）
  _vmToWorld(v) {
    this.vmCamera.updateMatrixWorld(true)
    this.vmHolder.localToWorld(v)
    this.camera.updateMatrixWorld()
    this.camera.localToWorld(v)
    return v
  }

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
      gold: new THREE.MeshStandardMaterial({ color: 0xe0b53c, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, normalMap: metalMaps.normalMap, roughness: 0.3, metalness: 0.9, emissive: 0x332200 }),
      dot: new THREE.MeshStandardMaterial({ color: 0x7dff9a, emissive: 0x2fbf62, emissiveIntensity: 2.2, roughness: 0.4 }),
    }
    // 第一人称手臂材质：袖臂 = 战术布料织纹；手套 = 聚合物橘皮纹（法线加重出近景微凹凸）
    const fabricMaps = Tex.fabric()
    this.armMats = {
      sleeve: new THREE.MeshStandardMaterial({ color: 0x8d949c, map: fabricMaps.map, roughnessMap: fabricMaps.roughnessMap, normalMap: fabricMaps.normalMap, roughness: 0.93, metalness: 0 }),
      glove: (() => {
        const m = new THREE.MeshStandardMaterial({ color: 0xa8aeb5, map: polyMaps.map, roughnessMap: polyMaps.roughnessMap, normalMap: polyMaps.normalMap, roughness: 0.85, metalness: 0.05 })
        m.normalScale = new THREE.Vector2(1.3, 1.3) // 近景微凹凸加重
        return m
      })(),
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
    // 持枪取景（对齐 Valorant）：枪在右下、贴近相机、枪身内偏使枪口汇聚准星。
    // 独立窄 FOV(55°) pass 下透视压缩小，稍拉远拉开层次；肘部/枪托出画的裁切
    // 由该位置 + 手臂长度共同决定
    holder.position.set(0.18, -0.14, -0.32)
    holder.scale.setScalar(this.baseVmScale)
    this.vmCamera.add(holder)
    this.vmHolder = holder
    this.vmBase = holder.position.clone()
    this.vmKick = 0
    this.swayX = 0; this.swayY = 0; this.bobT = 0
    this.strafeRoll = 0 // 侧移侧倾（平滑趋近目标）
    this.vmBolt = 0   // 机件后坐相位 0..1（枪机/套筒，击发置 1 快速回位）
    this.vmSwing = 0  // 挥刀相位 0..1（sin 包络弧线）
    this.idleT = 0    // 呼吸微摆计时
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
    // 弹匣（独立组 + 克隆材质：换弹时下落/回插/淡出，不影响其它深色件）
    const mag = new THREE.Group()
    const magMat = M.dark.clone()
    magMat.transparent = true
    const magSeg = (y, z, rx) => box(mag, magMat, 0.034, 0.052, 0.05, 0, y, z, rx) // 四段弧形弹匣
    magSeg(-0.058, -0.025, 0.08)
    magSeg(-0.104, -0.008, 0.24)
    magSeg(-0.146, 0.018, 0.42)
    magSeg(-0.182, 0.052, 0.6)
    g.add(mag)
    g.userData.mag = mag
    g.userData.magMats = [magMat]
    box(g, M.dark, 0.028, 0.005, 0.06, 0, -0.035, 0.03)             // 扳机护圈
    box(g, M.dark, 0.006, 0.018, 0.008, 0, -0.028, 0.018)           // 扳机
    box(g, M.wood, 0.034, 0.085, 0.045, 0, -0.06, 0.085, 0.3)       // 握把
    box(g, M.wood, 0.038, 0.05, 0.2, 0, -0.002, 0.26, -0.06)        // 枪托
    box(g, M.dark, 0.04, 0.06, 0.02, 0, -0.012, 0.36)               // 托底板
    // 枪机组件（击发后坐回位）：拉机柄 + 右侧导轨盖，沿 +z 后坐
    const bolt = new THREE.Group()
    cyl(bolt, M.dark, 0.006, 0.03, 0.034, 0.01, -0.06, 8)           // 拉机柄
    box(bolt, M.dark, 0.009, 0.018, 0.1, 0.0285, 0.012, -0.05)      // 枪机导轨盖
    g.add(bolt)
    bolt.userData.travel = 0.03
    g.userData.bolt = bolt
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
    // 弹匣（独立组 + 克隆材质，换弹动画用）
    const mag = new THREE.Group()
    const magMat = M.poly.clone()
    magMat.transparent = true
    box(mag, magMat, 0.032, 0.11, 0.05, 0, -0.075, -0.02, 0.08)     // 直弹匣
    g.add(mag)
    g.userData.mag = mag
    g.userData.magMats = [magMat]
    // 枪机组件：后置拉机柄，击发后坐
    const bolt = new THREE.Group()
    box(bolt, M.dark, 0.022, 0.012, 0.032, -0.02, 0.046, 0.075)     // 拉机柄（左后上）
    g.add(bolt)
    bolt.userData.travel = 0.02
    g.userData.bolt = bolt
    box(g, M.poly, 0.034, 0.08, 0.045, 0, -0.055, 0.08, 0.25)       // 握把
    box(g, M.poly, 0.036, 0.055, 0.14, 0, -0.005, 0.19)             // 枪托
    box(g, M.poly, 0.04, 0.07, 0.03, 0, -0.012, 0.27)               // 托腮板
    box(g, M.dark, 0.024, 0.005, 0.055, 0, -0.032, 0.02)            // 护圈
    box(g, M.dark, 0.006, 0.022, 0.05, 0.0235, 0.01, -0.02)         // 抛壳口
    this._orientVm(g, { muzzle: new THREE.Vector3(0, 0.012, -0.64), eject: new THREE.Vector3(0.032, 0.015, -0.02) })
    return g
  }

  // 重左轮（Sheriff 定位）：转轮 + 六角枪管 + 木质握把
  // 击发时转轮分度 60°、击锤前倒再待击（见 _updateVmParts/_indexCylinder）
  _buildRevolver() {
    const g = new THREE.Group()
    const { M, box, cyl } = this._vmHelpers()
    box(g, M.steel, 0.032, 0.05, 0.15, 0, 0.005, -0.02)             // 枪身框架
    // 转轮（pivot 旋转 = 分度；弹巢槽随之转动可见）
    const cylPivot = new THREE.Group()
    cylPivot.position.set(0, -0.002, -0.06)
    cyl(cylPivot, M.steel, 0.027, 0.05, 0, 0, 0)                    // 转轮体
    cyl(cylPivot, M.dark, 0.006, 0.052, 0, 0, 0, 6)                 // 中心栓
    for (let i = 0; i < 6; i++) {                                   // 六个弹巢暗槽
      const a = i * Math.PI / 3
      box(cylPivot, M.dark, 0.0085, 0.0085, 0.05, Math.cos(a) * 0.017, Math.sin(a) * 0.017, 0)
    }
    g.add(cylPivot)
    g.userData.cylPivot = cylPivot
    cyl(g, M.steel, 0.013, 0.17, 0, 0.014, -0.16, 6)                // 六角枪管
    box(g, M.dark, 0.012, 0.014, 0.16, 0, 0.033, -0.15)             // 准星肋
    box(g, M.gold, 0.005, 0.018, 0.008, 0, 0.05, -0.225)            // 前准星
    // 击锤（几何上移使 pivot 在根部，rotation.x 前倒/待击）
    const hammerGeo = new THREE.BoxGeometry(0.01, 0.03, 0.024)
    hammerGeo.translate(0, 0.015, 0)
    const hammer = new THREE.Mesh(hammerGeo, M.dark)
    hammer.position.set(0, 0.026, 0.056)
    g.add(hammer)
    g.userData.hammer = hammer
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
  // 套筒（含准星/防滑纹）为独立组：击发后坐回位；弹匣底板换弹时下落/回插
  _buildPistol(suppressed) {
    const g = new THREE.Group()
    const { M, box, cyl } = this._vmHelpers()
    const slide = suppressed ? M.steel : M.silver
    const bolt = new THREE.Group()
    box(bolt, slide, 0.028, 0.038, 0.17, 0, 0.02, -0.06)             // 套筒
    box(bolt, M.dark, 0.006, 0.008, 0.01, 0, 0.045, -0.135)         // 前准星
    box(bolt, M.dark, 0.022, 0.008, 0.012, 0, 0.046, 0.015)         // 后照门
    for (let i = 0; i < 3; i++) box(bolt, M.dark, 0.03, 0.026, 0.0035, 0, 0.02, 0.0 + i * 0.009) // 套筒后部防滑纹
    if (suppressed) box(bolt, M.dark, 0.007, 0.012, 0.03, 0.0145, 0.024, -0.03) // 抛壳窗
    g.add(bolt)
    bolt.userData.travel = 0.017
    g.userData.bolt = bolt
    box(g, M.poly, 0.026, 0.03, 0.15, 0, -0.008, -0.04)             // 下机匣
    box(g, M.poly, 0.03, 0.082, 0.044, 0, -0.05, 0.04, 0.28)        // 握把
    const mag = new THREE.Group()
    const magMat = M.dark.clone()
    magMat.transparent = true
    box(mag, magMat, 0.027, 0.016, 0.038, 0, -0.094, 0.052, 0.28)   // 弹匣底板（握把底微露）
    g.add(mag)
    g.userData.mag = mag
    g.userData.magMats = [magMat]
    box(g, M.dark, 0.022, 0.005, 0.05, 0, -0.026, -0.015)           // 护圈
    box(g, M.dark, 0.005, 0.014, 0.007, 0, -0.018, -0.02)           // 扳机
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
    const metalMaps = Tex.metal()
    const polyMaps = Tex.polymer()
    const steel = new THREE.MeshStandardMaterial({ color: 0xdfe4ea, map: metalMaps.map, roughnessMap: metalMaps.roughnessMap, normalMap: metalMaps.normalMap, roughness: 0.26, metalness: 0.94 })
    const gripM = new THREE.MeshStandardMaterial({ color: 0x31353c, map: polyMaps.map, roughnessMap: polyMaps.roughnessMap, normalMap: polyMaps.normalMap, roughness: 0.85, metalness: 0.05 })
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

    // ---- 第一人称持枪手臂（静态姿势）：袖臂圆柱 + 解剖学手部，全部合并成 2 个网格 ----
    // 坐标为各武器本地系（-Z 朝前），随武器继承持枪位置/缩放/后坐摆动，不做独立动画
    // 手臂比例按 FPS 惯例明显缩短（约解剖学 60%）：只保留小臂+手，上臂残段
    // 加粗压低 —— 肘部贴画面底边出画，避免"手臂过长穿帮"与近裁剪问题
    // 手部结构：三球掌型（掌跟/掌中/指根脊）+ 三节分段手指（指节球+扣握弧+微扁指尖）
    //           + 三段拇指 + 指节护甲板 + 护腕束带 —— 全部合并，零 draw call 增量
    _buildArms(kind) {
    const sleeve = [], glove = []
    const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3()
    const UP = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3()
    const ball = (bk, x, y, z, r, sx = 1, sy = 1, sz = 1, seg = 12) => {
      _m4.compose(_p.set(x, y, z), _q.identity(), _s.set(sx, sy, sz))
      bk.push(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.75)).applyMatrix4(_m4))
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
    const boxAt = (bk, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
      _q.setFromEuler(new THREE.Euler(rx, ry, rz))
      _m4.compose(_p.set(x, y, z), _q, _s.set(1, 1, 1))
      bk.push(new THREE.BoxGeometry(w, h, d).applyMatrix4(_m4))
    }
    // 三节扣握手指：沿 S→E 三段递进弓起（bow>0 向下扣、<0 向上翻）。
    // 关键：管段末端明显收细 + 指节球放大 → 关节处有肉眼可见的鼓包折角
    const curlFinger = (bk, S, E, rBase = 0.0104, bow = [0, 0.006, 0.014, 0.02]) => {
      const ts = [0, 0.36, 0.7, 1]
      const pts = ts.map((t, i) => [
        S[0] + (E[0] - S[0]) * t,
        S[1] + (E[1] - S[1]) * t - bow[i],
        S[2] + (E[2] - S[2]) * t,
      ])
      tube(bk, ...pts[0], ...pts[1], rBase * 0.9, rBase * 0.66)                       // 近节（粗→细）
      ball(bk, ...pts[1], rBase * 0.97)                                                // 指节球（凸出管端 ~45%）
      tube(bk, ...pts[1], ...pts[2], rBase * 0.78, rBase * 0.56)                      // 中节
      ball(bk, ...pts[2], rBase * 0.8)                                                 // 中节球
      tube(bk, ...pts[2], ...pts[3], rBase * 0.7, rBase * 0.48)                       // 远节（最细）
      ball(bk, pts[3][0], pts[3][1] - 0.001, pts[3][2], rBase * 0.62, 1, 0.92, 1.2)  // 指尖（微扁圆）
    }
    // 三段拇指：粗短腕掌根 → 渐细指尖，与四指形成明显粗细对比
    const thumb3 = (bk, base, mid, tip) => {
      ball(bk, ...base, 0.0142)                          // 腕掌关节（粗）
      tube(bk, ...base, ...mid, 0.012, 0.0094)
      ball(bk, ...mid, 0.0112)                           // 拇指掌指球
      tube(bk, ...mid, ...tip, 0.0102, 0.007)
      ball(bk, tip[0], tip[1] + 0.001, tip[2], 0.0078, 1, 0.85, 1.35)
    }
    // 三球掌型：掌跟（近腕收窄）+ 掌中（最饱满）+ 指根脊（横向展开）叠出体积过渡
    const palm3 = (bk, heel, mid, ridge) => {
      ball(bk, ...heel, 16)
      ball(bk, ...mid, 16)
      ball(bk, ...ridge, 14)
    }
    // 指节护甲板：横跨指根列的微倾厚板（战术手套样式，凸出轮廓 ~2mm 读得出体积）
    const knucklePlate = (bk, x, y, z, span, rx) => boxAt(bk, 0.014, 0.016, span, x, y, z, rx)
    // 护腕束带：腕口一段加粗环（手套色，与袖料形成层次；合并进现有桶 → 零 draw call）
    const cuff = (bk, A, B, t0, t1, r) => tube(bk,
      A[0] + (B[0] - A[0]) * t0, A[1] + (B[1] - A[1]) * t0, A[2] + (B[2] - A[2]) * t0,
      A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1, A[2] + (B[2] - A[2]) * t1, r)
    // 右臂（握把）：三球掌 + 指节护甲 + 四指三节扣握 + 三段拇指 + 小臂/上臂探出画面右下（fingerZ 为绝对 Z 坐标）
    const rightArm = (gx, gy, gz, gripW, fingerZ, thumbZ) => {
      palm3(glove,
        [gx + 0.033, gy - 0.03, gz + 0.05, 0.030, 0.8, 1.02, 0.85],     // 掌跟
        [gx + 0.030, gy - 0.012, gz + 0.018, 0.036, 0.88, 1.18, 1.12],  // 掌中
        [gx + 0.026, gy + 0.008, gz - 0.006, 0.030, 1.14, 0.6, 1.38],   // 指根脊
      )
      const zMid = (fingerZ[0] + fingerZ[fingerZ.length - 1]) / 2
      knucklePlate(glove, gx + gripW + 0.006, gy + 0.026, zMid,
        Math.abs(fingerZ[fingerZ.length - 1] - fingerZ[0]) + 0.024, 0.22)
      for (const fz of fingerZ) curlFinger(glove, [gx + gripW, gy + 0.017, fz], [gx - gripW, gy - 0.004, fz - 0.006])
      thumb3(glove,
        [gx + 0.034, gy + 0.026, thumbZ + 0.014],
        [gx + 0.038, gy + 0.04, thumbZ - 0.004],
        [gx + 0.034, gy + 0.049, thumbZ - 0.022],
      )
      ball(sleeve, gx + 0.052, gy - 0.045, gz + 0.06, 0.036)                          // 腕
      tube(sleeve, gx + 0.056, gy - 0.05, gz + 0.07, gx + 0.10, gy - 0.125, gz + 0.185, 0.043, 0.054) // 小臂（短，肘端加粗）
      tube(sleeve, gx + 0.10, gy - 0.125, gz + 0.185, gx + 0.155, gy - 0.245, gz + 0.27, 0.054, 0.062) // 上臂残段（出画）
      cuff(glove, [gx + 0.056, gy - 0.05, gz + 0.07], [gx + 0.10, gy - 0.125, gz + 0.185], 0.04, 0.17, 0.0465)
    }
    // 左臂（护木/握把下）：三球掌（宽扁托底）+ 四指三节上翻扣顶 + 三段拇指 + 小臂/上臂探出画面左下
    const leftArm = (gx, gy, gz, gripW, fingerZ) => {
      palm3(glove,
        [gx - 0.006, gy - 0.034, gz + 0.056, 0.030, 0.9, 0.95, 0.9],    // 掌跟
        [gx - 0.004, gy - 0.018, gz + 0.008, 0.038, 1.22, 0.88, 1.3],   // 掌中（宽扁）
        [gx - 0.002, gy + 0.002, gz - 0.018, 0.031, 1.3, 0.55, 1.45],   // 指根脊
      )
      const zMid = (fingerZ[0] + fingerZ[fingerZ.length - 1]) / 2
      knucklePlate(glove, gx - gripW - 0.003, gy + 0.03, zMid,
        Math.abs(fingerZ[fingerZ.length - 1] - fingerZ[0]) + 0.024, -0.16)
      for (const fz of fingerZ) curlFinger(glove, [gx - gripW, gy + 0.014, fz], [gx + gripW - 0.004, gy + 0.032, fz + 0.005], 0.0098, [0, -0.004, -0.01, -0.003])
      thumb3(glove,
        [gx + gripW - 0.004, gy + 0.002, gz - 0.052],
        [gx + gripW + 0.002, gy + 0.008, gz - 0.03],
        [gx + gripW + 0.006, gy + 0.014, gz - 0.008],
      )
      ball(sleeve, gx - 0.052, gy - 0.055, gz + 0.11, 0.035)                          // 腕
      tube(sleeve, gx - 0.056, gy - 0.06, gz + 0.12, gx - 0.105, gy - 0.15, gz + 0.235, 0.043, 0.054) // 小臂（短）
      tube(sleeve, gx - 0.105, gy - 0.15, gz + 0.235, gx - 0.165, gy - 0.27, gz + 0.30, 0.054, 0.062) // 上臂残段（出画）
      cuff(glove, [gx - 0.056, gy - 0.06, gz + 0.12], [gx - 0.105, gy - 0.15, gz + 0.235], 0.04, 0.17, 0.0465)
    }

    if (kind === 'rifle') {
      rightArm(-0.068, -0.068, 0.086, 0.04, [0.064, 0.086, 0.108], 0.106)             // 右手握木握把（掌贴近侧面）
      leftArm(-0.036, -0.032, -0.31, 0.028, [-0.26, -0.3, -0.34, -0.37])              // 左手托下护木
    } else if (kind === 'pistol') {
      // 右手（主力握把）：三球掌 + 指节护甲 + 三指扣握 + 拇指贴机匣侧
      palm3(glove,
        [-0.032, -0.08, 0.076, 0.029, 0.8, 1.0, 0.85],
        [-0.03, -0.058, 0.05, 0.035, 0.82, 1.16, 1.25],
        [-0.028, -0.04, 0.026, 0.03, 1.06, 0.6, 1.3],
      )
      knucklePlate(glove, 0.038, -0.018, 0.048, 0.064, 0.25)
      for (const dz of [0.028, 0.048, 0.068]) curlFinger(glove, [0.034, -0.026, dz], [-0.028, -0.046, dz], 0.0098)
      thumb3(glove, [-0.03, -0.032, 0.06], [-0.028, -0.024, 0.028], [-0.026, -0.022, -0.004])
      // 左手（托底支撑）：三球掌 + 三指扣压右手 + 拇指压掌背
      palm3(glove,
        [-0.056, -0.09, 0.062, 0.028, 0.8, 0.95, 0.85],
        [-0.052, -0.066, 0.038, 0.033, 0.8, 1.1, 1.15],
        [-0.048, -0.046, 0.018, 0.028, 1.1, 0.55, 1.25],
      )
      for (const dz of [0.03, 0.05, 0.07]) curlFinger(glove, [-0.054, -0.044, dz], [0.026, -0.056, dz], 0.0092, [0, 0.003, 0.008, 0.012])
      thumb3(glove, [-0.06, -0.052, 0.024], [-0.052, -0.038, 0.006], [-0.044, -0.03, -0.008])
      ball(sleeve, 0.048, -0.092, 0.1, 0.036)
      tube(sleeve, 0.052, -0.096, 0.11, 0.10, -0.19, 0.235, 0.043, 0.054)
      tube(sleeve, 0.10, -0.19, 0.235, 0.155, -0.30, 0.33, 0.054, 0.062)
      cuff(glove, [0.052, -0.096, 0.11], [0.10, -0.19, 0.235], 0.04, 0.17, 0.0465)
      ball(sleeve, -0.05, -0.098, 0.085, 0.035)
      tube(sleeve, -0.054, -0.102, 0.095, -0.10, -0.19, 0.225, 0.042, 0.053)
      tube(sleeve, -0.10, -0.19, 0.225, -0.155, -0.29, 0.31, 0.053, 0.061)
      cuff(glove, [-0.054, -0.102, 0.095], [-0.10, -0.19, 0.225], 0.04, 0.17, 0.0445)
    } else if (kind === 'knife') {
      // 反握刀柄：三球掌 + 指节护甲 + 三指扣柄 + 拇指压柄脊
      palm3(glove,
        [-0.028, -0.05, 0.085, 0.029, 0.8, 1.0, 0.9],
        [-0.026, -0.026, 0.055, 0.036, 0.85, 1.28, 1.45],
        [-0.024, -0.006, 0.03, 0.03, 1.0, 0.6, 1.5],
      )
      knucklePlate(glove, 0.028, 0.002, 0.06, 0.087, 0.3)
      for (const dz of [0.03, 0.06, 0.09]) curlFinger(glove, [0.024, 0.0, dz], [-0.022, -0.018, dz], 0.01)
      thumb3(glove, [-0.026, 0.0, 0.04], [-0.022, 0.01, 0.026], [-0.018, 0.016, 0.012])
      ball(sleeve, 0.042, -0.058, 0.12, 0.036)
      tube(sleeve, 0.046, -0.062, 0.13, 0.095, -0.175, 0.25, 0.043, 0.054)
      tube(sleeve, 0.095, -0.175, 0.25, 0.15, -0.28, 0.32, 0.054, 0.062)
      cuff(glove, [0.046, -0.062, 0.13], [0.095, -0.175, 0.25], 0.04, 0.17, 0.0465)
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
    // 自有 GLB 枪模只接管步枪（AK 造型配 Vandal/Phantom 定位）；
    // Sheriff/Classic/Ghost/Knife 用内置模型 —— 刀得像刀，左轮得像左轮
    const useCustom = !!this.customVm && (id === 'vandal' || id === 'phantom')
    for (const [vid, vm] of Object.entries(this.viewmodels)) vm.visible = !useCustom && vid === id
    if (this.customVm) this.customVm.visible = useCustom
    this.muzzleOffset.copy((useCustom ? this.customVm : this.viewmodels[id]).userData.muzzle)
    if (this.customArms) this.customArms.visible = useCustom && !this.customHands // 自有枪模手臂随其显隐
    if (this.customHands) this.customHands.visible = useCustom // GLB 手臂随步枪显隐
  }

  // ---- 高精度手套双手（public/models/glove.glb：单手 + Wrist/五指三关节骨骼）----
  // 实例化两份（SkeletonUtils.clone）→ 各自根节点落位（腕骨精确到握点 + 掌姿态
  // 对齐握持面）→ 五指链分别瞄向枪上特征点并逐节向掌心卷曲；袖管用程序化
  // 圆柱（布料贴图）自腕部探向画面下侧出画。相比 hands.glb 的低模三指合并
  // 手套，五指独立 + 高模细节显著更好；glove.glb 缺失/骨架不符时回退 hands.glb。
  setGloveHands(scene) {
    if (!this.customVm) return false
    // 绑定几何测量（原始场景孤立态：根单位变换）——先于任何挂载/缩放
    scene.quaternion.identity()
    scene.position.set(0, 0, 0)
    scene.scale.setScalar(1)
    scene.updateMatrixWorld(true)
    const byName = {}
    scene.traverse(o => { if (o.name) byName[o.name] = o })
    if (localStorage.getItem('vhtdbg')) console.log('[dbg] glove bones:', Object.keys(byName).join(','))
    const pickAny = (...res) => byName[Object.keys(byName).find(k => res.some(re => re.test(k)))]
    // GLTFLoader 名称清洗：空格→下划线、点删除（"Index Finger"→Index_Finger / "Lower.001"→Lower001）
    const wristB = pickAny(/^Wrist$/)
    const handB = pickAny(/^Hand$/)
    const F = {
      thumb: [pickAny(/^Thumb$/), pickAny(/^Lower$/), pickAny(/^Middle$/), pickAny(/^Top$/)],
      index: [pickAny(/^Index_?Finger$/), pickAny(/^Lower001$/), pickAny(/^Middle001$/), pickAny(/^Top001$/)],
      middle: [pickAny(/^Middle_?Finger$/), pickAny(/^Lower002$/), pickAny(/^Middle002$/), pickAny(/^Top002$/)],
      ring: [pickAny(/^Ring_?Finger$/), pickAny(/^Lower003$/), pickAny(/^Middle003$/), pickAny(/^Top003$/)],
      pinky: [pickAny(/^Pinky$/), pickAny(/^Lower004$/), pickAny(/^Middle004$/), pickAny(/^Top004$/)],
    }
    const needed = [wristB, handB, ...F.thumb, ...F.index, ...F.middle, ...F.ring, ...F.pinky]
    if (needed.some(b => !b)) {
      console.warn('[VHT] glove.glb 骨架不符合预期（缺少 Wrist/五指骨），已回退 hands.glb')
      return false
    }
    const bp = (o) => o.getWorldPosition(new THREE.Vector3())
    const fBind = bp(F.middle[3]).sub(bp(wristB)).normalize()      // 腕→中指尖 = 手指方向
    const sBind0 = bp(F.thumb[0]).sub(bp(handB)).normalize()       // 掌根→拇指根 = 拇指侧向
    const pBind = fBind.clone().cross(sBind0).normalize()          // 掌心法向
    const sBind = pBind.clone().cross(fBind).normalize()           // 正交化拇指侧向
    const handLenBind = bp(F.middle[3]).distanceTo(bp(wristB))     // 腕→中指尖实测长度
    const qBind = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fBind, sBind, pBind))

    // ---- 挂载组与矩阵工具（沿用 setCustomHands 的教训：先挂载、vmScene 根级联刷新）----
    if (this.customHands) this.vmHolder.remove(this.customHands)
    const group = new THREE.Group()
    this.customHands = group
    this.vmHolder.add(group)
    if (this.customArms) this.customArms.visible = false
    this.vmScene.updateMatrixWorld(true)
    const vmP = (x, y, z) => this.customVm.localToWorld(new THREE.Vector3(x, y, z))
    const wp = (o) => { this.vmScene.updateMatrixWorld(true); return o.getWorldPosition(new THREE.Vector3()) }
    const rotBone = (bone, q) => {
      this.vmScene.updateMatrixWorld(true)
      const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion())
      bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq))
      this.vmScene.updateMatrixWorld(true)
    }
    const aimChain = (ch, wristBone, aim, curls) => {
      const base = wp(ch[0])
      const cur = wp(ch[3]).sub(base).normalize()
      rotBone(ch[0], new THREE.Quaternion().setFromUnitVectors(cur, aim.clone().sub(base).normalize()))
      curls.forEach((deg, i) => {
        if (!deg) return
        const a = wp(ch[i])
        const dir = wp(ch[i + 1]).sub(a).normalize()
        const radial = a.clone().sub(wp(wristBone)).normalize()
        rotBone(ch[i], new THREE.Quaternion().setFromAxisAngle(dir.cross(radial).normalize(), THREE.MathUtils.degToRad(deg)))
      })
    }
    const holderScale = this.vmHolder.scale.x
    const handScale = 0.066 / handLenBind / holderScale // 腕→指尖 6.6cm（与枪缩放比例匹配）

    // 单手实例：腕骨精确落位 + 掌姿态 → 五指 IK
    const poseHand = (cfg) => {
      const root = cloneSkinned(scene)
      root.traverse(o => { if (o.isMesh) o.frustumCulled = false })
      group.add(root)
      root.quaternion.identity()
      root.scale.setScalar(handScale)
      root.position.set(0, 0, 0)
      // 掌姿态：绑定基 → 目标基（fDes 手指向 / sDes 拇指侧向），再换算到 holder 本地
      const fD = cfg.fDes.clone().normalize()
      const sD0 = cfg.sDes.clone().normalize()
      const pD = fD.clone().cross(sD0).normalize()
      const sD = pD.clone().cross(fD).normalize()
      const qDes = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fD, sD, pD)).multiply(qBind.clone().invert())
      const qHolder = this.vmHolder.getWorldQuaternion(new THREE.Quaternion())
      root.quaternion.copy(qHolder.clone().invert().multiply(qDes))
      this.vmScene.updateMatrixWorld(true)
      // 腕骨落位：t = (RS)⁻¹·(锚点 − pivot)（pivot = 本地零平移时的腕骨世界位）
      const bones = {}
      root.traverse(o => { if (o.isBone) bones[o.name] = o })
      const wristLocal = bones[wristB.name]
      const pivot = wp(wristLocal)
      const rsInv = this.vmHolder.matrixWorld.clone()
      rsInv.setPosition(0, 0, 0)
      rsInv.invert()
      root.position.copy(cfg.wrist.clone().sub(pivot).applyMatrix4(rsInv))
      this.vmScene.updateMatrixWorld(true)
      // 五指 IK（本实例的骨骼）
      const CH = {}
      for (const [k, ch] of Object.entries(F)) CH[k] = ch.map(b => bones[b.name])
      for (const [k, t] of Object.entries(cfg.fingers)) aimChain(CH[k], wristLocal, t.aim, t.curls)
      return { root, wristBone: wristLocal }
    }

    // ---- 右手：握把（掌压右侧面，四指绕前缘，食指沿扳机护圈，拇指搭后脊）----
    const handR = poseHand({
      wrist: vmP(0.055, -0.05, -0.01),
      fDes: new THREE.Vector3(-0.2, -0.5, -0.84),
      sDes: new THREE.Vector3(0.15, 0.6, -0.78),
      fingers: {
        pinky: { aim: vmP(0.03, -0.10, -0.09), curls: [55, 45, 30] },
        ring: { aim: vmP(0.028, -0.088, -0.105), curls: [50, 42, 30] },
        middle: { aim: vmP(0.028, -0.075, -0.115), curls: [46, 40, 28] },
        index: { aim: vmP(0.03, -0.05, -0.155), curls: [14, 20, 12] },
        thumb: { aim: vmP(0.05, -0.005, 0.045), curls: [18, 12, 0] },
      },
    })
    // ---- 左手：护木中段（弹匣侧后，掌托底面，四指卷握右侧面，拇指沿左侧前伸）----
    const handL = poseHand({
      wrist: vmP(-0.035, -0.215, -0.42),
      fDes: new THREE.Vector3(0.62, 0.5, -0.4),
      sDes: new THREE.Vector3(-0.3, 0.4, -0.85),
      fingers: {
        pinky: { aim: vmP(0.062, -0.105, -0.36), curls: [48, 40, 26] },
        ring: { aim: vmP(0.066, -0.10, -0.42), curls: [44, 38, 26] },
        middle: { aim: vmP(0.068, -0.095, -0.47), curls: [40, 36, 24] },
        index: { aim: vmP(0.066, -0.09, -0.52), curls: [36, 32, 22] },
        thumb: { aim: vmP(-0.06, -0.135, -0.5), curls: [10, 8, 0] },
      },
    })

    // ---- 程序化袖管：自腕部沿肘方向探出画面下侧（布料贴图，合并单网格）----
    const sleeveGeos = []
    const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3()
    const addTube = (A, B, r1, r2) => { // 相机系两点 → holder 本地圆柱
      const d = B.clone().sub(A)
      const len = d.length()
      const geo = new THREE.CylinderGeometry(r2, r1, len, 12)
      geo.translate(0, len / 2, 0)
      _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())
      _m4.compose(A, _q, _s.set(1, 1, 1))
      const toLocal = this.vmHolder.matrixWorld.clone().invert()
      geo.applyMatrix4(_m4).applyMatrix4(toLocal)
      sleeveGeos.push(geo)
    }
    const sleeveFor = (handBone, dir) => {
      const w = wp(handBone)
      const elbow = w.clone().addScaledVector(dir, 0.17)
      addTube(w, elbow, 0.028, 0.05)
      const cuffC = w.clone().addScaledVector(dir, 0.012)
      const cuff = new THREE.SphereGeometry(0.037, 14, 10)
      cuff.translate(cuffC.x, cuffC.y, cuffC.z)
      cuff.applyMatrix4(this.vmHolder.matrixWorld.clone().invert())
      sleeveGeos.push(cuff)
    }
    sleeveFor(handR.wristBone, new THREE.Vector3(0.42, -0.85, 0.3).normalize())
    sleeveFor(handL.wristBone, new THREE.Vector3(-0.42, -0.85, 0.3).normalize())
    group.add(new THREE.Mesh(mergeGeometries(sleeveGeos, false), this.armMats.sleeve))

    this.weaponMeshFor(this.currentVmId)
    return true
  }

  // 用户自有 GLB 手臂（public/models/hands.glb）→ IK 式持枪姿态
  // 成熟 FPS 做法（CS2 / Valorant / OW 通用）：
  //   1) 手臂明显短于解剖学比例 —— viewmodel 只保留小臂+手，肘/肩永远在画外，
  //      既避免"手臂过长穿帮"，也省去近裁剪面/穿模问题
  //   2) 握点从枪模几何自动推导（换 viewmodel.glb 无需重调姿态）
  //   3) 肩位 = 握点 + 肘方向 × 臂长：肘方向压低朝画面下侧 → 肘部尽快出画
  // 骨架适配（J-Toastie Rigged FPS Arms，绑定姿态=双臂前伸、指与前臂共线）：
  //   aimArm 整臂绕肩旋转（直链，腕到肩距离=臂长恒定）；orientHand 三点基定腕朝向；
  //   aimFinger 指链先瞄特征点再逐节向掌心卷曲。
  // 注意：hands 需为未经本方法处理过的新实例（loadUserAssets 每次返回新场景）。
  setCustomHands(hands) {
    if (!this.customVm) return false // 无自有枪模时握点无法推导，直接回退内置手臂
    hands.updateMatrixWorld(true)
    const byName = {}
    hands.traverse(o => { if (o.name) byName[o.name] = o })
    const pick = (re) => byName[Object.keys(byName).find(k => re.test(k))]
    const armR = { up: pick(/^UpperArmR/), hand: pick(/^HandR/) }
    const armL = { up: pick(/^UpperArmL$/), hand: pick(/^HandL$/) }
    const chain = (a, b, c) => [pick(a), pick(b), pick(c)]
    const F = {
      R: { // 点号已被 GLTFLoader 清理：Hand.R.001 → HandR001
        dbl: chain(/^DoubleFingersBeginning001/, /^DoubleFingersR/, /^DoubleFingersTipR/),
        idx: chain(/^IndexBeginningR/, /^IndexR/, /^IndexTipR/),
        thb: chain(/^ThumbBeginningR/, /^ThumbR/, /^ThumbTipR/),
      },
      L: {
        dbl: chain(/^DoubleFingersBeginning$/, /^DoubleFingersL$/, /^DoubleFingersTipL$/),
        idx: chain(/^IndexBeginningL$/, /^IndexL$/, /^IndexTipL$/),
        thb: chain(/^ThumbBeginningL$/, /^ThumbL$/, /^ThumbTipL$/),
      },
    }
    // 骨架防御：用户换用其它骨架的 hands.glb 时骨骼名对不上，后续 IK 取世界矩阵会抛
    // TypeError → 跳过贴合，回退内置程序化手臂
    const needed = [armR.up, armR.hand, armL.up, armL.hand,
      ...F.R.dbl, ...F.R.idx, ...F.R.thb, ...F.L.dbl, ...F.L.idx, ...F.L.thb]
    if (needed.some(b => !b)) {
      console.warn('[VHT] hands.glb 骨架不符合预期（缺少 UpperArm/Hand/指骨），已回退内置手臂')
      return false
    }
    const wp = (o) => { this.vmScene.updateMatrixWorld(true); return o.getWorldPosition(new THREE.Vector3()) }
    // 世界系旋转单根骨骼（保持父链不变）。矩阵从场景根级联刷新，保证 pq 与姿态始终同帧
    const worldRotate = (bone, q) => {
      this.vmScene.updateMatrixWorld(true)
      const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion())
      bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq))
      this.vmScene.updateMatrixWorld(true)
    }
    // 单指节向掌心卷曲：绕（指节方向 × 指根→腕方向）轴
    const curlJoint = (bone, handBone, angle) => {
      const a = wp(bone)
      const child = bone.children.find(c => c.isBone || c.name)
      const dir = wp(child).sub(a).normalize()
      const radial = a.clone().sub(wp(handBone)).normalize()
      worldRotate(bone, new THREE.Quaternion().setFromAxisAngle(dir.cross(radial).normalize(), angle))
    }
    const aimFinger = (ch, handBone, aim, curlDegs) => {
      const base = wp(ch[0])
      const cur = wp(ch[2]).sub(base).normalize()
      worldRotate(ch[0], new THREE.Quaternion().setFromUnitVectors(cur, aim.clone().sub(base).normalize()))
      curlDegs.forEach((deg, i) => { if (deg) curlJoint(ch[i], handBone, THREE.MathUtils.degToRad(deg)) })
    }
    // 手腕姿态：三点基（指/拇/掌）→ 目标基（掌心朝 pDes、指朝 fDes）
    const orientHand = (arm, fing, fDes, pDes) => {
      const Fd = wp(fing.idx[2]).sub(wp(arm.hand)).normalize()
      const Td = wp(fing.thb[2]).sub(wp(arm.hand)).normalize()
      const Pd = Fd.clone().cross(Td).normalize()
      const tDes = pDes.clone().cross(fDes).normalize()
      const qCur = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Fd, Td, Pd))
      const qTar = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fDes.clone().normalize(), tDes, pDes.clone().normalize()))
      worldRotate(arm.hand, qTar.multiply(qCur.invert()))
    }
    const aimArm = (arm, anchor) => {
      const s = wp(arm.up)
      const dRest = wp(arm.hand).sub(s).normalize()
      worldRotate(arm.up, new THREE.Quaternion().setFromUnitVectors(dRest, anchor.clone().sub(s).normalize()))
    }

    // ---- 姿态（vmScene 世界系 == 相机本地系；vmCamera 固定原点无旋转）----
    // 握点/指尖瞄准点全部用"枪模模型系"坐标经 vmP() 精确换算（含缩放/旋转/平移）。
    // 本枪模（Quaternius AK47，归一化前）实测几何轮廓（原始系，X=枪管轴、枪口 -1.1、Y 上）：
    //   枪管 -1.1..-0.7 / 前段护木+弹匣 -0.6..-0.4（弹匣下探至 y=-0.32）/
    //   机匣 -0.3..0.0（底面 y≈0）/ 握把凹口 x -0.1..0.0（下探至 y=-0.1）/ 枪托 0.1..0.3
    // vmP 坐标系 = 旋转后本地系（-Z 朝枪口）：c_z=原始x，c_y=原始y，c_x=-原始z
    // ---- 姿态 ----
    // 挂载前先量绑定几何（挂载后距离读数会被 holder 缩放污染）：
    // restLen = 绑定姿态肩→腕距离（孤立根、scale=1）
    hands.quaternion.identity()
    hands.position.set(0, 0, 0)
    hands.scale.setScalar(1)
    hands.updateMatrixWorld(true)
    const restLen = armR.hand.getWorldPosition(new THREE.Vector3()).distanceTo(armR.up.getWorldPosition(new THREE.Vector3()))
    // 挂进 holder 后做姿态：wp/worldRotate 一律从 vmScene 根级联刷新矩阵，
    // 所有量（锚点、骨骼位置、旋转）始终同帧，免疫挂载时序问题
    if (this.customHands && this.customHands !== hands) this.vmHolder.remove(this.customHands)
    this.customHands = hands
    this.vmHolder.add(hands)
    if (this.customArms) this.customArms.visible = false
    this.vmScene.updateMatrixWorld(true)
    // 握点/指尖瞄准点全部用"枪模模型系"坐标经 vmP() 精确换算（含缩放/旋转/平移）。
    // 本枪模（Quaternius AK47，归一化前）实测几何轮廓（原始系，X=枪管轴、枪口 -1.1、Y 上）：
    //   枪管 -1.1..-0.7 / 前段护木+弹匣 -0.6..-0.4（弹匣下探至 y=-0.32）/
    //   机匣 -0.3..0.0（底面 y≈0）/ 握把凹口 x -0.1..0.0（下探至 y=-0.1）/ 枪托 0.1..0.3
    // vmP 坐标系 = 旋转后本地系（-Z 朝枪口）：c_z=原始x，c_y=原始y，c_x=-原始z
    const vmP = (x, y, z) => this.customVm.localToWorld(new THREE.Vector3(x, y, z))
    // 腕锚点：右手贴握把右侧（掌压握把右面）、左手托护木前段左下（弹匣前、前置握法）
    const wristR = vmP(0.045, -0.055, -0.02)
    const wristL = vmP(-0.05, -0.235, -0.62)
    // 根落位：目标 shoulder = pivot + RS·t（pivot = hPos=0 时的肩位，RS = holder 旋转+缩放，
    // 平移已含在 pivot 里不能消）→ t = (RS)⁻¹·(S_target − pivot)，数学上精确（本地旋转恒为单位）
    const holderScale = this.vmHolder.scale.x
    const placeRoot = (armLen, S_target) => {
      hands.quaternion.identity()
      hands.scale.setScalar(armLen / restLen / holderScale)
      hands.position.set(0, 0, 0)
      const pivot = wp(armR.up) // = holderW·(s·bindUp)（hPos=0 时）
      const rsInv = this.vmHolder.matrixWorld.clone()
      rsInv.setPosition(0, 0, 0) // 只消旋转+缩放；平移已包含在 pivot 中
      rsInv.invert()
      hands.position.copy(S_target.clone().sub(pivot).applyMatrix4(rsInv))
      this.vmScene.updateMatrixWorld(true)
    }
    const elbowDirR = new THREE.Vector3(0.5, -0.78, 0.38).normalize() // 肘压低偏右 → 肘部出画且拉开与左腕距离
    const t0 = 0.36
    placeRoot(t0, wristR.clone().addScaledVector(elbowDirR, t0))
    // 臂长自动标定：直链 IK 腕到肩距离恒等于臂长 → 扫描臂长使"左肩到左腕锚"也恰好等于臂长
    // （双臂共用根节点，臂长取两臂可达性的平衡点 → 双手都精确落在握点上）
    const dShoulder = wp(armL.up).clone().sub(wp(armR.up)) // 相机系双肩间距（含 holder 旋转）
    let armLen = t0, best = Infinity
    for (let t = 0.28; t <= 0.48; t += 0.005) {
      const sR = wristR.clone().addScaledVector(elbowDirR, t)
      const sL = sR.clone().add(dShoulder.clone().multiplyScalar(t / t0))
      const err = Math.abs(t - sL.distanceTo(wristL))
      if (err < best) { best = err; armLen = t }
    }
    placeRoot(armLen, wristR.clone().addScaledVector(elbowDirR, armLen))

    // 双臂瞄准：右腕→握把、左腕→护木（方向瞄准；距离已由臂长标定保证）
    aimArm(armR, wristR)
    aimArm(armL, wristL)
    // 掌心朝向：右手压握把右侧面（掌朝 -X），左手托护木底面（掌朝上偏右）
    const V = (x, y, z) => new THREE.Vector3(x, y, z).normalize()
    orientHand(armR, F.R, V(-0.6, -0.4, -0.68), V(-0.95, -0.2, -0.25))
    orientHand(armL, F.L, V(0.35, 0.55, -0.75), V(0.3, 0.9, 0.2))
    // 指尖瞄准点（枪模模型系）：R 四指绕握把前缘 / 食指沿扳机护圈 / 拇指压握把后脊；
    // L 四指卷握护木右侧面 / 拇指沿护木左侧前伸
    aimFinger(F.R.dbl, armR.hand, vmP(0.055, -0.075, -0.16), [28, 46, 40])
    aimFinger(F.R.idx, armR.hand, vmP(0.03, -0.045, -0.17), [8, 14, 12])
    aimFinger(F.R.thb, armR.hand, vmP(0.05, 0.0, 0.03), [8, 12, 0])
    aimFinger(F.L.dbl, armL.hand, vmP(0.07, -0.115, -0.6), [24, 44, 40])
    aimFinger(F.L.idx, armL.hand, vmP(0.075, -0.075, -0.63), [20, 38, 34])
    aimFinger(F.L.thb, armL.hand, vmP(-0.065, -0.095, -0.66), [6, 6, 0])

    hands.traverse(o => { if (o.isMesh) o.frustumCulled = false }) // 蒙皮包围盒不随骨骼更新
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
    this.drySince = 0
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
    // 下一发时刻 = max(上一次限定, 当前时刻) + 射击间隔。
    // 若写成 max(上一次限定 + 间隔, 当前时刻)，停火后再次开火的首发会把下一发
    // 放到"现在"，第二个逻辑帧立刻击发 → 前两发仅隔 1 tick（射速超标）
    this.nextShotAt = Math.max(this.nextShotAt, this.now) + 1 / w.fireRate
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

    // 命中判定：世界 vs 机器人取最近（射线原点用当前逻辑帧的玩家眼睛，
    // 而非渲染帧相机位置——后者在固定步长内最多滞后一帧）
    const eye = _eye.set(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z)
    const maxDist = 250
    const wallHit = this.world.raycast(eye.x, eye.y, eye.z, _dir.x, _dir.y, _dir.z, maxDist)
    const botHit = this.bots.pickHit(eye, _dir, wallHit ? wallHit.t : maxDist)

    // 枪口焰（含动态点光）+ 抛壳 + 曳光
    _muzzle.copy(this.muzzleOffset)
    this._vmToWorld(_muzzle)
    this.fx.muzzle(_muzzle)
    const vm = this.customVm ?? this.viewmodels[this.currentId]
    if (vm.userData.eject) {
      _eject.copy(vm.userData.eject)
      this._vmToWorld(_eject)
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

    // 持枪模型后坐 + 机件循环（枪机/套筒后坐回位，Sheriff 转轮分度）
    this.vmKick = Math.min(this.vmKick + 0.035, 0.08)
    this.vmBolt = 1
    if (this.currentId === 'sheriff') this._indexCylinder()
    this.lastFireTime = this.now
    this.onAmmoChange?.(this)
  }

  // 转轮击发后分度 60°（下一发弹巢对准枪管）
  _indexCylinder() {
    this.viewmodels.sheriff.userData.cylPivot.rotation.z += Math.PI / 3
  }

  _meleeSwing() {
    const w = this.weapon
    this.audio.shot(w.sound, null, { pos: this.camera.position, yaw: this.player.yaw })
    this.vmKick = 0.09
    this.vmSwing = 1 // 挥刀弧线（updateViewmodel 里 sin 包络）
    const p = this.player
    const eye = _eye.set(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z)
    const hit = this.bots.pickHit(eye, _dir.set(0, 0, -1).applyEuler(_euler.set(p.pitch, p.yaw, 0)), w.range)
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

    const w = this.weapon
    const st = this._st(this.currentId)

    // 换弹完成
    if (this.reloadEnd > 0 && this.now >= this.reloadEnd) {
      const need = w.magSize - st.mag
      const take = Math.min(need, st.reserve)
      st.mag += take
      if (st.reserve !== Infinity) st.reserve -= take
      this.reloadEnd = 0
      this.sprayIndex = 0
      this.onAmmoChange?.(this)
    }

    // 弹药耗尽自动补给（无限时长回合不会卡死：打空 2.5s 后补满，模拟靶场随时买枪）
    if (w.slot !== 'melee' && st.mag <= 0 && st.reserve <= 0) {
      if (this.drySince === 0) this.drySince = this.now
      else if (this.now - this.drySince >= 2.5) {
        st.mag = w.magSize
        st.reserve = w.reserve ?? Infinity
        this.drySince = 0
        this.sprayIndex = 0
        this.audio.reload()
        this.onDryRefill?.()
        this.onAmmoChange?.(this)
      }
    } else {
      this.drySince = 0
    }

    // 停火重置弹道（刀无后坐力参数）
    const rec = w.recoil
    if (!rec || this.now - this.lastFireTime > rec.recoverTime) this.sprayIndex = 0
  }

  queueEdges(fireEdge, altEdge) {
    const edges = this.pendingEdges ?? (this.pendingEdges = { fireEdge: false, altEdge: false })
    if (fireEdge) edges.fireEdge = true
    if (altEdge) edges.altEdge = true
  }

  // ---- 渲染帧：持枪模型摆动 ----
  // 基础持枪姿势对齐 Valorant：枪在右下、贴近相机，枪身向内偏转使枪口朝准星汇聚
  static vmBaseYaw = 0.20     // 向内偏航（枪口指向屏幕中心）
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
    // 静止呼吸微摆（慢频小幅，速度越快越弱）
    this.idleT += dt
    const idleK = 1 - speedRatio
    const breatheY = Math.sin(this.idleT * 1.7) * 0.0022 * idleK
    const breatheX = Math.cos(this.idleT * 0.9) * 0.0016 * idleK
    // 换弹下沉 / 起枪缓动（从下方托起，ease-out）
    const reloading = this.reloadEnd > this.now
    const equipT = Math.max(0.01, this.weapon.equipTime)
    const ep = this.now < this.equipUntil ? 1 - (this.equipUntil - this.now) / equipT : 1
    const raise = (1 - Math.pow(THREE.MathUtils.clamp(ep, 0, 1), 3)) * 0.17
    const lower = reloading ? 0.1 : raise
    const crouchDrop = p.crouchAmt * 0.02
    // 挥刀弧线（sin 包络：抬起 → 劈下 → 回位）
    let swPitch = 0, swYaw = 0, swFwd = 0
    if (this.vmSwing > 0) {
      this.vmSwing = Math.max(0, this.vmSwing - dt * 3.2)
      const s = Math.sin((1 - this.vmSwing) * Math.PI)
      swPitch = s * 0.85
      swYaw = s * 0.3
      swFwd = -s * 0.12
    }
    // 侧移微侧倾（CS/Valorant 手感：平移时枪身轻微反向倾，急停摆回）
    const strafe = p.vel.x * Math.cos(p.yaw) - p.vel.z * Math.sin(p.yaw)
    const rollT = -strafe / CONFIG.movement.runSpeed * 0.045
    this.strafeRoll += (rollT - this.strafeRoll) * Math.min(1, dt * 9)
    this.vmHolder.position.set(
      this.vmBase.x + this.swayX + bobX + breatheX,
      this.vmBase.y + this.swayY + bob - lower - crouchDrop + breatheY,
      this.vmBase.z + this.vmKick + swFwd,
    )
    this.vmHolder.rotation.set(
      this.vmKick * 2.2 + this.swayY * 2 - swPitch,
      WeaponSystem.vmBaseYaw + this.swayX * 2 + swYaw,
      WeaponSystem.vmBaseRoll + this.strafeRoll + (reloading ? 0.3 : 0),
    )
    this._updateVmParts(dt, reloading)
  }

  // ---- 机件/弹匣动画：枪机后坐回位、左轮击锤、换弹弹匣下落回插 + 上膛抽动 ----
  _updateVmParts(dt, reloading) {
    this.vmBolt = Math.max(0, this.vmBolt - dt * 11) // ~90ms 一个循环，对上步枪射速观感
    const vm = this.customVm && (this.currentVmId === 'vandal' || this.currentVmId === 'phantom')
      ? this.customVm
      : this.viewmodels[this.currentVmId]
    if (!vm) return
    const bolt = vm.userData.bolt
    if (bolt) {
      bolt.userData.z0 ??= bolt.position.z
      bolt.position.z = bolt.userData.z0 + this.vmBolt * bolt.userData.travel
    }
    const hammer = vm.userData.hammer
    if (hammer) hammer.rotation.x = 0.12 + (1 - this.vmBolt) * 0.62 // 击发瞬间前倒，随后回待击
    const mag = vm.userData.mag
    if (!mag) return
    const mats = vm.userData.magMats
    if (reloading) {
      const pr = THREE.MathUtils.clamp(1 - (this.reloadEnd - this.now) / this.weapon.reloadTime, 0, 1)
      // 弹匣：0~14% 抽出下坠 → 中段离手（淡出）→ 62~84% 回插 → 90% 上膛抽动
      const drop = pr < 0.14 ? pr / 0.14 : pr < 0.62 ? 1 : pr < 0.84 ? 1 - (pr - 0.62) / 0.22 : 0
      mag.userData.y0 ??= mag.position.y
      mag.position.y = mag.userData.y0 - drop * 0.14
      const vis = pr < 0.10 ? 1 - pr / 0.10 : pr < 0.64 ? 0 : Math.min(1, (pr - 0.64) / 0.12)
      for (const m of mats) m.opacity = vis
      if (pr > 0.9) { if (!mag.userData.racked) this.vmBolt = 1; mag.userData.racked = true }
      if (pr < 0.5) mag.userData.racked = false
    } else {
      mag.position.y = mag.userData.y0 ?? 0
      for (const m of mats) m.opacity = 1
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0)
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _rx = new THREE.Vector3()
const _eye = new THREE.Vector3()
