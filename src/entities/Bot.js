import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { CONFIG } from '../core/Config.js'
import { groundStep, accelFor } from '../core/GroundMotion.js'
import { peekFacingYaw, leanInto, strafeRampW, strafeStepPose } from '../core/PeekPose.js'
import { matchRigBones, bakeLocomotionClips, bakeDeathClips, smoothW } from '../core/GaitBake.js'
import { locoWeights, sampleIkAnchor, pickDeathSide, pickTurnClip, CROUCH_WALK_STEP, jumpFallBlend, JUMP_FALL_AFTER, gaitStepLen } from '../core/Locomotion.js'
import { solveGunAim, pickAimTarget, gunBobPose, stepDroppedGun, settleFlatQ, kickPose, solveTwoBoneIK, deriveGunHoldPoints, solveGripMount } from '../core/WeaponAim.js'
import { vary } from '../core/Rng.js'
import { Tex, pbr } from '../world/Textures.js'
import { raySphere } from '../world/World.js'

// 训练机器人 v6：
//  - 分段人形：头盔+发光面罩 / 护甲(3D 弹匣袋+袋盖+腰带) / 圆柱渐变四肢 / 手套 / VALORANT 横移步态
//  - 全部 PBR：颜色+粗糙度+法线贴图（程序化生成，纹理单例共享，材质按 bot 克隆）
//  - 命中区域球体（头/胸/腹/腿）与视觉对齐；移动模型与玩家一致
//  - 命中反馈：受击泛红闪 + 踉跄后仰（爆头更强）；死亡后仰塌倒 + 侧倒，尸体
//    与掉枪整局留存（corpse 模式：定格零开销）——池复用/回合结束/地图重建才回收
//  - 接触阴影；支持 agent.glb 骨骼模型整体替换（SkeletonUtils 克隆）：
//    idle/walk/run 按实际移速加权混合，clip 播放头由步态相位锁定驱动（速率恒
//    等于实际移速不滑步）；单 clip 老模型（BrainStem）静止时相位停走=冻结
//  - 腿部遵循无畏契约运动规则：拉出（pull）面向目标持枪侧移（strafe）、跑过
//    （cross）顺跑向前进跑姿 + 上身前倾；步频与位移/脚步声锁相、counter-strafe
//    急停即刻站定、身体向移动方向微倾
//  - GLB 只有前进向 clip：pull 的横移步态用程序化侧移覆盖腿骨骼 —— 躯干正对
//    玩家不扭腰（横移时上身压向 idle，持枪不甩臂），双腿镜像外展滑步 + 脚尖
//    微朝移动方向 + 并腿屈膝起伏（与程序化假人同套 VALORANT 步态口径），见
//    _stepStrafeGait；腿骨链不齐的老模型 pull 退回顺跑向（防滑步穿帮）
//  - 挂官方枪（Vandal/Phantom 池，kamae 官方手位）：枪体握把钉后手 WeaponPoint
//    （≈掌心，托底抵肩）、前手 IK 钉护木握点；世界空间解瞄准四元数——pull 对枪/
//    站定枪口追玩家眼、cross 顺跑向携枪（_stepGun）；
//    受击踉跄/开火后坐走脊柱骨骼覆盖（_applyUpperFlinch 共轭精确合成）；
//    死亡为骨骼化塌倒（bakeDeathClips 烘焙：盆骨后仰下沉+腿折叠+撒手）+
//    撒手掉枪弹道（WeaponAim.stepDroppedGun：抛落翻滚落地摆平）
const STEP_LEN = 1.55 // 一步的位移（m）：程序化假人/烘焙近似/无官方数据模型的相位
                      // 锁相基准（官方曲线集走 gaitStepLen：走 1.05/跑 1.54/横移跑
                      // 1.40，各族官方步距不同——160 轮；本值 = 跑族口径，与官方
                      // runN 实测 1.54 互证）
const JUMP_LAUNCH = 0.15   // 起跳蹬伸时长（JumpN 前 0.15s 是预备蹲，弧线在其后）
// 滞空换层常数（JUMP_FALL_AFTER/JUMP_FALL_FADE）在 Locomotion.js（jumpFallBlend）
const JUMP_V0 = 7.098      // 起跳竖直初速（m/s）：本体社区逐帧推导值（r/VALORANT
                           // "Valorant Physics, Derived"：跳高 1.2m = v0²/2g）
const JUMP_G = 21          // 空中重力（m/s²）：同源推导值；滞空 = 2·v0/g ≈ 0.676s
const STRAFE_STEP_LEN = 1.15 // 横移步距保持既有调校口径（pull 出场节奏 1 步/1.15m 已验收）
const BOT_EYE_Y = 1.68 // Bot 眼位（模型总高 1.8m 的眼部；可见性判定起点。注意与
// 玩家 CONFIG.movement.eyeHeight=1.65 是两个口径——玩家是相机高度、Bot 是模型眼骨位）
const _v = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _axX = new THREE.Vector3(1, 0, 0)
const _axZ = new THREE.Vector3(0, 0, 1)
// 128Hz 热路径复用暂存：locoWeights/gunBobPose 的入参出参（_bobZero 是
// runAdd 激活时程序化 bob 退位的常量零值——只读）
const _lwOut = { idle: 0, walkN: 0, runN: 0, walkS: 0, runS: 0, walkNoIdle: 0 }
const _bobOut = { dip: 0, sway: 0, roll: 0 }
const _bobZero = { dip: 0, sway: 0, roll: 0 }
const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _q4 = new THREE.Quaternion()
const _gv1 = new THREE.Vector3() // 挂枪：双 WeaponPoint 世界位置/中点
const _gv2 = new THREE.Vector3()
const _gBob = new THREE.Vector3() // 步伐随动：武器锚点偏移（世界系）
const _gaim = new THREE.Vector3() // 挂枪瞄准目标
const _gq1 = new THREE.Quaternion()
const _gq2 = new THREE.Quaternion()
const _gq3 = new THREE.Quaternion()
const _gq4 = new THREE.Quaternion()
const _gscl = new THREE.Vector3() // decompose 的 scale 占位
const _ikA = new THREE.Vector3() // 左手 IK：肩/肘/腕世界位置 + 目标
const _ikB = new THREE.Vector3()
const _ikC = new THREE.Vector3()
const _ikT = new THREE.Vector3()
const _ikDir = new THREE.Vector3()
const _chainW = new THREE.Quaternion() // 腿链覆盖：髋世界 → 逐骨下传的父级世界
const _curW = new THREE.Quaternion()
const _fpHip = new THREE.Vector3() // 脚钉地：髋/膝/脚世界位置 + 锚点
const _fpKnee = new THREE.Vector3()
const _fpFoot = new THREE.Vector3()
const _fpAnchor = new THREE.Vector3()
const _fpKneeWClip = new THREE.Quaternion() // 脚钉地：clip 膝世界 Q（脚朝向反旋转基准）
const _fpBlend = new THREE.Vector3() // 脚钉地：多锚源加权混合累加器
const _fpPole = new THREE.Vector3() // 脚钉地：膝极向参考点（髋前面）
const _fwdAxis = new THREE.Vector3() // 脚钉地：面朝方向暂存
const _IDENTITY = new THREE.Quaternion()
const _ZAXIS = new THREE.Vector3(0, 0, 1) // 枪轴滚转轴（holder 局部 Z = 枪管向）
const _headC = new THREE.Vector3() // 蹲姿头部区：Head 骨世界位暂存

export class Bot {
  static customTemplate = null   // 用户 GLB 模板（UserAssets 注入）
  static customAnimations = null // 模板动画 clips
  static customTemplates = null  // 多英雄模板池 [{root, clips}]（agent-*.glb，每 bot 随机一名）
  static weaponTemplates = null  // 官方枪模板池 {vandal, phantom}（main 注入归一化件克隆，每 bot 随机一把）
  static _baseMats = null        // 基础材质（纹理共享，逐 bot clone）
  static realShadows = false     // 真实阴影开启时隐藏 blob 接触阴影（防双重投影）

  constructor(scene, world) {
    this.scene = scene
    this.world = world
    this.id = Bot._id = (Bot._id ?? 0) + 1

    this.pos = new THREE.Vector3()
    this.prevPos = new THREE.Vector3()
    this.velX = 0
    this.velZ = 0
    this.mode = 'idle'
    this.active = false
    this.hp = CONFIG.bot.health
    this.firstVisibleAt = -1
    this.visibleNow = false
    this.walkPhase = 0
    this.lean = 0       // 身体侧倾量（向移动方向倾，平滑跟踪局部横向速度）
    this.foreLean = 0   // 上身前倾量（cross 顺跑向跑时的奔跑重心，负 rot.x）
    this._foreW = 0     // 步态的前进权重（wFore>0 时才前倾：侧移对枪保持上身立直）
    this.plantT = 0     // 急停卸力下沉的剩余时间
    this._prevSpeed = 0 // 上一 tick 速度（调试/平滑用）
    this._wasFast = false // 高速闩锁：本条命跑出过 >2.2 m/s（近停时据此触发卸力下沉）
    this.flinch = 0      // 受击踉跄相位（0~1+，衰减）
    this.flinchAmp = 0   // 本次踉跄后仰幅度
    this.deathRoll = 0   // 死亡侧倒角
    this.breath = 0      // 程序化假人 idle 呼吸相位（mixer 假人有 kamae 待机自带）
    this.breathW = 0     // 呼吸权重（静止淡入 / 移动快速淡出，防与步态叠加）
    this._yBase = 0      // 步态/急停的高度基线（呼吸偏移在其上绝对合成，防累积）

    // 命中区域：{ y, r, zone }
    // 命中区骨锚跟随：每区锚定其解剖骨（官方蹲姿=收拢球，头部/躯干/腿全部随
    // 骨位走，站姿 lift = 站姿区中心 − 站姿骨高实测）。蹲姿权重插值：
    // 中心 = lerp(站姿位, 骨世界位, 蹲姿权重)——蹲/起全程连续，render 即真相
    this.zones = [
      { y: 1.63, r: 0.13, zone: 'head', bone: 'Head', lift: -0.024 },
      { y: 1.3, r: 0.21, zone: 'body', bone: 'Spine2', lift: 0.159 },
      { y: 0.95, r: 0.2, zone: 'body', bone: 'Spine1', lift: -0.091 },
      { y: 0.55, r: 0.16, zone: 'leg', bone: 'L_Knee', lift: -0.153 },
      { y: 0.55, r: 0.16, zone: 'leg', bone: 'R_Knee', lift: -0.153 },
      { y: 0.22, r: 0.14, zone: 'leg', bone: 'L_Foot', lift: 0.11 },
      { y: 0.22, r: 0.14, zone: 'leg', bone: 'R_Foot', lift: 0.11 },
    ]

    this._buildMesh()
  }

  static baseMats() {
    if (!Bot._baseMats) {
      // 面罩 = 玻璃反光贴图 + 青色传感条自发光（机器人敌意识别点）
      const visorMat = pbr({ maps: Tex.visor(), roughness: 0.12, metalness: 0.6 })
      visorMat.emissiveMap = Tex.visorGlow()
      visorMat.emissive = new THREE.Color(0x7fdcff)
      visorMat.emissiveIntensity = 1.5
      Bot._baseMats = {
        suit: pbr({ maps: Tex.suit(), roughness: 0.9 }),
        vest: pbr({ maps: Tex.vest(), roughness: 0.7 }),
        head: pbr({ maps: Tex.robotJoint(), color: 0xb8bdc4, roughness: 0.5, metalness: 0.3 }),
        visor: visorMat,
        glove: pbr({ maps: Tex.fabric(), color: 0x4a4f57, roughness: 0.88 }),
        accent: new THREE.MeshStandardMaterial({ color: 0xe84b55, roughness: 0.55, emissive: 0x55131a }),
        gun: pbr({ maps: Tex.metal(), roughness: 0.45, metalness: 0.75 }),
      }
    }
    return Bot._baseMats
  }

  _buildMesh() {
    if (Bot.customTemplate || Bot.customTemplates?.length) return this._buildCustom()
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
      mesh.castShadow = true // Bot 投真实阴影（blob 接触阴影在其关闭时兜底）
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

  // 用户自有 GLB 人物（agent.glb / 无畏契约英雄池 agent-*.glb）：骨骼模型需
  // SkeletonUtils 克隆 + 每 bot 材质克隆
  _buildCustom() {
    const g = new THREE.Group()
    // 多英雄模板池：每只 Bot 随机一名英雄；单模板（旧 agent.glb）走原字段
    const pool = Bot.customTemplates?.length
      ? Bot.customTemplates
      : [{ root: Bot.customTemplate, clips: Bot.customAnimations }]
    const tpl = pool[Math.floor(Math.random() * pool.length)]
    const clone = SkeletonUtils.clone(tpl.root)
    this.mats = {}
    this._ownMats = []
    let i = 0
    clone.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true
        o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone()
        const all = Array.isArray(o.material) ? o.material : [o.material]
        this._ownMats.push(...all)
        // 全部材质都入 mats：flashHit/setOpacity/_restoreEmissive 都遍历 mats，
        // 多材质网格只注册首个会让其余子网格不闪红、死亡淡出时保持不透明
        for (const m0 of all) {
          this.mats['m' + i++] = m0
          m0.userData.em ??= m0.emissive?.getHex() ?? 0   // 受击闪红后按原始值恢复
          m0.userData.emI ??= m0.emissiveIntensity ?? 1
        }
        o.frustumCulled = false // 蒙皮网格包围盒不随骨骼更新，禁用裁剪防闪没
      }
    })
    g.add(clone)
    // 横移步态骨链（mixer 首次 update 前的 bind 姿态捕获 mesh 空间基准四元数）：
    // 髋（父级四元数来源）+ 双腿大腿/小腿/脚/趾。骨名匹配 UE（无畏契约英雄 GLB：
    // Pelvis_0131 / L_Hip_0136…，见 core/GaitBake.RIG_MATCH）与 Mixamo 双口径。
    // 链不齐（老模型）→ null：pull 波退回顺跑向（侧移放前进 clip 会滑步穿帮）
    g.updateMatrixWorld(true)
    const rig = matchRigBones(clone)
    const bindOf = (b) => b.getWorldQuaternion(new THREE.Quaternion()) // g 为恒等根 = mesh 空间
    // 命中区骨锚解析：psa 无后缀名 ↔ GLB _NNNN 后缀（蹲姿命中区跟随骨位）
    for (const z of this.zones) {
      if (!z.bone) continue
      clone.traverse(o => {
        if (!z._boneObj && o.isBone && o.name.replace(/_\d+$/, '') === z.bone) z._boneObj = o
      })
    }
    let rigLegs = []
    if (rig) {
      rigLegs = rig.legs.map(l => ({
        side: l.side, up: l.up, knee: l.knee, foot: l.foot, toe: l.toe,
        bind: { up: bindOf(l.up), knee: bindOf(l.knee), foot: bindOf(l.foot), toe: bindOf(l.toe) },
      }))
    }
    this._strafeRig = rig ? { hips: rig.hips, hipsBind: bindOf(rig.hips), legs: rigLegs } : null
    // 死亡塌倒烘焙 + 受击脊柱覆盖层的 bind 基准（mixer 首次 update 前的
    // kamae 绑定姿态）：盆骨父级/自身世界四元数、盆骨世界高、脊柱/颈世界基准
    this._rigExtra = null
    this.deathClip = null
    this.gun = null
    this._drop = null
    if (rig) {
      const spineBindW = rig.spine.map(b => b.getWorldQuaternion(new THREE.Quaternion()))
      const neckBindW = rig.neck ? rig.neck.getWorldQuaternion(new THREE.Quaternion()) : null
      this._rigExtra = { spine: rig.spine, neck: rig.neck, spineBindW, neckBindW }
      this.deathClip = bakeDeathClips({
        hipsBone: rig.hips,
        hipsParentW: rig.hips.parent.getWorldQuaternion(new THREE.Quaternion()),
        hipsBindW: rig.hips.getWorldQuaternion(new THREE.Quaternion()),
        hipsBindY: rig.hips.getWorldPosition(new THREE.Vector3()).y,
        legs: rigLegs,
        spineBones: rig.spine, spineBindW,
        neckBone: rig.neck, neckBindW,
        arms: rig.arms ?? [],
      })
      // 挂官方枪（Vandal/Phantom 池随机一把）：kamae 后手 WeaponPoint（≈掌心）
      // 钉枪体握把、前手 IK 钉护木握点——官方双手架枪位。holder 挂 mesh 下、
      // 逐帧世界空间解瞄准（_stepGun），枪口追目标；材质逐 bot 克隆（受击闪红/
      // 死亡淡出含枪）
      const wtpl = Bot.weaponTemplates
      const wkeys = wtpl ? Object.keys(wtpl) : []
      if (wkeys.length && rig.weaponL && rig.weaponR) {
        const gun = wtpl[wkeys[(Math.random() * wkeys.length) | 0]].clone(true)
        let gi = 0
        gun.traverse(o => {
          if (!o.isMesh) return
          o.castShadow = true
          o.frustumCulled = false
          o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone()
          for (const m0 of (Array.isArray(o.material) ? o.material : [o.material])) {
            this.mats['gun' + gi++] = m0
            m0.userData.em ??= m0.emissive?.getHex() ?? 0   // 受击闪红后按原始值恢复
            m0.userData.emI ??= m0.emissiveIntensity ?? 1
            this._ownMats.push(m0)
          }
        })
        const holder = new THREE.Group()
        // 微下沉：握把落向后手。⚠ 只减 y——归一化模板根节点带居中偏移
        //（normalizeViewmodel 的 vm.position = −center），set 会把整枪平移出位
        gun.position.y -= 0.02
        // 枪体双手握点：derive 在「根变换已生效的摆放系」采样（顶点经 matrixWorld
        // 已含 gun.position 平移）→ 返回值即 holder 系，直接作挂枪钉位/左手 IK 目标。
        // grip=后握把（钉后手）、fore=护木
        const hold = deriveGunHoldPoints(gun) ?? { grip: new THREE.Vector3(0, 0, 0.18), fore: new THREE.Vector3(0, 0, -0.18) }
        holder.add(gun)
        holder.updateMatrixWorld(true)
        const bb = new THREE.Box3().setFromObject(gun)
        const muzzle = bb.getCenter(new THREE.Vector3())
        muzzle.z = bb.min.z // 枪口 = -Z 端（UserAssets.normalizeViewmodel 约定）
        const muzzleLocal = holder.worldToLocal(muzzle)
        this.gun = {
          holder, gun,
          boneL: rig.weaponL, boneR: rig.weaponR,
          armL: rig.arms?.find(a => a.side === 'L') ?? null, // 左手两骨 IK 链（肩/肘）
          hold,
          gunBase: gun.position.clone(),
          muzzleLocal,
          aimQ: new THREE.Quaternion(), kick: 0, init: false,
        }
        g.add(holder)
      }
    }
    // 动画：idle/walk/run 多 clip 按移速加权混合；单 clip 老模型回退为
    // "移动时播放走路段、静止时冻结在当前帧"（避免原地踏步）
    // 注意不能 stopAllAction()/uncacheRoot() —— 会把属性还原回 T-pose 绑定姿态
    const clips = tpl.clips
    if (clips?.length) {
      this.mixer = new THREE.AnimationMixer(clone)
      const find = (re) => clips.find(c => re.test(c.name))
      let idle = find(/idle|stand|kamae/i) // kamae：无畏契约英雄 GLB 的持枪站姿待机 clip
      let walk = find(/walk/i)
      let run = find(/run|sprint/i)
      const official = tpl.locomotion ?? null // 官方 .psa 曲线集（UserAssets 按 hero 解析）
      if (!walk && !run && official) {
        // 官方骨骼曲线直接播放（Rocklan 官方 .psa：Jett/Sova 走跑 + Sova 横移
        // E/W；与英雄 GLB 同源同约定——kamae=psa Aim 站姿逐骨 0.0° 实测）。
        // 播放头同样由步态相位锁定（周期=官方时长，速率恒等于实际移速；
        // STEP_LEN 1.55 取官方步距 1.44~1.62 中值，≤5% 滑步与烘焙口径一致）
        walk = official.walk
        run = official.run
        this._officialLo = true
      }
      if (!walk && !run && rig) {
        // 无畏契约英雄 GLB 只有 kamae 待机：走/跑 clip 用步态数学现场烘焙
        // （周期 2×STEP_LEN/参考速度，_setAnimWeights 从步态相位锁定播放头，
        // 播放速率恒等于实际移速不滑步；手臂不出轨道 = 跑动保持持枪姿态）
        const baked = bakeLocomotionClips({
          hipsBone: rig.hips, legs: rigLegs,
          spineBones: rig.spine, neckBone: rig.neck,
          stepLen: STEP_LEN,
        })
        if (baked) { walk = baked.walk; run = baked.run }
      } else if (!walk && !run) { // BrainStem：单 clip，前 8s 是走路段（后面是头部变形演示）
        walk = clips[0].duration > 10 ? clips[0].clone().trim(0, 8) : clips[0]
      }
      const mk = (clip) => {
        const a = this.mixer.clipAction(clip)
        a.play()
        a.setEffectiveWeight(0)
        return a
      }
      // 兜底：clips 只匹配到 run 而无 walk 时（或烘焙失败）上面三个分支全被
      // !walk&&!run 前置条件跳过，walk 保持 null → mk(null) 直接抛 TypeError
      //（clipAction 读 null.uuid）。取首 clip 占位：权重 0 + 播放头步态锁定，
      // 单 clip 兜底与 BrainStem 分支同口径
      walk ??= clips[0].duration > 10 ? clips[0].clone().trim(0, 8) : clips[0]
      this.anim = { walk: mk(walk) }
      // walk/run 播放头由 _setAnimWeights 从步态相位锁定驱动 → timeScale=0 让
      // mixer.update 只采样不推进（idle 保持自由跑：待机呼吸循环）
      this.anim.walk.timeScale = 0
      if (idle && idle !== walk) {
        this.anim.idle = mk(idle)
        // kamae 待机 PingPong（前放-倒放）：英雄 GLB 的 kamae 不是循环制作
        // （Sage 18s 版实测回卷 L_Hip 跳 30.9°——LoopRepeat 每 18s 一次整骨
        // 跳变）；待机是往返摆动，倒放观感等价
        this.anim.idle.loop = THREE.LoopPingPong
      }
      if (run) { this.anim.run = mk(run); this.anim.run.timeScale = 0 }
      // 官方横移 E/W 动作对（pull 面向玩家侧移时取代程序化侧移腿覆盖）
      if (official?.strafe) {
        this.anim.strafe = {}
        for (const side of ['E', 'W']) {
          this.anim.strafe[side] = {
            walk: mk(official.strafe[side].walk),
            run: mk(official.strafe[side].run),
          }
          this.anim.strafe[side].walk.timeScale = 0
          this.anim.strafe[side].run.timeScale = 0
        }
      }
      if (this.deathClip) { // 死亡塌倒 clip：常态零权重，startDeath 时接管
        this.deathAction = this.mixer.clipAction(this.deathClip)
        this.deathAction.play()
        this.deathAction.setEffectiveWeight(0)
      }
      // 官方死亡整身 clip（背摔/前扑，TP_Core Death Splat）：优先于烘焙塌倒；
      // LoopOnce 播一次停在终 pose（corpse 定格 = 尸体姿势）
      if (official?.death && (official.death.back || official.death.front)) {
        this.deathActions = {}
        for (const side of ['back', 'front']) {
          const clip = official.death[side]
          if (!clip) continue
          const a = this.mixer.clipAction(clip)
          a.loop = THREE.LoopOnce
          a.clampWhenFinished = true
          a.play()
          a.setEffectiveWeight(0)
          this.deathActions[side] = a
        }
      }
      // 跑动上身叠加层（加法，官方胸口随步频运动 + 枪锚随动）：播放头随 run
      // 相位锁拍（_setAnimWeights），权重随跑态
      if (official?.runAdd) {
        this.anim.runAdd = {}
        for (const [side, clip] of Object.entries(official.runAdd)) {
          if (!clip) continue
          const a = this.mixer.clipAction(clip)
          a.play()
          a.setEffectiveWeight(0)
          a.timeScale = 0
          this.anim.runAdd[side] = a
        }
        this._runAddKeys = Object.keys(this.anim.runAdd) // 静态键缓存（同 _turnKeys）
      }
      // 停步转身踏步（8 向）：自然速率自走（选型时 reset 重播），权重由停步坡控制
      if (official?.turn) {
        this.anim.turn = {}
        for (const [key, clip] of Object.entries(official.turn)) {
          if (!clip) continue
          const a = this.mixer.clipAction(clip)
          a.play()
          a.setEffectiveWeight(0)
          this.anim.turn[key] = a
        }
        // 键集合静态：缓存供 128Hz 热路径遍历（Object.values/entries 每 tick
        // 分配数组+键值对）
        this._turnKeys = Object.keys(this.anim.turn)
      }
      // 蹲踞待机（官方蹲姿循环，自由跑；权重坡合成下蹲/起立过渡）
      if (official?.crouchIdle) {
        const a = this.mixer.clipAction(official.crouchIdle)
        a.play()
        a.setEffectiveWeight(0)
        this.anim.crouchIdle = a
      }
      // 蹲走拉出 E/W（官方蹲走循环，播放头由专用蹲走步幅相位锁定）
      if (official?.crouchWalk) {
        this.anim.crouchWalk = {}
        for (const [side, clip] of Object.entries(official.crouchWalk)) {
          if (!clip) continue
          const a = this.mixer.clipAction(clip)
          a.play()
          a.setEffectiveWeight(0)
          a.timeScale = 0
          this.anim.crouchWalk[side] = a
        }
        this._cwKeys = Object.keys(this.anim.crouchWalk) // 静态键缓存（同 _turnKeys）
      }
      // 跳 peek：JumpN（起跳蹬伸→空中收腿，LoopOnce 保持）+ JumpLand（落地恢复）
      if (official?.jump) {
        for (const [key, clip] of Object.entries(official.jump)) {
          if (!clip) continue
          const a = this.mixer.clipAction(clip)
          if (key === 'fall') {
            // Falling 滞空循环：自然重复（不合入 LoopOnce 组）
            a.play()
            a.setEffectiveWeight(0)
            this.anim.fall = a
            continue
          }
          a.loop = THREE.LoopOnce
          a.clampWhenFinished = true
          a.play()
          a.setEffectiveWeight(0)
          this.anim[key === 'jumpN' ? 'jump' : 'jumpLand'] = a
        }
      }
      // 急停支架（加法层叠在 kamae 上）：播完定格（clampWhenFinished）= 支架保持
      if (official?.stopAdd) {
        const a = this.mixer.clipAction(official.stopAdd)
        a.loop = THREE.LoopOnce
        a.clampWhenFinished = true
        a.play()
        a.setEffectiveWeight(0)
        this.anim.stopAdd = a
      }
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

  // 骨骼动画权重：idle ↔ walk ↔ run 按移速平滑过渡 × 前进(N)/横移(E/W) 正交分配
  // （locoWeights 纯函数）。clip 播放头由步态相位直接驱动（walkPhase → time，
  // 官方曲线周期=官方时长、烘焙曲线周期=2×STEP_LEN/参考速度）——播放速率恒等
  // 于实际移速（不滑步），走/跑/横移同相（混合中落脚帧一致）、站定相位停走 =
  // 冻结在当前帧，恢复移动不跳相位。timeScale 恒 0：mixer.update 不自行推进。
  // 权重本身过 smoothW 时间常数：纯速度映射在摩擦急停下会瞬跳（速度带
  // 1.15→0.25 只占急停最后 ~30ms，腿从中摆位「瞬移」到站姿）；淡出 ~143ms 让
  // 收腿读作一次干净的并步（起步淡入仍跟速度，即走即起）
  _setAnimWeights(speed, dt = 0) {
    const A = this.anim
    if (!A) return
    const moveTarget = THREE.MathUtils.clamp((speed - 0.25) / 0.9, 0, 1)   // 起步/急停的淡入淡出
    const runTarget = A.run ? THREE.MathUtils.clamp((speed - 3.0) / 1.6, 0, 1) : 0
    // kamae↔步态的入坡 8/s（125ms 全幅）：kamae 站姿与步幅姿态差 ~200°，22/s
    // 的 45ms 全幅交换被 60Hz mixer 门量化成单帧 65°+ 的姿态突扫（读作瞬移/
    // 抽动）；125ms 与 0→5.4 的 ~290ms 加速段匹配（第一步迈出时身体还在提速）
    this._moveW = smoothW(this._moveW ?? 0, moveTarget, dt, 8, 7)
    // 走↔跑入坡 10/s：同相位下 walkN/runN 步幅几何差 ~100°，22/s 被 60Hz 门
    // 量化成单帧 35°+ 突扫；换挡本就该渐进（移速连续爬升）
    this._runW = smoothW(this._runW ?? 0, runTarget, dt, 10, 7)
    const W = locoWeights({
      moveW: this._moveW, runW: this._runW,
      strafeW: this._strafeW, hasStrafe: !!A.strafe,
    }, _lwOut) // 复用暂存：128Hz 每 tick 一只入参+返回对象纯 GC churn
    // 蹲踞时 idle（全身站立待机）按蹲姿权重退缩——否则站立腿型与蹲姿五五混
    // 合（半蹲脚悬空，贴地跟踪跟着追不上）
    if (A.idle) A.idle.setEffectiveWeight(W.idle * (1 - (this._crouchW ?? 0)))
    // 蹲走权威：蹲走起来时站姿 loco 层（走/跑/横移）按 (1−cwWW) 退缩——否则
    // mixer 归一化把 crouchWalk/strafeWalk/crouchIdle 摊成三份，蹲姿被稀释成
    // 三分之一（实测骨盆高 0.92 vs 官方 0.825，浅蹲 9cm + 膝屈不足；165 轮。
    // 160 轮只给锚管道加了 locoK/cwW 门，姿态权重从未同步——滑速探针量不出
    // 姿态稀释，锚已经把脚钉住了）
    const cwK = 1 - Math.min(1, Math.max(0, this._crouchWW ?? 0))
    A.walk.setEffectiveWeight((A.idle ? W.walkN : W.walkNoIdle) * cwK)
    if (A.run) A.run.setEffectiveWeight(W.runN * cwK)
    const ph = ((this.walkPhase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    A.walk.time = (ph / (Math.PI * 2)) * A.walk.getClip().duration
    if (A.run) A.run.time = (ph / (Math.PI * 2)) * A.run.getClip().duration
    // 横移 E/W：官方曲线与前进同相位基准（官方横移步距≈前进步距，无需
    // STRAFE_STEP_LEN 换算——那套 1.15m 节奏只属于程序化侧移覆盖）
    if (A.strafe) {
      const S = A.strafe[this._strafeSide ?? 'E']
      S.walk.setEffectiveWeight(W.walkS * cwK)
      S.run.setEffectiveWeight(W.runS * cwK)
      S.walk.time = (ph / (Math.PI * 2)) * S.walk.getClip().duration
      S.run.time = (ph / (Math.PI * 2)) * S.run.getClip().duration
      // 非当前侧的对侧动作压零（防 _strafeSide 切换后残留权重）
      const other = A.strafe[this._strafeSide === 'W' ? 'E' : 'W']
      other.walk.setEffectiveWeight(0)
      other.run.setEffectiveWeight(0)
    }
    // 跑动上身叠加层（不在 strafe 块内：cross 无横移集也要吃 N 向）：E/W 侧别
    // 与横移跑同侧，播放头同相位锁拍（加法层随跑态淡入淡出——权重即
    // W.runN/W.runS，与前进/横移跑严格同源）
    if (A.runAdd) {
      const addSide = this._strafeW > 0.5 ? (this._strafeSide ?? 'E') : 'N'
      for (const s of this._runAddKeys) {
        const a = A.runAdd[s]
        a.time = (ph / (Math.PI * 2)) * a.getClip().duration
        a.setEffectiveWeight(s === addSide ? (W.runN + W.runS) * cwK : 0)
      }
    }
  }

  _stepAnim(speed, dt) {
    if (!this.mixer) return
    this._setAnimWeights(speed, dt)
    // 60Hz 采样足够平滑，省一半蒙皮计算（逻辑帧 128Hz）。每次 update 后快照
    // 腿骨骼的 clip 原值——程序化侧移覆盖以它为混合基准（未跑 update 的帧
    // 沿用最近快照，≤16ms 滞后与整体位姿一致）
    this._animAcc += dt
    if (this._animAcc >= 1 / 60) {
      this.mixer.update(this._animAcc)
      this._animAcc = 0
      this._snapshotClipPose()
    }
  }

  // 每次 mixer.update 后快照被程序化覆盖的骨骼 clip 原值——侧移腿覆盖（含盆骨）
  // 与受击脊柱覆盖都以它为混合基准（未跑 update 的帧沿用最近快照，≤16ms 滞后一致）
  _snapshotClipPose() {
    const rig = this._strafeRig
    if (rig) {
      (rig.hips.userData._clipQ ??= new THREE.Quaternion()).copy(rig.hips.quaternion)
      for (const leg of rig.legs) {
        for (const b of [leg.up, leg.knee, leg.foot, leg.toe]) {
          (b.userData._clipQ ??= new THREE.Quaternion()).copy(b.quaternion)
        }
      }
    }
    const ex = this._rigExtra
    if (ex) {
      for (const b of ex.spine) (b.userData._clipQ ??= new THREE.Quaternion()).copy(b.quaternion)
      if (ex.neck) (ex.neck.userData._clipQ ??= new THREE.Quaternion()).copy(ex.neck.quaternion)
    }
  }

  // 挂枪步进：握把钉位 + 手线定向。kamae 的 R_WeaponPoint ≈ 后手掌心（实测在腕
  // 骨前 ~9cm）：把枪体握把点（deriveGunHoldPoints 几何推导）钉在后手上——托底
  // 板自然抵肩窝、枪口略越前手，本体持枪形态 = 官方双手架枪位（旧锚点公式把枪
  // 心放后手前 0.365m，握把离后手 0.58m 悬空穿帮）。朝向沿手线解瞄准——pull 对
  // 枪/站定枪口追玩家眼、cross 顺跑向携枪。holder 挂 mesh 下，局部 = mesh⁻¹·world
  _stepGun(dt, player, stopped) {
    const G = this.gun
    if (!G) return
    G.boneR.updateWorldMatrix(true, false)
    G.boneR.matrixWorld.decompose(_gv1, _gq1, _gscl)
    G.boneL.updateWorldMatrix(true, false)
    G.boneL.matrixWorld.decompose(_gv2, _gq2, _gscl)
    _gv2.sub(_gv1) // 手线向量（后手 → 前手 = 枪口向）
    if (_gv2.lengthSq() < 1e-6) return
    _gv2.normalize()
    const moving = Math.abs(this.velX) > 0.4
    // 步伐随动（漂浮感主消）：跑动中武器锚点随步频 dip/sway——本体跑动枪不是
    // 焊死在胸口，落脚后武器惯性下沉、左右脚交替横摆。锚点平移而瞄准点不动
    // （枪口纪律不受扰，方向偏移仅 8mm/4m≈0.1°），左手 IK 随握点自动跟随 =
    // 手臂给枪让位的真实弹性，后手让位 ≤8mm 读作握持旷量。幅度随移速渐强、
    // 急停随速度淡出（gunBobPose 纯函数，单测锁值）
    // 官方 runAdd 加法层激活时枪锚骨（WeaponPoint）自己随步频动 = 官方武器
    // 随动；程序化 bob 退位（两套叠加会双重起伏），只在不官方时兜底
    const bob = this.anim?.runAdd ? _bobZero
      : gunBobPose({ phase: this.walkPhase, speed: Math.abs(this.velX) }, _bobOut)
    if (bob.dip !== 0 || bob.sway !== 0) {
      _gBob.set(-_gv2.z, 0, _gv2.x).normalize() // 手线的水平垂直向（重心横摆方向）
      _gBob.multiplyScalar(bob.sway)
      _gBob.y = bob.dip
      _gv1.add(_gBob)
    }
    _gaim.copy(_gv1).addScaledVector(_gv2, 4) // 手线远点（默认目标）
    if (pickAimTarget({ style: this.peek?.style, stopped, moving }) === 'player') {
      // 枪口全权重钉玩家眼位（167 轮起移动中同样 k=1）：瞄准目标里混手线分量
      // （旧 moving k=0.5）会把 kamae 携枪方向（偏离瞄准向 ~17°）的一半留在枪口
      // 上——13m 外实测枪口指着目标旁 ~2m（7~9°），读作「人没对准我」。扫入
      // 过渡感由下方 aimQ.slerp 的时间常数承担（出场从携枪位压向玩家 ~70ms 摆
      // 过去）；瞄准目标不再依赖手线 = 无待机呼吸→枪口画圈的闭环（k=1 的前提
      // 本来就是这个）
      _gaim.set(player.pos.x, player.pos.y + player.eyeHeight, player.pos.z)
    }
    solveGunAim(_gv1, _gaim, _gq3)
    if (!G.init) { G.aimQ.copy(_gq3); G.init = true } // 出场首帧直接落位不甩枪
    else G.aimQ.slerp(_gq3, Math.min(1, dt * 14))
    _gq4.copy(this.mesh.quaternion).invert()
    G.holder.quaternion.copy(_gq4).multiply(G.aimQ)
    if (bob.roll !== 0) { // 枪轴微倾：绕 holder 局部 Z（=枪管轴）滚转，不甩枪口
      G.holder.quaternion.multiply(_gq1.setFromAxisAngle(_ZAXIS, bob.roll))
    }
    // 握把钉位：解 holder 位置使枪上握把点世界位 = 后手（步初 _gv1）
    solveGripMount(_gv1, this.mesh.position, this.mesh.quaternion,
      _gq3.copy(this.mesh.quaternion).multiply(G.holder.quaternion), G.hold.grip, G.holder.position)
    G.gun.position.z = G.kick > 0 ? kickPose(G.kick).gunZ : 0
    this._stepHandIK()
  }

  // 左手两骨 IK：肩-肘链把 L_Hand 钉在枪上护木握点（紧随 _stepGun）。目标 =
  // fore 握点世界位——瞄准把枪转开时手随枪走（真实持枪，手不离护木），臂展不
  // 够由 IK 距离钳制自然前伸。解算的旋转增量为零起点（极向量=当前上臂方向），
  // Δ_world 用共轭落到骨局部——⚠ 方向向量全部来自 matrixWorld = 场景系，父级
  // 四元数必须前乘 meshQ 升到场景系（_boneWorldQ 只给 mesh 系，差一个 bot
  // 朝向/侧倾，共轭会被拧错方向）
  _stepHandIK() {
    const G = this.gun
    const arm = G?.armL
    if (!arm) return
    arm.up.updateWorldMatrix(true, false)
    arm.up.matrixWorld.decompose(_ikA, _gq1, _gscl)   // 肩
    arm.fore.updateWorldMatrix(true, false)
    arm.fore.matrixWorld.decompose(_ikB, _gq2, _gscl) // 肘
    arm.hand.updateWorldMatrix(true, false)
    arm.hand.matrixWorld.decompose(_ikC, _gq3, _gscl) // 腕（kamae 前手）
    // fore 握点世界位：holder 系常量 → 经 holder 世界位姿升 mesh 系 → 世界
    _gq4.copy(this.mesh.quaternion).multiply(G.holder.quaternion)
    _ikT.copy(G.hold.fore).applyQuaternion(_gq4).add(G.holder.position)
    _ikT.applyQuaternion(this.mesh.quaternion).add(this.mesh.position)
    const sol = solveTwoBoneIK({ shoulder: _ikA, elbow: _ikB, hand: _ikC, target: _ikT })
    if (!sol) return
    // 肩骨：Δ_world = R(abDirCur → dirAb)，共轭到锁骨系（场景系）
    const clavW = this._boneWorldQ(arm.up.parent, _chainW).premultiply(this.mesh.quaternion)
    _gq1.setFromUnitVectors(sol.abDirCur, sol.dirAb)
    arm.up.quaternion.premultiply(_gq2.copy(clavW).invert().multiply(_gq1).multiply(clavW))
    // 肘骨：段方向 = L_Hand 在肘骨系的位置方向（常量），经新肩世界 Q 传播后
    // 转向 dirCb（指向握点）
    _gq3.copy(clavW).multiply(arm.up.quaternion) // 新肩世界 Q（场景系）
    _ikDir.copy(arm.hand.position).normalize()
      .applyQuaternion(_gq4.copy(_gq3).multiply(arm.fore.quaternion))
    _gq1.setFromUnitVectors(_ikDir, sol.dirCb)
    arm.fore.quaternion.premultiply(_gq2.copy(_gq3).invert().multiply(_gq1).multiply(_gq3))
  }

  // 枪口世界坐标（开火 FX 用）：holder 系枪口偏移 → 世界。掉枪中 holder 已是
  // scene 直接子级，其局部即世界
  muzzleWorld(out) {
    if (!this.gun) return null
    const { holder, muzzleLocal } = this.gun
    out.copy(muzzleLocal).applyQuaternion(holder.quaternion).add(holder.position)
    if (!this._drop) out.applyQuaternion(this.mesh.quaternion).add(this.mesh.position)
    return out
  }

  // 开火后坐（main 的 onBotFire 注入）：枪身后顶 + 脊柱微仰，衰减在 step 的
  // 踉跄分支统一推进
  kickFire() { if (this.gun) this.gun.kick = 1 }

  // 骨骼化受击踉跄/开火后坐的脊柱层：clip 快照上叠加 mesh 空间后仰角（共轭到
  // 骨局部精确合成，角度随冲击/衰减曲线归零时自动回到快照）。无脊柱链返回
  // false → 调用方退回整体刚体后仰（老模型/程序化假人路径）
  _applyUpperFlinch(theta) {
    const ex = this._rigExtra
    if (!ex || !ex.spine.length || theta <= 0) return false
    const n = ex.spine.length
    let parentW = this._boneWorldQ(ex.spine[0].parent, _chainW)
    for (let i = 0; i < n; i++) {
      // 目标世界 = R_x(θ/n)·W_当前（mesh 空间后仰分摊到每节脊柱）；
      // 局部 = parentW⁻¹·R_x(θ)·parentW·q（共轭，自上而下父级用本帧已写值）
      _q1.setFromAxisAngle(_axX, theta / n)
      _q2.copy(parentW).invert().multiply(_q1).multiply(parentW)
      ex.spine[i].quaternion.copy(ex.spine[i].userData._clipQ ?? ex.spine[i].quaternion).premultiply(_q2)
      _curW.copy(parentW).multiply(ex.spine[i].quaternion)
      parentW = _curW
    }
    if (ex.neck) {
      _q1.setFromAxisAngle(_axX, theta * 0.4)
      _q2.copy(parentW).invert().multiply(_q1).multiply(parentW)
      ex.neck.quaternion.copy(ex.neck.userData._clipQ ?? ex.neck.quaternion).premultiply(_q2)
    }
    return true
  }

  // GLB 横移步态（官方口径）：pull 波面向玩家横移时用程序化姿态覆盖腿骨骼——
  // 腿链 yaw 朝移动方向 + 左右腿反相的深膝跑循环（官方 Q_Bow_RunE 实测：
  // 横移循环 = 侧向的前进跑，非双脚同触地的开合滑步），躯干/盆骨保持正对玩家
  // （上身动画已被压向 idle，见 step）。姿态量来自 core/PeekPose.strafeStepPose；
  // cross 波/站定 w=0 → 腿还原为 clip 快照、起伏/侧倾归零
  _stepStrafeGait(speed, w, dt) {
    const rig = this._strafeRig
    if (!rig) return
    // 相位由 step() 的 mixer 分支统一推进（位移锁相，见 step）——这里只消费
    const lx = this.velX * Math.cos(this.mesh.rotation.y) // 模型局部横向速度（模型空间 x 分量；GLB 正面 +Z ⇒ 右侧为 -x）
    // 侧倾：向移动方向倾，回正比起倾更快（急停干净利落，与 _stepLegs 同节奏）。
    // ⚠ 官方横移 clip 路径不叠 mesh 级侧倾（167 轮）：官方 RunE/W 盆骨自带
    // ±5~10° 侧倾，再倾一层 6° = 全身刚体倒 11~16°，而脚被钉地 IK 按住 →
    // 膝/踝被动剪切、双腿读作别扭交叉步（实测去掉后官方骨盆侧倾 ±2~6.5°
    // 独挑，步态即正常跑姿）——mesh 侧倾只属于程序化侧移覆盖路径
    const leanTarget = w > 0 && !this.anim?.strafe ? leanInto(lx) : 0
    const leanRate = Math.abs(leanTarget) > Math.abs(this.lean) ? 8 : 18
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * leanRate)
    this.mesh.rotation.z = this.lean
    // 官方横移 E/W clip：腿/盆骨曲线全部来自 mixer 播放（权重在 _setAnimWeights），
    // 程序化腿覆盖退休——只保留身体侧倾与急停高度收敛（起伏在 clip 的盆骨轨道里）
    if (this.anim?.strafe) {
      if (w <= 0) this.mesh.position.y *= 1 - Math.min(1, dt * 22)
      return
    }
    if (w > 0) {
      // 横移相位保持 1 步/1.15m 的出场节奏（全局 STEP_LEN 1.55 是走/跑官方口径，
      // 拉出横移若跟着变会慢 26%，节奏感尽失——见 STRAFE_STEP_LEN）
      const pose = strafeStepPose({ speed, phase: this.walkPhase * STEP_LEN / STRAFE_STEP_LEN, lateralVel: lx })
      this._applyLegPose(pose, w)
      this.mesh.position.y = pose.bob * w
    } else {
      this._applyLegPose(null, 0) // 还原 clip（slerp 权重 0 = 快照原样）
      this.mesh.position.y *= 1 - Math.min(1, dt * 22) // 急停起伏即刻收敛
    }
  }

  // 骨骼当前世界四元数：沿 parent 链手动上乘到 mesh。mixer 60Hz 写的是局部
  // 四元数、matrixWorld 要等渲染才更新——手动传播拿到本逻辑帧的精确值
  _boneWorldQ(bone, out) {
    out.copy(bone.quaternion)
    for (let n = bone.parent; n && n !== this.mesh; n = n.parent) out.premultiply(n.quaternion)
    return out
  }

  // 把姿态写进一条腿骨链（自上而下，父级用本帧已写值下传）。目标 mesh 空间
  // 姿态 = R_y(feetYaw)·R_z(外展)·[R_x(屈膝)]·bind（yaw 最外层 = 整腿随脚尖
  // 方向）；pose=null（w=0）时直接还原 clip 快照
  _poseLegBone(bone, bindMesh, parentW, yaw, zRot, xRot, w, outW) {
    if (w > 0 && bone.userData._clipQ) {
      _q1.setFromAxisAngle(_up, yaw)
      if (zRot) _q1.multiply(_q2.setFromAxisAngle(_axZ, zRot))
      if (xRot) _q1.multiply(_q2.setFromAxisAngle(_axX, xRot))
      // 目标世界（mesh 为场景直接子级，quaternion 即世界）→ 转骨局部，再按
      // w 从 clip 姿态 slerp 过去（启停平滑淡入淡出）
      _q3.copy(this.mesh.quaternion).multiply(_q1).multiply(bindMesh)
      _q3.premultiply(_q4.copy(parentW).invert())
      bone.quaternion.copy(bone.userData._clipQ).slerp(_q3, w)
    } else if (bone.userData._clipQ) {
      bone.quaternion.copy(bone.userData._clipQ)
    }
    if (outW) outW.copy(parentW).multiply(bone.quaternion)
  }

  _applyLegPose(pose, w) {
    const rig = this._strafeRig
    this._boneWorldQ(rig.hips, _chainW)
    for (let i = 0; i < rig.legs.length; i++) {
      const leg = rig.legs[i]
      const abduct = i === 0 ? pose?.abductL : pose?.abductR
      const thigh = i === 0 ? pose?.thighL : pose?.thighR
      const knee = i === 0 ? pose?.kneeL : pose?.kneeR
      const yaw = pose?.yaw ?? 0
      this._poseLegBone(leg.up, leg.bind.up, _chainW, yaw, abduct ?? 0, thigh ?? 0, w, _curW)
      this._poseLegBone(leg.knee, leg.bind.knee, _curW, yaw, 0, -(knee ?? 0), w, _curW)
      this._poseLegBone(leg.foot, leg.bind.foot, _curW, yaw, 0, 0, w, null)
      this._poseLegBone(leg.toe, leg.bind.toe, _curW, yaw, 0, 0, w, null)
    }
    // 盆骨：前进跑/走用 clip 的官方盆骨轨道（yaw/roll/pitch，见 GaitBake.GAIT）；
    // pull 横移时官方 RunE 盆骨几乎不滚不俯（roll 振荡 2.3°、pitch ≈0、恒高）→
    // 按 w 把盆骨退回 kamae bind（正对玩家持枪，不带前进跑的前倾/侧摆/扭摆）。
    // 盆骨父级世界与腿链无关（腿是盆骨子孙），腿写完后父级基准仍精确
    const hq = rig.hips.userData._clipQ
    if (hq && w > 0 && pose) {
      this._boneWorldQ(rig.hips.parent, _chainW)
      _q3.copy(this.mesh.quaternion).multiply(rig.hipsBind)
      _q3.premultiply(_q4.copy(_chainW).invert())
      rig.hips.quaternion.copy(hq).slerp(_q3, w)
    }
  }

  // 官方锚源清单（_stepFootPin 每 tick 解一次，两腿共用）：全部带官方 IK 锚
  // 曲线的动作按 mixer 权重加权混合锚点——与姿态混合同源，换态（walk↔run↔
  // 横移↔蹲↔跳↔转身）的锚随权重渐变，无换源瞬态。
  // 覆盖：走/跑 N、横移 E/W、蹲走、蹲踞待机、跳三段（JumpN/Falling/JumpLand）、
  // 停步转身踏步（8 向）——psa 原始腿曲线是官方 FootIK 之前的基姿态（脚悬空
  // 0.4~1.15m），任何这些状态不钉地 = 折叠腿直接暴露（160 轮跳跃全程双脚
  // 1.4~2.8m、急停脚穿地的根因）。
  // ⚠ stopAdd（急停支架）不入列：其 psa 锚退化在原点恒 0（支架本就冻结双脚，
  // 不编排新落点）——急停时的脚部 = 走跑权重淡出途中锚随相位冻结自然保持在
  // 停止前落点。159 轮的单一 argmax + 连续性锁在侧别翻转/权重重置的 tick 会
  // 锁死在常锚源（crouchIdle）上 → 蹲走双脚全速滑行（160 轮实测），权重混合
  // 根除该类锁死。返回共享数组，勿持有
  _anchorSources() {
    const A = this.anim
    if (!A) return null
    // 描述符对象池（128Hz × 每源一只短命对象的 GC churn 消除）：数组本身也
    // 复用，length 截断即"逻辑清空"，元素引用对外只在本 tick 内消费
    const src = this._anchorList ?? (this._anchorList = [])
    const pool = this._anchorPool ?? (this._anchorPool = [])
    let n = 0
    // 蹲走权重起来时，脚部约束的权威 = 蹲走 clip 的官方锚：常锚的 crouchIdle
    // （蹲踞站姿落点）与站姿 loco 锚（walk/run/横移——含与蹲走侧别选择不同步
    // 的 E/W 配对）按 (1−cwW) 淡出——否则三者各带 1/3 把混合锚锁在身体上，
    // 蹲走双脚随体速滑行（160 轮实测脚速 2.64≈体速 2.7）
    const cwW = Math.min(1, Math.max(0, this._crouchWW ?? 0))
    const locoK = 1 - cwW
    const add = (a, k = 1) => {
      const ik = a?.getClip().userData.ik
      if (!ik) return
      const w = a.getEffectiveWeight() * k
      if (w > 0.01) {
        const o = pool[n] ?? (pool[n] = { a: null, w: 0, ik: null, dur: 0 })
        o.a = a; o.w = w; o.ik = ik; o.dur = a.getClip().duration
        n++
      }
    }
    add(A.walk, locoK); add(A.run, locoK)
    if (A.strafe) {
      add(A.strafe[this._strafeSide ?? 'E'].walk, locoK)
      add(A.strafe[this._strafeSide ?? 'E'].run, locoK)
    }
    const cwSide = this._cwSide ?? this._strafeSide ?? 'E'
    add(A.crouchWalk?.[cwSide])
    add(A.crouchIdle, locoK)
    add(A.jump); add(A.fall); add(A.jumpLand)
    const turnKeys = this._turnKeys
    if (turnKeys) for (const k of turnKeys) add(A.turn[k])
    src.length = n
    for (let i = 0; i < n; i++) src[i] = pool[i]
    return n ? src : null
  }

  // 官方曲线防滑步：脚钉地 IK。psa 导出剥离了根位移，原始腿曲线是官方 FootIK
  // 之前的基姿态（脚悬空 0.4~1.15m）——脚的世界落点全权由官方 IK 目标锚曲线
  // （L/R_IK_FootTarget）驱动：每 tick 把锚（按 mixer 权重混合，见 _anchorSources）
  // 变换到世界，两骨 IK（髋-膝，与左手持枪同款 solveTwoBoneIK）把踝拉到锚。
  // 每 tick 先从 _clipQ 快照还原本帧 clip 姿态再叠加 IK——mixer 只在 60Hz 门控
  // 里写骨骼，缺这一步 IK 会在自家输出上累积（快照反馈坑）。支撑/摆动全程跟锚
  // （UE 的 IK 目标曲线即引擎对脚部的全周期约束）；无锚态（kamae 纯站定，GLB
  // 原生 clip 双脚自贴地 0.09）权重坡释放回 clip。烘焙近似路径数学上已防滑
  // （步幅=大腿摆幅覆盖），不启用
  _stepFootPin(dt) {
    const rig = this._strafeRig
    if (!rig || !this._officialLo) return
    this._loMinY = 9
    // 锚源每 tick 解一次（两腿共用）；E/W 侧别翻转由权重过渡承担（换侧时横移
    // 权重清零重起坡，锚随权重连续，无需硬重置脚部权重）
    const srcs = this._anchorSources()
    for (const leg of rig.legs) {
      const st = leg.foot.userData._pin ??= { anchor: new THREE.Vector3(), has: false, w: 0 }
      const snap = leg.up.userData._clipQ
      if (!snap) continue // 首帧快照未建
      // 1) 还原本帧 clip 姿态（60Hz 快照，两次 update 之间沿用最近值）
      leg.up.quaternion.copy(leg.up.userData._clipQ)
      leg.knee.quaternion.copy(leg.knee.userData._clipQ)
      leg.foot.quaternion.copy(leg.foot.userData._clipQ)
      leg.foot.updateWorldMatrix(true, false) // 含祖先链：还原后的膝/脚矩阵一并刷新
      leg.foot.getWorldPosition(_fpFoot)
      // mesh 局部脚高/骨盆高（扣除当前身体偏移）——直接量世界高会把上一 tick 的偏移喂回
      // 量测，定点迭代只收敛到所需偏移的一半。骨盆参考高走一阶慢滤（k=3 ≈ τ0.33s）：
      // 只跟状态的慢漂移（kamae↔跑/蹲的骨盆基高差），不追 clip 骨盆/胸轨的步频
      // bob——那 ±4cm 起伏是官方身体起伏，逐帧抵消它 = 身体僵直 + 脚反相弹跳
      this._loMinY = Math.min(this._loMinY, _fpFoot.y - this.mesh.position.y)
      const hipsLocal = rig.hips.matrixWorld.elements[13] - this.mesh.position.y
      this._hipsLocalY = (this._hipsLocalY ?? 0) === 0 ? hipsLocal
        : this._hipsLocalY + (hipsLocal - this._hipsLocalY) * Math.min(1, dt * 3)
      if (this._pinOff) continue // 调试/曲线比对：只量高度不钉地
      // 2) 官方锚加权混合（各源按 mixer 权重，与姿态混合同源连续）：
      //    psa 锚活在根骨空间（UE 轴向：前=+X、侧=+Y、上=+Z）。实测该空间支撑
      //    期目标世界静止 ±2cm。骨矩阵链带 UE 常量节点旋转会把锚甩飞——按轴映
      //    射直接落到 mesh 系（前=−Z、上=+Y）再升世界；侧轴符号以「世界系支撑
      //    期静止」为准。锚世界高 = psaZ（与 mesh.y 无关，psa 地面即世界地面——
      //    跳跃弧线（mesh.y 加成）自动把锚抬升 = 收腿随体）
      //    ⚠ 锚曲线与脚同名同侧（167 轮翻转）：旧「L 目标曲线跟随右脚」反号
      //    在 runN 上锚 y 仅 ±0.05~0.13（近中线）两种配对都可达、分辨不出；
      //    strafe 族锚 y 扫 ±0.5 且交叉脚前伸 0.25-0.30——反号配对让每脚追
      //    对侧+交叉锚（水平 0.65+0.30 超 0.795 腿长预算）→ 一脚整支撑期悬空
      //    6-10cm 滑冰；同侧配对（离线可达性实测）双脚全程可达
      let wSum = 0
      _fpBlend.set(0, 0, 0)
      for (const s of srcs ?? []) {
        if (!sampleIkAnchor(s.ik, s.dur, s.ik.n, s.a.time, leg.side, _fpAnchor)) continue
        _fpBlend.x += _fpAnchor.x * s.w
        _fpBlend.y += _fpAnchor.y * s.w
        _fpBlend.z += _fpAnchor.z * s.w
        wSum += s.w
      }
      if (wSum > 0.02) {
        // 锚全幅跟曲线（勿做指数逼近：摆动期目标 10+ m/s，10/s 逼近恒滞后
        // ~1m = 支撑脚全速滑冰）；入锚软化由下方 w·lerp 目标混合承担（8/s 坡）
        // 锚世界高 = psaZ + mesh.y：地面态 mesh.y=0 即 psaZ（psa 地面=世界地面）；
        // 跳跃弧线（mesh.y 加成）把锚随体抬升——官方 IK 目标活在 component space
        // （随胶囊走），滞空收腿（锚 z≈0.69）在弧线顶点 = 髋下 ~0.5m 的官方
        // 收腿位（曾把弧线对消 = 锚沉在地面、髋在 2.3m，腿被拉成垂直下蹬的
        // 超人腿——160 轮跳跃腾空期修复）
        st.anchor.set(_fpBlend.y / wSum, _fpBlend.z / wSum, -_fpBlend.x / wSum)
          .applyQuaternion(this.mesh.quaternion).add(this.mesh.position)
        st.w = Math.min(1, st.w + dt * 8)
      } else if ((this._braceW ?? 0) > 0.05 || (this._turnW ?? 0) > 0.05) {
        // 无锚源但急停支架/转身外站定：官方支架本就冻结双脚（stopAdd 的 psa
        // 锚退化在原点 = 不编排新落点）——保持最后锚位不重采样，w 不衰减，
        // 脚停在哪里就钉到哪里；恢复移动/锚源回归后随权重自然交还
      } else {
        st.w = Math.max(0, st.w - dt * 20) // 无锚源（纯站定 kamae）：权重坡放回 clip 脚位
      }
      if (st.w <= 0) continue
      // 3) IK 目标 = 官方锚（全程，无让步）。旧「可达性越距让步」是放倒管线
      //    时代的补丁：骨盆高度被钳低 24cm 时锚不可达，释放回 clip 脚位防滑。
      //    158 轮骨盆回到官方高度后，锚-髋距离的几何由官方数据自洽保证
      //    （锚后扫极限 ~1.17m，在腿长满展边界附近），让步反而会把目标放回
      //    psa 原始摆动姿（官方 FootIK 之前的曲线，摆动中脚高达 1.5m+）=
      //    支撑末期整腿踢到胸口/头高（158 轮腿部残留问题的根因）。极端越距时
      //    solver 自然钳为指向锚的满展位 = 蹬地推移。绝不 skip IK
      leg.up.matrixWorld.decompose(_fpHip, _q1, _gscl)
      leg.knee.matrixWorld.decompose(_fpKnee, _q2, _gscl)
      _fpKneeWClip.setFromRotationMatrix(leg.knee.matrixWorld) // clip 膝世界 Q（此刻矩阵=还原后的 clip 姿态）
      _fpAnchor.copy(st.anchor).lerp(_fpFoot, 1 - st.w)
      // 膝极向 = 面朝方向（psa 原始腿曲线是官方 FootIK 之前的姿态，膝常反折，
      // 跟随当前肘方向会把反关节保留下来；官方 UE TwoBoneIK 同样用显式极向）。
      // GLB 视觉正面 = 局部 +Z（164 轮）：极向取 +Z 侧（旧 -Z 在 180° 翻转的
      // 朝向修正前恰好指向玩家侧 = 真正面，翻转后必须跟着换号）
      _fpPole.copy(_fpHip)
        .addScaledVector(_fwdAxis.set(0, 0, 1).applyQuaternion(this.mesh.quaternion), 0.4)
      const sol = solveTwoBoneIK({ shoulder: _fpHip, elbow: _fpKnee, hand: _fpFoot, target: _fpAnchor, pole: _fpPole })
      if (!sol) continue
      // clamped（腿全伸）照常应用：clamped 解 = 指向目标方向的满展位，脚沿可达
      // 弧后扫 = 蹬地推移的自然表现（跑步支撑期腿本就接近全伸，按 clamped 放锚
      // 会让锚点 4tick 内乒乓）
      // 4) 共轭落骨局部（与 _stepHandIK 同款：父级世界 Q 前乘 meshQ 升场景系）
      const hipParentW = this._boneWorldQ(leg.up.parent, _chainW).premultiply(this.mesh.quaternion)
      _q3.setFromUnitVectors(sol.abDirCur, sol.dirAb)
      _q3.slerp(_IDENTITY, 1 - st.w)
      leg.up.quaternion.premultiply(_q4.copy(hipParentW).invert().multiply(_q3).multiply(hipParentW))
      _gq1.copy(hipParentW).multiply(leg.up.quaternion)
      _ikDir.copy(leg.foot.position).normalize().applyQuaternion(_gq2.copy(_gq1).multiply(leg.knee.quaternion))
      _q3.setFromUnitVectors(_ikDir, sol.dirCb)
      _q3.slerp(_IDENTITY, 1 - st.w)
      leg.knee.quaternion.premultiply(_q4.copy(_gq1).invert().multiply(_q3).multiply(_gq1))
      // 脚骨朝向反旋转（167 轮「脚歪」修复）：两骨 IK 只重瞄准髋/膝，脚骨保持
      // clip 局部值跟着被重瞄准的小腿走——实测世界朝向被带偏可达 ~100°（脚尖
      // 向内拧 + 下扣，支撑脚侧立）。官方脚旋转轨本身有 0→62° 的动态（着地/蹬
      // 地/摆动，作曲内容）——把脚世界姿态钉回 clip 原作：delta = IK后膝世界⁻¹ ·
      // clip 膝世界，前乘到脚局部（膝世界含 mesh 变换=场景系，两膝世界同系可
      // 直乘），按 st.w 与髋/膝增量同权重混合
      _gq2.copy(_gq1).multiply(leg.knee.quaternion) // IK 后膝世界 Q
      _q3.copy(_gq2).invert().multiply(_fpKneeWClip)
      _q3.slerp(_IDENTITY, 1 - st.w)
      leg.foot.quaternion.premultiply(_q3)
    }
  }

  // 程序化假人腿部：按无畏契约 strafe 运动规则驱动
  //  1) 步频与位移锁相：walkPhase 由里程推进（每 STEP_LEN 米 = 一步 = π），相位无跳变；
  //  2) 横移步态（cross-side-step）：双腿镜像侧摆（步距开合交替）+ 双髋同向偏转
  //     （脚尖朝行进方向）+ 步内小幅反摆；朝/背玩家移动的前后分量按局部速度方向混合
  //  3) counter-strafe 急停：硬站定快速收步（不做长缓动漂浮）+ 一次短促下沉卸力
  //  4) 身体向移动方向微倾（lean into strafe），急停时快速回正
  _stepLegs(speed, dt) {
    const legL = this.legL, legR = this.legR
    // 局部横向速度（模型正面 -Z、右侧 +X）：面向玩家横移时该分量为主
    const yaw = this.mesh.rotation.y
    const lx = this.velX * Math.cos(yaw) - this.velZ * Math.sin(yaw)

    // 相位始终随位移推进（里程积分），跨低速段也不失锁。
    // 脚步声：walkPhase 每跨过 kπ = 走满一步（STEP_LEN 位移），恰是 |cos|=1
    // 的落脚瞬间——听到的步声与看到的落脚同拍；onFootstep 由 BotManager 注入，
    // 传连续速度（脚步随加速渐强，不是两档跳变）
    const kPrev = Math.floor(this.walkPhase / Math.PI)
    this.walkPhase += speed * dt * Math.PI / STEP_LEN
    if (speed > 0.5 && Math.floor(this.walkPhase / Math.PI) > kPrev) {
      this.onFootstep?.(speed)
    }

    if (speed > 0.3) {
      // 摆动取 cos：walkPhase = kπ（每步整除 STEP_LEN）时 |cos|=1，正是落脚（步距最开）瞬间
      const s = Math.cos(this.walkPhase)
      const sp = Math.max(speed, 1e-4)
      const wLat = Math.min(1, Math.abs(lx) / sp)      // 横向权重：纯侧移 = 1
      const wFore = 1 - wLat
      const aLat = Math.min(0.36, 0.12 + speed * 0.058)
      // 前摆幅随 STEP_LEN 1.55 加大：不滑步要求 2·L·sin(a) ≥ 步距（5.4m/s 全速
      // 需 ~55°，此处 0.92rad≈52.7° 覆盖 91%，与官方循环的轻微滑步率一致）
      const aFore = Math.min(0.92, 0.22 + speed * 0.13)
      // 镜像侧摆：步距张开-并拢交替（s=±1 为落脚支撑，s=0 双腿交叠过中点）
      legL.rotation.z = -s * aLat * wLat
      legR.rotation.z = s * aLat * wLat
      legL.rotation.x = s * aFore * wFore
      legR.rotation.x = -s * aFore * wFore
      // 双髋同向偏转：脚尖朝行进方向（脚位朝移动、上身持枪朝目标 = VALORANT strafe 姿态）
      const hipYaw = -Math.sign(lx || 1) * 0.26 * wLat + s * 0.12 * wLat
      legL.rotation.y = hipYaw
      legR.rotation.y = hipYaw
      // 步态起伏：落脚张开时最低（重心压上支撑步）、并腿过中点最高
      this._yBase = (1 - Math.abs(s)) * (0.01 + speed * 0.0036)
      this._foreW = wFore // 前倾只跟前进分量走：侧移对枪（wFore≈0）上身立直
    } else {
      // 急停即刻站定：快速收步 + 高度归零（counter-strafe 是硬停，不做漂浮缓动）
      const k = 1 - Math.min(1, dt * 22)
      legL.rotation.x *= k; legL.rotation.y *= k; legL.rotation.z *= k
      legR.rotation.x *= k; legR.rotation.y *= k; legR.rotation.z *= k
      this._yBase *= k
      this._foreW = 0
    }

    // 身体侧倾：向移动方向倾（lean into strafe）；回正比起倾更快（急停干净利落）
    const leanTarget = THREE.MathUtils.clamp(-lx * 0.011, -0.05, 0.05)
    const leanRate = Math.abs(leanTarget) > Math.abs(this.lean) ? 8 : 18
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * leanRate)
    this.mesh.rotation.z = this.lean

    // 上身前倾（cross 顺跑向跑）：负 rot.x 把重心压向跑动方向，急停/站定快速回正。
    // 受击踉跄在其后写入 rot.x（后仰优先），衰减完自然交还前倾
    const foreTarget = -this._foreW * Math.min(speed / CONFIG.bot.moveSpeed, 1) * 0.07
    const foreRate = Math.abs(foreTarget) > Math.abs(this.foreLean) ? 7 : 16
    this.foreLean += (foreTarget - this.foreLean) * Math.min(1, dt * foreRate)
    this.mesh.rotation.x = this.foreLean

    // idle 呼吸：静止时微起伏+微俯仰（本体待机不是石膏像）。权重随静止淡入、
    // 移动快速淡出（不与步态起伏叠加）；幅度 6mm/0.3° 在对枪距离上不可察觉，
    // 只给静止假人一点"活着"的质感。高度在 _yBase 上绝对合成（加法会被
    // 慢衰减累积成 31mm 的大起伏）
    const breathTarget = speed > 0.3 ? 0 : 1
    this.breathW += (breathTarget - this.breathW) * Math.min(1, dt * (breathTarget ? 1.2 : 6))
    this.breath += dt * Math.PI * 2 / 3.4 // ~3.4s 呼吸周期
    const br = this.breathW * (0.5 - 0.5 * Math.cos(this.breath))
    this.mesh.position.y = this._yBase + br * 0.006
    this.mesh.rotation.x += br * 0.005

    // counter-strafe 卸力：高速跑过/拉出的 Bot 减速到近停时触发一次短促下沉
    // （重心急停的重量感）。摩擦模型下速度逐 tick 递减（单 tick 降幅 ~0.3 m/s），
    // 单帧跨过"2.2 → ≤1.0"不可能发生 —— 用高速闩锁：只要出现过 >2.2 就记住，
    // 降到 1.0 以下那一刻卸力一次
    if (speed > 2.2) this._wasFast = true
    else if (this._wasFast && speed <= 1.0) { this._wasFast = false; this.plantT = 0.16 }
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
    if (this.gun) this.scene.remove(this.gun.holder) // 掉落的枪随尸体一起收
    this._drop = null
  }

  place(x, z, mode) {
    this.pos.set(x, 0, z)
    this.prevPos.copy(this.pos)
    this.hp = CONFIG.bot.health
    this.active = true
    this.mode = mode
    this.velX = 0
    this.velZ = 0
    this.mesh.visible = true
    this.blob.visible = !Bot.realShadows
    // 上一次死亡淡出可能关闭了网格投影（setOpacity 半程切换 blob 补位）——重生恢复
    this._casting = true
    this.mesh.traverse?.(o => { if (o.isMesh) o.castShadow = true })
    this.mesh.rotation.set(0, 0, 0)
    this.mesh.position.copy(this.pos)
    this.walkPhase = 0
    this.lean = 0        // 复用的 Bot 归位站姿：不带旧侧倾/急停残余
    this.foreLean = 0
    this._foreW = 0
    this.plantT = 0
    this._prevSpeed = 0
    this._wasFast = false
    if (this.legL) { this.legL.rotation.set(0, 0, 0); this.legR.rotation.set(0, 0, 0) }
    if (this._strafeRig) for (const leg of this._strafeRig.legs) { // 不带上一条的脚钉锚点
      const st = leg.foot.userData._pin
      if (st) st.w = 0
    }
    this._loY = 0 // 官方曲线贴地高度偏移归零
    this._loMinY = 0 // 最低脚局部高（贴地跟踪量测，首帧前归零防 NaN）
    this._hipsLocalY = 0 // 骨盆局部高（身体高度移动态参考，同上首帧归零）
    this.setOpacity(1)
    this.blobMat.opacity = 1
    this.spawnGuardUntil = this.now() + CONFIG.bot.spawnGuardMs / 1000
    this.firstVisibleAt = -1
    this.reactRecorded = false // 反应样本每次出场只记一条（防多段击杀重复计数）
    this.flinch = 0 // 复用的 Bot 不带旧受击踉跄
    this.breath = vary() * Math.PI * 2 // 呼吸相位随机（多假人不同步）
    this.breathW = 0
    this._yBase = 0
    this.hitFlash = 0
    this._restoreEmissive() // 也不带旧受击红光（如被击杀后立刻复用）
    if (this.mixer) { // 骨骼假人归位站姿，不带上一条的残留步态
      if (this.deathAction) this.deathAction.stop() // 先停死亡 clip，update(0) 才是干净重摆
      for (const a of Object.values(this.deathActions ?? {})) a.stop()
      for (const a of Object.values(this.anim?.turn ?? {})) a.stop()
      this.anim?.stopAdd?.stop()
      this._turnKey = null; this._turnW = 0; this._braceW = 0
      this._cwSide = null // 蹲走侧别锁存归零
      this._crouchPlanned = false; this._crouching = false; this._crouchW = 0
      this._crouchWW = 0; this._cwPhase = 0
      if (this.anim.crouchWalk) for (const a of Object.values(this.anim.crouchWalk)) a.setEffectiveWeight(0)
      this._jump = null; this._jumpW = 0
      if (this.anim.jump) this.anim.jump.setEffectiveWeight(0)
      if (this.anim.jumpLand) this.anim.jumpLand.setEffectiveWeight(0)
      this.anim.walk.time = 0
      if (this.anim.run) this.anim.run.time = 0
      if (this.anim.strafe) {
        for (const side of ['E', 'W']) {
          this.anim.strafe[side].walk.time = 0
          this.anim.strafe[side].run.time = 0
        }
        this._strafeSide = null
      }
      this._moveW = this._runW = this._strafeW = 0 // 平滑权重归零（不带旧淡出尾巴）
      this._setAnimWeights(0)
      this.mixer.update(0)
      this._animAcc = 0
      // mixer 复位已把腿骨骼重写为干净姿态 → 立即刷新 clip 快照（程序化侧移
      // 覆盖的混合基准），上一条的步态覆盖不带到新一条命
      this._snapshotClipPose()
    }
    if (this.gun) { // 上一条命掉在地上的枪收回手上（_stepGun 下一帧精确摆正）
      this.mesh.add(this.gun.holder)
      this.gun.holder.position.set(0, 1.2, 0.25) // GLB 正面 +Z：挂回身前（164 轮换号）
      this.gun.holder.quaternion.identity()
      this.gun.gun.position.copy(this.gun.gunBase) // 含模板根节点居中偏移，不能 set 硬编码
      this.gun.kick = 0
      this.gun.init = false
    }
    this._drop = null
    this._skelDeath = false
  }

  setOpacity(o) {
    for (const m of Object.values(this.mats)) {
      m.transparent = o < 1
      m.opacity = o
    }
    // 真实阴影随淡出衰减：材质透明不影响 depth pass，影子会保持实心到 hide
    // 才突然消失。半程后关掉投影，blob 接触阴影（透明度跟随）补位过渡
    if (o <= 0.55 && Bot.realShadows && this._casting) {
      this._casting = false
      this.mesh.traverse?.(obj => { if (obj.isMesh) obj.castShadow = false })
      this.blob.visible = true
    }
    if (o <= 0.55 && this.blob.visible) this.blobMat.opacity = o * 0.7
  }

  get invulnerable() { return this.now() < (this.spawnGuardUntil ?? 0) || !this.active || this.mode === 'dying' }
  now() { return this.manager ? this.manager.now() : performance.now() / 1000 } // 跟随游戏时钟（暂停时冻结）

  // targetVelX/targetVelZ = 世界系目标速度（walkout 波沿 z 穿缺口前进，横移波
  // 沿 x——两轴同款地面模型：加速 18.75 m/s²@步枪档、摩擦 28.6+3.3v 急停
  // （5.4→0 ≈0.147s，对齐 Riot_Classick 官方停稳 0.160s）。Bot 启停节奏 =
  // 真人 peek 的节奏
  moveToward(targetVelX, dt, targetVelZ = 0) {
    const M = CONFIG.movement
    this.velX = groundStep(this.velX, targetVelX, {
      accel: accelFor(targetVelX, M.groundAccel, M.runSpeed),
      decelFlat: M.groundDecelFlat,
      decelDrag: M.groundDecelDrag,
    }, dt)
    this.velZ = groundStep(this.velZ, targetVelZ, {
      accel: accelFor(targetVelZ, M.groundAccel, M.runSpeed),
      decelFlat: M.groundDecelFlat,
      decelDrag: M.groundDecelDrag,
    }, dt)
    this.pos.x += this.velX * dt
    this.pos.z += this.velZ * dt
  }

  // 跳 peek：播 JumpN（蹬伸→空中收腿），弧线由 mesh.y 偏移驱动（命中区随
  // mesh 自动跟随）；落地切 JumpLand 恢复。跳跃期间钉地/蹲/转身/支架全部让位
  startJump() {
    if (this._jump || this.mode !== 'peek' || !this.anim?.jump) return
    this.anim.jump.reset()
    this.anim.jump.play()
    this._jump = { t: 0, landed: false }
  }

  // 跳跃相位推进（纯过程量，Bot.step 的 mixer 分支消费）：返回本 tick 的弧线
  // 偏移（mesh.y 加成）；落地切 JumpLand，恢复完成后清 _jump（返回 null）
  _stepJump(dt) {
    if (!this._jump) return 0
    this._jump.t += dt
    const jt = this._jump.t
    let arc = 0
    if (jt > JUMP_LAUNCH) {
      const tt = jt - JUMP_LAUNCH
      arc = Math.max(0, JUMP_V0 * tt - 0.5 * JUMP_G * tt * tt)
    }
    if (!this._jump.landed && jt > JUMP_LAUNCH + 2 * JUMP_V0 / JUMP_G) {
      // 落地：切 JumpLand（压缩→回站），弧线归零；落地闷响（强脚步口径）
      this._jump.landed = true
      if (this.anim.jumpLand) { this.anim.jumpLand.reset(); this.anim.jumpLand.play() }
      this.onFootstep?.(5.4)
    }
    if (this._jump.landed && jt > JUMP_LAUNCH + 2 * JUMP_V0 / JUMP_G + 0.667) {
      this._jump = null // 恢复完成：交回走跑混合
      return 0
    }
    return arc
  }

  startDeath() {
    const vx = this.velX // 死亡瞬间的动量 → 掉枪的抛出初速
    this.mode = 'dying'
    this.deathT = 0
    this._landed = false
    this.velX = 0
    this.velZ = 0
    this.deathRoll = (vary() - 0.5) * 0.55 // 带随机侧倒更自然
    this.flinch = 0
    // 死亡分支不走上面的闪光恢复路径（step 提前返回）——在此立即还原，
    // 否则击杀瞬间的受击红光会贯穿整个倒地动画与重生
    this.hitFlash = 0
    this._restoreEmissive()
    // 死亡方向性：玩家在 bot 正面 → 弹道把人向后打（背摔）；背面/侧后 → 前扑
    let side = null
    if (this._playerX !== undefined) {
      const yaw = this.mesh.rotation.y
      const f = this.mixer ? 1 : -1 // GLB 视觉正面 +Z；程序化假人 -Z（164 轮）
      const fwdX = f * Math.sin(yaw), fwdZ = f * Math.cos(yaw)
      const dx = this._playerX - this.pos.x, dz = this._playerZ - this.pos.z
      side = pickDeathSide(fwdX * dx + fwdZ * dz)
    }
    const officialDeath = side ? this.deathActions?.[side] : null
    if (this.mixer && officialDeath) {
      // 官方死亡整身 clip（TP_Core Death Splat：脊柱/颈/手臂/腿全动 + 根位移
      // 走骨道）：kamae/步态全停，死亡 clip 从头播一次停在终 pose
      const A = this.anim
      if (A) {
        A.walk.setEffectiveWeight(0)
        if (A.idle) A.idle.setEffectiveWeight(0)
        if (A.run) A.run.setEffectiveWeight(0)
        if (A.strafe) for (const s of ['E', 'W']) {
          A.strafe[s].walk.setEffectiveWeight(0)
          A.strafe[s].run.setEffectiveWeight(0)
        }
      }
      if (this.deathAction) this.deathAction.setEffectiveWeight(0)
      officialDeath.reset()
      officialDeath.setEffectiveWeight(1)
      officialDeath.play()
      this._skelDeath = true
      this._officialDeath = true
      this._deathDur = officialDeath.getClip().duration
    } else if (this.mixer && this.deathAction) {
      // 烘焙塌倒（官方死亡 clip 缺席时的骨骼化回退）
      const A = this.anim
      if (A) {
        A.walk.setEffectiveWeight(0)
        if (A.idle) A.idle.setEffectiveWeight(0)
        if (A.run) A.run.setEffectiveWeight(0)
        if (A.strafe) for (const s of ['E', 'W']) {
          A.strafe[s].walk.setEffectiveWeight(0)
          A.strafe[s].run.setEffectiveWeight(0)
        }
      }
      this.deathAction.reset()
      this.deathAction.setEffectiveWeight(1)
      this.deathAction.play()
      this._skelDeath = true
      this._officialDeath = false
    } else {
      this._skelDeath = false
      this._officialDeath = false
    }
    // 撒手掉枪：保持世界姿态抛落（弹道/翻滚/落地摆平在 step 的 dying 分支）
    if (this.gun) {
      this.scene.attach(this.gun.holder)
      this._drop = {
        p: this.gun.holder.position.clone(),
        q: this.gun.holder.quaternion.clone(),
        v: new THREE.Vector3(vx * 0.7 + (vary() - 0.5) * 1.2, 1.5 + vary() * 0.9, (vary() - 0.5) * 1.0),
        axis: new THREE.Vector3(vary() - 0.5, 0, vary() - 0.5).normalize(),
        // 翻滚轴心偏置到枪口端 55% 处：枪托绕前段甩（本体掉枪不是绕中心匀速
        // 自旋），落地在 restY 反弹 ≤2 次（着速够才弹）
        pivotLocal: new THREE.Vector3(0, 0, this.gun.muzzleLocal.z * 0.55),
        spin: 4 + vary() * 5,
        restY: 0.05,
        landed: false,
      }
      this.gun.kick = 0
    }
  }

  // 对枪获胜（玩家没打中）不再有独立的 won 模式：Bot 保持 peek 横移跑向
  // 对面掩体撤离（BotManager._loseDuel 改写 peek 目标），到位躲进墙后 hide

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
      if (this._skelDeath) {
        // 骨骼化塌倒：死亡 clip 接管盆骨/腿/脊柱/手臂（128Hz 平滑推进）；
        // mesh 只收敛走跑残留的高度偏移，不做刚体旋转。官方死亡 clip 的根
        // 位移在骨道里（倒地全靠骨道），mesh.y 衰减会双重下沉——跳过
        this.mixer.update(dt)
        if (!this._officialDeath) this.mesh.position.y *= 1 - Math.min(1, dt * 22)
      } else {
        // 刚体后仰倒地（程序化假人/无烘焙老模型）：ease-out + 随机侧倒 + 下沉
        const e = 1 - Math.pow(1 - t, 3)
        this.mesh.rotation.x = e * (Math.PI / 2) * 0.95
        this.mesh.rotation.z = this.deathRoll * e
        this.mesh.position.y = -e * 0.05
      }
      // 掉枪弹道：抛落翻滚 → 落地摆平（枪平躺在地，随尸体一起留存/回收）
      if (this._drop && this.gun) {
        if (!this._drop.landed) {
          this._drop = stepDroppedGun(this._drop, dt)
          this.gun.holder.position.copy(this._drop.p)
          this.gun.holder.quaternion.copy(this._drop.q)
        } else {
          this.gun.holder.quaternion.slerp(settleFlatQ(this.gun.holder.quaternion, _q1), Math.min(1, dt * 10))
        }
      }
      // 触地闷响：ease-out 立方在 t≈0.63 转 angle 已达 ~95%=机体拍地帧，只响一次
      if (!this._landed && this.deathT > CONFIG.bot.deathTime * 0.63) {
        this._landed = true
        this.onDeathLand?.()
      }
      if (this.deathT > (this._officialDeath ? this._deathDur : 1.2)) {
        // 本体击杀表现：尸体与掉枪整局留存——定格在最终姿势（corpse 不 step：
        // 零 CPU，静态网格），不淡出不 hide；直到池复用（place 重置）或回合
        // 结束（dispose）/地图重建（onMapRebuilt）才回收
        this.mode = 'corpse'
        this.active = false
        this.corpseAt = this.now()
      }
      return
    }

    // 可见性 → 反应计时起点
    const p = ctx.player
    this._playerX = p.pos.x // 暂存玩家位置：死亡方向性（背摔/前扑）判定用
    this._playerZ = p.pos.z
    const eyeY = this.pos.y + BOT_EYE_Y
    this.visibleNow = this.world.lineOfSight(
      this.pos.x, eyeY, this.pos.z,
      p.pos.x, p.pos.y + p.eyeHeight, p.pos.z,
    )
    if (this.visibleNow && this.firstVisibleAt < 0) {
      this.firstVisibleAt = this.now()
      // 预瞄误差采样：Bot 露头瞬间，准星与目标胸口的角度偏差（度）。
      // 这是架枪训练的核心指标 —— 出现后才甩过去的是反应，出现前就贴住的是预瞄。
      const distH = Math.max(0.5, Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z))
      const yawTo = Math.atan2(-(this.pos.x - p.pos.x), -(this.pos.z - p.pos.z)) // 玩家→Bot 方向的 yaw（与视角同约定）
      const pitchTo = Math.atan2((this.pos.y + 1.3) - (p.pos.y + p.eyeHeight), distH)
      let dyaw = (p.yaw - yawTo) * 180 / Math.PI
      dyaw = ((dyaw + 180) % 360 + 360) % 360 - 180 // 归一到 -180..180
      const dpitch = (p.pitch - pitchTo) * 180 / Math.PI
      const arr = this.manager?.stats?.aimErrors
      if (arr && arr.length < 500) arr.push(Math.round(Math.hypot(dyaw, dpitch) * 10) / 10)
    }

    // 命中闪光：恢复原始自发光（受击时被 flashHit 置红/白）
    if (this.hitFlash > 0) {
      this.hitFlash -= dt
      if (this.hitFlash <= 0) this._restoreEmissive()
    }

    // 朝向（判定在 core/PeekPose.js，两种姿势 50/50 交替）：
    //  pull 横向拉出 = VALORANT 肩peek，面向对枪目标持枪横移（strafe）——
    //    GLB 靠 _stepStrafeGait 的程序化侧移步态；腿骨链不齐的老模型
    //    canStrafe=false 退回顺跑向（侧移放前进 clip 会滑步穿帮）
    //  cross 侧面跑过 = 顺行进方向跑（旋转跑、侧身入镜）
    //  急停/站定一律转回面向目标（停步挑战）
    const stopped = this.mode === 'peek' && this.peek?.stopUntil > this.now()
    const moving = Math.hypot(this.velX, this.velZ) > 0.4
    const targetYaw = peekFacingYaw({
      style: this.peek?.style,
      canStrafe: !this.mixer || !!this._strafeRig, // 程序化假人自带横移步态
      velX: this.velX, moving, stopped,
      dx: p.pos.x - this.pos.x, dz: p.pos.z - this.pos.z,
      front: this.mixer ? 1 : -1, // GLB 视觉正面 +Z；程序化假人正面 -Z（164 轮）
    })
    let dy = targetYaw - this.mesh.rotation.y
    dy = Math.atan2(Math.sin(dy), Math.cos(dy)) // 取最短角差
    // 跟踪增益 30/s（167 轮）：14/s 在横移 ω≈0.4rad/s（5.4m/s@13m）下留 ~1.7°
    // 稳态滞后——本体对枪角色身体始终压着瞄准向；30/s 残差 <0.8°，出场初始
    // 180° 转身也收得更快（τ 33ms），不再带半转身滑出墙
    this.mesh.rotation.y += dy * Math.min(1, dt * 30)

    // 蹲姿对枪（BotManager 在急停时按 crouchChance 掷定）：蹲下压低命中区，
    // 逼玩家下压准星——本体对枪蹲。蹲姿优先：蹲下时不出转身踏步/支架（腿部
    // 五五混合会吃掉蹲姿的根高沉降）
    const cwNow = !!(this.peek?.crouchWalk && this.peek?.phase === 'out' && this.anim?.crouchWalk)
    this._crouching = !!(stopped && this._crouchPlanned && this.anim?.crouchIdle && !this._jump)
    // 起立放缓（fall 3.5/s vs 默认 7）：蹲走拉出的低姿轮廓多保持 ~0.15s，头部
    // 抬升速度减半（过渡更平滑）。入坡 8/s 同步放缓：kamae↔蹲姿的姿态差大，
    // 14/s 的 71ms 全幅交换在 60Hz mixer 门下单帧 ~60° 姿态突扫
    this._crouchW = smoothW(this._crouchW ?? 0, (this._crouching || cwNow) ? 1 : 0, dt, 8, 3.5)
    // 停步挑战的官方转身/支架选型（先算好，mixer 分支消费）：急停且朝向差够大
    // → 出「转身踏步」clip（E=右转/W=左转，角度最近档）；朝向已对 → 出「急停
    // 支架」加法层。走路/移动中不触发（stopped 才算）；跳跃中全部让位
    let turnKey = null
    if (stopped && this.anim?.turn && !this._crouching && !this._jump) turnKey = pickTurnClip(dy)
    // 转身 clip 粘滞：上一发还在播（权重未淡出）就播完它——桶位随朝向收敛切换
    // （135°→90°→45°）+ reset 重播 = turnW 中段权重下定格姿势整姿跳变（实测
    // 单 tick 百度）；淡出后才允许换档重选
    if (turnKey && (this._turnW ?? 0) > 0.15 && this.anim.turn?.[this._turnKey]) turnKey = this._turnKey
    const braceTarget = stopped && this.anim?.stopAdd && !turnKey && !this._crouching && !this._jump ? 1 : 0

    // 移动表现：程序化假人 = VALORANT 横移步态；骨骼假人播放混合动画，walkout
    // 波沿 z 前进（顺跑向 clip），横移台架沿 x
    const speed = Math.hypot(this.velX, this.velZ)
    if (this.legL && this.legR) {
      this._stepLegs(speed, dt)
    } else if (this.mixer) {
      // 横移权重与走跑权重同过时间常数（急停收腿不瞬移）；入坡 10/s——E/W 换侧
      // 从 0 重起坡时 walkN↔strafe 姿态差大，22/s 会被 60Hz 门量化成单帧大跳
      const wT = strafeRampW({ style: this.peek?.style, speed })
      this._strafeW = smoothW(this._strafeW ?? 0, wT, dt, 10, 7)
      const w = this._strafeW
      // 停步转身/急停支架：权重过时间常数（停步进入淡入 ~125ms、恢复移动淡出
      // 不留残步）；turn/brace 与走跑是整姿替换（姿态差大），22/s 的 45ms 全幅
      // 会被 60Hz mixer 门量化成单帧百度级突扫——入坡同 8/s 家族
      const turnActive = !!(turnKey && this.anim.turn?.[turnKey])
      this._turnW = smoothW(this._turnW ?? 0, turnActive ? 1 : 0, dt, 8, 7)
      if (this.anim.turn) {
        if (turnKey !== this._turnKey && turnActive) {
          const a = this.anim.turn[turnKey]
          a.reset() // 从头播（踏步型与转身角绑定，半程续播会错步）
          a.play()
        }
        for (const key of this._turnKeys) {
          const a = this.anim.turn[key]
          a.setEffectiveWeight(key === turnKey ? this._turnW : 0)
        }
        this._turnKey = turnKey
      }
      // 蹲走拉出（pull 变体）：专用蹲走步幅相位锁播（CROUCH_WALK_STEP=官方扫
      // 幅，跑步机近零滑步），侧别跟横移方向；蹲姿权重复用 _crouchW（idle 退
      // 缩 + 命中区 ×0.70 同源）
      const cwActive = !!(this.peek?.crouchWalk && this.peek?.phase === 'out' && this.anim.crouchWalk && !this._jump)
      // 蹲走入坡 8/s（125ms 全幅）：kamae↔蹲走步幅的姿态差大（深屈膝步姿 vs
      // 站姿），14/s 的 71ms 全幅斜坡把整姿差在几 tick 内扫完 = 起步抽动
      this._crouchWW = smoothW(this._crouchWW ?? 0, cwActive ? 1 : 0, dt, 8, 3.5)
      if (this.anim.crouchWalk) {
        // 步幅 = clip 属性常量（0.84）：移速只改步频（任意移速近零滑步）
        this._cwPhase = (this._cwPhase ?? 0) + speed * dt * Math.PI / CROUCH_WALK_STEP
        // 侧别 = 局部速度主轴：横移主导 → E/W（配对依据见下方横移侧别数据注），
        // 前向主导（walkout 沿 z 穿出）→ N（官方蹲走 N 向 clip）。低速 ≤0.5 保持
        // 原侧——平局判决会把蹲走侧别在站定时翻面；换侧压零权重再起坡
        if (Math.max(Math.abs(this.velX), Math.abs(this.velZ)) > 0.5) {
          const yaw = this.mesh.rotation.y
          const fwd = -(this.velX * Math.sin(yaw) + this.velZ * Math.cos(yaw))
          const lat = this.velX * Math.cos(yaw) - this.velZ * Math.sin(yaw)
          const side = Math.abs(lat) > Math.abs(fwd) ? (lat < 0 ? 'E' : 'W') : 'N'
          if (side !== this._cwSide) {
            this._cwSide = side
            this._crouchWW = 0
          }
        }
        const cwSide = this._cwSide ?? 'E'
        const cwPh = ((this._cwPhase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        for (const s of this._cwKeys) {
          const a = this.anim.crouchWalk[s]
          a.time = (cwPh / (Math.PI * 2)) * a.getClip().duration
          a.setEffectiveWeight(s === cwSide ? this._crouchWW : 0)
        }
      }
      // 跳跃：空中 JumpN 独占腿部（走/跑/idle 压零防五五混合），落地 JumpLand
      // 恢复（权重 ~0.33s 淡出交接回走跑）；弧线偏移加在 mesh.y 上（命中区随
      // mesh 自动跟随）
      const __jl = this.anim.jumpLand
      if (this._jump || (__jl && __jl.getEffectiveWeight() > 0.01)) {
        const arc = this._stepJump(dt)
        const active = !!this._jump
        const landed = active ? this._jump.landed : true
        // 滞空段姿态源：JumpN 空中段 → Falling 循环平滑 crossfade（布尔瞬切
        // 会让两套空中姿态硬跳一帧）
        const airT = active ? Math.max(0, this._jump.t - JUMP_LAUNCH) : 0
        const airFall = airT > JUMP_FALL_AFTER && !!this.anim.fall
        const fallBlend = airFall ? jumpFallBlend(airT) : 0
        // 起跳权重走坡：预备蹲压缩读作蓄力下蹲，非硬切
        this._jumpW = smoothW(this._jumpW ?? 0, active && !landed ? 1 : 0, dt)
        if (this.anim.jump) this.anim.jump.setEffectiveWeight(this._jumpW * (1 - fallBlend))
        if (this.anim.fall) this.anim.fall.setEffectiveWeight(fallBlend * this._jumpW)
        if (__jl) {
          // 落地前 JumpLand 权重必须为 0：腾空姿态由 JumpN/Falling 独占（曾把
          // 权重预挂 1 = 空中姿态与错相位的 JumpLand 五五混合、官方锚曲线也被
          // 对半拉低——顶点收腿位矮 0.4m，160 轮修复）。落地（landed）才满权，
          // 恢复期淡出
          if (landed) __jl.setEffectiveWeight(1)
          else if (!active) __jl.setEffectiveWeight(Math.max(0, __jl.getEffectiveWeight() - dt * 3))
          else __jl.setEffectiveWeight(0)
        }
        if (this.anim.idle) this.anim.idle.setEffectiveWeight(0)
        this.anim.walk.setEffectiveWeight(0)
        if (this.anim.run) this.anim.run.setEffectiveWeight(0)
        if (this.anim.strafe) for (const s of ['E', 'W']) {
          this.anim.strafe[s].walk.setEffectiveWeight(0)
          this.anim.strafe[s].run.setEffectiveWeight(0)
        }
        this._jumpArcY = arc // 弧线在 mesh.y 定格后追加（见下），此处先存
      } else {
        this._jumpArcY = 0
      }
      if (this.anim.crouchIdle) {
        // 蹲走起来时让位（×(1−cwWW)）：crouchWalk 自己就是蹲姿——crouchIdle
        // 再挂 1/3 权重会把骨盆多压 ~1cm + 待机摆动混进步频（165 轮，与
        // _setAnimWeights 的 cwK 同源）
        this.anim.crouchIdle.setEffectiveWeight(this._crouchW * (1 - this._crouchWW))
      }
      if (this.anim.stopAdd) {
        this._braceW = smoothW(this._braceW ?? 0, braceTarget, dt, 8, 7)
        const sa = this.anim.stopAdd
        sa.setEffectiveWeight(this._braceW)
        if (this._braceW === 0 && !braceTarget) sa.reset() // 定格→归零后回卷，下次从头播
        else if (!sa.isRunning()) sa.play() // place() stop() 过的动作要重新起播
      }
      // 官方横移 E/W 侧别选择：模型局部横向速度 +X（右）= E（与官方锚曲线的
      // 补偿轴约定锁定——E+右移/W+左移的支撑锚世界静止，反向组合实测 2× 滑速）。
      // 转向中当前 yaw 穿越法线会变号选错侧 → w<0.85 持续重估（起步段在墙后，
      // 翻正不可见）；换侧一律先把横移权重压到 0（E/W 两套独立循环，任何非零
      // 权重下硬切 = 镜像整姿跳变，实测单膝差可达 178°）
      if (this.anim?.strafe && w < 0.85 && Math.abs(this.velX) > 0.5) {
        const lx = this.velX * Math.cos(this.mesh.rotation.y)
        // 官方锚数据锁定的配对：E 族锚支撑期向局部 +X 扫、W 族向 −X 扫（psa
        // 实测 runE/runW/crouchWalk 双向），锚要世界静止必须逆着局部移动方向扫
        // → 局部左移（lx<0）配 E、右移配 W。旧「lx>0→E」是反的：纯垂直横移下
        // 实测 E 配左移滑速 0.50 vs W 配左移 10.76（2× 反扫，160 轮修正）
        const side = lx < 0 ? 'E' : 'W'
        if (side !== this._strafeSide) {
          this._strafeSide = side
          this._strafeW = 0
        }
      }
      // 步态相位随位移推进（每步 = π；步距 = 当前混合族的官方步距，160 轮：
      // 走 1.05 / 跑 1.54 / 横移跑 1.40——各族天然速度不同，播放速率随移速
      // 缩放 = 支撑锚后扫速率 ≈ 体速，钉地零滑步）——官方/烘焙 clip 播放头
      // （_setAnimWeights 相位锁定）与侧移姿态都由它驱动；mixer 假人统一在这里
      // 推进（不含 _stepStrafeGait：骨链不齐的老模型 rig=null 提前返回，相位也
      // 不能停）。脚步声：跨 π = 走满一步的落脚瞬间触发（与程序化假人同口径）；
      // 跳跃滞空中静音（本体跳 peek 空中无脚步声），落地帧补一声落地闷响
      const kPrev = Math.floor(this.walkPhase / Math.PI)
      this.walkPhase += speed * dt * Math.PI / (this._officialLo
        ? gaitStepLen({ runW: this._runW ?? 0, strafeW: this._strafeW ?? 0 })
        : STEP_LEN)
      // 加速度（钉地入锚门用）：启停摩擦 ~30 m/s²、稳态 ~0——混合期不钉脚
      this._speedAcc = (speed - this._prevSpeed) / dt
      this._prevSpeed = speed
      // 本体音频口径：跳跃滞空/蹲走拉出均无脚步声（蹲走无声正是其战术价值；
      // 2.7m/s 蹲走 < 跑步声触发阈 3.2 的语义同源）
      const footSilent = !!this._jump || (this._crouchWW ?? 0) > 0.5
      if (!footSilent && speed > 0.5 && Math.floor(this.walkPhase / Math.PI) > kPrev) {
        this.onFootstep?.(speed)
      }
      this._stepAnim(speed, dt)
      this._stepStrafeGait(speed, w, dt)
      // 先落位再钉地（顺序是钉地成败的关键）：IK 用本帧最终 mesh 位姿解算——
      // 若先解 IK 再挪 mesh，脚会跟着 mesh 每帧前跳一次（系统性拖尾 = 钉住的
      // 脚恰好以体速滑行）。水平位本帧精确；身体高度用上一 tick 的量测（8ms
      // 滞后不可见），本 tick 的新量测由 _stepFootPin 顺带写下帧用
      if (this._officialLo) {
        // 身体高度：mesh 原点 = 地面，骨盆高度全权交给 clip 自带的 Splitter
        // 位置轨道（官方口径：runN 1.14m / walkN 1.10 / kamae 1.08 / 蹲踞
        // 0.80， mixer 混合即平滑过渡）。157 轮修正根链参考系后该轨道已精确
        // 落进骨架——曾用的 locoBodyY（骨盆参考 0.90m）是在放倒管线上标定的
        // 常数，会让全身塌 24cm：膝中位屈曲 64~69°（官方站姿段 20~33°）、
        // 高抬腿蹬伸异常 = 157 轮腿部残留问题的根因。
        // ⚠ 基座归零必须每 tick 无条件执行：跳跃弧线是「mesh.y += _jumpArcY」
        // 的增量叠加，基座若在跳跃中被跳过，弧线逐 tick 复利 = 火箭升天
        // （158 轮蹲走跳波 mesh.y 飙到 21m 的教训）
        this._loY = 0
        this.mesh.position.y = 0
      }
      _v.copy(this.prevPos).lerp(this.pos, ctx.alpha ?? 1)
      this.mesh.position.x = _v.x
      this.mesh.position.z = _v.z
      if (this._jumpArcY) this.mesh.position.y += this._jumpArcY // 跳跃弧线（命中区随 mesh）
      // 跳跃期间照常钉地：锚源含 JumpN/Falling/JumpLand（官方空中收腿/落地
      // 恢复的脚部约束），锚高随跳跃弧线自动抬升（160 轮前跳跃完全退锚 = 原始
      // 折叠腿暴露，双脚全程 1.4~2.8m）
      this._stepFootPin(dt)
      this._stepGun(dt, ctx.player, stopped)
    } else if (speed > 0.3) {
      // 无动画的自定义模型兜底：至少保留位移节奏的起伏
      this.walkPhase += speed * dt * Math.PI / STEP_LEN
      this.mesh.position.y = Math.abs(Math.cos(this.walkPhase)) * 0.018
    } else {
      this.mesh.position.y *= 1 - Math.min(1, dt * 22)
    }

    // 受击踉跄 + 开火后坐：正弦冲击曲线 → 后仰 + 微沉（不影响朝向/命中判定）。
    // 骨骼假人走脊柱覆盖（更贴本体：上身局部后仰，腿不动），无脊柱链的老模型/
    // 程序化假人退回整体刚体后仰
    if (this.flinch > 0 || (this.gun && this.gun.kick > 0)) {
      this.flinch = Math.max(0, this.flinch - dt * 5)
      if (this.gun) this.gun.kick = Math.max(0, this.gun.kick - dt * 7)
      const k = this.flinch > 0 ? Math.sin(Math.min(1, this.flinch) * Math.PI) : 0
      if (k > 0) this.mesh.position.y -= k * 0.025
      const theta = k * this.flinchAmp + kickPose(this.gun?.kick ?? 0).spine
      if (theta > 0 && !this._applyUpperFlinch(theta)) {
        this.mesh.rotation.x = k * this.flinchAmp
      }
    }

    _v.copy(this.prevPos).lerp(this.pos, ctx.alpha ?? 1)
    this.mesh.position.x = _v.x
    this.mesh.position.z = _v.z
    this.blob.position.set(_v.x, 0.02, _v.z)
  }

  // 渲染帧插值：128Hz 逻辑位 → 渲染帧用 accumulator alpha 重采样网格位置。
  // 相机在 renderFrame 里是插值的，Bot 不插值会在掉帧时相对视野抖动
  syncVisual(alpha) {
    if (!this.active && this.mode !== 'dying') return
    _v.copy(this.prevPos).lerp(this.pos, alpha)
    this.mesh.position.x = _v.x
    this.mesh.position.z = _v.z
    this.blob.position.set(_v.x, 0.02, _v.z)
  }

  // 受击反馈：泛红自发光 + 踉跄（爆头白热闪 + 更强后仰）
  // power=伤害力度（0.4-1.4，按 dmg/55 归一）：踉跄幅度与命中火花密度共用——
  // 重枪（Sheriff 55 伤）打得踉跄更深、火星更密，轻枪点到为止
  flashHit(head = false, power = 1) {
    this.hitFlash = Math.max(CONFIG.bot.hitFlashTime, 0.11)
    this.flinch = 1
    this.flinchAmp = (head ? 0.28 : 0.15) * (0.7 + 0.5 * power)
    const c = head ? 0xffd9cf : 0xff4630
    for (const m of Object.values(this.mats)) m.emissive?.setHex?.(c)
  }

  // 射线 vs 命中球体。命中球中心跟随网格当前姿态（受击踉跄后仰/横移侧倾
  // 会让头部视觉偏移可达 ~0.4m，命中区不跟着转会"看着打头却打空气"）：
  // 局部 (0, z.y, 0) 经网格四元数旋转 + 网格位置。绕 Y 的朝向对轴上点无平移，
  // 实际生效的是后仰（rot.x）与侧倾（rot.z）
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    if (this.invulnerable) return null
    // 命中区骨锚跟随：蹲姿（cw>0）时每区中心 lerp 到其解剖骨世界位（官方蹲姿
    // = 收拢球：头部/躯干/腿骨位全部随姿态走，固定高度区必错位）；cw=0 走
    // 站姿静态位（程序化假人/无骨区自动回退）
    const cw = this._crouchW ?? 0
    let bestT = maxT, bestZone = null
    for (const z of this.zones) {
      _v.set(0, z.y, 0).applyQuaternion(this.mesh.quaternion).add(this.mesh.position)
      if (cw > 0.001 && z._boneObj) {
        z._boneObj.updateWorldMatrix(true, false)
        const be = z._boneObj.matrixWorld.elements
        _headC.set(be[12], be[13] + z.lift, be[14])
        _v.lerp(_headC, cw)
      }
      const t = raySphere(ox, oy, oz, dx, dy, dz, _v.x, _v.y, _v.z, z.r)
      if (t !== null && t < bestT) { bestT = t; bestZone = z.zone }
    }
    if (!bestZone) return null
    return { t: bestT, zone: bestZone, x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT }
  }
}
