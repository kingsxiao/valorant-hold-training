# 部署指南

纯静态单页应用（SPA），`npm run build` 产物在 `dist/`，**任意静态文件服务器可直接托管**，无需 Node 运行时、无后端、无环境变量。

## 产物构成（v6.x，2026-09 体积优化后）

| 文件 | 大小 | 缓存建议 |
| --- | --- | --- |
| `index.html` | ~1 KB | **不缓存**（每次都拿最新的资源 hash） |
| `assets/*.js/.css/.woff2` | ~840 KB（gzip 后 ~350 KB） | 带内容 hash，可 `immutable` 长缓存 |
| `models/*.glb` | ~4.1 MB（已量化预压缩） | 无 hash，`no-cache` 或短缓存（见下） |
| `sfx/README.txt`、`models/README.txt` | ~4 KB | 随意 |
| `robots.txt`、`llms.txt` | ~2 KB | 随意（SEO/爬虫与 AI 代理站点说明） |

首次加载全量约 **4.9 MB**（GLB 已预压缩；JS/CSS/字体 gzip 后约 **0.5 MB**）；二次访问命中缓存后几乎零下载。字体已自托管（原 Google Fonts 外链移除），**无任何第三方请求**，断网/内网环境完整可用。

要点：

- vite 配置 `base: './'`，全部资源为**相对路径**——部署在域名根、子目录（如 `https://user.github.io/repo/`）、甚至 `file://` 本地双击打开均可。
- `three.js` 独立 vendor chunk（~585 KB / gzip 147 KB）：业务代码更新时用户无需重新下载渲染库。
- `models/` 下的 GLB 文件名固定（供用户同名覆盖替换），因此**不带 hash**；`public/sfx/` 同理（可选的 drop-in 音效目录，探测 404 是正常回退行为，不是错误）。

## 方式一：nginx（自建 / VPS）

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;
    root /var/www/vht;
    index index.html;

    # 开启压缩（对 JS/CSS/HTML 收益最大；GLB 是二进制容器，gzip 仍有 ~10-20%）
    gzip on;
    gzip_comp_level 6;
    gzip_types text/css application/javascript application/wasm model/gltf-binary;
    # 有条件的话用 brotli 替代/叠加 gzip，JS 再省 ~15%

    # 带 hash 的构建产物：永久缓存
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # 用户可替换的 GLB（文件名固定无 hash）：协商缓存
    location /models/ {
        add_header Cache-Control "no-cache";   # 每次校验 ETag/Last-Modified
    }

    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # SPA 单页，未知路径回落首页
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

注意 `.glb` 的 MIME：nginx 默认不含 `model/gltf-binary`，上面已在 `gzip_types` 里注册；如遇下载而非加载，检查 `types` 配置。

上传：

```bash
npm run verify          # lint + 测试 + 构建三重门禁，过了再发
rsync -avz --delete dist/ user@server:/var/www/vht/
```

## 方式二：GitHub Pages

1. 仓库 Settings → Pages → Source 选 `GitHub Actions`（推荐，自动部署 `dist/`）；或 Source 选 `gh-pages` 分支 + 手动推送：

   ```bash
   npm run build
   npx gh-pages -d dist
   ```

2. 项目页地址形如 `https://<user>.github.io/<repo>/`——`base: './'` 已保证子路径下资源引用正确，无需改配置。

如需用 Actions 自动部署，在 `.github/workflows/` 加一个 job（上传 `actions/upload-pages-artifact@v3` + `actions/deploy-pages@v4`）即可，CI 门禁沿用现有 `ci.yml` 的 `npm run verify`。

## 方式三：Vercel / Netlify / Cloudflare Pages

零配置，全部识别 vite：

- **构建命令** `npm run build`，**产物目录** `dist`
- 这些平台默认对 hash 资源长缓存、`index.html` 不缓存，规则已符合上表
- Cloudflare Pages 建议开启 Brotli（默认开启）与 HTTP/3

## 方式四：Docker（nginx:alpine）

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

nginx:alpine 自带的默认配置已含 gzip 与 MIME；如需上面那套缓存头，把配置片段写入文件并 `COPY` 到 `/etc/nginx/conf.d/default.conf`。

## 浏览器要求与协议

- 桌面版 Chrome / Edge / Firefox（WebGL2 + Pointer Lock；Safari 未在测试范围）
- `localhost` 与 `https` 下 Pointer Lock / WebAudio 体验完整；避免在 `http://` + 公网 IP 部署（部分浏览器限制自动播放等 API）
- 无需任何服务器端逻辑：命中判定、弹道、统计全部在客户端固定 128Hz 逻辑帧运行

## 更新与回滚

- 发布 = 覆盖 `dist/`；hash 文件名互不冲突，可先传新文件再覆盖 `index.html`（原子切换）
- 回滚 = 恢复旧 `index.html`（hash 资源若未清理仍可直接引用）
- `models/*.glb` 更新后因为 `no-cache`，用户刷新即生效

## 附：GLB 模型压缩管线

仓库内置模型已经过 [gltf-transform](https://gltf-transform.dev/) 量化压缩（几何 f32 → 8~14bit，KHR_mesh_quantization，three.js GLTFLoader 原生支持、无需解码器；agent.glb 另删除了未使用的动画 clip），整体 -46% ~ -55%。

同名换入你自己的模型后，一键重新压缩：

```bash
npm run optimize:models          # 压缩 public/models/*.glb（原地覆盖）
```

注意脚本使用 `prune({ keepLeaves: true })` 保留空叶子节点——`Top_end`、`IndexTip.R.001` 等末端节点是手部 IK 装配的测量标记，被清掉会导致手套/手臂回退到程序化模型。

### 换入手部/枪模 GLB 后的贴图与法线管线（2026-09-08 新增）

很多免费 CC 模型（如 Poly Pizza 系）不带 TEXCOORD_0 或带逐面法线——贴图会被
three.js 静默忽略（只剩纯色）、表面面片化。换入自己的 glove/hands/viewmodel 后按需运行：

```bash
# 1) 模型无 UV（材质贴图不显示）→ 盒式投影生成（皱纹/噪点类贴图对投影接缝不敏感）：
node scripts/add-model-uvs.mjs public/models/glove.glb
# 2) 表面呈面片棱线（逐面法线）→ 按位置聚合平滑（50° 折角阈值保留机械硬边；
#    不动索引/蒙皮权重，穿插审计结果不受影响）：
node scripts/smooth-normals.mjs public/models/glove.glb
```

两脚本均幂等（已有 UV / 已平滑则无操作或效果一致），内置 GLB 已处理完毕。

## 附：无畏契约模型获取与转换管线（2026-09-08）

> ⚠ 下述资源均为**非官方游戏提取件，无再分发授权**——仅限个人本地使用，请自行决定是否推送到远端。

### 来源清单

| 内容 | 来源 | 路径/文件 |
|---|---|---|
| 英雄（jett/phoenix/sage/sova，带贴图+kamae 待机动画，UE 骨架） | GitHub 粉丝仓库 [Valorant-3D-Immersive-Guide](https://github.com/abdullah-nadeem-lodhi/Valorant-3D-Immersive-Guide)（Sketchfab 导出） | `dist/{jett,phoenix,sage,sova}/*_animated.glb` → 拷为 `public/models/agent-*.glb` |
| 武器（32 把 .blend：Vandal/Phantom/Sheriff/Classic/Ghost/Operator/Odin…含皮肤变体） | YouTube Rocklan 模型包的 Google Drive 文件夹 | `drive.google.com/drive/folders/17pJMWTGJloEFU86NE9sIOBlH4VB9rFVh` → `Weapons/` 子目录 |
| 武器纯几何（无 UV/贴图，仅素材备用） | GitHub [codex-vibe-fps](https://github.com/yseho031018/codex-vibe-fps) | `assets/models/weapons/*.glb` → `models-optional/weapons-raw/` |

已验证的死路：models-resource 的 Valorant 页面是空的（0 资源）；Sketchfab/Meshy 下载需登录；
Mega 链接（YouTube 描述里的各包）大多已失效；"skins changer" 类仓库是恶意软件勿碰。

### 下载要点（Drive）

1. **过盾/访问**：Drive 公开文件夹不需要登录，但 `models-resource` 等站有 Cloudflare——
   chrome-devtools MCP 的 Chrome 过不了盾（无感验证死循环），**Playwright 浏览器能过**。
2. **取文件 ID**：文件夹页面 DOM 里 `[data-id]` 属性即文件 ID（或 `drive.usercontent.google.com` 抓包）。
3. **直下**（单文件 <100MB 无需确认页）：
   ```bash
   curl -sL -C - --retry 5 -o Vandal.blend \
     "https://drive.usercontent.google.com/download?id=<文件ID>&export=download&confirm=t"
   ```
4. **断流坑**：CN 网络对 Google 直连易截断（Vandal 25.1MB 下成 24MB），截断的 .blend
   在 Blender 报 `Missing DNA block`——用 `-C -` 续传补齐即可。先 `ls -l` 对照 Drive 页面大小。

### .blend → GLB 转换配方（Blender 4.5 LTS headless）

Blender 安装：官方源 `download.blender.org` 对 CN 网络常 HTTP/2 中断，用 TUNA 镜像
`https://mirrors.tuna.tsinghua.edu.cn/blender/release/Blender4.5/blender-4.5.9-macos-arm64.dmg`。

```bash
# 转换脚本要点（完整版思路）：
/Applications/Blender.app/Contents/MacOS/Blender -b -P blend2glb.py -- 源.blend 出.glb
#   1) 删 LIGHT/CAMERA/EMPTY 对象 + 删 0 尺寸图像块（Render Result）
#   2) 选中全部 MESH → bpy.ops.export_scene.gltf(
#        use_selection=True, export_format='GLB', export_apply=True, export_animations=False)
#   3) 贴图（DF 漫反射/NM 法线/MRS ORM/AEM 自发光遮罩）会自动内嵌
```

转换后三个必须的修正（脚本用 @gltf-transform，项目自带依赖）：

1. **材质补丁**：Valorant 的 MRS 通道语义与 glTF ORM 不一致，导出结果全金属+全粗糙
   （= 纯黑剪影）。摘 `metallicRoughnessTexture`、写死 `metallicFactor 0.3 / roughnessFactor 0.5`
   （法线贴图保留）。注意漫反射贴图本来就是近黑的（Vandal 默认皮肤暗色系），黑 ≠ 损坏。
2. **AEM 自发光补丁**（2026-09-10，`scripts/weapon-glb-patch.mjs`）：AEM 贴图（红通道=
   环境遮罩响应；Vandal 整图近纯红、Phantom 近白）被 Blender 接到 emissive 输入后，
   `emissiveFactor[1,1,1]` 全强度 → 整枪橘红/泛白自发光（用户所见"狂徒是橘色的"）。
   摘 `emissiveTexture` + emissive 归零；Phantom 的 `Tritium_MI` 瞄具件导出成 alpha=0+MASK
   整片被裁不可见 → 改 OPAQUE 深色底 + 绿色自发光（官方默认武器瞄具氚光小绿点）。
3. **枪口朝向**：截面法检测（两端各 8% 顶点，横截面小的一端 = 细枪管 = 枪口）。
   枪口在 +X 时绕 Y 翻 180°（`Node.setRotation([0,1,0,0])` + 平移 xy 取反）对齐本项目
   「-X = 枪口」作者系约定。

最后 `npm run optimize:models public/models/viewmodel-*.glb` 压缩（实测 -18% ~ -43%）。

### 扩枪 / 扩皮肤

同一 Drive 文件夹里的其余武器（Sheriff/Classic/Ghost 等本训练器的手枪槽、或新槽位）
走完全相同的配方即可；材质/网格名是官方代号（Vandal=GN_AK、Phantom=GN_Carbine+Tritium
氚光自发光），可用于识别与特效挂点。

**皮肤变体**（2026-09-10 已落地 aristocratVandal = 商城 Aristocrat 收藏集，内部代号
ArtDeco）：配方与基础武器完全一致（blend2glb → weapon-glb-patch --flip-y → optimize），
另有两个皮肤专属坑：①**悬浮玻璃盘**——皮肤件按材质拆 primitive 时镜片（1P_Weapon_Glass）
会被错分层进弹匣对象、世界位置卡在机匣中部，blend2glb.py 已按材质名删面（官方 Vandal
系无光学件）；②RedDot 壳体件节点无 RX90、网格数据自带朝向，属正常。运行时接入走
`src/weapons/skinMap.js`（SKINS 目录 + vmKeyFor 键解析）：皮肤 GLB 键 '<武器>:<皮肤>'
挂进 customVms，取景/握姿/机件推导按 ':' 前的武器 id 复用；Bot 模板池对应武器项由
main.applyWeaponSkin 克隆替换（敌我同步换肤）。

## 附：官方第三人称动画（.psa）获取与解析（2026-09-09）

走/跑/横移步态 1:1 校准的数据源与方法。官方动画资产（Unreal ActorX .psa，按英雄
分组、每英雄 Complex/First Person/Simple 三套）在模型来源同一个 Rocklan Drive 文件夹
的 `Animations/Agent Animations/<英雄>/Simple` 下（根 folder id 见上文模型附录）。

### 关键文件命名（TP_条件_英雄名_S0_…）

- `X_Knives_Run/Walk{N,E,S,W,NE,…}_LB`：移动循环（LB=下半身，UB=上半身叠加）。
  Jett 的 X=大招飞刀态；**Jett 的 RunE/WalkE 腿轨道与 RunN/WalkN 逐字节相同**（导出复用），
  方向性循环以 **Sova `Q_Bow_Run/Walk*`** 为准（全套 8 向、真正的方向差异）。
- `X_Aim{N,E,…}_LB/UB`：2 帧静态瞄准偏移 pose，不是循环。
- `Face_Idle / Face_Death / Face_HitReact`：整身待机（kamae）/死亡/受击。

### .psa 格式（本导出变体，与经典 ActorX 有差异）

- chunk：`ANIMHEAD`(32B 空头) → `BONENAMES`(每骨 120B：name[64]+parent i32@+64，
  但本导出 parent 全坏=0，需按名建链) → `ANIMINFO`(168B：totalbones@128、
  keyquotum@140、tracktime@148、animrate@152；**时长 = tracktime/animrate**，
  tracktime 实为帧数×[1/animrate]，如 RunN 37/61.667=0.6s) → `ANIMKEYS`(每 key 32B)
  → `SCALEKEYS`(空)。
- keys 为 **frame-major**：第 f 帧第 b 骨 = base+(f·totalbones+b)·32；每 key =
  pos(12B)+quat(x,y,z,w)(16B)+pad(4B)。单位 cm；四元数复合 **world = parent⊗local**；
  R 侧骨局部四元数带镜像约定（整腿链式 FK 不可靠，量指标用单骨局部数据最稳）。
- 解析器：`assets-raw/psa_osc.py`（局部四元数振荡分析，产出官方口径）、
  `assets-raw/psa_analyze.py`/`jett-psa/psa_parse.py`（FK 轨迹）。原始 .psa 在
  `assets-raw/{jett,sova}-psa/`。

### 官方实测口径（已锁进 GaitBake/PeekPose + 测试）

- 周期：跑 0.6s（3.33 步/s）、走 0.8~0.867s。→ STEP_LEN=1.55m（5.4m/s→3.48 步/s、
  3.39m/s→2.19 步/s，与官方 ±5% 内）。
- 膝：跑基础屈曲 20~33°、摆动峰值 108~117°；走基础 29~63°、峰值 88~103°；
  横移（RunE）基础 11.5°、峰值 ~106°。左右腿反相（相位差 ~180°）。
- 髋摆全幅：跑 ~60°(Jett)/走 ~42°；盆骨 clip 内恒高（起伏由腿部几何涌现）、
  侧摆 ~12°；LB 内脊柱无轨道（前倾走盆骨/UB 层）。
- 横移循环本质 = 腿链朝移动方向 yaw 后的前进跑循环（交替深膝），不是双脚同触地
  的开合滑步 → strafeStepPose 已按此重写（leg-chain yaw 0.90rad + GAIT.run 曲线
  按速度缩放），躯干/盆骨保持正对玩家。
- 原地导出根位移被剥离：脚相对骨盆行程仅 ~46cm，步幅必须用「周期×官方速度」推，
  不能从脚轨迹读。
- 视频回归参照：/tmp/val-rep.mp4（回放模式第三人称，原片 hoc1i5fI0ko 40-75s）；
  浏览器实测脚本 `scripts/verify-gait.mjs`（playwright-core + 系统 Chrome 独立
  profile，真实点击开局保指针锁定；MCP 浏览器被并行会话占用时的替代路径）。

### 盆骨三轴实测（psa_pelvis.py，2026-09-09 第二批：yaw/roll/pitch 落进 GAIT）

解析器 `assets-raw/psa_pelvis.py`（谐波拟合 1×/2× 振荡幅值+相位、绑定四元数差分）。
**轴语义靠方向集对比锁定，不能看绝对均值**（盆骨绑定位姿是大旋转，rotvec 逐分量
平均在 ~90° 附近会翻面乱跳）：俯仰 X 由 N/S 前后跑对比锁定（RunN 前倾 -7(Jett
-13.5)° vs RunS 后仰 +12.8°）、侧倾 Z 由 E/W 横移镜像锁定（RunE -4.8° / RunW +9.8°）、
偏航 Y 由振荡幅值确认（跑 11.5° / 走 11.9°，1×/步）。

- GAIT 新字段：`hipsYaw` 跑 0.201/走 0.207rad（与大腿摆同相）；`hipsRoll` 跑
  0.176/走 0.099rad（相位 sin(p+0.83)，摆动腿侧下沉）；`hipsPitch` 跑 -0.15/走
  +0.05rad（常量前倾/微后仰——LB 脊柱零轨道，前倾主体从 spine lean 0.16 移到盆骨，
  spine 只留 0.05 补 kamae 直立）。合成 roll·pitch·yaw·bind（roll/pitch 按 mesh
  世界轴最外层施加，不随 yaw 换轴）。
- 盆骨高度起伏官方 跑 ≤3mm（±0.7cm 峰谷）/ 走、横移恒 0 → bob 收到 0.012/0.006
  （防滑步下限，不再加倍）。
- 横移的盆骨：官方 RunE 盆骨 roll 振荡仅 2.3°、pitch ≈0、恒高（正对瞄准方向）→
  Bot._applyLegPose 在 w>0 时把盆骨按 w 退回 kamae bind（前进跑的三轴轨道不带入
  横移），bind 世界四元数在 _buildCustom 捕获（`_strafeRig.hipsBind`）。
- 侧倾入移动方向上限 0.05→0.12rad（leanInto 系数 0.011→0.02）：官方 RunE/W 盆骨
  侧倾均值 -4.8°/+9.8°（全速 ~6.9°）。
- 浏览器复核方法：轨道差值直接读 clip 数据（`anim.run.getClip()` 找 `Pelvis_*.quaternion`
  轨道算 up 轴倾角：run +10.2° / walk -1.2°，Δ=11.4° = GAIT 口径）；**别用实时
  rotvec 均值判盆骨 pitch/roll**——hips 父链常量节点旋转 + 复合旋转的轴间泄漏会
  把分量搅混，视觉截图与轨道差值才是准绳。横移盆骨快照实测：pull 全程振荡幅值=0
  （成功钉在 kamae bind）。

### 第三批：WalkE 低速横移锚点 + 趾骨蹬地轨道（2026-09-09）

- **strafeStepPose 双锚点插值**（替代 k=speed/5.4 整体缩放）：Sova WalkE 实测膝
  基础 28.1°/峰值 88.7°（摆动幅 60.6°）→ `{base:0.49, swing:1.06, thigh:0.70}`；
  RunE 用既有 GAIT.run 口径。t = (speed−3.39)/(5.4−3.39) 线性插值，走速以下全程
  WalkE 深膝——起步拉出不再是浅膝碎步（旧版 1.15m/s 时膝峰只有 21°，官方走速
  横移本身就是 88.7° 深膝），外展幅随 t 0.75→1。5.4 及以上 = 已验收 RunE 口径
  逐值不变（测试锁定）。
- **趾骨蹬地轨道**：`legAngles` 新增 toe 分量 + `bakeLocomotionClips` 腿链第 4 节
  （父级 = 脚）。官方 L_Toe 实测：2× 步频谐波主导（跑 7.5°/走 8.85°——每步一次
  提踵蹬地），峰值相位取膝摆动峰前 ~0.5rad（蹬地→摆动的时序），只屈不反关节；
  GAIT.toe 跑 0.13/走 0.155rad。横移覆盖时趾保持中性（w>0 写 bind，官方 RunE
  趾行为未量测不做臆造）；死亡烘焙链仍 3 节不含趾（撒手/塌倒不涉及蹬地）。
- 回归验证：235 用例全绿（新增 WalkE 锚点/中点插值/趾幅值与相位锁）；verify-gait
  探针 clip 时长 0.9145/0.5741s 精确、步频 3.484 步/s（官方 3.33 ±5%）、零控制台
  错误；pull（deep straddle 正对横移）/cross（侧视前倾跑+拖腿深屈膝）近远景截图
  评审无回归；盆骨探针 roll/upTilt 谐波与上一批逐值一致（盆骨层未受影响）。

## 附：官方技能道具模型（.blend）获取与接入（2026-09-09）

闪光干扰扩到七类的模型来源与方法。技能道具模型与武器/英雄同源（Rocklan Drive
包），**不在独立 Abilities 目录，而是散在各英雄文件夹里**（Agents/<英雄>/）。

### 可用道具清单（已实测核对官方物体代号）

| 文件 | 官方代号 | 是什么 | 本项目用途 |
| --- | --- | --- | --- |
| `skyeHawkSimple.blend` | `AB_Guide_S0_E_Hawk` | 飞行态追踪鹰（TP 贴图，翼骨 L/R_Wing1-3+Tail） | ✅ `public/models/ability-hawk.glb`，运行时扇翅 |
| `skyeHawkTotem.blend` | `AB_Guide_S0_E_HawkTotem` | 手持鹰图腾（FP 贴图，~30cm） | 备用（手持形态，未接入） |
| `zamboni.blend` | `AB_AggroBot_S0_E_Zamboni` | **就是 Dizzy**（Gekko E，骨骼 Body/Spine/Head/Tail） | ✅ `public/models/ability-dizzy.glb`，悬停摆尾 |
| `bubbletov.blend` | `AB_AggroBot_S0_4_Bubbletov` | 休眠泡泡（globule，~14cm） | 备用（未接入） |
| `shark.blend` | `AB_AggroBot_S0_X_Shark` | Thrash（X 大招鲨鱼） | 非闪光，未接入 |
| `spikebot.blend` | `AB_AggroBot_S0_Q_Spikebot` | Wingman（Q） | 非闪光，未接入 |
| `jettKnife/jettSmoke/sageOrb/sageWall/sovaArrow/sovaBow/sovaDrone.blend` | — | Jett 刀/烟、Sage 球/墙、Sova 箭/弓/无人机 | 非闪光，未接入（同名配方可扩） |

**没有的**：KAY/O 手雷、火男弧线球、Breach charge、Yoru 碎片、Reyna 眼——
各英雄文件夹只有英雄模型（Complex/FirstPerson/Simple；FirstPerson 里也只是
手臂，无手持道具）。这五类保持程序化原创近似。粉丝仓库（abdullah-nadeem-lodhi）
只有四个英雄 GLB，无道具；models-resource Valorant 页仍为空；Sketchfab 需登录。

### 转换与接入配方（在武器配方之上新增三点）

1. **带骨骼导出**：`export_apply=False` + 选中 ARMATURE+MESH（scripts/blend2glb.py
   的 apply=True 会把 armature modifier 烤进网格、丢掉全部骨骼；对照脚本
   /tmp/blend2glb_rig.py 的差异）。导出后 glTF 骨骼节点齐全，Skin 会保留
   （gltf-transform prune 日志打 "Removed Skin" 但内存里仍在——日志误导，别慌）。
2. **朝向**：Blender 侧骨链判头尾（Tail 骨沿 -X → 头在 +X）。Blender→glTF 映射
   (x,y,z)→(x,z,-y)：头 +X→glTF +X、上 Z→+Y、翼 ±Y→±Z。运行时容器 rotY(-π/2)
   即对齐本项目「+Z 喙向 + lookAt(航向)」约定（鹰/Dizzy 通用）。
3. **MRS 补丁 + 压缩**：`node scripts/ability-glb-patch.mjs <src> <out>`（摘
   metallicRoughnessTexture + metal 0.3/rough 0.5 + 贴图 JPEG 重编码 + 量化，
   蒙皮安全）。产物拷 `public/models/ability-*.glb`。
4. **运行时挂载**：FlashSystem `_loadOfficial` 异步加载（document.baseURI 相对
   路径——import.meta.url 相对路径在 dev 下指到 src/ 会 404），就位后与程序化
   近似互斥显隐，加载失败静默回退；骨骼扇动 = 静息四元数 ⊗ 本地轴旋转
   （restQuat 存 userData，直接写 rotation 会覆盖绑定姿态）。

### 浏览器实测

`scripts/verify-flash.mjs`（同 verify-gait 的自驱 Chrome 路线）：七类逐个强制
`flashes._spawn*` + 数值探针（官方挂载/盲时长/近视/等离子/可击毁 pickHit+damage）
+ 关键帧截图。坑：探针打可击毁目标要按 proj.pos 现算瞄准方向（部署点有随机横向
偏移，固定视线打不中 0.32m 球）。

## 附：TP_Core 共享移动集与滑步根治路线（2026-09-11）

### 各英雄 Simple 套装是「剥过跑步机」的变体，TP_Core 才是本体移动真集

129 轮确诊的滑步根因。各英雄 Simple 目录的移动循环（Jett `X_Knives_*`、Sova
`Q_Bow_*`）支撑期脚相对盆骨行程仅 ~46cm；Rocklan 包 **Shared/Simple** 目录的
`TP_Core_*` 共享核心集（本体所有英雄移动共用）扫幅 0.73m，且 RunE/RunW 是真
方向性循环（Jett 集的 E/W 是 N 的导出复件）。**量扫幅别用链式 FK**——parent
字段全坏 + R 侧镜像约定，自建 FK 链两次误诊（一次把 46cm 量成 124cm）；可信
的是单骨局部四元数对比 + 运行时实测（hip→ankle 骨间向量经 mesh 逆旋转）。

- TP_Core 可用清单（已下 `assets-raw/core-psa/`）：Run/Walk×N/E/W、Jump×4 向 +
  JumpLand、Falling、CrouchIdle/CrouchWalk、TurnE/W×45/90/135/180、StopAdd、
  `Death_Land_{Back,Front}Splat_Big`（P2 死亡方向性素材）、RunAdd*_UB（跑动
  上身叠加）、各武器 IdlePose/Aim*_UB。Drive 纯 HTML 列目录法逐级取文件 ID：
  `embeddedfolderview?id=<ID>#list` 正则抽 `flip-entry`。
- **官方脚部 IK 锚（130 轮已接入）**：`L/R_IK_FootTarget` 曲线已导出进
  locomotion.json（`core.*.ik`，盆骨根空间），运行时钉地锚直接采样该曲线
  （Locomotion.sampleIkAnchor，主导作权重选曲线）。三个实现要点：
  ①**目标骨命名与脚反号**——L_IK_FootTarget 跟随右脚（侧偏符号 + 落地窗对齐
  双重验证），采样按对侧取；②**空间映射别乘骨矩阵**——GLB 骨链带 UE 常量节点
  旋转会把锚甩飞，按轴映射（psa 前+X/侧+Y/上+Z → mesh −Z/+X/+Y，上轴另加
  -mesh.y 地面偏移：mesh 原点不在地面）；③锚 世界系支撑期静止 ±2-4cm（脚本
  与运行时双重实测），测试锁「最优支撑窗漂移 <0.15m」。
  物理边界：TP_Core FK 腿曲线扫幅 0.73m ≈ 步幅 45%——锚钉住前 ~0.1s 后腿 reach
  用尽，按 give 混合平滑交回 clip；这与 ripped 数据一致（FK 不带跑步机），残余
  滑步是数据上限而非实现缺陷。

### verify-official-loco 双重积分 bug（所有旧台架数字都在 2× 速度）

台架曾同时 `b.moveToward(vx, dt)` + `g.bots.step(dt, 1)`——manager 内部按 peek
状态**也**调 moveToward，双积分把体速跑成 2×（velX=5.4 实走 10.8）。正确姿势：
台架只设 peek/CONFIG，**绝不自己调 moveToward**，速度档注入
`window.__game.CONFIG.bot.moveSpeed`。修掉后 128 轮的所有数字（滑速 0.43/1.79、
步频 3.48）口径作废。另两坑：走曲线档要在 3.0 m/s 采（3.39 落进跑混合带
`(speed-3.0)/1.6` 掺 24% 跑）；相位分桶要用**被比对 clip 自己的播放头**
（walk 0.867s ≠ run 0.6s，拿 run.time 给 walk 分桶 RMS 虚高 3 倍）。

### 钉地 IK 的三条实现教训

1. **先落位再钉地**：IK 必须用本帧最终 mesh 位姿解算——先解 IK 再挪 mesh，脚
   每帧跟着 mesh 前跳一次（系统性拖尾 = 钉住的脚恰好以体速滑行，p50 恰等于
   体速是它的指纹）。
2. **「越距平滑移交」替代「硬释放」**：锚点被拉远 0.25→0.5m 区间按 smoothstep
   把 IK 目标滑回 clip 脚位——脚从钉住连续加速进蹬地离地；旧的 0.5m 硬释放会
   积攒「松钳弹回」snap（逐帧最高 20+ m/s 的脚速尖峰）。
3. **量滑速要按脚连续追踪**：双脚在换支撑瞬间「低脚」身份翻转，按低脚算速度
   会把两只脚的位置差算成 20+ m/s 假尖峰——p95 假高全拜它所赐。
