import * as THREE from 'three'
import { CONFIG, makeSprayPattern } from '../core/Config.js'
import { damageFor, spreadAt } from './ballistics.js'
import { buildWeaponModels, buildCustomArms } from './ViewmodelFactory.js'
import { poseGloveHands, poseCustomHands } from './HandsRig.js'

// ============================================================================
// 武器系统：命中判定（射线）+ 散布 + 后坐力弹道 + 切枪 + 第一人称持枪动画。
// 程序化枪模/手臂建模在 ViewmodelFactory；GLB 手部姿态装配在 HandsRig。
// 手感要点（对齐游戏机制）：
//  - 射线从眼睛出发；子弹偏移 = 后坐力弹道表（累计值）+ 随机散布锥
//  - 静止首发精度高；移动/跳跃散布剧增；蹲下小幅加成
//  - 停火 recoverTime 后弹道立即重置（鼓励点射/急停）
//  - 弹药无限（架枪训练不中断节奏；原换弹状态机已删）
// ============================================================================
const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _muzzle = new THREE.Vector3()
const _eject = new THREE.Vector3()
const _hitP = new THREE.Vector3()
const _deg = THREE.MathUtils.degToRad

// ---- 欠阻尼弹簧（后坐/颠簸/手部滞后的共用积分器）----
// 冲量进速度、半隐式欧拉步进；与旧"线性衰减 kick"的差别：冲击瞬间快起峰、
// 指数式回落带轻微过冲回稳 —— 连射时后坐自然堆叠、停火后弹性归位，不再机械。
// 子步积分（≥120Hz）保证低帧率下刚度高达 k≈900 仍稳定。
class Spring {
  constructor(k, c) { this.k = k; this.c = c; this.x = 0; this.v = 0 }
  impulse(vi) { this.v += vi }
  step(dt) {
    if (this.x === 0 && this.v === 0) return
    const steps = Math.max(1, Math.ceil(dt * 120))
    const h = dt / steps
    for (let i = 0; i < steps; i++) {
      this.v += (-this.k * this.x - this.c * this.v) * h
      this.x += this.v * h
    }
    if (Math.abs(this.x) < 1e-6 && Math.abs(this.v) < 1e-5) { this.x = 0; this.v = 0 }
  }
}

export class WeaponSystem {
  constructor({ camera, vmCamera, world, bots, fx, audio, player }) {
    this.camera = camera; this.vmCamera = vmCamera; this.world = world; this.bots = bots
    this.vmScene = vmCamera?.parent // 级联刷新矩阵用（vmCamera 固定挂 vmScene 下）
    this.fx = fx; this.audio = audio; this.player = player

    // 当前武器与副武器（菜单可改）
    this.primaryId = 'vandal'
    this.secondaryId = 'classic'
    this.currentId = 'vandal'
    this.baseVmScale = 0.49 // 视角模型基础缩放（独立窄 FOV pass 下的占屏比例，2026-09-03 随取景联调）
    this.lastShotAt = -10
    this.lastFireTime = -10
    this.sprayIndex = 0
    this.nextShotAt = 0
    this.burstLeft = 0 // Classic 右键三连发
    this.equipUntil = 0
    this.now = 0

    // 事件回调（main 注入）
    this.onHitBot = null    // (bot, zone, dmg, killed)
    this.onShotFired = null // () → 统计
    this.onAmmoChange = null // () → 切枪后 HUD 刷新武器名

    this._buildViewmodel()
    this.switchTo(this.currentId, true)
  }

  get weapon() { return CONFIG.weapons[this.currentId] }

  // ---- 第一人称持枪模型：工厂建模 + 挂载到 vmCamera ----
  // 支持 public/models/viewmodel.glb 用户自有模型整体替换（见 setCustomViewmodel）
  _buildViewmodel() {
    const { viewmodels, vmMats, armMats } = buildWeaponModels()
    this.viewmodels = viewmodels
    this.vmMats = vmMats
    this.armMats = armMats
    const holder = new THREE.Group()
    for (const vm of Object.values(this.viewmodels)) holder.add(vm)
    // 持枪取景（对齐 Valorant）：枪在右下、贴近相机、枪身内偏使枪口汇聚准星。
    // 独立窄 FOV(55°) pass 下透视压缩小，稍拉远拉开层次。2026-09-03 调参：
    // 枪托尖端 NDC y≈-1.13（大部分出画只露一角）、枪口 (0.20,-0.47) 居中偏右下
    holder.position.set(0.18, -0.2, -0.24)
    holder.scale.setScalar(this.baseVmScale)
    this.vmCamera.add(holder)
    this.vmHolder = holder
    this.vmBase = holder.position.clone()
    // 后坐/颠簸弹簧组：sKick 枪身后拉（k=900 ≈ 30rad/s，ζ≈0.55 轻微过冲）；
    // sYaw/sRoll 每发随机微抖方向；sDip 落地颠簸；sFlinch 手部滞后（刚度低于枪身 → 重量感）
    this.sKick = new Spring(900, 33)
    this.sYaw = new Spring(520, 34)
    this.sRoll = new Spring(520, 34)
    this.sDip = new Spring(260, 16)
    this.sFlinch = new Spring(300, 21)
    this.swayX = 0; this.swayY = 0; this.bobT = 0
    this.strafeRoll = 0 // 侧移侧倾（平滑趋近目标）
    this.strafeLag = 0  // 侧移滞后平移（枪身拖在移动方向后侧一点）
    this.airK = 0       // 空中姿态因子（平滑 0..1）
    this.trig = 0       // 扳机指扣合度 0..1（_animateHands 用）
    this.grip = 0       // 开火握持收紧脉冲（衰减）
    this.heat = 0       // 持续射击的枪口热度 0..1（枪口烟浓度）
    this._trigHeld = false
    this.vmBolt = 0   // 机件后坐相位 0..1（枪机/套筒，击发置 1 快速回位）
    this.vmSwing = 0  // 挥刀相位 0..1（sin 包络弧线）
    this.idleT = 0    // 呼吸微摆计时
    this.muzzleOffset = new THREE.Vector3()
    this.customVm = null
    this.customHands = null
    this.handsAnim = null // glove 路径的手部动画基准（HandsRig.poseGloveHands 注入）
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

  // ---- GLB 手部装配委托（姿态数学见 HandsRig.js）----
  setGloveHands(scene, arms) { return poseGloveHands(this, scene, arms) }
  setCustomHands(hands) { return poseCustomHands(this, hands) }

  // 用户自有 GLB 枪模（public/models/viewmodel.glb）：加载成功后替换所有武器外观。
  // userData.muzzle/eject 为枪组本地系点位（x=枪管轴、-X=枪口、-Z=射手右侧），
  // 未提供时按几何包围盒推导 —— _fireOne 经枪自身世界矩阵精确变换到场景
  setCustomViewmodel(scene) {
    // 按包围盒推导默认枪口/抛壳口。点位必须定义在枪本体（children）系 ——
    // _fireOne 经 vm.matrixWorld（T·R·S）变换，若直接用 setFromObject 量的
    // R·S 后世界系包围盒会二次旋转/缩放。先清平移、再把顶点剥回本体系测量
    scene.position.set(0, 0, 0)
    scene.updateMatrixWorld(true)
    const rs = scene.matrixWorld.clone() // 纯 R·S
    const inv = rs.clone().invert()
    const bb = new THREE.Box3()
    const v = new THREE.Vector3()
    scene.traverse(o => {
      if (!o.isMesh) return
      const pos = o.geometry.attributes.position
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv)
        bb.expandByPoint(v)
      }
    })
    const size = bb.getSize(new THREE.Vector3())
    scene.userData.muzzle ??= new THREE.Vector3(bb.min.x - 0.02, bb.min.y + size.y * 0.78, 0)
    scene.userData.eject ??= new THREE.Vector3(bb.min.x + size.x * 0.56, bb.min.y + size.y * 0.62, bb.min.z)
    scene.userData.pos ??= new THREE.Vector3(0.15, -0.13, -0.5) // 整枪前移：枪托不怼到相机
    scene.userData.scale ??= 1
    // 程序化拉机柄：自有枪模没有活动机件，补一个可见的击发后坐循环
    // （children 系：机匣右后上方，+X 为后坐方向）
    const bolt = new THREE.Mesh(
      new THREE.BoxGeometry(size.x * 0.055, size.y * 0.028, size.z * 0.16),
      this.vmMats.dark,
    )
    bolt.position.set(bb.min.x + size.x * 0.62, bb.min.y + size.y * 0.72, bb.min.z)
    bolt.userData.travel = size.x * 0.035
    bolt.userData.dir = new THREE.Vector3(1, 0, 0)
    scene.add(bolt)
    scene.userData.bolt = bolt
    scene.position.copy(scene.userData.pos) // 应用持枪位置（内部模型已归一化居中）
    // 自有枪模手臂：挂 holder（保证 -Z 朝枪口的坐标系），按模型包围盒中心对齐持握姿势
    if (!this.customArms) {
      this.customArms = buildCustomArms(this.armMats)
      this.vmHolder.add(this.customArms)
    }
    const center = new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3())
    this.customArms.position.copy(center)
    this.customVm = scene
    this.vmHolder.add(scene)
    this.weaponMeshFor(this.currentVmId)
  }

  // ---- 切枪 ----
  switchTo(id, instant = false) {
    if (id === this.currentId && !instant) return
    this.currentId = id
    this.burstLeft = 0
    this.equipUntil = this.now + CONFIG.weapons[id].equipTime * (instant ? 0 : 1)
    this.sprayIndex = 0
    this.weaponMeshFor(id)
    this.onAmmoChange?.(this)
  }

  // ---- 散布（度）----
  currentSpread() {
    return spreadAt(this.weapon, {
      speedRatio: this.player.moveSpeed / (CONFIG.movement.runSpeed * (this.weapon.moveSpeedMult ?? 1)),
      crouched: this.player.crouchAmt > 0.5,
      grounded: this.player.grounded,
      sprayIndex: this.sprayIndex,
    })
  }

  // ---- 开火（弹药无限：无弹匣/换弹分支）----
  tryFire(triggerEdge, triggerHeld, altEdge) {
    const w = this.weapon
    if (this.now < this.equipUntil) return

    if (w.slot === 'melee') {
      if (triggerEdge && this.now >= this.nextShotAt) {
        this.nextShotAt = this.now + 1 / w.fireRate
        this._meleeSwing()
      }
      return
    }

    // Classic 右键三连发：直接排队 3 发
    if (w.burst && altEdge && this.now >= this.nextShotAt) {
      this.burstLeft = 3
      this.nextShotAt = this.now
    }

    const wantFire = w.auto ? triggerHeld : triggerEdge || this.burstLeft > 0
    if (!wantFire) return
    if (this.now < this.nextShotAt) return

    if (this.burstLeft > 0) this.burstLeft--

    this._fireOne()
    // 下一发时刻 = max(上一次限定, 当前时刻) + 射击间隔。
    // 若写成 max(上一次限定 + 间隔, 当前时刻)，停火后再次开火的首发会把下一发
    // 放到"现在"，第二个逻辑帧立刻击发 → 前两发仅隔 1 tick（射速超标）
    this.nextShotAt = Math.max(this.nextShotAt, this.now) + 1 / w.fireRate
  }

  _fireOne() {
    const w = this.weapon
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

    // 枪口焰（含动态点光）+ 枪口烟（连射越久越浓）+ 抛壳 + 曳光。
    // userData 点位是枪组本地系 → 经枪自身世界矩阵变换（含持枪偏移/缩放/内偏旋转）；
    // vmScene 世界系 == 相机本地系，再过主相机矩阵落进世界（FX 都在世界场景）
    const vm = this.customVm ?? this.viewmodels[this.currentId]
    this.camera.updateMatrixWorld()
    _muzzle.copy(this.muzzleOffset)
    _muzzle.applyMatrix4(vm.matrixWorld).applyMatrix4(this.camera.matrixWorld)
    this.fx.muzzle(_muzzle)
    this.fx.muzzleSmoke(_muzzle, _dir, this.heat)
    if (vm.userData.eject) {
      _eject.copy(vm.userData.eject)
      _eject.applyMatrix4(vm.matrixWorld).applyMatrix4(this.camera.matrixWorld)
      // 抛壳初速按枪身姿态取轴向（枪有内偏 yaw/roll，按相机抛会偏出枪的右上方）
      this.fx.shell(_eject, this.vmHolder.matrixWorld)
    }
    const end = _hitP.copy(_dir)
    if (botHit) end.multiplyScalar(botHit.t).add(eye)
    else if (wallHit) end.set(wallHit.x, wallHit.y, wallHit.z)
    else end.multiplyScalar(maxDist).add(eye)
    this.fx.tracer(_muzzle, end)

    // 声音
    this.audio.shot(w.sound, null, { pos: eye, yaw: p.yaw })

    if (botHit) {
      const dmg = damageFor(this.weapon, botHit.zone, botHit.t)
      const killed = this.bots.damage(botHit.bot, dmg, botHit.zone)
      this.onHitBot?.(botHit.bot, botHit.zone, dmg, killed, botHit.point)
    } else if (wallHit) {
      this.fx.decal(wallHit.x, wallHit.y, wallHit.z, wallHit.nx, wallHit.ny, wallHit.nz)
      this.fx.impact(wallHit.x, wallHit.y, wallHit.z, wallHit.nx, wallHit.ny, wallHit.nz)
    }

    // 持枪模型后坐（弹簧冲量：快起峰 + 弹性回稳，连射自然堆叠）+ 每发随机
    // 微抖（yaw/roll 各自独立弹簧 → 每发的枪身姿态都有细微差别，连射不呆板）
    // + 手部滞后冲量（刚度低于枪身 → 开火时手比枪慢半拍，读出"顶手"重量感）
    const kick = w.vmKick ?? 0.032 // 每把枪独立开火冲量（重枪锤感 / 消音轻感）
    // 冲量标定：×62 → 峰值 ≈ vmKick（Vandal 0.032 = 33ms 峰值 0.030， Sheriff 0.047）
    this.sKick.impulse(kick * 62)
    this.sYaw.impulse((Math.random() * 2 - 1) * kick * 7.5)
    this.sRoll.impulse((Math.random() * 2 - 1) * kick * 10)
    this.sFlinch.impulse(kick * 50)
    this.grip = 1
    this.heat = Math.min(1, this.heat + 0.13)
    this.vmBolt = 1
    if (this.currentId === 'sheriff') this._indexCylinder()
    this.lastFireTime = this.now
  }

  // 转轮击发后分度 60°（下一发弹巢对准枪管）
  _indexCylinder() {
    this.viewmodels.sheriff.userData.cylPivot.rotation.z += Math.PI / 3
  }

  _meleeSwing() {
    const w = this.weapon
    this.audio.shot(w.sound, null, { pos: this.camera.position, yaw: this.player.yaw })
    this.sKick.impulse(0.09 * 40) // 挥击前冲冲量（弹簧路径与开火一致）
    this.vmSwing = 1 // 挥刀弧线（updateViewmodel 里 sin 包络）
    const p = this.player
    const eye = _eye.set(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z)
    const hit = this.bots.pickHit(eye, _dir.set(0, 0, -1).applyEuler(_euler.set(p.pitch, p.yaw, 0)), w.range)
    if (hit) {
      const killed = this.bots.damage(hit.bot, w.damage.body, 'body')
      this.onHitBot?.(hit.bot, 'body', w.damage.body, killed, hit.point)
    }
  }

  // ---- 固定步长更新 ----
  step(dt, input) {
    this.now += dt
    // 手部动画用的扳机状态（渲染帧 _animateHands 消费）
    this._trigHeld = !!input.mouse0
    // 鼠标边沿由渲染帧 queueEdges 喂入，这里消费
    const edges = this.pendingEdges ?? (this.pendingEdges = { fireEdge: false, altEdge: false })
    this.tryFire(edges.fireEdge, input.mouse0, edges.altEdge)
    edges.fireEdge = edges.altEdge = false

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
  static vmBaseYaw = 0.20     // 向内偏航（枪口指向屏幕中心）
  static vmBaseRoll = -0.06   // 轻微侧倾（露出枪顶）

  updateViewmodel(dt, mouseDx, mouseDy) {
    const p = this.player
    // ---- 弹簧组步进（后坐/随机微抖/落地颠簸/手部滞后）----
    this.sKick.step(dt); this.sYaw.step(dt); this.sRoll.step(dt)
    this.sDip.step(dt); this.sFlinch.step(dt)
    // 落地颠簸：消费 Player 落地冲击速度（跳落 ≈5.9m/s → 轻跳 ≈2 → 小台阶 ≈1）
    if (p.landKick > 0) { this.sDip.impulse(Math.min(p.landKick, 9) * 0.038); p.landKick = 0 }
    // 空中姿态因子（平滑过渡，起跳抬枪微沉+外翻）
    this.airK += ((p.grounded ? 0 : 1) - this.airK) * Math.min(1, dt * 7)
    // 枪口热度衰减（停火 ~1.8s 冷却）
    this.heat = Math.max(0, this.heat - dt * 0.55)
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
    // 换枪缓动（从下方托起，ease-out + 出枪弧线：低位时枪口上抬侧倾）
    const equipT = Math.max(0.01, this.weapon.equipTime)
    const ep = this.now < this.equipUntil ? 1 - (this.equipUntil - this.now) / equipT : 1
    const raise = (1 - Math.pow(THREE.MathUtils.clamp(ep, 0, 1), 3)) * 0.17
    const lower = raise
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
    // 侧移手感对：枪身轻微反向倾 + 平移滞后拖尾（急停时摆回）
    const strafe = p.vel.x * Math.cos(p.yaw) - p.vel.z * Math.sin(p.yaw)
    const rollT = -strafe / CONFIG.movement.runSpeed * 0.045
    this.strafeRoll += (rollT - this.strafeRoll) * Math.min(1, dt * 9)
    this.strafeLag += (-strafe / CONFIG.movement.runSpeed * 0.014 - this.strafeLag) * Math.min(1, dt * 8)
    this.vmHolder.position.set(
      this.vmBase.x + this.swayX + bobX + breatheX + this.strafeLag,
      this.vmBase.y + this.swayY + bob - lower - crouchDrop + breatheY - this.sDip.x - this.airK * 0.016,
      this.vmBase.z + this.sKick.x + swFwd,
    )
    this.vmHolder.rotation.set(
      this.sKick.x * 2.2 - this.sDip.x * 2.0 + this.airK * 0.045 + raise * 1.2 + this.swayY * 2 - swPitch,
      WeaponSystem.vmBaseYaw + this.sYaw.x + this.swayX * 2 + swYaw,
      WeaponSystem.vmBaseRoll + this.strafeRoll + this.sRoll.x + this.airK * 0.03 + raise * 0.5,
    )
    this._animateHands(dt)
    this._updateVmParts(dt)
  }

  // ---- 手部动画（glove 五指路径）：扳机指扣动 + 握持收紧 + 手部滞后回弹 ----
  // 每帧先把指骨/根节点重置回姿态基准（HandsRig 装配时存档），再叠加动画量 →
  // 动画与静态握姿解耦，不会随帧累积漂移。食指独立扣扳机（按住扳机时扣、
  // 停火/换弹松开），三指在开火瞬间收紧（后坐"顶手"的握持反应），双手整体
  // 随 sFlinch 弹簧滞后于枪身 → 开火重量感。
  // 待机肌腱微动：五指不同相位慢频 ±0.4° 漂移 —— 长时间架枪时手不僵死
  // （架枪训练器的核心场景是持枪等待，静帧死手最出戏）
  static FINGER_TWITCH = { thumb: 0, index: 1.3, middle: 2.1, ring: 3.4, pinky: 4.2 }
  _animateHands(dt) {
    const ha = this.handsAnim
    if (!ha) return
    // 扳机扣合度：快扣慢松（扣 40ms 级，松 ~100ms）
    const trigTarget = this._trigHeld && this.player.alive ? 1 : 0
    const trigRate = trigTarget > this.trig ? 26 : 10
    this.trig += (trigTarget - this.trig) * Math.min(1, dt * trigRate)
    this.grip = Math.max(0, this.grip - dt * 7)
    // 待机微动强度：静止满幅、移动收敛（与呼吸摆动同一因子逻辑）
    const idleFactor = 1 - Math.min(1, this.player.moveSpeed / CONFIG.movement.runSpeed)
    for (const side of ['right', 'left']) {
      const h = ha[side]
      if (!h) continue
      h.root.position.copy(h.basePos)
      h.root.quaternion.copy(h.baseQuat)
      for (const k in h.fingers) {
        const bones = h.fingers[k], base = h.bases[k]
        for (let i = 0; i < bones.length; i++) bones[i].quaternion.copy(base[i])
      }
      if (side === 'right') {
        // 食指扣扳机：近/中/远节递进额外卷曲（指根不动，保留扇形展开）
        if (this.trig > 0.001) {
          const idx = h.fingers.index
          idx[1].rotateX(_deg(7) * this.trig)
          idx[2].rotateX(_deg(13) * this.trig)
          idx[3].rotateX(_deg(9) * this.trig)
        }
      }
      // 握持收紧：中/无名/小指近中远节小幅加卷（左手 0.7 幅度，托握反应更弱）
      const g = this.grip * (side === 'right' ? 1 : 0.7)
      if (g > 0.001) {
        for (const k of ['pinky', 'ring', 'middle']) {
          const ch = h.fingers[k]
          ch[1].rotateX(_deg(2.2) * g)
          ch[2].rotateX(_deg(2.6) * g)
          ch[3].rotateX(_deg(1.8) * g)
        }
      }
      // 待机肌腱微动：中节 ±0.5° 慢漂移（~5.7s 周期），开火时收敛归零
      const twitchK = (1 - this.grip) * idleFactor
      if (twitchK > 0.01) {
        for (const k in h.fingers) {
          const ch = h.fingers[k]
          const ph = WeaponSystem.FINGER_TWITCH[k] ?? 0
          ch[2].rotateX(_deg(0.5) * twitchK * Math.sin(this.idleT * 1.1 + ph))
        }
      }
    }
    // 手部滞后回弹：手套+袖臂整组轻微后移/上旋（幅度远小于枪身后坐 → 读作握持压缩）
    if (ha.group) {
      ha.group.position.z = this.sFlinch.x * 0.12
      ha.group.rotation.x = this.sFlinch.x * 0.45
    }
  }

  // ---- 机件动画：枪机后坐回位、左轮击锤 ----
  _updateVmParts(dt) {
    // 回位速率随射速自适应：步枪 ~11-13/s（循环略短于射击间隔）、
    // Sheriff(4/s) 慢到 ~4.6/s 出戏剧性击锤回待击
    const boltRate = THREE.MathUtils.clamp((this.weapon.fireRate ?? 10) * 1.15, 4.5, 14)
    this.vmBolt = Math.max(0, this.vmBolt - dt * boltRate)
    const vm = this.customVm && (this.currentVmId === 'vandal' || this.currentVmId === 'phantom')
      ? this.customVm
      : this.viewmodels[this.currentVmId]
    if (!vm) return
    const bolt = vm.userData.bolt
    if (bolt) {
      // 后坐方向以本地单位向量存（内置模型 +Z 后坐；自有枪模 children 系 +X 后坐）
      bolt.userData.p0 ??= bolt.position.clone()
      bolt.userData.dir ??= new THREE.Vector3(0, 0, 1)
      bolt.position.copy(bolt.userData.p0).addScaledVector(bolt.userData.dir, this.vmBolt * bolt.userData.travel)
    }
    const hammer = vm.userData.hammer
    if (hammer) hammer.rotation.x = 0.12 + (1 - this.vmBolt) * 0.62 // 击发瞬间前倒，随后回待击
  }
}

const UP = new THREE.Vector3(0, 1, 0)
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _rx = new THREE.Vector3()
const _eye = new THREE.Vector3()
