import { describe, expect, it } from 'vitest'
import {
  PRESET_COLORS, crosshairDefaults, parseCrosshairCode, exportCrosshairCode,
  sanitizeCrosshair, isLegacyCrosshair, migrateLegacyCrosshair, crosshairColor, normalizeHex,
} from '../src/ui/crosshairCode.js'
import { CONFIG } from '../src/core/Config.js'
import { spreadAt, spreadParts } from '../src/weapons/ballistics.js'

// 真实游戏分享代码样本（新老键位混用，均可解析）
const TENZ = '0;s;1;P;c;5;h;0;m;1;0l;4;0o;2;0a;1;0f;0;1b;0'
const DOT_CUSTOM = '0;c;1;P;u;000000FF;h;0;d;1;z;1;f;0;m;1;0t;1;0l;2;0o;1;0a;1;0e;0.5;1b;0'
const UNLINKED = '0;P;c;1;0l;4;0v;5;0g;1;0o;2'
const FULL = '0;s;1;P;c;7;t;2;o;1;d;1;z;3;a;0.374;f;0;s;0;0t;10;0l;2;0o;2;0a;1;0f;0;1b;0'

describe('parseCrosshairCode 游戏代码解析', () => {
  it('TenZ：青色无轮廓、内线 4/2/1、开火误差关、外线隐藏', () => {
    const s = parseCrosshairCode(TENZ)
    expect(s).not.toBeNull()
    expect(s.colorIdx).toBe(5)
    expect(s.custom).toBe(PRESET_COLORS[5].hex)
    expect(s.outlines).toBe(false)
    expect(s.inner.length).toBe(4)
    expect(s.inner.offset).toBe(2)
    expect(s.inner.opacity).toBe(1)
    expect(s.inner.fireErr).toBe(false)
    expect(s.outer.show).toBe(false)
    expect(s.overrideFireOffset).toBe(true) // m;1
    expect(s.fadeFire).toBe(true)            // 无 primary 级 f 键 → 保持默认（开）
  })

  it('自定义色（c;8 + u 十六进制含 FF 透明位）与中心点', () => {
    const s = parseCrosshairCode(DOT_CUSTOM)
    expect(s.colorIdx).toBe(8)
    expect(s.custom).toBe('000000')
    expect(s.dot).toBe(true)
    expect(s.dotSize).toBe(1)
    expect(s.inner.fireMult).toBe(0.5) // 0e = 开火误差倍率
    expect(s.outer.show).toBe(false)
  })

  it('水平/垂直长度解耦（0v + 0g;1）', () => {
    const s = parseCrosshairCode(UNLINKED)
    expect(s.inner.length).toBe(4)
    expect(s.inner.vlength).toBe(5)
    expect(s.inner.linked).toBe(false)
    expect(s.inner.offset).toBe(2)
  })

  it('完整参数代码逐键对位', () => {
    const s = parseCrosshairCode(FULL)
    expect(s.colorIdx).toBe(7)
    expect(s.outlineThickness).toBe(2)
    expect(s.outlineOpacity).toBe(1)
    expect(s.dot).toBe(true)
    expect(s.dotSize).toBe(3)
    expect(s.dotOpacity).toBeCloseTo(0.374)
    expect(s.fadeFire).toBe(false)
    expect(s.fadeMove).toBe(false)
    expect(s.inner.thickness).toBe(10)
    expect(s.inner.length).toBe(2)
    expect(s.inner.offset).toBe(2)
    expect(s.outer.show).toBe(false)
  })

  it('容错：引号/空白/换行/全角分号不致命；垃圾输入返回 null', () => {
    expect(parseCrosshairCode(`  "0;P;c;5；h;0；1b;0" \n`)).not.toBeNull()
    expect(parseCrosshairCode('')).toBeNull()
    expect(parseCrosshairCode('hello world')).toBeNull()
    expect(parseCrosshairCode(null)).toBeNull()
    expect(parseCrosshairCode(123)).toBeNull()
  })

  it('裸 "0"（游戏与本训练器对默认配置的导出形态）导入即全默认', () => {
    const s = parseCrosshairCode('0')
    expect(s).toEqual(crosshairDefaults())
    expect(parseCrosshairCode('0;')).toEqual(crosshairDefaults())
    // 往返闭环：默认导出 "0" → 导入还原默认（此前导出自己的代码却报"无效"）
    expect(parseCrosshairCode(exportCrosshairCode(crosshairDefaults()))).toEqual(crosshairDefaults())
  })

  it('真实社区点准心代码：中心点开 + 内外线隐藏（0b/1b 与 0l;0 两种编码风格）', () => {
    // overgear 教程给的点准心代码（b 键关线组）
    const dot = parseCrosshairCode('0;P;c;1;o;1;d;1;0b;0;1b;0')
    expect(dot.dot).toBe(true)
    expect(dot.inner.show).toBe(false)
    expect(dot.outer.show).toBe(false)
    // 长度 0 风格（如 turbosmurfs 黑描边点准心）：线段 length=0，渲染为不可见
    const lz = parseCrosshairCode('0;P;c;5;o;1;d;1;z;1;f;0;0t;1;0l;0;0o;1;0a;1;0f;0;1t;1;1l;0;1o;1;1a;1;1m;0;1f;0')
    expect(lz.dot).toBe(true)
    expect(lz.inner.length).toBe(0)
    expect(lz.outer.length).toBe(0)
    for (const s of [dot, lz]) {
      expect(parseCrosshairCode(exportCrosshairCode(s))).toEqual(s)
    }
  })

  it('越界/非法数值被钳制不炸（防手改代码）', () => {
    const s = parseCrosshairCode('0;P;c;99;h;0;t;99;z;-5;0t;999;0l;-3;0o;88;0a;9')
    expect(s.colorIdx).toBeLessThanOrEqual(8)
    expect(s.outlineThickness).toBeLessThanOrEqual(6)
    expect(s.inner.thickness).toBeLessThanOrEqual(10)
    expect(s.inner.length).toBeGreaterThanOrEqual(0)
    expect(s.inner.offset).toBeLessThanOrEqual(20)
    expect(s.inner.opacity).toBeLessThanOrEqual(1)
  })

  it('未知键被忽略（与游戏面对未来新键的容错一致）', () => {
    const s = parseCrosshairCode('0;P;c;5;x;9;q;1;0z;3;1z;9;1b;0')
    expect(s.colorIdx).toBe(5)
    expect(s.outer.show).toBe(false)
  })
})

describe('exportCrosshairCode 导出（默认差异发射）', () => {
  it('默认设置导出为 "0"', () => {
    expect(exportCrosshairCode(crosshairDefaults())).toBe('0')
  })

  it('往返：解析→导出→解析 与首次解析逐字段一致', () => {
    for (const code of [TENZ, DOT_CUSTOM, UNLINKED, FULL]) {
      const a = parseCrosshairCode(code)
      const b = parseCrosshairCode(exportCrosshairCode(a))
      expect(b, code).toEqual(a)
    }
  })

  it('自定义色导出补 FF 透明位（c;8;u;RRGGBBFF）', () => {
    const s = crosshairDefaults()
    s.colorIdx = 8
    s.custom = '00FFB3'
    expect(exportCrosshairCode(s)).toContain('c;8;u;00FFB3FF')
  })

  it('外线隐藏只发射 1b;0（与游戏导出策略一致）', () => {
    const s = crosshairDefaults()
    s.outer.show = false
    expect(exportCrosshairCode(s)).toBe('0;P;1b;0')
  })

  it('淡出开关按默认差发射：f 仅在关时发 f;0，s 仅在开时发 s;1', () => {
    const s = crosshairDefaults()
    expect(exportCrosshairCode(s)).not.toContain('f;')
    s.fadeFire = false
    expect(exportCrosshairCode(s)).toContain('f;0')
    s.fadeMove = true
    const code = exportCrosshairCode(s)
    expect(code).toContain('s;1')
  })
})

describe('sanitizeCrosshair 脏数据防线', () => {
  it('非对象/空 → 全默认', () => {
    expect(sanitizeCrosshair(null)).toEqual(crosshairDefaults())
    expect(sanitizeCrosshair(3)).toEqual(crosshairDefaults())
  })

  it('越界钳制、类型错回落默认', () => {
    const s = sanitizeCrosshair({
      colorIdx: 12, custom: 'XYZ!', outlines: 'yes', outlineOpacity: 2,
      dotSize: -1, inner: { length: 999, thickness: 'abc', opacity: 0.5 },
    })
    expect(s.colorIdx).toBe(5)          // 非法色索引回落游戏默认青
    expect(s.custom).toBe('00FFFF')
    expect(s.outlines).toBe(true)
    expect(s.outlineOpacity).toBe(1)
    expect(s.dotSize).toBe(1) // -1 钳到范围下界（范围内的合法值保留）
    expect(s.inner.length).toBe(20)
    expect(s.inner.thickness).toBe(2)
    expect(s.inner.opacity).toBe(0.5)
  })

  it('颜色取值：预设索引或自定义恒得合法 #RRGGBB', () => {
    const s = sanitizeCrosshair({ colorIdx: 8, custom: 'ff4655' })
    expect(crosshairColor(s)).toBe('#FF4655')
    expect(crosshairColor(sanitizeCrosshair({ colorIdx: 5 }))).toBe('#00FFFF')
  })
})

describe('旧版准星设置迁移', () => {
  it('识别旧模型（length/gap/tShape），迁移保持观感', () => {
    const old = { color: '#00ffb3', length: 5, thickness: 2, gap: 3, dot: false, tShape: false, outline: true, error: true }
    expect(isLegacyCrosshair(old)).toBe(true)
    expect(isLegacyCrosshair(crosshairDefaults())).toBe(false)
    const s = migrateLegacyCrosshair(old)
    expect(s.colorIdx).toBe(8)
    expect(s.custom).toBe('00FFB3')
    expect(s.inner.length).toBe(5)
    expect(s.inner.thickness).toBe(2)
    expect(s.inner.offset).toBe(3)
    expect(s.outlines).toBe(true)
    expect(s.outlineOpacity).toBeCloseTo(0.85) // 旧描边 = 1px 黑 85%
    expect(s.outer.show).toBe(false)           // 旧版没有外线
    expect(s.inner.fireErr).toBe(true)         // 旧"动态误差"默认开
  })

  it('旧"动态误差"关闭 → 内线开火误差也关（静态准星）', () => {
    const s = migrateLegacyCrosshair({ color: '#fff', length: 6, thickness: 2, gap: 4, error: false })
    expect(s.inner.fireErr).toBe(false)
  })

  it('normalizeHex：#前缀/8位含FF/非法输入', () => {
    expect(normalizeHex('#00ffb3')).toBe('00FFB3')
    expect(normalizeHex('000000FF')).toBe('000000')
    expect(normalizeHex('zzz')).toBeNull()
    expect(normalizeHex(42)).toBeNull()
  })
})

describe('spreadParts 双路误差分量（准星动态误差信号）', () => {
  const V = CONFIG.weapons.vandal
  const ctx = (over) => ({ speedRatio: 0, crouched: false, grounded: true, sprayIndex: 0, ...over })

  it('站定静止：移动误差 0（游戏里站定即无移动误差）', () => {
    const p = spreadParts(V, ctx({}))
    expect(p.move).toBe(0)
    expect(p.fire).toBe(0)
    expect(p.total).toBeCloseTo(V.spread.stand)
  })

  it('全速跑：移动误差 = run - stand；跳跃全额计入', () => {
    const run = spreadParts(V, ctx({ speedRatio: 1 }))
    expect(run.move).toBeCloseTo(V.spread.run - V.spread.stand)
    const jump = spreadParts(V, ctx({ speedRatio: 0.2, grounded: false }))
    expect(jump.move).toBeCloseTo(V.spread.jump)
  })

  it('蹲立移动误差 0（静止基准随姿态走）；蹲走仍有超额', () => {
    const still = spreadParts(V, ctx({ crouched: true }))
    expect(still.move).toBe(0)
    const walk = spreadParts(V, ctx({ crouched: true, speedRatio: 0.34 }))
    expect(walk.move).toBeGreaterThan(0)
  })

  it('连射：fire 逐发 0.05° 封顶；total 与旧 spreadAt 全场景一致', () => {
    const p10 = spreadParts(V, ctx({ sprayIndex: 10 }))
    expect(p10.fire).toBeCloseTo(0.5)
    for (const over of [
      { speedRatio: 1 }, { speedRatio: 0.5 }, { crouched: true, speedRatio: 0.2 },
      { grounded: false, speedRatio: 0.7 }, { sprayIndex: 999 },
    ]) {
      const c = ctx(over)
      expect(spreadParts(V, c).total, JSON.stringify(over)).toBeCloseTo(spreadAt(V, c))
    }
  })

  it('刀：两路均为 0', () => {
    const p = spreadParts(CONFIG.weapons.knife, ctx({ speedRatio: 1 }))
    expect(p).toEqual({ move: 0, fire: 0, total: 0 })
  })
})
