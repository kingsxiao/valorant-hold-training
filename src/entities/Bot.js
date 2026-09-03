import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { CONFIG } from '../core/Config.js'
import { vary } from '../core/Rng.js'
import { Tex, pbr } from '../world/Textures.js'
import { raySphere } from '../world/World.js'

// 训练机器人 v6：
//  - 分段人形：头盔+发光面罩 / 护甲(3D 弹匣袋+袋盖+腰带) / 圆柱渐变四肢 / 手套 / VALORANT 横移步态
//  - 全部 PBR：颜色+粗糙度+法线贴图（程序化生成，纹理单例共享，材质按 bot 克隆）
//  - 命中区域球体（头/胸/腹/腿）与视觉对齐；移动模型与玩家一致
//  - 命中反馈：受击泛红闪 + 踉跄后仰（爆头更强）；死亡后仰倒地 + 侧倒 + 淡出消散
//  - 接触阴影；支持 agent.glb 骨骼模型整体替换（SkeletonUtils 克隆）：
//    idle/walk/run 按实际移速加权混合，脚步速率与位移同步 —— 拉出/横移真在跑；
//    单 clip 老模型（BrainStem）静止时 timeScale→0 冻结、移动时恢复
//  - 腿部遵循无畏契约运动规则：peek 面向目标持枪侧移（strafe）、步频与位移/
//    脚步声锁相、counter-strafe 急停即刻站定、身体向移动方向微倾
const STEP_LEN = 1.15 // 一步的位移（m）：脚步声触发与步态相位锁相共用
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
    this.stepDist = 0   // 脚步声里程（与位移同步）
    this.lean = 0       // 身体侧倾量（向移动方向倾，平滑跟踪局部横向速度）
    this.plantT = 0     // 急停卸力下沉的剩余时间
    this._prevSpeed = 0 // 检测"高速→近停"跨越，触发一次 plant settle
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
        head: pbr({ maps: Tex.robotJoint(), color: 0xb8bdc4, roughness: 0.5, metalness: 0.3 }),
        visor: visorMat,
        glove: pbr({ maps: Tex.fabric(), color: 0x4a4f57, roughness: 0.88 }),
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
    // 记录原始自发光（受击闪红后按此恢复）。注意 Material.clone 会深拷贝 userData，
    // 克隆之后才往基材写的字段不会出现在克隆体上 → 必须写在克隆体自己身上
    for (const [k, m] of Object.entries(Bot.baseMats())) {
      M[k] = m.clone()
      M[k].userData.em = m.emissive?.getHex() ?? 0
      M[k].userData.emI = m.emissiveIntensity ?? 1
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
    // 本实例独占的资源（dispose 用；克隆材质共享基材纹理，Geometry 均为逐 bot 合并产物）
    this._ownGeos = []
    g.traverse(o => { if (o.isMesh) this._ownGeos.push(o.geometry) })
    this._ownGeos.push(blob.geometry)
    this._ownMats = [...matsKey.map(k => M[k]), this.blobMat]
  }

  // 用户自有 GLB 人物（agent.glb）：骨骼模型需 SkeletonUtils 克隆 + 每 bot 材质克隆
  _buildCustom() {
    const g = new THREE.Group()
    const clone = SkeletonUtils.clone(Bot.customTemplate)
    this.mats = {}
    this._ownMats = []
    let i = 0
    clone.traverse(o => {
      if (o.isMesh) {
        o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone()
        const all = Array.isArray(o.material) ? o.material : [o.material]
        this._ownMats.push(...all)
        const m0 = all[0]
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
    // 克隆体与模板共享几何（不可释放）；仅接触阴影盘为本实例独占
    this._ownGeos = [blob.geometry]
    this._ownMats.push(this.blobMat)
  }

  // 从场景移除并释放本实例独占资源（回合重置时调用，防止切模式/重开局无限累积节点）
  dispose() {
    this.hide()
    this.scene.remove(this.mesh)
    this.scene.remove(this.blob)
    for (const m of this._ownMats ?? []) m.dispose?.()
    for (const geo of this._ownGeos ?? []) geo.dispose()
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
    // 脚步声步长 = 动画 cadence 换算（步/秒 → 米/步），声与腿同拍（音画锁相，
    // 与程序化假人的 STEP_LEN 锁相同规则）；idle 不算步，walk/run 权重归一
    let sps = 0, wSum = 0
    for (const a of [A.walk, A.run]) {
      if (!a) continue
      const w = a.getEffectiveWeight()
      sps += w * 2 * a.getEffectiveTimeScale() / a.getClip().duration
      wSum += w
    }
    this._audioStepLen = wSum > 0.01 && speed > 0.3 ? speed / (sps / wSum) : STEP_LEN
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

  // 程序化假人腿部：按无畏契约 strafe 运动规则驱动
  //  1) 步频与位移锁相：walkPhase 由里程推进（每 STEP_LEN 米 = 一步 = π），相位无跳变；
  //     摆动取 cos —— stepDist 越过 STEP_LEN 触发脚步声时 |cos|=1 正是落脚极值，音画同步
  //  2) 横移步态（cross-side-step）：双腿镜像侧摆（步距开合交替）+ 双髋同向偏转
  //     （脚尖朝行进方向）+ 步内小幅反摆；朝/背玩家移动的前后分量按局部速度方向混合
  //  3) counter-strafe 急停：硬站定快速收步（不做长缓动漂浮）+ 一次短促下沉卸力
  //  4) 身体向移动方向微倾（lean into strafe），急停时快速回正
  _stepLegs(speed, dt) {
    const legL = this.legL, legR = this.legR
    // 局部横向速度（模型正面 -Z、右侧 +X）：面向玩家横移时该分量为主
    const yaw = this.mesh.rotation.y
    const lx = this.velX * Math.cos(yaw)

    // 相位始终随位移推进（与 stepDist 同一积分），跨低速段也不失锁
    this.walkPhase += speed * dt * Math.PI / STEP_LEN

    if (speed > 0.3) {
      // 摆动取 cos：脚步声触发时 stepDist 整除 STEP_LEN → walkPhase = kπ → |cos|=1
      // 正是落脚（步距最开）的瞬间，声画严格同拍
      const s = Math.cos(this.walkPhase)
      const sp = Math.max(speed, 1e-4)
      const wLat = Math.min(1, Math.abs(lx) / sp)      // 横向权重：纯侧移 = 1
      const wFore = 1 - wLat
      const aLat = Math.min(0.36, 0.12 + speed * 0.058)
      const aFore = Math.min(0.62, 0.18 + speed * 0.085)
      // 镜像侧摆：步距张开-并拢交替（s=±1 为落脚支撑，s=0 双腿交叠过中点）
      legL.rotation.z = -s * aLat * wLat
      legR.rotation.z = s * aLat * wLat
      legL.rotation.x = s * aFore * wFore
      legR.rotation.x = -s * aFore * wFore
      // 双髋同向偏转：脚尖朝行进方向（脚位朝移动、上身持枪朝目标 = VALORANT strafe 姿态）
      const hipYaw = -Math.sign(lx || 1) * 0.26 * wLat + s * 0.12 * wLat
      legL.rotation.y = hipYaw
      legR.rotation.y = hipYaw
      // 步态起伏：落脚张开时最低（重心压上支撑步）、并腿过中点最高 —— 与脚步声同拍
      this.mesh.position.y = (1 - Math.abs(s)) * (0.01 + speed * 0.0036)
    } else {
      // 急停即刻站定：快速收步 + 高度归零（counter-strafe 是硬停，不做漂浮缓动）
      const k = 1 - Math.min(1, dt * 22)
      legL.rotation.x *= k; legL.rotation.y *= k; legL.rotation.z *= k
      legR.rotation.x *= k; legR.rotation.y *= k; legR.rotation.z *= k
      this.mesh.position.y *= k
    }

    // 身体侧倾：向移动方向倾（lean into strafe）；回正比起倾更快（急停干净利落）
    const leanTarget = THREE.MathUtils.clamp(-lx * 0.011, -0.05, 0.05)
    const leanRate = Math.abs(leanTarget) > Math.abs(this.lean) ? 8 : 18
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * leanRate)
    this.mesh.rotation.z = this.lean

    // counter-strafe 卸力：高速 → 近停瞬间触发一次短促下沉（重心急停的重量感）
    if (this._prevSpeed > 2.2 && speed <= 1.0) this.plantT = 0.16
    this._prevSpeed = speed
    if (this.plantT > 0) {
      this.plantT = Math.max(0, this.plantT - dt)
      this.mesh.position.y -= Math.sin(Math.PI * this.plantT / 0.16) * 0.03
    }
  }

  hide() {
    this.active = false
    this.mode = 'idle' // 死亡动画播完：归位让对象池可复用
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
    this.stepDist = 0
    this.lean = 0        // 复用的 Bot 归位站姿：不带旧侧倾/急停残余
    this.plantT = 0
    this._prevSpeed = 0
    if (this.legL) { this.legL.rotation.set(0, 0, 0); this.legR.rotation.set(0, 0, 0) }
    this.setOpacity(1)
    this.blobMat.opacity = 1
    this.spawnGuardUntil = this.now() + CONFIG.bot.spawnGuardMs / 1000
    this.firstVisibleAt = -1
    this.flinch = 0 // 复用的 Bot 不带旧受击踉跄
    this.hitFlash = 0
    this._restoreEmissive() // 也不带旧受击红光（如被击杀后立刻复用）
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
    // 指令归零/反向 = counter-strafe 急停：与玩家同规则享受反向减速倍率
    // （55×1.6=88 m/s²，5.4→0 约 61ms，peek 急停的节奏与真人一致）
    const counter = (targetVelX === 0 || this.velX * targetVelX < 0)
      ? CONFIG.movement.counterStrafeMult
      : 1
    const a = (Math.abs(targetVelX) > Math.abs(this.velX) ? B.accel : B.decel * counter) * dt
    if (this.velX < targetVelX) this.velX = Math.min(targetVelX, this.velX + a)
    else this.velX = Math.max(targetVelX, this.velX - a)
    this.pos.x += this.velX * dt
  }

  startDeath() {
    this.mode = 'dying'
    this.deathT = 0
    this.velX = 0
    this.deathRoll = (vary() - 0.5) * 0.55 // 带随机侧倒更自然
    this.flinch = 0
    // 死亡分支不走上面的闪光恢复路径（step 提前返回）——在此立即还原，
    // 否则击杀瞬间的受击红光会贯穿整个倒地动画与重生
    this.hitFlash = 0
    this._restoreEmissive()
  }

  // 还原各材质的原始自发光（受击闪红后的恢复路径统一走这里）
  _restoreEmissive() {
    for (const m of Object.values(this.mats)) {
      if (!m.emissive) continue
      m.emissive.setHex(m.userData?.em ?? 0)
      if (m.userData?.emI !== undefined) m.emissiveIntensity = m.userData.emI
    }
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
      if (this.hitFlash <= 0) this._restoreEmissive()
    }

    // 朝向：VALORANT peek 规则 —— 持枪面向对枪目标横移（strafe），不转身顺行进方向跑；
    // 骨骼假人例外：GLB 只有前进向 walk/run clip，侧移时放前进 clip 会滑步穿帮 → 移动时朝行进方向
    const stopped = this.mode === 'peek' && this.peek?.stopUntil > this.now()
    let targetYaw
    if (this.mixer && Math.abs(this.velX) > 0.4 && !stopped) {
      targetYaw = this.velX > 0 ? -Math.PI / 2 : Math.PI / 2
    } else {
      targetYaw = Math.atan2(-(p.pos.x - this.pos.x), -(p.pos.z - this.pos.z))
    }
    let dy = targetYaw - this.mesh.rotation.y
    dy = Math.atan2(Math.sin(dy), Math.cos(dy)) // 取最短角差
    this.mesh.rotation.y += dy * Math.min(1, dt * 14)

    // 移动表现：程序化假人 = VALORANT 横移步态；骨骼假人播放混合动画（脚步与位移同步）
    const speed = Math.abs(this.velX)
    // 脚步声：与位移同步的 HRTF 空间音 —— 架枪时可听声预判拉出方向与时机
    // （GLB 假人用动画 cadence 换算的步长，程序化假人用固定 STEP_LEN —— 两者都与腿同拍）
    this.stepDist += speed * dt
    if (this.stepDist > (this._audioStepLen ?? STEP_LEN)) {
      this.stepDist = 0
      this.manager?.audio?.footstep(
        { x: this.pos.x, z: this.pos.z },
        { pos: ctx.player.pos, yaw: ctx.player.yaw },
        true,
      )
    }
    if (this.legL && this.legR) {
      this._stepLegs(speed, dt)
    } else if (this.mixer) {
      this._stepAnim(speed, dt)
    } else if (speed > 0.3) {
      // 无动画的自定义模型兜底：至少保留位移节奏的起伏
      this.walkPhase += speed * dt * Math.PI / STEP_LEN
      this.mesh.position.y = Math.abs(Math.cos(this.walkPhase)) * 0.018
    } else {
      this.mesh.position.y *= 1 - Math.min(1, dt * 22)
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
      const t = raySphere(ox, oy, oz, dx, dy, dz, this.pos.x, z.y, this.pos.z, z.r)
      if (t !== null && t < bestT) { bestT = t; bestZone = z.zone }
    }
    if (!bestZone) return null
    return { t: bestT, zone: bestZone, x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT }
  }
}
