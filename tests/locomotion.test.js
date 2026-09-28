// Locomotion：官方 .psa 曲线（locomotion.json）→ AnimationClip 的构建与
// 走/跑/横移权重分配（Bot._setAnimWeights 共用的纯函数）
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import fs from 'node:fs'
import { buildClip, buildLocomotion, locoWeights, sampleIkAnchor, pickDeathSide, CROUCH_WALK_STEP, CROUCH_WALK_SPEED, gaitStepLen, STEP_WALK, STEP_RUN, STEP_STRAFE_RUN } from '../src/core/Locomotion.js'

// 假骨架：UE 风格带 _NNNN 后缀骨名（与英雄 GLB 同构）
function fakeHeroSkeleton(suffixes) {
  const root = new THREE.Object3D()
  root.name = 'mesh'
  let parent = root
  for (const [plain, suf] of suffixes) {
    const b = new THREE.Bone()
    b.name = plain + '_' + suf
    parent.add(b)
    parent = b
  }
  return root
}

const JSON_CLIP = {
  duration: 0.6,
  times: [0, 0.3, 0.6],
  tracks: [
    { b: 'Pelvis', q: [0, 0, 0, 1, 0, 0.1, 0, 0.99, 0, 0, 0, 1], p: [0, 0.9, 0, 0, 0.92, 0, 0, 0.9, 0] },
    { b: 'L_Hip', q: [0, 0, 0, 1, 0.05, 0, 0, 1, 0, 0, 0, 1] },
    { b: 'Nope_Bone', q: [0, 0, 0, 1] }, // 目标骨架没有 → 跳过
  ],
}

describe('buildClip 骨名后缀解析', () => {
  it('psa 无后缀骨名 → GLB _NNNN 后缀骨名建轨道；缺骨跳过；四元数/位置原样保留', () => {
    const root = fakeHeroSkeleton([['Pelvis', '0131'], ['L_Hip', '0136']])
    const clip = buildClip(JSON_CLIP, root, 'runN')
    expect(clip.name).toBe('runN')
    expect(clip.duration).toBeCloseTo(0.6, 5)
    const names = clip.tracks.map(t => t.name)
    expect(names).toContain('Pelvis_0131.quaternion')
    expect(names).toContain('Pelvis_0131.position')
    expect(names).toContain('L_Hip_0136.quaternion')
    expect(names).not.toContain('Nope_Bone.quaternion')
    const q = clip.tracks.find(t => t.name === 'L_Hip_0136.quaternion')
    expect(q.values.length).toBe(12) // 3 帧 × 4 分量
    // KeyframeTrack 内部转 Float32（0.05 → 0.0500000007…）→ 逐分量近似比对
    JSON_CLIP.tracks[1].q.forEach((v, i) => expect(q.values[i]).toBeCloseTo(v, 6))
    const p = clip.tracks.find(t => t.name === 'Pelvis_0131.position')
    JSON_CLIP.tracks[0].p.forEach((v, i) => expect(p.values[i]).toBeCloseTo(v, 6))
  })

  it('全部骨都解析不到 → null（调用方退回烘焙）', () => {
    const root = fakeHeroSkeleton([['Spine1', '03']])
    expect(buildClip(JSON_CLIP, root)).toBeNull()
  })
})

describe('buildClip psa 根链参考系修正（Splitter/Skeleton 轨道值为 GLB rest 的逆）', () => {
  // 英雄 GLB 同构骨架：Splitter 为运动根，直接子骨 Pelvis/Spine1，孙骨 L_Hip
  function heroSkeleton() {
    const root = new THREE.Object3D()
    root.name = 'mesh'
    const mk = (name, parent, q) => {
      const b = new THREE.Bone()
      b.name = name
      if (q) b.quaternion.copy(q)
      parent.add(b)
      return b
    }
    const restQ = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5).normalize()
    const skeleton = mk('Skeleton_00', root, new THREE.Quaternion(0, 0, -Math.SQRT1_2, Math.SQRT1_2))
    const splitter = mk('Splitter_02', skeleton, restQ)
    const pelvis = mk('Pelvis_0147', splitter)
    mk('Spine1_03', splitter)
    mk('L_Hip_0138', pelvis)
    return root
  }

  const ROOT_CLIP = {
    duration: 0.6,
    times: [0, 0.6],
    tracks: [
      // psa Splitter 恒定值 = GLB rest 的逆（(0.5,0.5,0.5,±0.5) 互逆）
      { b: 'Splitter', q: [0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, -0.5], p: [-0.12, 0.05, 1.15, -0.12, 0.05, 1.15] },
      { b: 'Skeleton', q: [0, 0, 0, -1, 0, 0, 0, -1], p: [0, 0, 1.0, 0, 0, 0.9] },
      { b: 'Pelvis', q: [0, 0, 0, 1, 0, 0.1, 0, 0.99] },
      { b: 'L_Hip', q: [0.05, 0, 0, 1, 0.05, 0, 0, 1] },
    ],
  }

  it('根链骨跳过旋转轨道、位置轨道原样保留（骨盆高度不丢）', () => {
    const root = heroSkeleton()
    const clip = buildClip(ROOT_CLIP, root, 'runN')
    const names = clip.tracks.map(t => t.name)
    expect(names).not.toContain('Splitter_02.quaternion')
    expect(names).not.toContain('Skeleton_00.quaternion')
    const sp = clip.tracks.find(t => t.name === 'Splitter_02.position')
    expect(sp).toBeTruthy()
    // 位置在公共父框架（z-up）里与 GLB 一致，原样保留
    ROOT_CLIP.tracks[0].p.forEach((v, i) => expect(sp.values[i]).toBeCloseTo(v, 6))
  })

  it('非根链骨（含 Splitter 直接子骨）轨道原样保留——无需逐骨换系', () => {
    const root = heroSkeleton()
    const clip = buildClip(ROOT_CLIP, root, 'runN')
    // Pelvis 是 Splitter 直接子骨：psa 局部与 GLB 局部同约定，原样保留
    const pelvis = clip.tracks.find(t => t.name === 'Pelvis_0147.quaternion')
    ROOT_CLIP.tracks[2].q.forEach((v, i) => expect(pelvis.values[i]).toBeCloseTo(v, 6))
    // 孙骨同样原样
    const hip = clip.tracks.find(t => t.name === 'L_Hip_0138.quaternion')
    ROOT_CLIP.tracks[3].q.forEach((v, i) => expect(hip.values[i]).toBeCloseTo(v, 6))
  })

  it('无 Splitter 的骨架（Mixamo XBot 回退）→ 全部原样保留（旧行为）', () => {
    const root = fakeHeroSkeleton([['Pelvis', '0131'], ['L_Hip', '0136']])
    const clip = buildClip(JSON_CLIP, root, 'runN')
    const q = clip.tracks.find(t => t.name === 'L_Hip_0136.quaternion')
    JSON_CLIP.tracks[1].q.forEach((v, i) => expect(q.values[i]).toBeCloseTo(v, 6))
  })
})

describe('buildClip 官方空间口径（原始骨架空间：轨道全原样，缩放统一在运行时消费）', () => {
  const S = 1.0461 // 高个英雄归一化缩放（UserAssets normalizeAgent：身高 1.721 → 1.8/1.721）
  // 带根缩放的假骨架：骨名按 json 实际出现面建（含根链/骨盆/IK 足骨/武器挂点
  // 等超集）。官方空间=原始骨架空间（2026-09-28 二轮定稿）：一轮曾在构建期 ÷s，
  // 造成身体矮于 kamae/idle 口径 + 锚-髋几何失衡（双脚腾空/滑步回归）——轨道
  // 必须原样，×s 的缩放消费统一在 Bot._stepFootPin 的锚升世界处
  function scaledSkeleton(boneNames, s) {
    const root = new THREE.Object3D()
    root.name = 'mesh'
    root.scale.set(s, s, s)
    for (const b of boneNames) {
      const bone = new THREE.Bone()
      bone.name = b + '_9'
      root.add(bone)
    }
    return root
  }
  const allClips = (o, prefix = '') => Object.entries(o ?? {}).flatMap(([k, v]) =>
    v?.tracks ? [[`${prefix}${k}`, v]] : allClips(v, `${prefix}${k}.`))

  it('官方 json 全集逐轨断言：位置/旋转轨道原样（缩放骨架不改变轨道值；death/runAdd/core 全覆盖）', () => {
    const locoJson = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))
    const clips = allClips(locoJson)
    // 用例面防空转：death（根位移/IK 足骨/武器挂点）与 runAdd（Splitter）确有 p 轨
    const deathP = clips.filter(([n]) => n.startsWith('death.')).flatMap(([, c]) => c.tracks.filter(t => t.p))
    expect(deathP.length).toBeGreaterThan(0)
    const runAddP = clips.filter(([n]) => n.startsWith('runAdd.')).flatMap(([, c]) => c.tracks.filter(t => t.p && t.b === 'Splitter'))
    expect(runAddP.length).toBeGreaterThan(0)
    const bones = new Set()
    for (const [, c] of clips) for (const t of c.tracks) bones.add(t.b)
    const root = scaledSkeleton([...bones], S)
    for (const [name, json] of clips) {
      const clip = buildClip(json, root, name)
      expect(clip, name).toBeTruthy()
      for (const t of json.tracks) {
        const node = t.b + '_9'
        if (t.q) {
          const tr = clip.tracks.find(x => x.name === node + '.quaternion')
          if (!tr) continue // 根链（Splitter/Skeleton）只保留位置轨道
          for (let i = 0; i < t.q.length; i++) expect(tr.values[i]).toBeCloseTo(t.q[i], 5)
        }
        if (t.p) {
          const tr = clip.tracks.find(x => x.name === node + '.position')
          expect(tr, `${name} ${node} 位置轨`).toBeTruthy()
          for (let i = 0; i < t.p.length; i++) expect(tr.values[i]).toBeCloseTo(t.p[i], 5)
        }
      }
    }
  })

  it('buildLocomotion 对缩放骨架同样原样（无任何按 scale.x 的构建期换算）', () => {
    const locoJson = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))
    const boneNames = [...new Set(Object.values(locoJson.core).flatMap(c => c.tracks.map(t => t.b)))]
    const jsonP = locoJson.core.walkN.tracks.find(t => t.p)
    for (const s of [S, 1]) {
      const built = buildLocomotion(locoJson, 'jett', scaledSkeleton(boneNames, s))
      const tr = built.walk.tracks.find(x => x.name === jsonP.b + '_9.position')
      for (let i = 0; i < jsonP.p.length; i++) expect(tr.values[i]).toBeCloseTo(jsonP.p[i], 5)
    }
  })

  it('ik 锚曲线逐值不变（原始骨架空间；运行时 Bot._stepFootPin ×英雄根缩放升世界）', () => {
    const root = scaledSkeleton(['Pelvis'], S)
    const ik = { L: [0.12, 0.5, 0.125, -0.31, 0.2, 0.137], R: [0.05, -0.4, 0.13] }
    const json = { duration: 0.6, times: [0, 0.6], ik, n: 2, tracks: [{ b: 'Pelvis', q: [0, 0, 0, 1, 0, 0, 0, 1] }] }
    const clip = buildClip(json, root, 'x')
    expect(clip.userData.ik.L).toEqual(ik.L)
    expect(clip.userData.ik.R).toEqual(ik.R)
  })
})

describe('buildLocomotion 池条目集', () => {
  const locoJson = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))

  it('locomotion.json 结构锁值：TP_Core 官方时长（跑 0.6s / 走 0.8667s）、十骨轨道、盆骨位置轨道在', () => {
    expect(locoJson.core.runN.duration).toBeCloseTo(0.6, 3)
    expect(locoJson.core.walkN.duration).toBeCloseTo(0.8667, 3)
    expect(locoJson.core.walkE.duration).toBeCloseTo(0.8667, 3) // E/W 真方向性循环（同为走时长）
    expect(locoJson.core.runW.duration).toBeCloseTo(0.6, 3)
    expect(locoJson.strafe.runE.duration).toBeCloseTo(0.6, 3)
    const bones = locoJson.core.runN.tracks.map(t => t.b)
    expect(bones).toEqual(['Splitter', 'Pelvis', 'L_Hip', 'L_Knee', 'L_Foot', 'L_Toe', 'R_Hip', 'R_Knee', 'R_Foot', 'R_Toe'])
    expect(locoJson.core.runN.tracks.find(t => t.b === 'Pelvis').p).toBeDefined() // 盆骨起伏轨道
    expect(locoJson.core.runN.tracks.find(t => t.b === 'Splitter').p).toBeDefined()
    // 方向性抽查：TP_Core 的 RunE 是真横移（腿轨道 ≠ RunN 导出复件——旧 Jett X_Knives 集是复件）
    const runN = locoJson.core.runN.tracks.find(t => t.b === 'L_Knee').q
    const runE = locoJson.core.runE.tracks.find(t => t.b === 'L_Knee').q
    expect(runN).not.toEqual(runE)
    // 四元数单位性抽查（转换不破坏归一）
    const q = locoJson.core.runN.tracks.find(t => t.b === 'L_Knee').q
    for (let i = 0; i < q.length; i += 4) {
      const n = Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3])
      expect(n).toBeCloseTo(1, 3)
    }
  })

  it('各英雄共用 core 集（本体移动全英雄同款 TP_Core），横移集同源；无数据回退 null', () => {
    const root = fakeHeroSkeleton([['Pelvis', '9'], ['L_Hip', '9'], ['L_Knee', '9'], ['L_Foot', '9'], ['L_Toe', '9'], ['R_Hip', '9'], ['R_Knee', '9'], ['R_Foot', '9'], ['R_Toe', '9'], ['Splitter', '9']])
    const jett = buildLocomotion(locoJson, 'jett', root)
    expect(jett.walk.duration).toBeCloseTo(0.8667, 3)
    expect(jett.run.duration).toBeCloseTo(0.6, 3)
    expect(jett.strafe.E.walk.tracks.length).toBeGreaterThan(0)
    expect(jett.strafe.W.run.tracks.length).toBeGreaterThan(0)
    const phx = buildLocomotion(locoJson, 'phoenix', root) // 未知英雄 → 同 core 集
    expect(phx.walk.duration).toBe(jett.walk.duration)
    expect(buildLocomotion({}, 'jett', root)).toBeNull() // 无数据 → null
  })

  it('buildClip 挂官方 IK 目标锚曲线到 clip.userData（不进 mixer 轨道）', () => {
    const root = fakeHeroSkeleton([['Pelvis', '9'], ['L_Hip', '9']])
    const clip = buildClip({ duration: 0.6, times: [0, 0.6], ik: { L: [1, 2, 3, 4, 5, 6] }, tracks: [{ b: 'Pelvis', q: [0, 0, 0, 1, 0, 0, 0, 1] }] }, root, 'x')
    expect(clip.userData.ik).toEqual({ L: [1, 2, 3, 4, 5, 6], n: undefined })
    expect(clip.tracks.map(t => t.name)).toEqual(['Pelvis_9.quaternion']) // ik 不产生轨道
  })
})

describe('sampleIkAnchor 官方落地锚采样', () => {
  const locoJson = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))
  it('线性插值：段内按 t 比例混合相邻帧；首尾钳制；无数据 null', () => {
    const ik = { L: [0, 0, 0, 1, 0, 0] } // 2 帧
    const out = { set(x, y, z) { this.x = x; this.y = y; this.z = z; return this } }
    expect(sampleIkAnchor(ik, 0.6, 2, 0.3, 'L', out)).toBe(out)
    expect(out.x).toBeCloseTo(0.5, 9)
    sampleIkAnchor(ik, 0.6, 2, -1, 'L', out); expect(out.x).toBe(0)   // 首钳制
    sampleIkAnchor(ik, 0.6, 2, 9, 'L', out); expect(out.x).toBe(1)    // 尾钳制
    expect(sampleIkAnchor({}, 0.6, 2, 0, 'L', out)).toBeNull()
    expect(sampleIkAnchor({ L: [1, 2] }, 0.6, 2, 0, 'L', out)).toBeNull() // 数据不齐
  })

  it('locomotion.json 官方锚的落地性：跑步支撑窗内锚世界漂移 <0.15m（锁 TP_Core 数据质量）', () => {
    const c = locoJson.core.runN
    const STEP = 1.55, rate = (2 * STEP) / c.duration // 锁相世界推进速率
    for (const side of ['L', 'R']) {
      const anchors = []
      for (let f = 0; f < c.n; f++) {
        anchors.push(rate * (f / (c.n - 1)) * c.duration + c.ik[side][f * 3]) // 世界 x
      }
      // 最优连续 1/3 周期窗（≈支撑期长）内最小漂移：官方曲线必须提供一段
      // 世界系可落地窗（锚随盆骨后退 ≈ 体速互相抵消）。支撑窗可跨循环边界——
      // 补一段 +周期位移的环绕副本
      const win = Math.floor(c.n / 3)
      const ext = anchors.concat(anchors.map(a => a + rate * c.duration))
      let best = Infinity
      for (let i = 0; i + win <= ext.length; i++) {
        const seg = ext.slice(i, i + win)
        best = Math.min(best, Math.max(...seg) - Math.min(...seg))
      }
      expect(best).toBeLessThan(0.15)
    }
  })

  it('psa IK 目标锚与脚同名同侧（167 轮翻转锁死）：L 目标侧偏为正、R 为负', () => {
    for (const key of ['runN', 'walkN']) {
      const c = locoJson.core[key]
      const mid = 3 * Math.floor(c.n / 2)
      expect(c.ik.L[mid + 1]).toBeGreaterThan(0)  // L 目标 Y（侧偏，+Y=左）>0
      expect(c.ik.R[mid + 1]).toBeLessThan(0)
    }
  })

  it('支撑锚同侧可达性（同侧配对的几何依据）：strafe 族支撑锚到同侧髋恒近于对侧', () => {
    // 走/跑 N 族锚侧偏仅 ±0.05~0.13（近中线），两种配对都可达、分辨不出侧别；
    // strafe 族锚侧扫 ±0.5 且交叉脚前伸 0.25~0.30——反号配对让每脚追对侧+交叉
    // 锚，水平距离 0.65+0.30 超出腿长水平预算 sqrt(1.11²−0.775²)≈0.795 → 一脚
    // 整支撑期悬空滑冰（167 轮实测）。本测试锁「同侧髋更近」的数据事实。
    const clips = [
      locoJson.core.runN, locoJson.core.walkN,
      locoJson.strafe.runE, locoJson.strafe.walkE,
      locoJson.strafe.runW, locoJson.strafe.walkW,
    ]
    const HIP = 0.115 // L_Hip 11.522cm（psa↔GLB 分毫不差互证）
    for (const c of clips) {
      for (const side of ['L', 'R']) {
        const hip = side === 'L' ? HIP : -HIP
        let maxIpsi = 0, maxContra = 0
        let zMin = Infinity
        for (let f = 0; f < c.n; f++) zMin = Math.min(zMin, c.ik[side][f * 3 + 2])
        for (let f = 0; f < c.n; f++) {
          if (c.ik[side][f * 3 + 2] > zMin + 0.045) continue // 支撑帧（锚贴地窗）
          const y = c.ik[side][f * 3 + 1]
          maxIpsi = Math.max(maxIpsi, Math.abs(y - hip))
          maxContra = Math.max(maxContra, Math.abs(y + hip))
        }
        expect(maxIpsi).toBeLessThan(maxContra) // 同侧髋更近 = 命名不反号
        expect(maxIpsi).toBeLessThan(0.65)     // 腿长水平预算内（0.795−前伸余量）
      }
    }
  })
})

describe('pickDeathSide 死亡倒向', () => {
  it('玩家在正面（dot>0，弹道向后打）→ 背摔；背面/侧后 → 前扑', () => {
    expect(pickDeathSide(1)).toBe('back')
    expect(pickDeathSide(0.01)).toBe('back')
    expect(pickDeathSide(0)).toBe('front')
    expect(pickDeathSide(-0.7)).toBe('front')
  })
})

describe('locoWeights 走/跑/横移权重分配', () => {
  it('纯前进：idle↔walk↔run 传统三态；横移权重把 moveW 按 wS 正交分给 N 与侧移', () => {
    const w = locoWeights({ moveW: 1, runW: 0, strafeW: 0 })
    expect(w.idle).toBe(0)
    expect(w.walkN).toBe(1)
    expect(w.walkS).toBe(0)
    const half = locoWeights({ moveW: 1, runW: 0, strafeW: 0.6, hasStrafe: true })
    expect(half.walkN).toBeCloseTo(0.4, 6)
    expect(half.walkS).toBeCloseTo(0.6, 6)
    expect(half.idle).toBe(0)
  })

  it('跑速 + 全横移：runS 独占；站定：idle 独占；无侧移动作时 strafeW 被忽略', () => {
    const run = locoWeights({ moveW: 1, runW: 1, strafeW: 1, hasStrafe: true })
    expect(run.runS).toBe(1)
    expect(run.walkN).toBe(0)
    expect(run.idle).toBe(0)
    const stand = locoWeights({ moveW: 0, runW: 0, strafeW: 1, hasStrafe: true })
    expect(stand.idle).toBe(1)
    const noStrafe = locoWeights({ moveW: 1, runW: 0, strafeW: 0.8, hasStrafe: false })
    expect(noStrafe.walkN).toBe(1) // hasStrafe=false：wS 不参与（老模型无侧移动作）
  })
})


// 161 轮玩法收敛（纯移动靶：不停步/不跳）后停步转身（turn 8 向）、急停支架
// （stopAdd）与跳 peek（jump 三段）整层下线：官方集构建/运行时消费/用例一并
// 删除，locomotion.json 资产（public + dist）与导出管线（psa2clips.mjs）的
// 对应集亦已清理——重跑导出不会再把下线集写回
describe('crouch 蹲走集（蹲走拉出变体）', () => {
  const locoJson = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))
  it('crouch 蹲走集：walkE/W 0.933s 蹲高根骨在；蹲走步幅/速度常数锁值', () => {
    expect(locoJson.crouch.walkE.duration).toBeCloseTo(0.9333, 3)
    expect(locoJson.crouch.walkW.duration).toBeCloseTo(0.9333, 3)
    for (const c of [locoJson.crouch.walkE, locoJson.crouch.walkW]) {
      const bones = c.tracks.map(t => t.b)
      expect(bones).toContain('Splitter')
      expect(bones).toContain('L_Knee')
    }
    expect(CROUCH_WALK_SPEED).toBeCloseTo(2.7, 6) // 本体口径 = 50% 跑速
    // 步幅按移速派生（任意速度近零滑步）：2.7 → 1.26；1.76（clip 天然速率）→ 0.82
    expect(CROUCH_WALK_STEP).toBeCloseTo(0.735, 6) // 步幅 = clip 属性（触地窗速率×周期/2），不随移速变
    // 近零滑步口径（160 轮）：脚速 = 移速×(1−触地速率×周期/(2×步幅))，
    // 触地速率≈1.6×0.933/2=0.747 → 2.7 m/s 时 |脚速| < 0.1
    expect(Math.abs(2.7 * (1 - 1.6 * 0.9333 / (2 * 0.735)))).toBeLessThan(0.1)
  })

  it('运行时与资产双锁：蹲走集可构建；turn/stopAdd/jump 已整层下线（构建产物与 json 资产均无）', () => {
    const root = fakeHeroSkeleton([['Pelvis', '9'], ['L_Hip', '9'], ['L_Knee', '9'], ['L_Foot', '9'], ['L_Toe', '9'], ['R_Hip', '9'], ['R_Knee', '9'], ['R_Foot', '9'], ['R_Toe', '9'], ['Splitter', '9'], ['Spine1', '9'], ['Neck', '9']])
    const built = buildLocomotion(locoJson, 'jett', root)
    expect(built.crouchWalk.E).toBeTruthy()
    expect(built.turn).toBeUndefined()
    expect(built.stopAdd).toBeUndefined()
    expect(built.jump).toBeUndefined()
    // 资产侧：遗留集已从 locomotion.json 删除（曾为待清理数据，~195KB）
    expect(locoJson.turn).toBeUndefined()
    expect(locoJson.stopAdd).toBeUndefined()
    expect(locoJson.jump).toBeUndefined()
    expect(Object.keys(locoJson)).toEqual(['core', 'death', 'runAdd', 'crouch', 'strafe'])
  })
})

describe('gaitStepLen 官方步距相位锁（160 轮：各族天然速度不同）', () => {
  it('各族步距常量：走/横移走 1.05、跑 1.54、横移跑 1.40', () => {
    expect(STEP_WALK).toBeCloseTo(1.05, 6)
    expect(STEP_RUN).toBeCloseTo(1.54, 6)
    expect(STEP_STRAFE_RUN).toBeCloseTo(1.40, 6)
  })

  it('runW/strafeW 连续内插：换态步距无跳变（相位速率连续）', () => {
    expect(gaitStepLen({})).toBeCloseTo(STEP_WALK, 6)
    expect(gaitStepLen({ runW: 1 })).toBeCloseTo(STEP_RUN, 6)
    expect(gaitStepLen({ strafeW: 1 })).toBeCloseTo(STEP_WALK, 6) // 横移走 = 走步距
    expect(gaitStepLen({ runW: 1, strafeW: 1 })).toBeCloseTo(STEP_STRAFE_RUN, 6)
    expect(gaitStepLen({ runW: 0.5 })).toBeCloseTo((STEP_WALK + STEP_RUN) / 2, 6)
    // 域外钳制
    expect(gaitStepLen({ runW: 9 })).toBeCloseTo(gaitStepLen({ runW: 1 }), 6)
    expect(gaitStepLen({ runW: -1 })).toBeCloseTo(STEP_WALK, 6)
  })

  it('官方锚触地窗互证：runN 步距 ≈ STEP_RUN、runE/runW ≈ STEP_STRAFE_RUN、walkN ≈ STEP_WALK（±0.12）', () => {
    // 触地窗（z ≤ zMin+4mm 的环形最长段）后扫速率 × 周期 / 2 = 跑族步距（有腾空相）
    const stepOf = (c, axis) => {
      const rates = []
      for (const side of ['L', 'R']) {
        let zmin = 9
        for (let f = 0; f < c.n; f++) zmin = Math.min(zmin, c.ik[side][f * 3 + 2])
        const flat = []
        for (let f = 0; f < c.n; f++) if (c.ik[side][f * 3 + 2] <= zmin + 0.004) flat.push(f)
        if (flat.length < 2) continue
        let gaps = []
        for (let i = 1; i < flat.length; i++) gaps.push(flat[i] - flat[i - 1])
        const maxGap = gaps.length ? Math.max(...gaps) : 0
        let seg = flat
        if (maxGap > 1) {
          const gi = gaps.indexOf(maxGap)
          seg = flat.slice(gi + 1).concat(flat.slice(0, gi + 1).map(v => v + c.n))
        }
        if (seg.length < 2) continue
        const f0 = seg[0], f1 = seg[seg.length - 1]
        const p0 = c.ik[side][(f0 % c.n) * 3 + axis], p1 = c.ik[side][(f1 % c.n) * 3 + axis]
        const t0 = f0 / (c.n - 1) * c.duration, t1 = f1 / (c.n - 1) * c.duration
        rates.push(Math.abs(p1 - p0) / (t1 - t0))
      }
      const v = rates.reduce((a, b) => a + b, 0) / Math.max(1, rates.length)
      return v * c.duration / 2
    }
    const core = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8')).core
    expect(Math.abs(stepOf(core.runN, 0) - STEP_RUN)).toBeLessThan(0.12)
    expect(Math.abs(stepOf(core.runE, 1) - STEP_STRAFE_RUN)).toBeLessThan(0.12)
    expect(Math.abs(stepOf(core.runW, 1) - STEP_STRAFE_RUN)).toBeLessThan(0.12)
    expect(Math.abs(stepOf(core.walkN, 0) - STEP_WALK)).toBeLessThan(0.12)
  })
})
