// 受控滑速探针：清场 + 手动恒速驱动，逐 tick 采样双脚世界位，统计支撑脚
// （世界 y<0.21）沿移动轴速度与体速之差 = 真实滑步率。
// 用法：node scripts/probe-slide.mjs
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:5213/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
await page.waitForTimeout(1000)

const out = await page.evaluate(async () => {
  const g = window.__game
  // 英雄偏好（审计 #4）：池随机英雄的骨段长/锚-髋几何逐英雄一致（四英雄同骨架，
  // 离线 FK 实测 reach 全等 1.0621），英雄级方差次要。⚠ 上轮 `find(sova)` 硬钉定
  // 是探针不可用根因之一：池固定，掷不出 sova 就 80s 空转 + {err:'no bot'}——改为
  // 优先 sova、缺失立即回退第一只官方 bot，实际英雄写入每行输出供跨轮比对
  let b = null
  for (let i = 0; i < 400 && !b; i++) {
    const pool = (g.bots.bots ?? []).filter(x => x._officialLo)
    b = pool.find(x => x.heroKey === 'sova') ?? pool[0] ?? null
    if (!b) await new Promise(r => setTimeout(r, 200))
  }
  if (!b) return { err: 'no bot' }
  const HERO = b.heroKey ?? 'unknown'
  g.bots.roundEndAt = 0; g.bots.countdownUntil = 0
  if (g.bots.hold) for (const s of g.bots.hold.slots) { s.nextAt = 1e18; s.bot = null }
  for (const x of g.bots.bots) if (x !== b && x.active) x.hide()
  const dt = 1 / 128
  // 玩家侧放远点，pull 朝向稳定为正对（yaw 恒定不穿越）
  const px = g.player.pos.x, pz = g.player.pos.z

  // vx 默认 0：N 场景只传 vz（vz 驱动、横移分量为 0）——undefined 会经
  // groundStep(·, undefined, …) 的 st·max(|undefined|=NaN, …) = 0·NaN 在首 tick
  // 把 velX/pos.x 打成 NaN（锚权→0、脚矩阵→NaN、支撑相样本=0，med.toFixed 崩）
  const run = (tag, { style, vx = 0, vz = 0, sec = 3, crouchWalk = false }) => {
    // 垂直几何：bot 与玩家同 x（正前方）。横移场景运动 ±x = 纯横移（真实 peek
    // 波几何；斜摆会让横移锚只能抵消横向分量，测出假滑步——162 轮起 cross 也
    // 面向玩家，同样受此几何约束）。N 场景（vz≠0）运动沿 ±z = 纯前后（审计
    // #4：style='cross' 会拉起 _strafeW 播 E/W 横移 clip，runN/walkN 官方 N 族
    // 从未被活体测量——N 场景改用非横移 style（strafeRampW 对未知 style 返 0
    // → N 族权重）+ vz 驱动，运动轴与锚扫轴（mesh z=−psa x）对齐后锚世界静止）
    b.place(px, pz - 6, 'peek')
    b.peek = { style, dir: Math.sign(vx || vz), phase: 'out', startX: b.pos.x,
      endX: b.pos.x + Math.sign(vx || vz) * 60, stopAt: 1, stopped: false, stopUntil: 0,
      holdX: b.pos.x, resolved: true, jiggleAt: 0, crouchWalk, jumpPlanned: false, jumped: false }
    b._reachClampN = 0 // D2 钳制触发率探针：逐场景清零
    b._pinDbg = null // 钉地状态机诊断（下一 tick 重建计数）：逐场景清零
    const warm = Math.round(1.2 / dt)
    // 面向 = 运动方向（N 场景顺跑向；横移场景正对玩家 yaw=0）。2026-09-29 畸形
    // r1：锚前轴修正为 +psa.x 后，N 场景若仍 yaw=0 + vz<0 = 逆跑向倒放（锚与
    // 腿链 FK 反向，支撑末 dH 拉出可达域=假病理）——面向运动方向才是 runN/
    // walkN 的官方消费几何（walkout 波沿跑向同款）；预热期即锁定防测量窗开头
    // 的换向瞬态
    const faceYaw = vz < 0 ? Math.PI : 0
    for (let i = 0; i < warm; i++) { b.moveToward(vx, dt, vz); g.bots.step(dt, 1); b.mesh.rotation.y = faceYaw; g.bots.step(0, 1) }
    const rows = []
    const N = Math.round(sec / dt)
    for (let i = 0; i < N; i++) {
      b.moveToward(vx, dt, vz)
      g.bots.step(dt, 1)
      // 锁面向：横移场景正对（玩家在 +z，GLB 正面 +Z ⇒ 正对 yaw=0（164 轮）；
      // 远离玩家后朝向 lerp 会把横移扭成斜向，测出假滑步）；N 场景顺跑向（见上）
      b.mesh.rotation.y = faceYaw; g.bots.step(0, 1)
      b.mesh.updateMatrixWorld(true)
      const row = { v: b.velX }
      for (const leg of b._strafeRig.legs) {
        leg.foot.updateWorldMatrix(true, false)
        const e = leg.foot.matrixWorld.elements
        row[leg.side] = { x: e[12], y: e[13], z: e[14] }
      }
      rows.push(row)
    }
    // 支撑脚滑速：低脚（y<0.14）沿运动轴的速度 − 体速
    const axis = vz !== 0 ? 'z' : 'x'
    const slides = []
    for (let i = 1; i < rows.length; i++) {
      for (const s of ['L', 'R']) {
        if (rows[i][s].y < 0.14 && rows[i - 1][s].y < 0.14) { // 官方触地平台 0.123-0.125；0.21 会把摆动脚过地带帧算进来
          slides.push(Math.abs((rows[i][s][axis] - rows[i - 1][s][axis]) / dt)) // 支撑脚自身世界速度：0=完美钉住
        }
      }
    }
    slides.sort((a, c) => a - c)
    const trim = slides.slice(Math.floor(slides.length * 0.1), Math.floor(slides.length * 0.9))
    // 空样本防护：双脚全程离地（异常态）时 trim 空 → NaN.toFixed 输出 null 废门，
    // 保险回 0 并以 stanceFrames=0 显形
    const mean = trim.length ? trim.reduce((a, v) => a + v, 0) / trim.length : 0
    const med = trim.length ? trim[Math.floor(trim.length / 2)] : 0
    // D2 硬判停②的分量（近似口径，与审计探针同族）：
    //  bothAir  = 双踝同步腾空（y>0.25m）tick 占比（官方 runN 0% / strafe ≤8%）
    //  hoverPct = 贴地悬停带（平台+2cm~+6cm，既非钉地也非真摆动弧）tick 占比
    //             （审计修前支撑相悬空 29~33% → 门 <5%）
    //  liftMax  = 支撑相（y<0.16）单脚近地带（≤平台+10cm）内最大抬升（蹬地提
    //             踵口径，门 ≤4cm）。审计 #10：整窗口径下摆动弧自然填满 10cm
    //             计量带、门不可判（基准卡 ⚠ 注同此结论——须限支撑相 tick 才
    //             与门同口径）。2026-09-29 量程放宽 y<0.14→0.16：提踵目标帽
    //             yCap=平台+3.2cm≈0.157 世界高，旧 0.14 窗把提踵弧顶裁掉——
    //             计量口径修正（探针量程，非门值；门 ≤4cm 不动）
    const plat = { L: 9, R: 9 }
    for (const r of rows) for (const s of ['L', 'R']) plat[s] = Math.min(plat[s], r[s].y)
    let both = 0, hover = 0
    const liftMax = { L: 0, R: 0 }
    for (const r of rows) {
      if (r.L.y > 0.25 && r.R.y > 0.25) both++
      for (const s of ['L', 'R']) {
        const h = r[s].y - plat[s]
        if (h > 0.02 && h <= 0.06) hover++
        if (r[s].y < 0.16 && h > 0.02 && h <= 0.10) liftMax[s] = Math.max(liftMax[s], h)
      }
    }
    // 诊断字段（163 轮）：门比较器只读上列字段，以下为 bothAir/hover 残余病理的
    // live 地面真值——脚高范围（钉固是否真的把脚放回平台）、髋世界高范围（锚-髋
    // 几何的可达性边界）、缩放、状态机 leg-tick 分布
    const fy = { L: [9, -9], R: [9, -9] }
    for (const r of rows) for (const s of ['L', 'R']) {
      if (r[s].y < fy[s][0]) fy[s][0] = r[s].y
      if (r[s].y > fy[s][1]) fy[s][1] = r[s].y
    }
    const dbg = b._pinDbg ?? {}
    return { tag, hero: HERO, side: b._strafeSide, v: +Math.abs(vx || vz).toFixed(2),
      stanceFrames: slides.length, slideMean: +mean.toFixed(2), slideMed: +med.toFixed(2),
      slideP90: +trim[Math.floor(trim.length * 0.9)].toFixed(2),
      bothAirPct: +(100 * both / rows.length).toFixed(1),
      hoverPct: +(100 * hover / (rows.length * 2)).toFixed(1),
      liftMax: { L: +liftMax.L.toFixed(3), R: +liftMax.R.toFixed(3) },
      clampN: b._reachClampN ?? 0,
      dbg: { heroScale: +(b._heroScale ?? 0).toFixed(4),
        footY: { L: [+fy.L[0].toFixed(3), +fy.L[1].toFixed(3)], R: [+fy.R[0].toFixed(3), +fy.R[1].toFixed(3)] },
        hipY: [+(dbg.hipMin ?? 0).toFixed(3), +(dbg.hipMax ?? 0).toFixed(3)],
        states: { latch: dbg.latch ?? 0, lift: dbg.lift ?? 0, loose: dbg.loose ?? 0, swing: dbg.swing ?? 0, heel: dbg.heel ?? 0 } } }
  }
  return [
    run('runN@5.4', { style: 'N', vz: -5.4 }),
    run('walkN@3.0', { style: 'N', vz: -3.0 }),
    run('strafe@5.4(拉右)', { style: 'pull', vx: 5.4 }),
    run('strafe@5.4(拉左)', { style: 'pull', vx: -5.4 }),
    run('crouchWalk@2.7', { style: 'pull', vx: 2.7, crouchWalk: true }),
  ]
})
console.log(JSON.stringify(out, null, 1))
await browser.close()
console.log('DONE')
