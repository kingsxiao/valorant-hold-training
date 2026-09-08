// 无畏契约英雄 GLB（UE 风格骨架）接入支持：
//  1. RIG_MATCH / matchRigBones —— 把 UE 骨名（Pelvis_0131 / L_Hip_0136 / …）和
//     Mixamo 骨名（mixamorig:Hips / LeftUpLeg / …）统一映射到 Bot 的横移步态
//     骨链槽位（hips + 双腿 up/knee/foot/toe），带 UE 辅助骨排除（Twst/Ndl/IK/end）
//  2. bakeLocomotionClips —— 英雄 GLB 只有 kamae（持枪站姿）clip，没有走/跑：
//     用步态数学现场烘焙 walk/run AnimationClip。周期 = 2×stepLen 米 / 参考速度，
//     与 Bot._setAnimWeights 的 timeScale 锁相（÷1.9 / ÷5.2）严格对齐——播放
//     速率永远等于实际移速，脚步位移不滑步。手臂不做轨道：跑步时上身保持
//     kamae 持枪姿态（idle 权重归零后骨骼停在最后写入帧），正是本体战斗跑
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
}

// 在克隆体上找骨链。返回 null = 腿链不齐（老模型，Bot 退回顺跑向）。
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
  return { hips, legs, spine, neck }
}

// ---- 步态曲线（mesh 空间角，X 轴：+ 前摆 / − 后屈；相位 p：|sin/cos| 周期 = 一步）----
const GAIT = {
  walk: { thigh: 0.50, knee: 0.55, foot: 0.22, bob: 0.022, hipsYaw: 0.055, lean: 0, neck: 0 },
  run: { thigh: 0.85, knee: 1.35, foot: 0.38, bob: 0.050, hipsYaw: 0.100, lean: 0.16, neck: -0.08 },
}

// 单腿三关节角：大腿正弦摆动；膝 = 基础微屈 + 后摆段踢腿折膝（脚跟离地）；
// 脚 = 落脚前勾脚尖/蹬地压脚尖的小幅摆动
export function legAngles(p, c) {
  return {
    thigh: c.thigh * Math.sin(p),
    knee: -(0.12 + c.knee * Math.max(0, -Math.sin(p - 0.5))),
    foot: THREE.MathUtils.clamp(c.foot * Math.sin(p + 2.4), -0.45, 0.55),
  }
}

// 烘焙 walk/run clip。spec：
//   hipsBone, legs: [{side, up, knee, foot, bind:{up,knee,foot,toe 世界四元数}}]
//   spineBones: [骨骼…], neckBone（可空，bind 局部四元数内部自取）
//   stepLen 一步位移（m）、walkSpeed/runSpeed 参考速度（timeScale 锁相基准）
// 返回 { walk, run }；legs/spine 数据不齐返回 null
export function bakeLocomotionClips({ hipsBone, legs, spineBones = [], neckBone = null, stepLen = 1.15, walkSpeed = 1.9, runSpeed = 5.2, samples = 32 }) {
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

const _AX_X = new THREE.Vector3(1, 0, 0)
const _AX_Y = new THREE.Vector3(0, 1, 0)

// mesh 空间世界四元数（根到该骨骼的链乘；克隆体挂在恒等根下时即世界）
function _worldQ(bone) {
  const q = bone.quaternion.clone()
  for (let n = bone.parent; n; n = n.parent) q.premultiply(n.quaternion)
  return q
}
