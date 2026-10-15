# dsh-professor-spike

Professor：一个带独立 Home 入口的 DeepSeek Harness 插件（bundle）。Home 可创建和继续原生 Professor 会话；学术能力仍限于名为 `professor` 的可选预设：**22 个** `professor_*` 工具、**6 个**自带技能、**5 个**内置教学预设和中文优先助教人格。普通编码会话不获得这些学术工具或技能。

当前版本 **`0.12.0-beta.1`**，面向 Apple Silicon Mac 的首个测试版，尚非完整稳定版。发布范围、安装要求、已知限制与验证边界见 [首版说明](docs/releases/0.12.0-beta.1.md)。

- 2026-10-15 完整本地验收：893 项通过，0 失败、0 跳过（配置已有增强运行时）。独立打包副本的 LaTeX 专项验收 66/66 通过。
- LaTeX 默认模板适用于全部学习预设；显式自定义模板仍优先。支持直接提交 `body_tex`，避免先转义再整篇重写。
- 已补齐会话沙箱策略传递、受限正文预检查、环境错误分类和有条件的编译结果复用。示例 PDF 已真实编译并检查，但原权限报错的同会话复现、真实模型完整交付和跨平台验收仍未完成。
- `private: true` 保留，防止误发布到 npm；当前许可证状态仍为 `UNLICENSED`，未宣称已采用开源许可证。

### 历史验收记录：2026-10-12

以下是当时的验收结果，保留日期；不是对当前版本的额外发布承诺。

- **全量验证（2026-10-12，配置增强运行时后）**：`npm run verify` **exit 0** → `npm test` **744 项 = 744 过 / 0 失败 / 0 跳过**（含生产 OCR 测试），`verify:e2e` **28/28**，`verify:syntax` **177 个文件**，`verify:skills` **39 项**、`verify:sync` **89 项**、`verify:dist` **70 项**、`verify:host` **65 项** —— 全部 `ALL PASS`（exit 0）。
- **增强（OCR）运行时**：本机**存在且可原样复用、无需新安装**——`/tmp/professor-auto-prepare/env-e270c763ff8847c4562c/bin/python`（Python 3.12、`docling-slim 2.137.0`、`rapidocr 3.10.0`、`pymupdf 1.28.2`、`pypdfium2 5.14.0`），模型在 `…/models`，backend `pdfium`（**执行时重新核对**，不是推断）。配置方式：设 `DSH_PROFESSOR_ENHANCE_PYTHON`、`DSH_PROFESSOR_ENHANCE_BACKEND=pdfium`、`DSH_PROFESSOR_ENHANCE_ARTIFACTS`，**并保持 `DSH_PROFESSOR_PYTHON` 未设置**，以免影响有意保留的回退夹具；此配置下 `real enhancement recovers scanned text…` **1/1 通过、零跳过**。该测试早先的 `no prepared enhancement runtime configured` 跳过是**某次未配置该运行时的运行**留下的带日期记录，保留原样、与本轮结果分开记账；**环境变量未设置或工作区没有缓存，只说明本次运行器没有配置它，不等于机器上没有运行时**。
- **工具面：22 个**（`professor_artifact_create/status`、`course_list/manage`、`diagnostics`、`extract`、`index_sync`、`latex_compile`、`material_read`、`memory_read/status/update`、`paths`、`project_init`、`search`、`session_bind/status`、`state_read/update`、`workspace_discover/confirm/rebuild`）。由 `src/tools/*_TOOL_NAME` 常量点数得到，并与 `verify-host-schemas`（`registered.length === 22`）、`verify-distribution`（`fake.tools.length === 22`）、`verify-e2e`（`names.length === 22`）三处独立断言一致。
- **技能 6 个 / 教学预设 5 个**：`skills/professor-{course-management,latex,notes,research,review,study}`；`BUNDLED_PRESETS` = `builtin-progressive`、`builtin-socratic`、`builtin-exam-review`、`builtin-coding`、`builtin-quick-answers`。两者都由 `verify:dist` 装后自测逐条断言。
- **Mac PDF OCR / 增强已实现，但只在读取路径**：`professor_material_read` 的 `enhance` 动作经 `src/extract/scripts/enhance_pdf.py` 做本地 OCR/结构抽取，OCR 模型按 sha256 锁定、进程内**禁网**，运行时按哈希锁定的 workspace 规则自动制备。**索引抽取路径 `professor_extract` 不做 OCR**——扫描件与纯图片仍报 `unsupported`（见 [§2.4](#24-文本抽取后端坐标与边界)）。独立图片 OCR 与 Windows/Linux 宿主的增强验收**未完成**（`professor_diagnostics.notImplemented` 如实列出）。
- **阶段状态**：Phase 0–5 已验收；**Phase 6 与 Phase 7 只有部分证据，未整体完成**；**Phase 8 与 Mac 发布就绪保持未关闭**，要等各自的实际判据通过。
- **教学交互 live-model 验收**：记录为 **6/8 通过，S3/S5 保持 OPEN**（窄缺口见 `docs/qa/2026-10-12-teaching-interaction/live-model/RETEST-RESULTS.md`）。用户决定「Accept and close」是**范围结案、保留限制**，**不是八例全通过**；这一区分写在 `live-model/adjudications.json`，并由修好的 `live-model/aggregate-assessment.json` 单独报告（`counts.passed: 6` / `counts.open: 2`、`all_passed: false`、`decision.is_acceptance_of_full_pass: false`）。
- **不声称的部分**：跨平台测试按 2026-10-11 用户决定推迟（Windows/Linux/macOS Intel 未验证）；原生**永久删除**受宿主 API 限制，归档不等于删除；Home 浏览器渲染、会话内模型轮次仍 `UNVERIFIED`；本轮**没有**付费模型调用、真实桌面安装、Git 提交或推送。

实时台账与边界见 `docs/v1/STATUS.md`、`docs/v1/PHASE6.md`。


---

## 1. 安装

2026-10-08 开发进度：Phase 6 部分页面已接入，Home 提供课程详情与技能设置入口。
全量 435/435；真实隔离浏览器已验证文件夹扫描/歧义确认/更换保护、课程偏好隔离、重建/诊断、材料列表和原生学习入口，以及此前的记忆开关。课程管理、材料定向上下文和完整阶段验收仍待补齐，Phase 6 尚未完成。见 `docs/v1/PHASE6.md`。真实桌面安装未更新。

本包**不发布到 npm**（`"private": true`）。作为 bundle 装进 profile：在 profile 的 `package.json` 里声明依赖并把它加入 `dsh.profile.bundles`。

```json
{
  "dependencies": {
    "dsh-professor-spike": "link:/absolute/path/to/professor-harness-spike-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-professor-spike"
      ]
    }
  }
}
```

`link:` 会让 `node_modules/dsh-professor-spike` 成为指向该目录的符号链接；也可用 tarball 或 git URL 分发。装完**需要重启 Harness** 才会挂载新 bundle。

为什么必须是 profile 依赖：预设里子插件的裸名 `dsh-professor-spike` 由预设注册表按 **profile 目录**（`baseUrl`）解析，装不到 profile 里就解析不到。

启用：重启后 `professor` 出现在 Harness 的 agent 预设名单中，**由使用者选择**（可设为默认，也可按会话选）。插件不会改 `agent-preset-registry.config.default`，所以不会影响其它会话。

---

## 2. 提供什么

### 2.1 UI 入口与 `professor` 预设

`cordis.patch.yml` 一次 `insert` 插入 UI-only 的部署级 `professor-app` 行和 `@deepseek-ai/dsh-agent-preset`（`id: professor`，`order: 20`）。全局行只提供 Home 后端，不注册学术工具/技能；预设的 `plugins` 列表仍是学术工具面（Harness 预设 schema 没有 `tools`/`allow`/`deny` 字段，最小权限靠组合表达）。

| 行 | 作用 |
|---|---|
| `@deepseek-ai/dsh-persona` | Professor 常驻人格（约 1.4 KB 中文优先；细节交给技能按需加载） |
| `dsh-professor-spike` | 本插件：22 个工具 + 自带技能 provider（**只在这一层注册**，因此技能仅 Professor 可见） |
| `@deepseek-ai/dsh-tool-fs` / `-fs-search` | 读/写/编辑 + ripgrep 检索 |
| `@deepseek-ai/dsh-tool-bash` | LaTeX 编译门（Harness 无 TeX 封装，必须走 shell；Windows 上自动禁用） |
| `@deepseek-ai/dsh-tool-web` | 联网检索 |
| `@deepseek-ai/dsh-tool-ask-user` | 笔记格式门与歧义澄清 |
| `@deepseek-ai/dsh-tool-todo` / `present` | 复习分块与产物交付卡片 |
| `@deepseek-ai/dsh-tool-skill` | 模型侧技能目录与加载器 |
| `compaction` 组 | `compaction-basic` + `command-compact` + `tool-result-pruner` |

**刻意不含**：`skill-filesystem`（避免与自带 provider 竞争）、`goal`/`plan`/`subagent`/`workflow`/`jobs`/`pwsh`/插件管理器。

### 2.2 二十二个工具

| 工具 | 用途 |
|---|---|
| `professor_project_init` | 创建 `.professor/project.yaml` 与项目结构。**只创建**：已存在或 schema 更新时拒绝，绝不覆盖 |
| `professor_course_manage` | 注册 / 更新 / 归档 / 重新激活课程，或从 Personal-Agent 注册表**只读导入**；每次一个操作；归档不删任何材料 |
| `professor_course_list` | 列出课程、按 id 或代码解析（歧义则返回候选请求确认）、校验源与输出路径、报告仍未归属的索引文件 |
| `professor_session_bind` | 把**当前会话**绑定/解绑到课程；改动追加进该会话的历史 |
| `professor_session_status` | 报告当前会话的绑定、已解析课程与历史；只读；**绝不**读其它会话的绑定 |
| `professor_index_sync` | 建立/刷新文件索引（`.professor/indexes/files.json`）：稳定 `file_id`、fs 版本 + 内容哈希、复用未变记录、消失的文件标 `missing` 而不删记录；**按已注册源根与 `category_rules` 归属课程**并报告 `classification_source`/`classification_confidence`，未匹配一律 `unassigned`；不接受自由形式的 `root` |
| `professor_extract` | 抽取文本并**标题感知分块**写入 `.professor/indexes/chunks/`；文本类直读，**PDF 先 PyMuPDF、其次 Ghostscript txtwrite，Office 走打包 Python**（先观测再声明，见 [§2.4](#24-文本抽取后端坐标与边界)）；**索引路径不做 OCR**——图片与无文本层 PDF 一律 `unsupported`；页码/张号只来自真实后端 |
| `professor_material_read` | 按需读取材料：`plan` 有界摘录 / `text` 正文分段（单次最多 6 页 32000 字符，`continue` + `text_offset` 续读）/ **`enhance` 对最多 6 页 PDF 做本地 OCR 与结构抽取**（增强运行时已制备时）/ `pages` 出页图 / `status` 覆盖率与备注。`sourceHash#page@variant` 台账确定性去重，摘录有界，物理页码与页脚标号标 `correspondence:'not-established'` |
| `professor_search` | 在已抽取分块上做**预算受限**检索（`max_chunks`/`max_sources` 硬预算），返回带完整溯源的结果与诊断；只读 |
| `professor_state_read` | 读取学习状态（PROGRESS / KNOWLEDGE / MISTAKES / INDEX），容忍标题漂移；只读；未绑定会话不回退 |
| `professor_state_update` | 按 `evidence` 门更新状态（`none` 一律拒绝写入）；`entry_id` 合并不重复；`revision` 并发拒绝；超预算压缩 |
| `professor_artifact_create` | 生成 Markdown 笔记 / LaTeX 笔记工程 / 考试复习产物；格式门、输出根校验、默认**不覆盖**、溯源引用块 |
| `professor_artifact_status` | 列出已生成产物的路径、版本、字节数与健康问题；只读 |
| `professor_latex_compile` | 先按文档分类再选驱动：**插件自己生成的 `main.tex`** 带 `dsh-professor-requirement: unicode-cjk`（正文中含插件生成的中文章节名），用 **XeLaTeX** 编译（有 latexmk 时为 `latexmk -xelatex`），CJK 字体取自 **TeX 发行版自带的 Fandol**，不写死任何操作系统字体名；**用户自己的 `main.tex`** 不声明该要求，保持原有驱动（`latexmk -pdf`）不变。`compiler` 里给出 `requirement`/`flavor`/`cjk_fonts`。缺 XeLaTeX 或缺 CJK 字体 → `compiler_unavailable` 并说明原因，**不**伪装成编译失败、也**不**静默退回 pdfTeX |
| `professor_memory_status` | 持久记忆状态：开关、存储健康、计数与预算；**不看内容** |
| `professor_memory_read` | 显式读取持久记忆（global 稳定偏好 / 本会话绑定课程的记忆 / control 开关）；禁用时如实报告并保留数据 |
| `professor_memory_update` | 修订守卫的持久记忆写入；全局偏好只接受 `explicit-stable` 证据（临时说法一律拒绝晋升）；课程指令/最近主题；`set_enabled` 开关（关闭时其它写入拒绝、数据保留） |
| `professor_paths` | 报告项目根、依赖工作区、根变量各自解析到什么与来源，以及本次调用允许读写的根 |
| `professor_diagnostics` | 统一健康端点：版本、项目根与 schema 健康、会话绑定、课程注册表、索引与分块健康、抽取能力矩阵、**LaTeX 与产物配置**、状态冲突、迁移状态、provider/watcher 健康，并**诚实列出尚未实现的能力** |
| `professor_workspace_discover` | 只读发现学术文件夹；返回带指纹、课程候选和歧义的方案，不写配置 |
| `professor_workspace_confirm` | 用户确认后重验方案、保存课程配置并建立索引/抽取；部分失败保留配置并报告重试 |
| `professor_workspace_rebuild` | 显式重建派生索引和抽取，不删除记忆、配置、笔记或原材料 |

项目根解析规则：**`DSH_PROFESSOR_PROJECT` 环境变量 → 当前对话工作区（该目录下必须有 `.professor/`）→ 明确报错**。解析结果带回 `bound` 与 `reason`：目录存在但没有 `.professor/` 时 `bound: false`，这是**通用学术模式**而不是故障——课程相关工具一律以 `PROFESSOR_PROJECT_MISSING` 拒绝，绝不把当前目录当作课程根，也不会因此新建 `.professor/`。没有跨会话回退，不会退回服务进程的启动目录，无会话上下文时直接失败而不是猜。

### 2.3 六个技能（provider 名 `professor-bundled`）

技能随包放在 `skills/<技能名>/`，由 `index.js` 经 `ctx.skills.registerProvider()` 在预设内注册。

| 技能 | 用途 |
|---|---|
| `professor-course-management` | 课程身份/路径/注册表/生命周期/状态文件初始化与 INDEX 同步（不教学、不写笔记） |
| `professor-study` | 教学：PPT / PROBLEM / CODING-TUTOR / READING / TRANSLATE、恢复顺序、提示梯度、证据门槛的状态更新 |
| `professor-notes` | 笔记：格式门、输出位置、绝不静默覆盖、溯源分离、深挖标记 |
| `professor-review` | 考试复习：优先级图、小块引导循环、练习题标注、独立产物 |
| `professor-research` | 联网检索触发条件与证据协议 |
| `professor-latex` | LaTeX：复制模板、生成契约、静态审查、编译门、诚实结论行 |

技能正文**不把遗留路径当作必需操作**。`${PERSONAL_AGENT_ROOT}` 只剩一处，位于 `professor-course-management` 的 **Optional（可选）** 章节，用于显式导入旧 Personal-Agent 注册表，且必须经 `professor_course_manage` 执行；其余五个技能里没有任何必需占位符。课程身份与路径一律来自 `.professor/project.yaml`（经 `professor_paths` / `professor_course_list` 核对），学习状态固定在 `.professor/state/courses/<course_id>/`。

provider 仍会把技能里的占位符替换成真实路径（未解析的保持占位符，绝不猜），优先级：环境变量 → `PATHS.md` → 内建默认。但**通用学术会话不依赖任何占位符解析结果**：解析不出来也照常工作。这条规则由 `test/portable-skills.test.mjs`（对交付文案做文本审计）与 `tools/verify-skill-sync.mjs`（portability 规则）共同守着。

### 2.4 文本抽取：后端、坐标与边界

`professor_extract` 的生产路径已经接线：它不是「接缝完整但没插上」，而是**通过 Harness 的 shell 接缝真的执行后端**。三类后端，一律**先观测再声明**——没有任何能力是从文件名或版本号推断出来的。

| 家族 | 后端（按优先级） | 坐标 | 依赖 |
|---|---|---|---|
| PDF → 文本 | ① 打包/工作区 Python 的 **PyMuPDF**（`fitz`）；② **Ghostscript `-sDEVICE=txtwrite -dTextFormat=1`**；③ 该 build 只回纯文本时的降级读法 | ①② 逐页一基 `page`；③ 有文本、无页码 | ② 需要 `gs`；① 需要 `fitz` |
| DOCX / PPTX / XLSX | 打包 Python：`python-docx` / `python-pptx` / `openpyxl`（**逐格式独立判定**） | PPTX 逐张一基 `slide`；DOCX / XLSX 无（结构读 XML，不渲染） | 三者互不牵连 |
| 文本 / 代码 / CSV / JSON … | 无（`ctx.fs` 直读） | 无 | 无 |

- **怎么进预设**：**不新增任何预设行**。runner 复用已有的 `ctx.shell` 接缝（LaTeX 编译门早就在用同一接缝），解释器按 `DSH_PRIMARY_RUNTIME` → `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` → `<resourcesPath>/runtime/primary-runtime` → `PATH` 依次发现。运行时插件**不**挂进预设，所以模型拿不到任何通用抽取工具——工具面仍然只有那 22 个 `professor_*`。
- **坐标系**：`page` / `slide` 是一基正整数。跨页分块写 `page_range: [a, b]`，跨张写 `slide_range`；若起始行落在已知页内、结束行落在已知页之外，标注 `coordinate_ambiguous: true` **而不是**替它挑一个页码；后端没报告页码时字段**整体缺席**，绝不合成。
- **输出上限**：单次抽取文本上限 4 MiB；PDF 最多 2000 页；XLSX 默认最多 24 张表 / 2000 行 / 64 列 / 20000 个单元格。触顶时**显式回报** `truncated[]` 并进入工具结果的 `warnings`，不静默截断。
- **超时**：探测 20 s、PDF 60 s、Office 60 s。超时记为 `failed` 并写明「timed out after Nms」，**不**当成空文档；取消（signal）同样记为 `failed`。
- **失败词汇**（互斥，且绝不把失败说成成功）：`unsupported`＝未观测到后端 / 加密或受保护 / 无文本层且需要 OCR；`failed`＝超时 / 取消 / 解析失败 / 捕获溢出；`extracted`＝真的抽到文本。加密容器先查 OLE/CFB 头；输出被捕获上限截断时**拒绝解析半截 JSON**——宁可失败，也不产出不可信的半份结果。
- **抽取 ≠ 视觉校验**：这里只读文本层，**不渲染**任何页面。因此 `capabilities.pdf.visual` 恒为 `false`、`extraction.visualInspection` 恒以 `not performed` 开头，`pdf.inspected` 也绝不会被自动置真。
- **OCR 分两条路径，别互相顶替**：**索引抽取路径不接 OCR**——`professor_extract` 对扫描件与纯图片按 `unsupported` 报告并点名 OCR，`capabilities.pdf.ocr` 描述的就是这条路径，恒为 `false`。**读取路径实现了 OCR**——`professor_material_read` 的 `enhance` 动作调用随包的 `src/extract/scripts/enhance_pdf.py`（sha256 锁定的 OCR 模型、进程内禁网、增强运行时按哈希锁定的 workspace 规则制备），因此「读材料时识别扫描页」是已实现能力，而「建索引时把扫描件抽成文本」仍然不是。
- **绝不修改源文件**：后端一律只读打开（Ghostscript 加 `-dSAFER`，Office 库用显式只读参数）；读路径在任何进程启动**之前**过调用方读策略，含 `..` 的拼写或读根之外的路径直接拒绝，且不会启动进程。
- **怎么诊断后端不可用**：`professor_diagnostics` 的 `extraction.capabilities` 给出 `pdf{text, backend, pageCoordinates, visual, ocr, reason?}`、`office{docx, pptx, xlsx, backend, slideCoordinates, reason?}` 和 `probe{attempted, at, reason, python, ghostscript}`；`python` / `ghostscript` 各自带 `available`、实测路径与版本，被淘汰的候选逐条带 `reason`（例如「this build has no txtwrite device」）。要指定解释器或 Ghostscript，用 `DSH_PROFESSOR_PYTHON` / `DSH_PROFESSOR_GS`。

### 2.5 项目布局

```
<会话工作区>/.professor/
├── project.yaml          # 权威：schema_version + 项目 + 课程 + 输出/检索/笔记配置
├── indexes/
│   ├── files.json        # 派生：确定性文件索引
│   └── chunks/           # 派生：分块存储
├── state/
│   ├── sessions/<session_id>.json   # 会话—课程绑定（含追加式切换历史）
│   └── <course_id>/{PROGRESS,KNOWLEDGE,MISTAKES,INDEX}.md
├── migrations/           # 迁移计划与追加式日志
├── notes/ reviews/       # 产物（也可指向配置的输出根）
└── cache/
```

`project.yaml` 的配置项：`outputs.notes_root` / `outputs.reviews_root`、`notes.default_format`（`markdown` / `latex` / `ask`）、`notes.overwrite_policy`（`never` / `versioned` / `allow`）、`notes.latex_template`、`retrieval.max_sources` / `max_chunks`。

课程可通过 `courses[].outputs` 和 `courses[].notes` 保存独立的输出目录和模板。保存的格式偏好不是本次生成授权：本次没有明确选择格式时，工具必须返回询问，不写文件。导入保留完整的 `registry_fields`，不自动迁移旧 Knowledge 学习状态。

- **schema 版本安全**：`schema_version: 1`；遇到更新的版本**一律拒绝读写**（`PROFESSOR_PROJECT_UNSUPPORTED`），绝不覆盖。
- **受控 YAML 子集**：插件无外部依赖，因此 `project.yaml` 用子集解析（嵌套映射/序列/标量/引号/注释 + JSON）。锚点、标签、流式集合、块标量、多文档一律**报错而不是猜**（`PROFESSOR_YAML_SUBSET`）。
- **课程身份**：`course_id` 由课程代码派生（kebab-case）；同一代码不同学期各自注册。`course_id`/`course_code` 不可被 update 改写（否则会孤立已有状态）。
- **解析规则**：只按匹配数量判断——多门课匹配就必须询问，绝不替用户选。
- **上游导入**：解析的是**真实漂移**的 Markdown（标题 + 代码块），容忍缺失学期、枚举外取值、散文式 LaTeX 字段、`N/A`；无法映射的字段原样回报，源注册表**零改动**。

### 2.6 工具 schema 的宿主契约：为什么是可空字段用 `oneOf` 而不是 `type: [...]`

Harness 在 `ctx.tools.register()` **注册之前**就用它自己的校验器（`@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema`）校验每个工具的输出 schema，而它只接受一个刻意收窄的 JSON Schema 子集：

- 单一 `type` 字符串（`object` / `array` / `string` / `number` / `integer` / `boolean` / `null`）；
- 或 **exact-one `oneOf`**（至少两个分支，且 `oneOf` 旁边不允许出现 `properties`/`required`/`items`/`enum`/`const` 这类约束兄弟节点，只有注解可以）；
- 其它都是拒绝，**不是降级**——尤其是 `type: ['string','null']` 这种 type 数组，会直接报 `… .type must be a single type string (type arrays are not supported)` 并让整个预设加载失败；子集里也**没有** `nullable` 关键字。

因此「这个字段可能是字符串、也可能是 `null`」统一写成 `oneOfTypes('string', 'null')`（定义在 `src/tools/support.js`），展开即 `{ oneOf: [{type:'string'},{type:'null'}] }`。分支之间**互斥**，所以宿主的 exact-one 语义与原来的联合类型完全等价：合法的类型被接受，其它类型仍然被拒绝（不是把校验放宽成「随便什么都可以」）。

这条约束不是理论：`docs/AUDIT.md` §7.4 第 10 条记录了它当时如何让预设装不上。回归由 `npm run verify:host` 守着——它导入实装的校验器，断言旧的 type 数组写法**被拒绝**、当前全部 22 个工具的 schema **被接受**、并且全部经真实 `ToolRuntime.register()` 注册成功。

`tool-todo` 同理：`@deepseek-ai/dsh-tool-todo` 的 `Config` 要求 `allowParallelInProgress: boolean`，所以预设里那一行必须带 `config: { allowParallelInProgress: false }`；Professor 一次只推进一个教学步骤，因此取 `false`。

### 2.7 两种模式与 Professor 自有存储（Phase 1）

同一套规则在两种模式下运行，不是两种人格：

- **课程模式**：工作区里有 `.professor/` → 一个课程助教。课程身份/路径/配置的唯一权威是 `.professor/project.yaml`，学习状态在 `.professor/state/courses/<course_id>/`，索引在 `.professor/indexes/`。
- **通用模式**：工作区里没有 `.professor/`（`professor_paths` 报 `projectBound: false`）→ 一个通用学术助手。照常讲解概念、讨论计划，但**不**创建课程目录、**不**猜课程或学习状态。

通用模式需要的「应用状态」由插件自己拥有，走宿主的 storage domain：

| 项 | 值 |
|---|---|
| 域 | `professor_app`，`version: 1`，一张 `app` 表 |
| 归属标记 | 首次打开写入一条 `bootstrap` 记录（`owner: dsh-professor-spike`、`schema: professor.app/1`、`domain_version`、`plugin_version`、`created_at`）；已存在就**不重写** |
| 落盘位置 | **宿主决定**：默认 `<DSH_HOME>/storages/professor_app.json`（即 `~/.dsh/storages/professor_app.json`） |
| 绝不落在 | 插件包内、任何学术文件夹内 |
| 打开时机 | **惰性**——`apply` 从不打开；有工具需要时才开，失败只记录状态不抛错 |

证据：`tools/verify-app-storage.mjs`（源码层面，已并入 `npm run verify:harness`）与 `npm run verify:packaged`（**打包产物**层面，含关闭后由新进程恢复）。五条经真实宿主验证的契约：

1. **`valueSchema` 是必需的，不是可选的**。宿主在加载时对每条已存记录调用 `valueSchema.parse(raw)`；不声明 schema 的表能开、能写，但**一旦落过盘就再也打不开**（报 `invalid-record`）。插件因此自带一个零依赖校验器，只实现宿主实际调用的 `parse()`，不引入 schema 依赖。
2. **校验必须无损，否则必须拒绝**。宿主写路径**不做任何校验**，所以坏值会原样落盘、直到下一次打开才爆出来。`validateRecord()` 遍历整张可达图，拒绝任何不能经 `JSON.stringify` → `JSON.parse` 无损往返的值（`NaN`/`±Infinity`/`-0`、`undefined`/BigInt/函数/symbol、`Date`/`Map`/`Set`/RegExp/类型化数组/类实例、稀疏数组、symbol 键、非枚举属性、访问器、循环引用），并点名 JSON 路径。**绝不静默丢弃或强转。** 所有写入走 `writeRecord()`（先校验再落盘）；`table()` 只留给探针代码。
   - **数组的"成员"只认真正的索引**：规范索引且不超过 `2 ** 32 - 2`。`"4294967295"`（`2 ** 32 - 1`）、`"1e2"`、`"01"` 这类只是**看起来像**数字的字符串属性——它们不计入 `length`，`JSON.stringify` 会**默默丢掉**，所以一律拒绝（`value["4294967295"]="lost"` 序列化后是 `[]`）。稀疏数组（洞会变成 `null`）同样拒绝。
   - **访问器是看描述符拒绝的，不会去调用 getter**：校验期运行被测代码、再信任一个后续读取未必复现的值，不叫校验。对象属性和数组元素都适用。
3. **记录形状与 null 策略**：记录本身必须是普通 JSON 对象或数组（`Object.create(null)` 也算）；`null` 在记录**内部**任意位置合法，但**不能**作为记录本身——`null` 是介质的「从未写入」哨兵。嵌套深度上限 `APP_VALUE_MAX_DEPTH = 32`，按**容器**计数（记录本身为 1，其成员为 2）。
4. **同一个域不允许并发打开**（`already-open`）。一个实例一个进程只拥有一个域；`close()` 之后重开会读到既有 `bootstrap` 标记且不重写。
   - **生命周期归属**：`close()` 在**同步段**就认领状态（`status = 'closed'`），之后 `await` 释放句柄期间**不再写任何状态**；打开尝试的每一次 `await` 之后也都先核对 epoch。原因很实在——释放是一次宿主往返，调用方正当地可能在它完成前重开，而一次**被顶替的**完成不得覆盖**更新**那次生命周期的状态、原因或 bootstrap 信息。谁清空 `domain` 谁负责释放，所以句柄恰好释放一次。

5. **`invalidRecords: 'backup-and-skip'` 在默认 `single` 布局下不可用**——后端只在 `per-record` 布局实现 `backupRecord`，所以插件**不声明**这条策略，而不是声明一个空操作充当安全网。

宿主没有 `ctx.storageDomain` 时，应用存储报 `unavailable` 并给出原因，**通用 Professor 会话照样能开始**（`professor_diagnostics.appStorage` 会如实回报）。

---

## 3. 安全边界

- **所有写入走 `ctx.fs`**，逐调用盖章 `ctx.sandboxPolicy.resolve({ session })`。插件不直接持有 `node:fs` 写通道。
- 写前经**插件自己的写白名单**：`<projectRoot>/.professor/` 以及 `project.yaml` 中显式配置的输出根。**课程原始材料永远不可写**。
- 产物输出根额外校验（`src/artifacts/paths.js`）：拒绝 `..` 拼写、拒绝指进 `.professor/state`、拒绝与任何已注册源根相同或包含、拒绝落在源根内部（除非路径里含安全产物段，如 `notes`/`reviews`）、拒绝符号链接逃逸；**绝不回退到进程工作目录**。
- 拒绝 `..`；符号链接经 `ctx.fs.resolve` 真实路径规范化与逐条 `lstat` 判定，链接不得越出读/写边界。
- 原子性与并发：父目录由 fs 服务自动创建，发布原子；`createIfAbsent` 用 no-replace 原语（并发创建者不会互相覆盖），`replaceIfVersion` 用 fs 版本令牌检测并发更新并拒绝静默覆盖。产物写入同理由 `expectedVersion` 守护（`PROFESSOR_ARTIFACT_STALE`）。
- **不静默覆盖**：笔记/复习默认 `overwrite_policy: never`，已存在文件会被拒绝并建议 `versioned`（写出 `-vN` 新版本）。
- LaTeX 模板**只读**：复制到产物目录再改写，共享模板永不修改；`latexmkrc`/`.latexmkrc` 被跳过；编译命令显式给 `-interaction=nonstopmode -halt-on-error`，驱动按文档分类选择（**生成的默认文档 → `latexmk -xelatex`；用户模板 → `latexmk -pdf`，与改动前一致**），**不加** `-shell-escape`（除非调用方显式选择）。
- 迁移**只读**源树：不读取为写、不改写 Personal-Agent 状态；支持 dry-run、稳定映射 + 未映射回报、幂等重跑、`.professor/migrations/` 追加式日志。
- 诊断只输出可观测事实，**不含**环境变量转储、密钥、文件内容、提示词或完整状态；测试双向断言这一点。
- **抽取不扩大工具面**：PDF/Office 抽取复用已有的 `ctx.shell` 接缝，**没有**新增预设行，也**没有**把运行时插件挂进预设——模型侧拿不到任何通用抽取-执行工具，只有那 22 个 `professor_*`。
- **抽取的 argv 不做字符串插值**：每个参数先单引号引用再拼成命令行（Harness 的命令接缝只接受字符串），含 NUL 的参数直接拒绝；源路径在**任何进程启动之前**过读策略，`..` 或读根之外直接失败且不启动进程。
- **抽取只读、绝不执行文档内容**：Ghostscript 带 `-dSAFER`；Office 库用 `read_only=True`、`keep_links=False`（不跟随外部链接）、`data_only=False`（公式照抄不重算）；不跑宏、不隐式 OCR、不写回源文件。源文件字节哈希前后比对有断言。
- **抽取有界**：超时 20s/60s/60s、捕获上限 4 MiB + 512 KiB（触顶即拒绝解析而非接受半截结果）、页码上限 2000、XLSX 默认 24 表 / 2000 行 / 64 列 / 20000 单元格，触顶**显式回报**而不是静默截断。

---

## 4. 复核（全部须退出码 0）

```bash
npm test                         # 744 项（744 过 / 0 失败 / 0 跳过；已配置增强运行时）：单元 / 集成 / 安全 / 端到端 / 激活超时诊断 / 无课程引导 / 应用存储生命周期与记录校验 / 持久记忆（M2）
npm run verify:syntax            # 177 个 JS 文件逐个 node --check（语法门，M0）
node verify-plugin-skills.mjs    # 39 项：技能 provider 契约、工具面、诊断诚实性、无秘密输出
node tools/verify-skill-sync.mjs # 89 项：技能与上游的双侧锚点同步 + 可移植性规则（遗留路径只许出现在 Optional 章节）
node tools/verify-distribution.mjs  # 70 项：打包白名单、无秘密/个人路径、离线安装 + 装后自测 + npm cache 隔离自检（断言 22 工具 / 6 技能 / 5 预设）
node tools/verify-e2e.mjs        # 28 个端到端场景，按会话顺序驱动真实 fixture（断言 22 工具）
node tools/rebuild-teaching-aggregate.mjs # 离线重建教学验收聚合（0 模型调用；`--gate` 时未全过则 exit 1）
```

> **计数口径**：上表为 **2026-10-12 实跑**结果。本节后续表格里未在本轮重跑的验证器（`verify:harness` 各段、`verify:packaged`、`verify:native-session`、`verify:home` 等）保留其**上一次记录的计数并标注日期**，不冒充本轮新鲜结果。

```bash
# 以下需要 Harness 自带 Node（asar 感知）。8 段共 266 项检查（2026-10-12 实跑，0 FAIL），全部 ALL PASS（exit 0）
npm run verify:preset            # 32 项：预设结构、schema、子插件在实装中可解析、todo 配置、无机器路径
npm run verify:composition       # 12 项：用加载器自身的 applyEntryPatches 组合并断言隔离
npm run verify:boot              # 27 项：真实 dsh 启动器冷启动两次 —— **只证明组合**
npm run verify:host              # 65 项（2026-10-12 实跑 ALL PASS）：真实宿主校验器 + 真实 ToolRuntime 注册全部 22 个工具
npm run verify:activation        # 28 项（2026-10-12 实跑 ALL PASS）：真实加载器挂载整棵树；读真实预设注册表；**点数 22 个 `professor_*` 且断言可见集合恰好等于期望清单**；读**真实 skills 注册表**证明 6 个技能在预设作用域里可枚举
npm run verify:desktop           # 24 项（2026-10-12 实跑 ALL PASS）：把**桌面 profile 自己的** bundle 清单与 patch 层原样启动，再读注册表，断言 22 个 `professor_*`
npm run verify:api               # 29 项：17 个宿主服务 + 客户端清单 / 原生会话创建 / 预设解析 / 存储域往返
npm run verify:app-storage       # 44 项：插件自带的 professor_app spec × 真实 ctx.storageDomain（含**关闭后重开**与并发拒绝）

# 打包安装验收：94 项（2026-10-12 重跑 ALL PASS）。以上都从**源码目录**用 link: 挂载；这一条装的是**打包产物**
npm run verify:packaged          # npm pack → 把那个 tarball 装进一次性 profile → 真实宿主 → 资源从安装副本解析 → 无课程行为 → 关闭后由**新进程**恢复记录

# Phase 1 验收的第一从句：**已安装包能否开启一个通用 Professor 原生会话**。47 项（2026-10-12 重跑 ALL PASS）
npm run verify:native-session    # 用宿主自己的 ctx.agents.create() 造会话 → ctx.agentPresets.select() 绑定 → 读**该会话自己**的人格/工具/技能；外加一个不选 preset 的对照会话
```

`npm run verify:native-session` 存在的原因：Phase 1 的验收原句要求已安装包 *"starts a general
Professor native session"*，而早先几轮只证明了 preset 的**注册与激活**。它不用模型，也**不需要任何凭据**：
它证明的是"会话真的跑在预设之下，且这套运行时确实属于该会话"；模型自己的行为（真实 turn、模型选的工具）
需要凭据、网络与花费，脚本会打印 `UNVERIFIED`，那是 **Phase 7/8** 的要求，不是 Phase 1 的条款。

`npm run verify` 串起前六项（不需要 Harness 应用即可跑完，也**不需要任何额外环境变量**）；`npm run verify:harness` 串起中间八项；`npm run verify:packaged` 是**打包产物**层面的验收，单独运行（它会 `npm pack` 并做真实安装）；`npm run verify:native-session` 是**原生会话**层面的验收，同样单独运行，也不需要任何凭据。

**沙箱注意（重要）**：`npm test` 与 `npm run verify:dist` 的装后自测会让子进程在系统临时目录里 `mkdir` / `rename` fixture 目录。在受限沙箱里这些调用可能被 WorkBuddy 的 fs broker 以 `CODEBUDDY_BROKER_DENY` 拒绝，**失败项全部是同一个 code，没有任何断言失败**。*2026-10-06 二次与三次复查实测：*`npm test` **263/263**、`npm run verify:dist` **62/62（exit 0）**，该拒绝**完全未复现**——所以它是环境性的，不是本包的性质。*历史（2026-10-05）：*并发高负载时 235 项里 21 项被拒；不并发时 234/235 通过且唯一失败仍是同一条；单独跑这些文件全绿。因为它是环境性的，发布门（Phase 7）仍应在**无沙箱 shell** 里复核，而不能假设它已消失。

**给长跑命令留足时间（本环境实测）**：`npm run verify:dist`、`npm run verify:packaged`、`npm run verify:harness` 单次耗时都超过默认命令超时（实测约 1–3 分钟）。超时被外层杀掉时会表现为**退出码 137 / SIGTERM 且完全没有输出**，很容易被误读成产品失败。请放宽超时重跑，或分别单独运行。

**机器过载时会以"fixture 超时"的形式假性失败（2026-10-06 实测）**：在 **12 核但 load average 11** 的机器上，一次平时约 6 分钟的全量跑用了 **1 小时 45 分**，并且有两项失败在 **fixture 而不是断言**上——`test/extract-production.test.mjs` 里 `spawnSync …/python3 ETIMEDOUT`（**917 秒**后超时），以及同因导致的 `verify:e2e` 场景 22 报 `no Office extractor for pptx … (the Python backend needs python-pptx)`（因为 PPTX fixture 没造出来，于是"看起来"没有后端）。**两者单独重跑都通过**（`extract-production` 19/19、`verify:e2e` 28/28），机器较闲时 `npm test` 263/263。判据是**失败形状**：断言失败才指向代码，`spawnSync … ETIMEDOUT` 指向环境。这些验证器请在空闲机器上逐个运行。


### 证据层次分清楚

`--dump-config` **不是**「完整启动」的证明。Harness 的 `--dump-config` 只打印组合后的树就退出，从不实例化任何插件——所以它看不见被宿主拒绝的 schema、被宿主配置 schema 拒绝的子行，以及其他任何激活期失败。这一点是有代价的：预设曾经在本仓所有 dump 类检查全绿的情况下，在桌面 UI 里显示 「Failed to load」。

| 层次 | 命令 | 证明什么 | 不证明什么 |
|---|---|---|---|
| 源码 / 语法 | `verify:syntax`、`npm test` | 能解析、单元与集成行为正确 | 宿主接不接受 |
| 假宿主 | 大部分 `npm test` 用例 | 插件自身契约 | 真实 schema / 真实注册 |
| **真实 schema 与注册** | `npm run verify:host` | 实装 `assertSupportedJsonSchema` 接受全部 22 个工具的输入/输出 schema；全部经**真实 `ToolRuntime.register()`** 注册并可枚举；旧的 type-array 写法被同一个校验器拒绝 | 预设会不会挂载 |
| 配置组合 | `npm run verify:composition`、`npm run verify:boot` | 加载器如何组合 patch 层、重启是否逐字节一致 | 任何插件是否真的启动 |
| **真实运行时激活** | `npm run verify:activation` | 真实 Cordis 加载器在可丢弃 home 里挂载**真实组合树**，真实预设注册表报告 `professor` 存在、`broken === undefined`、13 个子行全部 `active`，且预设作用域里 35 个工具（含 **22** 个 `professor_*`）已注册，**可见的 `professor_*` 集合恰好等于期望清单**（缺一个、多一个都失败）；读**真实 skills 注册表**证明 6 个技能在预设作用域里可枚举 | 桌面 profile 独有的 bundle 组合 |
| **桌面 profile 端到端** | `npm run verify:desktop` | 把 `~/.dsh/profiles/desktop` 的 **bundle 清单、顺序与 patch 层原样复制**到可丢弃 home 并启动：5 个 bundle 逐一成为真实 layer，`professor` 存在、`broken === undefined`、13/13 子行 active、工具面 35 个（含 22 个 `professor_*`）齐备 | 桌面 UI 观感 |
| 桌面 UI 冒烟 | 人工 | 设置 → Agent Presets 里可见、无 Failed to load、新会话模式选择器可选 | — |
| **打包产物端到端** | `npm run verify:packaged` | `npm pack` 出的**那个 tarball** 装进一次性 profile 后：207 个打包文件逐字节一致、运行时从**安装副本**解析资源（不是源码目录）、预设/人格（读宿主自己的 `ctx.systemPrompt.assemble()`）/6 技能/22 个 `professor_*` 工具齐备、无课程行为与拒绝、应用存储关闭后由**新进程**逐字节恢复 | 原生模型轮次（未配置 provider，脚本会打印 `UNVERIFIED`） |
| **原生会话集成** | `npm run verify:native-session` | 宿主**自己的工厂**（`ctx.agents.create()`）开出会话、宿主**自己的** `ctx.agentPresets.select()` 把它绑到 `professor`，然后读**该会话自己**解析出的表面：2629 字符 Professor 人格（`deployment:persona-prefix`，17 个 section）、22 个 `professor_*` 工具（预设作用域共 35 个）、6 个技能、无课程拒绝、会话可持久化；并有一个**不选 preset 的对照会话**证明这是按 scope 限定的（对照只拿到 54 字符编码人格 / 0 工具 / 0 技能） | 模型自己的行为：真实 turn 与模型选择的工具（`UNVERIFIED`，属 Phase 7/8） |

**写"原生会话"类检查时，两个坑都是静默的**（都已实测，写在这里以免重踩）：

1. **权威的 scope token 就是 agent 对象本身。** 要用宿主的 `assembleContextFor(agent)`（返回 `{ agent, scope: agent }`）。
   用 `agent.ctx`、`agent.scope` 或 preset mount 的 key 去读同一个 assembly，会拿到**默认部署人格**而不是预设的，而且**不报错**——
   实测差 2629 字符 Professor 人格 / 35 工具 / 6 技能 **对比** 54 字符编码人格 / 0 工具 / 0 技能。
   `dsh-system-prompt` 的 `renderContextSections()` 也是错的读取器（只有 render-hook 的 2 个 section，而 assembly 有 16 个）。
2. **`pathToFileURL(import.meta.url)` 会把已经是 URL 的值再编码一次**（`…/repo/file:/…/repo`），
   由此得到的 `cwd` 不存在，子进程会报 `spawnSync npm ENOENT`——把路径错误说成"没装 npm"。
   本仓一律用 `new URL(import.meta.url).pathname`；`verify-native-session.mjs` 还会**先**断言仓库根存在再跑子进程。

`npm run verify:boot` 在可丢弃的 `$DSH_HOME` 里用真实 `dsh` 初始化一个 profile、声明本 bundle、让**真实加载器**完成解析 → 兼容性评估 → patch 加载 → 组合，断言预设挂着本插件而**部署级没有**，并**再冷启动一次**断言组合逐字节一致；跑完删除可丢弃 home，并前后比对真实 profile 的 `package.json`/`cordis.patch.yml` 证明它没被写过。

`npm run verify:activation` 走得更远：它用 `@deepseek-ai/dsh-app-boot#boot`（`dsh <profile>` 的同一个入口）在可丢弃 home 里挂载整棵树，然后像设置页一样读真实预设注册表（`list()` / `resolve()` / `compositionInventory()`）与预设作用域的工具面。它不调用模型、不打开浏览器（`--no-open --port 0`）、不动真实 profile。真实网页宿主需要监听临时本机端口；在禁止本机监听的沙箱中，请为验证命令申请执行权限，而不是关闭产品的安全设置。两个激活校验器都有 20 秒启动期限：监听被拒绝时明确报告 `listen EPERM` 并清理临时 home，不再以含糊的未完成顶层 await 退出。

`npm run verify:desktop` 补上两者之间最后一格：`verify:activation` 挂载的仍是**合成** profile（`web` 模板 + 本插件），而桌面应用跑的是 base + web-app + `dsh-experimental-agent-team-profile` + `dsh-permission-rules` + 本插件，再叠该 profile 自己的 `cordis.patch.yml`。后者多出来的 bundle 独自绿并不等于合到一起仍绿，所以这一项直接从 `~/.dsh/profiles/desktop` 读 bundle 清单与 patch 层原样复现，只读不写（跑完比对真实 profile 的 `package.json`/`cordis.patch.yml`/`cordis.yml`/`pnpm-lock.yaml` 摘要证明没被改动）。

`DSH_HARNESS_BIN` 可覆盖 Harness 可执行文件路径；`DSH_BIN` 可覆盖 `dsh` 启动器路径；`DSH_HARNESS` 可覆盖 asar 根路径（后两项检查用）。

---

## 5. 已知限制

按「只是诚实声明」和「真的少了一块」分开列：

**设计选择（不是缺陷）**

- **生成的默认 LaTeX 文档要求 XeLaTeX + TeX 发行版自带的 Fandol 字体**。插件生成的 `main.tex` 带 `dsh-professor-requirement: unicode-cjk`，因为 `renderContentTex` 会给任何填了这些字段的笔记生成中文章节名（`概述`/`材料范围`/`重要术语`…），**连英文内容也一样**；pdfTeX + `inputenc` 排不了它们。这是刻意的整体方案：**只换 XeLaTeX 不给字体不成立**，**加了 CJK 导言仍用 `latexmk -pdf` 也不成立**，把字体名写死成 macOS 字体又不可移植——所以字体取自 TeX 发行版（Fandol），引擎与驱动一起选。缺 XeLaTeX 或缺该字体时返回 `compiler_unavailable` 并点名原因，不伪装成编译失败、不静默退回 pdfTeX。**用户自己的 `main.tex` 不声明该要求**，其编译行为与改动前完全一致；该文件生成后不再被覆盖，所以改动前生成的旧产物仍按旧行为编译（重跑不会自动翻新）。
- **OCR 分两条路径，别互相顶替**。**索引抽取路径不接 OCR**
——`professor_extract` 对扫描件与无文本层 PDF 一律 `unsupported` 并附原因，绝不猜（`capabilities.pdf.ocr` 恒为 `false`，描述的就是这条路径）。**读取路径已实现本地 OCR**——`professor_material_read` 的 `enhance` 动作经随包 `enhance_pdf.py` 做 OCR/结构抽取（sha256 锁定模型、进程内禁网、增强运行时按哈希锁定规则制备）。**未完成**的是独立图片 OCR 与 Windows/Linux 宿主的增强验收（见 `professor_diagnostics.notImplemented`）。
- **不声称未观测到的能力**。诊断里 `ocr: false`、未观测到的后端进 `unobserved[]` 并给原因；每个声明都描述了**插件自己的边界**，而不是断言宿主环境。后端可用性来自**真实执行**：`python3 probe_python.py` 与 `gs --version` 各跑一次，还额外用一段自带 PostScript 自测 Ghostscript 是否真的输出结构化标记。
- **PDF 视觉校验需调用方声明**。编译出 PDF 不等于「排版正确」；`pdf.produced` 来自真实 `stat`，`pdf.inspected` 只有在调用方显式声明时才为真。文本抽取同理：读到文本层**不等于**看过这一页长什么样。
- **DOCX 与 XLSX 不报页码**。结构性读 OOXML 不渲染版面，所以没有页码可言；与其按行数猜，不如让坐标缺席（PPTX 有真实的 `slide`，因为张号是结构里的事实）。
- **会话绑定落在项目侧**（偏离 v3 §4.6）：Harness 的会话事件类型是闭集，追加自定义事件会让日志在重启后无法解析（证据链见 `docs/AUDIT.md` §3）。代价：项目目录搬移后需按课程代码重新解析。
- **读路径未围栏**：Harness 的读原语本身不围栏，插件只对**写**强制白名单；读边界依赖会话工作区与显式允许根。
- **工具失败不带机器可读错误码**：真实管线的物化结果是 `{ content, isError: true, error: { message } }`，**没有 `code`**。因此 `PROFESSOR_PROJECT_MISSING` 这类域错误码无法从工具返回值观测，调用方只能按消息文本判断；需要机器可读码的后续阶段不能假设它能穿过工具边界（`npm run verify:packaged` 会把这一点显式记进报告）。

**未闭合的差距**

1. **自动视觉解读仍然没有**。`professor_material_read` 能按需光栅化有界页（`pages` 动作）并记录哪些页真的送到了调用方，但插件**不跑任何视觉模型，从不自行声称「这一页看懂了」**；`professor_extract` 侧的 `capabilities.pdf.visual` 与 `extraction.visualInspection` 也仍是 `false` / `not performed`。「这一页排版对不对」「图里画了什么」由调用方回答。
2. **OCR 只覆盖 PDF 读取路径**。扫描件在**索引抽取**里永远 `unsupported`；`professor_material_read` 的 `enhance` 可对最多 6 页 PDF 做本地 OCR，但**独立图片 OCR** 与 **Windows/Linux 宿主的增强验收**尚未完成。
3. **Office 文档的版面信息**。表格按「行 × 列」还原为文本，但列宽、合并单元格的视觉跨度、批注、修订痕迹都不在输出里。
4. **Packaging 之外的坐标系**。只有 PDF 的页与 PPTX 的张有坐标；DOCX 的「节」、XLSX 的「命名区域」都还没有独立坐标。
5. **学习状态与课程材料不在插件目录里**：课程状态固定在**已连接学术文件夹**的 `.professor/state/courses/<course_id>/`，课程产出写入 `project.yaml` 声明的输出目录，两者都不在只读的插件包内。没有连接课程时，通用会话需要保存的只有 **Professor 自有应用状态**（见 §2.7），它由宿主的 storage domain 托管。`PERSONAL_AGENT_ROOT` 只对**可选**的遗留导入有意义，不再是任何必需操作的前提。
6. **与默认技能根的相对优先级**：`BUNDLED_SKILL_RANK = 600` 高于用户根（400），同名技能以本插件为准；本机若另装了同名技能，生效的是本插件这份。
7. **模型观测行为尚未验证**：Phase 1 的验收要求"已安装包开启一个通用 Professor 原生会话"，这一点已由 `npm run verify:native-session` 证明；但**模型自己做了什么**——真实 turn、由模型选择的工具——没有证据，因为一次性 profile 里没有配置任何模型供应商（`defaultModel` 为 ABSENT），而跑一个 turn 需要凭据、网络与花费。按规划这属于 **Phase 4 / Phase 7** 的要求（Phase 7 原文：*"Where a model turn is required, obtain the normal model/network authorization and record actual observed behavior."*），不是 Phase 1 的条款，也**没有**被悄悄挪到后面充数。两个验证器每次运行都会把这几行 `UNVERIFIED` 打进自己的输出。

`professor_diagnostics` 的 `notImplemented` 字段就是上表的机器可读版本，当前三条：`standalone image OCR and real Windows/Linux host enhancement acceptance`、`automated visual interpretation … this plugin runs no vision model and never claims a page was understood on its own`、`DOCX page numbers`（后者是上面第 4 条在工具层的说法）。README 与它保持一致。

完整的三列对照（Hermes Professor 实际行为 / v3 目标设计 / 本实现）与逐条差距的闭合路径在 **`docs/PARITY.md`**。

---

## 6. 版本与分发

- 版本 `0.12.0`。诊断报的版本在调用时从本包 `package.json` 读取，**不存在硬编码的版本字符串**，因此不会与包版本漂移（`test/indexer.test.mjs` 断言这一点）。
- `"private": true` + `"license": "UNLICENSED"`：这是**决策**，不是待办——本包按 bundle 形态分发（`link:` / tarball / git），不走 npm 公共注册表。
- 分发内容由 `files` 白名单决定：`index.js`、`src`、`skills`、`cordis.patch.yml`、`tools`、`test`、`verify-plugin-skills.mjs`。**`docs/` 不进分发**（设计记录属仓库），仓库根的 `*.bak-*` 备份也不进分发——两条都由 `tools/verify-distribution.mjs` 逐条断言，且它会在干净临时目录里离线安装 tarball 并跑一遍装后自测。
- **校验器自带 npm cache 隔离**。`tools/verify-distribution.mjs` 会跑 `npm pack` 与离线安装，而 `npm` 默认写**全局** `~/.npm`——在容器、CI 镜像或共享工作站上，那个目录可能含 root 所有、当前用户写不进去的文件，于是与包本身无关的 `EACCES` 会让校验失败。所以它**从不继承环境里的 cache**：每次运行都 `mkdtemp` 一个唯一 cache，通过 `npm_config_cache` 传给每个子进程，成功与失败路径都会删掉它；不写 `.npmrc`、不用 `sudo`、不动全局 cache 的所有权、也不会硬编码任何临时路径。这一点由脚本自己的回归自检证明：它先用一个**故意不可用**的 cache（父级是普通文件，`ENOTDIR` 连 root 也绕不过）跑一次 `npm pack` 断言其**必然失败**，再用隔离后的 cache 断言其**必然成功**——因此 `npm run verify` 在默认环境下直接可跑，不需要任何额外环境变量。
