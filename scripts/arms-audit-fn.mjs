// 审计页内函数（arms-audit.mjs 与调参工具共享本体；playwright 序列化整函数
// 源码进页面执行，内部动态 import 走 vite 同 URL = 同实例）——勿引用模块作用域。
//
// 三角对相交口径（八轮视觉评审回退新增：奇偶法只判「顶点在枪体内部」，对
// 「穿透而出」的顶点结构性漏报；本口径直接测网格对网格）：
//   intersectTris = 与枪三角实际相交的**不同**手臂蒙皮三角数（原始相交三角形对
//   总数记 diag.intersectPairs；口径=去重到臂三角，同请求约定）。相交判定 =
//   Möller 型三角-三角区间法（非共面：两三角在交线上的投影区间求交 → 交线段；
//   退化点接触（交线段 <0.1mm，diag.touchPairs）与共面重叠（diag.coplanarPairs，
//   AABB 交叠近似）均计为相交——接触带「贴持」与「穿插」在该口径下同为相交，
//   穿透信息在交线段长度里）。精度取舍：①「恰在平面上」阈值 EPS_D=1e-12m（1pm，
//   远高于 double 噪声 ~1e-23、远低于几何特征）；②共面子分支不展开多边形裁剪，
//   以两三角 AABB 交叠区中心作交点中点（保守计数，中点近似）；③ AABB 重叠是
//   三角相交的必要条件（交点同在两个 AABB 内），枪三角 YZ 桶反查 + x 向快筛
//   broadphase 因此无漏。
//   intersectVisible = 相交臂三角中，其任一交线段中点从玩家眼可见（眼→中点射线
//   不被枪体严格先挡，遮挡口径与 pierceVisible 同源）的数量。
export async function auditWeaponInPage(weaponId) {
  const g = window.__game
  const w = g.weapons
  const vm = w.activeCustomVm(weaponId)
  const arms = w.officialArms
  if (!vm) throw new Error(`activeCustomVm(${weaponId}) 为空（GLB 未加载？）`)
  if (!arms) throw new Error('officialArms 未挂载（arms-official.glb 未到货或装配失败）')
  g.engine.vmScene.updateMatrixWorld(true) // 骨 matrixWorld / 枪 matrixWorld 同帧快照

  // ---- 枪三角收集（vmScene 世界系；跳过手臂子树——root 恰是 vm 的子节点）----
  const verts = []
  const tris = []
  const inArmSubtree = (o) => { for (let p = o; p; p = p.parent) if (p === arms) return true; return false }
  const walkGun = (o) => {
    if (inArmSubtree(o)) return
    if (o.isMesh && o.geometry && o.geometry.attributes.position) {
      const pos = o.geometry.attributes.position
      const e = o.matrixWorld.elements
      const base = verts.length
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
        verts.push(e[0] * x + e[4] * y + e[8] * z + e[12],
                   e[1] * x + e[5] * y + e[9] * z + e[13],
                   e[2] * x + e[6] * y + e[10] * z + e[14])
      }
      const idx = o.geometry.index
      const n = idx ? idx.count : pos.count
      for (let t = 0; t < n; t += 3) {
        const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2
        tris.push(verts[base + ia * 3], verts[base + ia * 3 + 1], verts[base + ia * 3 + 2],
                  verts[base + ib * 3], verts[base + ib * 3 + 1], verts[base + ib * 3 + 2],
                  verts[base + ic * 3], verts[base + ic * 3 + 1], verts[base + ic * 3 + 2])
      }
    }
    for (const c of o.children) walkGun(c)
  }
  walkGun(vm)

  // ---- 加速结构：枪顶点 30mm 3D 桶 + 枪三角 YZ 平面 2D 桶（四轮附录口径）----
  const CELL = 0.03
  const ck = (x, y, z) => Math.floor(x / CELL) + '|' + Math.floor(y / CELL) + '|' + Math.floor(z / CELL)
  const vBk = new Map()
  for (let i = 0; i < verts.length; i += 3) {
    const k = ck(verts[i], verts[i + 1], verts[i + 2])
    let a = vBk.get(k)
    if (!a) vBk.set(k, (a = []))
    a.push(i)
  }
  const TCELL = 0.03
  const tBk = new Map()
  for (let t = 0; t < tris.length; t += 9) {
    const y0 = Math.min(tris[t + 1], tris[t + 4], tris[t + 7])
    const y1 = Math.max(tris[t + 1], tris[t + 4], tris[t + 7])
    const z0 = Math.min(tris[t + 2], tris[t + 5], tris[t + 8])
    const z1 = Math.max(tris[t + 2], tris[t + 5], tris[t + 8])
    for (let gy = Math.floor(y0 / TCELL); gy <= Math.floor(y1 / TCELL); gy++) {
      for (let gz = Math.floor(z0 / TCELL); gz <= Math.floor(z1 / TCELL); gz++) {
        const k = gy + '|' + gz
        let a = tBk.get(k)
        if (!a) tBk.set(k, (a = []))
        a.push(t)
      }
    }
  }
  // 最近枪顶点距离：±2 格 = 30mm 格下 45mm 带全覆盖（45mm/30mm=1.5 → 跨至多 2 格）
  const nearGunVert = (x, y, z) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL)
    let best = Infinity
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const a = vBk.get((cx + dx) + '|' + (cy + dy) + '|' + (cz + dz))
          if (!a) continue
          for (let j = 0; j < a.length; j++) {
            const i = a[j]
            const d = (verts[i] - x) ** 2 + (verts[i + 1] - y) ** 2 + (verts[i + 2] - z) ** 2
            if (d < best) best = d
          }
        }
      }
    }
    return Math.sqrt(best)
  }
  // +X 世界光线奇偶（Möller–Trumbore 特化 d=(1,0,0)）：odd=枪内；只测光线所在
  // YZ 格的三角（穿越光线的三角其 YZ 投影必含光线 → 必在光线所在格的桶里）
  const insideGun = (x, y, z) => {
    const a = tBk.get(Math.floor(y / TCELL) + '|' + Math.floor(z / TCELL))
    if (!a) return false
    let count = 0
    for (let j = 0; j < a.length; j++) {
      const t = a[j]
      const ax = tris[t] - x, ay = tris[t + 1] - y, az = tris[t + 2] - z
      const bx = tris[t + 3] - x, by = tris[t + 4] - y, bz = tris[t + 5] - z
      const cx = tris[t + 6] - x, cy = tris[t + 7] - y, cz = tris[t + 8] - z
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az
      // pvec = d×e2 = (0, −e2z, e2y)；det = e1·pvec = e1z*e2y − e1y*e2z
      const det = e1z * e2y - e1y * e2z
      if (det > -1e-14 && det < 1e-14) continue
      const inv = 1 / det
      // tvec = −a（原点平移到顶点）；u = tvec·pvec·inv = (ay*e2z − az*e2y)·inv
      const u = (ay * e2z - az * e2y) * inv
      if (u < 0 || u > 1) continue
      // qvec = tvec×e1（tvec=−a）：qvec.x = az*e1y − ay*e1z。重心 v = qvec.x·inv
      //（除 det），而 t 分子里用 qvec.x 原始值——曾把缩放后的 v 塞进 t 分子，
      // t 被 ÷det 两次（det~3e-5 → t 虚增 ~3 万倍、随机翻号 → 奇偶全污染）
      const qxr = az * e1y - ay * e1z
      const v = qxr * inv
      if (v < 0 || u + v > 1) continue
      const qy = ax * e1z - az * e1x, qz = ay * e1x - ax * e1y
      const tHit = (e2x * qxr + e2y * qy + e2z * qz) * inv
      if (tHit > 1e-9) count++
    }
    return (count & 1) === 1
  }

  // ---- 手臂蒙皮顶点：applyBoneTransform（→mesh 本地）+ localToWorld（→世界）----
  let armVerts = 0
  const pierce = []
  const armV = [] // 全部臂蒙皮顶点世界系（三角对相交口径用，非仅 45mm 带内）
  const armT = [] // 扁平化臂三角（与枪 tris 同构：9 数/三角，坐标取自 armV）
  const walkArms = (o) => {
    if (o.isSkinnedMesh && o.geometry && o.geometry.attributes.position) {
      const pos = o.geometry.attributes.position
      const V3 = new o.position.constructor() // three.Vector3（页内无全局 THREE）
      const e = o.matrixWorld.elements
      const base = armV.length / 3
      for (let i = 0; i < pos.count; i++) {
        V3.fromBufferAttribute(pos, i) // 原始顶点先入 target——applyBoneTransform
        // 蒙皮的是 target 本体（SkinnedMesh.js: _baseVector.set(...target,1)），
        // 不自行读 position；空向量进去=蒙皮原点（实测云偏 0.2m 全体错位）
        o.applyBoneTransform(i, V3) // 两步都不能省（DEPLOY 四轮附录）
        const x = e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12]
        const y = e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13]
        const z = e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14]
        armVerts++
        armV.push(x, y, z)
        if (nearGunVert(x, y, z) > 0.045) continue // 45mm 带外直接跳过
        if (insideGun(x, y, z)) pierce.push([x, y, z])
      }
      const idx = o.geometry.index
      const n = idx ? idx.count : pos.count
      for (let t = 0; t < n; t += 3) {
        const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2
        armT.push(armV[base + ia * 3], armV[base + ia * 3 + 1], armV[base + ia * 3 + 2],
                  armV[base + ib * 3], armV[base + ib * 3 + 1], armV[base + ib * 3 + 2],
                  armV[base + ic * 3], armV[base + ic * 3 + 1], armV[base + ic * 3 + 2])
      }
    }
    for (const c of o.children) walkArms(c)
  }
  walkArms(arms)

  // ---- 可见子集：玩家眼 → 顶点射线对枪体的遮挡测试 ----
  // vmScene 系内玩家眼 = vmCamera 位（Engine.js：vmCamera 固定于原点无旋转）
  const ce = g.engine.vmCamera.matrixWorld.elements
  const ex = ce[12], ey = ce[13], ez = ce[14]
  const occludedByGun = (px, py, pz) => {
    const dx = px - ex, dy = py - ey, dz = pz - ez
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 1e-9) return false
    const invLen = 1 / len
    const ddx = dx * invLen, ddy = dy * invLen, ddz = dz * invLen
    const maxT = len * (1 - 1e-4) // 命中点严格先于顶点才算遮挡（贴面/自身命中不算）
    for (let t = 0; t < tris.length; t += 9) {
      const e1x = tris[t + 3] - tris[t], e1y = tris[t + 4] - tris[t + 1], e1z = tris[t + 5] - tris[t + 2]
      const e2x = tris[t + 6] - tris[t], e2y = tris[t + 7] - tris[t + 1], e2z = tris[t + 8] - tris[t + 2]
      const pvx = ddy * e2z - ddz * e2y, pvy = ddz * e2x - ddx * e2z, pvz = ddx * e2y - ddy * e2x
      const det = e1x * pvx + e1y * pvy + e1z * pvz
      if (det > -1e-14 && det < 1e-14) continue
      const inv = 1 / det
      const tx = ex - tris[t], ty2 = ey - tris[t + 1], tz = ez - tris[t + 2]
      const u = (tx * pvx + ty2 * pvy + tz * pvz) * inv
      if (u < 0 || u > 1) continue
      const qx = ty2 * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty2 * e1x
      const v = ddx * qx + ddy * qy + ddz * qz
      if (v < 0 || u + v > 1) continue
      const tHit = (e2x * qx + e2y * qy + e2z * qz) * inv
      if (tHit > 1e-6 && tHit < maxT) return true
    }
    return false
  }
  // 遮挡比（诊断用）：眼→点射线上最近枪体命中的 tHit/len（<1 即被枪体先挡；
  // ∞=射线上无严格先行的枪体命中）。命中条件与 occludedByGun 完全同源。
  const occRatioByGun = (px, py, pz) => {
    const dx = px - ex, dy = py - ey, dz = pz - ez
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 1e-9) return Infinity
    const invLen = 1 / len
    const ddx = dx * invLen, ddy = dy * invLen, ddz = dz * invLen
    const maxT = len * (1 - 1e-4)
    let best = Infinity
    for (let t = 0; t < tris.length; t += 9) {
      const e1x = tris[t + 3] - tris[t], e1y = tris[t + 4] - tris[t + 1], e1z = tris[t + 5] - tris[t + 2]
      const e2x = tris[t + 6] - tris[t], e2y = tris[t + 7] - tris[t + 1], e2z = tris[t + 8] - tris[t + 2]
      const pvx = ddy * e2z - ddz * e2y, pvy = ddz * e2x - ddx * e2z, pvz = ddx * e2y - ddy * e2x
      const det = e1x * pvx + e1y * pvy + e1z * pvz
      if (det > -1e-14 && det < 1e-14) continue
      const inv = 1 / det
      const tx = ex - tris[t], ty2 = ey - tris[t + 1], tz = ez - tris[t + 2]
      const u = (tx * pvx + ty2 * pvy + tz * pvz) * inv
      if (u < 0 || u > 1) continue
      const qx = ty2 * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty2 * e1x
      const v = ddx * qx + ddy * qy + ddz * qz
      if (v < 0 || u + v > 1) continue
      const tHit = (e2x * qx + e2y * qy + e2z * qz) * inv
      if (tHit > 1e-6 && tHit < maxT && tHit / len < best) best = tHit / len
    }
    return best
  }
  let pierceVisible = 0
  for (const p of pierce) if (!occludedByGun(p[0], p[1], p[2])) pierceVisible++

  // ---- 三角对相交口径（Möller 型区间法）：捕捉「穿透而出」的奇偶盲区 ----
  // 返回 0=不相交；1=相交（seg 填交线段端点 P,Q 各 3 数）；2=共面重叠（seg 两端
  // 同为两三角 AABB 交叠区中心，近似——不展开多边形裁剪，取舍见文件头）。
  const EPS_D = 1e-12 // 有符号距离「恰在平面上」阈值（米≈1pm；double 噪声 ~1e-23）
  const segPts = (p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z, d0, d1, d2, out) => {
    // 收集本三角与交线的交点（去重后 ≤2）：顶点恰在对方面上直接取，跨面边线性插值
    let n = 0
    const push = (x, y, z) => {
      for (let i = 0; i < n; i++) {
        const dx = out[i * 3] - x, dy = out[i * 3 + 1] - y, dz = out[i * 3 + 2] - z
        if (dx * dx + dy * dy + dz * dz < 1e-20) return // 与已收点重合（<0.01nm）
      }
      if (n < 2) { out[n * 3] = x; out[n * 3 + 1] = y; out[n * 3 + 2] = z; n++ }
    }
    if (d0 === 0 && d1 === 0) { push(p0x, p0y, p0z); push(p1x, p1y, p1z) }
    else if (d0 === 0) push(p0x, p0y, p0z)
    else if (d1 === 0) push(p1x, p1y, p1z)
    else if ((d0 > 0) !== (d1 > 0)) {
      const t = d0 / (d0 - d1)
      push(p0x + t * (p1x - p0x), p0y + t * (p1y - p0y), p0z + t * (p1z - p0z))
    }
    if (d1 === 0 && d2 === 0) { push(p1x, p1y, p1z); push(p2x, p2y, p2z) }
    else if (d1 === 0) push(p1x, p1y, p1z)
    else if (d2 === 0) push(p2x, p2y, p2z)
    else if ((d1 > 0) !== (d2 > 0)) {
      const t = d1 / (d1 - d2)
      push(p1x + t * (p2x - p1x), p1y + t * (p2y - p1y), p1z + t * (p2z - p1z))
    }
    if (d2 === 0 && d0 === 0) { push(p2x, p2y, p2z); push(p0x, p0y, p0z) }
    else if (d2 === 0) push(p2x, p2y, p2z)
    else if (d0 === 0) push(p0x, p0y, p0z)
    else if ((d2 > 0) !== (d0 > 0)) {
      const t = d2 / (d2 - d0)
      push(p2x + t * (p0x - p2x), p2y + t * (p0y - p2y), p2z + t * (p0z - p2z))
    }
    return n
  }
  const triTriSeg = (A, ao, B, bo, seg) => {
    const a0x = A[ao], a0y = A[ao + 1], a0z = A[ao + 2]
    const e1x = A[ao + 3] - a0x, e1y = A[ao + 4] - a0y, e1z = A[ao + 5] - a0z
    const e2x = A[ao + 6] - a0x, e2y = A[ao + 7] - a0y, e2z = A[ao + 8] - a0z
    const n1x = e1y * e2z - e1z * e2y, n1y = e1z * e2x - e1x * e2z, n1z = e1x * e2y - e1y * e2x
    if (n1x * n1x + n1y * n1y + n1z * n1z < 1e-24) return 0 // 退化三角
    const f0x = B[bo], f0y = B[bo + 1], f0z = B[bo + 2]
    const g1x = B[bo + 3] - f0x, g1y = B[bo + 4] - f0y, g1z = B[bo + 5] - f0z
    const g2x = B[bo + 6] - f0x, g2y = B[bo + 7] - f0y, g2z = B[bo + 8] - f0z
    const n2x = g1y * g2z - g1z * g2y, n2y = g1z * g2x - g1x * g2z, n2z = g1x * g2y - g1y * g2x
    if (n2x * n2x + n2y * n2y + n2z * n2z < 1e-24) return 0
    const c0 = (v) => (v > -EPS_D && v < EPS_D ? 0 : v)
    const dB0 = c0(n1x * (B[bo] - a0x) + n1y * (B[bo + 1] - a0y) + n1z * (B[bo + 2] - a0z))
    const dB1 = c0(n1x * (B[bo + 3] - a0x) + n1y * (B[bo + 4] - a0y) + n1z * (B[bo + 5] - a0z))
    const dB2 = c0(n1x * (B[bo + 6] - a0x) + n1y * (B[bo + 7] - a0y) + n1z * (B[bo + 8] - a0z))
    if (dB0 * dB1 > 0 && dB0 * dB2 > 0) return 0 // B 全严格在平面 A 同侧
    const dA0 = c0(n2x * (A[ao] - f0x) + n2y * (A[ao + 1] - f0y) + n2z * (A[ao + 2] - f0z))
    const dA1 = c0(n2x * (A[ao + 3] - f0x) + n2y * (A[ao + 4] - f0y) + n2z * (A[ao + 5] - f0z))
    const dA2 = c0(n2x * (A[ao + 6] - f0x) + n2y * (A[ao + 7] - f0y) + n2z * (A[ao + 8] - f0z))
    if (dA0 * dA1 > 0 && dA0 * dA2 > 0) return 0 // A 全严格在平面 B 同侧
    const copA = dA0 === 0 && dA1 === 0 && dA2 === 0
    const copB = dB0 === 0 && dB1 === 0 && dB2 === 0
    if (copA || copB) { // 共面重叠：AABB 交叠近似（取舍见文件头）
      const ox0 = Math.max(Math.min(A[ao], A[ao + 3], A[ao + 6]), Math.min(B[bo], B[bo + 3], B[bo + 6]))
      const ox1 = Math.min(Math.max(A[ao], A[ao + 3], A[ao + 6]), Math.max(B[bo], B[bo + 3], B[bo + 6]))
      const oy0 = Math.max(Math.min(A[ao + 1], A[ao + 4], A[ao + 7]), Math.min(B[bo + 1], B[bo + 4], B[bo + 7]))
      const oy1 = Math.min(Math.max(A[ao + 1], A[ao + 4], A[ao + 7]), Math.max(B[bo + 1], B[bo + 4], B[bo + 7]))
      const oz0 = Math.max(Math.min(A[ao + 2], A[ao + 5], A[ao + 8]), Math.min(B[bo + 2], B[bo + 5], B[bo + 8]))
      const oz1 = Math.min(Math.max(A[ao + 2], A[ao + 5], A[ao + 8]), Math.max(B[bo + 2], B[bo + 5], B[bo + 8]))
      if (ox0 > ox1 || oy0 > oy1 || oz0 > oz1) return 0
      seg[0] = seg[3] = (ox0 + ox1) / 2; seg[1] = seg[4] = (oy0 + oy1) / 2; seg[2] = seg[5] = (oz0 + oz1) / 2
      return 2
    }
    // 交线方向单位化（投影即米）→ 两三角各自交点区间 → 重叠段
    let dx = n1y * n2z - n1z * n2y, dy = n1z * n2x - n1x * n2z, dz = n1x * n2y - n1y * n2x
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dl < 1e-18) return 0 // 平面近平行（真共面已在上面分支）
    dx /= dl; dy /= dl; dz /= dl
    const pa = [0, 0, 0, 0, 0, 0], pb = [0, 0, 0, 0, 0, 0]
    const na = segPts(A[ao], A[ao + 1], A[ao + 2], A[ao + 3], A[ao + 4], A[ao + 5],
                      A[ao + 6], A[ao + 7], A[ao + 8], dA0, dA1, dA2, pa)
    const nb = segPts(B[bo], B[bo + 1], B[bo + 2], B[bo + 3], B[bo + 4], B[bo + 5],
                      B[bo + 6], B[bo + 7], B[bo + 8], dB0, dB1, dB2, pb)
    if (na === 0 || nb === 0) return 0
    let ax0 = pa[0] * dx + pa[1] * dy + pa[2] * dz
    let ax1 = na === 2 ? pa[3] * dx + pa[4] * dy + pa[5] * dz : ax0
    let bx0 = pb[0] * dx + pb[1] * dy + pb[2] * dz
    let bx1 = nb === 2 ? pb[3] * dx + pb[4] * dy + pb[5] * dz : bx0
    if (ax0 > ax1) { // 投影与点同步交换
      for (let k = 0; k < 3; k++) { const tv = pa[k]; pa[k] = pa[3 + k]; pa[3 + k] = tv }
      const tv = ax0; ax0 = ax1; ax1 = tv
    }
    if (bx0 > bx1) {
      for (let k = 0; k < 3; k++) { const tv = pb[k]; pb[k] = pb[3 + k]; pb[3 + k] = tv }
      const tv = bx0; bx0 = bx1; bx1 = tv
    }
    const lo = ax0 > bx0 ? ax0 : bx0
    const hi = ax1 < bx1 ? ax1 : bx1
    if (lo > hi + 1e-10) return 0 // 投影区间不交（0.1nm 容差）
    // 段端点：A/B 两侧各自按区间参数线性回插后取均值（消单侧数值漂移）
    const lerpPoint = (pts, q0, q1, tproj, out) => {
      if (q1 === q0) { out[0] = pts[0]; out[1] = pts[1]; out[2] = pts[2]; return }
      const t = (tproj - q0) / (q1 - q0)
      out[0] = pts[0] + t * (pts[3] - pts[0])
      out[1] = pts[1] + t * (pts[4] - pts[1])
      out[2] = pts[2] + t * (pts[5] - pts[2])
    }
    const P = [0, 0, 0], Q = [0, 0, 0], T = [0, 0, 0]
    lerpPoint(pa, ax0, ax1, lo, P); lerpPoint(pb, bx0, bx1, lo, T)
    P[0] = (P[0] + T[0]) / 2; P[1] = (P[1] + T[1]) / 2; P[2] = (P[2] + T[2]) / 2
    lerpPoint(pa, ax0, ax1, hi, Q); lerpPoint(pb, bx0, bx1, hi, T)
    Q[0] = (Q[0] + T[0]) / 2; Q[1] = (Q[1] + T[1]) / 2; Q[2] = (Q[2] + T[2]) / 2
    seg[0] = P[0]; seg[1] = P[1]; seg[2] = P[2]; seg[3] = Q[0]; seg[4] = Q[1]; seg[5] = Q[2]
    return 1
  }

  // ---- 相交扫描：复用 tBk 枪三角 YZ 桶（臂三角 yz-AABB 覆盖格反查）+ x 向快筛 ----
  // AABB 重叠是三角相交的必要条件（交点同在两 AABB 内）→ 此 broadphase 无漏；
  // 格内枪三角以 stamp 去重（一枪三角入多格）。
  const stamp = new Int32Array(tris.length / 9)
  let stampId = 0
  const seg = [0, 0, 0, 0, 0, 0]
  let intersectPairs = 0, touchPairs = 0, coplanarPairs = 0, maxSegM = 0
  const armTriMids = [] // 每个相交臂三角的交线段中点列表（可见性口径用）
  for (let at = 0; at < armT.length; at += 9) {
    const ax0 = Math.min(armT[at], armT[at + 3], armT[at + 6])
    const ax1 = Math.max(armT[at], armT[at + 3], armT[at + 6])
    const ay0 = Math.min(armT[at + 1], armT[at + 4], armT[at + 7])
    const ay1 = Math.max(armT[at + 1], armT[at + 4], armT[at + 7])
    const az0 = Math.min(armT[at + 2], armT[at + 5], armT[at + 8])
    const az1 = Math.max(armT[at + 2], armT[at + 5], armT[at + 8])
    stampId++
    let mids = null
    for (let gy = Math.floor(ay0 / TCELL); gy <= Math.floor(ay1 / TCELL); gy++) {
      for (let gz = Math.floor(az0 / TCELL); gz <= Math.floor(az1 / TCELL); gz++) {
        const cand = tBk.get(gy + '|' + gz)
        if (!cand) continue
        for (let j = 0; j < cand.length; j++) {
          const t = cand[j]
          const gi = (t / 9) | 0
          if (stamp[gi] === stampId) continue
          stamp[gi] = stampId
          const gx0 = Math.min(tris[t], tris[t + 3], tris[t + 6])
          if (gx0 > ax1) continue
          const gx1 = Math.max(tris[t], tris[t + 3], tris[t + 6])
          if (gx1 < ax0) continue
          const code = triTriSeg(armT, at, tris, t, seg)
          if (!code) continue
          intersectPairs++
          if (code === 2) coplanarPairs++
          else {
            const slx = seg[3] - seg[0], sly = seg[4] - seg[1], slz = seg[5] - seg[2]
            const sl2 = slx * slx + sly * sly + slz * slz
            if (sl2 < 1e-8) touchPairs++ // 交线段 <0.1mm 的点接触
            if (sl2 > maxSegM * maxSegM) maxSegM = Math.sqrt(sl2) // 穿透深度尺度（diag）
          }
          if (!mids) mids = []
          mids.push([(seg[0] + seg[3]) / 2, (seg[1] + seg[4]) / 2, (seg[2] + seg[5]) / 2])
        }
      }
    }
    if (mids) armTriMids.push(mids)
  }
  // 相交中点可见性：口径与 pierceVisible 同源——眼→中点射线不被枪体严格先挡；
  // 臂三角级去重口径 = 该臂三角任一交线段中点可见即计 1。midOccMin/midOccNear1
  // 为诊断量：全部中点里最近的枪体遮挡比（<1=有枪体在前；>0.999 的「贴面级」
  // 遮挡单独计数，用于区分真实枪体阻挡与共面数值噪声）。
  let intersectVisible = 0
  let midOccMin = Infinity
  let midOccNear1 = 0
  for (const mids of armTriMids) {
    let vis = false
    for (const m of mids) {
      const ratio = occRatioByGun(m[0], m[1], m[2])
      if (ratio < midOccMin) midOccMin = ratio
      if (ratio > 0.999) midOccNear1++
      if (ratio >= 1) vis = true
    }
    if (vis) intersectVisible++
  }

  // ---- 骨名索引 + 三项指标 ----
  const byName = {}
  const walkNames = (o) => {
    if (o.name) byName[o.name] = o
    for (const c of o.children) walkNames(c)
  }
  walkNames(arms)
  const bonePos = (n) => {
    const b = byName[n]
    if (!b) throw new Error(`缺骨 ${n}`)
    const e = b.matrixWorld.elements
    return [e[12], e[13], e[14]]
  }
  // 十指尖 → 枪面最近顶点距离的最小值（mm）
  const TIPS = ['R_Index3', 'R_Middle3', 'R_Ring3', 'R_Pinky3', 'R_Thumb3',
                'L_Index3', 'L_Middle3', 'L_Ring3', 'L_Pinky3', 'L_Thumb3']
  let fingertipMin = Infinity
  for (const n of TIPS) {
    const p = bonePos(n)
    fingertipMin = Math.min(fingertipMin, nearGunVert(p[0], p[1], p[2]))
  }
  // 双腕骨 → ARMS_ANCHORS 腕锚最大误差（mm）。锚与运行时同源：动态 import 同一
  // 模块（vite 同 URL = 同实例），并尊重 __ARMS_ANCHORS 页内覆盖缝
  const armsMod = await import('/src/weapons/OfficialArms.js')
  const A = (globalThis.__ARMS_ANCHORS && globalThis.__ARMS_ANCHORS[weaponId]) || armsMod.ARMS_ANCHORS[weaponId]
  const V3 = new arms.position.constructor()
  let wristErr = 0
  for (const [bone, key] of [['R_Hand', 'handR'], ['L_Hand', 'handL']]) {
    const aw = vm.localToWorld(V3.set(A[key][0], A[key][1], A[key][2]))
    const bp = bonePos(bone)
    wristErr = Math.max(wristErr, Math.sqrt((bp[0] - aw.x) ** 2 + (bp[1] - aw.y) ** 2 + (bp[2] - aw.z) ** 2))
  }
  // 腕→中指尖骨链相机系表观长度（cm）：vmScene 世界系 = 相机系（vmCamera 原点），
  // 仍显式乘 vmCamera.matrixWorldInverse（若 vmCamera 将来移动公式依然成立）
  const CHAIN = ['R_Hand', 'R_Middle0', 'R_Middle1', 'R_Middle2', 'R_Middle3']
  const ci = g.engine.vmCamera.matrixWorldInverse.elements
  let prev = null
  let handScale = 0
  for (const n of CHAIN) {
    const p = bonePos(n)
    const cur = [ci[0] * p[0] + ci[4] * p[1] + ci[8] * p[2] + ci[12],
                 ci[1] * p[0] + ci[5] * p[1] + ci[9] * p[2] + ci[13],
                 ci[2] * p[0] + ci[6] * p[1] + ci[10] * p[2] + ci[14]]
    if (prev) handScale += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2])
    prev = cur
  }

  return {
    pierceTotal: pierce.length,
    pierceVisible,
    // 三角对相交口径（口径/精度取舍见文件头）：去重到臂三角；原始对数与
    // 穿透（交线段≥0.1mm）/点接触/共面子计数在 diag
    intersectTris: armTriMids.length,
    intersectVisible,
    fingertipMinMm: +(fingertipMin * 1000).toFixed(2),
    // 腕锚误差世界系 mm（2026-10-01 修正：旧版漏 ×1000 把米标成 mm——四/五轮
    // 「误差恒 0.00000」实为 1.9/6.5mm 的真实左腕跨度失配被掩盖，见 DEPLOY 六轮）
    wristErrMm: +(wristErr * 1000).toFixed(4),
    handScaleCm: +(handScale * 100).toFixed(3),
    diag: { armVerts, gunVerts: verts.length / 3, gunTris: tris.length / 9,
            eye: [ex, ey, ez], armVerts45: pierce.length,
            armTris: armT.length / 9, intersectPairs, touchPairs, coplanarPairs,
            intersectMaxSegMm: +(maxSegM * 1000).toFixed(2),
            midOccMin: midOccMin === Infinity ? null : +midOccMin.toFixed(3),
            midOccNear1 },
  }
}
