# Trellis Panel 完成声明核对报告

> **适用快照与后续变更说明（补充于2026-10-17 07:50:30 UTC）**
>
> - 审计基线记录始于2026-10-17 07:24:26.173087 UTC，HEAD为`e07cdc003a64d0289e071b98d3856753cbd4bf73`；工作区已有未提交改动，不能用该提交独自代表全部受审代码。核心隔离探针P06/P07使用的`handoff.ts` SHA256为`d69fefe0a150d9edb2552871addc60e380b18c88869fc679f2922f6e5f1b85f7`。70项分类与正文证据属于审计记录，不是当前持续变化实现的完成率。
> - 报告后只读观察发现`handoff.ts`与`TaskDetail.tsx`已有新增内容：Git变化摘要、检查记录文件、未完成子任务与PRD开放问题。该次观察的`handoff.ts` SHA256为`1f4521c18e1b7d3a10adf3bfeaa89b18876144e1173fb80c9ffc593ce8ba0b25`，未取得可归属这些改动的精确提交，亦不判断作者。正文“D1只有索引/意图”及P07只适用于旧探针快照，**不得再当作最新代码现状**；新增内容能否支持完整接手仍未验收。
> - 创建失败/警告、停止请求与终态、PRD读取失败等结论保留原边界：有隔离依赖下的源码函数执行与受控故障观察，不等于原生UI、真实OS进程或真实业务复现。对后续版本需重新确认，不能把旧探针结果自动移植到新实现。
> - 本次仅补充这段时效说明，保留正文与历史证据；不修改roadmap_v2或产品代码，不继续追踪、重跑变化中的实现。原始实施指令与zcode原回复仍未取得，不能据本报告推断其全部承诺。

核对日期：2026-10-17（Asia/Shanghai）。这是独立只读核对，不修改原roadmap，不实施产品修正。

## 结论先行

**现有证据支持“做出了一批功能”，不支持“整份roadmap已经全部实现并验收完成”。** 创建PRD、统一交接、受控子任务关联、只读Git、命令/日志和组合启动都有实际代码，不能说全没做；但其中仍有结果处理缺口，且整体验收没有关闭。

**Roadmap本身确有容易误读的地方，我之前的整合方式需要承担这部分问题。** 它虽多次声明范围可选和未测边界，却把原README的“已实现”表放在首章、要求先读，并将宽目标标为已实施；没有把“代码存在、用例验证、真实使用验收、明确不做”拆成同一张可签收表。D1等宽目标与实际较窄的索引实现尤其容易被等同。不能仅凭这点推断zcode原话一定错误，也不能把原因全归文档。

尚未取得用户发给zcode的完整实施指令及zcode的原回复。项目内找到的是共享README和roadmap中的实施/原生走查文字，没有找到能独立证明其原话与批次边界的专门报告；没有读取其他Agent私有会话。因此**本次实际选择了哪些义务、所谓“完成”指代码还是验收，仍未知**。不把所有候选、已有能力或Crux功能自动纳入本批。

当前最高影响问题：普通创建丢失失败/警告；“全部停止”把请求计成成功；携带PRD失败却未进入读取问题；接续与交接缺完整结果内容/真实使用证据。前3项得到当前源码的隔离逻辑执行支持，均未声称已在原生产品中复现。

## 1 核对边界与基线

- HEAD：`e07cdc003a64d0289e071b98d3856753cbd4bf73`；开始时214条工作区状态记录，大量实现未提交，不能据此归属给特定作者或一次执行。
- 审计输入：`docs/roadmap_v2.md`，126,725字节；SHA256 `6c03bfeb9e262292c94426ff591d1d6952950500dd858fe925aa981ee14d3a77`。这比最初整合稿多了后续“原生走查”记录，已使用当前文件核对。
- 检查范围：项目docs、当前源码、scripts/smoke和相关任务验证文档。没有搜索Agent私有会话、读取凭据、启动真实Agent、执行工程脚本、外部写回、变更任务状态或改产品代码。
- 直接类型检查无输出写入；两项既有冒烟因环境路径访问受限阻断。没有申请扩大访问权限，也不把环境阻断当产品失败。检查结果对应当时输入，不为之后的并发修改背书。
- 收尾时观察到5个既有源码文件相对开始指纹发生变化，作者及批次未知：`src/main/ipc/tasks.ts`、`src/renderer/src/pages/TaskDetail.tsx`、`src/renderer/src/my/pages/IssuePeek.tsx`、`src/shared/types.ts`、`src/preload/index.ts`。其中IssuePeek在矩阵生成后又有变化，已重新核对其关联入口并修正行号；新资料复制入口只记静态存在，未追加产品验证。核心探针的store/handoff/dev-run源文件指纹未变。不能将本报告视为整个工作区的原子构建验收快照。
- 受控探针：读取并转译当前源文件，所有进程、文件内容、API与UI store依赖以内存夹具替换。记录函数实际返回/构造参数，不运行cmd、taskkill、npm脚本或模型。探针不是原生UI或真实OS验收。
- 新增的两份v0.6下载副本属于另一个明确请求，不是本次产品改动；原roadmap和v2始终保留。

## 2 先界定什么能叫“本次完成”


| 材料类别 | 本次处理 | 能否自动算本批必做 |
| --- | --- | --- |
| PF-01..PF-11、A/B/C/D小包 | 拆为具体行为，核对代码及证据 | 不能；最终选择仍需原始实施指令 |
| 已有阅读/ACP/观测基础 | 作为现存基线与余项，引用既有验证边界 | 不能要求从零重做；文档记载后续实施排除ACP，原始授权仍未独立取得 |
| PN-01..PN-08 | 对被选中范围的横向约束 | 适用约束不能因页面存在或编译通过免除 |
| 多仓库、配置就绪、跨设备等条件项 | 保留条件，不预设架构 | 条件是否成立/是否选中未知 |
| 旧48条FR、R0–R5及244+12用例 | 只审查取舍，不把历史方案恢复成新清单 | 明确不是当前全量承诺 |
| Crux47页、22覆盖项、25观察及UX建议 | 研究参考与设计原则 | 不是Trellis实施数量或完成率分母 |



依据：[docs/roadmap_v2.md:94](../roadmap_v2.md#L94)、[docs/roadmap_v2.md:188](../roadmap_v2.md#L188)、[docs/roadmap_v2.md:529](../roadmap_v2.md#L529)、[docs/roadmap_v2.md:688](../roadmap_v2.md#L688)。本报告不报“完成百分比”；没有选定范围就没有可信分母。

## 3 高影响缺口及可复查证据

### F-A01 普通创建的失败/PRD警告没有走到用户反馈（高影响）

PF-04要求三种入口真实展示产物。普通入口却`await api.createTask(...)`后丢弃整个返回，刷新并按标题寻找id；弹窗拿到任何id即关闭。受控P04中API返回`ok:false`且同名旧任务存在，函数返回`old-task`；P05中API返回PRD写失败警告，调用者仍只得到id，无警告。后端已有files/warnings并不意味着普通入口合同完成。

证据：[src/renderer/src/my/store.ts:254](../../src/renderer/src/my/store.ts#L254)、[src/renderer/src/my/pages/work-items/CreateIssueModal.tsx:32](../../src/renderer/src/my/pages/work-items/CreateIssueModal.tsx#L32)、[src/main/state.ts:475](../../src/main/state.ts#L475)；目标：[docs/roadmap_v2.md:501](../roadmap_v2.md#L501)。这是实际store函数的隔离执行结果；原生重复点击、文件失败与业务数据均未操作。验收见补充AV05。

### F-A02 “全部停止”在请求后即显示“已停止”（高影响）

服务`devRunStop`发出taskkill/kill后立即返回ok；`devRunStopAll`累计该ok；UI立即显示“已停止N个运行”。受控P01中尚未产生任何子进程退出事件，返回`stopped:1`而运行状态仍是`running`。这与单行状态等close更新的处理不一致，不能称停止终态已核实；Windows taskkill自身的异步失败也没有在该返回中确认。

证据：[src/main/services/dev-run.ts:118](../../src/main/services/dev-run.ts#L118)、[src/main/services/dev-run.ts:145](../../src/main/services/dev-run.ts#L145)、[src/renderer/src/my/pages/DevToolsPage.tsx:288](../../src/renderer/src/my/pages/DevToolsPage.tsx#L288)；目标：[docs/roadmap_v2.md:507](../roadmap_v2.md#L507)、[docs/roadmap_v2.md:518](../roadmap_v2.md#L518)。原生记录本身也承认停止终态未捕获：[docs/roadmap_v2.md:70](../roadmap_v2.md#L70)。验收AV15。

### F-A03 显式携带PRD时读取失败被吞成“无已知读取问题”（中高影响）

`readPrdContent`失败返回null，调用方没有携带失败原因；`buildHandoffPackage`仅按exists列出文件。P06夹具让文件存在而读取抛错，得到PRD原文未附加、issues空数组和“已知读取问题：无”。文件存在与已成功读取并非同一事实。

证据：[src/main/services/handoff.ts:103](../../src/main/services/handoff.ts#L103)、[src/main/ipc/tasks.ts:180](../../src/main/ipc/tasks.ts#L180)、[src/main/services/handoff.ts:59](../../src/main/services/handoff.ts#L59)、[src/main/services/handoff.ts:86](../../src/main/services/handoff.ts#L86)。该结果来自内存读失败，不是改真实权限后的UI复现。验收AV10。

### F-A04 D1/PF-08的结果接续目标只覆盖了索引部分（范围落差）

目标是让接手者了解上次结果、本次增量、实际检查、未覆盖、已知问题和下一步；当前接续区提供阶段提示、二选一意图、文件清单和可选PRD。P07确认默认输出没有填好的结果/检查/下一步内容，候选清单也未包含通用validation记录。文件中可能人工保存了等效信息，本报告不要求新表单或数据库；但尚无真实样本证明现有资料和入口已满足宽目标。

证据：[docs/roadmap_v2.md:505](../roadmap_v2.md#L505)、[docs/roadmap_v2.md:508](../roadmap_v2.md#L508)、[docs/roadmap_v2.md:675](../roadmap_v2.md#L675)；实现：[src/main/services/handoff.ts:51](../../src/main/services/handoff.ts#L51)、[src/main/services/handoff.ts:77](../../src/main/services/handoff.ts#L77)、[src/renderer/src/pages/TaskDetail.tsx:269](../../src/renderer/src/pages/TaskDetail.tsx#L269)。原生“生成材料成功”只证实索引与复制，不是整个接续目标关闭：[docs/roadmap_v2.md:73](../roadmap_v2.md#L73)。验收AV11。

### F-A05 C3已实现顺序发起，缺少完整组合/失败/停止验收（不要扩大为必建调度平台）

`startCombo`按目录调用start，仅检查即时返回。dev-run的真正退出/异步错误随后才到；没有选中脚本的目录被跳过，全部跳过时仍可能提示“组合已按顺序启动”。该函数也未把busy置true，连续点击的重复启动风险尚未交互复现。未见依赖/就绪配置并不自动成为缺陷：就绪检查是条件项，且规划允许没有检查时只显示存活。应先核对本批到底承诺“顺序启动”还是包含具体前后端依赖；至少不能用一次typecheck代替真实组合与部分失败验证。

证据：[src/renderer/src/my/pages/DevToolsPage.tsx:265](../../src/renderer/src/my/pages/DevToolsPage.tsx#L265)、[src/renderer/src/my/pages/DevToolsPage.tsx:313](../../src/renderer/src/my/pages/DevToolsPage.tsx#L313)、[src/main/services/dev-run.ts:93](../../src/main/services/dev-run.ts#L93)、[docs/roadmap_v2.md:168](../roadmap_v2.md#L168)、[docs/roadmap_v2.md:75](../roadmap_v2.md#L75)。除隔离函数和参数观察外，未运行真实工程脚本。验收AV16。

### F-A06 Windows脚本名没有保持独立参数边界（中影响，参数证据）

名称先被确认存在于package.json，再拼入`npm run ${script}`送cmd。P02/P03分别捕获`npm run task with spaces`和`npm run dev & extra`。这证明没有安全引用名称；未运行shell，因此不宣称已利用漏洞。含空格的合法脚本名和shell元字符应有明确支持/拒绝合同，不能仅凭“在scripts中存在”证明实际执行的是所选名称。

证据：[src/main/services/dev-run.ts:72](../../src/main/services/dev-run.ts#L72)。验收AV14；此处不要求运行不可信脚本。

## 4 本轮与既有验证证据分别说明


| 检查 | 命令/范围 | 本轮结果 |
| --- | --- | --- |
| TC01 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json` | 通过；类型检查，仅noEmit，不代表运行行为通过 |
| TC02 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json` | 通过；类型检查，仅noEmit，不代表原生交互通过 |
| SM01 | `node scripts/smoke/navigation.mjs` | 环境阻断：esbuild读取临时目录祖先路径被拒，未进入断言；不是产品失败/通过 |
| SM02 | `node scripts/smoke/task-presentation.mjs` | 同上：环境阻断；没有申请额外访问权限 |
| IP01 | `独立内存依赖执行当前dev-run/store/handoff源码` | 7条受控观察已记录；不启动真实进程、Agent、网络或业务写入；不称原生复现 |



本轮没有重跑build、ACP厂商矩阵、Jira写回、真实长驻进程/多工程或原生UI。既有smoke源码未检出针对devRun/devtools/prdContent/ignored/handoffBuild/linkSubtask的专项行为断言；注册/类型/旧阅读回归仍有价值，但不能为未调用的新行为背书。只按名称搜索也不能证明绝对没有间接覆盖，因此这里限定为“未找到专项断言”，不声称旧测试无效。

已有ACP任务保留核心功能通过矩阵与IME/profile原生待测：[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:39](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L39)、[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:56](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L56)。其证据指向项目外路径，本审计遵守项目内范围，没有访问或重新验证那些附件。工作区任务原验证仍记载原生截图中断：[.trellis/tasks/10-16-project-workspace-uiux/validation.md:3](../../.trellis/tasks/10-16-project-workspace-uiux/validation.md#L3)；v2后来补了亮色文字观察，但未将PA整体关闭。原生文字记录既不应被抹掉，也不能扩为全验收。

## 5 Roadmap自身哪里容易误读


| 问题 | 证据 | 影响与应改口径 |
| --- | --- | --- |
| 首章“先看实施记录”+多行已实现 | [docs/roadmap_v2.md:7](../roadmap_v2.md#L7)；[docs/roadmap_v2.md:48](../roadmap_v2.md#L48) | 虽有边界提示，快速阅读仍会把工作包标签看成验收结论；应分代码/自动化/原生/真实使用状态 |
| 同一文件A1旧not_run、新亮色通过、PF仍余项未验 | [docs/roadmap_v2.md:57](../roadmap_v2.md#L57)；[docs/roadmap_v2.md:67](../roadmap_v2.md#L67)；[docs/roadmap_v2.md:498](../roadmap_v2.md#L498) | 不是非黑即白的矛盾：断言粒度不同但未建立统一状态表；应标旧记录被哪条子断言替代 |
| B3原生“通过”仅看见提示 | [docs/roadmap_v2.md:72](../roadmap_v2.md#L72) | 提示出现不证明task.py持久化、循环拒绝、失败恢复已验证；标题过宽 |
| D1宽目标与“生成交接材料”窄路径并列完成 | [docs/roadmap_v2.md:55](../roadmap_v2.md#L55)；[docs/roadmap_v2.md:508](../roadmap_v2.md#L508) | 目标还包括结果/检查/缺项/下一步和接手效果；需要一个实际样本或明确缩窄本次交付 |
| PA计划较泛，缺故障输入和步骤 | [docs/roadmap_v2.md:537](../roadmap_v2.md#L537)；[docs/roadmap_v2.md:561](../roadmap_v2.md#L561) | “按工作包执行/逐路径核对”不足以避免只走happy path；应拆普通冲突、PRD失败、停止未结束等断言。PA-01还未讲清跨工程阅读会话清空与同工程返回保留各自范围 |
| 性能阈值和实测环境留待以后 | [docs/roadmap_v2.md:523](../roadmap_v2.md#L523) | 不能在未形成设备/数据量/阈值前宣称性能完成；同时不应临时虚构SLO |
| 实现范围没有独立冻结页 | [docs/roadmap_v2.md:94](../roadmap_v2.md#L94)；[docs/roadmap_v2.md:791](../roadmap_v2.md#L791) | 已有、候选、条件项、约束与本次选择混在长文；需列本次选中ID和排除ID，不能要求整份研究全实现 |
| 历史代码与时效提示距离较远 | [docs/roadmap_v2.md:354](../roadmap_v2.md#L354)；[docs/roadmap_v2.md:393](../roadmap_v2.md#L393) | 已修历史F01–F03仍占大表；虽然声明是基线，复核者必须反复跳转；应统一每义务的最新状态和证据 |



研究覆盖没有被正文正式规定为必建目标，旧FR取舍亦明确否认承诺，见[docs/roadmap_v2.md:688](../roadmap_v2.md#L688)。因此“实现不全”不能用47/64项竞品能力来计数。真正缺的是**本次范围声明+原子验收+done证据规则**。建议单独补充这些规则，保留原版本，不悄悄改写历史完成文字。

## 6 逐项义务核对矩阵

从当前PF行为/验收、PN约束及A/B/C/D场景拆出70项可复核断言。它们不是全部授权待办：已有范围、项目记录涉及范围和条件项在每行标明；原实施指令未知。“现存”只表示找到了相应代码/记录，不等于验收通过；“部分”表示实现或证据只覆盖一部分；“缺失”用于确未形成的合同/证据；“证据不足”不自动等于没有代码。

分类计数：现存40项、部分18项、证据不足11项、缺失1项。这不是完成率。完整机器可读版本见[义务清单](2026-10-17-completion-obligations.json)。AV编号对应[验收补充](2026-10-17-completion-acceptance-addendum.md)。

### PF-01


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-01.01 工程root切换与任务/资料归属正确<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 静态路径及既有记录；整条PA-01未关闭 | [docs/roadmap_v2.md:498](../roadmap_v2.md#L498)<br>[src/renderer/src/my/store.ts:108](../../src/renderer/src/my/store.ts#L108) | AV01 |
| PF-01.02 预览展开到中央、返回保留对象与来源位置<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | ui逻辑和既有task-presentation用例；本轮冒烟被环境阻断 | [docs/roadmap_v2.md:498](../roadmap_v2.md#L498)<br>[src/renderer/src/store/slices/ui.ts:49](../../src/renderer/src/store/slices/ui.ts#L49)<br>[src/renderer/src/store/slices/ui.ts:57](../../src/renderer/src/store/slices/ui.ts#L57) | AV01 |
| PF-01.03 旧工程迟到的读取响应不能污染新工程<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 阅读hook有请求序号/卸载处理；所有入口尚非本轮运行结论 | [docs/roadmap_v2.md:498](../roadmap_v2.md#L498)<br>[src/renderer/src/reader/use-document-reader.ts:93](../../src/renderer/src/reader/use-document-reader.ts#L93)<br>[src/renderer/src/my/store.ts:108](../../src/renderer/src/my/store.ts#L108) | AV01 |
| PF-01.04 实际A→B→A与阅读返回组合完整验收<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 证据不足 | roadmap:75明确未覆盖；原生亮色检查不能替代 | [docs/roadmap_v2.md:498](../roadmap_v2.md#L498)<br>[docs/roadmap_v2.md:75](../roadmap_v2.md#L75)<br>[.trellis/tasks/10-16-project-workspace-uiux/validation.md:9](../../.trellis/tasks/10-16-project-workspace-uiux/validation.md#L9) | AV01 |
| PF-01.05 原生外框、主题、拖拽/resize适用走查<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 部分 | 有最新亮色文字通过记录；深色、拖拽/resize未测且旧状态仍存在 | [docs/roadmap_v2.md:498](../roadmap_v2.md#L498)<br>[docs/roadmap_v2.md:57](../roadmap_v2.md#L57)<br>[docs/roadmap_v2.md:67](../roadmap_v2.md#L67)<br>[docs/roadmap_v2.md:75](../roadmap_v2.md#L75) | AV02 |


### PF-02


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-02.01 读取PRD/设计/清单并显示真实正文或诊断<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 共享读取/渲染链存在；既有记录非全场景关闭 | [docs/roadmap_v2.md:499](../roadmap_v2.md#L499)<br>[src/renderer/src/reader/use-document-reader.ts:15](../../src/renderer/src/reader/use-document-reader.ts#L15)<br>[src/main/services/documents/controller.ts:111](../../src/main/services/documents/controller.ts#L111) | AV03 |
| PF-02.02 外部保存仅产生候选，不静默替换正在读的版本<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | hook和reader状态机存在；本轮未运行watch链 | [docs/roadmap_v2.md:499](../roadmap_v2.md#L499)<br>[src/renderer/src/reader/use-document-reader.ts:20](../../src/renderer/src/reader/use-document-reader.ts#L20)<br>[src/renderer/src/store/slices/reader.ts:45](../../src/renderer/src/store/slices/reader.ts#L45) | AV03 |
| PF-02.03 用户显式阅读新版，保留打开基线和比较能力<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 状态机与diff服务可定位；原生完整场景未重验 | [docs/roadmap_v2.md:499](../roadmap_v2.md#L499)<br>[src/renderer/src/store/slices/reader.ts:52](../../src/renderer/src/store/slices/reader.ts#L52)<br>[src/main/services/documents/diff-service.ts:173](../../src/main/services/documents/diff-service.ts#L173) | AV03 |
| PF-02.04 读取失败保留旧正文并说明原因<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | hook契约和错误状态存在；需读失败夹具 | [docs/roadmap_v2.md:499](../roadmap_v2.md#L499)<br>[src/renderer/src/reader/use-document-reader.ts:24](../../src/renderer/src/reader/use-document-reader.ts#L24) | AV03 |
| PF-02.05 坏JSON/缺文件/无Git仍能理解并中性降级<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 既有文档诊断/diff路径；不代表新增工具所有错误场景已验 | [docs/roadmap_v2.md:499](../roadmap_v2.md#L499)<br>[src/main/services/documents/controller.ts:111](../../src/main/services/documents/controller.ts#L111)<br>[src/main/services/documents/diff-service.ts:213](../../src/main/services/documents/diff-service.ts#L213) | AV03 |


### PF-03


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-03.01 生命周期字段不由面板直接改写<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | adapter不发送status、scan白名单仍排除；本轮静态确认 | [docs/roadmap_v2.md:500](../roadmap_v2.md#L500)<br>[src/renderer/src/my/adapter.ts:185](../../src/renderer/src/my/adapter.ts#L185)<br>[src/main/services/scan.ts:443](../../src/main/services/scan.ts#L443) | AV04 |
| PF-03.02 白名单外字段ignored得到用户可见反馈<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | IPC透传ignored及store toast存在；未执行真实文件patch | [docs/roadmap_v2.md:500](../roadmap_v2.md#L500)<br>[src/main/ipc/tasks.ts:36](../../src/main/ipc/tasks.ts#L36)<br>[src/renderer/src/my/store.ts:235](../../src/renderer/src/my/store.ts#L235) | AV04 |
| PF-03.03 列表/表格提供实际task.py命令而非假保存<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 命令映射和复制成功逻辑存在；既有原生文字仅证复制archive | [docs/roadmap_v2.md:500](../roadmap_v2.md#L500)<br>[src/renderer/src/my/pages/WorkItemsPage.tsx:380](../../src/renderer/src/my/pages/WorkItemsPage.tsx#L380)<br>[docs/roadmap_v2.md:71](../roadmap_v2.md#L71) | AV04 |
| PF-03.04 拖拽/批量路径不暗中绕开生命周期权威<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 拖拽只复制命令、批量状态入口去除；未端到端覆盖所有视图 | [docs/roadmap_v2.md:500](../roadmap_v2.md#L500)<br>[src/renderer/src/my/pages/WorkItemsPage.tsx:1052](../../src/renderer/src/my/pages/WorkItemsPage.tsx#L1052)<br>[src/renderer/src/my/pages/WorkItemsPage.tsx:1517](../../src/renderer/src/my/pages/WorkItemsPage.tsx#L1517) | AV04 |


### PF-04


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-04.01 普通创建实际生成任务与原始描述PRD<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 创建IPC提供prdContent，创建器写文件；未真实创建业务任务 | [docs/roadmap_v2.md:501](../roadmap_v2.md#L501)<br>[src/main/ipc/tasks.ts:147](../../src/main/ipc/tasks.ts#L147)<br>[src/main/state.ts:420](../../src/main/state.ts#L420) | AV05 |
| PF-04.02 AI计划确认后生成描述、子任务、待确认问题PRD<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 计划IPC构建各段、完成页显示files/warnings；未调用模型 | [docs/roadmap_v2.md:501](../roadmap_v2.md#L501)<br>[src/main/ipc/planning.ts:30](../../src/main/ipc/planning.ts#L30)<br>[src/renderer/src/components/PlanningModal.tsx:284](../../src/renderer/src/components/PlanningModal.tsx#L284) | AV05 |
| PF-04.03 普通入口显示真实files/warnings和失败结果<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | P04/P05隔离探针：ok=false仍返回旧id；PRD警告被丢弃 | [docs/roadmap_v2.md:501](../roadmap_v2.md#L501)<br>[src/renderer/src/my/store.ts:254](../../src/renderer/src/my/store.ts#L254)<br>[src/renderer/src/my/pages/work-items/CreateIssueModal.tsx:32](../../src/renderer/src/my/pages/work-items/CreateIssueModal.tsx#L32) | AV05 |
| PF-04.04 重复/同名普通创建不得冒充新建成功<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | P04返回old-task；真实弹窗时序未运行 | [docs/roadmap_v2.md:501](../roadmap_v2.md#L501)<br>[src/renderer/src/my/store.ts:257](../../src/renderer/src/my/store.ts#L257)<br>[src/main/state.ts:429](../../src/main/state.ts#L429) | AV05 |
| PF-04.05 Jira重复导入打开原任务，恢复中断不重复创建<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 既有LocalTaskService幂等/对账路径和旧smoke存在；本轮未运行Jira | [docs/roadmap_v2.md:501](../roadmap_v2.md#L501)<br>[src/main/services/local-task/index.ts:143](../../src/main/services/local-task/index.ts#L143)<br>[src/main/services/local-task/index.ts:181](../../src/main/services/local-task/index.ts#L181) | AV06 |
| PF-04.06 已有用户PRD不覆盖，部分产物失败明确告知<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 创建器有存在检查及warning；普通UI没有消费warning；竞争/中断未验 | [docs/roadmap_v2.md:501](../roadmap_v2.md#L501)<br>[src/main/state.ts:475](../../src/main/state.ts#L475)<br>[src/renderer/src/my/store.ts:257](../../src/renderer/src/my/store.ts#L257) | AV05 |
| PF-04.07 各入口的声明与实际文件逐一核对<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 证据不足 | 有构建/实施文字；未见三入口错误与重试完整行为证据 | [docs/roadmap_v2.md:501](../roadmap_v2.md#L501)<br>[docs/roadmap_v2.md:49](../roadmap_v2.md#L49)<br>[docs/roadmap_v2.md:561](../roadmap_v2.md#L561) | AV05 |


### PF-05


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-05.01 计划清单/assembled/emitted/模型遵守不同级别<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 观测面板有事实等级及措辞；本轮未执行全事件链 | [docs/roadmap_v2.md:502](../roadmap_v2.md#L502)<br>[src/renderer/src/observation/ObservationPanel.tsx:30](../../src/renderer/src/observation/ObservationPanel.tsx#L30)<br>[src/renderer/src/observation/ObservationPanel.tsx:105](../../src/renderer/src/observation/ObservationPanel.tsx#L105) | AV07 |
| PF-05.02 回执保留来源与工程/任务范围，不挂错任务<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 证据不足 | 存在归属实现与旧记录；跨页面/迟到/并发组合未逐项重验 | [docs/roadmap_v2.md:502](../roadmap_v2.md#L502)<br>[docs/roadmap_v2.md:502](../roadmap_v2.md#L502)<br>[src/renderer/src/observation/use-observation-scope.ts:1](../../src/renderer/src/observation/use-observation-scope.ts#L1) | AV07 |
| PF-05.03 Flow通过不自动等于外部Trellis/业务验收通过<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | Flow独立服务和运行状态；不能从现存服务证明所有文案均正确 | [docs/roadmap_v2.md:502](../roadmap_v2.md#L502)<br>[src/main/services/flow-run.ts:34](../../src/main/services/flow-run.ts#L34)<br>[docs/roadmap_v2.md:502](../roadmap_v2.md#L502) | AV07 |


### PF-06


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-06.01 继续复用现有acpx及Codex/Claude基础<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 历史核心矩阵有通过记录；本轮未启动Agent | [docs/roadmap_v2.md:503](../roadmap_v2.md#L503)<br>[src/main/services/acp.ts:6](../../src/main/services/acp.ts#L6)<br>[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:39](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L39) | AV08 |
| PF-06.02 显式启动与发送；忙时草稿不自动排队<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 服务显式入口及原矩阵；非本次新验收 | [docs/roadmap_v2.md:503](../roadmap_v2.md#L503)<br>[src/main/services/acp.ts:312](../../src/main/services/acp.ts#L312)<br>[src/main/services/acp.ts:378](../../src/main/services/acp.ts#L378)<br>[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:54](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L54) | AV08 |
| PF-06.03 权限/取消/恢复按真实结果与归属处理<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | owned guard和取消状态存在；旧核心通过记录 | [docs/roadmap_v2.md:503](../roadmap_v2.md#L503)<br>[src/main/services/acp.ts:246](../../src/main/services/acp.ts#L246)<br>[src/main/services/acp.ts:446](../../src/main/services/acp.ts#L446)<br>[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:49](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L49) | AV08 |
| PF-06.04 会话恢复和材料绑定不等于业务状态流转<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 现存 | 材料快照与历史接受记录；本轮不验证真实厂商 | [docs/roadmap_v2.md:503](../roadmap_v2.md#L503)<br>[src/main/services/acp.ts:398](../../src/main/services/acp.ts#L398)<br>[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:46](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L46) | AV08 |
| PF-06.05 系统IME、配置操作、草稿切换原生余项完成<br>范围：既有能力/收尾验证；不能据此认定zcode本次应重做 | 证据不足 | 原验收明确pending native；后续实施记录记载未动ACP | [docs/roadmap_v2.md:503](../roadmap_v2.md#L503)<br>[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:56](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L56)<br>[docs/roadmap_v2.md:503](../roadmap_v2.md#L503) | AV08 |


### PF-07


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-07.01 原问题/整理结果/未决问题留回同一任务资料<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 普通和计划PRD不同来源段落；真实澄清效果仍未验 | [docs/roadmap_v2.md:504](../roadmap_v2.md#L504)<br>[src/main/ipc/tasks.ts:147](../../src/main/ipc/tasks.ts#L147)<br>[src/main/ipc/planning.ts:38](../../src/main/ipc/planning.ts#L38) | AV05 |
| PF-07.02 用户选取本地相关资料后可连续阅读<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 收尾时新增资料复制入口可定位；没有本轮真实粗需求→澄清/连续阅读样本 | [docs/roadmap_v2.md:504](../roadmap_v2.md#L504)<br>[src/renderer/src/reader/use-document-reader.ts:15](../../src/renderer/src/reader/use-document-reader.ts#L15)<br>[src/renderer/src/my/pages/IssuePeek.tsx:137](../../src/renderer/src/my/pages/IssuePeek.tsx#L137)<br>[docs/roadmap_v2.md:504](../roadmap_v2.md#L504) | AV09 |
| PF-07.03 创建计划不自动开始Agent或视作已获实施确认<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | createFromPlan固定planning；handoff默认只核对；未扩团队审批 | [docs/roadmap_v2.md:504](../roadmap_v2.md#L504)<br>[src/main/ipc/planning.ts:48](../../src/main/ipc/planning.ts#L48)<br>[src/main/services/handoff.ts:22](../../src/main/services/handoff.ts#L22) | AV09 |


### PF-08


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-08.01 计划完成页与详情统一交接出口<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 旧handoff已移除，新接口共用；两入口完整UI比对未运行 | [docs/roadmap_v2.md:505](../roadmap_v2.md#L505)<br>[src/main/ipc/planning.ts:67](../../src/main/ipc/planning.ts#L67)<br>[src/renderer/src/components/PlanningModal.tsx:306](../../src/renderer/src/components/PlanningModal.tsx#L306)<br>[src/main/ipc/tasks.ts:180](../../src/main/ipc/tasks.ts#L180) | AV10 |
| PF-08.02 交接默认只阅读，不自动建任务/开工/归档<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 确定性文本及默认意图存在 | [docs/roadmap_v2.md:505](../roadmap_v2.md#L505)<br>[src/main/services/handoff.ts:22](../../src/main/services/handoff.ts#L22)<br>[src/main/services/handoff.ts:85](../../src/main/services/handoff.ts#L85) | AV10 |
| PF-08.03 真实文件清单与无法读取问题如实告知<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | P06：exists为真但PRD读取失败→issues=[]并称无问题 | [docs/roadmap_v2.md:505](../roadmap_v2.md#L505)<br>[src/main/services/handoff.ts:51](../../src/main/services/handoff.ts#L51)<br>[src/main/services/handoff.ts:103](../../src/main/services/handoff.ts#L103)<br>[src/main/ipc/tasks.ts:185](../../src/main/ipc/tasks.ts#L185) | AV10 |
| PF-08.04 上次结果、本次增量、缺项、下一步可从接续说明获得<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | P07仅生成索引/阶段/意图；未见真实使用证明已有资料等效满足 | [docs/roadmap_v2.md:505](../roadmap_v2.md#L505)<br>[src/main/services/handoff.ts:77](../../src/main/services/handoff.ts#L77)<br>[docs/roadmap_v2.md:505](../roadmap_v2.md#L505)<br>[docs/roadmap_v2.md:677](../roadmap_v2.md#L677) | AV11 |
| PF-08.05 父子关联经受控命令持久化，失败不伪造链接<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | handler检查退出码；peek有部分失败提示；原生记录只证提示可见 | [docs/roadmap_v2.md:505](../roadmap_v2.md#L505)<br>[src/main/ipc/tasks.ts:282](../../src/main/ipc/tasks.ts#L282)<br>[src/renderer/src/my/pages/IssuePeek.tsx:166](../../src/renderer/src/my/pages/IssuePeek.tsx#L166)<br>[docs/roadmap_v2.md:72](../roadmap_v2.md#L72) | AV12 |
| PF-08.06 隔天/换工具/真实返工能继续原任务<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 证据不足 | 原记录仍缺真实样本；不能以复制材料按钮代替 | [docs/roadmap_v2.md:505](../roadmap_v2.md#L505)<br>[docs/roadmap_v2.md:505](../roadmap_v2.md#L505)<br>[docs/roadmap_v2.md:593](../roadmap_v2.md#L593) | AV11 |


### PF-09


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-09.01 当前仓库分支、基线、暂存/未暂存/未跟踪分组<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | Git读取服务与UI存在，记录一次本仓库观察 | [docs/roadmap_v2.md:506](../roadmap_v2.md#L506)<br>[src/main/services/devtools-git.ts:34](../../src/main/services/devtools-git.ts#L34)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:62](../../src/renderer/src/my/pages/DevToolsPage.tsx#L62)<br>[docs/roadmap_v2.md:68](../roadmap_v2.md#L68) | AV13 |
| PF-09.02 新入口只发读取类Git命令且相对路径受限<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 参数只含status/log/diff等，contained检查；未完整恶意路径测试 | [docs/roadmap_v2.md:506](../roadmap_v2.md#L506)<br>[src/main/services/devtools-git.ts:94](../../src/main/services/devtools-git.ts#L94)<br>[src/main/services/devtools-git.ts:105](../../src/main/services/devtools-git.ts#L105) | AV13 |
| PF-09.03 非Git项目中性降级，不阻挡任务阅读<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 服务分支存在；原生记录明确未触发该场景 | [docs/roadmap_v2.md:506](../roadmap_v2.md#L506)<br>[src/main/services/devtools-git.ts:39](../../src/main/services/devtools-git.ts#L39)<br>[docs/roadmap_v2.md:68](../roadmap_v2.md#L68) | AV13 |
| PF-09.04 Diff有截断与二进制说明<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 返回值/UI有截断标记；底层git缓冲先全量收集，未测极大输出 | [docs/roadmap_v2.md:506](../roadmap_v2.md#L506)<br>[src/main/services/devtools-git.ts:115](../../src/main/services/devtools-git.ts#L115)<br>[src/main/services/git.ts:15](../../src/main/services/git.ts#L15)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:145](../../src/renderer/src/my/pages/DevToolsPage.tsx#L145) | AV13 |
| PF-09.05 多仓库如启用须标明各来源<br>范围：条件义务：是否选择/配置未知；不自动认定为本批必做缺失 | 证据不足 | 当前Git IPC只读当前root；是否本批选择多仓库未知 | [docs/roadmap_v2.md:506](../roadmap_v2.md#L506)<br>[src/main/ipc/devtools.ts:11](../../src/main/ipc/devtools.ts#L11)<br>[docs/roadmap_v2.md:506](../roadmap_v2.md#L506) | AV13 |


### PF-10


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-10.01 目录、脚本来源与拟执行命令可核对<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | package.json发现和UI选择器存在；真实多工程未完成 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/main/services/dev-run.ts:19](../../src/main/services/dev-run.ts#L19)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:329](../../src/renderer/src/my/pages/DevToolsPage.tsx#L329) | AV14 |
| PF-10.02 脚本名称按选中的名称准确执行，不被shell再拆分<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | P02/P03捕获Windows未引用命令文本；未执行任何shell | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/main/services/dev-run.ts:79](../../src/main/services/dev-run.ts#L79) | AV14 |
| PF-10.03 输出、退出码/信号与运行归属显示真实<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | run字段和close处理存在；记录一次typecheck；本轮未跑工程脚本 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/main/services/dev-run.ts:90](../../src/main/services/dev-run.ts#L90)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:376](../../src/renderer/src/my/pages/DevToolsPage.tsx#L376)<br>[docs/roadmap_v2.md:69](../roadmap_v2.md#L69) | AV14 |
| PF-10.04 停止只作用于面板拥有的运行<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 只从内部Map取child/pid；非面板进程保护未做真实验证 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/main/services/dev-run.ts:118](../../src/main/services/dev-run.ts#L118) | AV15 |
| PF-10.05 停止请求与已确认停止分开，不提前成功<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | P01累计stopped=1时state仍running；UI立即显示已停止 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/main/services/dev-run.ts:137](../../src/main/services/dev-run.ts#L137)<br>[src/main/services/dev-run.ts:145](../../src/main/services/dev-run.ts#L145)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:288](../../src/renderer/src/my/pages/DevToolsPage.tsx#L288) | AV15 |
| PF-10.06 暂停日志跟随不停止进程<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | RunConsole仅改变follow/scroll；原生行为未独立验证 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:174](../../src/renderer/src/my/pages/DevToolsPage.tsx#L174) | AV14 |
| PF-10.07 多工程明确顺序和每项启动/失败结果<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 仅顺序发起spawn；异步退出不在组合汇总；没有完整组合验收 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:265](../../src/renderer/src/my/pages/DevToolsPage.tsx#L265)<br>[src/main/services/dev-run.ts:93](../../src/main/services/dev-run.ts#L93) | AV16 |
| PF-10.08 没有任何可用脚本时不报告组合启动成功<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 静态：空picked全部continue，dirs>0仍走success分支；未UI复现 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:265](../../src/renderer/src/my/pages/DevToolsPage.tsx#L265) | AV16 |
| PF-10.09 连续点击/中断时不无意重复启动组合<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 证据不足 | startCombo未设busy或防重标记；静态风险，尚未交互复现 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:265](../../src/renderer/src/my/pages/DevToolsPage.tsx#L265)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:313](../../src/renderer/src/my/pages/DevToolsPage.tsx#L313) | AV16 |
| PF-10.10 就绪条件若定义须按真实条件判断，否则仅称进程存活<br>范围：条件义务：是否选择/配置未知；不自动认定为本批必做缺失 | 部分 | 无就绪检查时中性措辞已实现；条件配置/依赖图没有实现证据 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:168](../../src/renderer/src/my/pages/DevToolsPage.tsx#L168)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:323](../../src/renderer/src/my/pages/DevToolsPage.tsx#L323)<br>[docs/roadmap_v2.md:168](../roadmap_v2.md#L168) | AV16 |
| PF-10.11 真实前后端/多工程长期运行、部分失败、停止可复查<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 证据不足 | roadmap仍列真实组合/长驻停止为待测；不等于程序全缺失 | [docs/roadmap_v2.md:507](../roadmap_v2.md#L507)<br>[docs/roadmap_v2.md:70](../roadmap_v2.md#L70)<br>[docs/roadmap_v2.md:75](../roadmap_v2.md#L75)<br>[docs/roadmap_v2.md:507](../roadmap_v2.md#L507) | AV16 |


### PF-11


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PF-11.01 集中呈现本次变化、检查、未覆盖、已知问题和继续方式<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 索引/PRD/意图有代码；未形成完整结果摘要或等效使用证据 | [docs/roadmap_v2.md:508](../roadmap_v2.md#L508)<br>[src/main/services/handoff.ts:77](../../src/main/services/handoff.ts#L77)<br>[src/renderer/src/pages/TaskDetail.tsx:269](../../src/renderer/src/pages/TaskDetail.tsx#L269)<br>[docs/roadmap_v2.md:508](../roadmap_v2.md#L508) | AV11 |
| PF-11.02 业务认可、检查通过、归档、Jira与发布分别决定<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 归档直写禁用，Jira单独外部动作；全部组合未验 | [docs/roadmap_v2.md:508](../roadmap_v2.md#L508)<br>[src/main/ipc/tasks.ts:27](../../src/main/ipc/tasks.ts#L27)<br>[src/main/ipc/jira.ts:28](../../src/main/ipc/jira.ts#L28) | AV17 |
| PF-11.03 本地任务无需Jira或发布也能收尾<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 普通本地创建、命令提示和handoff均不要求Jira | [docs/roadmap_v2.md:508](../roadmap_v2.md#L508)<br>[src/main/ipc/tasks.ts:147](../../src/main/ipc/tasks.ts#L147)<br>[src/main/services/handoff.ts:28](../../src/main/services/handoff.ts#L28) | AV17 |
| PF-11.04 实际接手者能说清目标、结果、未测、下一步<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 证据不足 | 真实第二人接手仍not_run；原生“生成成功”只覆盖索引 | [docs/roadmap_v2.md:508](../roadmap_v2.md#L508)<br>[docs/roadmap_v2.md:55](../roadmap_v2.md#L55)<br>[docs/roadmap_v2.md:73](../roadmap_v2.md#L73)<br>[docs/roadmap_v2.md:617](../roadmap_v2.md#L617) | AV11 |


### PN-01


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PN-01.01 原字段/用户改动保留，不引入生命周期双主<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | scan保留原record，白名单排除status；创建/更新竞争仍需夹具 | [docs/roadmap_v2.md:516](../roadmap_v2.md#L516)<br>[src/main/services/scan.ts:449](../../src/main/services/scan.ts#L449)<br>[src/main/state.ts:429](../../src/main/state.ts#L429) | AV04 |


### PN-02


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PN-02.01 每次动作与迟到事件保持root/task/session归属<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 文档/ACP有归属校验；新运行仅dir/id、全局列表，适用全局/项目范围未定义 | [docs/roadmap_v2.md:517](../roadmap_v2.md#L517)<br>[src/main/services/acp.ts:378](../../src/main/services/acp.ts#L378)<br>[src/renderer/src/reader/use-document-reader.ts:93](../../src/renderer/src/reader/use-document-reader.ts#L93)<br>[src/main/services/dev-run.ts:35](../../src/main/services/dev-run.ts#L35)<br>[src/main/ipc/devtools.ts:44](../../src/main/ipc/devtools.ts#L44) | AV01 |


### PN-03


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PN-03.01 文件更新/回合/进程/就绪/检查/业务/发布不混同<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 多处边界文案正确；全部停止仍把请求当完成 | [docs/roadmap_v2.md:518](../roadmap_v2.md#L518)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:168](../../src/renderer/src/my/pages/DevToolsPage.tsx#L168)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:288](../../src/renderer/src/my/pages/DevToolsPage.tsx#L288)<br>[docs/roadmap_v2.md:518](../roadmap_v2.md#L518) | AV15 |


### PN-04


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PN-04.01 失败保留可用旧内容与冲突用户内容<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | reader保留旧版，metadata mtime冲突保护；故障组合未全验 | [docs/roadmap_v2.md:519](../roadmap_v2.md#L519)<br>[src/renderer/src/reader/use-document-reader.ts:24](../../src/renderer/src/reader/use-document-reader.ts#L24)<br>[src/main/services/scan.ts:426](../../src/main/services/scan.ts#L426) | AV03 |
| PN-04.02 外部结果未知先核对，不能自动重做副作用<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 证据不足 | Jira有操作对账；未证明全部外部路径均满足，未做真实写回 | [docs/roadmap_v2.md:519](../roadmap_v2.md#L519)<br>[src/main/services/local-task/index.ts:230](../../src/main/services/local-task/index.ts#L230)<br>[src/main/ipc/jira.ts:28](../../src/main/ipc/jira.ts#L28) | AV06 |


### PN-05


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PN-05.01 携带资料显式选择，默认不自动分享<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | PRD复选默认false，交接包含显式携带提示 | [docs/roadmap_v2.md:520](../roadmap_v2.md#L520)<br>[src/renderer/src/pages/TaskDetail.tsx:277](../../src/renderer/src/pages/TaskDetail.tsx#L277)<br>[src/main/services/handoff.ts:93](../../src/main/services/handoff.ts#L93) | AV10 |
| PN-05.02 诊断不含凭据，并明确模型服务可能收到资料<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 证据不足 | 规划边界明确；未找到面向新日志与错误复制的脱敏专项证据 | [docs/roadmap_v2.md:520](../roadmap_v2.md#L520)<br>[docs/roadmap_v2.md:520](../roadmap_v2.md#L520)<br>[src/main/services/dev-run.ts:91](../../src/main/services/dev-run.ts#L91) | AV18 |


### PN-06


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PN-06.01 原生IME/草稿/焦点/Esc/窄宽/主题适用实测<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 原生亮色文字观察存在；IME/深色/全组合并未闭环 | [docs/roadmap_v2.md:521](../roadmap_v2.md#L521)<br>[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:56](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L56)<br>[docs/roadmap_v2.md:75](../roadmap_v2.md#L75)<br>[docs/roadmap_v2.md:521](../roadmap_v2.md#L521) | AV02 |


### PN-07


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PN-07.01 复用固定acpx，不重复构建编码循环<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | 现有import/固定运行层与原记录；后续变更未触及ACP主体 | [docs/roadmap_v2.md:522](../roadmap_v2.md#L522)<br>[src/main/services/acp.ts:6](../../src/main/services/acp.ts#L6)<br>[.trellis/tasks/10-16-acp-runtime-foundation/validation.md:9](../../.trellis/tasks/10-16-acp-runtime-foundation/validation.md#L9) | AV08 |
| PN-07.02 运行资源有归属且可解释地停止/断开<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 部分 | 内部child句柄存在；退出确认/停止失败结果仍有缺口 | [docs/roadmap_v2.md:522](../roadmap_v2.md#L522)<br>[src/main/services/dev-run.ts:118](../../src/main/services/dev-run.ts#L118)<br>[src/renderer/src/my/pages/DevToolsPage.tsx:288](../../src/renderer/src/my/pages/DevToolsPage.tsx#L288) | AV15 |


### PN-08


| 断言/范围 | 实现判断 | 验证证据与缺口 | 源码/原文位置 | 复验 |
| --- | --- | --- | --- | --- |
| PN-08.01 性能/可靠性目标有设备、数据量、步骤、阈值基线<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 缺失 | 仅规定以后确认；本批C2/C3缺可复查的目标/阈值，不能判断性能通过 | [docs/roadmap_v2.md:523](../roadmap_v2.md#L523)<br>[docs/roadmap_v2.md:523](../roadmap_v2.md#L523)<br>[docs/roadmap_v2.md:525](../roadmap_v2.md#L525) | AV18 |
| PN-08.02 估算只算剩余/新增工作，不虚构团队日历<br>范围：可实施规划/约束；记录涉及的实现不能代替原始授权与逐项验收 | 现存 | roadmap明确不重估已完成工作，但不是实现验收证据 | [docs/roadmap_v2.md:523](../roadmap_v2.md#L523)<br>[docs/roadmap_v2.md:807](../roadmap_v2.md#L807) | AV18 |


## 7 没有自动算作缺失的可选范围

正式跨设备资料确认/审批、组织RBAC与共享存储、共享视图/团队通知统计、专项/交付目标、分拣台、高级字段/类型平台、小队/通用自动化扩张、测试或文档流水线、更多任务平台、Jira兼容API/PAT、非研发扩张、远程机器/云开发，都需要真实场景或另行选择。当前有些存在基础入口/Flow，有些没有完整平台；本审计不把它们都列成zcode未完成项。

同样，日志长期留存、自动就绪检查、完整多仓库Git管理和跨runtime无损会话迁移不能因为图中出现相关概念而成为默认承诺。若原始实施指令另外选定，应在范围表补上具体断言后再核对。

## 8 可以怎样对外声明当前结果

建议的保守说法是：“已在当前工作区实现并接入A3、B、C及D1的一部分功能路径；类型检查通过，既有文字记录含部分原生观察；本次范围与原始回复尚待对齐。普通创建错误反馈、停止确认、PRD读取失败、完整接续结果及真实组合/接手验收仍有缺口，不能称整份roadmap已验收完成。”

如果zcode原话只声称某个更小范围完成，必须用那个范围重新核对，不能替它放大承诺。用户的直觉可以提示缺口，但结论应落在这里的具体断言、实际结果和证据上。

## 9 保全与仍未知事项

本审计未修改原roadmap、v2、业务与任务记录或产品代码，未提交或推送。工作区另有上述并发变化，不能说整个目录自开始以来完全不变。审计只新增独立报告、验收补充与结构化证据；写入前固定当前源文件与既有文件指纹，写入后确认本次保存没有再改变它们，另核对Git索引和HEAD。具体保全结果另存核验记录。

仍未知：zcode原回复、当时完整实施指令、原生记录可复查附件与目标构建身份、真实业务工程组合/就绪条件、第二人接续样本。它们限制完成范围与UI结论，不阻止本报告指出已定位的逻辑/证据缺口，也不授权新实现。
