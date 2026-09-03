// 输入：键盘状态 + 指针锁定鼠标增量（灵敏度按 Valorant 换算在 Player 中应用）
export class Input {
  constructor(canvas) {
    this.keys = new Set()
    this.canvas = canvas
    this.dx = 0
    this.dy = 0
    this.mouse0 = false   // 左键（按住）
    this.mouse1 = false   // 右键
    this.mouse0Edge = false  // 本帧按下沿（半自动）
    this.mouse1Edge = false
    this.locked = false

    addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.keys.add(e.code)
      this.onKey?.(e.code)
      // 游戏中拦截 Tab / 空格 / R 的默认行为（菜单打开时不拦，保证表单可用键盘）
      if (this.locked && ['Tab', 'Space', 'KeyR'].includes(e.code)) e.preventDefault()
    })
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('blur', () => { this.keys.clear(); this.mouse0 = this.mouse1 = false })

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas
      if (!this.locked) { this.keys.clear(); this.mouse0 = this.mouse1 = false }
      this.onLockChange?.(this.locked)
    })

    addEventListener('mousemove', (e) => {
      if (!this.locked) return
      this.dx += e.movementX
      this.dy += e.movementY
    })
    addEventListener('mousedown', (e) => {
      if (!this.locked) return
      if (e.button === 0) { this.mouse0 = true; this.mouse0Edge = true }
      if (e.button === 2) { this.mouse1 = true; this.mouse1Edge = true }
    })
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse0 = false
      if (e.button === 2) this.mouse1 = false
    })
    addEventListener('contextmenu', (e) => e.preventDefault())
    addEventListener('wheel', (e) => { if (this.locked) e.preventDefault() }, { passive: false })
  }

  down(code) { return this.keys.has(code) }
  consumeMouse() {
    const d = { dx: this.dx, dy: this.dy, e0: this.mouse0Edge, e1: this.mouse1Edge }
    this.dx = this.dy = 0
    this.mouse0Edge = this.mouse1Edge = false
    return d
  }

  // 优先请求"未经系统调整"的原始鼠标输入（绕过 OS 加速度/平滑 —— 瞄准训练器的
  // 关键一致性）。旧浏览器不支持 options / 返回 undefined / 抛 NotSupportedError
  // 时回退普通锁定；Promise 拒绝（无手势）静默处理由调用方语义决定。
  lock() {
    let p
    try {
      p = this.canvas.requestPointerLock({ unadjustedMovement: true })
    } catch {
      p = this.canvas.requestPointerLock()
    }
    if (p?.catch) {
      p.catch(() => {
        // unadjustedMovement 不被支持（Firefox 等）→ 普通锁定重试
        const retry = this.canvas.requestPointerLock()
        retry?.catch?.(() => {}) // 仍失败（无手势）保持现状，由点击再触发
      })
    }
  }
}
