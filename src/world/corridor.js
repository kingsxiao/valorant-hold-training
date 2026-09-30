// 走廊硬域单一事实源（训练不变量，任何视觉重构不得触碰——MapBuilder.js 头注同口径）。
// 墙盒原值供 MapBuilder 建墙，派生面供 BotManager 横移线钳位/藏点外扩消费，测试
// 锁两端一致。此前手抄死值三处并存（MapBuilder 墙盒 / BotManager 钳位 / 测试注释），
// 改墙厚或位置会静默失效（Bot 贴/穿墙、firstVisibleAt 恒 -1）——本模块是唯一出处
//
// 门墙（A 门横墙）：z 中心 -24、厚 1.6 → z∈[-24.8,-23.2]
export const DOOR_WALL_Z = -24
export const DOOR_WALL_THICK = 1.6
export const DOOR_WALL_FAR_Z = DOOR_WALL_Z - DOOR_WALL_THICK / 2  // -24.8 远面（通道侧）
export const DOOR_WALL_NEAR_Z = DOOR_WALL_Z + DOOR_WALL_THICK / 2 // -23.2 近面（玩家侧）

// 通道后墙（Main 尽头）：z 中心 -36、厚 0.8 → z∈[-36.4,-35.6]
export const BACK_WALL_Z = -36
export const BACK_WALL_THICK = 0.8
export const BACK_WALL_NEAR_Z = BACK_WALL_Z + BACK_WALL_THICK / 2 // -35.6 内面（玩家侧）

// Bot 出场横移线 z 硬域：两端各留 0.4m 模型余量（越界贴/穿墙或被后墙挡断 LOS
// → firstVisibleAt 恒 -1，反应/漏杀统计全废）——菜单滑杆已限 9-18，此域是
// BotManager._peekZ 的运行时硬钳（防 params 被其它代码路径污染，双层钳位缺一不可）
export const PEEK_Z_MARGIN = 0.4
export const PEEK_Z_MIN = BACK_WALL_NEAR_Z + PEEK_Z_MARGIN // -35.2
export const PEEK_Z_MAX = DOOR_WALL_FAR_Z - PEEK_Z_MARGIN  // -25.2

// 缺口 x 区间（左右镜像等距，视线调校一致）与出生架枪位（缺口正前方 17m，
// MapBuilder build() 写入 this.spawn）
export const GAP_LEFT = { x0: -9, x1: -6 }  // 左窄口 hw=1.5
export const GAP_RIGHT = { x0: 3, x1: 7 }   // 右宽口 hw=2（楔形外扩最先起效）
export const SPAWN_Z = -17
