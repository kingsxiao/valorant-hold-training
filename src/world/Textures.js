import * as THREE from 'three'

// ============================================================================
// 程序化 PBR 纹理库 v2（全部运行时生成，无外部素材）
// 每种材质 = 颜色贴图(SRGB) + 粗糙度贴图 + 法线贴图（由高度图 Sobel 转换）
// 纹理按名称缓存为单例；需要独立淡出/闪白的对象用 material.clone() 共享纹理
// v2：主材质升至 1024²、金属/地面/墙面细节大幅增强；
//     新增 聚合物/弹孔/火花/烟雾/冲击波环/面罩辉光/警示条纹 贴图（特效与识别用）
// ============================================================================

function canvas(size) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return c
}

function toTex(c, { srgb = false, repeat = null, anisotropy = 4 } = {}) {
  const t = new THREE.CanvasTexture(c)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  if (repeat) t.repeat.set(repeat[0], repeat[1])
  t.anisotropy = anisotropy
  return t
}

// ---- 通用笔刷 ----
function noise(g, size, alpha = 0.05, count = 1200, w = 2) {
  for (let i = 0; i < count; i++) {
    const v = Math.random() > 0.5 ? 255 : 0
    g.fillStyle = `rgba(${v},${v},${v},${Math.random() * alpha})`
    g.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * w, 1 + Math.random() * w)
  }
}

function scratches(g, size, count, color = 'rgba(255,255,255,0.08)') {
  for (let i = 0; i < count; i++) {
    g.strokeStyle = color
    g.lineWidth = Math.random() * 1.2 + 0.3
    const x = Math.random() * size, y = Math.random() * size
    const a = Math.random() * Math.PI * 2, l = 4 + Math.random() * 30
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke()
  }
}

function stitches(g, x, y, w, color = 'rgba(255,255,255,0.16)') {
  g.strokeStyle = color; g.lineWidth = 1.5
  g.setLineDash([4, 3])
  g.strokeRect(x, y, w[0], w[1])
  g.setLineDash([])
}

// 软边污渍斑（径向渐变）
function blotch(g, x, y, r, rgba0) {
  const rg = g.createRadialGradient(x, y, 0, x, y, r)
  rg.addColorStop(0, rgba0)
  rg.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = rg
  g.fillRect(x - r, y - r, r * 2, r * 2)
}

// ---- 高度图 → 法线图（Sobel，行索引外提的热循环版）----
// 数学与朴素实现完全一致（周期边界、R 通道为高度），仅去掉逐像素取模/函数调用
export function heightToNormal(hCanvas, strength = 2) {
  const size = hCanvas.width
  const src = hCanvas.getContext('2d').getImageData(0, 0, size, size).data
  const out = canvas(size)
  const octx = out.getContext('2d')
  const img = octx.createImageData(size, size)
  const d = img.data
  const k = strength / 255 // 朴素实现中 H() 归一到 [0,1]，此处并入系数
  for (let y = 0; y < size; y++) {
    const row = y * size
    const rowUp = ((y - 1 + size) % size) * size
    const rowDn = ((y + 1) % size) * size
    for (let x = 0; x < size; x++) {
      const colL = (x - 1 + size) % size
      const colR = (x + 1) % size
      const dx = (src[(row + colL) * 4] - src[(row + colR) * 4]) * k
      const dy = (src[(rowUp + x) * 4] - src[(rowDn + x) * 4]) * k
      const inv = 1 / Math.hypot(dx, dy, 1)
      const i = (row + x) * 4
      d[i] = (-dx * inv * 0.5 + 0.5) * 255
      d[i + 1] = (-dy * inv * 0.5 + 0.5) * 255
      d[i + 2] = (inv * 0.5 + 0.5) * 255
      d[i + 3] = 255
    }
  }
  octx.putImageData(img, 0, 0)
  return out
}

// 成对生成：颜色 + 高度（高度用于转法线）
function pair(size, draw) {
  const color = canvas(size), height = canvas(size)
  const cg = color.getContext('2d'), hg = height.getContext('2d')
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, size, size)
  draw(cg, hg, size)
  return { color, height }
}

// ============================================================================
// 材质纹理定义
// ============================================================================
const cache = {}

function get(name, build) {
  return cache[name] ??= build()
}

// ---- 战术服织物（人物全身）----
const suit = () => get('suit', () => {
  const { color, height } = pair(512, (cg, hg, s) => {
    cg.fillStyle = '#39414e'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 细织物纹（双向）
    for (let y = 0; y < s; y += 3) {
      cg.fillStyle = 'rgba(255,255,255,0.05)'; cg.fillRect(0, y, s, 1)
      hg.fillStyle = 'rgba(255,255,255,0.10)'; hg.fillRect(0, y, s, 1)
    }
    for (let x = 0; x < s; x += 3) {
      cg.fillStyle = 'rgba(0,0,0,0.06)'; cg.fillRect(x, 0, 1, s)
      hg.fillStyle = 'rgba(0,0,0,0.10)'; cg.fillRect(x, 0, 1, s)
    }
    // 低对比数码迷彩块（打散大色块）
    for (let i = 0; i < 46; i++) {
      const bx = Math.random() * s, by = Math.random() * s, bs = 10 + Math.random() * 34
      cg.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(10,14,20,0.06)'
      cg.fillRect(bx, by, bs, bs * (0.5 + Math.random()))
    }
    // 衣板拼块 + 双缝线
    const panels = [[24, 40, 220, 180], [270, 40, 218, 180], [24, 250, 220, 220], [270, 250, 218, 220]]
    for (const [x, y, w, h] of panels) {
      cg.strokeStyle = 'rgba(0,0,0,0.38)'; cg.lineWidth = 2.5
      cg.strokeRect(x, y, w, h)
      stitches(cg, x + 6, y + 6, [w - 12, h - 12])
      stitches(cg, x + 11, y + 11, [w - 22, h - 22], 'rgba(0,0,0,0.14)')
      hg.strokeStyle = 'rgba(0,0,0,0.5)'; hg.lineWidth = 3
      hg.strokeRect(x, y, w, h)
    }
    // 肘/膝加固块（微亮）
    cg.fillStyle = 'rgba(255,255,255,0.06)'
    cg.fillRect(60, 340, 150, 90); cg.fillRect(300, 340, 150, 90)
    hg.fillStyle = 'rgba(255,255,255,0.08)'
    hg.fillRect(60, 340, 150, 90); hg.fillRect(300, 340, 150, 90)
    // 臂章：红底白字
    cg.fillStyle = '#c8373f'; cg.fillRect(380, 80, 88, 44)
    cg.fillStyle = 'rgba(0,0,0,0.25)'; cg.fillRect(380, 80, 88, 8)
    cg.fillStyle = '#f2e6e0'; cg.font = 'bold 26px monospace'; cg.textAlign = 'center'
    cg.fillText('TR-07', 424, 112)
    hg.fillStyle = '#a0a0a0'; hg.fillRect(380, 80, 88, 44) // 布贴微凹
    // 条形码印字（装备编号）
    cg.fillStyle = 'rgba(230,235,240,0.5)'
    for (let x = 48; x < 150; x += 4) cg.fillRect(x, 448, 1 + Math.random() * 2, 26)
    cg.font = '12px monospace'; cg.textAlign = 'left'
    cg.fillText('RANGE-07-TRN', 48, 490)
    noise(cg, s, 0.05, 900)
    noise(hg, s, 0.06, 900)
  })
  return {
    map: toTex(color, { srgb: true }),
    roughnessMap: toTex(color), // 粗度直接复用颜色明度（近似）
    normalMap: toTex(heightToNormal(height, 1.6)),
  }
})

// ---- 护甲/背心（MOLLE 织带 + 弹匣袋 + 钢印）----
const vest = () => get('vest', () => {
  const { color, height } = pair(512, (cg, hg, s) => {
    cg.fillStyle = '#22262d'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // MOLLE 织带（凸起横带）
    for (let y = 14; y < s - 10; y += 42) {
      cg.fillStyle = '#2b3039'; cg.fillRect(8, y, s - 16, 22)
      cg.fillStyle = 'rgba(255,255,255,0.10)'; cg.fillRect(8, y, s - 16, 4)
      cg.fillStyle = 'rgba(0,0,0,0.45)'; cg.fillRect(8, y + 18, s - 16, 4)
      hg.fillStyle = '#9a9a9a'; hg.fillRect(8, y, s - 16, 22)
      hg.fillStyle = '#b5b5b5'; hg.fillRect(8, y, s - 16, 5)
    }
    // 斜挎带（对角，压在织带上）
    cg.strokeStyle = '#171a1f'; cg.lineWidth = 30
    cg.beginPath(); cg.moveTo(-20, s * 0.8); cg.lineTo(s * 0.75, -20); cg.stroke()
    cg.strokeStyle = 'rgba(255,255,255,0.08)'; cg.lineWidth = 3
    cg.beginPath(); cg.moveTo(-20, s * 0.8 - 13); cg.lineTo(s * 0.75, -20 - 13); cg.stroke()
    hg.strokeStyle = '#a5a5a5'; hg.lineWidth = 30
    hg.beginPath(); hg.moveTo(-20, s * 0.8); hg.lineTo(s * 0.75, -20); hg.stroke()
    // 三个弹匣袋（带袋盖 + 搭扣）
    const pouch = (x, y, w, h) => {
      cg.fillStyle = '#191c21'; cg.fillRect(x, y, w, h)
      cg.strokeStyle = 'rgba(0,0,0,0.6)'; cg.lineWidth = 3; cg.strokeRect(x, y, w, h)
      cg.fillStyle = '#232830'; cg.fillRect(x + 5, y + 5, w - 10, h * 0.42) // 袋盖
      cg.fillStyle = 'rgba(255,255,255,0.09)'; cg.fillRect(x + 5, y + 5, w - 10, 5)
      cg.fillStyle = '#3a3f48'; cg.fillRect(x + w / 2 - 9, y + h * 0.42, 18, 9) // 搭扣
      stitches(cg, x + 9, y + 9, [w - 18, h - 18])
      hg.fillStyle = '#b8b8b8'; hg.fillRect(x, y, w, h)
      hg.fillStyle = '#c8c8c8'; hg.fillRect(x + 5, y + 5, w - 10, h * 0.42)
      hg.strokeStyle = 'rgba(0,0,0,0.6)'; hg.lineWidth = 3; hg.strokeRect(x, y, w, h)
    }
    pouch(40, 60, 130, 110); pouch(200, 60, 130, 110); pouch(360, 60, 118, 110)
    pouch(40, 210, 200, 120); pouch(270, 210, 208, 120)
    // 红方识别魔术贴
    cg.fillStyle = '#c8373f'; cg.fillRect(196, 18, 120, 30)
    cg.fillStyle = '#f2e6e0'; cg.font = 'bold 22px monospace'; cg.textAlign = 'center'
    cg.fillText('ENEMY', 256, 40)
    hg.fillStyle = '#909090'; hg.fillRect(196, 18, 120, 30)
    // 钢印编号
    cg.fillStyle = 'rgba(255,255,255,0.30)'
    cg.font = 'bold 34px monospace'; cg.textAlign = 'left'
    cg.fillText('VC-22', 48, 420)
    cg.fillText('VC-22', 290, 470)
    // 磨损（织带边缘起毛发白）
    scratches(cg, s, 26, 'rgba(255,255,255,0.07)')
    blotch(cg, 120, 330, 46, 'rgba(0,0,0,0.16)')
    blotch(cg, 380, 300, 38, 'rgba(120,100,70,0.14)')
    noise(cg, s, 0.06, 800)
    noise(hg, s, 0.05, 500)
  })
  return {
    map: toTex(color, { srgb: true }),
    normalMap: toTex(heightToNormal(height, 2.4)),
  }
})

// ---- 面罩（曲面玻璃感）----
const visor = () => get('visor', () => {
  const c = canvas(256)
  const g = c.getContext('2d')
  const grad = g.createLinearGradient(0, 0, 256, 256)
  grad.addColorStop(0, '#0b1016'); grad.addColorStop(0.45, '#16242e'); grad.addColorStop(0.7, '#0c1218'); grad.addColorStop(1, '#0a0d11')
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256)
  // 宽斜反光带（两层）
  const band = (x0, a) => {
    g.fillStyle = `rgba(150,205,255,${a})`
    g.beginPath()
    g.moveTo(x0, 256); g.lineTo(x0 + 90, 0); g.lineTo(x0 + 150, 0); g.lineTo(x0 + 60, 256)
    g.closePath(); g.fill()
  }
  band(20, 0.20); band(130, 0.10)
  // 星形高光点
  for (const [x, y, r] of [[70, 70, 7], [180, 160, 5]]) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r)
    rg.addColorStop(0, 'rgba(255,255,255,0.9)'); rg.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2)
  }
  // 边框
  g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 10; g.strokeRect(0, 0, 256, 256)
  return { map: toTex(c, { srgb: true }) }
})

// ---- 面罩辉光层（自发光贴图：一条青色传感条 → 机器人敌意感）----
const visorGlow = () => get('visorGlow', () => {
  const c = canvas(128)
  const g = c.getContext('2d')
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 128)
  // 主传感条（带辉光渐变）
  const bar = g.createLinearGradient(0, 44, 0, 84)
  bar.addColorStop(0, 'rgba(0,60,80,0)'); bar.addColorStop(0.5, 'rgba(140,235,255,1)'); bar.addColorStop(1, 'rgba(0,60,80,0)')
  g.fillStyle = bar; g.fillRect(10, 44, 108, 40)
  // 两端收窄（更利落）
  g.fillStyle = '#000'
  g.fillRect(0, 30, 14, 68); g.fillRect(114, 30, 14, 68)
  // 中心亮点
  const dot = g.createRadialGradient(64, 64, 0, 64, 64, 12)
  dot.addColorStop(0, 'rgba(255,255,255,0.9)'); dot.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = dot; g.fillRect(52, 52, 24, 24)
  return toTex(c)
})

// ---- 拉丝工具钢（枪械主体 v2：1024² 面板缝 + 铆钉 + 断续丝纹 + 油渍）----
const metal = () => get('metal', () => {
  const { color, height } = pair(1024, (cg, hg, s) => {
    cg.fillStyle = '#31373f'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 拉丝（纵向细线）
    for (let x = 0; x < s; x += 2) {
      const a = Math.random() * 0.08
      cg.fillStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`
      cg.fillRect(x, 0, 1, s)
    }
    // 断续丝纹（长条擦痕，方向与拉丝一致）
    for (let i = 0; i < 110; i++) {
      const x = Math.random() * s, y = Math.random() * s, len = 24 + Math.random() * 110
      cg.fillStyle = `rgba(${188 + Math.random() * 44 | 0},${198 + Math.random() * 34 | 0},212,${0.03 + Math.random() * 0.06})`
      cg.fillRect(x, y, 1 + Math.random() * 1.6, len)
      hg.fillStyle = 'rgba(255,255,255,0.09)'
      hg.fillRect(x, y, 1.6, len)
    }
    // 面板拼缝（横两条 + 铆钉列）
    for (const py of [s * 0.34, s * 0.72]) {
      cg.strokeStyle = 'rgba(0,0,0,0.5)'; cg.lineWidth = 3
      cg.beginPath(); cg.moveTo(0, py); cg.lineTo(s, py); cg.stroke()
      cg.strokeStyle = 'rgba(255,255,255,0.13)'; cg.lineWidth = 1.4
      cg.beginPath(); cg.moveTo(0, py + 3.5); cg.lineTo(s, py + 3.5); cg.stroke()
      hg.strokeStyle = '#525252'; hg.lineWidth = 5
      hg.beginPath(); hg.moveTo(0, py); hg.lineTo(s, py); hg.stroke()
      for (let x = 48; x < s; x += 112) {
        cg.fillStyle = 'rgba(0,0,0,0.55)'; cg.beginPath(); cg.arc(x, py + 16, 5, 0, 7); cg.fill()
        cg.fillStyle = 'rgba(222,230,240,0.5)'; cg.beginPath(); cg.arc(x - 1.5, py + 14.5, 2.1, 0, 7); cg.fill()
        hg.fillStyle = '#ababab'; hg.beginPath(); hg.arc(x, py + 16, 5.5, 0, 7); hg.fill()
      }
    }
    scratches(cg, s, 80, 'rgba(205,215,228,0.10)')
    scratches(hg, s, 80, 'rgba(255,255,255,0.20)')
    // 边缘磨损亮块（磕碰露白）
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * s, y = Math.random() * s
      cg.fillStyle = `rgba(178,188,200,${0.10 + Math.random() * 0.12})`
      cg.fillRect(x, y, 5 + Math.random() * 26, 2 + Math.random() * 5)
    }
    // 油渍/指纹暗斑
    for (let i = 0; i < 12; i++) {
      blotch(cg, Math.random() * s, Math.random() * s, 20 + Math.random() * 44, 'rgba(12,14,18,0.14)')
    }
    noise(cg, s, 0.035, 1100)
  })
  return {
    map: toTex(color, { srgb: true }),
    roughnessMap: toTex(height),
    normalMap: toTex(heightToNormal(height, 0.7)),
  }
})

// ---- 枪械聚合物（下机匣/护木：细颗粒防滑纹 + 模具线 + 使用亮面）----
const polymer = () => get('polymer', () => {
  const { color, height } = pair(512, (cg, hg, s) => {
    cg.fillStyle = '#26292f'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 防滑颗粒（橘皮纹）
    for (let i = 0; i < 5200; i++) {
      const a = 0.05 + Math.random() * 0.09
      cg.fillStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`
      const r = 0.8 + Math.random() * 1.4
      cg.beginPath(); cg.arc(Math.random() * s, Math.random() * s, r, 0, 7); cg.fill()
    }
    noise(hg, s, 0.09, 2600, 1)
    // 模具分型线（竖向细槽）
    for (const x of [s * 0.5]) {
      cg.strokeStyle = 'rgba(0,0,0,0.4)'; cg.lineWidth = 2.5
      cg.beginPath(); cg.moveTo(x, 0); cg.lineTo(x, s); cg.stroke()
      hg.strokeStyle = '#5f5f5f'; hg.lineWidth = 3.5
      hg.beginPath(); cg.moveTo(x, 0); cg.lineTo(x, s); cg.stroke()
    }
    // 握持区磨亮（常用处聚合物发亮）
    for (let i = 0; i < 8; i++) {
      blotch(cg, Math.random() * s, Math.random() * s, 26 + Math.random() * 50, 'rgba(255,255,255,0.05)')
    }
    scratches(cg, s, 16, 'rgba(255,255,255,0.05)')
  })
  return {
    map: toTex(color, { srgb: true }),
    roughnessMap: toTex(height),
    normalMap: toTex(heightToNormal(height, 0.9)),
  }
})

// ---- 木纹（护木/握把/枪托/木箱）----
const wood = () => get('wood', () => {
  const { color, height } = pair(512, (cg, hg, s) => {
    cg.fillStyle = '#54402a'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 波浪木纹
    for (let x = 0; x < s; x += 4) {
      const a = 0.05 + Math.random() * 0.1
      cg.strokeStyle = Math.random() > 0.5 ? `rgba(30,20,10,${a})` : `rgba(200,170,120,${a * 0.7})`
      cg.lineWidth = 1 + Math.random() * 1.6
      cg.beginPath()
      for (let y = 0; y <= s; y += 8) {
        const xx = x + Math.sin(y * 0.02 + x * 0.05) * 5
        y === 0 ? cg.moveTo(xx, y) : cg.lineTo(xx, y)
      }
      cg.stroke()
      hg.fillStyle = 'rgba(0,0,0,0.10)'; hg.fillRect(x, 0, 1, s)
    }
    // 两个木节
    for (const [kx, ky] of [[140, 140], [360, 350]]) {
      const rg = cg.createRadialGradient(kx, ky, 2, kx, ky, 34)
      rg.addColorStop(0, 'rgba(25,15,8,0.85)'); rg.addColorStop(0.4, 'rgba(60,42,24,0.5)'); rg.addColorStop(1, 'rgba(0,0,0,0)')
      cg.fillStyle = rg; cg.fillRect(kx - 36, ky - 36, 72, 72)
      hg.fillStyle = 'rgba(0,0,0,0.5)'; hg.fillRect(kx - 8, ky - 8, 16, 16)
    }
    // 清漆光泽（粗糙度扰动）
    scratches(cg, s, 18, 'rgba(255,240,210,0.05)')
    noise(cg, s, 0.04, 400)
  })
  return {
    map: toTex(color, { srgb: true }),
    normalMap: toTex(heightToNormal(height, 1.2)),
  }
})

// ---- 地面 v2（1024² 水磨石大板：骨料双色调 + 磨亮走道 + 裂纹）----
const floor = () => get('floor', () => {
  const { color, height } = pair(1024, (cg, hg, s) => {
    cg.fillStyle = '#a79c8b'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 四块大板（2m 一格的砖缝）
    for (const [x, y] of [[0, 0], [512, 0], [0, 512], [512, 512]]) {
      cg.fillStyle = `rgba(${148 + Math.random() * 26 | 0},${138 + Math.random() * 24 | 0},${122 + Math.random() * 22 | 0},0.5)`
      cg.fillRect(x + 7, y + 7, 498, 498)
      hg.fillStyle = `rgba(${118 + Math.random() * 44 | 0},${118 + Math.random() * 44 | 0},${118 + Math.random() * 44 | 0},0.6)`
      hg.fillRect(x + 7, y + 7, 498, 498)
    }
    // 骨料斑点（水磨石：灰 + 暖 + 少量深色大理石屑）
    for (let i = 0; i < 9000; i++) {
      const warm = Math.random()
      let r, g2, b
      if (warm < 0.72) { const v = 96 + Math.random() * 128 | 0; r = v; g2 = v - 8; b = v - 18 }
      else if (warm < 0.92) { r = 150 + Math.random() * 60 | 0; g2 = 120 + Math.random() * 40 | 0; b = 84 + Math.random() * 30 | 0 }
      else { const v = 52 + Math.random() * 40 | 0; r = v; g2 = v; b = v + 6 }
      cg.fillStyle = `rgba(${r},${g2},${b},${0.28 + Math.random() * 0.32})`
      cg.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 3)
    }
    noise(hg, s, 0.12, 6000, 1)
    // 中央走道磨亮（常用路径抛光 → 粗糙度更低）
    const wear = cg.createLinearGradient(0, s * 0.28, 0, s * 0.72)
    wear.addColorStop(0, 'rgba(255,250,240,0)'); wear.addColorStop(0.5, 'rgba(255,250,240,0.10)'); wear.addColorStop(1, 'rgba(255,250,240,0)')
    cg.fillStyle = wear; cg.fillRect(0, s * 0.28, s, s * 0.44)
    // 发丝裂纹（两三条随机折线）
    for (let i = 0; i < 3; i++) {
      let x = Math.random() * s, y = Math.random() * s
      cg.strokeStyle = 'rgba(70,62,52,0.4)'; cg.lineWidth = 1
      cg.beginPath(); cg.moveTo(x, y)
      for (let k = 0; k < 14; k++) {
        x += (Math.random() - 0.5) * 46; y += (Math.random() - 0.3) * 30
        cg.lineTo(x, y)
      }
      cg.stroke()
    }
    // 砖缝（凹槽）
    cg.strokeStyle = 'rgba(48,44,38,0.75)'; cg.lineWidth = 6
    for (const p of [0, 512, 1024]) {
      cg.beginPath(); cg.moveTo(p, 0); cg.lineTo(p, s); cg.stroke()
      cg.beginPath(); cg.moveTo(0, p); cg.lineTo(s, p); cg.stroke()
    }
    hg.strokeStyle = '#404040'; hg.lineWidth = 9
    for (const p of [0, 512, 1024]) {
      hg.beginPath(); hg.moveTo(p, 0); hg.lineTo(p, s); hg.stroke()
      hg.beginPath(); hg.moveTo(0, p); hg.lineTo(s, p); hg.stroke()
    }
    // 污渍/胎痕
    for (let i = 0; i < 14; i++) {
      blotch(cg, Math.random() * s, Math.random() * s, 26 + Math.random() * 80, 'rgba(60,54,46,0.18)')
    }
    scratches(cg, s, 44, 'rgba(70,62,52,0.14)')
  })
  return {
    map: toTex(color, { srgb: true, anisotropy: 8 }),
    roughnessMap: toTex(height, { anisotropy: 4 }),
    normalMap: toTex(heightToNormal(height, 1.8), { anisotropy: 4 }),
  }
})

// ---- 墙面 v2（1024² 砂浆板缝 + 腰线 + 流挂 + 裂纹与磕碰）----
const wall = () => get('wall', () => {
  const { color, height } = pair(1024, (cg, hg, s) => {
    cg.fillStyle = '#c3b5a0'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 砂浆颗粒
    for (let i = 0; i < 11000; i++) {
      const a = 0.05 + Math.random() * 0.08
      cg.fillStyle = Math.random() > 0.5 ? `rgba(255,250,240,${a})` : `rgba(90,80,66,${a})`
      cg.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2)
    }
    noise(hg, s, 0.10, 7000, 1)
    // 面板分缝（每 4m 一条 + 缝内高光）
    for (const x of [0, 512]) {
      cg.strokeStyle = 'rgba(70,62,50,0.55)'; cg.lineWidth = 5
      cg.beginPath(); cg.moveTo(x, 0); cg.lineTo(x, s); cg.stroke()
      cg.strokeStyle = 'rgba(255,250,240,0.16)'; cg.lineWidth = 1.6
      cg.beginPath(); cg.moveTo(x + 4, 0); cg.lineTo(x + 4, s); cg.stroke()
      hg.strokeStyle = '#4a4a4a'; hg.lineWidth = 8
      hg.beginPath(); cg.moveTo(x, 0); hg.lineTo(x, s); hg.stroke()
    }
    // 腰线（青绿漆带，带漆面流淌）
    cg.fillStyle = '#3d7068'; cg.fillRect(0, s * 0.70, s, s * 0.062)
    cg.fillStyle = 'rgba(255,255,255,0.10)'; cg.fillRect(0, s * 0.70, s, 6)
    cg.fillStyle = 'rgba(0,0,0,0.18)'; cg.fillRect(0, s * 0.70 + s * 0.062 - 6, s, 6)
    hg.fillStyle = '#8a8a8a'; hg.fillRect(0, s * 0.70, s, s * 0.062)
    for (let i = 0; i < 20; i++) { // 漆面流挂
      const x = Math.random() * s
      cg.fillStyle = 'rgba(40,80,74,0.20)'
      cg.fillRect(x, s * 0.70 + s * 0.062, 3 + Math.random() * 5, 14 + Math.random() * 60)
    }
    // 顶部雨水渍（从上往下的扇形淡痕）
    for (let i = 0; i < 10; i++) {
      const x = Math.random() * s
      const gg = cg.createLinearGradient(0, 0, 0, s * (0.2 + Math.random() * 0.3))
      gg.addColorStop(0, 'rgba(96,86,70,0.22)'); gg.addColorStop(1, 'rgba(96,86,70,0)')
      cg.fillStyle = gg
      cg.save(); cg.translate(x, 0); cg.rotate(0.04 * (Math.random() - 0.5))
      cg.fillRect(-14, 0, 28, s * 0.4); cg.restore()
    }
    // 底部泛潮 + 磕碰露底
    const gg2 = cg.createLinearGradient(0, s * 0.8, 0, s)
    gg2.addColorStop(0, 'rgba(80,72,58,0)'); gg2.addColorStop(1, 'rgba(80,72,58,0.35)')
    cg.fillStyle = gg2; cg.fillRect(0, s * 0.8, s, s * 0.2)
    for (let i = 0; i < 8; i++) {
      const x = Math.random() * s, y = s * (0.1 + Math.random() * 0.55)
      cg.fillStyle = 'rgba(150,132,108,0.5)'
      cg.beginPath(); cg.arc(x, y, 3 + Math.random() * 8, 0, 7); cg.fill()
    }
  })
  return {
    map: toTex(color, { srgb: true, anisotropy: 8 }),
    normalMap: toTex(heightToNormal(height, 1.4), { anisotropy: 4 }),
  }
})

// ---- 木箱（板条 + 铁角 + 钢印）----
const crate = () => get('crate', () => {
  const { color, height } = pair(512, (cg, hg, s) => {
    // 六块木板
    for (let i = 0; i < 6; i++) {
      const y = i * (s / 6)
      const tone = 118 + (i % 2) * 16 + Math.random() * 10
      cg.fillStyle = `rgb(${tone + 30},${tone - 8},${tone - 42})`
      cg.fillRect(0, y, s, s / 6)
      // 板内木纹
      for (let x = 0; x < s; x += 5) {
        cg.strokeStyle = `rgba(60,40,20,${0.06 + Math.random() * 0.08})`
        cg.lineWidth = 1 + Math.random()
        cg.beginPath()
        for (let yy = y; yy <= y + s / 6; yy += 6) {
          const xx = x + Math.sin(yy * 0.03 + x) * 2
          yy === y ? cg.moveTo(xx, yy) : cg.lineTo(xx, yy)
        }
        cg.stroke()
      }
      // 板缝
      cg.fillStyle = 'rgba(30,20,10,0.7)'; cg.fillRect(0, y + s / 6 - 4, s, 4)
      hg.fillStyle = '#5a5a5a'; hg.fillRect(0, y + s / 6 - 4, s, 4)
      hg.fillStyle = `rgb(${128 + (i % 2) * 20},${128 + (i % 2) * 20},${128 + (i % 2) * 20})`
      hg.fillRect(0, y, s, s / 6 - 4)
    }
    // 铁角（四角 L 形支架 + 铆钉）
    const bracket = (x, y, sx, sy) => {
      cg.fillStyle = '#3a3f45'; cg.fillRect(x, y, 74 * sx, 20); cg.fillRect(x, y, 20, 74 * sy)
      cg.fillStyle = 'rgba(255,255,255,0.10)'; cg.fillRect(x, y, 74 * sx, 4); cg.fillRect(x, y, 4, 74 * sy)
      hg.fillStyle = '#c0c0c0'; hg.fillRect(x, y, 74 * sx, 20); hg.fillRect(x, y, 20, 74 * sy)
      for (const [rx, ry] of [[x + 10, y + 10], [x + 58 * sx, y + 10], [x + 10, y + 58 * sy]]) {
        cg.fillStyle = '#22252a'; cg.beginPath(); cg.arc(rx, ry, 4.5, 0, 7); cg.fill()
        hg.fillStyle = '#d5d5d5'; hg.beginPath(); cg.arc(rx, ry, 5, 0, 7); hg.fill()
      }
    }
    bracket(2, 2, 1, 1); bracket(s - 76, 2, 1, 1)
    bracket(2, s - 76, 1, 1); bracket(s - 76, s - 76, 1, 1)
    // 钢印
    cg.fillStyle = 'rgba(30,22,14,0.65)'
    cg.font = 'bold 44px monospace'; cg.textAlign = 'center'
    cg.fillText('SUPPLY-07', s / 2, s / 2 + 14)
    scratches(cg, s, 34, 'rgba(235,220,190,0.10)')
    noise(cg, s, 0.05, 700)
  })
  return {
    map: toTex(color, { srgb: true }),
    normalMap: toTex(heightToNormal(height, 2.0)),
  }
})

// ---- 特效贴图 ----
const flash = () => get('flash', () => {
  const c = canvas(256)
  const g = c.getContext('2d')
  const C = 128
  // 外层光晕
  const halo = g.createRadialGradient(C, C, 0, C, C, C)
  halo.addColorStop(0, 'rgba(255,214,140,0.55)'); halo.addColorStop(0.4, 'rgba(255,190,100,0.16)'); halo.addColorStop(1, 'rgba(255,170,80,0)')
  g.fillStyle = halo; g.fillRect(0, 0, 256, 256)
  // 八向不规则星芒（长短交替更凶）
  for (let i = 0; i < 8; i++) {
    g.save()
    g.translate(C, C); g.rotate(i * Math.PI / 4 + (Math.random() - 0.5) * 0.2)
    const len = 52 + Math.random() * 68
    const halfW = i % 2 ? 3 : 5.5
    const spike = g.createLinearGradient(0, 0, len, 0)
    spike.addColorStop(0, 'rgba(255,235,180,0.95)'); spike.addColorStop(0.7, 'rgba(255,200,110,0.5)'); spike.addColorStop(1, 'rgba(255,180,80,0)')
    g.fillStyle = spike
    g.beginPath(); g.moveTo(0, -halfW); g.lineTo(len, 0); g.lineTo(0, halfW); g.closePath(); g.fill()
    g.restore()
  }
  // 白炽核心
  const core = g.createRadialGradient(C, C, 0, C, C, 34)
  core.addColorStop(0, 'rgba(255,255,248,1)'); core.addColorStop(0.55, 'rgba(255,224,150,0.9)'); core.addColorStop(1, 'rgba(255,190,90,0)')
  g.fillStyle = core; g.fillRect(C - 40, C - 40, 80, 80)
  return toTex(c, { srgb: true })
})

const blob = () => get('blob', () => {
  const c = canvas(64)
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32)
  grad.addColorStop(0, 'rgba(0,0,0,0.42)'); grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64)
  return toTex(c)
})

// 弹孔（透明底：灼烧边 + 裂纹 + 翻边高光）
const hole = () => get('hole', () => {
  const c = canvas(128)
  const g = c.getContext('2d')
  const C = 64
  // 灼烧软边
  const burn = g.createRadialGradient(C, C, 8, C, C, 58)
  burn.addColorStop(0, 'rgba(18,15,12,0.9)'); burn.addColorStop(0.55, 'rgba(24,20,16,0.5)'); burn.addColorStop(1, 'rgba(24,20,16,0)')
  g.fillStyle = burn; g.fillRect(0, 0, 128, 128)
  // 放射裂纹
  for (let i = 0; i < 11; i++) {
    const a = Math.random() * Math.PI * 2
    let x = C + Math.cos(a) * 10, y = C + Math.sin(a) * 10
    g.strokeStyle = `rgba(12,10,8,${0.5 + Math.random() * 0.4})`
    g.lineWidth = 1 + Math.random() * 1.2
    g.beginPath(); g.moveTo(x, y)
    for (let k = 0; k < 3; k++) {
      x += Math.cos(a + (Math.random() - 0.5) * 0.7) * (8 + Math.random() * 10)
      y += Math.sin(a + (Math.random() - 0.5) * 0.7) * (8 + Math.random() * 10)
      g.lineTo(x, y)
    }
    g.stroke()
  }
  // 黑洞核心
  const core = g.createRadialGradient(C, C, 0, C, C, 22)
  core.addColorStop(0, 'rgba(2,2,2,1)'); core.addColorStop(0.75, 'rgba(6,5,4,0.95)'); core.addColorStop(1, 'rgba(10,8,6,0)')
  g.fillStyle = core; g.fillRect(C - 26, C - 26, 52, 52)
  // 金属翻边高光（月牙）
  g.strokeStyle = 'rgba(190,198,208,0.4)'; g.lineWidth = 2
  g.beginPath(); g.arc(C - 2, C - 2, 15, Math.PI * 0.9, Math.PI * 1.7); g.stroke()
  return toTex(c, { srgb: true })
})

// 火花粒子（白炽核心 + 暖色衰减）
const spark = () => get('spark', () => {
  const c = canvas(64)
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,240,200,0.9)')
  grad.addColorStop(0.6, 'rgba(255,190,90,0.35)')
  grad.addColorStop(1, 'rgba(255,160,60,0)')
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64)
  return toTex(c, { srgb: true })
})

// 烟雾粒子（多圆叠加软斑 + 边缘遮罩）
const smoke = () => get('smoke', () => {
  const c = canvas(128)
  const g = c.getContext('2d')
  for (let i = 0; i < 26; i++) {
    const x = 34 + Math.random() * 60, y = 34 + Math.random() * 60, r = 10 + Math.random() * 24
    const rg = g.createRadialGradient(x, y, 0, x, y, r)
    rg.addColorStop(0, `rgba(255,255,255,${0.05 + Math.random() * 0.08})`)
    rg.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2)
  }
  // 边缘软遮罩（destination-in 径向）
  g.globalCompositeOperation = 'destination-in'
  const mask = g.createRadialGradient(64, 64, 8, 64, 64, 62)
  mask.addColorStop(0, 'rgba(0,0,0,1)'); mask.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = mask; g.fillRect(0, 0, 128, 128)
  return toTex(c)
})

// 冲击波环（细亮圆环，击杀反馈用）
const ring = () => get('ring', () => {
  const c = canvas(256)
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  grad.addColorStop(0.62, 'rgba(255,255,255,0)')
  grad.addColorStop(0.74, 'rgba(255,255,255,0.95)')
  grad.addColorStop(0.8, 'rgba(255,255,255,0.28)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256)
  return toTex(c, { srgb: true })
})

// 警示条纹（地图缺口上沿 / 台阶）
const stripes = () => get('stripes', () => {
  const { color, height } = pair(256, (cg, hg, s) => {
    cg.fillStyle = '#d7a83c'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    cg.save()
    cg.translate(s / 2, s / 2); cg.rotate(Math.PI / 4)
    cg.fillStyle = '#15181c'
    for (let x = -s; x < s; x += 44) cg.fillRect(x, -s, 22, s * 2)
    cg.restore()
    // 使用磨损
    scratches(cg, s, 30, 'rgba(0,0,0,0.2)')
    noise(cg, s, 0.05, 500)
    noise(hg, s, 0.05, 400)
  })
  return {
    map: toTex(color, { srgb: true }),
    roughnessMap: toTex(height),
    normalMap: toTex(heightToNormal(height, 1.0)),
  }
})

// ---- 机器人装甲板（GLB 假人外壳：烤漆双色面板 + 螺丝 + 风口 + 钢印 + 边缘磨损）----
const robotShell = () => get('robotShell', () => {
  const { color, height } = pair(1024, (cg, hg, s) => {
    // 底色 = 拼缝深色（面板之间露出的缝）
    cg.fillStyle = '#24262a'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 面板布局：4×4 粗格随机再分割 → 不规则板件
    const panels = []
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const x = c * 256, y = r * 256
      if (Math.random() < 0.55) { // 竖切一刀
        const w = 96 + Math.random() * 64
        panels.push([x, y, w, 256], [x + w, y, 256 - w, 256])
      } else if (Math.random() < 0.5) { // 横切一刀
        const h = 96 + Math.random() * 64
        panels.push([x, y, 256, h], [x, y + h, 256, 256 - h])
      } else panels.push([x, y, 256, 256])
    }
    const capsule = (g, x, y, w, h) => {
      const r = h / 2
      g.beginPath()
      g.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5)
      g.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2)
      g.closePath(); g.fill()
    }
    panels.forEach(([x, y, w, h], idx) => {
      const roll = Math.random()
      let base = '#d9d5cc'                                   // 主色：暖白烤漆
      if (roll > 0.82) base = '#b8402e'                      // 敌方识别红橙板
      else if (roll > 0.7) base = '#3f444c'                  // 深色技术板
      else if (roll > 0.6) base = '#8b8e92'                  // 灰过渡板
      const inset = 6
      const px = x + inset, py = y + inset, pw = w - inset * 2, ph = h - inset * 2
      cg.fillStyle = base; cg.fillRect(px, py, pw, ph)
      // 面板顶部受光 / 底部阴影（烤漆体积感）
      cg.fillStyle = 'rgba(255,255,255,0.12)'; cg.fillRect(px, py, pw, 3)
      cg.fillStyle = 'rgba(0,0,0,0.22)'; cg.fillRect(px, py + ph - 3, pw, 3)
      hg.fillStyle = `rgb(${135 + Math.random() * 14 | 0},${135 + Math.random() * 14 | 0},${135 + Math.random() * 14 | 0})`
      hg.fillRect(px, py, pw, ph)
      hg.fillStyle = 'rgba(255,255,255,0.12)'; hg.fillRect(px, py, pw, 3)
      // 角螺丝 ×4（凹窝 + 亮月牙）
      for (const [sx, sy] of [[px + 11, py + 11], [px + pw - 11, py + 11], [px + 11, py + ph - 11], [px + pw - 11, py + ph - 11]]) {
        if (pw < 60 || ph < 60) break
        cg.fillStyle = 'rgba(0,0,0,0.55)'; cg.beginPath(); cg.arc(sx, sy, 3.4, 0, 7); cg.fill()
        cg.strokeStyle = 'rgba(255,255,255,0.35)'; cg.lineWidth = 1.2
        cg.beginPath(); cg.arc(sx - 0.8, sy - 0.8, 2.4, Math.PI * 0.7, Math.PI * 1.6); cg.stroke()
        hg.fillStyle = '#c8c8c8'; hg.beginPath(); hg.arc(sx, sy, 3.8, 0, 7); hg.fill()
      }
      // 大板加风口 / 钢印 / 警示角
      if (pw > 120 && ph > 120) {
        const deco = idx % 3
        if (deco === 0) { // 风口列
          const vx = px + pw * 0.5 - 34, vy = py + ph * 0.5 - 30
          for (let i = 0; i < 4; i++) {
            cg.fillStyle = 'rgba(10,11,13,0.85)'
            capsule(cg, vx, vy + i * 16, 68, 7)
            hg.fillStyle = '#3c3c3c'; hg.fillRect(vx, vy + i * 16, 68, 7)
          }
        } else if (deco === 1) { // 钢印编号
          cg.fillStyle = 'rgba(20,22,26,0.5)'
          cg.font = `bold ${Math.min(30, ph * 0.16) | 0}px monospace`; cg.textAlign = 'center'
          cg.fillText('TRN-07', px + pw / 2, py + ph / 2 + 8)
        } else { // 警示斜纹角
          cg.save()
          cg.beginPath(); cg.rect(px + 4, py + 4, 54, 26); cg.clip()
          cg.fillStyle = '#d7a83c'; cg.fillRect(px + 4, py + 4, 54, 26)
          cg.fillStyle = '#15181c'
          for (let k = -30; k < 60; k += 16) {
            cg.beginPath()
            cg.moveTo(px + 4 + k, py + 30); cg.lineTo(px + 4 + k + 8, py + 30)
            cg.lineTo(px + 4 + k + 22, py + 4); cg.lineTo(px + 4 + k + 14, py + 4)
            cg.closePath(); cg.fill()
          }
          cg.restore()
        }
      }
    })
    // 全局磨损：边缘磕碰露底金属 + 划痕 + 污渍 + 噪点
    scratches(cg, s, 60, 'rgba(250,250,246,0.12)')
    for (let i = 0; i < 16; i++) {
      blotch(cg, Math.random() * s, Math.random() * s, 24 + Math.random() * 60, 'rgba(40,36,30,0.12)')
    }
    noise(cg, s, 0.04, 900)
    noise(hg, s, 0.05, 700)
  })
  return {
    map: toTex(color, { srgb: true }),
    normalMap: toTex(heightToNormal(height, 2.2)),
  }
})

// ---- 机器人关节（深色橡胶/碳纤：斜纹织纹 + 六角螺栓 + 线槽）----
const robotJoint = () => get('robotJoint', () => {
  const { color, height } = pair(512, (cg, hg, s) => {
    cg.fillStyle = '#23262b'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 斜纹织纹（±45° 交叉）
    for (let i = -s; i < s * 2; i += 6) {
      cg.strokeStyle = 'rgba(255,255,255,0.045)'; cg.lineWidth = 1.4
      cg.beginPath(); cg.moveTo(i, 0); cg.lineTo(i + s, s); cg.stroke()
      cg.strokeStyle = 'rgba(0,0,0,0.10)'
      cg.beginPath(); cg.moveTo(i + 3, 0); cg.lineTo(i + 3 + s, s); cg.stroke()
      hg.strokeStyle = 'rgba(255,255,255,0.10)'; hg.lineWidth = 1.4
      hg.beginPath(); hg.moveTo(i, 0); hg.lineTo(i + s, s); hg.stroke()
    }
    for (let i = -s; i < s * 2; i += 9) {
      cg.strokeStyle = 'rgba(255,255,255,0.03)'
      cg.beginPath(); cg.moveTo(i + s, 0); cg.lineTo(i, s); cg.stroke()
      hg.strokeStyle = 'rgba(0,0,0,0.08)'
      hg.beginPath(); hg.moveTo(i + s, 0); cg.lineTo(i, s); hg.stroke()
    }
    // 六角螺栓（三颗，凸起 + 高光边）
    for (const [bx, by] of [[110, 120], [360, 90], [240, 360]]) {
      cg.fillStyle = '#31353c'; cg.beginPath()
      for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3 + 0.3
        const X = bx + Math.cos(a) * 13, Y = by + Math.sin(a) * 13
        k === 0 ? cg.moveTo(X, Y) : cg.lineTo(X, Y)
      }
      cg.closePath(); cg.fill()
      cg.strokeStyle = 'rgba(255,255,255,0.18)'; cg.lineWidth = 1.6; cg.stroke()
      cg.fillStyle = 'rgba(0,0,0,0.5)'; cg.beginPath(); cg.arc(bx, by, 4.5, 0, 7); cg.fill()
      hg.fillStyle = '#c2c2c2'; cg.beginPath(); cg.arc(bx, by, 14, 0, 7); cg.fill()
    }
    // 线槽（两条平行走线槽 + 点胶固定）
    cg.strokeStyle = 'rgba(0,0,0,0.5)'; cg.lineWidth = 5
    cg.beginPath(); cg.moveTo(0, 250); cg.bezierCurveTo(170, 240, 300, 290, s, 262); cg.stroke()
    cg.strokeStyle = 'rgba(255,255,255,0.05)'; cg.lineWidth = 1.4
    cg.beginPath(); cg.moveTo(0, 244); cg.bezierCurveTo(170, 234, 300, 284, s, 256); cg.stroke()
    hg.strokeStyle = '#484848'; hg.lineWidth = 6
    hg.beginPath(); hg.moveTo(0, 250); hg.bezierCurveTo(170, 240, 300, 290, s, 262); hg.stroke()
    // 磨损发白 + 尘土
    scratches(cg, s, 30, 'rgba(210,214,220,0.07)')
    for (let i = 0; i < 8; i++) blotch(cg, Math.random() * s, Math.random() * s, 20 + Math.random() * 40, 'rgba(90,84,70,0.10)')
    noise(cg, s, 0.05, 700)
    noise(hg, s, 0.06, 500)
  })
  return {
    map: toTex(color, { srgb: true }),
    normalMap: toTex(heightToNormal(height, 1.8)),
  }
})

// ---- 战术布料（GLB 袖臂：科尔迪拉织纹 + 绗缝线 + 织标，无大图案 —— 供任意 GLB 裁片）----
const fabric = () => get('fabric', () => {
  const { color, height } = pair(512, (cg, hg, s) => {
    cg.fillStyle = '#cfd3d8'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 粗横棱（科尔迪拉风格，4px 周期）
    for (let y = 0; y < s; y += 4) {
      cg.fillStyle = 'rgba(255,255,255,0.10)'; cg.fillRect(0, y, s, 1)
      cg.fillStyle = 'rgba(0,0,0,0.10)'; cg.fillRect(0, y + 2, s, 1)
      hg.fillStyle = 'rgba(255,255,255,0.14)'; hg.fillRect(0, y, s, 1)
      hg.fillStyle = 'rgba(0,0,0,0.14)'; hg.fillRect(0, y + 2, s, 1)
    }
    // 纵向纤维
    for (let x = 0; x < s; x += 3) {
      cg.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.03})`
      cg.fillRect(x, 0, 1, s)
    }
    // 绗缝线（竖两道，压出衣服裁片感）
    for (const x of [s * 0.33, s * 0.78]) {
      stitches(cg, x - 14, 12, [28, s - 24], 'rgba(0,0,0,0.16)')
      cg.strokeStyle = 'rgba(0,0,0,0.20)'; cg.lineWidth = 2
      cg.beginPath(); cg.moveTo(x, 0); cg.lineTo(x, s); cg.stroke()
      hg.strokeStyle = '#5c5c5c'; hg.lineWidth = 3
      hg.beginPath(); hg.moveTo(x, 0); hg.lineTo(x, s); hg.stroke()
    }
    // 小织标
    cg.fillStyle = 'rgba(30,34,40,0.85)'; cg.fillRect(392, 40, 66, 26)
    cg.fillStyle = 'rgba(230,232,236,0.8)'; cg.font = 'bold 13px monospace'; cg.textAlign = 'center'
    cg.fillText('R-07', 425, 57)
    hg.fillStyle = '#929292'; hg.fillRect(392, 40, 66, 26)
    // 磨损与尘土
    scratches(cg, s, 22, 'rgba(255,255,255,0.06)')
    for (let i = 0; i < 6; i++) blotch(cg, Math.random() * s, Math.random() * s, 24 + Math.random() * 46, 'rgba(60,55,45,0.10)')
    noise(cg, s, 0.05, 700)
    noise(hg, s, 0.07, 600)
  })
  return {
    map: toTex(color, { srgb: true }),
    roughnessMap: toTex(height),
    normalMap: toTex(heightToNormal(height, 1.1)),
  }
})

// ---- 皮肤（GLB 手臂裸露部分：底色近中性供材质 tint 上色 + 毛孔噪点 + 红晕 + 静脉淡痕）----
const skin = () => get('skin', () => {
  const { color, height } = pair(512, (cg, hg, s) => {
    cg.fillStyle = '#e7c9ae'; cg.fillRect(0, 0, s, s)
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s)
    // 毛孔噪点（细密、极低对比）
    noise(cg, s, 0.035, 3200, 1)
    noise(hg, s, 0.05, 2600, 1)
    // 红晕斑（关节/指节常见泛红）
    for (let i = 0; i < 10; i++) {
      blotch(cg, Math.random() * s, Math.random() * s, 26 + Math.random() * 60, 'rgba(205,120,100,0.05)')
    }
    // 静脉淡痕（两条极淡青色细线）
    cg.strokeStyle = 'rgba(120,140,160,0.05)'; cg.lineWidth = 3 + Math.random() * 2
    cg.beginPath(); cg.moveTo(60, 0)
    cg.bezierCurveTo(120, s * 0.3, 40, s * 0.6, 110, s); cg.stroke()
    cg.beginPath(); cg.moveTo(330, 0)
    cg.bezierCurveTo(390, s * 0.4, 300, s * 0.7, 380, s); cg.stroke()
    // 皱纹细线（横向极淡）
    for (let i = 0; i < 26; i++) {
      const y = Math.random() * s
      cg.strokeStyle = `rgba(150,95,75,${0.03 + Math.random() * 0.03})`
      cg.lineWidth = 1
      cg.beginPath(); cg.moveTo(Math.random() * s * 0.5, y)
      cg.lineTo(Math.random() * s * 0.5 + s * 0.4, y + (Math.random() - 0.5) * 8); cg.stroke()
      if (i % 3 === 0) {
        hg.strokeStyle = 'rgba(0,0,0,0.10)'; hg.lineWidth = 1
        hg.beginPath(); hg.moveTo(Math.random() * s * 0.5, y)
        hg.lineTo(Math.random() * s * 0.5 + s * 0.4, y + (Math.random() - 0.5) * 8); hg.stroke()
      }
    }
  })
  return {
    map: toTex(color, { srgb: true }),
    normalMap: toTex(heightToNormal(height, 0.5)),
  }
})

// ---- PBR 材质工厂 ----
export function pbr({ maps, color = 0xffffff, roughness = 1, metalness = 0, repeat = null, emissive = null, emissiveIntensity = 1 } = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness })
  if (maps?.map) {
    m.map = maps.map.clone(); m.map.needsUpdate = true
    if (repeat) m.map.repeat.set(repeat[0], repeat[1])
  }
  if (maps?.roughnessMap) {
    m.roughnessMap = maps.roughnessMap.clone(); m.roughnessMap.needsUpdate = true
    if (repeat) m.roughnessMap.repeat.set(repeat[0], repeat[1])
  }
  if (maps?.normalMap) {
    m.normalMap = maps.normalMap.clone(); m.normalMap.needsUpdate = true
    m.normalScale = new THREE.Vector2(0.9, 0.9)
    if (repeat) m.normalMap.repeat.set(repeat[0], repeat[1])
  }
  if (maps?.emissiveMap) {
    m.emissiveMap = maps.emissiveMap.clone(); m.emissiveMap.needsUpdate = true
    m.emissive = new THREE.Color(emissive ?? 0xffffff)
    m.emissiveIntensity = emissiveIntensity
  }
  return m
}

export const Tex = {
  suit, vest, visor, visorGlow, metal, polymer, wood,
  floor, wall, crate,
  flash, blob, hole, spark, smoke, ring, stripes,
  robotShell, robotJoint, fabric, skin,
}
