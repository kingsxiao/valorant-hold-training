// 头部姿态看门狗：自然波次跑 N 秒，逐 tick 监控每只 bot 的头骨世界俯仰/高度，
// 捕获「头朝下」时刻（存活态头高 < 0.95m 或头俯仰偏离该 bot 站姿基线 >25°），
// 记录完整动画层状态；每 0.4s 截图并行记录状态索引，事后按时间戳对齐复现。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'

const RUN_SECONDS = 75
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:5213/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 8000 })

const setup = await page.evaluate(async () => {
  const g = window.__game
  // 等池建满（自然波次逐步建池至 4）
  let last = -1, stable = 0
  for (let i = 0; i < 300; i++) {
    const n = g.bots.bots.filter(x => x._officialLo).length
    if (n === last && n >= 4) { if (++stable >= 8) break } else stable = 0
    last = n
    await new Promise(r => setTimeout(r, 250))
  }
  g.bots.roundEndAt = 0
  g.bots.countdownUntil = 0
  return { pool: last }
})
console.log('pool:', JSON.stringify(setup))

// 看门狗注入 + 自然波次采样
await page.evaluate(() => {
  const g = window.__game
  window.__wd = { events: [], frames: [], t0: performance.now() }
  const origStep = g.bots.step.bind(g.bots)
  const findHead = (m) => { let h = null; m.traverse(o => { if (!h && o.isBone && /^Head_\d+$/.test(o.name)) h = o }); return h }
  const heads = new Map() // mesh -> headBone + 基线
  g.bots.step = (dt, alpha) => {
    origStep(dt, alpha)
    for (const b of g.bots.bots) {
      if (!b._officialLo || (!b.active && b.mode !== 'dying')) continue
      let rec = heads.get(b.mesh)
      if (!rec) {
        const h = findHead(b.mesh)
        if (!h) continue
        rec = { h, base: null }
        heads.set(b.mesh, rec)
      }
      rec.h.updateWorldMatrix(true, false)
      const e = rec.h.matrixWorld.elements
      const upDeg = Math.acos(Math.max(-1, Math.min(1, e[5]))) * 180 / Math.PI
      const hy = e[13]
      // 基线：站定存活态的头俯仰（首次见到 alive+非dying 记）
      if (rec.base === null && b.mode === 'peek' && Math.abs(b.velX) < 0.5) rec.base = upDeg
      const dev = rec.base !== null ? upDeg - rec.base : 0
      const alive = b.mode !== 'dying' && b.mode !== 'corpse'
      const lowHead = alive && hy < 0.95
      const tilt = alive && rec.base !== null && Math.abs(dev) > 25
      if (lowHead || tilt) {
        const A = b.anim
        const w = { mode: b.mode, hero: A.walk.getClip().name.split('-')[0], headY: +hy.toFixed(2),
          upDeg: +upDeg.toFixed(1), dev: +dev.toFixed(1), velX: +(b.velX ?? 0).toFixed(1),
          flinch: +(b.flinch ?? 0).toFixed(2), kick: +(b.gun?.kick ?? 0).toFixed(2),
          turnKey: b._turnKey ?? null, turnW: +(b._turnW ?? 0).toFixed(2), braceW: +(b._braceW ?? 0).toFixed(2),
          jumpW: +(b._jumpW ?? 0).toFixed(2), crouchW: +(b._crouchW ?? 0).toFixed(2),
          peek: b.peek ? { style: b.peek.style, phase: b.peek.phase ?? '-', cw: !!b.peek.crouchWalk, jig: !!b.peek.jiggleAt } : null,
          wts: { idle: +(A.idle?.getEffectiveWeight() ?? 0).toFixed(2), walkN: +A.walk.getEffectiveWeight().toFixed(2),
            runN: +(A.run?.getEffectiveWeight() ?? 0).toFixed(2), sE: 0, sW: 0 } }
        if (A.strafe) for (const s of ['E', 'W']) w.wts['s' + s] = +(A.strafe[s].walk.getEffectiveWeight() + A.strafe[s].run.getEffectiveWeight()).toFixed(2)
        if (A.turn) for (const [k, a] of Object.entries(A.turn)) if (a.getEffectiveWeight() > 0.01) w.wts['turn_' + k] = +a.getEffectiveWeight().toFixed(2)
        if (A.stopAdd && (b._braceW ?? 0) > 0.01) w.wts.brace = +A.stopAdd.getEffectiveWeight().toFixed(2)
        if (A.runAdd) for (const [k, a] of Object.entries(A.runAdd)) if (a.getEffectiveWeight() > 0.01) w.wts['add_' + k] = +a.getEffectiveWeight().toFixed(2)
        if (A.jump) w.wts.jump = +A.jump.getEffectiveWeight().toFixed(2)
        if (A.crouchIdle) w.wts.crIdle = +A.crouchIdle.getEffectiveWeight().toFixed(2)
        if (A.crouchWalk) for (const s of ['E', 'W']) if (A.crouchWalk[s]) w.wts['cw' + s] = +A.crouchWalk[s].getEffectiveWeight().toFixed(2)
        window.__wd.events.push({ at: +(performance.now() - window.__wd.t0).toFixed(0), ...w })
      }
    }
  }
})

// 截图循环（Node 侧，0.4s 一张，时间戳用页面钟与事件对齐）
const shotIdx = []
const shooter = (async () => {
  for (let i = 0; i < RUN_SECONDS / 0.4; i++) {
    await page.waitForTimeout(400)
    const at = await page.evaluate(() => +(performance.now() - window.__wd.t0).toFixed(0))
    await page.screenshot({ path: `/tmp/headwatch/f${String(i).padStart(4, '0')}.png` })
    shotIdx.push({ i, at })
  }
})()
await page.waitForTimeout(RUN_SECONDS * 1000)
const events = await page.evaluate(() => window.__wd.events)
// 聚合：同状态事件太多 → 按 (hero,mode,turnKey,peek) 归并计数
const agg = new Map()
for (const e of events) {
  const k = `${e.hero}|${e.mode}|${e.turnKey}|${e.peek?.style}/${e.peek?.phase}|cw=${e.peek?.cw}|headY=${e.headY}|dev=${e.dev}|fl=${e.flinch}|kk=${e.kick}|${JSON.stringify(e.wts)}`
  if (!agg.has(k)) agg.set(k, { n: 0, first: e.at, ...e })
  agg.get(k).n++
}
console.log('shots:', JSON.stringify(shotIdx.slice(0, 3)), '... total', shotIdx.length)
console.log('events total:', events.length)
for (const v of [...agg.values()].sort((a, b) => b.n - a.n).slice(0, 20)) console.log(JSON.stringify(v))
await shooter
await browser.close()
