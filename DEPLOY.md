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

仓库内置模型已经过 [gltf-transform](https://gltf-transform.dev/) 量化压缩（几何 f32 → 8~14bit，KHR_mesh_quantization，three.js GLTFLoader 原生支持、无需解码器），整体 -46% ~ -55%。

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
> 这些 .glb 已按 `.gitignore` 的 `models-optional/**/*.glb` 口径**移出 git 版控**（150MB 级死重，clone/CI 不再拉取）；仓库历史中仍存在，彻底清除需 `git filter-repo`；新环境请按下表来源自行下载放置。

### 来源清单

| 内容 | 来源 | 路径/文件 |
|---|---|---|
| 英雄（jett/phoenix/sage/sova，带贴图+kamae 待机动画，UE 骨架） | GitHub 粉丝仓库 [Valorant-3D-Immersive-Guide](https://github.com/abdullah-nadeem-lodhi/Valorant-3D-Immersive-Guide)（Sketchfab 导出） | `dist/{jett,phoenix,sage,sova}/*_animated.glb` → 拷为 `public/models/agent-*.glb` |
| 武器（32 把 .blend：Vandal/Phantom/Sheriff/Classic/Ghost/Operator/Odin…含皮肤变体） | YouTube Rocklan 模型包的 Google Drive 文件夹 | `drive.google.com/drive/folders/17pJMWTGJloEFU86NE9sIOBlH4VB9rFVh` → `Weapons/` 子目录 |
| 武器纯几何（无 UV/贴图，仅素材备用；**不入库**，本地放置） | GitHub [codex-vibe-fps](https://github.com/yseho031018/codex-vibe-fps) | `assets/models/weapons/*.glb` → `models-optional/weapons-raw/` |

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
4. **音频口径**：跳跃滞空静音 + 落地闷响（onFootstep(5.4) 复用空间化脚步管
   线）、蹲走拉出全程静音（本体蹲走无声=战术价值）——静音门在 mixer 脚步触
   发处（_jump || _crouchWW>0.5）。
5. **过渡平滑性回归门**：`scripts/verify-transitions.mjs` 量测全部过渡（起跳
   坡/滞空 crossfade/落地/蹲走起立）的 Head 帧间位移与 Spine1 角步进，断言
   ≤0.09m/≤4°；改动跳跃或蹲走链路后必跑。

## 附：官方第一人称手臂（Phoenix 1P）获取与还原（2026-09-15）

**产物**：`public/models/arms-official.glb`（1.19MB，Phoenix 官方 1P 手臂：7471 顶点
蒙皮 + 104 骨官方 1P 骨架 + 官方 DF/MRAE/NM 2048² 贴图内嵌；动画轨道
`vandal_idle` / `phantom_idle` = 官方持枪待机姿势）。运行时 `src/weapons/OfficialArms.js`
装配，glove/hands 开源件降级为回退件。

**素材来源**（均在 Rocklan 官方包 Drive，文件夹 ID 见上附录）：
- 手臂：`Agents/Phoenix/phoenixFirstPerson.blend`（本地 `assets-raw/abilities/`，
  贴图已打包在 blend 内）。骨架名即官方 1P 约定：`R/L_{Clavicle,Shoulder,Elbow,Hand}`
  + 五指 `{Index,Middle,Ring,Pinky}{0..3}` / `L_Thumb{1..3}` + `Camera`（1P 相机骨，
  head=相机位）+ `R/L_WeaponPoint` / `MasterWeapon` / `WeaponADS`（官方挂枪点）。
- 官方持枪姿势：`Animations/Shared/First Person/FP_Core_{AK,Carbine}_S0_IdlePose.psa`
  （AK=Vandal、Carbine=Phantom；Weapon Animations/<枪>/ 目录里只有 Fire/Equip/Reload，
  idle 全在 Shared 下）。已下载 8 个 1P psa 到 `assets-raw/fp-arms-psa/`。

**psa → Blender 姿态应用配方**（`scripts/fp-arms-from-psa.py`，渲染验证双手呈官方
握持手型、MasterWeapon 落在官方腰射枪位）：psa 局部四元数**不能**直接按父链 ⊗ 合成
（Rocklan blend 的骨局部已被 Blender 化）。用 Befzz blender3d_import_psk_psa 的
"非 psk 骨架"分支配方：
```
post_quat = q_parent⁻¹ ⊗ q_bone        # rest 旋转差（blend 层级父骨）
chanQ = (p_quat ⊗ post_quat)⁻¹         # 根骨先共轭 p_quat（bDontInvertRoot=True）
chanP = post_quat⁻¹ ⊗ (p_pos×0.01 − orig_loc)
pb.rotation_quaternion = chanQ ; pb.location = chanP
```
（psa 位置 cm→m；父链用 blend 层级——BONENAMES+72 的 parent 字段与实际不符）

**GLB 导出**（`scripts/fp-arms-export.py`）：姿势在 Blender 摆好后**烘成 action** 再
随 GLB 导出动画轨道（`export_animation_mode='NLA_TRACKS'`，bind=ref）——比手工换算
通道稳健（glTF 导出器骨节点约定自洽）。两个坑：① NLA 轨道建好必须立即 `mute=True`，
否则 depsgraph 求值会把后续 apply_pose 的通道覆盖回第一条（四姿势全变第一个姿势即此）；
② Blender 4.5.9 无 `export_bone_directions` 参数。

**贴图补丁** `scripts/arms-glb-patch.mjs`（MRAE→glTF ORM 语义不一致，摘除 +
metal 0.02/rough 0.85 布料参数；法线保留）→ `scripts/optimize-models.mjs`（7.4MB→
1.19MB；prune 会删掉一个冗余 Skin，主 skin 104 joints 完好）。

**运行时装配**（OfficialArms.attachOfficialArms）：
1. cloneSkinned 实例 + 动画轨道首帧写骨局部量 = 官方姿势；
2. 三点相似拟合贴枪：官方 `R_Hand`/`L_Hand` 骨 ↔ 现役枪 GLOVE_POSES 腕锚（与手套
   路径同一标定），官方 `Camera` 骨 ↔ vmScene 原点（1P 相机位置，眼对眼）；旋转由
   三点定向、缩放只取腕-腕边（握把到护木的真实跨度）、**平移按右腕精确锚定**（腕轴
   已被旋转+缩放精确映射 → 双腕同时零误差落锚；相机点只承担姿态余量——两侧三角形
   不相似，质心式定位会把残差摊到手上，实测双腕偏 11.4cm 即此因）；
3. `vmHolder.attach(root)` 保持世界变换 → 后坐/摇摆/ADS 缩放全程手不脱枪。
（四五轮后终态：枪本地系两点拟合 + 数据解滚转，root 直接挂 vm 下——见末两节）
切枪重摆走 `weaponMeshFor`（`_armsPoseFor` 键），非 GLB 枪（Sheriff 等）自动隐藏。
`_animateHands` 逐指动画对官方手臂停用（官方姿势自带扳机指放置，骨名也不兼容）。

**后续可扩展**（数据已就位未接入）：`FP_Core_*_S0_{Fire,WalkAdd,RunAdd,Equip}.psa`
官方 1P 开火后坐/移动摆动/切枪动画（同一管线烘轨道，运行时插值播放）；
Phantom ADS 官方姿势 = `FP_Core_Carbine_S0_Aim2{E,S,W}.psa`（Aim2N 缺失）；
其余英雄 1P 手臂在 Drive `Agents/<英雄>/` 同路径（KayO 已在本地 abilities/）。

### 附：官方 1P 手臂二轮打磨（2026-09-15 下午）

**腕锚校准（ARMS_ANCHORS）**：GLOVE_POSES 的腕锚是为 J-Toastie 手套掌型调的，
官方手掌相对腕骨偏置不同——直用时左手悬空 11-20mm（指尖到枪面）。页面内扫描
（双手五指尖到枪面最近顶点距离均值最小化 + <3.5mm 穿插罚项，粗 6mm/细 2.5mm
两轮网格）收敛出官方手臂专用锚：
```
vandal:  handR [0.257, 0.016, -0.072]   handL [-0.239, 0.0385, 0.0175]
phantom: handR [0.239, -0.0285, -0.056] handL [-0.2025, -0.003, 0.0185]
```
收敛后双手指尖 3.6-15.5mm（与手套路径同档）。调参缝：`globalThis.__ARMS_ANCHORS`
运行时可覆盖（OfficialArms 读取），扫描方法见本节。

**官方 fire 加法层（vandal_fire / phantom_fire 轨道）**：
- 数据：`FP_Core_{AK,Carbine}_S0_{Fire,FireAdd}.psa`（20 帧 0.317s，帧 0≈ref、
  踢完归零）。**IdleAdd 系（AK AltIdleAdd / Carbine IdleAdd）实测 83 帧全零**——
  官方呼吸不在这批文件里（手臂挂 vmHolder 已继承整枪呼吸摆动，够用）。
- 导出坑 ×2：① Blender 默认 24fps——psa 60fps 采样烘帧后轨道被拉长 2.5 倍
  （fire 0.833s 即此因），导出前 `scene.render.fps = 60`；② optimize 的 resample
  把恒定轨道抽稀到 2 键——运行时必须按每骨自带 times 采样，不能按全局帧号索引。
- 运行时（OfficialArms.buildFireLayer + animateOfficialArmsFire）：fire 是
  「ref 姿势 + 踢动」的全量局部轨道——加法增量以 **fire 轨道自身帧 0 为参考**
  D(t)=F(0)⁻¹⊗F(t)（makeClipAdditive 默认口径）。以 idle 为参考会引入 idle↔ref
  常量偏差（实测 R_Elbow 恒偏 87°）。`_fireOne` 置零 t 重触发（连发逐发重启），
  `_animateHands` 每帧推进 `final = base⊗D(t)`。R_Elbow 峰值 ~10° 于 117ms、
  0.333s 归零；开火中右手按官方踢动离锚 ~19mm（官方真实行为），射后精确归位。

**实测回归锚点**：腰射/ADS 往返/射后 双腕-锚误差恒 0.00000（手臂挂 holder 随
枪刚体运动 + fire 增量只叠在骨局部量上，不动根变换）。

### 附：官方 1P 手臂三轮增强（2026-09-15 傍晚）

**官方 equip 切枪动画（vandal_equip / phantom_equip 轨道）**：
- 数据：`FP_Core_{AK,Carbine}_S0_Equip.psa`（100 帧 1.65s，60fps）；**末帧与 idle
  逐骨 0.0° 分毫不差**——进出 equip 无需混合，天然无缝。
- 运行时（animateOfficialArms 管线）：两段式切枪（SWAP_AT=0.35）阶段 1 旧枪
  手臂保持 idle；换枪瞬间 attach 恰为 equip(0) 起点，阶段 2 按
  `u = (epc−0.35)/0.65` 采样（1.65s 官方曲线压进 0.65s 抬枪窗），开局首取枪
  同路径。管线：`base = equip(u)`（切枪中）`否则 idle`（见下条 ADS 结论），
  `final = base ⊗ fireD(t)`（equip 期间无法开火，天然互斥）。

**Aim2 数据结论（phantom_ads 撤销）**：Aim2E/S/W 是**瞄准方向偏移**（±偏航，
E-W 仅差 ≤17.4°；E/W 四元数半球对齐平均 ≈ identity，合成姿势与 idle 仅差
0.49°）——不是 ADS 抬枪姿势。官方 ADS 抬枪在武器自身动画（我们由 holder
刚体完成），手臂在 ADS 下就是 idle。运行时 ADS 混合管线保留但无轨道时闲置。
另：合成绝对姿势的正确复合是 `idle ⊗ delta`（后乘，与 fire 层同构）；直用
Aim2 增量会把 R_Hand 放倒原点（idle↔增量格式不可混）。

**移动叠加层结论（未接入）**：`FP_Core_AK_S0_{WalkAdd,RunAdd}.psa` 实测帧间
<0.3°、近恒定——与 IdleAdd 同为空数据（官方移动摆动不在这批文件；手臂挂
vmHolder 已继承整枪 bob/breath）。Phantom（Carbine）侧 Drive 仅 14 个 clip，
无移动/跳跃/蹲族——跨枪借用 AK 移动层亦无意义（源数据本身为空）。

**GLB 终态**：1.65MB（idle×2 + fire×2 + equip×2 轨道，104 骨蒙皮 + 官方贴图）。

### 附：官方 1P 手臂四轮——网格级穿模修复（2026-09-15 深夜）

**等价手定尺（OFFICIAL_HAND_EQUIV = 0.082）**：官方手（腕→中指尖 ~19-22cm）必须
缩放到 glove 路径的手大小（相机系 8.2cm），锚才是为这个尺寸调的。手长的取法三条路
只有一条对：
- ✅ **骨链分段求和**（`R_Hand→Middle0→1→2→3` 逐段距离相加）——姿势无关的解剖长；
- ❌ 腕锚跨度比（|dstL−dstR|/|srcL−srcR| ≈ 0.78）——锚是为 8.2cm 手调的，会把手
  放大 ~1.7×，皮肉整体嵌枪（实测 502 顶点入枪）；
- ❌ 腕→尖直线距（弯曲握持姿势下仅 ~5cm）——会放大 3 倍（scale 1.58 即此因）。

**穿透检测（扫描的目标函数）**：手臂蒙皮顶点（`applyBoneTransform(i,v)` 后
`localToWorld`——两步都不能省）对枪三角做 **+X 世界光线奇偶判定**（odd=枪内）。
加速结构：枪顶点 30mm 3D 桶（broadphase，>45mm 直接跳过）+ 三角 YZ 平面 2D 桶
（光线只测所在格的三角）。**坑：最近顶点+法线符号法会漏深度嵌入**——6mm 距离门
在粗网格区（握把）把大量枪内顶点判为"非接触"（符号法 12 vs 奇偶法 407 的假象即此），
奇偶才是真值。

**锚扫描收敛（ARMS_ANCHORS 终值，穿透计数 + 十指尖悬停距离双目标）**：
```
vandal:  handR [0.24, -0.009, -0.109]     handL [-0.247, 0.0225, -0.0045]
phantom: handR [0.237, -0.0495, -0.097]   handL [-0.2065, -0.017, 0.0025]
```
基态（GLOVE_POSES 锚 + 等价手定尺）495/325 顶点嵌枪（掌根/鱼际）→ 收敛后残留
45/12（旧世界基口径）全在玩家视角被枪体遮挡区（左前臂下侧/拇指远侧）。

### 附：官方 1P 手臂五轮——扭曲根治：枪本地两点拟合 + 数据解滚转（2026-09-15）

**病因**：三点拟合的第三个点（相机）在 attach 时刻读实时世界位，而切枪 attach 恰在
holder 抬枪瞬态中段——滚转被瞬态倾斜共轭污染（phantom 真路径 333→407 顶点嵌枪
稳定复现；vandal 开局 instant 无倾斜故侥幸正确，扫描与真路径对不上即此因）。
迭代史：世界系（倾斜泄漏）→ holder 本地系（单位混乱，臂掉 0.9m）→ attach 后本地
滚转（与锚方程冲突无解）→ **终态：纯枪本地系两点拟合，相机实时位姿完全退出**：
```
q = setFromUnitVectors(官方腕腕轴 → 锚轴)          # 双腕精确落锚
滚转 = 数据解夹角（见下）                            # 绕锚轴 premultiply
sLocal = 0.082 / handLen骨链 / 枪链世界系数           # 等价手定尺
root.position = dstR_g − (q·srcR)·sLocal             # 右腕精确锚定（左腕随轴对齐同精）
root 挂 vm 下（枪的一切刚体运动手臂同行，且与 attach 时刻无关）
```
位置公式坑：root 的局部系是**官方骨骼系**——srcR 必须用官方系本体（曾把 5.7u 的
枪本地向量塞进公式，双腕偏 0.9m）。

**数据解滚转（ARMS_ROLL 手调常数退役）**：手调滚转两轮换基即废（世界系→holder 系
→枪本地系）。终态由两边数据直接解出：
```
d1 = 官方 Camera 骨 − 官方双腕中点        （官方 pose 自带「臂面相对官方相机」）
d2 = rest 相机 − 锚中点                    （rest 取景 = vmBase + vmBaseYaw/Roll +
                                            baseVmScale + vm 本地阵的逆作用于原点）
roll = atan2((d1⊥×d2⊥)·span, d1⊥·d2⊥)    （两方向在 span 平面上的有向夹角）
```
全程静态常数（相机的实时位姿不参与——倾斜泄漏的源头），attach 结果与切枪瞬态无关。
vandal 解出 −167.1°——数值大≠错：setFromUnitVectors 的最小旋转在 ⊥ 平面里滚转
本来就是任意的，−167° 只是那个任意偏置。`globalThis.__ARMS_ROLL` 保留为**加性**
微调缝（数据解之上叠加，vhtdbg 扫描用）。

**指标陷阱（为什么不能只扫 pierce 选滚转）**：pierce 随 |roll| 双向单调下降
（两枪都在 0° 出峰值）——极端滚转把手转离枪、穿透自然变小，但那正是扭曲。目标函数
必须 = 奇偶穿透 + 指尖贴枪 + 肘方位 + 截图视觉终审。

**终态实测**（45mm 带内奇偶，双枪零手调）：
- vandal：35 顶点残留 / 指尖最小 1.4mm / 双肘下方自然位；截图评审 7.5/10、扭曲已解决；
- phantom：56 顶点残留 / 指尖最小 2.4mm；截图评审 7/10、无扭曲；
- 残留均在被枪体遮挡区（截图上 2-4px 边缘重叠）。
回归：npm test 384/384；腕-锚误差恒 0；清理后代码复测数值分毫不差。

### 附：官方 1P 手臂六轮——锚重扫（五轮拟合基）+ 腕锚口径修正（2026-10-01）

**病因**：四轮收敛的 `ARMS_ANCHORS` 是为三点拟合基调的，五轮换基（枪本地两点
拟合 + 数据解滚转）后从未重扫。两点拟合把右腕精确钉锚、左腕落在
`dstR + spanDir×(|srcSpan|·sLocal)`——左锚只在 `|handL−handR| = L*`（实际落腕
跨度）时可达；旧锚对半径与 L* 差 6.2/20.9 本地 mm（≈1.9/6.5 世界 mm），左腕
从未真正落锚。旧「腕-锚误差恒 0.00000」是审计脚本 `wristErrMm` 漏 ×1000 的
米标毫米假象（arms-audit.mjs 已修；指尖口径本就 ×1000 所以一直是对的）。

**扫描器**（scripts/arms-anchor-scan.mjs）：页内坐标下降，`__ARMS_ANCHORS` 覆盖缝
逐候选 `_armsPoseFor=null` 强制重摆。三条铁律（各翻车一次换来）：
- 流形：handL 候选投影回 handR 为心、L* 为半径的球面（保方向锁半径）→ 双腕
  真实零误差；基线投影点物理姿势与旧锚完全一致（只改名义值）。
- 方向：「+X 光线奇偶」是方向敏感算法——vm 本地系 +X 是另一条世界方向
  （vmBaseYaw≈11.5°+枪自转），非凸枪网穿棱数全变（同帧同姿势实测 34→225）。
  奇偶必须全程世界系（audit 口径）。
- 同帧：枪/臂同一 updateMatrixWorld 瞬间取位——枪 setup 存 vm 本地系（刚体
  不变帧），每 eval 经当前 vm.matrixWorld 搬回世界建桶；跨瞬间世界冻结会被
  holder 呼吸相位漂移污染（实测 28↔34 抖动）。三角阵存顶点索引、展开时同步
  变换（曾存坐标值，eval 重建世界 verts 后量纲错位 → pierce 恒 0 假绿）。
硬约束：pierceVisible=0 一票否决、世界系腕锚误差≤0.2mm、肘移≤40mm（防「把
手臂转离枪」）、指尖悬停退让设限、不碰 `__ARMS_ROLL`/`OFFICIAL_HAND_EQUIV`。

**收敛**：vandal 34→27（handR y −9mm 下探、handL 沿流形微转，指尖最小
1.38→0.52mm 更贴）；phantom 49→9（**handR 锁基线**守握把接触——放开 handR
可到 5 但要多退 1.4mm 拇指悬停，守恒优先；收益全在 handL 沿流形 ~13mm 重落，
拇指 6.9→5.0mm）。审计口径全绿：pierceVisible 双枪 0；腕锚误差真 mm
0.006/0.0045；手尺 8.2cm 不变形；截图终审无悬空/无可见穿模/无扭曲（phantom
左拇指从撬出改为贴轨，握持更实）。

**残留去向**：27/9 全在枪体遮挡区。phantom 再往下压（→5）与指尖贴枪直接
冲突——嵌枪肉点恰在握把/护木接触带，锚扫描（动骨）已到边界；下一步是网格级
去穿透（推皮肉不动骨， DEPLOY 四轮附录授权的独立一轮）。

### 附：官方 1P 手臂七轮——网格级去穿透（推皮肉不动骨）（2026-10-01）

**定位**：六轮锚重扫后残留 vandal 27 / phantom 9 全在握把/护木接触带——动骨到界
（再压必退指尖贴枪）。本轮按四轮附录授权的独立一层走**网格级去穿透**：推出向量
按蒙皮线性（s(p+Δ)=s(p)+B_lin·Δ，B_lin=顶点蒙皮混合的 3×3 线性部）映射进静止
位姿，骨系零改动 → 腕锚/手尺/肘位天然不变（审计复核 0.006/0.0045mm、8.2cm
分毫不动），fire/equip 姿态下偏移随骨走。

**烘焙器**（scripts/arms-depenetrate-bake.mjs + 收尾驱动
scripts/arms-depenetrate-finish.mjs）：页内同帧世界系（枪 setup 存 vm 本地、
eval 经当前 vm.matrixWorld 搬回，六轮铁律③）奇偶迭代推出；种子=已发布偏移表
（live import，增量烘焙自洽）；UV 缝重复顶点按静止位分组同推（防撕面）。

**三条血泪坑**：
- 单位：偏移表活在几何静止（bind）系，与世界的比例 ≈1:62——「rest mm」不是
  世界 mm，推距上限/统计必须以世界位移记账（曾把 rest 尖刺误读成 mm）。
- 双壁震荡：非水密枪网里「最近面退出」会出 A 壁入 B 壁（无上限实测叠出
  390+ 尖刺）——每顶点累计世界推出 60mm 硬上限 + 试探步长封顶。
- 收尾判定必须在**审计同款节律**下做：审计流程确定可复现（同状态两跑 1/2、
  1/2 分毫不差），任意 rAF 相位的「多瞬间采样」只会对接触刀刃顶点群（手皮
  贴枪面）打地鼠，越推越多。

**视觉红线（两次回退实录）**：vandal 袖口布顶点组（1765 及重复 2344/2345/
2348/2349）被 32mm 试逃拉出**白布尖刺**、phantom 左拇指尖 3835-3843/6515-6595
簇被推出**星芒撕裂**——均回退。裁决：布料/贴面刀刃顶点的嵌入是自然接触态，
强行推出=可见撕裂，宁留残。最终表=六轮表基础上「审计点名残余」的最小补推：
vandal +1873（0.35mm 微推）等 45 顶点、phantom 保持 8 顶点原深推。

**终态**（45mm 带内奇偶，双审计复现）：vandal 27→**0**、phantom 9→**2**，
双枪 pierceVisible=0；指尖最小 0.52/1.52mm、腕锚误差 0.006/0.0045mm、手尺
8.2cm 全部维持；截图终审 vandal/phantom 与六轮终态目视无差（袖口针、拇指
星芒均已消除）。phantom 残余 2 = 枪口螺母薄壁区的拇指尖顶点（距枪顶点
1.0/2.3mm），有界位移（≤60mm）内无偶数落点，修复即撕裂——接受为该口径的
噪声底层，留待网格修模或口径演进。回归：npx vitest run
tests/official-arms.test.js tests/glove-poses.test.js → 19/19。

### 附：官方 1P 手臂八轮——视觉评审回退与归因（2026-10-01）

**评审结论**（右手护木握持区打分 vandal 5 / phantom 2）：左手「不规则团块/锯齿
下缘」、phantom「指根陷枪体+指尖穿顶、金戒指指 Z 拐弯带黑色裂缝、红色网格凸
起、掌背锯齿、指节粗短」。

**归因（6× 裁剪逐框对比 r1-final vs 现态，out/rev-*-*.png）**：
- vandal「团块/锯齿」= 七轮手术表增补的 ~18 个左手顶点 ±2mm 世界级位移叠加在
  官方手型上的变形贡献（45 顶点表混入了非审计残余的手术追逐项）→ 已回退：
  最终 vandal 表 = 六轮 v1 精确 26 条 + 1873 微推（0.35mm 世界，审计点名的唯
  一残余），共 27 条。回退后手部区域像素差 vs r1 平均 4.33/255（≈1.7%，边缘
  级），目视与 r1 一致。
- phantom 全部条目（指根被护木顶轨遮挡读作「陷进」、指尖过轨贴背景墙、金戒
  指指节 Z 拐弯、指节比例）在 r1-final 逐框一致——系官方 Phoenix 1P 握姿在
  本取景下的固有观感，非本轮去穿透引入（v1 表 8 组全为单顶点、亚毫米世界推
  距，页内展开验证无重复顶点遗漏）；「红色网格凸起」r1 同位同在（金戒指指侧
  的皮肤小凸起）。
- 数值终态维持：vandal 0/0、phantom 2/0（45mm 带 +X 奇偶，双跑复现），指尖
  0.52/1.52mm、腕锚 0.006/0.0045mm、手尺 8.2cm。

**边界结论**：指节 Z 拐弯/比例/握持可读性属**官方姿势与模型特征**，网格级
去穿透（本轮类）不可修——动骨即扭曲（五轮指标陷阱）、动模型超出还原范畴。
若评审坚持此观感不可接受，需要的是：左手锚沿护木下移的姿势重调（六轮扫描
空间内、会动指尖贴枪指标，须重扫）或官方模型指节修模——均超出本轮授权。
工具沉淀：out/rev-* 裁剪对比流程 + 手部区域像素差度量（r1 vs 现态 ≤1.7%）。

### 附：官方 1P 手臂九轮——握持润饰补丁（评审可见穿模修复）（2026-10-01）

**评审焦点**（二轮视觉评审）：phantom 左拇指**横跨枪管**（网格互陷、交界杂色，
评审标【穿模】）、vandal 左三指尖**过导轨上缘**（评审标【穿模】）、phantom 袖口
布拧转（【扭曲】）。几何根源：官方 idle 指姿按官方枪体前段尺寸烘焙，我们的
phantom 枪管/导气箍更靠前，拇指正好压在枪管上；vandal 指尖伸过导轨顶。

**修复类**：握持润饰补丁（指尖姿势层）——`ARMS_GRIP_PATCH`（OfficialArms.js，
`export`）按骨名叠加**骨本地小旋转**（`final = base ⊗ delta`，`_patchQ` scratch），
只动 L_Thumb*/L_Index*/L_Middle*/L_Ring* 指骨；腕/臂锚与手定尺零改动。调参走
`globalThis.__GRIP_PATCH` 覆盖缝 + scripts/grip-patch-tune.mjs / grip-patch-tune2.mjs
（逐骨/轴/角度候选截图拼对比 + 页内审计同口径 pierce 计数）。

**终值（三轮评审后定稿）**：phantom `L_Index2/L_Middle2/L_Ring2 +本地X 75°`
（扇形竖指带背景缝 → 整排包覆枪体，隐藏嵌枪 29→2）+ `L_Thumb2 +本地Y 25°` +
`L_Thumb3 +本地Y 15°`（拇指整段沉到枪管下侧、尖端离开枪管轮廓——指尖互陷
【穿模】消除）；vandal `L_Index2/L_Middle2/L_Ring2 +本地X 40°`（指尖收拢到护
木后侧）。调参器实测过 Yp6/9/12/15、L_Thumb2 15/25/35、3×20/30/40/60/75+远端
组合——深层卷曲（X60+）同时把隐藏嵌枪从 29 压回 2（指尖离开护木顶贴持区、
包到远侧），视觉与数值同向。

**代价与守恒**（node scripts/arms-audit.mjs 双跑复现）：phantom 嵌枪 2→**29**
（全部隐藏，pierceVisible=0——拇指段下摆压进护木前顶的贴持接触面），这是
「可见互陷 → 隐藏贴持」的显式交换，按评审优先级（可见穿模优先）接受并如实
记录；vandal 0/0 维持；指尖 0.52/1.52mm、腕锚 0.006/0.0045mm、手尺 8.2cm
全部不变。截图终审：phantom 枪管完全露出、无互陷杂色；vandal 导轨上缘只剩
包握指节轮廓。**未修**：袖口布拧转（布料网格，推顶两次实测撕裂——布/贴面
接触保持原样）、手指拱高与粗细比例（官方模型特征）。回归：npx vitest run
tests/official-arms.test.js tests/glove-poses.test.js → 19/19。

### 附：六轮：持续穿模收敛（2026-09-30，总账）

本节合并上文六~九轮分册（锚重扫 → 网格级去穿透 → 视觉评审回退 → 握持润饰
补丁），作为本次持续穿模收敛的总账与终态归档。

**审计方法**：`node scripts/arms-audit.mjs --out out/arms-audit-*.json --shots
out/arms-shots-*`——自注入 vite dev server（--strictPort 随机口）+ playwright
接管系统 Chrome → 开始训练、冻结 Bot → 逐枪 switchTo + 等待 idle 稳定（equip 完/
无 pending/fire=∞/adsBlend=0）→ 页内按四轮口径审计。
**可见性分类口径**：pierceTotal = 手臂蒙皮顶点（applyBoneTransform → localToWorld
两步不可省）对枪三角 45mm 带内 +X 世界光线奇偶判定（odd=枪内）计数；
pierceVisible = 玩家眼（vmCamera 位）→ 顶点射线对枪体遮挡测试（命中严格先于
顶点），不可见嵌入单独计，不算可见穿模。配套指标：十指尖→枪顶点最近距离
最小值（mm）、双腕→锚最大误差（mm，×1000 口径修正后）、腕→中指尖骨链相机系
表观长度（cm，标称 8.2）。

**逐轮数字**（奇偶嵌枪/可见）：
- 基线：vandal 34/0，phantom 49/0（指尖 1.38/2.40mm，腕锚「0.0019/0.0065」系
  米标毫米假象，真值 1.89/6.55mm）；
- 第 1 轮（锚重扫，五轮拟合基下 L* 流形投影）：vandal 27/0，phantom 9/0，指尖
  0.52/1.52mm，腕锚真零（0.006/0.0045mm），手尺 8.2cm；
- 第 2 轮（网格级去穿透，静止位偏移表）：vandal 0/0，phantom 2/0，其余指标维持；
- 视觉 1~3 轮（评审回退 + ARMS_GRIP_PATCH 握持润饰）：袖口白刺/拇指星芒两次
  回退；phantom 三指 X75 整排包覆（隐藏嵌枪 29→2 后因拇指贴持回至 30）+ 拇指
  段下沉消除枪管互陷；vandal 维持 0/0（评审 9 分通过）。

**终态**（node scripts/arms-audit.mjs 与 --confirm 双跑复现；out/arms-audit-r5.json /
out/arms-audit-r5-confirm.json）：vandal 嵌枪 0（可见 0）、phantom 嵌枪 30（可见
0——拇指贴持接触面，为消除可见枪管互陷的显式交换；中途 29 值为 X40 指卷 +
拇指 Yp15 的中间态），指尖最小 0.52/1.52mm、腕锚误差 0.006/0.0045mm、手尺
8.2cm；vandal 视觉评审 9 分通过、phantom 可见互陷/扇形竖指两项已修。固化参数：
ARMS_ANCHORS（L* 流形锚）、ARMS_DEPENETRATE（静止位偏移表）、ARMS_GRIP_PATCH
（指骨润饰旋转）——全在 src/weapons/OfficialArms.js，滚转保持数据解零手调。

**遗留**：① phantom 拇指贴持面隐藏嵌枪 ~30（拇指夹在枪管与护木顶之间 ~3mm
间隙内，任意下摆必嵌入；消除需官方模型指节修模或贴持面加厚）；② phantom 袖
口布拧转/掌背锯齿/缠布锯齿边（官方模型布料与缠布设计，推顶两次实测撕裂）；
③ 指节比例/拱高观感（官方模型特征）。三者均为官方模型/姿势特征或奇偶口径的
接触带底层，不动骨不加假的的前提下收敛到位。

### 附：七轮：phantom 专项收敛与相交口径（2026-10-01，系列总账）

本节汇总 2026-10-01 的 phantom 专项收敛系列（十~十八轮分册详后），含相交口
径的算法与取舍、逐轮轨迹与终态。

**三角对相交口径（intersectTris / intersectVisible，arms-audit-fn.mjs 文件头
为准）**：奇偶法只判「顶点在枪体内部」，对「穿透而出」的顶点结构性漏报——
新增口径直接测网格对网格。判定=Möller 型三角-三角区间法（非共面：两三角在交
线上的投影区间求交→交线段；退化点接触 <0.1mm 计 touchPairs、共面重叠以两
AABB 交叠区中心近似计 coplanarPairs，均计入相交）；「恰在平面上」阈值
EPS_D=1e-12m（远高于 double 噪声、远低于几何特征）；broadphase=枪三角 YZ 桶
反查 + x 向快筛（AABB 重叠是三角相交的必要条件，无漏）；计数去重到**臂三角**
（原始对数记 diag.intersectPairs）；intersectVisible=相交臂三角的任一交线段
中点从玩家眼可见（眼→中点射线不被枪体严格先挡，与 pierceVisible 同源）。
已知盲区：皮肤在枪体缝隙「之间」可见（非 inside、非被遮挡）不计入——评审曾
指「机匣-弹匣缝隙露肤」即此类，属锚定掌位的遮挡关系而非穿模。

**逐轮轨迹**（嵌枪/可见/相交/可见）：
- 起点：vandal 0/0/75/0，phantom 30/0/27/0（指尖 0.52/1.52mm，腕锚
  0.006/0.0045mm，手尺 8.2cm）。
- 第 1 轮：诊断证实评审尖刺疑点=phantom 网格级去穿透表——页内 B_lin 实测其
  拇指尖 4 顶点世界位移 7.3~9.8mm（七轮「亚毫米」系把 rest 单位误当世界 mm，
  rest≈世界×5.8），ARMS_DEPENETRATE.phantom 整表清空
  (src/weapons/OfficialArms.js)，vandal 表/骨系/锚/握持补丁零改动 →
  phantom 32/0/36/0，拇指尖撕裂消除。
- 第 2 轮：左手整指包握——ARMS_GRIP_PATCH.phantom 新增近节 +Y35°（Index/
  Middle/Ring1）+ 小指收拢（Pinky1 +Y20°、Pinky2 +X55°），保留中节 X75° 与
  拇指 Y25/15°；轴物理：零偏移骨架骨长轴=局部 X（*2 旋转不动 *3 节点），
  *1 绕 Y+ 才是整指摆近侧的包握向 → 32/0/36/0（扇形指消除）。
- 第 3 轮：袖口拧麻花正解——新增 L_Twist2 +X45° 把官方袖扣带卷回腕侧 →
  32/0/38/0（+2 相交为候选共同代价）。
- 第 4 轮：包握角定稿——新增 L_Hand +X−20°（腕骨绕关节滚转）→ phantom
  4/0/31/0（指尖团退轨顶后、拇指尖脱离护木顶压持带）。
- 视觉 1~5 轮（评审驱动修正/回退）：视觉 1 后证 L_Hand −20°+Twist2 45° 致扭
  （腕反折/拇指蹼膜/袖口漏斗）整体回退并扫描 vandal 深卷/腕滚转全劣化；视觉
  2 后 vandal 左拇指落位 L_Thumb1 +Z−25°（悬空 15.8mm→贴合 1.6mm，vandal
  3/0/75/0）；视觉 3 后袖口微滚 L_Twist2 +X8°（透缝变窄）与拇指改 X15 钩持
  （L_Thumb2 替换 Y25，嵌枪 32→10）；视觉 4 后指列收敛（Index1 +Y42/
  Ring1 +Y40，指团间隙闭合、金戒指露边缩小）；视觉 5 微扫 7 候选全中性-劣化
  ——姿势层触底，零代码改动归档。

**终态**（node scripts/arms-audit.mjs 双跑复现）：vandal 3/0/75/0（指尖
0.52mm、腕锚 0.006mm、手尺 8.2cm，九分评审态）；phantom 10/0/38/0（指尖
1.52mm、腕锚 0.0045mm、手尺 8.2cm）——双可见口径双枪 0。固化参数全在
src/weapons/OfficialArms.js：ARMS_ANCHORS（L* 流形锚）、ARMS_DEPENETRATE
（仅 vandal 表）、ARMS_GRIP_PATCH（phantom：包握/收敛/拇指钩持/袖口合缝；
vandal：三指 X40 + 拇指 Z−25）。调参器入库：grip-wrap-tune / cuff-roll-tune /
grip-deepen-tune / vandal-thumb-tune / phantom-undo-tune / arms-diag /
arms-cuff-diag{,2,3} / vandal-{jag-diag,ab-nodepen,bind-diag,thumb-tune} /
ring-diag。

**遗留（姿势层触底，需模型层/锚层授权）**：①金戒指露边（指骨杠杆到界，十六
轮 9 候选）；②皮肤折痕锯齿（握拳折痕呈现，十四轮 A/B+绑定位+射线三重取证）；
③袖口卷边观感（十七轮合缝交换，评审自注非穿模）；④香肠指/团块感/比例（官方
模型几何+锁定手尺 8.2cm）；⑤vandal 越顶指尖/握位偏后（远侧包握固有，锚锁定，
十五轮扫描深卷/腕滚转均劣化）。

### 附：官方 1P 手臂十轮——phantom 网格位移回退（评审尖刺归因，2026-10-01）

**评审焦点**（三轮视觉评审）：phantom「网格撕裂/尖刺」「拇指横穿枪管」「袖口拧
麻花」「手指扇形不包握」。本轮先诊断后动手（scripts/arms-diag.mjs：取证 + 四
变体页内对照 S1 base / S2 无补丁 / S3 无去穿透 / S4 双无 / S5 复原=base）。

**归因（数字取证）**：
- 七轮 phantom 表的 4 个拇指尖顶点（6579/6584/6588/6595，L_Thumb2/3 权重
  0.6~0.87）世界位移实测 **7.3/7.8/8.1/9.8mm**，3929（L_Hand+Callus_Pad2+
  Palm_Fold 掌跟）4.5mm——七轮附录「8 顶点亚毫米世界推距」是记账错误（把
  rest 单位当世界 mm；B_lin 实测 rest≈世界×5.8，正是四轮就踩过的单位坑复刻）。
  拇指尖高曲率轮廓区局部 4 顶点 8~10mm 定向拉伸 = 评审「撕裂/尖刺」；S1 vs
  S3 截图逐框：撤表后拇指尖平滑、尖刺消失。嵌枪 30 顶点的骨归属 26 在
  L_Thumb3（拇指尖压持）、2 L_Thumb2、2 R_Index1——「拇指横穿枪管」的网格
  侧也在同处。
- S2（仅关补丁）嵌枪 30→2：九轮 GRIP_PATCH 贡献了 30 个隐藏嵌枪中的 28 个
  （X75 深卷 + 拇指 Y 下摆压进护木贴持面）；指尖/腕锚/手尺五变体全同（补丁
  不碰腕锚系指标）。
- 袖口白布拧转、指列扇形在 S1/S3 间不变——非去穿透成因（前者官方布料网格、
  后者九轮 X75 只卷中节未动近节，均留待下一改动类）。

**修复（一类）**：phantom `ARMS_DEPENETRATE` 整表回退（`FP_Phoenix_S0_Skelmesh001:
[]`），vandal 表不动（评审 9 分、审计 0/0；其 27 顶点在遮挡面低曲率区，1744
等大推距顶点均在护木下侧面非轮廓区）。不选「重做」：残余 9 顶点区在 45mm 带
内无偶数落点（七轮已证），亚毫米推距过不了奇偶门，过门必再出轮廓区拉伸。

**终态**（node scripts/arms-audit.mjs 双跑复现；out/arms-audit-r1fix-final{,-confirm}.json）：
vandal 0/0/75/0（指尖 0.52mm、腕锚 0.006mm、手尺 8.2cm——分毫未动）；phantom
32/0/36/0（指尖 1.52mm、腕锚 0.0045mm、手尺 8.2cm）——可见穿透/可见相交双
口径双枪 0，隐藏嵌枪 +2、隐藏相交 +9 为回退的显式代价；拇指尖撕裂/尖刺消除
（截图终审）。回归：npx vitest run tests/official-arms.test.js
tests/glove-poses.test.js → 19/19。

**遗留（下一改动类，本轮未动）**：① 指列扇形/分段折断观感——九轮 X75 只卷
L_Index2/Middle2/Ring2 中节、近节（*1）未动，整指包握需近节+中节联合小角度
（须重扫嵌枪/贴枪平衡）；② 袖口白布拧转（官方布料网格）；③ 拇指尖压持隐藏
嵌枪 32 的奇偶底层（同六轮结论：动骨到界）。

### 附：官方 1P 手臂十一轮——左手整指包握（评审扇形指修复，2026-10-01）

**评审焦点**：phantom「手指扇形不包握」（十轮遗留①）。九轮补丁只卷中节
（L_Index2/Middle2/Ring2 +X75°）、近节（*1）未动——指节列呈高弧扇形悬在护木
上方，左指尖（网格级）距枪 13~15mm。

**轴映射探针**（scripts/grip-wrap-tune.mjs + /tmp 探针）：本骨架为**零偏移骨
架**——骨长轴=局部 X，*2 旋转不移动 *3 骨节点（L_Index3 位移 <0.0001，皮肉
变形在网格上），故骨节点指尖度量对 *2 全盲（九轮以来的度量口径局限）；绕
*1 局部 X = 绕指长轴拧转（关节不动、网格段滚转，+X 近节实测是「张开」不是
「包握」——α 越大指尖越悬 13.3→20.7mm）；**绕 *1 局部 Y+ 才把指节列往
「屏幕下方+近侧」摆**（Δ +6.3/−4.4/+3.9mm @Y20）= 包握方向。

**扫描与定稿**：三轮 24 候选（α+β 分布卷指 ×2 组、负近节 ×6 组、Y 摆 ×8 组、
细扫 ×8 组），逐候选 auditWeaponInPage 全口径 + 5x 裁剪对比。终值：左三指
近节 **+本地Y 35°**（中节 X75° 保留）+ 小指 +本地Y 20°/中节 +本地X 55°（收
拢，不再向后外翘拖扇形尾巴）；拇指 Y25/15°（九轮）保留。

**守恒与代价**（node scripts/arms-audit.mjs 双跑复现，out/arms-audit-r2fix-final{,-confirm}.json）：
全部 24 候选嵌枪/可见/相交/可见/指尖min/腕锚/手尺与 ref 逐字节相同——摆动
方向朝枪外侧自由空间，不产生新互陷：vandal 0/0/75/0（0.52mm/0.006mm/8.2cm
分毫未动）、phantom 32/0/36/0（1.52mm/0.0045mm/8.2cm）。视觉终审：指列从
「高弧扇形+分段折断观感」压成「贴持护木侧面」的包握观感，小指内收
（out/diag-r1-vs-r2.png）。回归：npx vitest run tests/official-arms.test.js
tests/glove-poses.test.js → 19/19。

**遗留**：① 袖口白布拧转（官方布料网格，同十轮结论）；② 指节分段「香肠串」
观感（官方模型分节几何+贴图特征，姿势层已到收益边界）；③ 左手指列 Y 摆后
包握角仍偏平（真正的环握需 *1 三轴复合或腕骨微调——动腕锚系，超出本轮授权）。

### 附：官方 1P 手臂十二轮——袖扣带拧麻花归因与滚转修正（2026-10-01）

**评审焦点**：phantom「袖口拧麻花」（十轮遗留②中最显眼项，九/十轮均以「官方
布料设计」挂起）。

**取证链**（scripts/arms-cuff-diag{,2,3}.mjs）：
- 材质面：臂网格单材质单段（FP_Phoenix_S0_01_MI，无 groups），白布只能按屏
  幕射线反查——白布带顶点主权重 L_Twist2 0.8（前臂拧转骨）+ L_Hand/L_Callus_
  Pad2（腕掌过渡区）。
- 绑定位原貌（模板克隆多角度直拍 out/diag-bind-*.png）：白布=**官方设计的白
  色袖扣带**（环腕一圈、带卡扣、下接深灰罗纹袖口）——绑定位干净无拧转。
- 结论：拧麻花不是网格缺陷也不是布料模拟缺失，而是 phantom_idle 姿势的腕-
  前臂相对拧转把扣带压到掌跟下方、我们取景角（非官方相机角）下的呈现；
  七~十一轮全部截图（含 rev3 存档）中该区恒定不变，与去穿透/指姿各改动无关。

**修复（一类）**：L_Twist2 +本地X 45°（前臂拧转骨的滚转职责位）——只动袖筒/
扣带皮肉权重顶点，手/指/腕锚/肘零改动。扫描（scripts/cuff-roll-tune.mjs，
±15/30/45 七候选，生效角页内校验 15/30/45°）：+45 把垂带卷回腕侧读作护腕环
（评审【扭曲】观感消除）；−45 收紧但保留垂带读法；+X 近节类同九轮教训（方向
相反侧）。审计七候选对照：嵌枪/可见/指尖/腕锚/手尺全同，相交 36→38（+2 隐
藏三角，遮挡面）为全部非零候选共同代价。

**终态**（node scripts/arms-audit.mjs 双跑复现；out/arms-audit-r3fix-final{,-confirm}.json）：
vandal 0/0/75/0（0.52mm/0.006mm/8.2cm 分毫未动）；phantom 32/0/38/0（1.52mm/
0.0045mm/8.2cm）——双可见口径双枪 0。回归：npx vitest run
tests/official-arms.test.js tests/glove-poses.test.js → 19/19。

**遗留**：① 指节分段「香肠串」观感（官方模型分节几何+贴图，姿势层到界）；
② 扣带环内露出的腕部皮肤小片（8x 放大可辨，游戏尺度读作腕；ref 本有）；
③ 环握角偏平（动腕骨系超授权，同十一轮③）。

### 附：官方 1P 手臂十三轮——包握角定稿（腕骨滚转，指尖越轨消除，2026-10-01）

**目标**：包握指列的指尖团块越出轨顶轮廓（评审「指尖穿顶」残留类；十一轮包握
后指尖包到远侧、高于轨顶线 2~3 团块，8x 取证 out/diag-r4-railtips.png）。

**方法**（scripts/grip-deepen-tune.mjs，13 候选双杠杆）：*2 卷曲加深（X75→
85/95）对指尖越轨无效（骨节点盲区+网格位移不足以越回轨顶）；**L_Hand 腕骨滚
转**才是整手包握角杠杆——绕腕关节转动，腕锚位（L_Hand 骨关节位置）零改动。
轴扫描：hx−10 → 嵌枪 12/相交 32；**hx−15/−20 → 嵌枪 4/相交 31（最优平台）**；
−25 起过卷（6/38→11/56 指列堆叠）；hx+、hy±、hz− 全劣化（hy+5 会抵消 hx−20
收益 4→28）。拇指尖压持带同步松开（26 嵌枪顶点→0，拇指保持枪管下方不横穿）。

**定稿**：`L_Hand +本地X −20°`（[-0.173648, 0, 0, 0.984808]），与九~十二轮全
部补丁复合。终态（node scripts/arms-audit.mjs 双跑复现；
out/arms-audit-r4fix-final{,-confirm}.json）：vandal 0/0/75/0（0.52mm/0.006mm/
8.2cm 分毫未动）；**phantom 4/0/31/0**（1.52mm/0.0045mm/8.2cm）——双可见口径
双枪 0；隐藏嵌枪 32→4（起点 30，现存值为全系列最低）、相交 38→31。视觉终审：
指尖团退到轨顶后、掌贴持不悬空、袖扣环完整（out/diag-r4final-hand.png）。回
归：npx vitest run tests/official-arms.test.js tests/glove-poses.test.js →
19/19。

**遗留**：① 指节分段「香肠串」观感（官方模型分节几何+贴图，姿势层到界）；
② 剩余 4 隐藏嵌枪（R_Index1 2 + 接触带残点，全遮挡）；③ 环握角在 hx−20 已到
腕骨滚转收益边界（更深过卷堆叠）。

### 附：官方 1P 手臂十四轮——vandal 左拇指落位（评审回退归因与修复，2026-10-01）

**评审焦点**（四轮视觉评审：vandal 7/phantom 9）：vandal ①左掌/腕下缘「连续
3~4 个三角状锯齿凸起」（原生分辨率隐约可见）②左拇指「光滑钩状伸向前下方、
完全悬空不接触护木」③左手比例偏大+手背无指节起伏团块感。phantom 9 分通过。

**归因**（scripts/vandal-jag-diag.mjs + vandal-ab-nodepen.mjs + vandal-bind-diag.mjs）：
- ①锯齿边：评审像素射线反查命中 L_Index0 0.94 / L_Hand 0.68 / L_Twist2 0.75 /
  L_Thumb1 0.71（掌跟-拇指根过渡区）。**A/B 撤去穿透表对照：锯齿逐像素不变**
  （撤表嵌枪 0→27、相交 75→101、可见 0/0 均不变、C 复原=base）——非表成因。
  vandal 表 27 条实测世界位移 1.0~6.4mm（rest≈世界×5.8 同 phantom 记账坑），
  全部 L_Twist1 袖筒/R_Index1 握把/L_Hand 掌，投影在锯齿区右下方——维持原状
  （表当前压制 27 隐藏嵌枪，撤表是纯损失）。绑定位直拍：掌跟轮廓平滑——锯齿
  是握拳姿势下掌跟折痕的呈现，自七轮以来恒定（含九轮 9 分通过态）。
- ②悬空拇指：拇指尖云距枪 15.8mm。轴探测（L_Thumb1 三轴 ±15°）：仅 Z− 朝护
  木收拢（质心 +6.6/−6.1mm）；*2/*3 单轴在零偏移骨架下指尖云只动 ~2mm。
- ③手比例：8.2cm 等效为锁定守恒指标（=glove 路径标定），不可缩；指节起伏为
  官方模型几何——超姿势层授权，如实挂起。

**修复（一类）**：`ARMS_GRIP_PATCH.vandal.L_Thumb1 = +本地Z −25°`
（[0,0,-0.21644,0.976296]）。扫描（scripts/vandal-thumb-tune.mjs，指尖云质心
+距枪 min 双度量）：−20 → 4.1mm/嵌枪 6、**−25 → 1.6mm/嵌枪 3**（贴合不穿）、
−30 → 0.6mm 但嵌枪 23/相交 104（穿透劣化）；±X/±Y 反向或远离。

**终态**（node scripts/arms-audit.mjs 双跑复现；out/arms-audit-r5fix-final{,-confirm}.json）：
vandal 3/0/75/0（0.52mm/0.006mm/8.2cm；拇指贴合的 3 个隐藏接触顶点，可见
0）——拇指贴持护木、悬空钩消除（out/diag-r5final-vandal-zone.png）；phantom
4/0/31/0 分毫未动（9 分态保持）。回归：npx vitest run
tests/official-arms.test.js tests/glove-poses.test.js → 19/19。

**遗留**：①掌跟折痕锯齿（姿势态呈现、原生分辨率隐约、非表非设计缺陷；辅助
骨盲扫风险>收益，挂起）；②手背团块感/比例观感（模型几何+锁定手尺，超授权）；
③ phantom 残留同类（香肠指节、扣带环内皮肤小片，同前）。

### 附：官方 1P 手臂十五轮——致扭补丁回退（评审证实压数字换扭曲，2026-10-01）

**评审焦点**（五轮视觉评审：vandal 5 / phantom 2，均标 visibleClipping+distortion）：
phantom「袖口螺旋漏斗镂空透肤」「拇指蹼皮肤拉伸薄膜」「腕部自下而上反向弯折、
掌反搭枪顶」；vandal「越顶指方形缺口/指尖被轨面削平压入」「掌缘尖刺」「护腕
楔缝」「白布折纸」「香肠指/比例」。

**归因与处置（phantom，本轮修复）**：五轮评审指认的三项 phantom 伪影均为
十二/十三轮补丁的产物——L_Twist2 +X45°（十二轮）把袖扣带卷成环带镂空漏斗
（中心透出腕部皮肤，评审第 1 条）；L_Hand +X−20°（十三轮）致腕部反向弯折、
掌反搭枪顶与拇指蹼皮肤拉伸薄膜（评审第 3/4 条）。二者当时以隐藏嵌枪 32→4/
相交 38→31 为交换，属「压数字换扭曲」——本轮整体回退至十一轮指姿表
（phantom=无 L_Hand/无 L_Twist2）。扫描（scripts/phantom-undo-tune.mjs）：
回退态袖口为平滑袖管、腕线自然、拇指蹼无拉伸（sheet-cuff/sheet-hand）；
十二轮「拧麻花垂带」读法系与 hx−20 联带的呈现，纯回退后不出现。隐藏嵌枪
4→32、相交 31→36 为如实代价。

**vandal 扫描结论（不改动）**（scripts/vandal-thumb-tune.mjs 扩展）：卷指加深
m55 与 m40 全同、m65/75 指尖压入枪体（嵌枪 10/17、相交 92/108）；L_Hand 滚转
在 vandal 上爆炸（hx−8 即嵌枪 49/相交 166，与 phantom 相反——两手与护木相对
几何不同）。越顶指尖=远侧包握几何在锁定锚下的固有呈现；掌缘尖刺=握拳折痕
（十四轮 A/B 已证非表）；护腕楔缝/白布折纸=官方布料；香肠指/比例=模型几何+
锁定手尺——均非姿势层可修，维持十四轮终态。

**终态**（node scripts/arms-audit.mjs 双跑复现；out/arms-audit-r6fix-final{,-confirm}.json）：
vandal 3/0/75/0（0.52mm/0.006mm/8.2cm）；phantom 32/0/36/0（1.52mm/0.0045mm/
8.2cm）——双可见口径双枪 0。回归：npx vitest run tests/official-arms.test.js
tests/glove-poses.test.js → 19/19。

**评审方差备忘**：r4 轮输入评审对与 r5/r6 轮几何完全相同的 phantom 态打出过
9 分（无 issue），r5/r6 轮同态打 2 分并列明细——评审存在显著方差。本轮只治
理几何上真实的扭曲（漏斗/蹼膜/反折），不追单次评审的读法。机匣-弹匣缝隙露肤
为锚定掌位在枪体缝隙间的遮挡关系（pierceVisible=0，皮肤在枪外），七轮以来恒定。

**遗留**：同十四轮①②③ + vandal 越顶指尖（远侧包握固有，锚锁定）。

### 附：官方 1P 手臂十六轮——指列收敛与金戒指暴露治理（2026-10-01）

**评审焦点**（六轮视觉评审：vandal 4 / phantom 5）：两枪共同项——皮肤轮廓锯齿
（掌缘/腕下缘）、袖口交界楔缝、指团间隙透背景、金戒指黄碎片从指根交界穿出、
香肠指/团块感。

**取证**（scripts/ring-diag.mjs + 16x 裁剪 out/diag-r7-yellow.png）：评审所指
「黄色异色网格碎片」= **凤凰金戒指网格**（无名指饰件，非穿模异物、非枪件—
射线对臂/枪网格均未命中，16x 目视定位在中指/无名指尖团之间的轨面交线缝隙）。

**扫描与定稿**（scripts/grip-deepen-tune.mjs，本轮 +9 候选）：戒指清轨
（Ring2 单独 85/95、Ring1 ±Y）全部无效——戒指藏在指团间隙的几何位，指骨姿
势杠杆动不了它；**指列收敛**（近节 Y 差异化）有效关闭指团间隙：定稿
Index1 +Y42 / Middle1 +Y35 / Ring1 +Y40（Ring≥Middle 使戒指藏到中指团后）/
Pinky1 +Y15 不变。审计：候选与 ref 全同（32/0/36/0、1.52mm、0.0045mm、8.2cm
——收敛不产生新枪体互陷）。

**终态**（node scripts/arms-audit.mjs 双跑复现；out/arms-audit-r7fix-final{,-confirm}.json）：
vandal 3/0/75/0（0.52mm/0.006mm/8.2cm，不回退）；phantom 32/0/36/0（1.52mm/
0.0045mm/8.2cm）——双可见口径双枪 0。指间透背景大缝隙闭合、金戒指露边大幅缩
小（out/diag-r7final-phantom-fingers.png；全消需模型层：戒指网格独立遮蔽或
锚移动）。回归：npx vitest run tests/official-arms.test.js
tests/glove-poses.test.js → 19/19。

**不可达项（如实归档）**：①金戒指露边全消——指骨姿势杠杆到界（本轮 9 候选
+80mm 带内审计全同），需模型编辑（戒指网格）或锚移动；②皮肤轮廓锯齿（掌缘/
腕下缘，双枪）——握拳折痕呈现（十四轮 A/B+绑定位取证），原生分辨率隐约；
③香肠指/团块感/无指节起伏——官方模型几何；④vandal 越顶指尖/握位偏后——
远侧包握固有+锚锁定（十五轮扫描：深卷压入枪体、腕滚转爆炸）。

### 附：官方 1P 手臂十七轮——phantom 腕袖合缝与拇指落位（2026-10-01）

**评审焦点**（七轮视觉评审：vandal 9 通过 / phantom 4）：phantom ①掌跟-袖口间
通透裂缝（背景可见、手与袖口未连接）②袖口撕纸状锯齿 ③拇指细长僵直伸向枪口
悬空 ④金戒指黄碎片。vandal 九分态保持。

**取证与扫描**（scripts/grip-deepen-tune.mjs BASE 更新至十六轮定稿，+8 候选）：
- ①透缝（out/diag-r8-hole.png 证实：掌跟与袖口间垂直透缝，背景可见）：成因=
  phantom idle 腕屈使掌（L_Hand 权重）与袖（L_Twist2 权重）在腕内侧拉开。杠杆
  =L_Twist2 微正角（+8/+15 向掌侧收）：+8 透缝显著变窄且未起环折、+15 起环折
  初现（十五轮漏斗教训）→ 定稿 +8（嵌枪 32 不变、相交 36→38 如实 +2）。
- ③拇指：out/diag-r8-thumb.png 证实悬空前伸。杠杆=L_Thumb2 +本地X 15°（卷曲
  钩向护木底，替换九轮 Y25 沉底——Y25 态的悬空前伸即其产物）：嵌枪 32→10
  （拇指尖脱离护木顶压持带）、相交 36 不变；X25 同平台；t3x+20 仅至 23；
  定稿 X15（替换 Y25）+ 末节 Y15 保留。

**终态**（node scripts/arms-audit.mjs 双跑复现；out/arms-audit-r8fix-final{,-confirm}.json）：
vandal 3/0/75/0（0.52mm/0.006mm/8.2cm，九分态不回退）；phantom 10/0/38/0
（1.52mm/0.0045mm/8.2cm）——双可见口径双枪 0；透缝显著变窄（out/
diag-r8final-seam.png，余腕折细线）、拇指由悬空前伸改为钩向枪管下方贴合
（out/diag-r8final-thumb.png）。回归：npx vitest run
tests/official-arms.test.js tests/glove-poses.test.js → 19/19。

**不可达/遗留**：①透缝全闭合需模型层（+15 起环折，姿势层上限=变窄）；②拇
指细长光滑无甲（官方模型几何）；③金戒指露边（十六轮归档，模型层）。

### 附：官方 1P 手臂十八轮——微扫触底确认（姿势层下限归档，2026-10-01）

**评审**（八轮视觉评审：vandal 9 / phantom 8，均无 visibleClipping；vandal 明确
「整体无可见穿模…上述轮廓瑕疵为局部轻微问题」）：剩余项为 2~5px 级掌缘/腕下
缘皮肤折痕锯齿、袖口交界黑楔、phantom 灰色小尖刺（968,778）、金戒指露边、袖
口卷边观感（评审自注「布料造型问题，非穿模」）。

**微扫**（scripts/grip-deepen-tune.mjs，现态基准 +7 候选：L_Hand z/y ±5°、
L_Thumb1 z ±6°）：全部中性-劣化——隐藏嵌枪 10→6~16、相交 38→36~43（仅
t1z+6 −2）、金戒指暴露反而增大、nub 区裁剪无可见改善。诊断补充：phantom 灰
色小尖刺在 tw+8 前后同位同形（out/diag-r9-spike-{pre,post}.png）——非上轮
tw+8 新引入，系掌缘折痕的持续特征；其像素射线对臂/枪网格 12mm 内均未命中
（scripts/ring-diag.mjs）——2~3px 级三角尖端，无法定点。

**结论：姿势层触底，本轮零代码改动**。十七轮烘焙态维持（vandal 3/0/75/0、
phantom 10/0/38/0，双可见口径双枪 0；node scripts/arms-audit.mjs 复现
out/arms-audit-r9fix-confirm.json；回归 npx vitest run
tests/official-arms.test.js tests/glove-poses.test.js → 19/19）。剩余伪影分类：
①皮肤折痕锯齿（握拳折痕呈现，十四轮 A/B+绑定位+本轮射线三重取证）；②金戒
指露边（十六轮 9 候选到界）；③袖口卷边观感（tw+8 的合缝交换，评审自注非穿
模）；④香肠指/团块/比例（模型几何+锁定手尺）。②③④需模型编辑或锚/手尺变
更——均超「只动骨不加假的」授权边界。
