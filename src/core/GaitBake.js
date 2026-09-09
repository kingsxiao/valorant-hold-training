// 无畏契约英雄 GLB（UE 风格骨架）接入支持：
//  1. RIG_MATCH / matchRigBones —— 把 UE 骨名（Pelvis_0131 / L_Hip_0136 / …）和
//     Mixamo 骨名（mixamorig:Hips / LeftUpLeg / …）统一映射到 Bot 的横移步态
//     骨链槽位（hips + 双腿 up/knee/foot/toe），带 UE 辅助骨排除（Twst/Ndl/IK/end）
//  2. bakeLocomotionClips —— 英雄 GLB 只有 kamae（持枪站姿）clip，没有走/跑：
//     用步态数学现场烘焙 walk/run AnimationClip。周期 = 2×stepLen 米 / 参考速度，
//     与 Bot 的步态相位锁相（walkPhase 里程推进，播放头直接钉在相位上）严格
//     对齐——播放速率永远等于实际移速，脚步位移不滑步。手臂不做轨道：跑步时
//     上身保持 kamae 持枪姿态（idle 权重归零后骨骼停在最后写入帧），正是本体
//     战斗跑
//  3. deathPose / bakeDeathClips —— 死亡塌倒烘焙：盆骨后仰下沉 + 腿折叠落地
//     的骨骼化死亡（取代整体刚体旋转），arms 骨链让撒手的外垂也进轨道
import * as THREE from 'three'

// 骨名模式：数组按序取第一个命中的骨骼。UE 名为精确锚定（^name_\d+$），
// 避免匹配到辅助骨（L_Hip_Twst1_0142 / L_Knee_Ndl_0138 / L_Foot_IKpv_IUE_0132 /
// L_Toe_end_0141 / L_Shoulder_Twst1_085 / L_ShoulderPad_089 均被 \d+$ 排除）
export const RIG_MATCH = {
  hips: [/hips|pelvis/i],
  leg: {
    L: { up: [/^L_Hip_\d+$/, /LeftUpLeg$/], knee: [/^L_Knee_\d+$/, /LeftLeg$/], foot: [/^L_Foot_\d+$/, /LeftFoot$/], toe: [/^L_Toe_?\d+$/, /LeftToeBase$/] },
    R: { up: [/^R_Hip_\d+$/, /RightUpLeg$/], knee: [/^R_Knee_\d+$/, /RightLeg$/], foot: [/^R_Foot_\d+$/, /RightFoot$/], toe: [/^R_Toe_?\d+$/, /RightToeBase$/] },
  },
  spine: [/spine\d*(_\d+)?$/i],   // UE Spine1_03..Spine4_06 / Mixamo mixamorig:Spine/1/2（$ 尾排除 SpinePad 类）
  neck: [/neck/i],
  // 手臂（死亡塌倒的撒手轨道）：UE 肩=L_Shoulder_054/肘=L_Elbow_055/手=L_Hand_056
  // （L_Shoulder_Twst1_085 / L_ShoulderPad_089 / L_Hand_IKpv_IUE_0177 被 \d+$ 排除）
  arm: {
    L: { up: [/^L_Shoulder_\d+$/, /LeftArm$/], fore: [/^L_Elbow_\d+$/, /LeftForeArm$/], hand: [/^L_Hand_\d+$/, /LeftHand$/] },
    R: { up: [/^R_Shoulder_\d+$/, /RightArm$/], fore: [/^R_Elbow_\d+$/, /RightForeArm$/], hand: [/^R_Hand_\d+$/, /RightHand$/] },
  },
  // 挂枪骨（kamae 双手架枪位：R 后手/扳机位、L 前手/护木位；*_end 为末端辅助骨排除）
  weapon: {
    L: [/^L_WeaponPoint_?\d*$/],
    R: [/^R_WeaponPoint_?\d*$/],
  },
}

// 在克隆体上找骨链。返回 null = 腿链不齐（老模型，Bot 退回顺跑向）。
// arms/weapon 为可选增强（死亡撒手轨道 / 挂枪锚点），缺不致命——只少特性。
// 必须在 mixer 首次 update 前调用（bind 姿态未被动画覆盖时）。
export function matchRigBones(root) {
  const findOne = (patterns) => {
    for (const re of patterns) {
      let found = null
      root.traverse(o => { if (!found && o.isBone && re.test(o.name)) found = o })
      if (found) return found
    }
    return null
  }
  const hips = findOne(RIG_MATCH.hips)
  if (!hips) return null
  const legs = []
  for (const side of ['L', 'R']) {
    const slot = {}
    for (const part of ['up', 'knee', 'foot', 'toe']) slot[part] = findOne(RIG_MATCH.leg[side][part])
    if (!slot.up || !slot.knee || !slot.foot || !slot.toe) return null
    legs.push({ side, ...slot })
  }
  // spine：0-4 根（按名排序保证 UE Spine1→4 / Mixamo Spine→2 自下而上的顺序）
  const spine = []
  root.traverse(o => {
    if (o.isBone && RIG_MATCH.spine.some(re => re.test(o.name))) spine.push(o)
  })
  spine.sort((a, b) => (a.name < b.name ? -1 : 1))
  const neck = findOne(RIG_MATCH.neck)
  // 手臂：单侧三骨齐才算该侧（Twst/Pad 骨架变体直接少一侧，不拖垮整个 rig）
  const arms = []
  for (const side of ['L', 'R']) {
    const up = findOne(RIG_MATCH.arm[side].up)
    const fore = findOne(RIG_MATCH.arm[side].fore)
    const hand = findOne(RIG_MATCH.arm[side].hand)
    if (up && fore && hand) arms.push({ side, up, fore, hand })
  }
  const weaponL = findOne(RIG_MATCH.weapon.L)
  const weaponR = findOne(RIG_MATCH.weapon.R)
  return { hips, legs, spine, neck, arms, weaponL, weaponR }
}

// ---- 步态曲线（mesh 空间角，X 轴：+ 前摆 / − 后屈；相位 p：|sin/cos| 周期 = 一步）----
// 官方动画实测校准（assets-raw/{jett,sova}-psa：Rocklan Drive Animations 目录的
// 第三人称 .psa 骨骼曲线，解析见 psa_osc.py）：跑周期 0.6s / 走周期 0.8~0.87s；
// 膝基础屈曲 跑 20~33°、走 29~63°，摆动峰值 跑 108~117°、走 88~103°；髋摆全幅
// 跑 ~60°(Jett) / 走 ~42°；盆骨在 clip 内恒高（起伏由腿部几何涌现，轨道只留极小
// 值）、盆骨侧摆 ~12°；LB 内脊柱无轨道（前倾由盆骨/UB 层承担，此处保留少量
// 脊柱分摊补 kamae 上身的直立倾向）
export const GAIT = {
  walk: { thigh: 0.70, knee: 0.95, kneeBase: 0.50, foot: 0.26, bob: 0.012, hipsYaw: 0.055, lean: 0, neck: 0 },
  run: { thigh: 0.82, knee: 1.55, kneeBase: 0.38, foot: 0.45, bob: 0.025, hipsYaw: 0.100, lean: 0.16, neck: -0.08 },
}

// 单腿三关节角：大腿正弦摆动；膝 = 基础屈曲（官方走/跑全程不屈直）+ 后摆段踢腿
// 折膝（脚跟离地）；脚 = 落脚前勾脚尖/蹬地压脚尖的小幅摆动
export function legAngles(p, c) {
  return {
    thigh: c.thigh * Math.sin(p),
    knee: -((c.kneeBase ?? 0.12) + c.knee * Math.max(0, -Math.sin(p - 0.5))),
    foot: THREE.MathUtils.clamp(c.foot * Math.sin(p + 2.4), -0.45, 0.55),
  }
}

// 烘焙 walk/run clip。spec：
//   hipsBone, legs: [{side, up, knee, foot, bind:{up,knee,foot,toe 世界四元数}}]
//   spineBones: [骨骼…], neckBone（可空，bind 局部四元数内部自取）
//   stepLen 一步位移（m）、walkSpeed/runSpeed 参考速度（官方口径：跑周期 0.6s
//   @5.4m/s → 1.62m/步、走周期 ~0.85s@3.39m/s → 1.44m/步；默认 stepLen 取中值）
// 返回 { walk, run }；legs/spine 数据不齐返回 null
export function bakeLocomotionClips({ hipsBone, legs, spineBones = [], neckBone = null, stepLen = 1.55, walkSpeed = 3.39, runSpeed = 5.4, samples = 32 }) {
  if (!hipsBone || !legs || legs.length !== 2) return null
  const hipsBindQ = hipsBone.quaternion.clone()
  const hipsBindPos = hipsBone.position.clone()
  const hipsWorldQ = _worldQ(hipsBone)          // 大腿的父级基准（mesh 空间）
  const spineLocal = spineBones.map(b => b.quaternion.clone())
  const neckLocal = neckBone ? neckBone.quaternion.clone() : null

  const bake = (kind) => {
    const c = GAIT[kind]
    const duration = (2 * stepLen) / (kind === 'walk' ? walkSpeed : runSpeed)
    const times = []
    for (let i = 0; i <= samples; i++) times.push((i / samples) * duration)
    const tracks = []
    const q = new THREE.Quaternion(), rx = new THREE.Quaternion()

    // 双腿（R 侧相位差 π：镜像同步摆动）
    for (const leg of legs) {
      const flip = leg.side === 'R' ? Math.PI : 0
      const chain = [
        { bone: leg.up, parentW: hipsWorldQ, bindW: leg.bind.up },
        { bone: leg.knee, parentW: leg.bind.up, bindW: leg.bind.knee },
        { bone: leg.foot, parentW: leg.bind.knee, bindW: leg.bind.foot },
      ]
      const vals = chain.map(() => [])
      for (let i = 0; i <= samples; i++) {
        const a = legAngles((times[i] / duration) * Math.PI * 2 + flip, c)
        const angles = [a.thigh, a.knee, a.foot]
        for (let j = 0; j < chain.length; j++) {
          // 目标 mesh 姿态 = R_x(θ)·bind；父级 Δ 同轴相消 → 局部 = parentBind⁻¹·R_x(θ)·bind
          rx.setFromAxisAngle(_AX_X, angles[j])
          q.copy(chain[j].parentW).invert().multiply(rx).multiply(chain[j].bindW)
          vals[j].push(q.x, q.y, q.z, q.w)
        }
      }
      for (let j = 0; j < chain.length; j++) {
        tracks.push(new THREE.QuaternionKeyframeTrack(chain[j].bone.name + '.quaternion', times, vals[j]))
      }
    }

    // 髋：小幅盆骨反转（yaw）+ 步态起伏（每步一次触底 = walkPhase 与 |cos|=1 落脚同拍）
    const hq = [], hp = []
    for (let i = 0; i <= samples; i++) {
      const p = (times[i] / duration) * Math.PI * 2
      rx.setFromAxisAngle(_AX_Y, c.hipsYaw * Math.sin(p))
      q.copy(rx).multiply(hipsBindQ)
      hq.push(q.x, q.y, q.z, q.w)
      const bob = -c.bob * (0.5 + 0.5 * Math.cos(2 * p))
      hp.push(hipsBindPos.x, hipsBindPos.y + bob, hipsBindPos.z)
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(hipsBone.name + '.quaternion', times, hq))
    tracks.push(new THREE.VectorKeyframeTrack(hipsBone.name + '.position', times, hp))

    // 跑步前倾：脊柱逐节分摊 + 颈部回正（走路 0 = 不加轨道，交叉淡化自然回直）
    if (c.lean && spineBones.length) {
      const share = c.lean / spineBones.length
      spineBones.forEach((bone, k) => {
        rx.setFromAxisAngle(_AX_X, share)
        const v = []
        for (let i = 0; i <= samples; i++) {
          q.copy(rx).multiply(spineLocal[k])
          v.push(q.x, q.y, q.z, q.w)
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(bone.name + '.quaternion', times, v))
      })
    }
    if (c.neck && neckBone) {
      rx.setFromAxisAngle(_AX_X, c.neck)
      const v = []
      for (let i = 0; i <= samples; i++) {
        q.copy(rx).multiply(neckLocal)
        v.push(q.x, q.y, q.z, q.w)
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(neckBone.name + '.quaternion', times, v))
    }

    const clip = new THREE.AnimationClip(kind, duration, tracks)
    return clip
  }

  return { walk: bake('walk'), run: bake('run') }
}

// ---- 死亡塌倒（无畏契约击杀表现：中弹后仰、身体折叠拍地、撒手）----
// 姿态量随 t（0→1）的曲线（ease-out 立方与旧刚体死亡同节奏——0.63 处拍地
// 音效/结算时序不动）：
//  hipsPitch  盆骨绕 mesh X 后仰（t=1 ≈83°，身体放平）
//  thigh      大腿反向补偿盆骨的旋转（盆骨转多少腿转回多少 → 躺平时腿顺地面，
//             留 ~18% 不补全 = 膝盖微抬的自然尸体位）
//  knee/foot  屈膝/勾脚；spineCurl 每节脊柱轻微前卷；neck 头后仰
//  armDrop/elbowCurl 撒手——上臂外垂、前臂微屈（握枪姿态松开）
export function deathPose(t) {
  const e = 1 - Math.pow(1 - THREE.MathUtils.clamp(t, 0, 1), 3)
  return {
    e,
    hipsPitch: 1.45 * e,
    thigh: -1.45 * 0.82 * e,
    knee: -0.32 * e,
    foot: 0.18 * e,
    spineCurl: 0.06 * e,
    neck: -0.22 * e,
    armDrop: 0.32 * e,
    elbowCurl: -0.35 * e,
  }
}

// 烘焙死亡塌倒 clip（取代 mesh 刚体旋转）。spec：
//   hipsBone, hipsParentW（盆骨父级 bind 世界四元数）, hipsBindW（盆骨 bind 世界）,
//   hipsBindY（盆骨 bind 世界高——下沉目标按 restY 折算）, restY 落地盆骨高
//   legs 与 bakeLocomotionClips 同构（含 bind 世界四元数）
//   spineBones/spineBindW、neckBone/neckBindW（世界系，与腿同款精确换算）
//   arms [{side, up, fore}]（bind 局部姿态内部自取；小幅外垂用局部后乘即可）
//   roll 死亡侧倒角（mesh Z 轴）、duration 与 CONFIG.bot.deathTime 对齐
export function bakeDeathClips({
  hipsBone, hipsParentW, hipsBindW, hipsBindY, restY = 0.11,
  legs, spineBones = [], spineBindW = [], neckBone = null, neckBindW = null,
  arms = [], roll = 0, duration = 0.55, samples = 14,
}) {
  if (!hipsBone || !hipsParentW || !hipsBindW || !legs || legs.length !== 2) return null
  const hipsBindPos = hipsBone.position.clone()
  const armLocal = arms.map(a => ({ up: a.up.quaternion.clone(), fore: a.fore.quaternion.clone() }))
  const times = []
  for (let i = 0; i <= samples; i++) times.push((i / samples) * duration)
  const tracks = []
  const q = new THREE.Quaternion(), r = new THREE.Quaternion()

  // 盆骨：后仰 + 侧倒（mesh 空间合成 → 骨局部）+ 下沉到贴地
  const hq = [], hp = []
  const dropTotal = Math.max(0, hipsBindY - restY)
  for (let i = 0; i <= samples; i++) {
    const p = deathPose(times[i] / duration)
    r.setFromAxisAngle(_AX_X, p.hipsPitch)
    q.setFromAxisAngle(_AX_Z, roll * p.e)
    q.multiply(r).multiply(hipsBindW).premultiply(hipsParentW.clone().invert())
    hq.push(q.x, q.y, q.z, q.w)
    hp.push(hipsBindPos.x, hipsBindPos.y - p.e * dropTotal, hipsBindPos.z)
  }
  tracks.push(new THREE.QuaternionKeyframeTrack(hipsBone.name + '.quaternion', times, hq))
  tracks.push(new THREE.VectorKeyframeTrack(hipsBone.name + '.position', times, hp))

  // 双腿：与走跑烘焙同款链式 mesh 空间换算（大腿父级基准 = 盆骨 bind 世界）
  for (const leg of legs) {
    const chain = [
      { bone: leg.up, parentW: hipsBindW, bindW: leg.bind.up },
      { bone: leg.knee, parentW: leg.bind.up, bindW: leg.bind.knee },
      { bone: leg.foot, parentW: leg.bind.knee, bindW: leg.bind.foot },
    ]
    const vals = chain.map(() => [])
    for (let i = 0; i <= samples; i++) {
      const p = deathPose(times[i] / duration)
      const angles = [p.thigh, p.knee, p.foot]
      for (let j = 0; j < chain.length; j++) {
        r.setFromAxisAngle(_AX_X, angles[j])
        q.copy(chain[j].parentW).invert().multiply(r).multiply(chain[j].bindW)
        vals[j].push(q.x, q.y, q.z, q.w)
      }
    }
    for (let j = 0; j < chain.length; j++) {
      tracks.push(new THREE.QuaternionKeyframeTrack(chain[j].bone.name + '.quaternion', times, vals[j]))
    }
  }

  // 脊柱前卷 / 头后仰：bind 世界 → 局部（精确口径）
  const axial = (bone, bindW, parentW, ang) => {
    r.setFromAxisAngle(_AX_X, ang)
    q.copy(parentW).invert().multiply(r).multiply(bindW)
    tracks.push(new THREE.QuaternionKeyframeTrack(bone.name + '.quaternion', times,
      (() => { const v = []; for (let i = 0; i <= samples; i++) v.push(q.x, q.y, q.z, q.w); return v })()))
  }
  spineBones.forEach((bone, k) => {
    const share = deathPose(1).spineCurl
    const bindParentW = k === 0 ? hipsBindW : spineBindW[k - 1]
    axial(bone, spineBindW[k], bindParentW, share)
  })
  if (neckBone && neckBindW) axial(neckBone, neckBindW, spineBindW[spineBindW.length - 1] ?? hipsBindW, deathPose(1).neck)

  // 撒手：小幅外垂走局部后乘（≤0.32rad，骨架轴向差异不敏感）
  arms.forEach((a, k) => {
    const sgn = a.side === 'L' ? 1 : -1
    const upTrack = [], foreTrack = []
    for (let i = 0; i <= samples; i++) {
      const p = deathPose(times[i] / duration)
      q.setFromAxisAngle(_AX_Z, sgn * p.armDrop).multiply(armLocal[k].up)
      upTrack.push(q.x, q.y, q.z, q.w)
      q.setFromAxisAngle(_AX_X, p.elbowCurl).multiply(armLocal[k].fore)
      foreTrack.push(q.x, q.y, q.z, q.w)
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(a.up.name + '.quaternion', times, upTrack))
    tracks.push(new THREE.QuaternionKeyframeTrack(a.fore.name + '.quaternion', times, foreTrack))
  })

  return new THREE.AnimationClip('death', duration, tracks)
}

const _AX_X = new THREE.Vector3(1, 0, 0)
const _AX_Y = new THREE.Vector3(0, 1, 0)
const _AX_Z = new THREE.Vector3(0, 0, 1)

// mesh 空间世界四元数（根到该骨骼的链乘；克隆体挂在恒等根下时即世界）
function _worldQ(bone) {
  const q = bone.quaternion.clone()
  for (let n = bone.parent; n; n = n.parent) q.premultiply(n.quaternion)
  return q
}
