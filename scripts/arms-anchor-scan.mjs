// 第 1 轮修复 v4（终版）：ARMS_ANCHORS 在五轮终态拟合基（枪本地两点拟合 + 数据解
// 滚转）下的重扫描。前三轮教训沉淀为三条铁律：
//   ① 流形：两点拟合把右腕精确钉锚、左腕落在 dstR + spanDir×(|srcSpan|·sLocal)
//     ——左锚只在 |handL−handR| = L*（实际落腕跨度，页内实测）时可达。源锚对
//     半径 L0 与 L* 差 6.2/20.9 本地 mm（≈1.9/6.5 世界 mm）——arms-audit.mjs
//     wristErrMm 漏 ×1000（米标成 mm）把真相盖成了 0.0019/0.0065。v4 把 handL
//     候选投影回 handR 为心、L* 为半径的球面（保方向锁半径）→ 双腕真实零误差
//     （严格优于基线），基线投影点物理姿势与现役完全一致。
//   ② 方向：「+X 光线奇偶」是方向敏感算法——vm 本地系的 +X 是另一条世界方向
//     （vmBaseYaw≈11.5°+枪自转），非凸枪网穿棱数全变（同帧同姿势实测 34→225）。
//     必须全程世界系做奇偶（arms-audit.mjs 口径）。
//   ③ 同帧：枪/臂须同一 updateMatrixWorld 瞬间取位——枪 setup 时存 vm 本地系
//     （刚体不变帧），每 eval 经当前 vm.matrixWorld 搬回世界再建桶，与蒙皮手臂
//     严格同帧（跨瞬间世界冻结会被 holder 呼吸相位漂移污染，实测 28↔34 抖动）。
// 目标函数（DEPLOY 四轮「锚扫描收敛」同源）：奇偶穿透主目标 + 十指尖悬停次级；
// 硬约束：pierceVisible=0、世界系腕锚误差≤0.2mm、肘移≤40mm（防「把手臂转离枪」，
// 五轮「指标陷阱」）、不碰 __ARMS_ROLL / OFFICIAL_HAND_EQUIV。
//
// 用法：node scripts/arms-anchor-scan.mjs --out out/arms-anchor-scan.json
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
const OUT = path.resolve(ROOT, arg('out', 'out/arms-anchor-scan.json'))
const HEADLESS = process.argv.includes('--headless')
const log = (...a) => console.log('[arms-scan]', ...a)

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

// ---- 页内：setup（枪几何存 vm 本地系）/ eval（重摆 + 世界系审计口径度量）----
async function harness(job) {
  const g = window.__game
  const w = g.weapons
  if (job.mode === 'setup') {
    const weaponId = job.weaponId
    const vm = w.activeCustomVm(weaponId)
    const arms = w.officialArms
    if (!vm || !arms) throw new Error('setup: vm/arms 未就绪')
    g.engine.vmScene.updateMatrixWorld(true)
    const vmInv = vm.matrixWorld.clone().invert()

    // ---- 枪三角存 vm 本地系（刚体不变帧；每 eval 经当前 vm.matrixWorld 搬回世界）----
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
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12]
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13]
          const wz = e[2] * x + e[6] * y + e[10] * z + e[14]
          verts.push(vmInv.elements[0] * wx + vmInv.elements[4] * wy + vmInv.elements[8] * wz + vmInv.elements[12],
                     vmInv.elements[1] * wx + vmInv.elements[5] * wy + vmInv.elements[9] * wz + vmInv.elements[13],
                     vmInv.elements[2] * wx + vmInv.elements[6] * wy + vmInv.elements[10] * wz + vmInv.elements[14])
        }
        const idx = o.geometry.index
        const n = idx ? idx.count : pos.count
        for (let t = 0; t < n; t += 3) {
          const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2
          tris.push(base + ia * 3, base + ib * 3, base + ic * 3) // 顶点索引（eval 展开成世界值）
        }
      }
      for (const c of o.children) walkGun(c)
    }
    walkGun(vm)
    window.__armsScan = { weaponId, verts, tris, gunVerts: verts.length / 3, gunTris: tris.length / 9 }
    return { gunVerts: verts.length / 3, gunTris: tris.length / 9 }
  }

  // ---- eval：设锚 → 强制重摆 → 骨矩阵刷新 → 世界系审计口径度量 ----
  const st = window.__armsScan
  const weaponId = st.weaponId
  globalThis.__ARMS_ANCHORS = globalThis.__ARMS_ANCHORS || {}
  globalThis.__ARMS_ANCHORS[weaponId] = { handR: job.anchors.handR.slice(), handL: job.anchors.handL.slice() }
  w._armsPoseFor = null
  w.weaponMeshFor(weaponId)
  const vm = w.activeCustomVm(weaponId)
  const arms = w.officialArms
  if (!arms) return { ok: false, why: 'attach 失败' }
  const g2 = window.__game
  g2.engine.vmScene.updateMatrixWorld(true) // 先骨 matrixWorld……
  arms.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update() }) // ……再 boneMatrices（免等渲染帧的陈旧零阵）
  g2.engine.vmScene.updateMatrixWorld(true)
  const V3C = Object.getPrototypeOf(vm.position).constructor
  const gunScale = vm.getWorldScale(new V3C()).x
  const vmInv = vm.matrixWorld.clone().invert()
  const toVm = (wx, wy, wz, out) => {
    const e = vmInv.elements
    out[0] = e[0] * wx + e[4] * wy + e[8] * wz + e[12]
    out[1] = e[1] * wx + e[5] * wy + e[9] * wz + e[13]
    out[2] = e[2] * wx + e[6] * wy + e[10] * wz + e[14]
    return out
  }

  // ---- 枪三角搬回世界（与手臂同一 updateMatrixWorld 瞬间）+ 世界桶（audit 同款）----
  const verts = []
  const tris = []
  {
    const e = vm.matrixWorld.elements
    const src = st.verts
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i], y = src[i + 1], z = src[i + 2]
      verts.push(e[0] * x + e[4] * y + e[8] * z + e[12],
                 e[1] * x + e[5] * y + e[9] * z + e[13],
                 e[2] * x + e[6] * y + e[10] * z + e[14])
    }
    const srcT = st.tris
    for (let t = 0; t < srcT.length; t += 3) {
      const a = srcT[t], b = srcT[t + 1], c = srcT[t + 2]
      tris.push(verts[a], verts[a + 1], verts[a + 2],
                verts[b], verts[b + 1], verts[b + 2],
                verts[c], verts[c + 1], verts[c + 2])
    }
  }
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
  // +X 世界光线奇偶（arms-audit.mjs 原样，含 t 分子未除 det 的修正）
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

  // ---- 手臂蒙皮（世界系，与枪同帧）----
  let armVerts = 0
  const pierce = []
  const walkArms = (o) => {
    if (o.isSkinnedMesh && o.geometry && o.geometry.attributes.position) {
      const pos = o.geometry.attributes.position
      const V3 = new o.position.constructor() // Object3D.position 是 Vector3
      const e = o.matrixWorld.elements
      for (let i = 0; i < pos.count; i++) {
        V3.fromBufferAttribute(pos, i)
        o.applyBoneTransform(i, V3)
        const x = e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12]
        const y = e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13]
        const z = e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14]
        armVerts++
        if (nearGunVert(x, y, z) > 0.045) continue // 世界 45mm 带
        if (insideGun(x, y, z)) pierce.push([x, y, z])
      }
    }
    for (const c of o.children) walkArms(c)
  }
  walkArms(arms)

  // 可见子集：眼（vmCamera 世界位）→ 顶点射线遮挡测试（audit 同款）
  const ce = g2.engine.vmCamera.matrixWorld.elements
  const ex = ce[12], ey = ce[13], ez = ce[14]
  const occludedByGun = (px, py, pz) => {
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
  let pierceVisible = 0
  for (const p of pierce) if (!occludedByGun(p[0], p[1], p[2])) pierceVisible++

  // ---- 骨位指标（世界系；腕锚误差按 audit 公式：锚经 vm.localToWorld 入世界）----
  const byName = {}
  const walkNames = (o) => { if (o.name) byName[o.name] = o; for (const c of o.children) walkNames(c) }
  walkNames(arms)
  const bonePos = (n) => {
    const b = byName[n]
    if (!b) throw new Error(`缺骨 ${n}`)
    const e = b.matrixWorld.elements
    return [e[12], e[13], e[14]]
  }
  const TIPS = ['R_Index3', 'R_Middle3', 'R_Ring3', 'R_Pinky3', 'R_Thumb3',
                'L_Index3', 'L_Middle3', 'L_Ring3', 'L_Pinky3', 'L_Thumb3']
  const tipsMm = TIPS.map((n) => {
    const p = bonePos(n)
    return +(nearGunVert(p[0], p[1], p[2]) * 1000).toFixed(3)
  })
  const V3 = new V3C()
  let wristErr = 0
  for (const [bone, key] of [['R_Hand', 'handR'], ['L_Hand', 'handL']]) {
    const aw = vm.localToWorld(V3.set(job.anchors[key][0], job.anchors[key][1], job.anchors[key][2]))
    const bp = bonePos(bone)
    wristErr = Math.max(wristErr, Math.sqrt((bp[0] - aw.x) ** 2 + (bp[1] - aw.y) ** 2 + (bp[2] - aw.z) ** 2))
  }
  const wristR = bonePos('R_Hand'), wristL = bonePos('L_Hand')
  const wristSpanLocal = Math.hypot(...toVm(...wristL, [0, 0, 0]).map((v, i) => v - toVm(...wristR, [0, 0, 0])[i]))
  const CHAIN = ['R_Hand', 'R_Middle0', 'R_Middle1', 'R_Middle2', 'R_Middle3']
  let prev = null
  let handScale = 0
  for (const n of CHAIN) {
    const cur = bonePos(n)
    if (prev) handScale += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2])
    prev = cur
  }
  return {
    ok: true,
    gunScale: +gunScale.toFixed(6),
    pierce: pierce.length,
    visible: pierceVisible,
    tipMinMm: Math.min(...tipsMm),
    tipMeanMm: +(tipsMm.reduce((a, b) => a + b, 0) / tipsMm.length).toFixed(3),
    tipsMm,
    wristErrMm: +(wristErr * 1000).toFixed(4), // 世界 mm（= 修正 ×1000 后的审计口径）
    wristSpanLocal: +wristSpanLocal.toFixed(6), // 实际落腕跨度（vm 本地）= L*
    handScaleCm: +(handScale * 100).toFixed(3),
    elbows: { R: bonePos('R_Elbow'), L: bonePos('L_Elbow') },
    armVerts,
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

// ---- Node 侧评分（硬约束罚项穿透主量子 1e4；全部世界系单位）----
const argN = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}
const TIP_SLACK_MIN = argN('tip-slack-min', 1.5) // 指尖最近悬停相对基线允许的退让（mm）
const TIP_SLACK_MEAN = argN('tip-slack-mean', 1.5)
const LOCK_HANDR = process.argv.includes('--lock-handR') // 右手锚锁基线（守握把接触换 L 臂收益）
const ONLY = (arg('weapons', '') || '').split(',').filter(Boolean)

function scoreOf(m, guard) {
  if (!m.ok) return Infinity
  let s = m.pierce * 1e4 + m.visible * 1e6
  if (m.wristErrMm > 0.2) s += 1e7 // 腕锚零误差锁（投影流形下应 ≈0）
  s += Math.max(0, m.tipMinMm - guard.tipMinMm - TIP_SLACK_MIN) * 800
  s += Math.max(0, m.tipMeanMm - guard.tipMeanMm - TIP_SLACK_MEAN) * 800
  s += (m.tipMinMm + m.tipMeanMm) * 2 // 平分时贴枪 tie-break
  const elbowMove = Math.max(
    Math.hypot(m.elbows.R[0] - guard.elbows.R[0], m.elbows.R[1] - guard.elbows.R[1], m.elbows.R[2] - guard.elbows.R[2]),
    Math.hypot(m.elbows.L[0] - guard.elbows.L[0], m.elbows.L[1] - guard.elbows.L[1], m.elbows.L[2] - guard.elbows.L[2]),
  ) * 1000
  if (elbowMove > 40) s += (elbowMove - 40) * 1e4
  return s
}
// handL 候选投影回球面：方向保留、半径锁 L*（实际落腕跨度）→ 双腕真实零误差
function projectL(anchors, Lstar) {
  const r = anchors.handR, l = anchors.handL
  const dx = l[0] - r[0], dy = l[1] - r[1], dz = l[2] - r[2]
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (len < 1e-9) return
  const k = Lstar / len
  l[0] = r[0] + dx * k
  l[1] = r[1] + dy * k
  l[2] = r[2] + dz * k
}

const BASE_ANCHORS = {
  vandal: { handR: [0.24, -0.009, -0.109], handL: [-0.247, 0.0225, -0.0045] },
  phantom: { handR: [0.237, -0.0495, -0.097], handL: [-0.2065, -0.017, 0.0025] },
}
const spanLen = (a) => Math.hypot(a.handL[0] - a.handR[0], a.handL[1] - a.handR[1], a.handL[2] - a.handR[2])

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

  const STEPS = [0.006, 0.003, 0.0012, 0.0006]
  const report = {}
  for (const weaponId of (ONLY.length ? ONLY : ['vandal', 'phantom'])) {
    await page.evaluate((id) => { window.__game.weapons.switchTo(id) }, weaponId)
    await waitIdleStable(page, weaponId)
    await page.evaluate((id) => { window.__game.weapons.weaponMeshFor(id) }, weaponId)
    await waitIdleStable(page, weaponId)
    const gun = await page.evaluate(harness, { mode: 'setup', weaponId })
    log(`${weaponId}: 枪 ${gun.gunVerts} 顶点/${gun.gunTris} 三角（存 vm 本地系），加速结构每 eval 现场建`)

    const base = await page.evaluate(harness, { mode: 'eval', anchors: BASE_ANCHORS[weaponId] })
    const baseRep = await page.evaluate(harness, { mode: 'eval', anchors: BASE_ANCHORS[weaponId] }) // 确定性自检
    if (baseRep.pierce !== base.pierce || baseRep.visible !== base.visible) {
      throw new Error(`${weaponId} eval 非确定：${base.pierce}/${base.visible} vs ${baseRep.pierce}/${baseRep.visible}`)
    }
    log(`${weaponId} 确定性自检通过（两次 eval pierce ${base.pierce}/${baseRep.pierce}）`)
    const guard = { tipMinMm: base.tipMinMm, tipMeanMm: base.tipMeanMm, elbows: base.elbows }
    const Lstar = base.wristSpanLocal // 实际落腕跨度（源锚名义跨度 L0 与之差 = 既有左腕锚误差）
    log(`${weaponId} 基线: pierce ${base.pierce} visible ${base.visible} tipMin ${base.tipMinMm}mm wristErr ${base.wristErrMm}mm hand ${base.handScaleCm}cm gunScale ${base.gunScale} L0 ${spanLen(BASE_ANCHORS[weaponId]).toFixed(6)} → L* ${Lstar} (差 ${((spanLen(BASE_ANCHORS[weaponId]) - Lstar) * 1000).toFixed(2)} 本地mm)`)

    // 起点 = 基线投影（物理姿势与现役完全一致，名义左锚改到可达点 → 腕锚误差归零）
    let cur = JSON.parse(JSON.stringify(BASE_ANCHORS[weaponId]))
    projectL(cur, Lstar)
    let curM = await page.evaluate(harness, { mode: 'eval', anchors: cur })
    let evals = 3
    let curScore = scoreOf(curM, guard)
    log(`${weaponId} 投影基线: pierce ${curM.pierce} visible ${curM.visible} tipMin ${curM.tipMinMm}mm wristErr ${curM.wristErrMm}mm hand ${curM.handScaleCm}cm score ${curScore}`)

    for (const step of STEPS) {
      for (let sweeps = 0; sweeps < 8; sweeps++) {
        let improved = false
        const hands = LOCK_HANDR ? ['handL'] : ['handR', 'handL']
        for (const hand of hands) {
          for (const ax of [0, 1, 2]) {
            for (const dir of [1, -1]) {
              const cand = JSON.parse(JSON.stringify(cur))
              cand[hand][ax] += dir * step
              if (hand === 'handL') projectL(cand, Lstar) // 半径锁：双腕精确落锚
              const m = await page.evaluate(harness, { mode: 'eval', anchors: cand })
              evals++
              const s = scoreOf(m, guard)
              if (s < curScore - 1e-9) {
                cur = cand; curScore = s; curM = m; improved = true
                log(`${weaponId} 步${step} 接受 ${hand}[${'xyz'[ax]}]${dir > 0 ? '+' : '−'} → handR[${cur.handR}] handL[${cur.handL.map((v) => +v.toFixed(4))}] pierce ${m.pierce} vis ${m.visible} tip ${m.tipMinMm}/${m.tipMeanMm}mm werr ${m.wristErrMm}mm score ${s.toFixed(0)}`)
              }
            }
          }
        }
        if (!improved) break
      }
    }
    // 固化精度（0.1mm 本地量化 + 重投影）后复评，取优
    const rounded = JSON.parse(JSON.stringify(cur))
    for (const h of ['handR', 'handL']) for (let i = 0; i < 3; i++) rounded[h][i] = Math.round(rounded[h][i] * 1e4) / 1e4
    projectL(rounded, Lstar)
    for (const h of ['handL']) for (let i = 0; i < 3; i++) rounded[h][i] = Math.round(rounded[h][i] * 1e4) / 1e4
    const mR = await page.evaluate(harness, { mode: 'eval', anchors: rounded }); evals++
    let finalAnchors = cur, finalM = curM
    if (scoreOf(mR, guard) <= scoreOf(curM, guard)) { finalAnchors = rounded; finalM = mR }
    log(`${weaponId} 收敛: evals ${evals} → pierce ${base.pierce}→${finalM.pierce} visible ${finalM.visible} tipMin ${finalM.tipMinMm}mm wristErr ${finalM.wristErrMm}mm hand ${finalM.handScaleCm}cm`)
    log(`${weaponId} 锚: ${JSON.stringify(finalAnchors)}`)
    report[weaponId] = { base: { pierce: base.pierce, visible: base.visible, tipMinMm: base.tipMinMm,
        wristErrMm: base.wristErrMm, handScaleCm: base.handScaleCm },
      L0: spanLen(BASE_ANCHORS[weaponId]), Lstar, final: finalAnchors, metrics: finalM, evals }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
  log(`JSON 已写入 ${OUT}`)
} finally {
  try { await browser.close() } catch { /* 已关 */ }
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
  log('清理完成')
}
