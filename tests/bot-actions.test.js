// Bot 动作 1:1 本轮两块新纯逻辑：
//  WeaponAim —— 挂枪瞄准解算（-Z=枪口向）/ 瞄准目标选择 / 掉枪弹道 / 后坐曲线
//  GaitBake.deathPose / bakeDeathClips —— 骨骼化死亡塌倒烘焙
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { solveGunAim, pickAimTarget, gunBobPose, stepDroppedGun, settleFlatQ, kickPose, solveTwoBoneIK, deriveGunHoldPoints, solveGripMount } from '../src/core/WeaponAim.js'
import { deathPose, bakeDeathClips } from '../src/core/GaitBake.js'

const V = (x, y, z) => new THREE.Vector3(x, y, z)

describe('solveGunAim 挂枪瞄准解算', () => {
  it('局部 -Z（枪口向）精确指向目标，+Y 尽量朝上', () => {
    const q = solveGunAim(V(0, 0, 0), V(0, 0, -5))
    const muzzle = V(0, 0, -1).applyQuaternion(q)
    expect(muzzle.x).toBeCloseTo(0, 5); expect(muzzle.z).toBeCloseTo(-1, 5)
    const q2 = solveGunAim(V(1, 1, 1), V(6, 1, 1))
    const dir = V(6, 1, 1).sub(V(1, 1, 1)).normalize()
    const got = V(0, 0, -1).applyQuaternion(q2)
    expect(got.distanceTo(dir)).toBeLessThan(1e-5)
    expect(V(0, 1, 0).applyQuaternion(q2).y).toBeGreaterThan(0.9)
  })

  it('近垂直俯仰不退化（方向压回 72° 内），零距离回单位', () => {
    const q = solveGunAim(V(0, 0, 0), V(0, 5, 0.001))
    expect(q.length()).toBeCloseTo(1, 6)
    expect(Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z)).toBe(true)
    const q0 = solveGunAim(V(0, 0, 0), V(0, 0, 0))
    expect(q0.x).toBe(0); expect(q0.w).toBe(1)
  })
})

describe('pickAimTarget 瞄准目标选择', () => {
  it('pull 对枪/站定/急停瞄玩家；cross 跑动顺跑向携枪', () => {
    expect(pickAimTarget({ style: 'pull', stopped: false, moving: true })).toBe('player')
    expect(pickAimTarget({ style: 'cross', stopped: true, moving: true })).toBe('player')
    expect(pickAimTarget({ style: 'cross', stopped: false, moving: false })).toBe('player')
    expect(pickAimTarget({ style: 'cross', stopped: false, moving: true })).toBe('forward')
  })
})

describe('gunBobPose 步伐随动', () => {
  it('站定/低速全零（对枪枪口纪律），幅度随速度线性涨到跑速满幅', () => {
    for (const sp of [0, 0.3, 0.4]) {
      const z = gunBobPose({ phase: 1.23, speed: sp })
      expect(z.dip).toBe(0); expect(z.sway).toBe(0); expect(z.roll).toBe(0)
    }
    const walk = gunBobPose({ phase: 0.9, speed: 2.7 })
    const run = gunBobPose({ phase: 0.9, speed: 5.4 })
    expect(run.dip).toBeCloseTo(walk.dip * 2, 6) // 2.7/5.4 = 半幅线性
    expect(Math.abs(run.dip)).toBeLessThanOrEqual(0.008 + 1e-9) // ±8mm 封顶
  })

  it('dip 每步下沉一次：谷在落脚（kπ）后 ~0.28rad，摆动中段回正', () => {
    const at = (p) => gunBobPose({ phase: p, speed: 5.4 }).dip
    expect(at(Math.PI + 0.28)).toBeCloseTo(-0.008, 6)  // 落脚后惯性下沉谷
    expect(at(Math.PI)).toBeLessThan(-0.006)           // 落脚瞬间已大部分压实
    expect(at(Math.PI + Math.PI / 2 + 0.28)).toBeCloseTo(0.008, 6) // 摆动中段回升峰
    expect(at(0)).toBeCloseTo(at(Math.PI), 9)          // 周期 π 每步重复
  })

  it('sway 左右脚交替（周期 2π 反号），roll 有界', () => {
    const sway = (p) => gunBobPose({ phase: p, speed: 5.4 }).sway
    expect(sway(Math.PI / 2)).toBeCloseTo(0.005, 6)
    expect(sway(3 * Math.PI / 2)).toBeCloseTo(-0.005, 6)
    expect(sway(0)).toBeCloseTo(0, 9)
    const roll = (p) => gunBobPose({ phase: p, speed: 5.4 }).roll
    expect(Math.abs(roll(1.4))).toBeLessThanOrEqual(0.007 + 1e-9)
  })
})

describe('stepDroppedGun 掉枪弹道', () => {
  const st = (vy = 0) => ({
    p: V(0, 1.5, 0), q: new THREE.Quaternion(),
    v: V(0.5, vy, 0), axis: V(1, 0, 0), spin: 6, restY: 0.05, landed: false,
  })
  it('空中受重力 + 翻滚（四元数改变、y 下坠、平移前进）；纯函数不改入参', () => {
    const s0 = st()
    const s1 = stepDroppedGun(s0, 0.016)
    expect(s1.v.y).toBeLessThan(s0.v.y)
    expect(s1.p.y).toBeLessThan(s0.p.y)
    expect(s1.p.x).toBeGreaterThan(s0.p.x)
    expect(s1.q.angleTo(s0.q)).toBeGreaterThan(0.01)
    expect(s0.p.y).toBeCloseTo(1.5, 9) // 入参未被原地修改
  })
  it('上抛初速先升后落（重力只改速度方向，水平速度守恒）', () => {
    const s0 = st(2)
    const s1 = stepDroppedGun(s0, 0.1)
    expect(s1.p.y).toBeGreaterThan(s0.p.y)
    expect(s1.v.x).toBeCloseTo(s0.v.x, 9)
  })
  it('落到 restY 钳平并置 landed；landed 后不再演化', () => {
    let s = st()
    for (let i = 0; i < 200 && !s.landed; i++) s = stepDroppedGun(s, 1 / 60)
    expect(s.landed).toBe(true)
    expect(s.p.y).toBeCloseTo(0.05, 6)
    const again = stepDroppedGun(s, 0.1)
    expect(again).toBe(s)
  })
})

describe('stepDroppedGun 落地反弹与偏心翻滚', () => {
  const st = (over = {}) => ({
    p: V(0, 1.2, 0), q: new THREE.Quaternion(),
    v: V(0.5, 0, 0), axis: V(1, 0, 0), spin: 6, restY: 0.05, landed: false, ...over,
  })
  it('高速着地弹起再落，≤2 次后趴住（bounces 计数锁定）', () => {
    let s = st()
    let touched = false, rose = false
    for (let i = 0; i < 400 && !s.landed; i++) {
      s = stepDroppedGun(s, 1 / 60)
      if (s.p.y <= 0.051) touched = true
      else if (touched && s.p.y > 0.08) rose = true // 触地后弹起（离地 >3cm）
    }
    expect(touched).toBe(true)
    expect(rose).toBe(true)
    expect(s.landed).toBe(true)
    expect(s.bounces).toBe(2) // 1.2m 落高：两次弹后着速 <0.8m/s 停
  })
  it('慢落（着速 <0.8）直接趴住不弹', () => {
    let s = st({ p: V(0, 0.06, 0), v: V(0, 0, 0) })
    for (let i = 0; i < 3; i++) s = stepDroppedGun(s, 1 / 60)
    expect(s.landed).toBe(true)
    expect(s.bounces).toBe(0)
  })
  it('pivotLocal 偏心翻滚：位置绕枪口端公转（路径偏离中心自旋，轴距守恒）', () => {
    const base = { p: V(0, 1.0, 0), q: new THREE.Quaternion(), v: V(0, 0, 0), axis: V(1, 0, 0), spin: 6, restY: 0.05, landed: false }
    const a = stepDroppedGun(base, 0.016, 0) // g=0 隔离平移，只看公转
    const b = stepDroppedGun({ ...base, pivotLocal: V(0, 0, -0.2) }, 0.016, 0)
    expect(b.p.distanceTo(a.p)).toBeGreaterThan(1e-3)
    const pivot = V(0, 0, -0.2).applyQuaternion(base.q).add(base.p)
    expect(b.p.distanceTo(pivot)).toBeCloseTo(base.p.distanceTo(pivot), 6)
  })
})

describe('settleFlatQ 落地摆平', () => {
  it('保留水平 yaw、清除俯仰/横滚（-Z 投影回水平面）', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 1.2, -0.3, 'YXZ'))
    const flat = settleFlatQ(q)
    const fwd = V(0, 0, -1).applyQuaternion(flat)
    expect(Math.abs(fwd.y)).toBeLessThan(1e-6)
    const orig = V(0, 0, -1).applyQuaternion(q)
    expect(Math.atan2(-fwd.x, -fwd.z)).toBeCloseTo(Math.atan2(-orig.x, -orig.z), 5)
  })
})

describe('kickPose 开火后坐', () => {
  it('随 k 线性衰减，k=0 无后坐', () => {
    expect(kickPose(1).spine).toBeGreaterThan(kickPose(0.5).spine)
    expect(kickPose(0).spine).toBe(0)
    expect(kickPose(0).gunZ).toBe(0)
    expect(kickPose(1).gunZ).toBeGreaterThan(0)
  })
})

describe('deriveGunHoldPoints 枪体握点几何推导', () => {
  // AK 族简化几何（归一化口径：枪口 -Z、居中）：枪管前段 + 护木 + 弹匣 + 握把 + 枪托。
  // 深度方向细分（真实枪模顶点沿枪身稠密分布；纯 24 顶点盒的角落稀疏采样会让
  // z 分箱簇碎裂）。BoxGeometry 顶点在 mesh 局部，根为独立 Group（matrixWorld = 摆放系）
  const box = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, 1, 1, Math.max(2, Math.round(d / 0.02))))
    m.position.set(x, y, z)
    return m
  }
  const gun = () => {
    const g = new THREE.Group()
    g.add(box(0.05, 0.09, 0.5, 0, 0.07, -0.19))    // 机匣+枪管前段（轴线 ~0.07）
    g.add(box(0.05, 0.06, 0.14, 0, 0.05, -0.24))   // 护木（前段下方）
    g.add(box(0.05, 0.14, 0.12, 0, -0.005, -0.02)) // 弹匣（中段、深）
    g.add(box(0.05, 0.09, 0.09, 0, -0.03, 0.17))   // 握把（后段、低于枪管线）
    g.add(box(0.05, 0.1, 0.16, 0, 0.06, 0.32))     // 枪托（末端、高于握把底）
    return g
  }

  it('后握点落在握把块内（z 带内最深簇：排除前方弹匣与后方枪托）', () => {
    const { grip } = deriveGunHoldPoints(gun())
    expect(grip.z).toBeGreaterThan(0.12)
    expect(grip.z).toBeLessThan(0.24)
    expect(grip.y).toBeLessThan(0.02)    // 低于枪管轴线
    expect(grip.y).toBeGreaterThan(-0.09)
  })

  it('前握点落在护木段（枪管前段 |y-轴线| 环带顶点质心）', () => {
    const { fore } = deriveGunHoldPoints(gun())
    expect(fore.z).toBeLessThan(-0.05)
    expect(fore.z).toBeGreaterThan(-0.33)
    expect(Math.abs(fore.y - 0.07)).toBeLessThan(0.05)
  })

  it('无网格几何返回 null', () => {
    expect(deriveGunHoldPoints(new THREE.Group())).toBe(null)
  })
})

describe('solveGripMount 握把钉位', () => {
  it('恒等式：meshPos + R_meshQ·(holderPos + R_hwQ·gripLocal) = worldGrip', () => {
    const worldGrip = V(2, 1.2, -3)
    const meshPos = V(1.5, 0, -2.6)
    const meshQ = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), 0.7)
    const holderWorldQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -0.5, 0.04))
    const gripLocal = V(0, -0.05, 0.2)
    const pos = solveGripMount(worldGrip, meshPos, meshQ, holderWorldQ, gripLocal)
    const lhs = pos.clone().add(gripLocal.clone().applyQuaternion(holderWorldQ))
    const rhs = worldGrip.clone().sub(meshPos).applyQuaternion(meshQ.clone().invert())
    expect(lhs.distanceTo(rhs)).toBeLessThan(1e-9)
  })

  it('恒等 mesh：holder 位 = 世界握点直减 R_hwQ·gripLocal', () => {
    const holderWorldQ = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), 1.1)
    const gripLocal = V(0, -0.03, 0.17)
    const worldGrip = V(3, 1, -4)
    const pos = solveGripMount(worldGrip, V(0, 0, 0), new THREE.Quaternion(), holderWorldQ, gripLocal)
    expect(pos.distanceTo(worldGrip.clone().sub(gripLocal.clone().applyQuaternion(holderWorldQ)))).toBeLessThan(1e-9)
  })
})

describe('solveTwoBoneIK 左手两骨 IK', () => {
  // 左臂前伸持枪位：肩(0,1.4,0) 肘(0.1,1.25,-0.22) 腕(0.05,1.22,-0.48)
  const arm = () => ({
    a: V(0, 1.4, 0),
    b: V(0.1, 1.25, -0.22),
    c: V(0.05, 1.22, -0.48),
  })

  it('目标=当前腕位 → 旋转增量为零（极向量=当前上臂方向，kamae 贴手不跳变）', () => {
    const { a, b, c } = arm()
    const sol = solveTwoBoneIK({ shoulder: a, elbow: b, hand: c, target: c.clone() })
    expect(sol).toBeTruthy()
    expect(sol.abDirCur.angleTo(sol.dirAb)).toBeLessThan(1e-6)
  })

  it('可达目标：长度保持 + 腕精确落到目标（肩→肘新位=lab，肘新位+dirCb·lcb=目标）', () => {
    const { a, b, c } = arm()
    const target = V(0.05, 1.24, -0.44) // 护木前下 ~10cm（臂展 0.55 内）
    const sol = solveTwoBoneIK({ shoulder: a, elbow: b, hand: c, target })
    expect(sol.clamped).toBe(false)
    const elbowNew = a.clone().addScaledVector(sol.dirAb, sol.lab)
    expect(elbowNew.distanceTo(a)).toBeCloseTo(sol.lab, 6)
    const handNew = elbowNew.clone().addScaledVector(sol.dirCb, sol.lcb)
    expect(handNew.distanceTo(target)).toBeLessThan(1e-6)
    // 上臂方向变化平滑（不是大角度翻转）
    expect(sol.abDirCur.angleTo(sol.dirAb)).toBeLessThan(1.2)
  })

  it('超距目标：钳制为完全伸展（上臂与前臂同向），数据不齐返回 null', () => {
    const { a, b, c } = arm()
    const far = V(0, 1.4, -5)
    const sol = solveTwoBoneIK({ shoulder: a, elbow: b, hand: c, target: far })
    expect(sol.clamped).toBe(true)
    expect(sol.dirAb.angleTo(sol.dirCb)).toBeLessThan(0.05)
    expect(solveTwoBoneIK({ shoulder: a, elbow: a, hand: c, target: far })).toBeNull()
  })
})

describe('deathPose 死亡塌倒曲线', () => {
  it('t=0 全零（击杀瞬间不跳变），随 t 单调放大，t=1 到位', () => {
    const p0 = deathPose(0)
    for (const k of ['hipsPitch', 'knee', 'spineCurl', 'armDrop']) expect(Math.abs(p0[k])).toBe(0)
    let prev = 0
    for (let i = 1; i <= 8; i++) {
      const p = deathPose(i / 8)
      expect(p.hipsPitch).toBeGreaterThan(prev)
      prev = p.hipsPitch
    }
    const p1 = deathPose(1)
    expect(p1.hipsPitch).toBeCloseTo(1.45, 6)   // 盆骨后仰 ~83°
    expect(p1.thigh).toBeCloseTo(-1.45 * 0.82, 6) // 腿反向补偿（躺平）
    expect(p1.knee).toBeLessThan(0)               // 屈膝不为反关节
  })
})

// 最小 UE 骨架（含脊柱/颈/手臂/盆骨父级），与 gait-bake.test 的假腿骨架同思路
function buildFakeRig() {
  const root = new THREE.Group()
  const B = (name) => { const b = new THREE.Bone(); b.name = name; return b }
  const hips = B('Pelvis_0131'); root.add(hips)
  hips.position.y = 1.0 // 盆骨 bind 世界高（下沉折算基准，与英雄 GLB 实测 ~0.97 同量级）
  const legs = []
  for (const [side, hipN, kneeN, footN] of [
    ['L', 'L_Hip_0136', 'L_Knee_0137', 'L_Foot_0140'],
    ['R', 'R_Hip_0146', 'R_Knee_0147', 'R_Foot_0150'],
  ]) {
    const up = B(hipN), knee = B(kneeN), foot = B(footN), toe = B(side + '_Toe_01')
    hips.add(up); up.add(knee); knee.add(foot); foot.add(toe)
    up.position.y = -0.05; knee.position.y = -0.45; foot.position.y = -0.45
    legs.push({ side, up, knee, foot, toe })
  }
  const spine = []
  let cur = hips
  for (const n of ['Spine1_03', 'Spine2_04']) { const s = B(n); cur.add(s); s.position.y = 0.12; cur = s; spine.push(s) }
  const neck = B('Neck_07'); cur.add(neck); neck.position.y = 0.15
  const arms = []
  for (const [side] of [['L'], ['R']]) {
    const up = B(side + '_Shoulder_054'), fore = B(side + '_Elbow_055'), hand = B(side + '_Hand_056')
    cur.add(up); up.add(fore); fore.add(hand)
    up.position.x = side === 'L' ? -0.15 : 0.15; fore.position.y = 0.3; hand.position.y = 0.28
    arms.push({ side, up, fore, hand })
  }
  root.updateMatrixWorld(true)
  const bindOf = (b) => b.getWorldQuaternion(new THREE.Quaternion())
  return {
    root, hips, spine, neck, arms,
    legs: legs.map(l => ({ ...l, bind: { up: bindOf(l.up), knee: bindOf(l.knee), foot: bindOf(l.foot), toe: bindOf(l.toe) } })),
  }
}

describe('bakeDeathClips 死亡烘焙', () => {
  const make = () => {
    const r = buildFakeRig()
    return {
      rig: r,
      spec: {
        hipsBone: r.hips,
        hipsParentW: r.hips.parent.getWorldQuaternion(new THREE.Quaternion()),
        hipsBindW: r.hips.getWorldQuaternion(new THREE.Quaternion()),
        hipsBindY: r.hips.getWorldPosition(new THREE.Vector3()).y,
        legs: r.legs,
        spineBones: r.spine, spineBindW: r.spine.map(b => b.getWorldQuaternion(new THREE.Quaternion())),
        neckBone: r.neck, neckBindW: r.neck.getWorldQuaternion(new THREE.Quaternion()),
        arms: r.arms,
        roll: 0.2, duration: 0.55,
      },
    }
  }

  it('轨道覆盖盆骨四元数+位移、双腿、脊柱、颈、手臂；数值有限且单位四元数', () => {
    const { spec } = make()
    const clip = bakeDeathClips(spec)
    expect(clip.name).toBe('death')
    expect(clip.duration).toBeCloseTo(0.55, 9)
    const names = clip.tracks.map(t => t.name)
    for (const n of ['Pelvis_0131.quaternion', 'Pelvis_0131.position',
      'L_Hip_0136.quaternion', 'R_Knee_0147.quaternion',
      'Spine1_03.quaternion', 'Neck_07.quaternion',
      'L_Shoulder_054.quaternion', 'R_Elbow_055.quaternion']) expect(names).toContain(n)
    for (const t of clip.tracks) {
      for (let i = 0; i < t.values.length; i++) expect(Number.isFinite(t.values[i])).toBe(true)
      if (t.name.endsWith('.quaternion')) {
        for (let i = 0; i < t.values.length; i += 4) {
          expect(Math.hypot(t.values[i], t.values[i + 1], t.values[i + 2], t.values[i + 3])).toBeCloseTo(1, 5)
        }
      }
    }
  })

  it('盆骨下沉到位（末帧 y ≈ restY 折算）且首帧=bind（击杀瞬间不跳变）', () => {
    const { spec } = make()
    const clip = bakeDeathClips(spec)
    const pos = clip.tracks.find(t => t.name === 'Pelvis_0131.position')
    const bindY = pos.values[1] // 首帧 = bind 局部 y
    const lastY = pos.values[pos.values.length - 2]
    expect(bindY).toBeCloseTo(spec.hipsBone.position.y, 6)
    expect(lastY).toBeCloseTo(spec.hipsBone.position.y - (spec.hipsBindY - 0.11), 5)
  })

  it('clip 可被 AnimationMixer 绑定并推进（盆骨旋转离开 bind）', () => {
    const { rig, spec } = make()
    const clip = bakeDeathClips(spec)
    const mixer = new THREE.AnimationMixer(rig.root)
    const a = mixer.clipAction(clip)
    a.play(); a.setEffectiveWeight(1)
    mixer.update(0.3)
    expect(Math.abs(rig.hips.quaternion.angleTo(new THREE.Quaternion()))).toBeGreaterThan(0.01)
  })

  it('数据不齐返回 null（无盆骨父级基准/腿不齐）', () => {
    const { spec } = make()
    expect(bakeDeathClips({ ...spec, hipsParentW: null })).toBeNull()
    expect(bakeDeathClips({ ...spec, legs: [spec.legs[0]] })).toBeNull()
  })
})

describe('蹲姿命中区逐区缩放（raycast 逐区 cr 插值）', () => {
  // Bot.prototype.raycast 用最小桩直测：zones 高度按 1−0.30·蹲姿权重缩放
  // crouchW：蹲姿权重（逐区高度 = 1 + (cr−1)·crouchW 插值）
  const stub = (crouchW) => ({
    invulnerable: false,
    // 逐区蹲姿比：head 0.70 / leg 0.70
    zones: [
      { y: 1.63, r: 0.13, zone: 'head', cr: 0.7 },
      { y: 0.22, r: 0.14, zone: 'leg', cr: 0.7 },
    ],
    _crouchW: crouchW,
    mesh: { quaternion: { get x() { return 0 }, get y() { return 0 }, get z() { return 0 }, get w() { return 1 } }, position: { x: 0, y: 0, z: 0 } },
  })
  const getRaycast = async () => (await import('../src/entities/Bot.js')).Bot.prototype.raycast
  it('站定（crouchW=0）头部命中区在 1.63m', async () => {
    const raycast = await getRaycast()
    const hit = raycast.call(stub(0), 0, 1.63, 5, 0, 0, -1, 50)
    expect(hit.zone).toBe('head')
  })
  it('蹲姿头部区跟随 Head 骨（前倾前移建模）：命中中心 = 骨世界位 + 0.06', async () => {
    const raycast = await getRaycast()
    // 假 Head 骨：骨原点在 (0.3, 0.75, -0.4)（蹲姿前倾前移后的真实渲染头位）
    const m = { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0.3, 0.75, -0.4, 1] }
    const s = {
      invulnerable: false,
      zones: [{ y: 1.63, r: 0.13, zone: 'head' }],
      _crouchW: 1,
      _headBone: { updateWorldMatrix() {}, matrixWorld: m },
      mesh: { quaternion: { get x() { return 0 }, get y() { return 0 }, get z() { return 0 }, get w() { return 1 } }, position: { x: 0, y: 0, z: 0 } },
    }
    // 站立缩放线（1.14）打空；头部骨位（+0.06 颅心偏移）命中
    expect(raycast.call(s, 0, 1.14, 5, 0, 0, -1, 50)).toBeNull()
    const hit = raycast.call(s, 0.3, 0.81, 5, 0, 0, -1, 50)
    expect(hit.zone).toBe('head')
  })

  it('蹲满（crouchW=1，cr=0.70）头部区下沉到 ~1.14m：站立爆头线打空、下压命中', async () => {
    const raycast = await getRaycast()
    const s = stub(1)
    const miss = raycast.call(s, 0, 1.63, 5, 0, 0, -1, 50) // 站立爆头线
    expect(miss).toBeNull()
    const hit = raycast.call(s, 0, 1.14, 5, 0, 0, -1, 50)
    expect(hit.zone).toBe('head')
  })
})
