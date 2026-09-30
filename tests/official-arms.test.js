import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { fitSimilar3 } from '../src/weapons/OfficialArms.js'

// 官方 1P 手臂三点相似拟合回归（2026-09-15 开发实录踩坑锁）：
//  - 缩放必须只来自 p1p2 边（腕-腕）：曾用双边均值混入语义不匹配的 MasterWeapon
//    ↔枪体原点边，scale 1.33（应为 ~0.4），手臂巨型化
//  - 旋转正确时平移必须让 p1/p2 精确落锚（右侧锚定式）：曾用三点质心定位，
//    三角形不相似的残差被摊到手上，双腕各偏 11.4cm
//  - 手性不符（对应点镜像）返回 null，宁可不装也不出翻转手臂
const V = (x, y, z) => new THREE.Vector3(x, y, z)

describe('官方手臂三点相似拟合 fitSimilar3', () => {
  // 官方侧近似实形：双腕张开 ~0.41m、相机骨在上方后方 1.67m 高处
  const srcR = V(0.203, -0.179, 1.438)
  const srcL = V(0.608, -0.115, 1.485)
  const srcC = V(0.0, 0.0, 1.6735)
  // 游戏侧：腕锚贴枪（跨度 0.21m）+ 相机原点——与官方三角形刻意不相似
  const dstR = V(0.22, -0.20, -0.37)
  const dstL = V(0.175, -0.18, -0.52)
  const dstC = V(0, 0, 0)

  it('缩放只取腕-腕边（不相似三角形的第三边不污染）', () => {
    const fit = fitSimilar3(srcR, srcL, srcC, dstR, dstL, dstC)
    expect(fit).not.toBeNull()
    const spanSrc = srcR.distanceTo(srcL)
    const spanDst = dstR.distanceTo(dstL)
    expect(fit.scale).toBeCloseTo(spanDst / spanSrc, 6)
  })

  it('旋转为纯旋转（det=+1，蒙皮法线不翻）', () => {
    const fit = fitSimilar3(srcR, srcL, srcC, dstR, dstL, dstC)
    const m = new THREE.Matrix4().makeRotationFromQuaternion(fit.quat)
    expect(m.determinant()).toBeCloseTo(1, 6)
  })

  it('右腕锚定式平移：双腕精确落锚（第三点余量不摊到手）', () => {
    const fit = fitSimilar3(srcR, srcL, srcC, dstR, dstL, dstC)
    const apply = (p) => p.clone().applyQuaternion(fit.quat).multiplyScalar(fit.scale)
    const pos = dstR.clone().sub(apply(srcR))
    expect(pos.clone().add(apply(srcR)).distanceTo(dstR)).toBeCloseTo(0, 9)
    expect(pos.clone().add(apply(srcL)).distanceTo(dstL)).toBeCloseTo(0, 9)
  })

  it('相似三角形时三点全精确', () => {
    // 构造严格相似的 dst（随机刚体 + 缩放）
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 1.1, -0.3))
    const s = 0.43
    const t = V(0.1, -0.2, -0.3)
    const warp = (p) => p.clone().applyQuaternion(rot).multiplyScalar(s).add(t)
    const fit = fitSimilar3(srcR, srcL, srcC, warp(srcR), warp(srcL), warp(srcC))
    const apply = (p) => p.clone().applyQuaternion(fit.quat).multiplyScalar(fit.scale)
    const pos = warp(srcR).clone().sub(apply(srcR))
    for (const p of [srcR, srcL, srcC]) {
      expect(pos.clone().add(apply(p)).distanceTo(warp(p))).toBeCloseTo(0, 6)
    }
    expect(fit.scale).toBeCloseTo(s, 6)
  })

  it('三点退化返回 null（宁可不装）', () => {
    expect(fitSimilar3(srcR, srcR, srcC, dstR, dstL, dstC)).toBeNull() // 两腕重合
    const mid = srcR.clone().add(srcL).multiplyScalar(0.5) // 第三点在腕连线上（共线）
    expect(fitSimilar3(srcR, srcL, mid, dstR, dstL, dstC)).toBeNull()
  })
})

// —— animateOfficialArms 姿势管线（模块级 scratch 化后的行为锁）——
// 104 骨每帧管线是「算完立即 copy 进 node」的纯重算：scratch（_poseQ/_finalQ/
// _sampleQ）跨骨跨帧覆盖安全，但求值顺序（copy 先于 multiply 的 fireD 采样——
// equip 路径 q 与 fireD 采样共用 _sampleQ）与幂等性必须锁死
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { animateOfficialArms } from '../src/weapons/OfficialArms.js'

const qq = (x, y, z, w) => new THREE.Quaternion(x, y, z, w).normalize()
const track2 = (qa, qb) => ({ times: [0, 1], frames: [qa, qb] })

function mkSys({ withFire = true, withEquip = false, withAds = false } = {}) {
  const idleR = qq(0.1, 0.2, 0.3, 0.9)
  const idleL = qq(-0.2, 0.1, -0.3, 0.9)
  const fireD = track2(qq(0.02, 0.03, 0.04, 0.99), qq(-0.03, 0.05, -0.02, 0.99))
  const bones = [
    { idle: idleR, fireD: withFire ? fireD : null, node: { quaternion: new THREE.Quaternion() } },
    { idle: idleL, fireD: withFire ? fireD : null, node: { quaternion: new THREE.Quaternion() } },
  ]
  if (withAds) bones[0].ads = qq(0.15, 0.25, 0.35, 0.89)
  if (withEquip) bones[0].equip = track2(qq(0.3, 0.1, 0.2, 0.9), idleR)
  const A = { bones, hasAds: withAds, equipDur: withEquip ? 0.3 : 0, fire: withFire ? { t: 0, dur: 0.4 } : null }
  return { sys: { officialArms: true, _armsAnim: A, _armsEquipU: 1, adsBlend: 0 }, A, bones }
}
const fireRef = (track, t) => new THREE.Quaternion().slerpQuaternions(track.frames[0], track.frames[1], t)

describe('animateOfficialArms 姿势管线（scratch 零分配改造）', () => {
  it('fire 窗口：final = idle ⊗ fireD(t)（与独立参考实现逐分量一致）；连续两帧幂等', () => {
    const { sys, A, bones } = mkSys()
    animateOfficialArms(sys, 0.2) // 推进 fire.t 0→0.2
    for (const [i, ref] of [
      bones[0].idle.clone().multiply(fireRef(A.bones[0].fireD, 0.2)),
      bones[1].idle.clone().multiply(fireRef(A.bones[1].fireD, 0.2)),
    ].entries()) {
      expect(bones[i].node.quaternion.x).toBeCloseTo(ref.x, 12)
      expect(bones[i].node.quaternion.y).toBeCloseTo(ref.y, 12)
      expect(bones[i].node.quaternion.z).toBeCloseTo(ref.z, 12)
      expect(bones[i].node.quaternion.w).toBeCloseTo(ref.w, 12)
    }
    const snap = bones.map(b => b.node.quaternion.clone())
    animateOfficialArms(sys, 0) // 第二帧同参重算：scratch 复用不得串扰/漂移
    for (let i = 0; i < 2; i++) expect(bones[i].node.quaternion).toEqual(snap[i])
  })

  it('equip 采样与 fireD 采样共用 _sampleQ：copy 先于采样，乘积仍 = equip(u) ⊗ fireD(t)', () => {
    const { sys, A, bones } = mkSys({ withFire: true, withEquip: true })
    A.fire.t = 0.1
    sys._armsEquipU = 0.5 // equip 采到 t=0.15（0.5×0.3s）
    animateOfficialArms(sys, 0)
    const ref = new THREE.Quaternion().slerpQuaternions(
      A.bones[0].equip.frames[0], A.bones[0].equip.frames[1], 0.15, // 采样 t = eqU×equipDur = 0.15，轨道 times[0,1] → kk=0.15
    ).multiply(fireRef(A.bones[0].fireD, 0.1))
    expect(bones[0].node.quaternion.x).toBeCloseTo(ref.x, 11)
    expect(bones[0].node.quaternion.y).toBeCloseTo(ref.y, 11)
    expect(bones[0].node.quaternion.z).toBeCloseTo(ref.z, 11)
    expect(bones[0].node.quaternion.w).toBeCloseTo(ref.w, 11)
  })

  it('无 fire 轨道的骨直接写 base 姿势；ADS 混合走 slerp 路径', () => {
    const { sys, bones } = mkSys({ withFire: false, withAds: true })
    sys.adsBlend = 0.25
    animateOfficialArms(sys, 0)
    // angleTo 对逐位相同的四元数也有 ~4e-8 rad 底噪（dot 求和不满 1 被 acos 放大）——用逐分量断言
    const ref = new THREE.Quaternion().slerpQuaternions(bones[0].idle, bones[0].ads, 0.25)
    for (const c of ['x', 'y', 'z', 'w']) expect(bones[0].node.quaternion[c]).toBeCloseTo(ref[c], 12)
    for (const c of ['x', 'y', 'z', 'w']) expect(bones[1].node.quaternion[c]).toBe(bones[1].idle[c]) // copy 逐位
  })

  it('源码文本锁：逐骨 clone 与每帧 tmp 不得回归（热路径零分配）', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/weapons/OfficialArms.js'), 'utf8')
    expect(src, 'q.clone() 逐骨分配曾达 100+/帧（每秒 6000+）').not.toContain('q.clone()')
    expect(src, 'animateOfficialArms 每帧 new tmp 曾每帧一个 Quaternion').not.toContain('const tmp = new THREE.Quaternion()')
  })
})
