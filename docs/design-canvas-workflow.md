# 设计会话、画布与产物

设计能力覆盖：用户描述要求 → 设计规则和上下文注入 → 实际页面生成 → 画布展示 → 元素选择和修改 → 原型演示 → 产物库重开。画布、页面源文件、会话与产物库共享身份和版本。

## 使用流程

1. 在个人产物中选择「网页设计」「App 设计」或「交互原型」，进入独立的本人 Work 会话。输入具体要求并发送；应用在主进程加入设计规则，沿用已配置的 Pi 模型和权限流程。
2. 实际页面写出并核对后，会话出现设计卡片并打开旁侧画布。每个页面可以移动、调整尺寸；画布可以平移、缩放及全屏打开。「选择」用于选元素，「交互」用于操作页面。
3. 点击标题等实际页面元素，可选父级、定位、直接保存支持的文字，或用「让助手修改」将引用带回输入框。输入修改要求并发送后，先查看候选、比较原稿，再采用或放弃。HTML 源码也可编辑保存。
4. 「原型」用于跨页演示和返回。「导出与整理设计」可以保存源 ZIP、独立 HTML 原型，或整理为现有可发布产物。源包包含各页 HTML、页面摘要和布局清单。
5. 个人产物库按同一文档身份显示设计。关闭会话或重启后可重开画布，继续原会话、编辑当前稿或查看历史。

个人设计按本机创建者保存，不依赖当前所选团队服务。整理为可发布产物后，沿用现有空间选择、固定发布版本、评审及任务采用流程；后续个人改稿不替换已采用的版本。

生成页面要求资源自包含：样式和脚本内嵌，图片等使用内嵌数据。不支持外部站点、外链依赖、嵌套 iframe 或 live app 绑定。最多八页，单页 HTML 128 KiB、合计512 KiB；发布完整原型仍受现有256 KiB正文上限约束，超过时可导出。来源变化时保留已保存的只读稿，恢复原来源并核对后才继续编辑。

## Kun 源码基线

本地源码位于 `D:\my_demo\Kun`，提交为 `0d8406128e2cede3bb5085c2d28fb90ab9e91f69`。以下路径与行号对应此提交。

用户截图中的 Fast Context 长提示词来自 [fast-context-tool-provider.ts](/D:/my_demo/Kun/kun/src/adapters/tool/fast-context-tool-provider.ts:38)，用途是限定检索子代理的代码读取，并不是设计角色提示词。“Skills 1”显示一个技能计数，不能仅从截图确定技能身份。

### 两条设计入口

| 路径 | 具体调用与结果 |
| --- | --- |
| Code 会话直接做设计 | `startNewArtifact` 预填用户输入 → 普通 Code 回合 → 模型调用 `design_open(title, screens)` → 工具写 HTML 并返回 `designRequest` → renderer 登记设计文档和页面 → 会话显示设计卡片并打开旁侧画布。 |
| 设计画布生成与修改 | 设计输入控制器确定文档/画布和选区 → 提交 Design 回合 → 按目标注入模式规则 → 创建页面框并预约页面文件 → 后续页面回合填充 HTML，或针对已有页面进行局部迭代。 |

两条入口最终使用同一 DesignDocument/DesignArtifact/CanvasDocument，但初始生成方式不同，不能把它们描述为总是先调用同一个设计子代理。

Code 路径的 [design_open](/D:/my_demo/Kun/kun/src/adapters/tool/design-open-tool.ts:152) 在一个工具调用中接收最多六个完整页面；同一会话与规范化标题决定文档 ID，同一文档与页面名决定页面 ID。HTML 写到 `.kun-design/<documentId>/<artifactId>/v1.html`。再次以相同身份调用会覆盖该路径，不能把这条路径称为每次都自动新增不可变版本。

设计模式的 [design_create_screen](/D:/my_demo/Kun/kun/src/adapters/tool/design-canvas-tool.ts:309) 先返回画框操作及 accepted 状态；设计模式随后生成 HTML。Code 的普通白板使用该工具时只创建普通画框，不触发 HTML 页面生成。accepted、画框已创建、HTML 可读、预览完成是不同结果。

入口证据：[artifact-actions.ts](/D:/my_demo/Kun/src/renderer/src/artifacts/artifact-actions.ts:105)、[设计输入控制器](/D:/my_demo/Kun/src/renderer/src/components/design/useDesignPromptController.ts:382)、[Design 回合分派](/D:/my_demo/Kun/src/renderer/src/design/design-turn-dispatch.ts:77)。

### 提示词如何组成

| 层 | 作用与源码 |
| --- | --- |
| 模式规则 | [turn-mode-instruction.ts](/D:/my_demo/Kun/kun/src/loop/turn-mode-instruction.ts:24) 根据回合合同选择规则；[design-mode.ts](/D:/my_demo/Kun/kun/src/loop/design-mode.ts:8) 区分单页、多页、修改、原型导航与动效。 |
| 页面生成规则 | [design-html-page-mode.ts](/D:/my_demo/Kun/kun/src/loop/design-html-page-mode.ts:15) 要求写入已预约的 HTML，限定可修改文件、响应式和交付要求；[design-authoring-rules.ts](/D:/my_demo/Kun/kun/src/prompt/design-authoring-rules.ts:17)提供视觉、状态与交互质量规则。 |
| 稳定设计档案 | [DesignTaskProfile](/D:/my_demo/Kun/kun/src/contracts/design-task-profile.ts:103) 保存文档/画布绑定、Web/App、HTML/图片、风格和 DESIGN.md 快照；[档案指令](/D:/my_demo/Kun/kun/src/prompt/design-task-profile.ts:25) 从锁定快照派生，避免跟随另一个设计任务变色或换目标。 |
| 当前操作上下文 | [buildDesignTurnPromptPayload](/D:/my_demo/Kun/src/renderer/src/design/design-turn-prompt/payload.ts:153)组合当前页面、画布选区、尺寸、兄弟页面、元素与质量问题；[页面提示词](/D:/my_demo/Kun/src/renderer/src/design/design-turn-prompt/html-and-canvas.ts:34)要求局部修改保留其他内容。 |
| 技能与工具合同 | [canvas skill](/D:/my_demo/Kun/resources/bundled-skills/canvas/SKILL.md:1)、[component-design skill](/D:/my_demo/Kun/resources/bundled-skills/component-design/SKILL.md:1)提供工具使用方式；普通 Code 的页面生成还依赖 design_open 的工具描述和输入输出合同。技能不是全部功能的实现。 |

[model-step-preparation-service.ts](/D:/my_demo/Kun/kun/src/loop/model-step-preparation-service.ts:583) 将档案、技能与模式上下文交给模型。Design 模式规则按真实回合能力选择，不是把所有设计提示词附在每条普通 Code 消息后。

### 生成结果进入画布

`design_open.output.designRequest` → mapper 解析工具结果 → [useAgentDesignAutoOpen](/D:/my_demo/Kun/src/renderer/src/components/workbench/useAgentDesignAutoOpen.ts:37) 识别本窗口新到达的结果 → [ingestAgentDesign](/D:/my_demo/Kun/src/renderer/src/design/agent-design-ingest.ts:92)登记文档和页面 → `showDesignDocument` → `DesignDocumentCanvasSurface`。

每个页面作为 HTML frame 放进画布，可以移动和缩放页面框。页面内部由 [DesignHtmlPreviewHost](/D:/my_demo/Kun/src/renderer/src/components/design/DesignHtmlPreviewHost.tsx:124) 在隔离 webview 中加载真实 HTML。文件监视更新预览修订，页面重新读取；不是把模型文字或页面截图当成可编辑源。

页面框的移动/缩放属于画布对象操作；页面内按钮、标题和段落属于 HTML DOM。二者采用不同对象身份。设计画布也不同于 Work 自由白板和普通流程图，不能直接用节点流程图或图片画板替代。

历史会话重放不会重新执行工具或自动抢开画布；[DesignOpenCard](/D:/my_demo/Kun/src/renderer/src/components/chat/DesignOpenCard.tsx:38)可重新打开已有设计。

### 组件选择与编辑

1. 页面框处于选择态时，host 将鼠标坐标转换为页面内部坐标，读取 DOM 元素映射并确定元素或祖先。预览交互态、只读或生成期间不按普通选择态处理。
2. [useHtmlFrameElementSelection](/D:/my_demo/Kun/src/renderer/src/components/design/canvas/html-frame/use-html-frame-element-selection.ts:80)保存 selector、标签、文字、HTML 片段、层级路径、页面/画框身份、预览修订和实时验证 token。可选择父级或更内层元素。
3. [HtmlFrameElementPickBar](/D:/my_demo/Kun/src/renderer/src/components/design/canvas/html-frame/HtmlFrameElementPickBar.tsx:71)提供选中组件提示、父级、文字编辑和让 Kun 修改入口；让 Kun 修改把引用和可选指令种子带入 composer，不在该按钮里直接发送模型请求。
4. [submitDesignTurn](/D:/my_demo/Kun/src/renderer/src/design/design-turn-submit.ts:340)在发送前校验元素引用。[formatHtmlElementContextLines](/D:/my_demo/Kun/src/renderer/src/design/design-turn-prompt/html-and-canvas.ts:172)将目标及片段作为引用数据，要求重新读取当前文件并唯一定位，避免修改外观相似的元素。
5. 对允许的文本元素，[commitSelectedElementText](/D:/my_demo/Kun/src/renderer/src/components/design/canvas/html-frame/HtmlFrameScreenOverlay.tsx:271)能读取源 HTML、替换所选文字并保存；复杂结构或样式修改仍通过设计回合处理。源码不证明所有 DOM 都可像设计软件一样直接拖拽改布局或双向修改 React 组件。

预览重载后旧选区必须重新识别；无法确认的引用不继续发送。组件选区、整个页面和多个画布对象分别携带准确目标。

### 设计动作与原型

[buildDesignAgentActions](/D:/my_demo/Kun/src/renderer/src/design/agent-actions/design-agent-actions.ts:190)定义探索方向、提取设计系统、组件化、审查、串联原型、绑定 live app 和修复代码桥。这些动作组合预设指令与实际画布上下文；显示菜单不等于模型已完成操作。

- 组件化和审查需要选区。
- 原型串联需要至少两个 HTML 页面框。
- live app 绑定需要运行中的应用框；代码桥修复需要活动代码绑定和操作记录。

原型导航通过 [prototype-player/playback.ts](/D:/my_demo/Kun/src/renderer/src/design/prototype-player/playback.ts:9)识别链接、按钮目标和路由变化，结合页面关系切换目标页并保留历史。原型播放期间页面可交互；元素选择期间点击用于选择，二者不能混用。

### 保存、产物库与继续编辑

```text
.kun-design/
  documents.json                         设计文档索引、顺序和活动指针
  <documentId>/
    <pageArtifactId>/
      meta.json                          页面标题、版本、位置和关联
      DESIGN.md                          页面设计说明，按生成路径建立
      v1.html / v2.html                   实际页面源
    <boardArtifactId>/
      meta.json                          画布产物元数据
      canvas.json                        画布对象及页面关联
      design-system.json                 使用相应设计系统功能时的状态
```

依据：[设计文档持久化](/D:/my_demo/Kun/src/renderer/src/design/design-document-persistence.ts:25)、[页面持久化](/D:/my_demo/Kun/src/renderer/src/design/design-artifact-persistence.ts:26)、[画布创建](/D:/my_demo/Kun/src/renderer/src/design/design-board-artifact.ts:82)。目录列出各合同路径，不保证每条初次生成路径都会写出全部可选文件。

[upsertArtifact](/D:/my_demo/Kun/src/renderer/src/design/design-workspace-artifact-actions.ts:67)更新页面元数据和索引。产物库的 [scanDesigns](/D:/my_demo/Kun/src/renderer/src/artifacts/artifact-index.ts:79)读取 documents.json，每个设计文档成为一个库条目；[loadDesignScreens](/D:/my_demo/Kun/src/renderer/src/artifacts/artifact-design-screens.ts:8)按页面元数据和画布顺序加载预览。

点击产物先进入 Viewer；[openDesignCanvas](/D:/my_demo/Kun/src/renderer/src/artifacts/artifact-actions.ts:69)再进入同一 designDocumentId 的编辑画布。来源会话通过明确 sourceThreadId 或 thread.designProfile 的文档绑定查找；找不到时建立新的工作会话，不能声称恢复了原生成会话。Code design_open 的文档登记本身不写入 thread.designProfile，因此不能推断所有设计都能显示原会话。

相同标题不代表同一个设计。Code 入口的文档身份包含 threadId，跨会话同名输出可以形成不同文档；仅凭两张同名卡片不能断言库重复索引。同理，库详情的版本数量不能代替页面历史或团队不可变发布合同。

## Trellis Panel 的实现合同

### 复用现有能力

- [web-preview.ts](/D:/my_demo/trellis-panel/src/main/services/pi/engine/web-preview.ts:6)已注册 preview_web，可验证已保存静态 HTML 并发出包含路径和摘要的结构化结果；它不负责创建设计文档或 DOM 编辑。
- [Pi 资源装配](/D:/my_demo/trellis-panel/src/main/services/pi/engine/resources.ts:76)已有指令和扩展注入点，设计规则应在主进程按明确意图装配，复用现有执行引擎与模型。
- [PiWebPreviewService](/D:/my_demo/trellis-panel/src/main/services/pi-web-preview/index.ts:52)及会话预览卡片提供受控资源读取、原会话关联和打开路径。设计页面框在这些能力上增加文档身份、画布和元素引用，不另建任意文件预览服务器。
- 既有 creations 的发布、评审和任务采用继续作为空间交付域；设计源和私有会话不能因进入产物库而自动共享。

### 补齐的数据与操作

| 合同 | 必须满足 |
| --- | --- |
| 设计文档 | 稳定 documentId、私人创建者、来源会话、原生执行身份、受管输出目录和版本化合同；修改以当前页面源为风格依据。 |
| 页面与画布 | 稳定 pageId/frameId、尺寸、位置、页面源及修订；一份文档允许多页和多个页面状态。 |
| 生成交付 | 只有实际文件及格式核对成功才登记完成；部分页面失败时保留成功页和原操作，不生成虚假成果卡。 |
| 元素引用 | 绑定文档、页面、画框、源摘要及预览代次、唯一元素定位；发送和采用前验证，不匹配则重新选择。 |
| 修改候选 | AI 先修改候选页面副本，工作台预览并比较；用户采用时校验当前修订。失败、停止及外部改动保留原稿。 |
| 本机持久化 | 文档、页面源、画布、素材、修订和来源映射可重开；修改既有文档复用身份，不按标题新建另一份。 |
| 产物索引 | 会话卡片、产物条目和画布指向同一 documentId；索引是对成果的入口，不能要求先转成另一种受管正文。 |
| 原型与导出 | 原型播放可跨页面导航和返回；导出可编辑设计源与原型资源包，不能只导出预览截图。 |

应用外壳沿用设置页 tokens；用户生成的设计遵循其明确设计要求和锁定的项目风格，不把外壳样式强加给所有成果。设计画布与普通自由白板分别适配，不能用增加流程图节点或接入 Excalidraw 就声称具备 HTML 元素编辑。

设计操作合同在不同执行引擎之间显式声明能力。优先复用现有 Pi 工具扩展与预览链；ACP/外部引擎须有真实工具桥接或经过核对的输出清单，不能仅追加同一段提示词就宣称能力等价。Kun 自身也区分普通 Code 工具入口与要求 Kun Agent 的完整 Design 回合。

### 首个验收场景

1. 从新建设计稿进入本人会话，输入“设计个人博客的首页和文章页”，发送前保留原草稿。
2. 按实际输出在旁侧画布出现两页；可调整页面框、缩放、阅读与切换交互。
3. 选择首页标题，选父级，再把具体元素带入指令；发送后得到局部修改候选，其他页面不被覆盖。
4. 可直接修改支持的文字并保存；对不能直接编辑的结构明确走助手修改。
5. 原型模式可从首页进入文章并返回；设计源和页面资源可导出。
6. 关闭会话并重启，从产物库找到同一设计；打开画布后继续修改，保留页面、画布与来源关系。
7. 显式发布选定修订到空间，任务采用固定版本；后续个人改稿不替换任务旧引用。

单页请求只生成要求的一页。首个验收场景用于验证多页、选区和原型链路，不作为所有用户请求的强制页数。
