// GaitBake：无畏契约英雄 GLB（UE 骨架）接入的两块纯逻辑 ——
// 骨名映射（UE/Mixamo 双口径 + 辅助骨排除）与程序化 walk/run clip 烘焙
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { RIG_MATCH, matchRigBones, legAngles, bakeLocomotionClips } from '../src/core/GaitBake.js'

const m = (re, s) => re.test(s)

describe('RIG_MATCH 骨名映射（UE + Mixamo 双口径）', () => {
  it('UE 风格英雄骨名命中（Jett 实测骨名）', () => {
    expect(m(RIG_MATCH.leg.L.up[0], 'L_Hip_0136')).toBe(true)
    expect(m(RIG_MATCH.leg.L.knee[0], 'L_Knee_0137')).toBe(true)
    expect(m(RIG_MATCH.leg.L.foot[0], 'L_Foot_0140')).toBe(true)
    expect(m(RIG_MATCH.leg.L.toe[0], 'L_Toe_0120')).toBe(true)
    expect(m(RIG_MATCH.leg.R.up[0], 'R_Hip_0146')).toBe(true)
    expect(m(RIG_MATCH.hips[0], 'Pelvis_0131')).toBe(true)
    expect(RIG_MATCH.spine.some(re => m(re, 'Spine1_03'))).toBe(true)
    expect(RIG_MATCH.spine.some(re => m(re, 'Spine4_06'))).toBe(true)
    expect(m(RIG_MATCH.neck[0], 'Neck_07')).toBe(true)
  })

  it('UE 辅助骨全部排除（Twst/Ndl/IK/end/Pad 不算腿）', () => {
    for (const re of RIG_MATCH.leg.L.up) expect(m(re, 'L_Hip_Twst1_0142')).toBe(false)
    for (const re of RIG_MATCH.leg.L.knee) expect(m(re, 'L_Knee_Ndl_0138')).toBe(false)
    for (const re of RIG_MATCH.leg.L.foot) expect(m(re, 'L_Foot_IKpv_IUE_0132')).toBe(false)
    for (const re of RIG_MATCH.leg.L.toe) expect(m(re, 'L_Toe_end_0141')).toBe(false)
    for (const re of RIG_MATCH.leg.R.toe) expect(m(re, 'R_Toe_end_0152')).toBe(false)
  })

  it('Mixamo 骨名（X Bot）仍命中，保持向后兼容', () => {
    expect(m(RIG_MATCH.hips[0], 'mixamorig:Hips')).toBe(true)
    expect(m(RIG_MATCH.leg.L.up[1], 'mixamorig:LeftUpLeg')).toBe(true)
    expect(m(RIG_MATCH.leg.L.knee[1], 'mixamorig:LeftLeg')).toBe(true)
    expect(m(RIG_MATCH.leg.R.foot[1], 'mixamorig:RightFoot')).toBe(true)
    expect(m(RIG_MATCH.leg.L.toe[1], 'mixamorig:LeftToeBase')).toBe(true)
    expect(RIG_MATCH.spine.some(re => m(re, 'mixamorig:Spine2'))).toBe(true)
    expect(m(RIG_MATCH.neck[0], 'mixamorig:Neck')).toBe(true)
  })
})

// 最小 UE 骨架：hips + 双腿三节 + 趾 + 脊柱两节 + 颈（名字取自 Jett 实测）
function buildFakeRig() {
  const root = new THREE.Group()
  const B = (name) => { const b = new THREE.Bone(); b.name = name; return b }
  const hips = B('Pelvis_0131'); root.add(hips)
  const legs = []
  for (const [side, hipN, kneeN, footN, toeN] of [
    ['L', 'L_Hip_0136', 'L_Knee_0137', 'L_Foot_0140', 'L_Toe_0120'],
    ['R', 'R_Hip_0146', 'R_Knee_0147', 'R_Foot_0150', 'R_Toe_0151'],
  ]) {
    const up = B(hipN), knee = B(kneeN), foot = B(footN), toe = B(toeN)
    hips.add(up); up.add(knee); knee.add(foot); foot.add(toe)
    up.position.y = 0.1; knee.position.y = 0.45; foot.position.y = 0.45; toe.position.y = 0.08
    legs.push({ side, up, knee, foot, toe })
  }
  const spine = []
  let cur = hips
  for (const n of ['Spine1_03', 'Spine2_04']) { const s = B(n); cur.add(s); s.position.y = 0.12; cur = s; spine.push(s) }
  const neck = B('Neck_07'); cur.add(neck); neck.position.y = 0.15
  root.updateMatrixWorld(true)
  return { root, hips, legs, spine, neck }
}

describe('matchRigBones', () => {
  it('UE 骨架完整命中：hips/双腿/spine 自下而上/neck', () => {
    const { root, spine } = buildFakeRig()
    const rig = matchRigBones(root)
    expect(rig).toBeTruthy()
    expect(rig.hips.name).toBe('Pelvis_0131')
    expect(rig.legs.map(l => l.side)).toEqual(['L', 'R'])
    expect(rig.legs[0].up.name).toBe('L_Hip_0136')
    expect(rig.legs[1].toe.name).toBe('R_Toe_0151')
    expect(rig.spine.map(b => b.name)).toEqual(spine.map(b => b.name))
    expect(rig.neck.name).toBe('Neck_07')
  })

  it('腿链不齐（缺趾骨）返回 null → Bot 退回顺跑向', () => {
    const { root, legs } = buildFakeRig()
    legs[0].toe.parent.remove(legs[0].toe)
    expect(matchRigBones(root)).toBeNull()
  })
})

describe('legAngles 步态曲线', () => {
  const c = { thigh: 0.5, knee: 0.55, foot: 0.22 }
  it('膝恒为负（只屈不反关节）且含基础微屈；大腿正弦限幅', () => {
    for (let i = 0; i < 64; i++) {
      const a = legAngles((i / 64) * Math.PI * 2, c)
      expect(a.knee).toBeLessThanOrEqual(-0.12 + 1e-9)
      expect(Math.abs(a.thigh)).toBeLessThanOrEqual(c.thigh + 1e-9)
      expect(a.foot).toBeGreaterThanOrEqual(-0.45 - 1e-9)
      expect(a.foot).toBeLessThanOrEqual(0.55 + 1e-9)
    }
  })
})

describe('bakeLocomotionClips 烘焙', () => {
  const make = () => {
    const { hips, legs, spine, neck } = buildFakeRig()
    const bindOf = (b) => b.getWorldQuaternion(new THREE.Quaternion())
    const rigLegs = legs.map(l => ({
      side: l.side, up: l.up, knee: l.knee, foot: l.foot, toe: l.toe,
      bind: { up: bindOf(l.up), knee: bindOf(l.knee), foot: bindOf(l.foot), toe: bindOf(l.toe) },
    }))
    return { hipsBone: hips, legs: rigLegs, spineBones: spine, neckBone: neck }
  }

  it('返回 walk/run 双 clip，周期与 timeScale 锁相基准对齐（2×1.15/速度）', () => {
    const baked = bakeLocomotionClips(make())
    expect(baked.walk.name).toBe('walk')
    expect(baked.run.name).toBe('run')
    expect(baked.walk.duration).toBeCloseTo((2 * 1.15) / 1.9, 9)
    expect(baked.run.duration).toBeCloseTo((2 * 1.15) / 5.2, 9)
  })

  it('轨道按骨名绑定：双腿三节 + 髋四元数/位移；数值有限且单位四元数', () => {
    const baked = bakeLocomotionClips(make())
    const names = baked.walk.tracks.map(t => t.name)
    for (const n of ['L_Hip_0136.quaternion', 'L_Knee_0137.quaternion', 'L_Foot_0140.quaternion',
      'R_Hip_0146.quaternion', 'Pelvis_0131.quaternion', 'Pelvis_0131.position']) {
      expect(names).toContain(n)
    }
    // 手臂/趾骨不出轨道：跑步上身保持持枪姿态（kamae clip 权重外骨骼停最后写入帧）
    expect(names.some(n => n.startsWith('L_Toe') || n.startsWith('R_Toe'))).toBe(false)
    for (const clip of [baked.walk, baked.run]) {
      for (const t of clip.tracks) {
        const v = t.values
        for (let i = 0; i < v.length; i++) expect(Number.isFinite(v[i])).toBe(true)
        if (t.name.endsWith('.quaternion')) {
          for (let i = 0; i < v.length; i += 4) {
            expect(Math.hypot(v[i], v[i + 1], v[i + 2], v[i + 3])).toBeCloseTo(1, 5)
          }
        }
      }
    }
  })

  it('walk 无脊柱前倾轨道、run 有（分摊到每节）；legs 不齐返回 null', () => {
    const spec = make()
    const baked = bakeLocomotionClips(spec)
    expect(baked.walk.tracks.some(t => t.name.startsWith('Spine'))).toBe(false)
    expect(baked.run.tracks.some(t => t.name === 'Spine1_03.quaternion')).toBe(true)
    expect(baked.run.tracks.some(t => t.name === 'Neck_07.quaternion')).toBe(true)
    expect(bakeLocomotionClips({ hipsBone: spec.hipsBone, legs: [spec.legs[0]] })).toBeNull()
  })

  it('clip 可被 AnimationMixer 绑定（PropertyBinding 解析骨名）', async () => {
    const { root, hips } = buildFakeRig()
    const spec = make()
    const baked = bakeLocomotionClips(spec)
    const mixer = new THREE.AnimationMixer(root)
    const action = mixer.clipAction(baked.walk)
    action.play()
    mixer.update(0.3)
    expect(hips.quaternion.x).toBeDefined()
    // 播放后骨骼确实离开 bind 姿态（步态在动）
    expect(hips.position.y).not.toBe(0.1)
  })
})
