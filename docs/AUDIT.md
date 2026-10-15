# 审计报告：把 Professor spike 插件做成交付级 DeepSeek Harness 实现

审计对象：本仓库（`dsh-professor-spike`）。审计基线为 `0.2.0`（§2/§4/§5 的缺陷定位与行号均针对那一版）；**当前版本 `0.12.0`，M0-M12 全部实施完毕**，各条处置在 §2/§5 就地表注，未闭合的差距汇总在文末 §7。
目标架构：`professor-harness-plugin-design-v3.md`（1879 行，仓库外）
运行时版本：**@deepseek-ai/dsh-desktop 0.2.0-rc.2**，全部 290 个 `@deepseek-ai/dsh-*` 包同为 `0.2.0-rc.2`；vendor：`cordis 4.0.4`、`cordis-plugin-loader 1.0.5`、`cordis-plugin-include 1.0.9`、`schemastery 3.18.4`、`libreoffice-kit 0.1.2`。

方法：4 路并行审计（v3 设计、Hermes 行为、DSH 实装 API、数据布局与现有代码）+ 对关键接缝的第一手复核（直接读 app.asar 与磁盘产物）。全程只读；未修改 `~/.hermes`、`~/Personal-Agent` 或任何课程材料。

---

## 1. 已确认的真实 API（逐条附证据）

| 接缝 | 证据 | 结论 |
|---|---|---|
| **预设声明** | `dsh-agent-preset/lib/index.js`：`static inject = ["agentPresets"]`，`static Config = z.object({id: string required, name, description, order: number, plugins: array required})`，`Service.init` → `ctx.agentPresets.register(this.config)` | bundle 可自带预设 |
| **预设是 bundle patch 的普通条目** | 官方随包文档 `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`：*"Agent presets are ordinary `@deepseek-ai/dsh-agent-preset` declarations carried by bundle patches… a preset is created or changed by installing a bundle whose patch declares or overrides it"*；先例 `dsh-web-app/presets/*.patch.yml` | 无需改别人的 profile |
| **预设默认与选择** | `dsh-agent-preset-registry`：`Config = {default: string required, selectedDefault: string volatile}`，`get defaultId() { return selectedDefault.get() ?? default }`；选择写 `agent-preset/selected` 事件；磁盘上体现为投影行 `agentPreset: "standard"` | 可设默认，也可仅提供可选 |
| **限制预设工具面** | `AgentPreset.Config` 无 `tools`/`allow`/`deny` 字段；工具面 = `plugins` 列表 + `disabled` 行 | 隔离靠组合，不靠白名单 |
| **patch 语义** | `applyEntryPatches`：`{insert:[…]}` 追加；非 insert 需 `id`，可选 `name` 必须匹配否则 warn+skip，其余键**整值替换**（非深合并） | 改 `default` 必须整份重写 config |
| **自定义会话事件** | `dsh-session`：`KNOWN_SESSION_EVENT_TYPES` **闭集 54 项**（无 `professor/*`、无通配）；`append(type,data,...opts)` 的封装只有 `{type,seq,time,data}` + `surfaceOp/sourceEventSeqs`，**无法写 `ignorable`**；`dsh-session-persistence` 的 `validateStoredEvents()` 对闭集外且未标 `ignorable` 的事件 `throw unsupported(...refusing to interpret the log…)` | ❌ **三方插件无法追加持久化自定义事件**（见 §3） |
| **投影注册（读取折叠状态）** | `dsh-sandbox-policy` 原文：`ctx.sessionProjections.register({key:"sandboxMode", stateVersion:1, stateSchema, init:()=>null, apply:(state,event)=> event.type==="sandbox/mode" ? event.data.mode : state})`；配套 `stateOf(session,key)`、`snapshot(session,keys)`、`onChanged`、`checkpoint/restore/hydrate` | 投影机制可用，但**只能折叠已知事件**，且没有 setter |
| **会话存储** | 权威日志：`~/.dsh/sessions/<编码cwd>/<session-id>/session.v4.jsonl.zstd` + `session.lock`；派生缓存：`~/.dsh/storages/session_projcache/sessions/*.json`（`rows{ver,seq,val}`） | 只读日志侧 API；**不得**再读 projcache 作为第二套绑定库 |
| **沙箱化文件写入** | `dsh-fs-local`：`writeText(target, content, expected, signal)`；`dsh-fs-sandbox`：`writeText(target, content, expected, signal, sandboxPolicy)` → `checkedTarget`；`dsh-sandbox-policy`：`resolve({session})` → `{mode, workspaceRoot: session.header.cwd, sessionId}`；`workspace-write` 要求包含于 `[workspaceRoot,/tmp,tmpdir()]`；拒绝 = `FS_SANDBOX_DENIED` | 盖章策略后**无需绕过沙箱** |
| **写入的原子性与并发** | `writeFileAtomic` 内部 `await mkdir(dirname, {recursive:true})`（自动建父目录），用 staging 目录 + no-replace 硬链接发布；`expected.kind ∈ {createIfAbsent, replaceIfVersion}`（分别 `FS_NOT_OBSERVED` / `FS_STALE_VERSION`） | 插件无需自造 temp+rename，也无需 mkdir |
| **fs 无 mtime** | `stat()` 返回 `{version, type, size}`；`version` 是不透明品牌值 | 变更检测用 `fs_version` + `content_hash`，`mtime` 记为 `null` |
| **符号链接与 `lstat`** | `listDir`/`probe` 用 `stat`（跟随链接），链接目录类型显示为 `directory`；`lstat(path, opts, signal)` 才返回 `type:"symlink"` | `follow_symlinks:false` 必须逐条 `lstat` 判定 |
| **fs 无 mkdir/delete/rename/copy** | `dsh-fs/README.md` 明列 | 删除/重命名不在插件能力内（设计也禁止） |
| **bundle 加载与失败半径** | bundle = 声明 `dsh.bundle.patch`（字符串或列表）的包；patch 层按 `dsh.profile.bundles` 顺序扁平化 + profile patch + overlays；只有 `agent-loop, webserver, modules, connection, headless-runner, acp, sdk-jsonrpc-server`（或 bootstrap include）失败会 `StartupError`，其余行失败仅 stderr 警告；预设挂载失败只在名单留 `broken` 诊断 | 安装风险低 |
| **预设子插件解析锚点** | `prepareProfileEntries(ctx, plugins, ctx.baseUrl)`，`baseUrl` 来自 registry（= profile 目录） | 插件包必须是 profile 依赖，裸名才解析得到 |

### 能力矩阵（宿主实测，非推断）

这张表是**宿主调查**：它记录这台机器上确实存在什么，以及插件是否真的接上了那条线。两列必须分开看——**宿主有**不等于**插件做了**，把这两件事混在一起的文档正是「声称了未观测到的能力」的来源。

| 能力 | 宿主实测 | 插件接线 | 说明 / 路径 |
|---|---|---|---|
| Markdown / 文本 / LaTeX / 代码 / CSV / JSON | ✅ | ✅ **已实现** | 无需外部进程，经 `ctx.fs` 读字节（`src/extract/extract.js` 的 `text` 分支） |
| **PDF 文本** | ✅ 双后端 | ✅ **已接线** | 宿主：① 打包 Python 有 `fitz`(PyMuPDF) 时走 `extract_pdf.py`（页码精确）；② `/usr/local/bin/gs` 10.07.0 走 `-sDEVICE=txtwrite -dTextFormat=1`（实测结构化标记可用，逐页 `<page>`）。插件：`src/extract/runner.js` 经 `ctx.shell` 真的执行后端，`pages[]` 逐页喂给分块器与溯源；后端缺席时仍如实报 `unsupported` |
| **PDF 幻灯片视觉检查** | ✅ | ❌ **不接线（设计）** | 宿主有 `gs -sDEVICE=png16m` 栅格化 + `read_image`。插件只读文本层，**从不渲染**，所以 `capabilities.pdf.visual` 恒 `false`、`extraction.visualInspection` 恒以 `not performed` 开头。文本抽取已接线**不等于**视觉校验已接线 |
| DOCX / PPTX / XLSX 文本 | ✅ | ✅ **已接线** | `extract_office.py` 经 `ctx.shell` 调用**打包 Python**（`docx` / `pptx` / `openpyxl` / `lxml` 随 `runtime.json` 声明）——系统 Python 3.14 没有这些包（实测均为 `no`），所以必须走打包 payload。**逐格式判定**：只有 `docx` 而没有 `pptx` 时，DOCX 仍可读、PPTX 报 `unsupported` 并点名缺哪个包。PPTX 带真实 `slide` 坐标；DOCX / XLSX 不报页码（结构读 XML 不渲染） |
| Office → PDF | ✅ 宿主服务 | ⚠️ **仅探测** | `ctx.officeToPdf`（`dsh-office-to-pdf` + `libreoffice-kit-darwin-arm64`，实测包内带 `bin/prebuilds/program/sources`）。插件用 `ctx.get('officeToPdf')` 探测并如实播报该标志，但没有任何抽取路径消费它 |
| 词法检索 | ✅ | ✅ **已实现** | 预设内挂 `dsh-tool-fs-search`（内置 ripgrep）；插件另有自己的预算受限分块检索 `professor_search` |
| 联网检索 | ✅ | ✅ **已实现** | 预设内挂 `dsh-tool-web` |
| LaTeX 编译 | ✅ 但须走 shell | ✅ **已实现（M11）** | DSH 无 TeX 封装；主机 TeX Live `/Library/TeX/texbin`（`xelatex/lualatex/pdflatex/latexmk` 实测齐全）+ `pandoc`、`gs`、`qpdf`。插件经 `ctx.shell`（`src/latex/runner.js`）编译，无编译器时如实报 `compiler_unavailable` |
| OCR | ❌ | ❌ **按设计关闭** | 宿主无 tesseract（实测 `command -v tesseract` 为空）。插件侧**不依赖**这个宿主事实：它声明的是自己的边界——本插件不接任何 OCR 引擎，所以扫描件与无文本层 PDF 一律 `unsupported`，绝不猜 |
| `ctx.fs` 沙箱模式 | `workspace-write`（`ctx.fs` 即沙箱后端，带 `defaultMode`） | ✅ | `ctx.fs.sandboxMode` 可诚实播报 |

### 1.1 生产抽取 runner 的接线事实（本轮闭合）

M8 的 runner 缺口已闭合，且**没有新增任何预设行**：

| 项 | 事实 |
|---|---|
| 执行通道 | 复用已有的 `ctx.shell` 接缝（`createShellRunner(ctx)`，LaTeX 编译门早就在用）。预设的 `plugins` 列表**未变**——运行时插件（`workspace-dependencies`）没有被挂进去 |
| 解释器发现 | `src/extract/runtime.js` 按 `DSH_PROFESSOR_PYTHON` → `DSH_PRIMARY_RUNTIME` → `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` → `<process.resourcesPath>/runtime/primary-runtime` → `PATH` → `~/.local/bin` 依次枚举；`src/extract/runner.js` 再**逐个真的执行**一次 import 探针，只采信真的答上来的那个 |
| Ghostscript 发现 | `DSH_PROFESSOR_GS` → `PATH`（含 `/usr/local/bin`、`/opt/homebrew/bin`、`/usr/bin`、`/bin`）；`gs --version` 与 `gs -h` 各跑一次，另加一段自带的 PostScript 自测（`showpage`）确认它真的回结构化的 `<page>` 标记，而不是只看版本号 |
| argv 安全 | `src/extract/backend.js` 用单引号逐参数引用后拼成命令行（Harness 的 `ShellExecRequest.command` 是字符串），**不做字符串插值**；含 NUL 的 argv 直接拒绝 |
| 读路径门 | 任何进程启动**之前**，源路径先过调用方读策略；`..` 或读根之外直接 `failed`，且不会执行任何命令 |
| 只读保证 | Ghostscript 加 `-dSAFER`；Office 库用 `read_only=True` / `keep_links=False` / `data_only=False`（公式保持公式，不重算） |
| 超时与上限 | 探测 20 s、PDF 60 s、Office 60 s；捕获上限 = 4 MiB + 512 KiB，触顶时**拒绝解析半截 JSON**；PDF 最多 2000 页；XLSX 默认 24 表 / 2000 行 / 64 列 / 20000 单元格 |
| 坐标 | `page` / `slide` 一基正整数；跨页 `page_range`、跨张 `slide_range`；结尾落在已知范围外则 `coordinate_ambiguous: true`；后端没报页码则字段整体缺席 |

---

## 2. 现状缺陷（§8 逐条定位到行）

| # | 问题 | 证据（0.2.0 行号） | 处置 |
|---|---|---|---|
| 1 | README 写 6 个工具，实际 7 个 | README vs `index.js` L568-L736 | ✅ 0.3.0 修正为 3 个 |
| 2 | `project_scan` 与 `_v2` 行为完全相同 | L662-L676 / L678-L692（同参数、同 schema、同正文） | ✅ 删除二者，改为 `professor_index_sync` |
| 3 | 3 个 fs 探针 + 静态 status | L570-L660（`_v2` 是 `_capabilities` 真子集；status 的 `probe` 参数被忽略） | ✅ 全部移除，能力并入 `professor_diagnostics` |
| 4 | 无 Professor agent 层 | 全文件 | ✅ M3 完成：bundle 只 insert 一个可选预设 `id: professor`（`cordis.patch.yml`），人格约 1.4 KB 常驻 |
| 5 | 技能对整个部署可见 | bundle 层 `ctx.skills.registerProvider`（L724-L733） | ✅ M3 完成：provider 挂在预设内的 `dsh-professor-spike` 行，普通会话看不到 |
| 6 | 5 个技能依赖未打包载荷 | 引用 `${PERSONAL_AGENT_ROOT}`；源仓库**无 `PATHS.md`** → `parsePathsFile` 属死代码 | ✅ M5/M12 完成：技能正文保留 `${VAR}` 占位符，由 provider 在交付前解析（`env` → `PATHS.md` → 内建默认），未解析的保持占位符；载荷所在 workspace 由使用者指定 |
| 7-8 | 只收少量文本扩展名、只存元数据、无抽取/检索 | L9-L16、L115-L168 | ✅ M7/M8 完成（索引 + 标题感知分块 + 预算受限检索）；**但非文本抽取的生产 runner 未接线**，见 §1 能力矩阵 |
| 9-16 | 无课程注册、无会话绑定、无状态服务、无溯源、无产物管理、无文档管线、无并发保护、`private` 且分发不明 | 全文件 | ✅ M5-M12 完成：课程注册与只读导入、按会话绑定、四类溯源、产物与 LaTeX 管线、`createIfAbsent`/`replaceIfVersion` 并发保护、`private` + `files` 白名单 + 干净环境安装验证 |
| 17-19 | `EMFILE` 风险；无防抖；watcher 建在 **provider 工厂内部**（每个 scope 一个、`control.signal` 可选即泄漏）；校验器从不 abort | L533-L548、L726-L729；校验器 L98 | ✅ 0.3.0 修复 |
| 20 | 736 行单文件混 7 类关注点 | 行号映射见 §4 | ✅ 拆为 12 个模块 |

---

## 3. v3 假设与实装的差异（含一处否决）

| v3 假设 | 实装现实 | 适配 |
|---|---|---|
| 自定义会话事件 `professor/course-bound`（L501-L519；设计自述扩展点未知 L1743） | **不可实现**：事件类型闭集 + 无法标 `ignorable` + 持久化校验抛错 | **M6 改为项目侧按 session id 键控**（见下） |
| `ctx.fs` 受保护写入即原子性来源（L1085-L1089、L1833） | 成立，但必须逐调用盖章 | 网关强制要求 `sandboxPolicy` |
| 有 `course_id`/`course_code`/`term` | 注册表是 **Markdown（标题+代码块）而非 YAML**，**无稳定 id**，课程代码即身份；真实数据已偏离自身枚举（5/6 文件 `Default Note Format: Ask every time`、LaTeX 字段写成散文、CSC3001 缺 `# 10.`） | 由代码派生 `course_id`；解析器容忍漂移 |
| chunk 键名、PROGRESS/KNOWLEDGE 结构、migration.log 格式、项目根规则、预设包清单未定义 | 仍未定义 | 由实现定义并写入文档 |
| 索引需 `mtime` | fs 只给品牌化 `version` | 记 `mtime: null`，用 `fs_version` + `content_hash` |
| 读也走 `ctx.fs` | 读原语不围栏；写才有 `checkedTarget` | 写强制白名单；读边界靠会话工作区 + 显式允许根 |
| v3 未提符号链接判定细节 | `listDir` 跟随链接 | 索引逐条 `lstat`，`follow_symlinks:false` 时跳过并计入 `skipped` |
| `project.yaml` 需要 YAML 读写 | 插件刻意无外部依赖，Harness 也没有暴露 YAML 服务 | 实现**受控 YAML 子集**（嵌套映射/序列/标量/引号/注释 + JSON）；锚点、标签、流式集合、块标量、多文档一律 `PROFESSOR_YAML_SUBSET` 报错，绝不猜；更高 `schema_version` 一律 `PROFESSOR_PROJECT_UNSUPPORTED` 拒绝读写 |

### M6 否决的完整证据链（结论：v3 §4.6 需改设计）

1. `dsh-session/lib/index.js`：`KNOWN_SESSION_EVENT_TYPES = new Set([...])` 共 **54 项**，注释原文：*"Downstream (out-of-repo) plugin events are outside this list by construction… event-name registration was rejected because it does not classify omission safety and would make reads composition-dependent."*
2. 同文件 `append(type, data, ...opts)`：封装为 `{type, seq: SessionSeq(log.length), time, data, ...surfaceMetadata}`，`surfaceMetadata` 仅含 `sourceEventSeqs`/`surfaceOp` → **无 `ignorable` 通道**。
3. `dsh-session-persistence/lib/index.js`：`validateStoredEvents()` → `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(...)`，在 JSONL 后端 open/verify 时调用 → 追加未知类型会**让日志在重启后无法解析**。
4. 替代落点均不可用：投影只有读/折叠（无 setter，且只能折叠已知事件）；`settings` 是用户/部署级命名空间；`dsh-session-reference` 是跨会话快照引用。

**采用的替代**：`.professor/state/sessions/<session_id>.json`（`{session_id, course_id, bound_at, reason, history[]}`）。满足设计**意图**：会话独立（无文件即未绑定，**绝不**回退到其它会话——旧插件的 `storedSessionRoot()` 回退已删除）、切换显式留痕、每会话一文件无跨会话写竞争、同一项目下重放可复现。代价：绑定属项目而非转录，项目搬移需按课程代码重新解析。

---

## 4. 现有代码结构问题（0.2.0，736 行）

- 解析：L190-L202、L290-L411（自实现 YAML 子集，与 Harness 解析器仅靠契约对齐）
- 扫描：L9-L16、L94-L132、L152-L168
- 工具 schema：L551-L566 + 7 处内联块
- 状态/环境：L20、L35、L39-L44、L58-L81、L222-L278
- provider/watcher：L25-L30、L419-L523、L533-L548
- 诊断：L570-L660、L694-L722
- 注册与副作用：L568-L736（直接 `console.*`）
- 可复用：frontmatter 子集解析、provider 形状、`collectFiles`/`scanProject` 的确定性哈希、`substituteRoots`、会话 cwd 优先的项目根解析
- 应废弃：4 个探针、1 个重复扫描工具、`parsePathsFile`（本部署为死代码）、硬编码 `legacy-home` 候选、重复 watcher

---

## 5. 安全审计发现（0.2.0，按严重度）

| # | 发现 | 证据 | 处置 |
|---|---|---|---|
| 1 | **任意绝对 `root` 被原样接受**，随后写 `<root>/.professor/index.json` → 可写进 Personal-Agent（正是注册表禁止被复制的树） | L96-L97、L159-L166 | ✅ 0.3.0 取消 `root` 参数 |
| 2 | 相对 `root` 未拒 `..` | L106 | ✅ 策略层拒 `..` |
| 3 | **有意的裸 fs 沙箱绕过**（注释自认） | L138-L145 | ✅ 全部改为 `ctx.fs` + 盖章 |
| 4 | 符号链接**文件**被读并哈希（可越出根），符号链接**目录**被静默跳过（两向不一致） | L119-L124 | ✅ 逐条 `lstat`，跳过并计入 `skipped` |
| 5 | 通过环境变量 id 读 `~/.dsh/storages` 跨根 | L20、L74-L75 | ✅ 该回退已删除 |
| 6 | 临时文件写在目标旁（外部目标时也落在外部） | L164 | ✅ 由 fs 服务的原子发布取代，插件不再自造临时文件 |

---

## 6. 风险登记册

| 风险 | 影响 | 缓解 |
|---|---|---|
| 预设/技能隔离不足（缺陷 5） | Professor 行为泄漏给普通编码会话 | M3：provider 移入预设 `plugins` 列表；`plugins` 即工具面 |
| 迁移破坏真实 Personal-Agent 状态 | 用户数据丢失 | 导入只读；测试只用临时 fixtures；迁移写 `.professor/migrations/` 日志，不写源树 |
| 依赖载荷不随包 | 5 个技能在新机器上引用不存在的路径 | M5/M12：引导初始化到用户可写目录，或明确要求使用者提供 workspace |
| PDF 依赖宿主能力 | 无 `fitz`/`gs` 的机器上 PDF 不可用 | 能力探测 + 诚实标 `unsupported`，不伪造抽取。**注意**：当前插件侧连 runner 都未接线，所以在**任何**机器上 PDF/Office 都是 `unsupported`（见 §7 差距 1） |
| LaTeX 依赖 shell 与超时 | 编译门可能无法执行 | 预设含 `tool-bash`；无编译器时明说「未执行」，绝不声称通过 |
| `BUNDLED_SKILL_RANK = 600` 是内部常量镜像 | Harness 改动后失配 | 保持常量并注释来源；契约校验断言该值 |
| 范围过大 | 浅交付 | 按 M0-M12 分阶段，每阶段独立测试与验收 |

---

## 7. 当前状态（0.12.0）与未闭合差距

三列对照（Hermes `professor` 实际行为 / v3 目标设计 / 本实现）与每条差距的闭合路径、安全结论汇总、剩余限制清单见 **`docs/PARITY.md`**；本节记录同一批事实的里程碑视角与证据台账。

### 7.1 里程碑

M0-M12 全部实施完毕。每条的**已验证**含义如下（"代码完成" ≠ "已验证" ≠ "集成已验证"）：

| M | 状态 | 验证方式 | 独立性 |
|---|---|---|---|
| M0 | ✅ 已验证 | `node --test test/*.test.mjs`（205 项） | 离线 |
| M1 | ✅ 已验证 | 同上（watcher 非递归 / 恰一个描述符 / 突发合并为一次）+ `verify-plugin-skills.mjs` 39 项 | 离线 |
| M2 | ✅ 已验证 | 路径策略 / 沙箱 / 符号链接 / 并发 / 只读拒绝；源材料字节不变断言 | 离线 |
| M3 | ✅ **集成已验证** | `tools/verify-preset.mjs` 32 项（离线结构 + todo 配置）+ `tools/verify-profile-composition.mjs` 12 项（用加载器自身算法组合）+ `tools/verify-runtime-boot.mjs` 27 项（真实启动器、可丢弃 home、两次冷启动逐字节一致，**只证明组合**）+ **`tools/verify-host-schemas.mjs`（真实 `assertSupportedJsonSchema` + 真实 `ToolRuntime.register()` 注册全部 15 个工具）** + **`tools/verify-preset-activation.mjs`（真实 Cordis 加载器挂载整棵树，读真实预设注册表诊断）** | 真机 |
| M4 | ✅ 已验证 | `tools/verify-skill-sync.mjs` 79 项双侧锚点 | 离线（上游在时装才跑锚点） |
| M5 | ✅ 已验证 | 项目 schema / 课程注册 / 解析 / 归档 / 只读导入；YAML 子集安全失败 | 离线 |
| M6 | ✅ 已验证 | 会话独立 / 历史 append-only / 并发不丢失 / 无回退 / 损坏不重写 / 无 session id 硬失败 | 离线 |
| M7 | ✅ 已验证 | 分类只由注册源根与 `category_rules` 推导，最具体规则优先且与注册顺序无关；未匹配 `unassigned` | 离线 |
| M8 | ✅ 已验证 | `node test/extract-production.test.mjs` 19 项（真实后端契约 + 真实 PDF/Office 集成）+ `node test/extract-runtime.test.mjs` 16 项（argv 引用、候选顺序、结构化解析、失败分类）+ e2e 场景 19-27 | 离线 + 真机后端 |
| M9 | ✅ 已验证 | 四类来源 / 原题约束 / 页码映射与 `page_range` / 冲突展示 / 引用块；页与张坐标由真实后端生产（e2e 场景 20、22、28） | 离线 + 真机后端 |
| M10 | ✅ 已验证 | 标题漂移容忍 / `entry_id` 合并 / `revision` 并发拒绝 / 压缩 / `evidence: none` 一律拒绝 | 离线 |
| M11 | ✅ 已验证 | 格式门 / 输出根安全 / 不静默覆盖（`never` 默认）/ 笔记与复习内容契约 / 模板只读 / 编译四态判定 | 离线 |
| M12 | ✅ 已验证 | 诊断字段与 `notImplemented` 双向诚实 / 迁移只读 + dry-run + 日志 + 幂等 / 打包白名单 + 干净安装自测（205/205）+ npm cache 隔离回归自检 | 离线 + 真机安装 |

### 7.2 未闭合差距（逐条给出证据与闭合路径）

1. **PDF 的视觉校验**：插件从不渲染页面，所以「这一页排版对不对」「图里画了什么」仍然无法回答。文本抽取已接线，但它是**文本**能力；`capabilities.pdf.visual` 恒为 `false`，`pdf.inspected` 只有调用方显式声明才为真（`inspected_by: 'caller-attestation'`）。这是设计选择，不是缺陷。
2. **OCR 按设计关闭**：宿主无 tesseract，但插件的声明**不依赖**该宿主事实——它声明的是自己的边界。
3. **DOCX / XLSX 无页码**：结构读 OOXML 不渲染版面，所以没有页码可言；与其按行数猜，不如让坐标缺席（PPTX 的 `slide` 是结构里的事实，所以照报）。
4. **Office 的版面信息缺失**：表格还原为「行 × 列」文本，列宽、合并单元格的视觉跨度、批注、修订痕迹都不在输出里。
5. **M6 偏离 v3 §4.6**：绑定落在项目侧（`.professor/state/sessions/<session_id>.json`）而非会话事件日志，原因是 §3 的否决证据链。代价：项目目录搬移后需按课程代码重新解析。
6. **读路径未围栏**：Harness 的读原语本身不围栏，插件只对**写**做白名单强制；读边界依赖会话工作区与显式允许根。这是继承自运行时的限制，已在 §1 记录。
7. **仓库根的 `*.bak-*` 备份**：`index.js.bak-20260930-134809`、`package.json.bak-20260930-141448`、`cordis.patch.yml.bak-20260930-152316` 仍在仓库里。打包已被 `tools/verify-distribution.mjs` 的 `FORBIDDEN` 规则挡住（`/\.bak[-.]/`），并逐条断言，所以**不会进分发**；留在仓库是历史记录，可随时删除。

### 7.3 复核命令一览（全部以退出码 0 为准）

| 命令 | 项数 | 依赖 |
|---|---|---|
| `npm test` | 205 | 无 |
| `npm run verify:syntax` | 83 个文件 | 无 |
| `node verify-plugin-skills.mjs` | 39 | 无 |
| `node tools/verify-skill-sync.mjs` | 79 | 上游源在时装才跑锚点，否则跳过 |
| `node tools/verify-distribution.mjs` | 62 | 本地 npm，无网络；自带 mkdtemp npm cache |
| `node tools/verify-e2e.mjs` | 28 | 无（真实临时 fixture，按会话顺序驱动工具；19-28 在缺后端时报 SKIP 并给出原因） |
| `npm run verify:preset` | 32 | Harness 自带 Node |
| `npm run verify:composition` | 12 | Harness 自带 Node |
| `npm run verify:boot` | 27 | Harness 自带 Node + `dsh` 启动器（自建可丢弃 home）—— **组合层，不是启动层** |
| `npm run verify:host` | 44 | Harness 自带 Node（从 `app.asar` 导入真实校验器与 `ToolRuntime`） |
| `npm run verify:activation` | 24 | Harness 自带 Node（真实 Cordis 加载器，自建可丢弃 home） |
| `npm run verify:desktop` | 24 | Harness 自带 Node（真实 Cordis 加载器 + 真实 `~/.dsh/profiles/desktop` 的 bundle 清单与 patch 层，自建可丢弃 home；只读真实 profile） |

`npm run verify` 串起前六项且**不需要任何额外环境变量**（包含 npm cache 那一项，见 §7.4 第 8 条）；`npm run verify:harness` 串起后六项。

**六层证据不可互相替代**（源码/语法 → 假宿主 → **真实 schema 与注册** → 配置组合 → **真实运行时激活** → **桌面 profile 端到端** → 桌面 UI 冒烟）。尤其是：`--dump-config` 只打印组合后的树，**从不实例化插件**，因此它看不见被拒绝的 schema、被拒绝的子行配置、以及其它激活期失败——不得把它当作"完整启动"的证明。这条纪律是 §7.4 第 9 条的直接产物。

`verify:activation` 与 `verify:desktop` 的差别不是重复：前者挂载的是**合成** profile（`web` 模板 + 本插件），后者挂载的是桌面应用真正跑的五个 bundle 加该 profile 自己的 patch 层。一个 bundle 单独干净并不等于合进别的 bundle 之后仍干净，所以两者都要有。

### 7.4 本轮新发现并修复的缺陷（由端到端与真实启动复核暴露）

这一节记录的是：**离线模块测试全绿、但整机走一遍才会暴露**的缺陷。它们都属于同一个类别——**公布的契约与实现不一致**，所以每一条都补了会失败的回归测试。

| # | 缺陷 | 症状 | 证据 | 修复 |
|---|---|---|---|---|
| 1 | `state_update` 只按 `course_id` 精确匹配 | `course: "CSC3200"` 能绑定会话，却在 `state_read`/`state_update`/`artifact_*` 上报 `PROFESSOR_COURSE_MISSING` —— 而这四个工具的 schema 都写着 "Course id or code" | 会话工具走 `resolveCourse`（id 或 code、大小写不敏感、歧义询问），状态/产物工具走 `entry.course_id === resolved` | 把 `requireCourse` 提到 `courses/registry.js` 共享，双方都走它；歧义改为 `PROFESSOR_COURSE_AMBIGUOUS` 并列出候选 |
| 2 | `state_update` 的 `file` 枚举包含 KNOWLEDGE.md/INDEX.md，`kind` 枚举包含 `concept`，但两者都没实现 | 调用方按 schema 传 `KNOWLEDGE.md` + `concept` 会被拒绝；且拒绝信息告诉它对 KNOWLEDGE.md 传 `mistake/deep-dive/unit`（对那个文件毫无意义） | 实现分支只覆盖 `PROGRESS.md`（field / unit）与 `MISTAKES.md`（mistake / deep-dive）；`parseKnowledge` 有、`renderKnowledge` 不存在 | 枚举收紧为实际可写集合，`kind` 去掉 `concept`，拒绝信息按文件给出可执行建议；KNOWLEDGE/INDEX 明确为只读（用 `professor_state_read` 读、用文件工具改） |
| 3 | `kind: deep-dive` 被规划为零变更 | 传 `{kind:'deep-dive', topic, question}` 得到 `written: false` 且 `problems: []` —— 静默不写 | 变更条件只认 `field`/`unit`，深挖既无 title 也无这两者，`planStateUpdate` 收到空 changes | 深挖按 `topic` 计入变更（其身份就是 topic+question，正是 `mergeMistakes` 的键） |
| 4 | 单元更新的合并键无法跨读写往返 | 同一单元更新两次 → `Unit Progress` 表出现两行相同记录 | 表没有 id 列（上游形状），`parseProgress` 因此产出无 `entry_id` 的行；而合并键是 `u_<course>_<unit>`，下一次解析无法复现 | 新增 `unitEntryId(unit)`：由单元名（表里唯一的身份）派生，读写两侧一致；回归测试锁定"两次更新后恰好一行" |
| 5 | 能力报告中混入宿主断言 | `doesNotMatch(/on this machine/i)` 失败：LaTeX 探测结果里带着宿主路径断言 | `probeLatex` 的 note 写的是 "found latexmk on this machine" | 探测是**观测**，note 改为描述观测本身（`found latexmk`），路径作为证据保留；断言改为区分「插件边界字段」与「可带证据的观测字段」 |
| 6 | 文档与实现不一致（3 处） | README 写 0.11.0 / 12 技能 / 3 工具 / 40 项测试；`docs/PLAN.md` M5 写「48 项测试」；README 的 state 目录写成 `.professor/state/<course_id>/` | 实际 0.12.0 / 6 技能 / 15 工具 / 170 项；M5 实际 17 项；真实路径是 `.professor/state/courses/<course_id>/` | README 全量重写；PLAN 各里程碑改为实测项数；新增「版本一致性」测试（包版本 / README / 诊断三方一致，且源码里不得硬编码本包版本） |
| 7 | Office 能力门控是「三者齐全才算可用」 | 一个只有 `python-docx` 的解释器会把 DOCX 报成 `unsupported`——把一个**已观测到**的能力说成不存在；反过来，只要三者齐全就声称三种都能读，也不看这份文档是不是真的能解析 | `capabilities.officePython = Object.values(officeModules).every(Boolean)` 同时被 `planExtraction`、`extractOffice` 与能力报告当作唯一门；诊断里的 `office{docx,pptx,xlsx}` 三个字段则各说各的，两者可以互相矛盾 | 新增 `officeFormatAvailable(capabilities, extension)` 作为**唯一**判定（`officeModules[ext] === true`，无 modules 时回落到旧的 `officePython` 以兼容老调用方）；`planExtraction`、`runner.extractOffice`、能力报告三处都改走它；拒绝原因改为逐格式并点名缺哪个发行包（如 `python-pptx`）；回归测试覆盖「只有 docx 时 DOCX 可读、PPTX 报 unsupported 且原因点名 python-pptx」 |
| 8 | `npm run verify` 在全局 npm cache 不可写时必然失败 | 在一台 `~/.npm` 含 root 所有文件的机器上，`verify:dist` 的 `npm pack` 报 `EACCES`；同一命令加 `npm_config_cache=/private/tmp/...` 就能过——即校验器的成败取决于**与包无关**的环境事实，而且当时是靠手工加环境变量绕开的 | 复现：`npm pack` 写默认 cache；`tools/verify-distribution.mjs` 直接 `execFileSync('npm', …)` 且不传 `env`，因此继承环境里的 cache 设置 | 脚本改为每次运行 `mkdtemp` 一个**唯一** cache，经 `npm_config_cache` 传给每个子进程；`process.on('exit')` 处理器保证成功与失败路径都会清理；不写 `.npmrc`、不用 `sudo`、不改全局 cache 所有权、不硬编码任何临时路径（都有结构性断言）。回归自检：先用一个故意不可用的 cache（父级是普通文件 → `ENOTDIR`，root 也绕不过）断言 `npm pack` **必然失败**，再用隔离 cache 断言**必然成功**；因此 `npm run verify` 在默认环境下直接通过 |
| 9 | 同一个事实在三个界面上有三种说法 | `planExtraction` 说「no PDF text backend **available**」、能力报告说「was not **observed** in this runtime」——前者读起来像在断言宿主没有该能力（而这是观测不到的），后者才是在描述插件自己的边界 | `src/extract/capabilities.js` 与 `src/extract/runner.js` 各自手写了一份句子 | 抽出 `NO_PDF_BACKEND_REASON` / `noOfficeBackendReason()` 两个常量，所有界面共用；能力报告里的 `office.reason` 只在**三种格式都不可用**时才出现（否则会与旁边的 `docx: true` 自相矛盾），`unobserved[]` 也改为逐格式列出缺哪一项 |
| 10 | **预设装不上：工具 schema 用了宿主不支持的 type 数组，`tool-todo` 又缺必填配置** | 桌面 UI 的 设置 → Agent Presets 里 Professor 显示 **Failed to load**，新会话模式选择器里根本不出现；插件面板的「running」标签照旧，掩盖了子插件一个都没激活 | 诊断原文：`professor-runtime (dsh-professor-spike): unsupported JSON schema: schema.properties.course_id.type must be a single type string (type arrays are not supported)` 与 `tool-todo (@deepseek-ai/dsh-tool-todo): invalid config: $.allowParallelInProgress missing required value`。第一手证据：`@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema` 只接受单一 `type` 字符串或 exact-one `oneOf`（明确报 "type arrays are not supported"，且没有 `nullable`）；`ToolRuntime.register()` 在注册前就调用它。`@deepseek-ai/dsh-tool-todo` 的 `Config = z.object({ allowParallelInProgress: z.boolean().required() })` | 16 处 `type: ['X','null']` 全部换成 `oneOfTypes('X','null')`（分支互斥 → 宿主 exact-one 语义等价，语义未放宽）；顺带发现 `artifact_create` 的 `format`/`root`/`root_source`/`directory` 在「格式待选」分支返回 `null` 却声明为 `string`，同样改为可空；`cordis.patch.yml` 的 todo 行补上 `config.allowParallelInProgress: false`。**回归**：新增 `tools/verify-host-schemas.mjs`（44 项，导入实装校验器与真实 `ToolRuntime`）与 `tools/verify-preset-activation.mjs`（24 项，真实加载器挂载整棵树 + 真实注册表诊断） |

第 1、2、3、4 条都是**只在端到端顺序里才出现**的：模块测试单独看每个函数都是对的（`mergeEntry`、`mergeMistakes`、`parseProgress` 各自的单元测试全部通过），错的是它们**凑在一起**的契约。这正是 `tools/verify-e2e.mjs` 存在的原因。

第 8 条同理，只是换了一个维度：它只在**换一台机器**时才出现。校验器的可移植性和产品的功能一样，必须由一个会失败的回归测试守着——否则「在 CI 上加一个环境变量就好了」会一直掩盖它。

第 10 条揭穿的是**证据层级本身**的漏洞。当时 205 项单元/集成、28 个端到端场景、以及全部 `--dump-config` 检查都是绿的，预设却在真机上装不上——因为**没有任何一项检查碰过宿主自己的 schema 校验器或注册路径**：假工具注册表只把定义收进数组，从不校验；`--dump-config` 只组合配置、从不实例化插件。所以修复分两半，一半是产品代码，另一半是把缺失的那两层证据补上（`verify:host` / `verify:activation`），并在全部文档里写明 `--dump-config` **不是**完整启动的证明。
