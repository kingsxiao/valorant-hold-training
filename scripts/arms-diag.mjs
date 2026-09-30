// 诊断（本轮修复第 1 步）：phantom 评审伪影归因。四类伪影（拇指横穿枪管/袖口
// 拧麻花/指列扇形不包握/网格撕裂尖刺）对照两条新增改动（ARMS_DEPENETRATE
// 网格位移表 vs ARMS_GRIP_PATCH 指骨旋转）做因果分离：
//   A. 数字取证：去穿透 8 顶点的解剖归属（骨权重）/接缝重复覆盖/世界位移量级；
//      嵌枪 30 顶点与相交 27 三角的骨归属；指尖-枪面关系。
//   B. 对照实验：base / 无补丁 / 无去穿透 / 双无 四变体截图+审计同口径计数。
// 用法：node scripts/arms-diag.mjs --out out/arms-diag.json --shots out/arms-diag-shots
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditWeaponInPage } from './arms-audit-fn.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const OUT = path.resolve(ROOT, arg('out', 'out/arms-diag.json'))
const SHOTS = path.resolve(ROOT, arg('shots', 'out/arms-diag-shots'))
const log = (...a) => console.log('[arms-diag]', ...a)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer()
  s.unref()
  s.on('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let viteErr = ''
vite.stderr.on('data', (d) => { viteErr += d })
vite.on('exit', (code) => { if (code !== 0 && code !== null) viteErr += `\nvite exited ${code}` })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
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
    if (vite.exitCode !== null || vite.signalCode !== null) throw new Error(`vite 提前退出：${viteErr}`)
    try { const r = await fetch(BASE); if (r.ok) break } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) throw new Error(`vite 30s 未就绪：${viteErr}`)
    await new Promise((r) => setTimeout(r, 150))
  }
  log(`vite 就绪 ${BASE}`)
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
  await page.evaluate(() => window.__game.weapons.switchTo('phantom'))
  const waitIdle = () => page.waitForFunction((id) => {
    const w = window.__game.weapons
    return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap
      && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0
      && (!w._armsAnim || !w._armsAnim.fire || w._armsAnim.fire.t === Infinity)
  }, 'phantom', { timeout: 20000, polling: 100 }).then(() => page.waitForTimeout(450))
  await waitIdle()
  log('phantom idle 稳定')

  // ---- 变体控制（页内）：补丁缝 = globalThis.__GRIP_PATCH；去穿透 = 清空
  // ARMS_DEPENETRATE.phantom 后 weaponMeshFor 重挂（缓存键查表前置短路，落回
  // 模板几何；恢复表后再重挂则命中缓存 = 精确回到 base 几何）----
  const setVariant = async (patch, depen) => page.evaluate(async ([patch, depen]) => {
    const w = window.__game.weapons
    const OA = await import('/src/weapons/OfficialArms.js')
    if (depen) {
      if (!OA.ARMS_DEPENETRATE.__savedPhantom) OA.ARMS_DEPENETRATE.__savedPhantom = OA.ARMS_DEPENETRATE.phantom
      OA.ARMS_DEPENETRATE.phantom = depen === 'off' ? {} : OA.ARMS_DEPENETRATE.__savedPhantom
    }
    // patch=true → 覆盖缝置空表（禁用补丁）；false → 缝整体摘除（回退烘焙表）
    globalThis.__GRIP_PATCH = patch ? { vandal: {}, phantom: {} } : null
    w._armsPoseFor = null
    w.weaponMeshFor('phantom')
    return { poseFor: w._armsPoseFor, arms: !!w.officialArms }
  }, [patch, depen])

  // ---- 取证函数（base 态下跑一次）----
  const forensic = () => page.evaluate(async () => {
    const g = window.__game
    const w = g.weapons
    const vm = w.activeCustomVm('phantom')
    const arms = w.officialArms
    const OA = await import('/src/weapons/OfficialArms.js')
    g.engine.vmScene.updateMatrixWorld(true)
    const out = { meshes: [], depen: [], pierce: [], intersect: [], tips: [], patch: {} }

    // 网格清单
    arms.traverse((o) => {
      if (o.isSkinnedMesh) out.meshes.push({ name: o.name, verts: o.geometry.attributes.position.count, skinned: true })
      else if (o.isMesh) out.meshes.push({ name: o.name || '(noname)', verts: o.geometry.attributes.position?.count ?? 0, skinned: false })
    })

    // 枪三角（audit 同款世界系收集）
    const verts = [], tris = []
    const inArmSubtree = (o) => { for (let p = o; p; p = p.parent) if (p === arms) return true; return false }
    const walkGun = (o) => {
      if (inArmSubtree(o)) return
      if (o.isMesh && o.geometry && o.geometry.attributes.position) {
        const pos = o.geometry.attributes.position
        const e = o.matrixWorld.elements
        const base = verts.length
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
          verts.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14])
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

    // +X 奇偶
    const TCELL = 0.03
    const tBk = new Map()
    for (let t = 0; t < tris.length; t += 9) {
      const y0 = Math.min(tris[t + 1], tris[t + 4], tris[t + 7]), y1 = Math.max(tris[t + 1], tris[t + 4], tris[t + 7])
      const z0 = Math.min(tris[t + 2], tris[t + 5], tris[t + 8]), z1 = Math.max(tris[t + 2], tris[t + 5], tris[t + 8])
      for (let gy = Math.floor(y0 / TCELL); gy <= Math.floor(y1 / TCELL); gy++)
        for (let gz = Math.floor(z0 / TCELL); gz <= Math.floor(z1 / TCELL); gz++) {
          const k = gy + '|' + gz
          let a = tBk.get(k); if (!a) tBk.set(k, (a = [])); a.push(t)
        }
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
    // 最近枪顶点距离（暴力：7k 顶点 × 少数查询点，可承受）
    const nearGun = (x, y, z) => {
      let best = Infinity
      for (let i = 0; i < verts.length; i += 3) {
        const d = (verts[i] - x) ** 2 + (verts[i + 1] - y) ** 2 + (verts[i + 2] - z) ** 2
        if (d < best) best = d
      }
      return Math.sqrt(best)
    }
    // 眼遮挡（audit 同款）
    const ce = g.engine.vmCamera.matrixWorld.elements
    const ex = ce[12], ey = ce[13], ez = ce[14]
    const occluded = (px, py, pz) => {
      const dx = px - ex, dy = py - ey, dz = pz - ez
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (len < 1e-9) return false
      const invLen = 1 / len
      const ddx = dx * invLen, ddy = dy * invLen, ddz = dz * invLen
      const maxT = len * (1 - 1e-4)
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

    // 蒙皮网格顶点遍历（带骨权重归属）
    const V3C = Object.getPrototypeOf(arms.position).constructor
    const tmp = new V3C()
    const armTris = [] // {ia,ib,ic 世界坐标} + 顶点索引
    const armV = []
    const vMeta = [] // {bones:[{n,w}...], idx, mesh}
    const smInfo = []
    const walkArms = (o) => {
      if (o.isSkinnedMesh && o.geometry && o.geometry.attributes.position) {
        const pos = o.geometry.attributes.position
        const si = o.geometry.attributes.skinIndex
        const sw = o.geometry.attributes.skinWeight
        const bones = o.skeleton.bones
        const e = o.matrixWorld.elements
        const base = armV.length / 3
        const topBones = (i) => {
          const arr = []
          for (let k = 0; k < 4; k++) {
            const wgt = sw.getComponent(i, k)
            if (wgt > 0.01) arr.push({ n: bones[si.getComponent(i, k)]?.name ?? '?', w: +wgt.toFixed(2) })
          }
          arr.sort((a, b) => b.w - a.w)
          return arr.slice(0, 3)
        }
        const rec = { name: o.name, verts: pos.count, byBone: {} }
        for (let i = 0; i < pos.count; i++) {
          tmp.fromBufferAttribute(pos, i)
          o.applyBoneTransform(i, tmp)
          const x = e[0] * tmp.x + e[4] * tmp.y + e[8] * tmp.z + e[12]
          const y = e[1] * tmp.x + e[5] * tmp.y + e[9] * tmp.z + e[13]
          const z = e[2] * tmp.x + e[6] * tmp.y + e[10] * tmp.z + e[14]
          armV.push(x, y, z)
          vMeta.push({ idx: i, mesh: o.name, bones: topBones(i) })
          if (nearGun(x, y, z) > 0.045) continue
          if (insideGun(x, y, z)) {
            const vis = !occluded(x, y, z)
            rec.byBone[vMeta[vMeta.length - 1].bones[0]?.n ?? '?'] =
              (rec.byBone[vMeta[vMeta.length - 1].bones[0]?.n ?? '?'] ?? 0) + 1
            out.pierce.push({ i, mesh: o.name, x, y, z, vis, bones: vMeta[vMeta.length - 1].bones })
          }
        }
        for (const [bn, c] of Object.entries(rec.byBone)) rec.byBone[bn] = c
        smInfo.push(rec)
        const idx = o.geometry.index
        const n = idx ? idx.count : pos.count
        for (let t = 0; t < n; t += 3) {
          const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2
          armTris.push({ mesh: o.name, i: [base + ia, base + ib, base + ic],
            p: [armV[base + ia * 3], armV[base + ia * 3 + 1], armV[base + ia * 3 + 2],
              armV[base + ib * 3], armV[base + ib * 3 + 1], armV[base + ib * 3 + 2],
              armV[base + ic * 3], armV[base + ic * 3 + 1], armV[base + ic * 3 + 2]] })
        }
      }
      for (const c of o.children) walkArms(c)
    }
    walkArms(arms)
    out.pierceByBone = {}
    for (const p of out.pierce) {
      const bn = p.bones[0]?.n ?? '?'
      out.pierceByBone[bn] = (out.pierceByBone[bn] ?? 0) + 1
    }

    // 模板几何 + 去穿透表取证
    const tmplByMesh = new Map()
    w._armsAssets.scene.traverse((o) => { if (o.isSkinnedMesh) tmplByMesh.set(o.name, o.geometry) })
    const tbl = OA.ARMS_DEPENETRATE.phantom?.FP_Phoenix_S0_Skelmesh001
    if (tbl) {
      const tg = tmplByMesh.get('FP_Phoenix_S0_Skelmesh001')
      const live = arms.traverse && (() => { let m = null; arms.traverse((o) => { if (o.isSkinnedMesh && o.name === 'FP_Phoenix_S0_Skelmesh001') m = o }); return m })()
      const tpos = tg.attributes.position
      const n = tpos.count
      // rest 位置指纹（含权重）用于重复顶点判定
      const restOf = (i) => [tpos.getX(i), tpos.getY(i), tpos.getZ(i)]
      const inTable = new Map(tbl.map(([i, dx, dy, dz]) => [i, [dx, dy, dz]]))
      const metaOf = (i) => vMeta.find((m) => m.mesh === 'FP_Phoenix_S0_Skelmesh001' && m.idx === i)
      const V3 = new V3C()
      const skinWorld = (geo, i) => {
        V3.fromBufferAttribute(geo.attributes.position, i)
        live.applyBoneTransform(i, V3)
        const e = live.matrixWorld.elements
        return [e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12], e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13], e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14]]
      }
      for (const [i, dx, dy, dz] of tbl) {
        const [px, py, pz] = restOf(i)
        // 世界位移：模板位 vs 模板位+Δ（同当前骨阵）
        const g2 = tg.clone()
        g2.attributes.position.setXYZ(i, px + dx, py + dy, pz + dz)
        g2.attributes.position.needsUpdate = true
        const a = skinWorld(tg, i), b = skinWorld(g2, i)
        const wDisp = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
        // 接缝重复：rest 位置 1e-5 内的其他顶点
        const dups = []
        for (let j = 0; j < n; j++) {
          if (j === i) continue
          const d2 = (tpos.getX(j) - px) ** 2 + (tpos.getY(j) - py) ** 2 + (tpos.getZ(j) - pz) ** 2
          if (d2 < 1e-10) dups.push(j)
        }
        const dupState = dups.map((j) => {
          const off = inTable.get(j)
          const same = off && Math.hypot(off[0] - dx, off[1] - dy, off[2] - dz) < 1e-9
          return { j, inTable: !!off, sameOffset: same }
        })
        out.depen.push({ i, rest: [+px.toFixed(4), +py.toFixed(4), +pz.toFixed(4)], wDispMm: +(wDisp * 1000).toFixed(3),
          bones: metaOf(i)?.bones ?? [], dups: dupState,
          inside: insideGun(...skinWorld(live.geometry, i)), vis: !occluded(...skinWorld(live.geometry, i)) })
      }
    }

    // 相交三角（简版 Möller：只统计 + 标骨归属；与 audit 数可能差 ±共面判定，取主归属）
    const segCount = (A, B) => {
      // 快速 AABB
      for (let k = 0; k < 3; k++) {
        const a0 = Math.min(A[k], A[3 + k], A[6 + k]), a1 = Math.max(A[k], A[3 + k], A[6 + k])
        const b0 = Math.min(B[k], B[3 + k], B[6 + k]), b1 = Math.max(B[k], B[3 + k], B[6 + k])
        if (a1 < b0 || b1 < a0) return 0
      }
      const n1 = [ (A[4]-A[1])*(A[8]-A[2]) - (A[5]-A[2])*(A[7]-A[1]), (A[5]-A[2])*(A[6]-A[0]) - (A[3]-A[0])*(A[8]-A[2]), (A[3]-A[0])*(A[7]-A[1]) - (A[4]-A[1])*(A[6]-A[0]) ]
      const n2 = [ (B[4]-B[1])*(B[8]-B[2]) - (B[5]-B[2])*(B[7]-B[1]), (B[5]-B[2])*(B[6]-B[0]) - (B[3]-B[0])*(B[8]-B[2]), (B[3]-B[0])*(B[7]-B[1]) - (B[4]-B[1])*(B[6]-B[0]) ]
      const d = (n, p, qx, qy, qz) => n[0]*(qx-p[0]) + n[1]*(qy-p[1]) + n[2]*(qz-p[2])
      const dB = [d(n1, A, B[0], B[1], B[2]), d(n1, A, B[3], B[4], B[5]), d(n1, A, B[6], B[7], B[8])]
      if (dB[0]*dB[1] > 0 && dB[0]*dB[2] > 0) return 0
      const dA = [d(n2, B, A[0], A[1], A[2]), d(n2, B, A[3], A[4], A[5]), d(n2, B, A[6], A[7], A[8])]
      if (dA[0]*dA[1] > 0 && dA[0]*dA[2] > 0) return 0
      return 1
    }
    const interByBone = {}
    let interCount = 0
    for (const at of armTris) {
      let hit = false
      for (let t = 0; t < tris.length && !hit; t += 9) hit = segCount(at.p, [tris[t], tris[t+1], tris[t+2], tris[t+3], tris[t+4], tris[t+5], tris[t+6], tris[t+7], tris[t+8]]) > 0
      if (!hit) continue
      interCount++
      const bn = (vMeta[at.i[0]]?.bones[0]?.n ?? '?')
      interByBone[bn] = (interByBone[bn] ?? 0) + 1
    }
    out.intersect = { count: interCount, byBone: interByBone }

    // 指尖 + 腕（vm 本地系坐标 + 距枪面）
    const byName = {}
    arms.traverse((o) => { if (o.name) byName[o.name] = o })
    for (const side of ['R', 'L']) for (const f of ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb']) {
      const bn = `${side}_${f}3`
      const node = byName[bn]
      if (!node) continue
      const wp = node.getWorldPosition(new V3C())
      const d = nearGun(wp.x, wp.y, wp.z)
      const lp = vm.worldToLocal(wp.clone())
      out.tips.push({ bone: bn, dMm: +(d * 1000).toFixed(2), vmLocal: [ +lp.x.toFixed(4), +lp.y.toFixed(4), +lp.z.toFixed(4) ] })
    }

    // 补丁实际生效检查：patched 骨当前四元数 vs idle 基
    const patchTbl = OA.ARMS_GRIP_PATCH.phantom ?? {}
    for (const bn of Object.keys(patchTbl)) {
      const rec = w._armsAnim?.bones?.find((b) => b.node.name === bn)
      if (!rec) { out.patch[bn] = 'MISSING_IN_ANIM' ; continue }
      const cur = rec.node.quaternion
      const delta = cur.clone().multiply(rec.idle.clone().invert())
      const ang = 2 * Math.acos(Math.min(1, Math.abs(delta.w))) * 180 / Math.PI
      out.patch[bn] = { appliedDeg: +ang.toFixed(1) }
    }
    out.smByBone = smInfo
    return out
  })
  const F = await forensic()
  await page.screenshot({ path: path.join(SHOTS, 'S1-base.png') })
  const A1 = await page.evaluate(auditWeaponInPage, 'phantom')
  log(`S1 base: pierce ${A1.pierceTotal}/${A1.pierceVisible} intersect ${A1.intersectTris}/${A1.intersectVisible} tip ${A1.fingertipMinMm}mm wrist ${A1.wristErrMm}mm hand ${A1.handScaleCm}cm`)

  await setVariant(true, null)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'S2-nopatch.png') })
  const A2 = await page.evaluate(auditWeaponInPage, 'phantom')
  log(`S2 noPatch: pierce ${A2.pierceTotal}/${A2.pierceVisible} intersect ${A2.intersectTris}/${A2.intersectVisible} tip ${A2.fingertipMinMm}mm wrist ${A2.wristErrMm}mm hand ${A2.handScaleCm}cm`)

  await setVariant(false, 'off')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'S3-nodepen.png') })
  const A3 = await page.evaluate(auditWeaponInPage, 'phantom')
  log(`S3 noDepen: pierce ${A3.pierceTotal}/${A3.pierceVisible} intersect ${A3.intersectTris}/${A3.intersectVisible} tip ${A3.fingertipMinMm}mm wrist ${A3.wristErrMm}mm hand ${A3.handScaleCm}cm`)

  await setVariant(true, 'off')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'S4-nopatch-nodepen.png') })
  const A4 = await page.evaluate(auditWeaponInPage, 'phantom')
  log(`S4 noPatch+noDepen: pierce ${A4.pierceTotal}/${A4.pierceVisible} intersect ${A4.intersectTris}/${A4.intersectVisible} tip ${A4.fingertipMinMm}mm wrist ${A4.wristErrMm}mm hand ${A4.handScaleCm}cm`)

  await setVariant(false, 'restore')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'S5-restore.png') })
  const A5 = await page.evaluate(auditWeaponInPage, 'phantom')
  log(`S5 restore(=base?): pierce ${A5.pierceTotal}/${A5.pierceVisible} intersect ${A5.intersectTris}/${A5.intersectVisible} tip ${A5.fingertipMinMm}mm wrist ${A5.wristErrMm}mm hand ${A5.handScaleCm}cm`)

  const json = {
    forensic: F,
    variants: {
      S1_base: A1, S2_noPatch: A2, S3_noDepen: A3, S4_noPatch_noDepen: A4, S5_restore: A5,
    },
  }
  fs.writeFileSync(OUT, JSON.stringify(json, null, 2) + '\n')
  log(`JSON 已写入 ${OUT}`)
} finally {
  try { await browser.close() } catch { /* 已关 */ }
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
  log('清理完成')
}
