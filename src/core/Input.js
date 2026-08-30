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
      // 阻止 Tab / 空格 等默认行为
      if (['Tab', 'Space', 'KeyR'].includes(e.code)) e.preventDefault()
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
  lock() { this.canvas.requestPointerLock() }
}
