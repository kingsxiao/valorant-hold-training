// 第 2 轮（七轮）：网格级去穿透烘焙。DEPLOY 六轮附录定界的下一层——动骨（锚扫描）
// 已到边界，剩余 27/9 嵌枪顶点靠「推皮肉不动骨」消灭。
//
// 原理：蒙皮对静止位姿线性（s(p+Δ) = s(p) + B_lin·Δ，B_lin = 该顶点蒙皮混合的
// 3×3 线性部）——对每个嵌枪顶点求「世界系最近枪面点 q」的推出向量 Δ_world =
// (q−p) + n·clearance，用有限差分求 B_lin 解出 Δ_rest，写进几何静止位姿；偏移
// 随骨走（fire/equip 姿态近似保持），骨系零改动 → 腕锚/手尺/肘位天然不变。
// 迭代收敛（平滑外溢/表面爬出者下一轮再推）直到奇偶穿透=0。
//
// 产物：每枪每蒙皮网格的静态偏移表 [[restIndex, dx, dy, dz], ...]（模板几何静止
// 单位），由 OfficialArms.js 在 attach 时按枪克隆几何一次性施加（模板共享，
// cloneSkinned 不复制 geometry）。偏移绑定当前锚/拟合常量——锚再调需重烘焙。
//
// 用法：node scripts/arms-depenetrate-bake.mjs --out out/arms-depenetrate.json
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const OUT = path.resolve(ROOT, arg('out', 'out/arms-depenetrate.json'))
const HEADLESS = process.argv.includes('--headless')
const log = (...a) => console.log('[arms-bake]', ...a)

fs.mkdirSync(path.dirname(OUT), { recursive: true })

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer()
  s.unref()
  s.on('error', rej)
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => res(p))
  })
})
const PORT = Number(arg('port', 0)) || (await freePort())
const BASE = `http://127.0.0.1:${PORT}`

const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let viteErr = ''
vite.stderr.on('data', (d) => { viteErr += d })
vite.on('exit', (code) => { if (code !== 0 && code !== null) viteErr += `\nvite exited ${code}` })

// ---- 页内烘焙（整体序列化：同帧世界系，audit 口径奇偶；模板几何只在页内克隆
//      修改——页面退出即弃，真实偏移以 JSON 输出为准）----
async function bakeWeapon(weaponId) {
  const CLEARANCE = 0.002 // 世界 m（2mm：跨瞬间呼吸微摆 ±~1mm 下的逸出余量；vm 取景下 ~2px，且残余区全在遮挡面）
  const EPS = 1e-4 // 有限差分步长（rest 单位）
  const MAX_PASS = 5
  const g = window.__game
  const w = g.weapons
  const vm = w.activeCustomVm(weaponId)
  const arms = w.officialArms
  if (!vm || !arms) throw new Error('vm/arms 未就绪')
  g.engine.vmScene.updateMatrixWorld(true)

  // ---- 枪三角（世界系，audit 同款收集）----
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

  const CELL = 0.03
  const ck = (x, y, z) => Math.floor(x / CELL) + '|' + Math.floor(y / CELL) + '|' + Math.floor(z / CELL)
  const vBk = new Map()
  for (let i = 0; i < verts.length; i += 3) {
    const k = ck(verts[i], verts[i + 1], verts[i + 2])
    let a = vBk.get(k); if (!a) vBk.set(k, (a = [])); a.push(i)
  }
  const TCELL = 0.03
  const tBk = new Map()
  for (let t = 0; t < tris.length; t += 9) {
    const y0 = Math.min(tris[t + 1], tris[t + 4], tris[t + 7])
    const y1 = Math.max(tris[t + 1], tris[t + 4], tris[t + 7])
    const z0 = Math.min(tris[t + 2], tris[t + 5], tris[t + 8])
    const z1 = Math.max(tris[t + 2], tris[t + 5], tris[t + 8])
    for (let gy = Math.floor(y0 / TCELL); gy <= Math.floor(y1 / TCELL); gy++)
      for (let gz = Math.floor(z0 / TCELL); gz <= Math.floor(z1 / TCELL); gz++) {
        const k = gy + '|' + gz
        let a = tBk.get(k); if (!a) tBk.set(k, (a = [])); a.push(t)
      }
  }
  const nearGunVert = (x, y, z) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL)
    let best = Infinity
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const a = vBk.get((cx + dx) + '|' + (cy + dy) + '|' + (cz + dz))
      if (!a) continue
      for (let j = 0; j < a.length; j++) {
        const i = a[j]
        const d = (verts[i] - x) ** 2 + (verts[i + 1] - y) ** 2 + (verts[i + 2] - z) ** 2
        if (d < best) best = d
      }
    }
    return Math.sqrt(best)
  }
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
      const det = e1z * e2y - e1y * e2z
      if (det > -1e-14 && det < 1e-14) continue
      const inv = 1 / det
      const u = (ay * e2z - az * e2y) * inv
      if (u < 0 || u > 1) continue
      const qxr = az * e1y - ay * e1z
      const v = qxr * inv
      if (v < 0 || u + v > 1) continue
      const qy = ax * e1z - az * e1x, qz = ay * e1x - ax * e1y
      const tHit = (e2x * qxr + e2y * qy + e2z * qz) * inv
      if (tHit > 1e-9) count++
    }
    return (count & 1) === 1
  }
  // 点→三角最近点（Ericson 最近点法，暴力全三角：嵌枪顶点仅几十个，~9k 三角可承受）
  const closestOnTri = (px, py, pz, t) => {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2]
    const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5]
    const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8]
    const abx = bx - ax, aby = by - ay, abz = bz - az
    const acx = cx - ax, acy = cy - ay, acz = cz - az
    const apx = px - ax, apy = py - ay, apz = pz - az
    const d1 = abx * apx + aby * apy + abz * apz
    const d2 = acx * apx + acy * apy + acz * apz
    if (d1 <= 0 && d2 <= 0) return [ax, ay, az]
    const bpx = px - bx, bpy = py - by, bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz
    const d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) return [bx, by, bz]
    const vc = d1 * d4 - d3 * d2
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3)
      return [ax + abx * v, ay + aby * v, az + abz * v]
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz
    const d5 = abx * cpx + aby * cpy + abz * cpz
    const d6 = acx * cpx + acy * cpy + acz * cpz
    if (d6 >= 0 && d5 <= d6) return [cx, cy, cz]
    const vb = d5 * d2 - d1 * d6
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6)
      return [ax + acx * w, ay + acy * w, az + acz * w]
    }
    const va = d3 * d6 - d5 * d4
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
      return [bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w]
    }
    const denom = 1 / (va + vb + vc)
    const v = vb * denom, w = vc * denom
    return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w]
  }
  const nearestSurface = (px, py, pz) => {
    let best = Infinity, bq = null
    for (let t = 0; t < tris.length; t += 9) {
      const q = closestOnTri(px, py, pz, t)
      const d = (q[0] - px) ** 2 + (q[1] - py) ** 2 + (q[2] - pz) ** 2
      if (d < best) { best = d; bq = q }
    }
    return { dist: Math.sqrt(best), q: bq }
  }

  // ---- 手臂蒙皮网格清单 + 静止位姿快照 ----
  // （基底 = 模板原始静止位 + 已发布 ARMS_DEPENETRATE 偏移种子（live import，与
  //   源码同步）——烘焙在已审计基线上做增量，产出表 = 种子 ∪ 新增（含重复顶点）。
  //   模板本体不可改（运行时缓存克隆自它），工作副本页内克隆。）
  const templateByMesh = new Map()
  const tRoot = w._armsAssets.scene
  tRoot.traverse((o) => { if (o.isSkinnedMesh && o.geometry) templateByMesh.set(o.name, o.geometry) })
  const shipped = (await import('/src/weapons/OfficialArms.js')).ARMS_DEPENETRATE[weaponId] ?? {}
  const meshes = []
  const walkArms = (o) => {
    if (o.isSkinnedMesh && o.geometry && o.geometry.attributes.position) {
      const pristine = templateByMesh.get(o.name)
      if (pristine) {
        const geo = pristine.clone() // 页内工作副本
        const seedTbl = shipped[o.name]
        if (seedTbl) {
          const pos = geo.attributes.position
          for (const [i, dx, dy, dz] of seedTbl) pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz)
        }
        o.geometry = geo
      }
      meshes.push({ mesh: o, name: o.name || `mesh${meshes.length}`, rest: null })
    }
    for (const c of o.children) walkArms(c)
  }
  walkArms(arms)
  if (!meshes.length) throw new Error('无蒙皮网格')
  const seedByIndex = new Map() // meshName -> Map(index -> [dx,dy,dz])（种子账本，产出时叠加增量）

  for (const [mn, tbl] of Object.entries(shipped)) {
    const m = new Map(); for (const [i, dx, dy, dz] of tbl) m.set(i, [dx, dy, dz])
    seedByIndex.set(mn, m)
  }

  const V3C = Object.getPrototypeOf(arms.position).constructor
  const tmp = new V3C()
  const skinOf = (m, i) => { // → 世界系（audit 同款两步）
    const pos = m.mesh.geometry.attributes.position
    tmp.fromBufferAttribute(pos, i)
    m.mesh.applyBoneTransform(i, tmp)
    const e = m.mesh.matrixWorld.elements
    return [e[0] * tmp.x + e[4] * tmp.y + e[8] * tmp.z + e[12],
            e[1] * tmp.x + e[5] * tmp.y + e[9] * tmp.z + e[13],
            e[2] * tmp.x + e[6] * tmp.y + e[10] * tmp.z + e[14]]
  }

  // 静止位姿去重组（UV 缝复制顶点共享静止位 → 必须同步推，否则撕面）
  const groups = new Map() // restQuantKey → { m, i0, world, corr:[0,0,0] }
  for (const m of meshes) {
    const pos = m.mesh.geometry.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const k = m.name + '|' + pos.getX(i).toFixed(6) + ',' + pos.getY(i).toFixed(6) + ',' + pos.getZ(i).toFixed(6)
      if (!groups.has(k)) groups.set(k, { m, i0: i, world: null, corr: [0, 0, 0] })
    }
  }

  const passes = []
  const CORR_CAP = 0.06 // 世界 m（60mm/组累计世界推出硬上限：双壁区「最近面推出」震荡防跑飞——实测无上限会叠出 390+ rest 尖刺）
  for (const g of groups.values()) g.worldPush = 0
  // 组内位移助手：写回全部静止位重合的重复顶点
  const moveGroup = (grp, rx, ry, rz) => {
    grp.corr[0] += rx; grp.corr[1] += ry; grp.corr[2] += rz
    const pos = grp.m.mesh.geometry.attributes.position
    const kx = pos.getX(grp.i0).toFixed(6) + ',' + pos.getY(grp.i0).toFixed(6) + ',' + pos.getZ(grp.i0).toFixed(6)
    for (let i = 0; i < pos.count; i++) {
      const kk = pos.getX(i).toFixed(6) + ',' + pos.getY(i).toFixed(6) + ',' + pos.getZ(i).toFixed(6)
      if (kk === kx) pos.setXYZ(i, pos.getX(i) + rx, pos.getY(i) + ry, pos.getZ(i) + rz)
    }
  }
  // B_lin 有限差分（蒙皮对静止位线性）→ 世界位移解 rest 位移
  const solveRest = (grp, dwx, dwy, dwz) => {
    const eps = EPS
    const solve = (axis) => {
      const pos = grp.m.mesh.geometry.attributes.position
      const i = grp.i0
      const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i)
      const deltas = [eps, 0, 0]; if (axis === 1) { deltas[0] = 0; deltas[1] = eps } else if (axis === 2) { deltas[0] = 0; deltas[1] = 0; deltas[2] = eps }
      pos.setXYZ(i, x0 + deltas[0], y0 + deltas[1], z0 + deltas[2])
      const p1 = skinOf(grp.m, i)
      pos.setXYZ(i, x0, y0, z0)
      const p0 = skinOf(grp.m, i)
      return [(p1[0] - p0[0]) / eps, (p1[1] - p0[1]) / eps, (p1[2] - p0[2]) / eps]
    }
    const bx = solve(0), by = solve(1), bz = solve(2)
    const det = bx[0] * (by[1] * bz[2] - by[2] * bz[1]) - by[0] * (bx[1] * bz[2] - bx[2] * bz[1]) + bz[0] * (bx[1] * by[2] - bx[2] * by[1])
    if (Math.abs(det) < 1e-12) return null
    const inv = 1 / det
    return [
      ((by[1] * bz[2] - by[2] * bz[1]) * dwx - (bx[1] * bz[2] - bx[2] * bz[1]) * dwy + (bx[1] * by[2] - bx[2] * by[1]) * dwz) * inv,
      ((by[2] * bz[0] - by[0] * bz[2]) * dwx - (bx[2] * bz[0] - bx[0] * bz[2]) * dwy + (bx[2] * by[0] - bx[0] * by[2]) * dwz) * inv,
      ((by[0] * bz[1] - by[1] * bz[0]) * dwx - (bx[0] * bz[1] - bx[1] * bz[0]) * dwy + (bx[0] * by[1] - bx[1] * by[0]) * dwz) * inv,
    ]
  }
  for (let pass = 1; pass <= MAX_PASS; pass++) {
    g.engine.vmScene.updateMatrixWorld(true)
    // 全量蒙皮 + 奇偶 → 本轮嵌枪组
    const embedded = []
    let bandCount = 0
    for (const grp of groups.values()) {
      const p = skinOf(grp.m, grp.i0)
      grp.world = p
      const d = nearGunVert(p[0], p[1], p[2])
      if (d > 0.045) continue
      bandCount++
      if (insideGun(p[0], p[1], p[2])) embedded.push(grp)
    }
    passes.push({ pass, embedded: embedded.length, band: bandCount })
    if (!embedded.length) break

    for (const grp of embedded) {
      const [px, py, pz] = grp.world
      const { dist, q } = nearestSurface(px, py, pz)
      if (!q || dist < 1e-9) continue
      const nx = (q[0] - px) / dist, ny = (q[1] - py) / dist, nz = (q[2] - pz) / dist
      const dwx = (q[0] - px) + nx * CLEARANCE
      const dwy = (q[1] - py) + ny * CLEARANCE
      const dwz = (q[2] - pz) + nz * CLEARANCE
      if (grp.worldPush + Math.hypot(dwx, dwy, dwz) > CORR_CAP) continue // 超限留给有界试逃
      const dr = solveRest(grp, dwx, dwy, dwz)
      if (!dr) continue
      moveGroup(grp, dr[0], dr[1], dr[2])
      grp.worldPush += Math.hypot(dwx, dwy, dwz)
    }
  }

  // ---- 收尾（审计同款整备）：审计流程确定可复现（同状态两跑 1/2、1/2 实测），
  //      唯一偏差源是测量瞬间的整备相位——每轮收敛前按审计节律静置 450ms 再
  //      度量，只对本条件下读奇的顶点动手（最近面退出 → 有界试逃），整备后
  //      复量为空即收工。 ----
  const stubborn = []
  const rounds = []
  const isOddNow = (grp) => {
    const p = skinOf(grp.m, grp.i0)
    return nearGunVert(p[0], p[1], p[2]) <= 0.045 && insideGun(p[0], p[1], p[2])
  }
  const auditSettle = async () => { await new Promise((r) => setTimeout(r, 450)); g.engine.vmScene.updateMatrixWorld(true) }
  const tryExit = async (grp) => {
    const p = skinOf(grp.m, grp.i0)
    const candidates = []
    const { dist, q } = nearestSurface(p[0], p[1], p[2])
    if (q && dist > 1e-9) {
      const nx = (q[0] - p[0]) / dist, ny = (q[1] - p[1]) / dist, nz = (q[2] - p[2]) / dist
      candidates.push([(q[0] - p[0]) + nx * CLEARANCE, (q[1] - p[1]) + ny * CLEARANCE, (q[2] - p[2]) + nz * CLEARANCE])
    }
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]])
      for (const s2 of [0.002, 0.005, 0.01, 0.02]) candidates.push([d[0] * s2, d[1] * s2, d[2] * s2])
    for (const dw of candidates) {
      if (grp.worldPush + Math.hypot(...dw) > CORR_CAP) continue
      const dr = solveRest(grp, dw[0], dw[1], dw[2])
      if (!dr) continue
      moveGroup(grp, dr[0], dr[1], dr[2])
      await auditSettle()
      if (!isOddNow(grp)) { grp.worldPush += Math.hypot(...dw); return true }
      moveGroup(grp, -dr[0], -dr[1], -dr[2]) // 回退（corr 同步撤账，净零）
    }
    return false
  }
  for (let round = 1; round <= 4; round++) {
    await auditSettle()
    const odd = [...groups.values()].filter(isOddNow)
    rounds.push({ round, odd: odd.length })
    if (!odd.length) break
    for (const grp of odd) {
      if (!(await tryExit(grp))) {
        const p = skinOf(grp.m, grp.i0)
        const { dist } = nearestSurface(p[0], p[1], p[2])
        stubborn.push({ restIndex: grp.i0, world: p.map((v) => +v.toFixed(4)), nearestSurfMm: +(dist * 1000).toFixed(2), worldPushMm: +(grp.worldPush * 1000).toFixed(2) })
      }
    }
  }

  // ---- 汇总偏移表（相对原始静止位；每个受影响顶点一条——含 UV 缝重复顶点，
  //      运行时按下标逐点施加，见 OfficialArms.applyArmsDepenetration）----
  const offsetsByMesh = {}
  let maxPush = 0, sumPush = 0, pushCount = 0
  for (const grp of groups.values()) {
    if (!grp.worldPush) continue
    maxPush = Math.max(maxPush, grp.worldPush); sumPush += grp.worldPush; pushCount++
  }
  {
    // 索引 → 组（增量归属）
    const grpByIndex = new Map()
    for (const [key, grp] of groups.entries()) {
      if (!grp.worldPush) continue
      const pos = grp.m.mesh.geometry.attributes.position
      const kx = pos.getX(grp.i0).toFixed(6) + ',' + pos.getY(grp.i0).toFixed(6) + ',' + pos.getZ(grp.i0).toFixed(6)
      for (let i = 0; i < pos.count; i++) {
        const kk = pos.getX(i).toFixed(6) + ',' + pos.getY(i).toFixed(6) + ',' + pos.getZ(i).toFixed(6)
        if (kk === kx) grpByIndex.set(key.slice(0, key.indexOf('|')) + '#' + i, { grp, meshName: key.split('|')[0], i })
      }
    }
    // 受影响索引全集 = 种子 ∪ 增量
    const allIdx = new Map() // meshName -> Set(index)
    for (const [mn, m] of seedByIndex) for (const i of m.keys()) allIdx.set(mn, (allIdx.get(mn) ?? new Set()).add(i))
    for (const { meshName, i } of grpByIndex.values()) allIdx.set(meshName, (allIdx.get(meshName) ?? new Set()).add(i))
    for (const [mn, set] of allIdx) {
      const seedM = seedByIndex.get(mn) ?? new Map()
      const arr = []
      for (const i of [...set].sort((a, b) => a - b)) {
        const sd = seedM.get(i) ?? [0, 0, 0]
        const inc = grpByIndex.get(mn + '#' + i)?.grp.corr ?? [0, 0, 0]
        const tot = [sd[0] + inc[0], sd[1] + inc[1], sd[2] + inc[2]]
        if (tot[0] === 0 && tot[1] === 0 && tot[2] === 0) continue
        arr.push([i, +tot[0].toFixed(6), +tot[1].toFixed(6), +tot[2].toFixed(6)])
      }
      if (arr.length) offsetsByMesh[mn] = arr
    }
  }
  // 终态复数（多瞬间采样最后一轮）
  let finalEmbedded = 0
  {
    g.engine.vmScene.updateMatrixWorld(true)
    for (const grp of groups.values()) {
      const p = skinOf(grp.m, grp.i0)
      if (nearGunVert(p[0], p[1], p[2]) <= 0.045 && insideGun(p[0], p[1], p[2])) finalEmbedded++
    }
  }
  return {
    weaponId,
    meshes: meshes.map((m) => ({ name: m.name, count: m.mesh.geometry.attributes.position.count })),
    passes,
    rounds,
    finalEmbedded,
    stubborn,
    offsets: offsetsByMesh,
    stats: { groups: groups.size, pushedGroups: pushCount, maxWorldPushMm: +(maxPush * 1000).toFixed(2),
             meanWorldPushMm: pushCount ? +((sumPush / pushCount) * 1000).toFixed(2) : 0, clearanceMm: CLEARANCE * 1000,
             corrCapMm: CORR_CAP * 1000 },
  }
}

// ---- 稳定 idle 等待 ----
async function waitIdleStable(page, weaponId) {
  await page.waitForFunction((id) => {
    const w = window.__game.weapons
    return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap
      && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0
      && (!w._armsAnim || !w._armsAnim.fire || w._armsAnim.fire.t === Infinity)
  }, weaponId, { timeout: 20000, polling: 100 })
  await page.waitForTimeout(450)
}

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: HEADLESS,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
let viteKilled = false
const killVite = (sig) => {
  if (viteKilled || !vite.pid) return
  viteKilled = true
  try { process.kill(-vite.pid, sig) } catch { /* 已退出 */ }
}
try {
  const t0 = Date.now()
  for (;;) {
    if (vite.exitCode !== null || vite.signalCode !== null) throw new Error(`vite 提前退出：${viteErr || vite.exitCode}`)
    try {
      const r = await fetch(BASE)
      if (r.ok) break
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) throw new Error(`vite 30s 未就绪：${viteErr}`)
    await new Promise((r) => setTimeout(r, 150))
  }
  log(`vite dev server 就绪 ${BASE} (pid ${vite.pid})`)

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => log('[pageerror]', e.message))
  page.on('console', (m) => { if (m.type() === 'error') log('[console.error]', m.text()) })
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForFunction(() => {
    const w = window.__game?.weapons
    return !!w && !!w._armsAssets && !!w.activeCustomVm('vandal') && !!w.activeCustomVm('phantom')
  }, null, { timeout: 60000, polling: 250 })
  await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
  await page.evaluate(() => {
    const g = window.__game
    g.bots.roundEndAt = 0
    g.bots.countdownUntil = 1e12
    if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  })
  log('训练已开始，Bot 调度已冻结')

  const report = {}
  for (const weaponId of ['vandal', 'phantom']) {
    await page.evaluate((id) => { window.__game.weapons.switchTo(id) }, weaponId)
    await waitIdleStable(page, weaponId)
    await page.evaluate((id) => { window.__game.weapons.weaponMeshFor(id) }, weaponId)
    await waitIdleStable(page, weaponId)
    const r = await page.evaluate(bakeWeapon, weaponId)
    log(`${weaponId}: 蒙皮网格 ${JSON.stringify(r.meshes)} · 迭代 ${JSON.stringify(r.passes)} · 收尾轮 ${JSON.stringify(r.rounds)} · 终态嵌枪组 ${r.finalEmbedded} · 顽固 ${r.stubborn.length} · 推出组 ${r.stats.pushedGroups}/${r.stats.groups} · 世界推距 max ${r.stats.maxWorldPushMm}mm / mean ${r.stats.meanWorldPushMm}mm (clearance ${r.stats.clearanceMm}mm)`)
    for (const [mn, arr] of Object.entries(r.offsets)) log(`  偏移表 ${mn}: ${arr.length} 顶点`)
    report[weaponId] = r
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n')
  log(`JSON 已写入 ${OUT}`)
} finally {
  try { await browser.close() } catch { /* 已关 */ }
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
  log('清理完成')
}
