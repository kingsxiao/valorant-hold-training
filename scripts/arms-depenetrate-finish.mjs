// 第 2 轮收尾驱动：审计在环（audit-in-the-loop）。最近面退出会落在 +X 奇偶意义下
// 的另一壁内（双壁区实测：推了 still inside，残余身份轮轮换）——而审计的判据就是
// +X 奇偶，其天然退出方向是 −X 回溯（把顶点挪回首次 +X 穿越面的 −X 侧，奇偶
// 恰翻一次）。本驱动：每轮按审计同款节律（switchTo→waitIdle→450ms→同帧度量）
// 列出残余顶点 → 对每个残余做 [−X 优先，步长 2/4/8/16mm] 的试探位移（当场写
// 几何→重蒙皮→奇偶判定，偶即留）→ 复量，直到残余为空或轮次/单顶点 60mm 累计
// 上限。产出最终偏移表（种子=源码 ARMS_DEPENETRATE live，含 UV 缝重复顶点）。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.resolve(ROOT, 'out/arms-depenetrate-finish.json')
const log = (...a) => console.log('[finish]', ...a)
fs.mkdirSync(path.dirname(OUT), { recursive: true })

const freePort = () => new Promise((res) => {
  const s = net.createServer(); s.unref()
  s.on('error', () => {})
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let viteErr = ''
vite.stderr.on('data', (d) => { viteErr += d })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
let killed = false
const killVite = (sig) => { if (killed || !vite.pid) return; killed = true; try { process.kill(-vite.pid, sig) } catch {} }

// 页内一轮：度量残余 → 定向修复 → 复量。返回 {residualsBefore, fixed, residualAfter, pushes}
async function cycle(weaponId) {
  const g = window.__game
  const w = g.weapons
  const vm = w.activeCustomVm(weaponId)
  const arms = w.officialArms
  g.engine.vmScene.updateMatrixWorld(true)

  // ---- 枪三角 + 加速结构（同帧世界系，audit 口径）----
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
  const vBk = new Map()
  for (let i = 0; i < verts.length; i += 3) {
    const k = Math.floor(verts[i] / CELL) + '|' + Math.floor(verts[i + 1] / CELL) + '|' + Math.floor(verts[i + 2] / CELL)
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

  // ---- 蒙皮网格 + 蒙皮线性 B_lin 有限差分 ----
  const mesh = (() => { let r = null; arms.traverse((o) => { if (!r && o.isSkinnedMesh) r = o }); return r })()
  const V3 = new mesh.position.constructor()
  const e = mesh.matrixWorld.elements
  const skinOf = (i) => {
    V3.fromBufferAttribute(mesh.geometry.attributes.position, i)
    mesh.applyBoneTransform(i, V3)
    return [e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12],
            e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13],
            e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14]]
  }
  const EPS = 1e-4
  const solveRest = (i, dwx, dwy, dwz) => {
    const pos = mesh.geometry.attributes.position
    const col = (axis) => {
      const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i)
      const d = [0, 0, 0]; d[axis] = EPS
      pos.setXYZ(i, x0 + d[0], y0 + d[1], z0 + d[2])
      const p1 = skinOf(i)
      pos.setXYZ(i, x0, y0, z0)
      const p0 = skinOf(i)
      return [(p1[0] - p0[0]) / EPS, (p1[1] - p0[1]) / EPS, (p1[2] - p0[2]) / EPS]
    }
    const bx = col(0), by = col(1), bz = col(2)
    const det = bx[0] * (by[1] * bz[2] - by[2] * bz[1]) - by[0] * (bx[1] * bz[2] - bx[2] * bz[1]) + bz[0] * (bx[1] * by[2] - bx[2] * by[1])
    if (Math.abs(det) < 1e-12) return null
    const inv = 1 / det
    return [
      ((by[1] * bz[2] - by[2] * bz[1]) * dwx - (bx[1] * bz[2] - bx[2] * bz[1]) * dwy + (bx[1] * by[2] - bx[2] * by[1]) * dwz) * inv,
      ((by[2] * bz[0] - by[0] * bz[2]) * dwx - (bx[2] * bz[0] - bx[0] * bz[2]) * dwy + (bx[2] * by[0] - bx[0] * by[2]) * dwz) * inv,
      ((by[0] * bz[1] - by[1] * bz[0]) * dwx - (bx[0] * bz[1] - bx[1] * bz[0]) * dwy + (bx[0] * by[1] - bx[1] * by[0]) * dwz) * inv,
    ]
  }

  const isOdd = (i) => { const p = skinOf(i); return nearGunVert(p[0], p[1], p[2]) <= 0.045 && insideGun(p[0], p[1], p[2]) }
  const residualsBefore = []
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) if (isOdd(i)) residualsBefore.push(i)

  // ---- 定向修复：−X 优先回溯（指标 = +X 奇偶，回溯首次穿越面恰翻一次奇偶）----
  const DIRS = [[-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const STEPS = [0.002, 0.004, 0.008, 0.016, 0.032]
  const worldPush = new Map()
  let fixed = 0
  const stillOdd = []
  for (const i of residualsBefore) {
    let ok = false
    for (const d of DIRS) {
      for (const s of STEPS) {
        if ((worldPush.get(i) ?? 0) + s > 0.06) break
        const dw = [d[0] * s, d[1] * s, d[2] * s]
        const dr = solveRest(i, dw[0], dw[1], dw[2])
        if (!dr) continue
        const pos = mesh.geometry.attributes.position
        const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i)
        pos.setXYZ(i, x0 + dr[0], y0 + dr[1], z0 + dr[2])
        // 重复顶点同步（静止位重合者同推，防撕面）
        const rk = x0.toFixed(6) + ',' + y0.toFixed(6) + ',' + z0.toFixed(6)
        const dups = []
        for (let j = 0; j < pos.count; j++) {
          if (j === i) continue
          const rk2 = pos.getX(j).toFixed(6) + ',' + pos.getY(j).toFixed(6) + ',' + pos.getZ(j).toFixed(6)
          if (rk2 === rk) { pos.setXYZ(j, pos.getX(j) + dr[0], pos.getY(j) + dr[1], pos.getZ(j) + dr[2]); dups.push(j) }
        }
        if (!isOdd(i)) { ok = true; worldPush.set(i, (worldPush.get(i) ?? 0) + s); break }
        pos.setXYZ(i, x0, y0, z0)
        for (const j of dups) pos.setXYZ(j, pos.getX(j) - dr[0], pos.getY(j) - dr[1], pos.getZ(j) - dr[2])
      }
      if (ok) break
    }
    if (ok) fixed++
    else stillOdd.push(i)
  }
  return {
    residualCount: residualsBefore.length,
    residualsBefore,
    fixed,
    stillOdd,
    pushes: [...worldPush.entries()].map(([i, v]) => [i, +v.toFixed(4)]),
  }
}

async function waitIdleStable(page, weaponId) {
  await page.waitForFunction((id) => {
    const w = window.__game.weapons
    return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap
      && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0
      && (!w._armsAnim || !w._armsAnim.fire || w._armsAnim.fire.t === Infinity)
  }, weaponId, { timeout: 20000, polling: 100 })
  await page.waitForTimeout(450)
}

try {
  const t0 = Date.now()
  for (;;) {
    if (vite.exitCode !== null) throw new Error(`vite 提前退出：${viteErr}`)
    try { if ((await fetch(BASE)).ok) break } catch {}
    if (Date.now() - t0 > 30000) throw new Error('vite 30s 未就绪')
    await new Promise((r) => setTimeout(r, 150))
  }
  log(`vite 就绪 ${BASE} (pid ${vite.pid})`)
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
    g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12
    if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  })

  // 总偏移账本（种子 = 源码 live）——页内克隆逐轮累加，轮间几何持续（同页同 attach）
  await page.evaluate(() => {
    const arms = window.__game.weapons.officialArms
    arms.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update() })
  })
  const report = {}
  for (const weaponId of ['vandal', 'phantom']) {
    await page.evaluate((id) => { window.__game.weapons.switchTo(id) }, weaponId)
    await waitIdleStable(page, weaponId)
    const cycles = []
    let table = null
    for (let c = 1; c <= 8; c++) {
      const r = await page.evaluate(cycle, weaponId)
      cycles.push({ cycle: c, residual: r.residualCount, fixed: r.fixed, stillOdd: r.stillOdd })
      log(`${weaponId} 轮${c}: 残余 ${r.residualCount}（${JSON.stringify(r.residualsBefore)}）→ 修复 ${r.fixed}，未解 ${JSON.stringify(r.stillOdd)}`)
      if (r.residualCount === 0) break
      if (r.fixed === 0) { log(`${weaponId} 轮${c} 无进展，停`); break }
    }
    // 终态复量
    const finalCheck = await page.evaluate(cycle, weaponId)
    cycles.push({ cycle: 'verify', residual: finalCheck.residualCount })
    log(`${weaponId} 复量: 残余 ${finalCheck.residualCount}`)
    // 导出最终几何 vs 模板的每顶点偏移
    table = await page.evaluate((wid) => {
      const w = window.__game.weapons
      const arms = w.officialArms
      const tpl = new Map()
      w._armsAssets.scene.traverse((o) => { if (o.isSkinnedMesh && o.geometry) tpl.set(o.name, o.geometry) })
      const out = {}
      arms.traverse((o) => {
        if (!o.isSkinnedMesh) return
        const tp = tpl.get(o.name)?.attributes.position
        if (!tp) return
        const pos = o.geometry.attributes.position
        const arr = []
        for (let i = 0; i < pos.count; i++) {
          const dx = pos.getX(i) - tp.getX(i), dy = pos.getY(i) - tp.getY(i), dz = pos.getZ(i) - tp.getZ(i)
          if (dx !== 0 || dy !== 0 || dz !== 0) arr.push([i, +dx.toFixed(6), +dy.toFixed(6), +dz.toFixed(6)])
        }
        if (arr.length) out[o.name] = arr
      })
      return out
    }, weaponId)
    report[weaponId] = { cycles, table }
    log(`${weaponId} 最终偏移 ${table.FP_Phoenix_S0_Skelmesh001?.length ?? 0} 顶点`)
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n')
  log(`JSON 已写入 ${OUT}`)
} finally {
  try { await browser.close() } catch {}
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
  log('清理完成')
}
