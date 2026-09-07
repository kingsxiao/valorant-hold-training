import * as THREE from 'three'
import { CONFIG } from '../core/Config.js'
import { groundStep, accelFor } from '../core/GroundMotion.js'

// 玩家控制器：Valorant 移动手感（数值口径见 CONFIG.movement）
// - 分武器跑速：步枪 5.4 / 副武器 5.73 / 刀 6.75 m/s；Shift 静步 ≈62.8%（3.39 m/s，无声）；蹲 ≈34%
// - 启停 = 摩擦模型（加速 18.75 m/s²@步枪；减速 28.6+3.3v，急停 ≈0.15s 与游戏一致；
//   反向键无额外减速加成 —— Valorant 摩擦恒大于加速，counter-strafe 不是 CS 机制）
// - 鼠标灵敏度：0.07°/count × 灵敏度（与游戏同换算）
const V = { // 复用向量，避免每帧分配（性能）
  wish: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(),
}
const EPS = 1e-4

export class Player {
  constructor(world, audio) {
    this.world = world
    this.audio = audio

    this.pos = new THREE.Vector3(0, 0, 0)      // 脚底位置
    this.prevPos = this.pos.clone()            // 渲染插值用
    this.vel = new THREE.Vector3()
    this.yaw = 0                                // 水平视角（rad），面向 -Z 为 0
    this.pitch = 0
    this.punchPitch = 0                         // 开枪视角上踢（视觉）
    this.punchYaw = 0

    this.crouching = false
    this.crouchAmt = 0                          // 0..1
    this.grounded = true

    this.moveSpeed = 0                          // 当前水平速度（HUD 显示用）
    this.running = false                        // 是否发出脚步声（全速跑）
    this.stepDist = 0
    this.landKick = 0                           // 落地冲击速度（viewmodel 颠簸用）
  }

  get eyeHeight() {
    return THREE.MathUtils.lerp(CONFIG.movement.eyeHeight, CONFIG.movement.crouchEyeHeight, this.crouchAmt)
  }

  respawn(x = 0, z = 0, yaw = 0) {
    this.pos.set(x, 0, z); this.prevPos.copy(this.pos)
    this.vel.set(0, 0, 0)
    this.yaw = yaw; this.pitch = 0; this.punchPitch = this.punchYaw = 0
    this.crouching = false; this.crouchAmt = 0
    this.grounded = true
    this.landKick = 0 // 最近一次落地的冲击速度（m/s，WeaponSystem 消费）
  }

  // 每渲染帧：鼠标视角（无延迟直通，保证跟手）
  applyMouse(dx, dy, sens) {
    const yawPerCount = CONFIG.mouse.yawPerCount * sens * Math.PI / 180
    this.yaw -= dx * yawPerCount
    this.pitch -= dy * yawPerCount
    const lim = CONFIG.mouse.pitchLimit * Math.PI / 180
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch))
  }

  addPunch(p, y) { // 武器开火时调用（视觉上踢）
    this.punchPitch = Math.min(this.punchPitch + p, 0.35)
    this.punchYaw += y
  }

  // 固定 128Hz 物理步进
  step(dt, input, weapon) {
    this.prevPos.copy(this.pos)

    const M = CONFIG.movement
    const wishDir = V.wish.set(0, 0, 0)
    if (input.down('KeyW')) wishDir.z -= 1
    if (input.down('KeyS')) wishDir.z += 1
    if (input.down('KeyA')) wishDir.x -= 1
    if (input.down('KeyD')) wishDir.x += 1

    // 目标速度
    let maxSpeed = M.runSpeed * (weapon?.moveSpeedMult ?? 1)
    if (weapon?.slot === 'melee') maxSpeed = M.knifeSpeed
    const holdingWalk = input.down('ShiftLeft') || input.down('ShiftRight')
    const wantCrouch = input.down('ControlLeft') || input.down('KeyC')
    this.crouching = wantCrouch || (this.crouching && !this.grounded) // 空中蹲保持
    if (holdingWalk) maxSpeed *= M.walkMult
    if (this.crouching) maxSpeed *= M.crouchMult
    this.running = !holdingWalk && !this.crouching && this.grounded

    if (wishDir.lengthSq() > 0) {
      wishDir.normalize().applyAxisAngle(UP, this.yaw)
    }

    // 跳跃
    if (input.down('Space') && this.grounded) {
      this.vel.y = M.jumpVel
      this.grounded = false
    }
    // 重力始终作用（站在地面时每 tick 由碰撞解算支撑并清零）
    this.vel.y -= M.gravity * dt

    // 地面/空中加速模型
    if (this.grounded) {
      const cur = _tmp.set(this.vel.x, 0, this.vel.z)
      if (wishDir.lengthSq() > 0) {
        // 摩擦模型（core/GroundMotion.js）：沿输入方向的 1D 速度走 groundStep，
        // 正交残余（换向漂移）按摩擦衰减 —— 反向输入不享受额外减速（与游戏一致）
        const accel = accelFor(maxSpeed, M.groundAccel, M.runSpeed)
        const k = { accel, decelFlat: M.groundDecelFlat, decelDrag: M.groundDecelDrag }
        const along = cur.dot(wishDir)
        const ortho = _tmp2.copy(cur).addScaledVector(wishDir, -along)
        const oMag = ortho.length()
        let oScale = 1
        if (oMag > EPS) {
          const oDrop = (M.groundDecelFlat + M.groundDecelDrag * oMag) * dt
          oScale = Math.max(0, (oMag - oDrop) / oMag)
        }
        cur.copy(wishDir).multiplyScalar(groundStep(along, maxSpeed, k, dt))
        cur.addScaledVector(ortho, oScale)
      } else if (cur.lengthSq() > EPS) {
        // 松键滑行：全速度摩擦衰减
        const speed = cur.length()
        const drop = Math.min(speed, (M.groundDecelFlat + M.groundDecelDrag * speed) * dt)
        cur.multiplyScalar((speed - drop) / speed)
      }
      this.vel.x = cur.x; this.vel.z = cur.z
    } else {
      // 空中：轻微操控
      this.vel.addScaledVector(wishDir, M.airAccel * dt)
    }

    // 蹲姿过渡
    const crouchTarget = this.crouching ? 1 : 0
    const cl = dt / M.crouchLerpTime
    this.crouchAmt += Math.sign(crouchTarget - this.crouchAmt) * Math.min(cl, Math.abs(crouchTarget - this.crouchAmt))

    // 分轴移动 + 碰撞（分轴推进天然形成沿墙滑动）
    const wasGrounded = this.grounded
    this._moveAxis('x', this.vel.x * dt)
    this._moveAxis('z', this.vel.z * dt)
    const vyBefore = this.vel.y
    this._moveAxis('y', this.vel.y * dt)
    // 落地冲击（viewmodel 颠簸弹簧消费一次后清零；站立支撑不触发）
    if (!wasGrounded && this.grounded) {
      this.landKick = Math.max(0, -vyBefore)
      if (this.landKick > 2) this.audio.land?.(this.landKick) // 真跳落地才有声响，小台阶不算
    }

    // 脚步声
    const hSpeed = Math.hypot(this.vel.x, this.vel.z)
    this.moveSpeed = hSpeed
    if (this.grounded && this.running) {
      this.stepDist += hSpeed * dt
      if (this.stepDist > 1.15) { this.stepDist = 0; this._footstep() }
    } else this.stepDist = 0.6

    // 视角后坐恢复（指数回落）。恢复速率分武器（recoil.punchRecover）：步枪快回
    // 保持准星可读，Sheriff 重枪慢沉 —— 每把枪打完"落回准心"的节奏不一样
    const rec = 1 - Math.exp(-dt * (weapon?.recoil?.punchRecover ?? 9))
    this.punchPitch -= this.punchPitch * rec
    this.punchYaw -= this.punchYaw * rec
  }

  _footstep() { this.audio.footstep(null, { pos: this.pos, yaw: this.yaw }, true) }

  _moveAxis(axis, delta) {
    if (delta === 0) return
    const M = CONFIG.movement
    const h = THREE.MathUtils.lerp(M.playerHeight, M.crouchHeight, this.crouchAmt)
    const r = M.playerRadius
    const res = this.world.moveAxis(this.pos, r, h, axis, delta) // moveAxis 内部完成位移+推挤
    if (axis === 'y') {
      if (res.hit) {
        if (delta < 0) this.grounded = true // 落地/站立支撑
        this.vel.y = 0
      } else {
        this.grounded = false // 走出台面 → 下落
      }
    } else if (res.hit) {
      this.vel[axis] = 0 // 撞墙（另一轴不受影响 → 沿墙滑动）
    }
  }

  // 渲染帧：把相机摆到位（位置做 128Hz 插值，视角直通）
  updateCamera(cam, alpha) {
    const p = _cpos.copy(this.prevPos).lerp(this.pos, alpha)
    cam.position.set(p.x, p.y + this.eyeHeight, p.z)
    cam.rotation.set(this.pitch + this.punchPitch, this.yaw + this.punchYaw, 0)
  }
}

const UP = new THREE.Vector3(0, 1, 0)
const _tmp = new THREE.Vector3()
const _tmp2 = new THREE.Vector3()
const _cpos = new THREE.Vector3()
