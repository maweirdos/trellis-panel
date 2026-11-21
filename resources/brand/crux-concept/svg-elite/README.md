# CRUX 品牌标识与视觉系统提案 (Elite Edition V3)

> **设计基准**：对标 Linear 与 Apple Notes 顶级克制美学、包豪斯结构主义与现代数学拓扑。  
> **适用范围**：桌面客户端（Trellis Panel / Crux App）、Web 工作台、CLI 工具、系统托盘、Favicon 及团队对外宣传。  
> **资源目录**：`resources/brand/crux-concept/svg-elite/`

---

## 1. 品牌叙事与核心意象 (Brand Narrative)

**Crux** 具有双重深邃内涵：
1. **关键核心 / 症结枢纽 (The Crux of the Matter)**：在复杂多变的研发协同、海量任务分发与上下文流转中，直击本质，锚定执行核心。
2. **南十字座 (Southern Cross Constellation)**：航行者在未知星海中的恒久定向标，隐喻为人类团队与自主智能体（AI Agents）在庞大代码与任务宇宙中指引方向。

---

## 2. 五套旗舰方案深度解析 (Concepts Spectrum)

| 编号 | 方案代号 | 视觉形态 | 核心寓意 | 最适合场景 |
| :--- | :--- | :--- | :--- | :--- |
| **01** | **星枢切面 (The Astral Prism)** | 45° 钛金精密双折面翼片 + 悬浮菱钻星核 + 天文定向刻度 | 精密理性、顶级工业质感、坚定航标 | 桌面客户端 App Icon、专业开发者工具、高精暗色界面 |
| **02** | **莫比乌斯枢纽 (The Nexus Mobius)** | 双环连续流体拓扑咬合 + 空间穿插穿透 | 人机共生、闭环流转、连续生命力 | 协同画布、动态 Loading 动效、团队故事主视觉 |
| **03** | **引力字标 (Monogram C-Crux)** | 黄金弧度字母 C 怀抱定向十字星 | 经典字标穿透力、第一眼高记忆度 | 16px/24px Favicon、系统托盘、CLI 徽标、轻量级图标 |
| **04** | **量子晶格 (The Trellis Constellation)** | 4 个模块方圆构筑「负空间」璀璨十字星 | 外显晶格秩序，内生璀璨星核；不画而显 | 平台品牌印章、官方宣传物料、结构化架构图腾 |
| **05** | **引力聚核 (The Singularity Core)** | 4 片空气动力学叶片斐波那契螺旋向心汇聚 | 极速收敛、任务引力场、坚决执行力 | 高并发任务调度器、旋转微动效、状态加载指示 |

---

## 3. 文件清单与资产指南

```text
resources/brand/crux-concept/svg-elite/
├── 01-astral-prism.svg              # 方案01 钛金渐变高精矢量
├── 01-astral-prism-mono.svg         # 方案01 纯单色微缝矢量
├── 02-nexus-mobius.svg              # 方案02 拓扑流线矢量
├── 03-monogram-crux.svg             # 方案03 字标与十字星矢量
├── 04-trellis-constellation.svg     # 方案04 负空间晶格矢量
├── 04-trellis-constellation-mono.svg# 方案04 纯单色极简矢量
├── 05-singularity-core.svg          # 方案05 斐波那契引力叶片矢量
├── 05-singularity-core-mono.svg     # 方案05 纯单色涡旋矢量
├── gallery.svg                      # 1560×1020 全景矢量设计提案展板
├── showcase.html                    # 交互式网页展板（支持明暗双模切换、小尺寸测试、代码一键复制）
└── README.md                        # 本规范说明文件
```

---

## 4. 品牌应用与设计系统规范 (Application Guidelines)

### 4.1 颜色系统 (Color Token Defaults)
- **深空黑曜底色 (Obsidian Canvas)**：`#0B0E14` 或 `#11141A`
- **深钛灰表面 (Surface Plate)**：`#1E293B` / `#232936`
- **高光冷白 (Cold Titanium White)**：`#FFFFFF` / `#F8FAFC`
- **冷青辅色 (Ion Cyan / Accent)**：`#38BDF8`（建议只用于焦点徽章、中心悬浮微核或微光轮廓）

### 4.2 品牌字标排版 (Logotype Typography)
- **字体推荐**：Inter / -apple-system / Helvetica Neue（无衬线几何体）
- **大小写规范**：全大写 `CRUX`
- **字间距 (Tracking)**：`letter-spacing: +0.18em`（约 2px~3px 扩散），展现高级呼吸感与从容度
- **比例规范**：Mark 图标高度与字标大写字母 X 高度保持 1.2:1 至 1.4:1 比例，间距固定为 0.5 × Mark 宽度。

### 4.3 多尺度保真 (Multi-scale Rendering)
- **1024px ~ 256px (主应用展示)**：使用带渐变光影与精密折面的完整版。
- **64px ~ 48px (侧边栏 / 导航栏)**：保留核心折面与星核。
- **32px ~ 16px (系统托盘 / Favicon / 代码编辑器标签)**：优先选用单色版（`*-mono.svg`）或方案 03 / 方案 04，确保纯像素对齐，杜绝次像素模糊。
