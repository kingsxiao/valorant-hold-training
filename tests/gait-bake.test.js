// GaitBake：无畏契约英雄 GLB（UE 骨架）接入的两块纯逻辑 ——
// 骨名映射（UE/Mixamo 双口径 + 辅助骨排除）与程序化 walk/run clip 烘焙
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { RIG_MATCH, matchRigBones, legAngles, bakeLocomotionClips, GAIT } from '../src/core/GaitBake.js'

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

describe('RIG_MATCH 手臂/挂枪骨映射（挂枪锚点 + 死亡撒手轨道）', () => {
  it('UE 四英雄骨名命中（Jett/Sage/Sova/Phoenix 实测名），辅助骨排除', () => {
    expect(m(RIG_MATCH.arm.L.up[0], 'L_Shoulder_054')).toBe(true)
    expect(m(RIG_MATCH.arm.L.fore[0], 'L_Elbow_055')).toBe(true)
    expect(m(RIG_MATCH.arm.L.hand[0], 'L_Hand_056')).toBe(true)
    expect(m(RIG_MATCH.arm.R.up[0], 'R_Shoulder_092')).toBe(true)
    expect(m(RIG_MATCH.arm.R.fore[0], 'R_Elbow_093')).toBe(true)
    expect(m(RIG_MATCH.weapon.L[0], 'L_WeaponPoint_061')).toBe(true)
    expect(m(RIG_MATCH.weapon.R[0], 'R_WeaponPoint_099')).toBe(true)
    // Twst/Pad/IK/end 辅助骨全部排除
    for (const re of RIG_MATCH.arm.L.up) { expect(m(re, 'L_Shoulder_Twst1_085')).toBe(false); expect(m(re, 'L_ShoulderPad_089')).toBe(false) }
    for (const re of RIG_MATCH.arm.L.fore) expect(m(re, 'L_Elbow_Ndl_080')).toBe(false)
    for (const re of RIG_MATCH.arm.L.hand) expect(m(re, 'L_Hand_IKpv_IUE_0177')).toBe(false)
    for (const re of RIG_MATCH.weapon.L) expect(m(re, 'L_WeaponPoint_end_062')).toBe(false)
  })

  it('Mixamo 口径兼容（LeftArm/LeftForeArm/LeftHand）', () => {
    expect(m(RIG_MATCH.arm.L.up[1], 'mixamorig:LeftArm')).toBe(true)
    expect(m(RIG_MATCH.arm.L.fore[1], 'mixamorig:LeftForeArm')).toBe(true)
    expect(m(RIG_MATCH.arm.L.hand[1], 'mixamorig:LeftHand')).toBe(true)
  })

  it('matchRigBones 可选增强：arms/weapon 缺失不拖垮腿链（返回空数组/null）', () => {
    const { root } = buildFakeRig()
    const rig = matchRigBones(root)
    expect(rig).toBeTruthy()
    expect(rig.arms).toEqual([])
    expect(rig.weaponL).toBeNull()
    expect(rig.weaponR).toBeNull()
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
  const c = { thigh: 0.5, knee: 0.55, kneeBase: 0.5, foot: 0.22, toe: 0.155 }
  it('膝恒为负（只屈不反关节）且含基础屈曲；大腿正弦限幅；趾只屈不反关节', () => {
    for (let i = 0; i < 64; i++) {
      const a = legAngles((i / 64) * Math.PI * 2, c)
      expect(a.knee).toBeLessThanOrEqual(-c.kneeBase + 1e-9)
      expect(Math.abs(a.thigh)).toBeLessThanOrEqual(c.thigh + 1e-9)
      expect(a.foot).toBeGreaterThanOrEqual(-0.45 - 1e-9)
      expect(a.foot).toBeLessThanOrEqual(0.55 + 1e-9)
      expect(a.toe).toBeLessThanOrEqual(1e-9)              // 趾只屈（蹬地）
      expect(a.toe).toBeGreaterThanOrEqual(-c.toe - 1e-9)  // 幅值 ≤ toe
    }
  })

  it('官方动画实测校准锁死：膝峰值/基础屈曲/髋摆（assets-raw psa 解析口径）', () => {
    // 官方：跑膝基础屈曲 20~33°、峰值 108~117°；走基础 29~63°、峰值 88~103°；
    // 髋摆全幅 跑~60° / 走~42°。烘焙曲线取：跑 0.38+1.55rad=21.8°+110.6°、
    // 走 0.50+0.95rad=28.6°+83.0°、髋 跑 0.82rad(47°) / 走 0.70rad(40°)
    expect(GAIT.run.kneeBase + GAIT.run.knee).toBeCloseTo(1.93, 5)   // ≈110.6°
    expect(GAIT.walk.kneeBase + GAIT.walk.knee).toBeCloseTo(1.45, 5) // ≈83.1°
    expect(GAIT.run.kneeBase).toBeCloseTo(0.38, 5)
    expect(GAIT.walk.kneeBase).toBeCloseTo(0.50, 5)
    expect(GAIT.run.thigh).toBeCloseTo(0.82, 5)
    expect(GAIT.walk.thigh).toBeCloseTo(0.70, 5)
    // 跑/走膝基础屈曲与峰值跨度不越出官方实测区间
    const runPk = (GAIT.run.kneeBase + GAIT.run.knee) * 180 / Math.PI
    const walkPk = (GAIT.walk.kneeBase + GAIT.walk.knee) * 180 / Math.PI
    expect(runPk).toBeGreaterThanOrEqual(108)
    expect(runPk).toBeLessThanOrEqual(117)
    expect(walkPk).toBeGreaterThanOrEqual(83)
    expect(walkPk).toBeLessThanOrEqual(103)
  })

  it('盆骨三轴官方口径锁死（psa_pelvis.py 实测：yaw 摆/roll 侧摆/pitch 前倾 + bob 收敛）', () => {
    // 官方：盆骨 yaw 振荡 跑 11.5° / 走 11.9°；roll 侧摆 跑 10.1° / 走 5.65°；
    // pitch 前倾 跑 -7(Jett -13.5)°→ 取 -8.6°、走 +3.7~+11.9° → 取 +2.9°；
    // LB 脊柱零轨道 → 前倾主体移到盆骨（spine lean 0.16 → 0.05 仅留补 kamae 直立）；
    // 盆骨高度起伏官方 跑 ≤3mm / 走 0 → bob 0.012/0.006 防滑步下限
    expect(GAIT.run.hipsYaw).toBeCloseTo(0.201, 5)
    expect(GAIT.walk.hipsYaw).toBeCloseTo(0.207, 5)
    expect(GAIT.run.hipsRoll).toBeCloseTo(0.176, 5)
    expect(GAIT.walk.hipsRoll).toBeCloseTo(0.099, 5)
    expect(GAIT.run.hipsPitch).toBeCloseTo(-0.15, 5)
    expect(GAIT.walk.hipsPitch).toBeCloseTo(0.05, 5)
    expect(GAIT.run.lean).toBeCloseTo(0.05, 5)
    expect(GAIT.run.bob).toBeLessThanOrEqual(0.012)
    expect(GAIT.walk.bob).toBeLessThanOrEqual(0.006)
  })

  it('趾骨蹬地官方口径锁死（psa L_Toe 2× 谐波：跑 7.5°/走 8.85°，峰值在蹬地）', () => {
    expect(GAIT.run.toe).toBeCloseTo(0.13, 5)
    expect(GAIT.walk.toe).toBeCloseTo(0.155, 5)
    // 蹬地屈伸是 2× 步频（每步一次提踵），且峰值相位 = max(0,-sin(2(p+1.6)))
    const a1 = legAngles(Math.PI * 2 - 1.6 - Math.PI / 4, GAIT.run) // sin(2(p+1.6))=-1 → 峰值
    expect(a1.toe).toBeCloseTo(-GAIT.run.toe, 5)
    const a0 = legAngles(Math.PI * 2 - 1.6, GAIT.run) // sin=0 → 中性
    expect(a0.toe).toBeCloseTo(0, 5)
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

  it('返回 walk/run 双 clip，周期与官方步频锁相基准对齐（2×1.55/速度）', () => {
    const baked = bakeLocomotionClips(make())
    expect(baked.walk.name).toBe('walk')
    expect(baked.run.name).toBe('run')
    // 官方口径：走 ≈3.39m/s（周期 ~0.9s）、跑 5.4m/s（周期 ~0.57s，官方 clip 0.6s）
    expect(baked.walk.duration).toBeCloseTo((2 * 1.55) / 3.39, 9)
    expect(baked.run.duration).toBeCloseTo((2 * 1.55) / 5.4, 9)
  })

  it('轨道按骨名绑定：双腿四节（含趾蹬地轨道）+ 髋四元数/位移；数值有限且单位四元数', () => {
    const baked = bakeLocomotionClips(make())
    const names = baked.walk.tracks.map(t => t.name)
    for (const n of ['L_Hip_0136.quaternion', 'L_Knee_0137.quaternion', 'L_Foot_0140.quaternion',
      'R_Hip_0146.quaternion', 'Pelvis_0131.quaternion', 'Pelvis_0131.position']) {
      expect(names).toContain(n)
    }
    // 趾骨蹬地轨道（官方 L_Toe 2× 谐波 7.5~8.85°）：双腿都有
    expect(names).toContain('L_Toe_0120.quaternion')
    expect(names).toContain('R_Toe_0151.quaternion')
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
