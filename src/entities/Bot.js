import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { CONFIG } from '../core/Config.js'
import { vary } from '../core/Rng.js'
import { Tex, pbr } from '../world/Textures.js'

// 训练机器人 v5：
//  - 分段人形：头盔+发光面罩 / 护甲(3D 弹匣袋+袋盖+腰带) / 圆柱渐变四肢 / 手套 / 走路摆腿
//  - 全部 PBR：颜色+粗糙度+法线贴图（程序化生成，纹理单例共享，材质按 bot 克隆）
//  - 命中区域球体（头/胸/腹/腿）与视觉对齐；移动模型与玩家一致
//  - 命中反馈：受击泛红闪 + 踉跄后仰（爆头更强）；死亡后仰倒地 + 侧倒 + 淡出消散
//  - 接触阴影；支持 agent.glb 骨骼模型整体替换（SkeletonUtils 克隆）：
//    idle/walk/run 按实际移速加权混合，脚步速率与位移同步 —— 拉出/横移真在跑；
//    单 clip 老模型（BrainStem）静止时 timeScale→0 冻结、移动时恢复
const _v = new THREE.Vector3()

export class Bot {
  static customTemplate = null   // 用户 GLB 模板（UserAssets 注入）
  static customAnimations = null // 模板动画 clips
  static _baseMats = null        // 基础材质（纹理共享，逐 bot clone）

  constructor(scene, world) {
    this.scene = scene
    this.world = world
    this.id = Bot._id = (Bot._id ?? 0) + 1

    this.pos = new THREE.Vector3()
    this.prevPos = new THREE.Vector3()
    this.velX = 0
    this.mode = 'idle'
    this.active = false
    this.hp = CONFIG.bot.health
    this.firstVisibleAt = -1
    this.visibleNow = false
    this.walkPhase = 0
    this.flinch = 0      // 受击踉跄相位（0~1+，衰减）
    this.flinchAmp = 0   // 本次踉跄后仰幅度
    this.deathRoll = 0   // 死亡侧倒角

    // 命中区域：{ y, r, zone }
    this.zones = [
      { y: 1.63, r: 0.13, zone: 'head' },
      { y: 1.3, r: 0.21, zone: 'body' },
      { y: 0.95, r: 0.2, zone: 'body' },
      { y: 0.55, r: 0.16, zone: 'leg' },
      { y: 0.22, r: 0.14, zone: 'leg' },
    ]

    this._buildMesh()
  }

  static baseMats() {
    if (!Bot._baseMats) {
      // 面罩 = 玻璃反光贴图 + 青色传感条自发光（机器人敌意识别点）
      const visorMat = pbr({ maps: Tex.visor(), roughness: 0.12, metalness: 0.6 })
      visorMat.emissiveMap = Tex.visorGlow()
      visorMat.emissive = new THREE.Color(0x7fdcff)
      visorMat.emissiveIntensity = 1.1
      Bot._baseMats = {
        suit: pbr({ maps: Tex.suit(), roughness: 0.9 }),
        vest: pbr({ maps: Tex.vest(), roughness: 0.7 }),
        head: new THREE.MeshStandardMaterial({ color: 0x474045, roughness: 0.5, metalness: 0.15 }),
        visor: visorMat,
        glove: new THREE.MeshStandardMaterial({ color: 0x1c1e23, roughness: 0.9 }),
        accent: new THREE.MeshStandardMaterial({ color: 0xd8454e, roughness: 0.55, emissive: 0x2a0708 }),
        gun: pbr({ maps: Tex.metal(), roughness: 0.45, metalness: 0.75 }),
      }
    }
    return Bot._baseMats
  }

  _buildMesh() {
    if (Bot.customTemplate) return this._buildCustom()
    const g = new THREE.Group()
    const M = this.mats = {}
    for (const [k, m] of Object.entries(Bot.baseMats())) {
      M[k] = m.clone()
      // 记录原始自发光（受击闪红后按此恢复；克隆体会继承 userData）
      m.userData.em ??= m.emissive?.getHex() ?? 0
      m.userData.emI ??= m.emissiveIntensity ?? 1
    }
    const matsKey = Object.keys(M)

    // 几何桶：同材质静态部位合并（每 Bot ~12 draw call）
    const buckets = { suit: [], vest: [], head: [], visor: [], glove: [], accent: [], gun: [] }
    const _m4 = new THREE.Matrix4()
    const _q = new THREE.Quaternion()
    const _e = new THREE.Euler()
    const _p = new THREE.Vector3()
    const _s = new THREE.Vector3(1, 1, 1)
    const put = (bucket, geo, x, y, z, rx = 0, ry = 0, sx = 1, sy = 1, sz = 1) => {
      _q.setFromEuler(_e.set(rx, ry, 0))
      _m4.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz))
      buckets[bucket].push(geo.applyMatrix4(_m4))
    }
    const boxGeo = (w, h, d) => new THREE.BoxGeometry(w, h, d)
    const cylGeo = (rTop, rBot, len, seg = 10) => new THREE.CylinderGeometry(rTop, rBot, len, seg)
    const cylGeoZ = (r, len, seg = 10) => {
      const geo = new THREE.CylinderGeometry(r, r, len, seg)
      geo.rotateX(Math.PI / 2)
      return geo
    }

    // 头：椭圆头盔 + 下颚 → head；面罩 + 盔沿 + 侧轨 → visor
    put('head', new THREE.SphereGeometry(0.115, 20, 14), 0, 1.645, 0, 0, 0, 1, 1.1, 1.06)
    put('head', boxGeo(0.105, 0.05, 0.105), 0, 1.553, -0.012)
    put('visor', boxGeo(0.152, 0.058, 0.022), 0, 1.657, -0.108)
    put('visor', new THREE.TorusGeometry(0.094, 0.013, 8, 18).rotateX(Math.PI / 2), 0, 1.608, 0)
    put('visor', boxGeo(0.028, 0.018, 0.06), 0.092, 1.7, 0.028)

    // 颈/腹 + 双臂（圆柱渐变肢段，持枪姿态）→ suit；手 → glove
    put('suit', cylGeo(0.038, 0.044, 0.07), 0, 1.528, 0)                       // 颈
    put('suit', boxGeo(0.33, 0.13, 0.2), 0, 1.09, 0)                           // 腹
    put('suit', cylGeo(0.052, 0.045, 0.26), -0.262, 1.33, 0.018, 0.3)          // 左上臂
    put('suit', cylGeo(0.044, 0.038, 0.25), -0.185, 1.27, -0.145, 1.25)        // 左小臂
    put('suit', cylGeo(0.052, 0.045, 0.24), 0.272, 1.34, -0.012, -0.55)        // 右上臂
    put('suit', cylGeo(0.044, 0.038, 0.22), 0.302, 1.33, -0.185, 1.3)          // 右小臂
    put('glove', boxGeo(0.078, 0.09, 0.1), -0.14, 1.24, -0.285)                // 左手（护木）
    put('glove', boxGeo(0.078, 0.09, 0.1), 0.2, 1.255, -0.3)                   // 右手（握把）

    // 躯干护甲：胸甲+前附层 / 骨盆 / 肩甲×2 / 背包 / 腰带 / 弹匣袋×2+袋盖 / 腰侧包 → vest
    put('vest', boxGeo(0.4, 0.36, 0.23), 0, 1.33, 0)
    put('vest', boxGeo(0.34, 0.3, 0.035), 0, 1.36, -0.125, 0.06)               // 前附板（微仰角）
    put('vest', boxGeo(0.36, 0.16, 0.21), 0, 0.95, 0)
    put('vest', new THREE.SphereGeometry(0.085, 12, 9), -0.24, 1.46, 0)
    put('vest', new THREE.SphereGeometry(0.085, 12, 9), 0.24, 1.46, 0)
    put('vest', boxGeo(0.28, 0.26, 0.1), 0, 1.33, 0.15)
    put('vest', boxGeo(0.385, 0.05, 0.235), 0, 1.155, 0)                       // 腰带
    put('vest', boxGeo(0.095, 0.085, 0.04), -0.1, 1.375, -0.14)                // 弹匣袋 L
    put('vest', boxGeo(0.095, 0.085, 0.04), 0.1, 1.375, -0.14)                 // 弹匣袋 R
    put('vest', boxGeo(0.1, 0.03, 0.045), -0.1, 1.415, -0.142, 0.12)           // 袋盖 L
    put('vest', boxGeo(0.1, 0.03, 0.045), 0.1, 1.415, -0.142, 0.12)            // 袋盖 R
    put('vest', boxGeo(0.07, 0.12, 0.04), -0.12, 1.12, -0.115)                 // 腰侧包
    put('vest', boxGeo(0.06, 0.1, 0.032), 0.14, 1.42, -0.06)                   // 肩挂电台

    // 红方识别肩章 → accent
    put('accent', boxGeo(0.07, 0.02, 0.12), -0.24, 1.525, 0)
    put('accent', boxGeo(0.07, 0.02, 0.12), 0.24, 1.525, 0)

    // 腿：髋部枢轴摆动；裤腿圆柱 + 靴 + 护膝
    const makeLeg = (side) => {
      const pivot = new THREE.Group(); pivot.position.set(side * 0.105, 0.88, 0)
      const leg = new THREE.Mesh(mergeGeometries([
        new THREE.CylinderGeometry(0.078, 0.066, 0.44).translate(0, -0.22, 0),   // 大腿
        new THREE.CylinderGeometry(0.064, 0.05, 0.42).translate(0, -0.61, 0.008),// 小腿
        boxGeo(0.14, 0.1, 0.16).translate(0, -0.34, -0.028),                     // 大腿挂包
      ], false), M.suit)
      const boot = new THREE.Mesh(mergeGeometries([
        boxGeo(0.13, 0.09, 0.26).translate(0, -0.838, -0.05),                    // 靴
        boxGeo(0.135, 0.05, 0.1).translate(0, -0.782, 0.07),                     // 后跟
      ], false), M.glove)
      const knee = new THREE.Mesh(boxGeo(0.13, 0.075, 0.05).translate(0, -0.43, -0.07), M.accent)
      pivot.add(leg, boot, knee)
      return pivot
    }
    const legL = makeLeg(-1)
    const legR = makeLeg(1)

    // 枪：机匣+圆柱枪管+弹匣+枪托+准星 → gun 桶
    put('gun', boxGeo(0.055, 0.09, 0.42), 0.13, 1.31, -0.28)
    put('gun', cylGeoZ(0.014, 0.24, 8), 0.13, 1.325, -0.6)
    put('gun', boxGeo(0.04, 0.13, 0.06), 0.13, 1.21, -0.31, 0.18)
    put('gun', boxGeo(0.045, 0.07, 0.16), 0.13, 1.305, 0)
    put('gun', boxGeo(0.012, 0.02, 0.03), 0.13, 1.37, -0.48)

    for (const [name, geos] of Object.entries(buckets)) {
      const mesh = new THREE.Mesh(mergeGeometries(geos, false), M[name])
      mesh.matrixAutoUpdate = false
      g.add(mesh)
    }

    // 接触阴影
    this.blobMat = new THREE.MeshBasicMaterial({ map: Tex.blob(), transparent: true, depthWrite: false })
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), this.blobMat)
    blob.rotation.x = -Math.PI / 2

    g.add(legL, legR)
    g.visible = false
    this.scene.add(g)
    this.scene.add(blob)

    this.mesh = g
    this.legL = legL; this.legR = legR
    this.blob = blob
    this.deathT = 0
    this.hitFlash = 0
    this.allMats = matsKey.map(k => M[k]).concat(this.blobMat)
  }

  // 用户自有 GLB 人物（agent.glb）：骨骼模型需 SkeletonUtils 克隆 + 每 bot 材质克隆
  _buildCustom() {
    const g = new THREE.Group()
    const clone = SkeletonUtils.clone(Bot.customTemplate)
    this.mats = {}
    let i = 0
    clone.traverse(o => {
      if (o.isMesh) {
        o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone()
        const m0 = Array.isArray(o.material) ? o.material[0] : o.material
        this.mats['m' + i++] = m0
        m0.userData.em ??= m0.emissive?.getHex() ?? 0   // 受击闪红后按原始值恢复
        m0.userData.emI ??= m0.emissiveIntensity ?? 1
        o.frustumCulled = false // 蒙皮网格包围盒不随骨骼更新，禁用裁剪防闪没
      }
    })
    g.add(clone)
    // 动画：idle/walk/run 多 clip 按移速加权混合；单 clip 老模型回退为
    // "移动时播放走路段、静止时 timeScale→0 冻结"（避免原地踏步）
    // 注意不能 stopAllAction()/uncacheRoot() —— 会把属性还原回 T-pose 绑定姿态
    const clips = Bot.customAnimations
    if (clips?.length) {
      this.mixer = new THREE.AnimationMixer(clone)
      const find = (re) => clips.find(c => re.test(c.name))
      let idle = find(/idle|stand/i)
      let walk = find(/walk/i)
      const run = find(/run|sprint/i)
      if (!walk && !run) { // BrainStem：单 clip，前 8s 是走路段（后面是头部变形演示）
        walk = clips[0].duration > 10 ? clips[0].clone().trim(0, 8) : clips[0]
      }
      const mk = (clip) => {
        const a = this.mixer.clipAction(clip)
        a.play()
        a.setEffectiveWeight(0)
        return a
      }
      this.anim = { walk: mk(walk) }
      if (idle && idle !== walk) this.anim.idle = mk(idle)
      if (run) this.anim.run = mk(run)
      this._animAcc = 0
      this._setAnimWeights(0)
      this.mixer.update(0)
    }
    this.blobMat = new THREE.MeshBasicMaterial({ map: Tex.blob(), transparent: true, depthWrite: false })
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), this.blobMat)
    blob.rotation.x = -Math.PI / 2
    g.visible = false
    this.scene.add(g); this.scene.add(blob)
    this.mesh = g
    this.legL = this.legR = null // 腿部摆动由动画驱动
    this.blob = blob
    this.deathT = 0
    this.hitFlash = 0
    this.allMats = [...Object.values(this.mats), this.blobMat]
  }

  // 骨骼动画权重：idle ↔ walk ↔ run 按移速平滑过渡；
  // timeScale 让脚步频率与实际位移同步（原地 clip ≈1.9m/s 步速、run clip ≈5.2m/s）
  _setAnimWeights(speed) {
    const A = this.anim
    if (!A) return
    const moveW = THREE.MathUtils.clamp((speed - 0.25) / 0.9, 0, 1)   // 起步/急停的淡入淡出
    const runW = A.run ? THREE.MathUtils.clamp((speed - 3.0) / 1.6, 0, 1) : 0
    if (A.idle) A.idle.setEffectiveWeight(1 - moveW)
    A.walk.setEffectiveWeight(moveW * (1 - runW) + (A.idle ? 0 : 1 - moveW))
    if (A.run) A.run.setEffectiveWeight(moveW * runW)
    const alias = !A.idle // 无独立 idle：静止时冻结在当前帧（timeScale=0）
    A.walk.timeScale = alias
      ? Math.min(speed / 1.9, 2.1)
      : THREE.MathUtils.clamp(speed / 1.9, 0.6, 2.1)
    if (A.run) A.run.timeScale = THREE.MathUtils.clamp(speed / 5.2, 0.9, 1.5)
  }

  _stepAnim(speed, dt) {
    if (!this.mixer) return
    this._setAnimWeights(speed)
    // 60Hz 采样足够平滑，省一半蒙皮计算（逻辑帧 128Hz）
    this._animAcc += dt
    if (this._animAcc >= 1 / 60) {
      this.mixer.update(this._animAcc)
      this._animAcc = 0
    }
  }

  hide() {
    this.active = false
    this.mode = 'idle' // 死亡动画播完：归位让对象池可复用（respawnAt 靠 BotManager 找回靶位）
    this.mesh.visible = false
    this.blob.visible = false
    this.visibleNow = false
    this.firstVisibleAt = -1
  }

  place(x, z, mode) {
    this.pos.set(x, 0, z)
    this.prevPos.copy(this.pos)
    this.hp = CONFIG.bot.health
    this.active = true
    this.mode = mode
    this.velX = 0
    this.mesh.visible = true
    this.blob.visible = true
    this.mesh.rotation.set(0, 0, 0)
    this.mesh.position.copy(this.pos)
    this.walkPhase = 0
    this.setOpacity(1)
    this.blobMat.opacity = 1
    this.spawnGuardUntil = this.now() + CONFIG.bot.spawnGuardMs / 1000
    this.firstVisibleAt = -1
    this.flinch = 0 // 复用的 Bot 不带旧受击踉跄
    if (this.mixer) { // 骨骼假人归位站姿，不带上一条的残留步态
      this.anim.walk.time = 0
      if (this.anim.run) this.anim.run.time = 0
      this._setAnimWeights(0)
      this.mixer.update(0)
      this._animAcc = 0
    }
  }

  setOpacity(o) {
    for (const m of Object.values(this.mats)) {
      m.transparent = o < 1
      m.opacity = o
    }
  }

  get invulnerable() { return this.now() < (this.spawnGuardUntil ?? 0) || !this.active || this.mode === 'dying' }
  now() { return this.manager ? this.manager.now() : performance.now() / 1000 } // 跟随游戏时钟（暂停时冻结）

  moveToward(targetVelX, dt) {
    const B = CONFIG.bot
    const target = targetVelX
    const a = (Math.abs(target) > Math.abs(this.velX) ? B.accel : B.decel) * dt
    if (this.velX < target) this.velX = Math.min(target, this.velX + a)
    else this.velX = Math.max(target, this.velX - a)
    this.pos.x += this.velX * dt
  }

  // 面向：模型正面为 -Z
  faceTowards(px, pz) {
    this.mesh.rotation.y = Math.atan2(-(px - this.pos.x), -(pz - this.pos.z))
  }

  startDeath() {
    this.mode = 'dying'
    this.deathT = 0
    this.velX = 0
    this.deathRoll = (vary() - 0.5) * 0.55 // 带随机侧倒更自然
    this.flinch = 0
  }

  step(dt, ctx) {
    this.prevPos.copy(this.pos)
    if (!this.active && this.mode !== 'dying') return

    if (this.mode === 'dying') {
      this.deathT += dt
      const t = Math.min(1, this.deathT / CONFIG.bot.deathTime)
      // 后仰倒地（ease-out 加速起步）+ 随机侧倒 + 轻微下沉
      const e = 1 - Math.pow(1 - t, 3)
      this.mesh.rotation.x = e * (Math.PI / 2) * 0.95
      this.mesh.rotation.z = this.deathRoll * e
      this.mesh.position.y = -e * 0.05
      this.blobMat.opacity = Math.max(0, 1 - t * 1.4)
      if (this.deathT > 0.75) this.setOpacity(Math.max(0, 1 - (this.deathT - 0.75) / 0.45))
      if (this.deathT > 1.2) this.hide()
      return
    }

    // 可见性 → 反应计时起点
    const p = ctx.player
    const eyeY = this.pos.y + 1.68
    this.visibleNow = this.world.lineOfSight(
      this.pos.x, eyeY, this.pos.z,
      p.pos.x, p.pos.y + p.eyeHeight, p.pos.z,
    )
    if (this.visibleNow && this.firstVisibleAt < 0) this.firstVisibleAt = this.now()

    // 命中闪光：恢复原始自发光（受击时被 flashHit 置红/白）
    if (this.hitFlash > 0) {
      this.hitFlash -= dt
      if (this.hitFlash <= 0) {
        for (const m of Object.values(this.mats)) {
          if (!m.emissive) continue
          m.emissive.setHex(m.userData?.em ?? 0)
          if (m.userData?.emI !== undefined) m.emissiveIntensity = m.userData.emI
        }
      }
    }

    // 朝向：移动时朝行进方向（与脚步方向一致），急停/静止时朝玩家；平滑转身
    const stopped = this.mode === 'peek' && this.peek?.stopUntil > this.now()
    let targetYaw
    if ((this.mode === 'peek' || this.mode === 'track') && Math.abs(this.velX) > 0.4 && !stopped) {
      targetYaw = this.velX > 0 ? -Math.PI / 2 : Math.PI / 2
    } else {
      targetYaw = Math.atan2(-(p.pos.x - this.pos.x), -(p.pos.z - this.pos.z))
    }
    let dy = targetYaw - this.mesh.rotation.y
    dy = Math.atan2(Math.sin(dy), Math.cos(dy)) // 取最短角差
    this.mesh.rotation.y += dy * Math.min(1, dt * 14)

    // 移动表现：程序化假人腿部摆动；骨骼假人播放混合动画（脚步与位移同步）
    const speed = Math.abs(this.velX)
    if (this.legL && this.legR) {
      if (speed > 0.3) {
        this.walkPhase += dt * (4 + speed * 2.4)
        const swing = Math.sin(this.walkPhase) * Math.min(0.62, 0.18 + speed * 0.085)
        this.legL.rotation.x = swing
        this.legR.rotation.x = -swing
        this.mesh.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.028
      } else {
        this.legL.rotation.x *= 1 - Math.min(1, dt * 10)
        this.legR.rotation.x *= 1 - Math.min(1, dt * 10)
        this.mesh.position.y = 0
      }
    } else if (this.mixer) {
      this._stepAnim(speed, dt)
    } else if (speed > 0.3) {
      this.walkPhase += dt * (4 + speed * 2.4)
      this.mesh.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.018
    } else {
      this.mesh.position.y *= 1 - Math.min(1, dt * 10)
    }

    // 受击踉跄：正弦冲击曲线 → 后仰 + 微沉（不影响朝向/命中判定）
    if (this.flinch > 0) {
      this.flinch = Math.max(0, this.flinch - dt * 5)
      const k = Math.sin(Math.min(1, this.flinch) * Math.PI)
      this.mesh.rotation.x = k * this.flinchAmp
      this.mesh.position.y -= k * 0.025
    }

    ctx.drive?.(this, dt)

    _v.copy(this.prevPos).lerp(this.pos, ctx.alpha ?? 1)
    this.mesh.position.x = _v.x
    this.mesh.position.z = _v.z
    this.blob.position.set(_v.x, 0.02, _v.z)
  }

  // 受击反馈：泛红自发光 + 踉跄（爆头白热闪 + 更强后仰）
  flashHit(head = false) {
    this.hitFlash = Math.max(CONFIG.bot.hitFlashTime, 0.11)
    this.flinch = 1
    this.flinchAmp = head ? 0.28 : 0.15
    const c = head ? 0xffd9cf : 0xff4630
    for (const m of Object.values(this.mats)) m.emissive?.setHex?.(c)
  }

  // 射线 vs 命中球体
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    if (this.invulnerable) return null
    let bestT = maxT, bestZone = null
    for (const z of this.zones) {
      const lx = this.pos.x - ox, ly = z.y - oy, lz = this.pos.z - oz
      const tca = lx * dx + ly * dy + lz * dz
      if (tca < 0) continue
      const d2 = lx * lx + ly * ly + lz * lz - tca * tca
      const r2 = z.r * z.r
      if (d2 > r2) continue
      const t = tca - Math.sqrt(r2 - d2)
      if (t < bestT) { bestT = t; bestZone = z.zone }
    }
    if (!bestZone) return null
    return { t: bestT, zone: bestZone, x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT }
  }
}
