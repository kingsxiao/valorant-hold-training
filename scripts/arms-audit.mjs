// 手臂穿模确定性审计（自包含）：自己拉起 vite dev server（--strictPort 随机空闲口）
// → playwright-core + 系统 Chrome 接管页面 → 开始训练 → 逐枪切到 vandal/phantom →
// 等 officialArms 挂载且 idle 腰射姿势稳定 → 页内按 DEPLOY.md「官方 1P 手臂四轮」
// 附录口径审计，另量指尖/腕锚/手尺三项指标 → JSON 写 --out，截图写 --shots。
//
// 穿透口径（四轮附录原文方法，不得用「最近顶点+法线符号」法——已知漏深嵌）：
//   手臂蒙皮顶点 sm.applyBoneTransform(i,v)（→ mesh 本地）再 sm.localToWorld(v)
//   （→ vmScene 世界系）两步都不能省；对枪三角做 +X 世界光线奇偶判定（odd=枪内）。
//   加速：枪顶点 30mm 3D 桶 broadphase（>45mm 带外直接跳过；±2 格搜索保证 45mm
//   带内最近顶点不漏）+ 三角 YZ 平面 2D 桶（光线只测所在格的三角）。
// 可见子集：玩家眼在 vmScene 系 = vmCamera 位（Engine.js:99「vmCamera 固定于原点
//   无旋转」）→ 眼→顶点射线对枪体三角做遮挡测试（命中点严格先于顶点即被遮挡）。
// 另量：十指尖（R/L_{Index,Middle,Ring,Pinky,Thumb}3）→ 枪顶点最近距离的最小值
//   （mm）；双腕骨（R_Hand/L_Hand）→ ARMS_ANCHORS 腕锚的最大误差（mm）；腕→中指尖
//   骨链（R_Hand→R_Middle0..3）相机系表观长度（cm，标称 8.2 = OFFICIAL_HAND_EQUIV）。
// 三角对相交口径（intersectTris/intersectVisible，八轮评审回退新增）：Möller 型
//   三角-三角区间法直接测网格对网格，捕捉「穿透而出」的奇偶盲区——完整口径与
//   精度取舍见 arms-audit-fn.mjs 文件头。
// 对账基线：DEPLOY.md 五轮终态 vandal 35 / phantom 56 嵌枪顶点（45mm 带内奇偶）。
//
// 用法：node scripts/arms-audit.mjs --out out/arms-audit.json --shots out/arms-shots
//       [--headless]（默认有头 + --use-angle=metal，capture-feet.mjs 同款 WebGL 前提）
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditWeaponInPage } from './arms-audit-fn.mjs'
import sharp from 'sharp'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const OUT = path.resolve(ROOT, arg('out', 'out/arms-audit.json'))
const SHOTS = path.resolve(ROOT, arg('shots', path.join(path.dirname(OUT), 'arms-shots')))
const HEADLESS = process.argv.includes('--headless')
const log = (...a) => console.log('[arms-audit]', ...a)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

// ---- 1. 随机空闲端口 + vite dev server（--strictPort，端口被抢即报错不静默换）----
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

// ---- 2. 页内审计（此函数整体序列化进页面执行：不得引用本模块作用域）----

// ---- 3. 稳定 idle 等待（真实路径切枪后：equip 完 / 无 pending / 无 fire / 无 ADS）----
async function waitIdleStable(page, weaponId) {
  await page.waitForFunction((id) => {
    const w = window.__game.weapons
    return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap
      && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0
      && (!w._armsAnim || !w._armsAnim.fire || w._armsAnim.fire.t === Infinity)
  }, weaponId, { timeout: 20000, polling: 100 })
  await page.waitForTimeout(450) // 弹簧组（后坐/落地/急停）余摆收敛
}

// ---- 主流程 ----
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
  // 等 vite 就绪（stdout Local: 或 HTTP 200；vite 早退立即报错）
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
  log(`vite dev server 就绪 ${BASE} (pid ${vite.pid}, strictPort)`)

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => log('[pageerror]', e.message))
  page.on('console', (m) => { if (m.type() === 'error') log('[console.error]', m.text()) })
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 60000 })
  // 等关键资产到货：官方手臂 GLB（后台批）+ 双枪 viewmodel GLB（关键批）
  await page.waitForFunction(() => {
    const w = window.__game?.weapons
    return !!w && !!w._armsAssets && !!w.activeCustomVm('vandal') && !!w.activeCustomVm('phantom')
  }, null, { timeout: 60000, polling: 250 })
  log('资产到货：arms-official.glb + viewmodel-{vandal,phantom}.glb')
  await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
  // 回合冻结：Bot 不出场（截图无闯镜者）、回合不结束；不碰武器/手臂任何状态
  await page.evaluate(() => {
    const g = window.__game
    g.bots.roundEndAt = 0
    g.bots.countdownUntil = 1e12
    if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  })
  log('训练已开始，Bot 调度已冻结')

  const results = []
  for (const weaponId of ['vandal', 'phantom']) {
    await page.evaluate((id) => { window.__game.weapons.switchTo(id) }, weaponId) // 真实切换路径
    await waitIdleStable(page, weaponId)
    await page.evaluate((id) => { window.__game.weapons.weaponMeshFor(id) }, weaponId) // 确保重摆幂等
    await waitIdleStable(page, weaponId)
    const shotPath = path.join(SHOTS, `${weaponId}.png`)
    await page.screenshot({ path: shotPath })
    const r = await page.evaluate(auditWeaponInPage, weaponId)
    const base = { vandal: 35, phantom: 56 }[weaponId]
    const dev = base ? Math.abs(r.pierceTotal - base) / base : null
    log(`${weaponId}: 嵌枪 ${r.pierceTotal}（玩家可见 ${r.pierceVisible}）· 相交臂三角 ${r.intersectTris}（可见 ${r.intersectVisible}，对 ${r.diag.intersectPairs}＝穿透 ${r.diag.intersectPairs - r.diag.touchPairs - r.diag.coplanarPairs}/点触 ${r.diag.touchPairs}/共面 ${r.diag.coplanarPairs}，最深交线 ${r.diag.intersectMaxSegMm}mm，遮挡比 min ${r.diag.midOccMin ?? '∞'} / 贴面级 ${r.diag.midOccNear1}）· 指尖最小 ${r.fingertipMinMm}mm · 腕锚误差 ${r.wristErrMm}mm · 手尺 ${r.handScaleCm}cm · 蒙皮 ${r.diag.armVerts} 顶点/枪 ${r.diag.gunVerts} 顶点 ${r.diag.gunTris} 三角 · 截图 ${shotPath} · 对基线 ${base} 偏差 ${(dev * 100).toFixed(0)}%`)
    results.push({ weapon: weaponId, ...r })
  }

  // ---- 截图校验（宽 ≥1280 + sharp 非空白：任一通道 stdev > 2）----
  for (const { weapon } of results) {
    const p = path.join(SHOTS, `${weapon}.png`)
    const meta = await sharp(p).metadata()
    if (meta.width < 1280) throw new Error(`${p} 宽 ${meta.width} < 1280`)
    const stats = await sharp(p).stats()
    const stdev = Math.max(...stats.channels.map((c) => c.stdev))
    if (stdev <= 2) throw new Error(`${p} 疑似空白（最大通道 stdev ${stdev}）`)
    log(`截图校验 ${weapon}.png：${meta.width}×${meta.height}，通道最大 stdev ${stdev.toFixed(1)}（非空白）`)
  }

  const json = {
    weapons: results.map(({ weapon, pierceTotal, pierceVisible, intersectTris, intersectVisible,
                            fingertipMinMm, wristErrMm, handScaleCm }) =>
      ({ weapon, pierceTotal, pierceVisible, intersectTris, intersectVisible,
         fingertipMinMm, wristErrMm, handScaleCm })),
  }
  fs.writeFileSync(OUT, JSON.stringify(json, null, 2) + '\n')
  log(`JSON 已写入 ${OUT}`)
} finally {
  try { await browser.close() } catch { /* 已关 */ }
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
  log('清理完成：browser 已关，vite 进程组已终止')
}
