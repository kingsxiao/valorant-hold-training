// ============================================================================
// 无畏契约准星设置模型 + 准星代码 —— 纯逻辑，无 DOM（Crosshair 渲染 / Menu 编辑共用）。
//
// 代码格式为游戏内"导入/分享准星代码"同款：分号键值对，P 段为主准星，如
//   0;s;1;P;c;5;h;0;0t;1;0l;2;0o;2;0a;1;0f;0;1b;0
// 键位语义（与游戏代码一一对应，新老代码同构，o;0/o;1 在"开关/不透明度"两种
// 历史解释下渲染结果恰好一致，无需兼容分支）：
//   主段  c 颜色索引(0-8, 8=自定义)   u 自定义色 RRGGBB[AA]
//         h 轮廓开关   t 轮廓粗细   o 轮廓不透明度
//         d 中心点     z 中心点大小 a 中心点不透明度
//         m 开火误差叠加在准星间距上   f/s 开火/移动时准星淡出
//   线段  前缀 0=内线 1=外线：
//         b 显示  a 不透明度  l 水平长度  v 垂直长度  g 长度解耦(1=已解耦)
//         t 线粗  o 间距      m 移动误差(开关)  s 移动误差倍率
//         f 开火误差(开关)    e 开火误差倍率
// A（开镜）/S（狙击镜）/NAME 段本训练器无对应物，导入时忽略。
//
// 默认值与滑条范围对齐游戏设置面板（含外线静止间距 +4 的开火误差底距规则，
// 见 Crosshair.js 的 gap 计算）。未知键一律忽略——与游戏面对未来新键的容错一致。
// ============================================================================

export const PRESET_COLORS = [
  { hex: 'FFFFFF', name: '白' },
  { hex: '00FF00', name: '绿' },
  { hex: '7FFF00', name: '黄绿' },
  { hex: 'DFFF00', name: '绿黄' },
  { hex: 'FFFF00', name: '黄' },
  { hex: '00FFFF', name: '青' },
  { hex: 'FF00FF', name: '粉' },
  { hex: 'FF0000', name: '红' },
]

// 滑条范围（min/max/step），与游戏设置面板一致；sanitize 也按它钳制
export const RANGES = {
  outlineOpacity: [0, 1, 0.01],
  outlineThickness: [0, 6, 1],
  dotOpacity: [0, 1, 0.01],
  dotSize: [1, 6, 1],
  length: [0, 20, 1],
  thickness: [0, 10, 1],
  offset: [0, 20, 1],
  opacity: [0, 1, 0.01],
  errMult: [0, 3, 0.1],
}

// 游戏"重置默认"形态：青十字（游戏默认色即青 c;5，社区默认准星代码 "0" 所指）
// + 轮廓半透明 + 外线淡而远（开火/移动误差的默认开关组合 = 游戏原味：跑动外线
// 张开、扫射内线张开）。代码解析也以此为缺省基准，缺键即取默认——这样老代码
// （缺新键）导入结果与游戏内一致
export function crosshairDefaults() {
  return {
    colorIdx: 5, custom: '00FFFF',
    outlines: true, outlineOpacity: 0.5, outlineThickness: 1,
    dot: false, dotOpacity: 1, dotSize: 2,
    // Advanced 三开关：f 游戏默认开（默认准星扫射时会淡出——大家都关的就是它）；
    // s 默认关（跑动不淡出，与游戏默认观感一致）；m 默认关
    fadeFire: true, fadeMove: false, overrideFireOffset: false,
    inner: {
      show: true, opacity: 0.8, length: 6, vlength: 6, linked: true,
      thickness: 2, offset: 3,
      moveErr: false, moveMult: 1, fireErr: true, fireMult: 1,
    },
    outer: {
      show: true, opacity: 0.35, length: 2, vlength: 2, linked: true,
      thickness: 2, offset: 10,
      moveErr: true, moveMult: 1, fireErr: true, fireMult: 1,
    },
  }
}

// ---- 代码 → 设置 ----
// 解析失败返回 null（调用方可提示"代码无效"）。成功返回全新设置对象（已钳制）。
export function parseCrosshairCode(raw) {
  if (typeof raw !== 'string') return null
  const code = raw.replace(/[\s"'\\/]/g, '').replace(/；/g, ';')
  // 裸 "0" = 全默认准星（游戏与导出端对默认配置的编码形态），导入即还原默认
  if (/^0;?$/.test(code)) return sanitizeCrosshair(crosshairDefaults())
  // 段切分：P/A/S/NAME 作分隔符；只消费首个 P 段，其余段忽略
  const parts = code.split(/(P|A|S|NAME);/g)
  let seg = null
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === 'P') { seg = parts[i + 1]; break }
  }
  if (seg == null) return null
  const s = crosshairDefaults()
  const kv = seg.split(';')
  // 主段键位（线段键以 0/1 前缀分流，另行处理）
  const PRIMARY = {
    c: 'colorIdx', u: 'custom', h: 'outlines', t: 'outlineThickness',
    o: 'outlineOpacity', d: 'dot', z: 'dotSize', a: 'dotOpacity',
    m: 'overrideFireOffset', f: 'fadeFire', s: 'fadeMove',
  }
  const LINE = {
    b: 'show', a: 'opacity', l: 'length', v: 'vlength', g: 'linked',
    t: 'thickness', o: 'offset', m: 'moveErr', s: 'moveMult', f: 'fireErr', e: 'fireMult',
  }
  const BOOLS = new Set(['outlines', 'dot', 'overrideFireOffset', 'fadeFire', 'fadeMove',
    'show', 'linked', 'moveErr', 'fireErr'])
  for (let i = 0; i + 1 < kv.length; i += 2) {
    const key = kv[i], val = kv[i + 1]
    if (/^[01]/.test(key) && LINE[key.slice(1)]) {
      setField(s[key[0] === '0' ? 'inner' : 'outer'], LINE[key.slice(1)], val)
      continue
    }
    if (PRIMARY[key]) setField(s, PRIMARY[key], val, key)
  }
  function setField(obj, field, val, codeKey) {
    // g 键语义是"长度解耦"：g;1 = 已解耦（联动关闭），与模型字段 linked 正反相
    // 反（导出端 !linked 时才发射 g;1，解析端必须取反，否则往返翻转）
    if (field === 'linked') obj[field] = !+val
    else if (BOOLS.has(field)) obj[field] = !!+val
    else if (field === 'colorIdx') {
      const n = +val
      if (Number.isInteger(n) && n >= 0 && n <= 8) {
        obj[field] = n
        if (n < 8) obj.custom = PRESET_COLORS[n].hex
      }
    } else if (typeof obj[field] === 'number') {
      const n = +val
      if (Number.isFinite(n)) obj[field] = n
    } else if (field === 'custom' && codeKey === 'u') {
      // u 出现即自定义色（可后于 c;N 覆盖预设；顺序应用、后者生效，与游戏一致）
      const hex = normalizeHex(val)
      if (hex) { obj[field] = hex; obj.colorIdx = 8 }
    }
  }
  if (s.inner.linked) s.inner.vlength = s.inner.length
  if (s.outer.linked) s.outer.vlength = s.outer.length
  return sanitizeCrosshair(s)
}

// ---- 设置 → 代码 ----
// 与游戏同策略：等于默认值的键不发射（默认配置导出即为 "0"）；只发射差异键，
// 游戏导入按自家默认补齐缺键——两边默认一致，语义即一致。
export function exportCrosshairCode(raw) {
  const s = sanitizeCrosshair(raw)
  const d = crosshairDefaults()
  const fmt = (n) => String(parseFloat((Math.round(n * 1000) / 1000).toFixed(3)))
  const out = []
  if (s.colorIdx === 8) {
    out.push('c', 8)
    if (s.custom !== d.custom) out.push('u', s.custom + 'FF')
  } else if (s.colorIdx !== d.colorIdx) {
    out.push('c', s.colorIdx)
  }
  if (!s.outlines) out.push('h', 0)
  else {
    if (s.outlineThickness !== d.outlineThickness) out.push('t', s.outlineThickness)
    if (s.outlineOpacity !== d.outlineOpacity) out.push('o', fmt(s.outlineOpacity))
  }
  if (s.dot) {
    out.push('d', 1)
    if (s.dotSize !== d.dotSize) out.push('z', s.dotSize)
    if (s.dotOpacity !== d.dotOpacity) out.push('a', fmt(s.dotOpacity))
  }
  if (s.overrideFireOffset) out.push('m', 1)
  if (s.fadeFire !== d.fadeFire) out.push('f', s.fadeFire ? 1 : 0)
  if (s.fadeMove !== d.fadeMove) out.push('s', s.fadeMove ? 1 : 0)
  for (const [p, name] of [['0', 'inner'], ['1', 'outer']]) {
    const g = s[name], gd = d[name]
    if (!g.show) { out.push(p + 'b', 0); continue }
    if (g.thickness !== gd.thickness) out.push(p + 't', g.thickness)
    if (g.length !== gd.length) out.push(p + 'l', g.length)
    if (!g.linked) out.push(p + 'v', g.vlength, p + 'g', 1)
    if (g.offset !== gd.offset) out.push(p + 'o', g.offset)
    if (g.opacity !== gd.opacity) out.push(p + 'a', fmt(g.opacity))
    if (g.moveErr !== gd.moveErr) out.push(p + 'm', g.moveErr ? 1 : 0)
    if (g.moveErr && g.moveMult !== gd.moveMult) out.push(p + 's', fmt(g.moveMult))
    if (g.fireErr !== gd.fireErr) out.push(p + 'f', g.fireErr ? 1 : 0)
    if (g.fireErr && g.fireMult !== gd.fireMult) out.push(p + 'e', fmt(g.fireMult))
  }
  return out.length ? '0;P;' + out.join(';') : '0'
}

// ---- localStorage 脏数据防线：类型/范围全量清洗，坏值回落默认 ----
export function sanitizeCrosshair(raw) {
  const d = crosshairDefaults()
  const s = crosshairDefaults()
  if (typeof raw !== 'object' || raw === null) return s
  const num = (v, def, [min, max]) => {
    const n = typeof v === 'number' ? v : parseFloat(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
  }
  const bool = (v, def) => (typeof v === 'boolean' ? v : def)
  s.colorIdx = Number.isInteger(raw.colorIdx) && raw.colorIdx >= 0 && raw.colorIdx <= 8 ? raw.colorIdx : d.colorIdx
  s.custom = normalizeHex(raw.custom) ?? d.custom
  s.outlines = bool(raw.outlines, d.outlines)
  s.outlineOpacity = num(raw.outlineOpacity, d.outlineOpacity, RANGES.outlineOpacity)
  s.outlineThickness = Math.round(num(raw.outlineThickness, d.outlineThickness, RANGES.outlineThickness))
  s.dot = bool(raw.dot, d.dot)
  s.dotOpacity = num(raw.dotOpacity, d.dotOpacity, RANGES.dotOpacity)
  s.dotSize = Math.round(num(raw.dotSize, d.dotSize, RANGES.dotSize))
  s.fadeFire = bool(raw.fadeFire, d.fadeFire)
  s.fadeMove = bool(raw.fadeMove, d.fadeMove)
  s.overrideFireOffset = bool(raw.overrideFireOffset, d.overrideFireOffset)
  for (const name of ['inner', 'outer']) {
    const rd = raw[name], dd = d[name]
    if (typeof rd !== 'object' || rd === null) continue
    const g = s[name]
    g.show = bool(rd.show, dd.show)
    g.opacity = num(rd.opacity, dd.opacity, RANGES.opacity)
    g.length = Math.round(num(rd.length, dd.length, RANGES.length))
    g.linked = bool(rd.linked, dd.linked)
    g.vlength = Math.round(num(rd.vlength, g.linked ? g.length : dd.vlength, RANGES.length))
    g.thickness = Math.round(num(rd.thickness, dd.thickness, RANGES.thickness))
    g.offset = Math.round(num(rd.offset, dd.offset, RANGES.offset))
    g.moveErr = bool(rd.moveErr, dd.moveErr)
    g.moveMult = num(rd.moveMult, dd.moveMult, RANGES.errMult)
    g.fireErr = bool(rd.fireErr, dd.fireErr)
    g.fireMult = num(rd.fireMult, dd.fireMult, RANGES.errMult)
  }
  return s
}

// ---- 旧版准星设置（v1 简化面板）迁移 ----
// 旧模型 { color,length,thickness,gap,dot,tShape,outline,error } → 新模型。
// 外线旧版没有 → 迁移后隐藏；tShape 无游戏对应物，随迁移退役（文档已注明）
export function isLegacyCrosshair(raw) {
  return typeof raw === 'object' && raw !== null && !('inner' in raw) &&
    ('length' in raw || 'gap' in raw || 'tShape' in raw)
}
export function migrateLegacyCrosshair(old) {
  const s = crosshairDefaults()
  const hex = normalizeHex(old?.color)
  const idx = PRESET_COLORS.findIndex((p) => p.hex === hex)
  if (hex) { s.colorIdx = idx >= 0 ? idx : 8; s.custom = hex }
  s.outlines = old?.outline !== false
  s.outlineOpacity = 0.85 // 旧描边即 1px 黑 85%
  s.outlineThickness = 1
  s.dot = !!old?.dot
  const clamp = (v, [min, max], def) => {
    const n = parseInt(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
  }
  s.inner.length = clamp(old?.length, RANGES.length, s.inner.length)
  s.inner.vlength = s.inner.length
  s.inner.thickness = clamp(old?.thickness, RANGES.thickness, s.inner.thickness)
  s.inner.offset = clamp(old?.gap, RANGES.offset, s.inner.offset)
  s.outer.show = false
  // 旧"动态误差"总开关：关 = 内线也不随误差扩张（静态准星）
  if (old?.error === false) s.inner.fireErr = false
  return s
}

// ---- 渲染用取色：预设索引或自定义，恒为 #RRGGBB ----
export function crosshairColor(s) {
  return '#' + (s.colorIdx === 8 ? s.custom : PRESET_COLORS[s.colorIdx]?.hex ?? s.custom)
}

// 任意杂七杂八的色串 → 6 位大写 HEX；非法返回 null
export function normalizeHex(v) {
  if (typeof v !== 'string') return null
  let h = v.replace('#', '').trim().toUpperCase()
  if (/^[0-9A-F]{8}$/.test(h)) h = h.slice(0, 6)
  return /^[0-9A-F]{6}$/.test(h) ? h : null
}
