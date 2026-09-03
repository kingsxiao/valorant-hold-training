import * as THREE from 'three'
import { CONFIG, makeSprayPattern } from '../core/Config.js'
import { damageFor, spreadAt } from './ballistics.js'
import { buildWeaponModels, buildCustomArms } from './ViewmodelFactory.js'
import { poseGloveHands, poseCustomHands } from './HandsRig.js'

// ============================================================================
// 武器系统：命中判定（射线）+ 散布 + 后坐力弹道 + 换弹/切枪 + 第一人称持枪动画。
// 程序化枪模/手臂建模在 ViewmodelFactory；GLB 手部姿态装配在 HandsRig。
// 手感要点（对齐游戏机制）：
//  - 射线从眼睛出发；子弹偏移 = 后坐力弹道表（累计值）+ 随机散布锥
//  - 静止首发精度高；移动/跳跃散布剧增；蹲下小幅加成
//  - 停火 recoverTime 后弹道立即重置（鼓励点射/急停）
// ============================================================================
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

  // 用户自有 GLB 枪模（public/models/viewmodel.glb）：加载成功后替换所有武器外观
  setCustomViewmodel(scene) {
    scene.userData.muzzle ??= new THREE.Vector3(0, 0, -0.45)
    scene.userData.pos ??= new THREE.Vector3(0.15, -0.13, -0.5) // 整枪前移：枪托不怼到相机
    scene.userData.scale ??= 1
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
    return spreadAt(this.weapon, {
      speedRatio: this.player.moveSpeed / (CONFIG.movement.runSpeed * (this.weapon.moveSpeedMult ?? 1)),
      crouched: this.player.crouchAmt > 0.5,
      grounded: this.player.grounded,
      sprayIndex: this.sprayIndex,
    })
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
      const dmg = damageFor(this.weapon, botHit.zone, botHit.t)
      const killed = this.bots.damage(botHit.bot, dmg, botHit.zone)
      this.onHitBot?.(botHit.bot, botHit.zone, dmg, killed, botHit.point)
    } else if (wallHit) {
      this.fx.decal(wallHit.x, wallHit.y, wallHit.z, wallHit.nx, wallHit.ny, wallHit.nz)
      this.fx.impact(wallHit.x, wallHit.y, wallHit.z, wallHit.nx, wallHit.ny, wallHit.nz)
    }

    // 持枪模型后坐 + 机件循环（枪机/套筒后坐回位，Sheriff 转轮分度）
    const kick = w.vmKick ?? 0.032 // 每把枪独立开火冲量（重枪锤感 / 消音轻感）
    this.vmKick = Math.min(this.vmKick + kick, kick * 2.3)
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
