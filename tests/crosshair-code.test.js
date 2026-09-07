import { describe, expect, it } from 'vitest'
import {
  PRESET_COLORS, crosshairDefaults, parseCrosshairCode, exportCrosshairCode,
  sanitizeCrosshair, isLegacyCrosshair, migrateLegacyCrosshair, crosshairColor, normalizeHex,
} from '../src/ui/crosshairCode.js'

describe('parseCrosshairCode 游戏准星代码解析', () => {
  it('无 P 段/非字符串返回 null', () => {
    expect(parseCrosshairCode('0;s;1')).toBeNull()
    expect(parseCrosshairCode('hello')).toBeNull()
    expect(parseCrosshairCode(null)).toBeNull()
  })

  it('解析文档示例代码的各键位', () => {
    const s = parseCrosshairCode('0;P;c;5;h;0;0t;1;0l;2;0o;2;0a;1;0f;0;1b;0')
    expect(s).not.toBeNull()
    expect(s.colorIdx).toBe(5)
    expect(s.outlines).toBe(false)
    expect(s.inner.thickness).toBe(1)
    expect(s.inner.length).toBe(2)
    expect(s.inner.offset).toBe(2)
    expect(s.inner.opacity).toBe(1)
    expect(s.inner.fireErr).toBe(false)
    expect(s.outer.show).toBe(false)
  })

  it('容忍全角分号/空白/引号，忽略未知键与 A/S/NAME 段', () => {
    const s = parseCrosshairCode('0；P； c；1； zz；9； 0l；7；A；c；0；S；c；0')
    expect(s.colorIdx).toBe(1)
    expect(s.inner.length).toBe(7)
  })

  it('线段长度联动：linked 时 vlength 跟随 length', () => {
    const s = parseCrosshairCode('0;P;0l;9')
    expect(s.inner.linked).toBe(true)
    expect(s.inner.vlength).toBe(9)
  })

  it('预设色同步进 custom（颜色选择器回显）；自定义色走 c;8 + u', () => {
    const s = parseCrosshairCode('0;P;c;3')
    expect(s.custom).toBe(PRESET_COLORS[3].hex)
    const u = parseCrosshairCode('0;P;c;8;u;12abCf')
    expect(u.colorIdx).toBe(8)
    expect(u.custom).toBe('12ABCF') // normalizeHex 统一大写
    expect(crosshairColor(u)).toBe('#12ABCF')
  })
})

describe('exportCrosshairCode 导出与往返', () => {
  it('默认设置导出为 "0"（游戏同策略：只发射差异键）', () => {
    expect(exportCrosshairCode(crosshairDefaults())).toBe('0')
  })

  it('导出 → 导入往返一致（渲染口径：预设色的 custom 由解析同步，颜色结果不变）', () => {
    const s = crosshairDefaults()
    s.colorIdx = 5
    s.inner.length = 10
    s.outer.show = false
    s.fadeFire = false
    s.fadeMove = true
    s.inner.linked = false
    s.inner.vlength = 4
    const back = parseCrosshairCode(exportCrosshairCode(s))
    expect(back).toEqual({ ...sanitizeCrosshair(s), custom: PRESET_COLORS[5].hex })
    expect(crosshairColor(back)).toBe(crosshairColor(sanitizeCrosshair(s)))
  })

  it('自定义色导出发射 u;RRGGBBFF', () => {
    const s = crosshairDefaults()
    s.colorIdx = 8
    s.custom = 'ABCDEF'
    expect(exportCrosshairCode(s)).toContain('u;ABCDEFFF')
  })
})

describe('sanitizeCrosshair 脏数据防线', () => {
  it('非对象/空值回落默认', () => {
    expect(sanitizeCrosshair(null)).toEqual(crosshairDefaults())
    expect(sanitizeCrosshair('x')).toEqual(crosshairDefaults())
  })

  it('越界数值双向钳制到 RANGES，非法类型回落默认', () => {
    const s = sanitizeCrosshair({ inner: { length: 999, thickness: 'abc', offset: -5 }, dotSize: 99 })
    expect(s.inner.length).toBe(20)
    expect(s.inner.thickness).toBe(crosshairDefaults().inner.thickness)
    expect(s.inner.offset).toBe(0)
    expect(s.dotSize).toBe(6)
  })

  it('vlength：linked 下非法值回落 length（渲染口径 linked 用 length）；解耦时保留', () => {
    const s = sanitizeCrosshair({ inner: { length: 8, vlength: 'abc' } })
    expect(s.inner.vlength).toBe(8)
    const keep = sanitizeCrosshair({ inner: { linked: false, length: 8, vlength: 4 } })
    expect(keep.inner.vlength).toBe(4)
  })
})

describe('旧版准星设置迁移', () => {
  it('识别旧模型（无 inner 且含 length/gap/tShape）', () => {
    expect(isLegacyCrosshair({ length: 5, gap: 3 })).toBe(true)
    expect(isLegacyCrosshair({ inner: {} })).toBe(false)
    expect(isLegacyCrosshair({})).toBe(false)
  })

  it('迁移：旧线长/粗/间距进内线，外线隐藏，旧颜色映射预设或自定义', () => {
    const s = migrateLegacyCrosshair({ color: '#00ffff', length: 5, thickness: 2, gap: 3, dot: true })
    expect(s.inner.length).toBe(5)
    expect(s.inner.thickness).toBe(2)
    expect(s.inner.offset).toBe(3)
    expect(s.outer.show).toBe(false)
    expect(s.dot).toBe(true)
    expect(s.colorIdx).toBe(5) // 青
    const c = migrateLegacyCrosshair({ color: '#123456' })
    expect(c.colorIdx).toBe(8)
    expect(c.custom).toBe('123456')
  })

  it('旧"动态误差"关闭 → 内线开火误差同步关（静态准星）', () => {
    const s = migrateLegacyCrosshair({ error: false })
    expect(s.inner.fireErr).toBe(false)
  })
})

describe('normalizeHex', () => {
  it('接受 6 位/带#/8 位（截断），拒绝非法', () => {
    expect(normalizeHex('00ff00')).toBe('00FF00')
    expect(normalizeHex('#aBcDeF')).toBe('ABCDEF')
    expect(normalizeHex('AABBCCDD')).toBe('AABBCC')
    expect(normalizeHex('xyz')).toBeNull()
    expect(normalizeHex(42)).toBeNull()
  })
})
