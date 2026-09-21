// 暂停冻结接线锁（main.js renderFrame）：simStep 停在后 renderFrame 照跑，
// 渲染帧里的物理/表现推进必须与 flashes.renderSync 同款以 `state.playing ?
// dt : 0` 门控——fx.update 收真实 dt 会让抛壳/头盔物理继续跑，弹壳落地声
// 走 Audio.ensure() 无条件 resume 刚 suspend 的 AudioContext（暂停菜单里
// 听见叮声）；hud.updateDamage 收真实 dt 则伤害数字在冻结画面里继续上浮。
// main.js 是 DOM/WebGL 绑定的启动模块，node 环境无法整量 import——按
// prewarm-arrival.test.js 手法锁源码接线。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8')
const src = read('src/main.js')

describe('暂停时渲染帧推进门控（playing ? dt : 0）', () => {
  const gated = ['flashes.renderSync', 'fx.update', 'hud.updateDamage']

  it.each(gated)('%s 以 state.playing 门控 dt（暂停 = 冻结，含弹壳物理/落地声/伤害数字）', (name) => {
    const call = `${name}(`
    const i = src.indexOf(call)
    expect(i, `main.js 应调用 ${name}`).toBeGreaterThanOrEqual(0)
    // 调用点之后 80 字符内必须出现同一行的 playing 门控（三处同款写法）
    expect(src.slice(i, i + 80)).toContain('state.playing ? dt : 0')
  })

  it('renderFrame 内不再有裸 dt 推进的物理/表现更新（fx.update(dt) / hud.updateDamage(dt) 已封死）', () => {
    for (const bad of ['fx.update(dt)', 'hud.updateDamage(dt)']) {
      expect(src, `${bad} 应回退为 playing 门控写法`).not.toContain(bad)
    }
  })
})
