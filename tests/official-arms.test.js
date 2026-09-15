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
