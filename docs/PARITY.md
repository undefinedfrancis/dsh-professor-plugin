# 对照矩阵与差距报告（M12 最终交付）

这份文档回答一个问题：**现在的 `dsh-professor-spike` 相对于「Hermes Professor 实际会做什么」和「v3 目标设计想要什么」，究竟做到哪一步了。**

三列的定义与取证方式：

| 列 | 来源 | 取证方式 |
|---|---|---|
| **Hermes** | `/Users/<user>/.hermes/profiles/professor/SOUL.md`（800 行、27 节）与 `~/Personal-Agent` 的数据布局 | 只读通读；不修改该 profile、不改动 Personal-Agent 的任何文件 |
| **v3 目标** | 仓库外 `professor-harness-plugin-design-v3.md`（1879 行）+ M11/M12 的验收条目 | 通过 `docs/AUDIT.md §3` 记录的「v3 假设 vs 实装现实」逐条核对 |
| **DSH 实现** | 本仓库 `src/`、`cordis.patch.yml`、`skills/`、`tools/` | 源码 + 可复现的验证命令（见 §7） |

三种状态词的**严格含义**（`docs/AUDIT.md §7.1` 用的是同一套）：

| 标记 | 含义 | 判定标准 |
|---|---|---|
| ✅ **已验证** | 离线可复现 | 本机 `npm test` / 离线校验器全绿 |
| ✅ **集成已验证** | 在**真实 Harness** 里跑通 | 真实加载器组合、真实 `dsh` 启动器冷启动、真实宿主 schema/注册、**真实预设激活**，或真实干净安装 |
| ⚠️ **未接线** | 接缝完整且有测试，但生产路径没有消费者 → **诚实降级** | 工具返回 `unsupported` 并附原因，绝不伪造结果（当前只剩 `ctx.officeToPdf` 这一项：探测并如实播报，但没有抽取路径消费它） |
| 🔷 **设计选择** | 有意偏离，**不是缺陷** | 在 `docs/AUDIT.md` 或 README 里写明理由与代价 |

> 一句话结论：**Hermes 的教学语义与安全承诺基本 1:1 保留；v3 的产物/复习/LaTeX/学习状态设计已实现；PDF 与 Office 的文本抽取已接线并有真实后端证据（含逐页 `page` 与逐张 `slide` 坐标）；剩下的「未接线」只有 PDF 的**视觉**校验与 OCR，两者都是**设计选择**而非缺失；一处对 v3 的**否决**（会话绑定落点）有完整证据链。**

---

## 1. 主对照矩阵

### 1.1 运行形态与隔离

| 能力 | Hermes `professor` | v3 目标 | DSH 实现 | 状态 |
|---|---|---|---|---|
| 身份载体 | 独立 profile（`~/.hermes/profiles/professor`），`SOUL.md` 21.6 KB **全程常驻**上下文 | 专用 `professor` agent + 人格 | bundle 只 `insert` 一个**可选**预设 `@deepseek-ai/dsh-agent-preset`（`id: professor`, `order: 20`）；人格约 **1.4 KB** 常驻，细节交给技能按需加载 | ✅ **集成已验证** |
| 工具面隔离 | profile 级隔离（整个 profile 的插件就是工具面） | 预设隔离 | 预设的 `plugins` 列表**就是**工具面（Harness 预设 schema 无 `tools`/`allow`/`deny` 字段，最小权限只能靠组合表达）；**无任何部署级行** | ✅ **集成已验证** |
| 技能可见性 | 21 个技能目录挂在 profile 上 | 预设内注册 | provider `professor-bundled` **只在预设那一层**注册 → 普通编码会话看不到 | ✅ **集成已验证** |
| 记忆 | Hermes 全局记忆 + profile `memories/{MEMORY,USER}.md`；§16 明确**不**把课程状态放全局记忆 | 明确「课程状态归项目」 | 无全局记忆依赖；课程状态在项目侧 `.professor/state/courses/<course_id>/`（与 §16 的意图一致） | ✅ 已验证 |
| 抽取后端的挂载方式 | profile 上的插件直接可用系统工具 | 未定义 | **不新增预设行**：runner 复用已有的 `ctx.shell` 接缝（LaTeX 已在用），运行时插件**不**挂进预设 → 模型侧工具面仍然是那 15 个 `professor_*`，**没有**任何通用抽取工具；后端可用性靠真实执行观测（import 探针 / `gs --version` / 一次结构化输出自测） | ✅ 已验证（真机后端） |

### 1.2 课程注册与会话绑定

| 能力 | Hermes `professor` | v3 目标 | DSH 实现 | 状态 |
|---|---|---|---|---|
| 课程注册表 | `01_Learning/Registry/COURSES.md` + `Registry/Courses/<CODE>.md`；**Markdown 标题 + 代码块**，**无稳定 id**，课程代码即身份 | `course_id` / `course_code` / `term` 三件套 | 解析真实漂移的 Markdown（容忍缺失学期、枚举外取值、散文式 LaTeX 字段、`N/A`）；`course_id` 由课程代码派生（kebab-case）；同一代码不同学期各自注册 | ✅ 已验证 |
| 课程管理边界 | §20：`courses-manage` 管 REGISTER/SYNC/LOCATE/UPDATE/ARCHIVE，`notes-manage` 管教学；两者不混 | 注册 / 列出 / 解析 / 更新 / 归档 | `professor_course_manage`（每次一个操作，归档**不删材料**）+ `professor_course_list`（歧义只报候选） | ✅ 已验证 |
| 只读导入 | —（自身即源） | 从 Personal-Agent 导入 | **只读**导入：源注册表**零改动**，无法映射的字段原样回报 | ✅ 已验证（源树逐字节不变有断言） |
| 会话—课程绑定 | §24：**每个课程建议一个会话**；用户切换课程时显式确认新课程，不混材料 | 自定义会话事件 `professor/course-bound`（§4.6） | **否决 v3 §4.6**：自定义事件类型是**闭集 + 无法标 `ignorable` + 持久化校验抛错** → 改为项目侧 `.professor/state/sessions/<session_id>.json`（`course_id/bound_at/reason/history[]`） | 🔷 **设计选择**（偏离，有完整证据链 `docs/AUDIT.md §3`） |
| 无跨会话回退 | §24：不混材料 | 未定义 | 无 `session_projcache`、无环境默认、无其它会话读取；**无 session id 直接硬失败**而不是猜 | ✅ 已验证 |

### 1.3 材料索引、抽取与检索

| 能力 | Hermes `professor` | v3 目标 | DSH 实现 | 状态 |
|---|---|---|---|---|
| 材料索引 | §3：`courses-manage` 做「lightweight structural indexing」 | 需 `mtime`、稳定 `file_id`、增量 | 确定性增量索引：稳定 `file_id`、`fs_version` + `content_hash`（fs 无 mtime，记 `mtime: null`）；逐条 `lstat` 遵守 `follow_symlinks:false`；消失的文件标 `missing` 而**不删记录** | ✅ 已验证 |
| 虚拟分类 | §11 来源优先级（教授讲义 > 代码 > 官方教程 > 作业 > 学生笔记 > 补充） | 未定义 | 课程归属与分类**只**由 `project.yaml` 的已注册源根 / `category_rules` 推导；最具体规则优先且**与注册顺序无关**；未匹配一律 `unassigned`；带 `classification_source` / `classification_confidence` | ✅ 已验证 |
| 文本类抽取 | 靠通用文件读取 | 抽取管线 | Markdown/文本/LaTeX/代码/CSV/JSON 经 `ctx.fs` 读字节直读；标题感知分块（稳定 `chunk_id`、代码块不切开、硬上限） | ✅ 已验证 |
| **PDF 文本抽取** | 模型侧直接处理 PDF | PDF 文本 | **已接线**：经 `ctx.shell` 执行后端——打包 Python 的 PyMuPDF（`fitz`）优先，否则 Ghostscript `-sDEVICE=txtwrite -dTextFormat=1`（实测结构化 `<page>` 标记可用）。逐页文本喂给分块器，`page` 由真实页边界产生；2 页真实 PDF 的端到端链路（extract → chunk → search → SourceRef → 产物引用块）有测试 | ✅ 已验证（真机后端） |
| **Office 文本抽取** | 模型侧直接处理 PPT/docx | Office（docx/pptx/xlsx） | **已接线**：经 `ctx.shell` 调用**打包 Python**（`python-docx` / `python-pptx` / `openpyxl`）；DOCX 保持文档顺序（标题→`#` 级、表格→`\| a \| b \|`）、PPTX 逐张带真实 `slide`、XLSX 逐表带表名且**公式照抄不重算**。**逐格式判定**：缺 `python-pptx` 不会连累 DOCX | ✅ 已验证（真机后端） |
| **PPT 视觉检查** | 模型侧视觉 | PPT 视觉检查 | ❌ **不接线（设计选择）**：插件只读文本层，**从不渲染**；`capabilities.pdf.visual` 恒 `false`，`extraction.visualInspection` 恒以 `not performed` 开头。文本抽取已接线 ≠ 视觉校验已接线 | 🔷 **设计选择** |
| OCR | 模型侧视觉 | 未明确 | **按设计关闭**：插件不接任何 OCR 引擎，扫描件与无文本层 PDF 一律 `unsupported`；声明的是**插件自己的边界**，不依赖宿主事实 | 🔷 **设计选择** |
| 检索 | §25 上下文预算：只读活跃课程的 Registry / Knowledge / 所需技能；不整目录重读 | 词法检索 | 预算受限分块检索（`max_chunks`/`max_sources` **硬预算** + 过滤前置 + 确定性排序 + 诊断）；预设内另挂 `dsh-tool-fs-search`（ripgrep）与 `dsh-tool-web` | ✅ 已验证 |

### 1.4 溯源与证据

| 能力 | Hermes `professor` | v3 目标 | DSH 实现 | 状态 |
|---|---|---|---|---|
| 来源分类 | §11 来源优先级；§25 区分 sourced facts / calculations / teaching explanations | `SourceRef` 四类来源 | `SourceRef` 四类（local / external / user / model-inference）；只含**已知**字段，未知 `page`/`slide` **省略而非猜测** | ✅ 已验证 |
| 练习题标注 | §27：`原题` / `改编题` / `新编练习`，**绝不暗示新题来自教授** | 原题约束 | 同三标签；「原题」约束有专门断言（不可能把新编题标成原题） | ✅ 已验证 |
| 页码坐标 | §25：记录 title/publisher/date/URL 与**具体主张** | PDF 抽取器产出页码 → 分块携带 `page` | **有生产者**：真实 PDF 的一基 `page` 来自后端的逐页边界；跨页分块写 `page_range: [a,b]`；结尾落在已知页之外标 `coordinate_ambiguous: true` 而**不猜**；后端不报页码时字段整体缺席 | ✅ 已验证（真机后端） |
| slide 坐标 | — | 幻灯片边界 | **有生产者**：PPTX 的 `slide` 来自 `python-pptx` 的张序（一基），逐张保留到检索结果与引用块；`slide_range` 同理。`dsh-office-to-pdf` 仍只给页面，未被用于此 | ✅ 已验证（真机后端） |
| 冲突处理 | §25：多源分歧要**如实报告** | 冲突展示不合并 | 冲突**展示不合并**；未观测到的坐标不写 | ✅ 已验证 |
| 引用块 | §25「资料依据」节；不必要不加装饰性引用 | 产物引用块 | 产物引用块`资料依据`，区分 external 与 model-inference；无检索则不加 | ✅ 已验证 |

### 1.5 学习状态与续学

| 能力 | Hermes `professor` | v3 目标 | DSH 实现 | 状态 |
|---|---|---|---|---|
| 状态文件 | `Knowledge/<CODE>/{INDEX,PROGRESS,KNOWLEDGE,MISTAKES}.md`，四文件**职责分明**（§5、§15） | 未定义结构 | 同四个文件名 + 同四职责；解析器容忍真实漂移（`**Field:**` 后置 `**`、`##`/`# 1.` 混用、单字符表分隔、`## File Inventory` 挂载点） | ✅ 已验证 |
| 选择性更新 | §6「不要每次交互都改所有 Knowledge 文件」；§7 轻量提问**不写状态** | `evidence: none` ⇒ 不写 | `professor_state_update` 的 `evidence` 门：`none` **一律拒绝写入**（不是「先写再说」） | ✅ 已验证 |
| 去重 | §15「prefer merging and rewriting over endless appending」；§26 同主题**更新而非重复** | `entry_id` 合并 | `entry_id` 合并：同一单元/同一错误/同一深挖**只占一行**；新增 `unitEntryId(unit)` 让单元合并**跨读写往返可复现** | ✅ 已验证 |
| 压缩 | §15：KNOWLEDGE 是压缩持久理解，**不得**成为笔记的第二份副本 | 压缩 | 压缩：重复单元折叠、慢性错误转 resolved、过期深挖清理；**压缩保留历史**（不删证据） | ✅ 已验证 |
| 并发保护 | — | `revision` 并发拒绝 | `revision` + `replaceIfVersion` 检测并发更新并**拒绝静默覆盖**（`FS_STALE_VERSION`） | ✅ 已验证 |
| 续学 | §17：`PROGRESS.md` + `INDEX.md` 决定上一停点 / 未完成 / 推荐下一材料 / 复习主题，**不问起点** | 持久状态驱动 | 同一语义由 `PROGRESS.md` 的 `current_unit` / `recommended_next_step` 驱动；会话绑定提供课程上下文 | ✅ 已验证 |

### 1.6 产物：笔记、深挖、复习、LaTeX

| 能力 | Hermes `professor` | v3 目标 | DSH 实现 | 状态 |
|---|---|---|---|---|
| 笔记输出位置 | §12：`<COURSE_ROOT>/04_My-Notes/AI-Notes/`（以注册配置为准）；**不得**写进 `Knowledge/` | 输出根解析 + create-only | 输出根校验（拒 `..`、拒指进 `.professor/state`、拒与源根重叠或落入源根内部、拒符号链接逃逸）；**绝不回退到进程工作目录** | ✅ 已验证 |
| 格式门 | §13/§24：未指定格式就**每次都问**「1. Markdown 2. LaTeX」，**绝不**复用上次选择 | 格式门 | `default_format: ask` **每次都问**；字面值为 `LaTeX`/`Markdown` 才自动采用 | ✅ 已验证 |
| 不静默覆盖 | §21：不覆盖、不清空、宁可保守可逆 | 默认 `never`、版本化备选、显式覆盖需当前版本保护 | `overwrite_policy: never`（默认）→ 拒绝并建议 `versioned`（写 `-vN`）；`allow` 需匹配 `expectedVersion`（否则 `PROFESSOR_ARTIFACT_STALE`） | ✅ 已验证 |
| 笔记内容契约 | §12 详细笔记、§8 中文解释保留英文术语 | Markdown 笔记内容契约 | `professor_artifact_create` 产出结构化笔记（含溯源引用块） | ✅ 已验证 |
| 深挖请求 | §26：`MISTAKES.md` 的 `Requested Deep Dives` 子区块（日期/主题/问题/成因/复习动作，**不负面标签**）+ 笔记里用 callout 或 `重点掌握：加深讲解` 标记 | deep-dive callouts | `kind: deep-dive` → 按 `topic`+`question` 去重合并进 `MISTAKES.md`；笔记侧带深挖标记 | ✅ 已验证 |
| 考试复习 | §27：四标签优先级图 `薄弱点`/`重难点`/`高频基础`/`待确认范围`；小块引导循环；独立复习产物；优先级不得无据声称 | exam-review artifact | 同四区块 + 同三标注 + **独立**复习产物；「未确认范围」如实存在 | ✅ 已验证 |
| LaTeX 模板 | §13：解析并**复制**模板、改副本、**绝不**改共享主模板；共享模板在 `06_Shared/Templates/` | 模板只读 + 生成契约 + 编译门 | 模板**只读**、复制到产物目录再改写；跳过 `latexmkrc`/`.latexmkrc`；`-interaction=nonstopmode -halt-on-error`，**不加** `-shell-escape`（除非显式选择） | ✅ 已验证 |
| 编译判定 | §13「compile when appropriate and supported」；技能要求**诚实结论行** | 诚实 verdict | 四态判定：`source_generated` / `compiler_unavailable` / `compilation_failed` / `compilation_succeeded`；无编译器就明说「未执行」，**绝不声称通过**；`pdf.inspected` 只认调用方显式声明 | ✅ 已验证 |
| 产物状态 | — | 健康/校验 | `professor_artifact_status`：路径、版本、字节数、健康问题；只读 | ✅ 已验证 |

### 1.7 迁移、诊断、打包

| 能力 | Hermes `professor` | v3 目标 | DSH 实现 | 状态 |
|---|---|---|---|---|
| 迁移 | —（自身即源） | 安全迁移/导入工作流 | **只读**源树：dry-run 零写入、稳定映射 + 未映射回报、幂等重跑、`.professor/migrations/` **追加式**日志；**源树逐字节不变**有断言 | ✅ 已验证 |
| 诊断 | 无统一端点 | `professor_diagnostics` 扩充字段集，且**必须**从 `notImplemented` 移除已完成项 | 统一健康端点：版本 / 项目根与 schema / 会话绑定 / 课程注册表 / 索引与分块 / 抽取能力矩阵 / LaTeX 与产物配置 / 状态冲突 / 迁移 / provider+watcher；`notImplemented` 与实现**双向**诚实；**不含**环境变量转储、密钥、文件内容、提示词、完整状态（有测试双向断言） | ✅ 已验证 |
| 打包 | Hermes profile 机制 | npm vs private 决策 | `private: true` + `license: UNLICENSED`（**决策**，非待办）+ `files` 白名单；`docs/` 与 `*.bak-*` **不进分发** | ✅ **集成已验证** |
| 干净安装 | — | clean-install 验证 | `tools/verify-distribution.mjs` 在干净临时目录**离线**安装 tarball 并跑装后自测（**205/205**），并断言装后 `apply()` 注册 **15 工具 + 6 技能**；另含 **npm cache 隔离的回归自检**（见 §4） | ✅ **集成已验证** |

### 1.8 技能目录映射

| Hermes 上游 | DSH 技能 | 状态 |
|---|---|---|
| `study-session` + `04_Agents/Learning-Agent/{MODES,SYSTEM}.md` + SOUL.md | `professor-study`（PPT / PROBLEM / CODING-TUTOR / READING / TRANSLATE 五模式、恢复顺序、提示梯度、证据门槛） | ✅ 已验证 |
| `notes-manager`（教学部分剥离） | `professor-notes`（只管产物） | ✅ 已验证 |
| `05_Skills/learning/course-manager` + `Registry/*` | `professor-course-management` | ✅ 已验证 |
| `latex-notes-quality` + 模板 | `professor-latex` | ✅ 已验证 |
| `research/web-research-evidence` | `professor-research` | ✅ 已验证 |
| —（复习行为只存在于人格文档） | `professor-review`（**显式化**为按需加载技能） | ✅ 已验证 |
| `algorithm-coach`、`agent-handoff`、`hermes-routing`、`project-discovery`、`project-orchestrator`、`project-verification`、`safe-opencode-execution` | **刻意排除**（Algorithm Coach 在 Hermes 中是**另一个 bot**，其余是项目开发工作流） | 🔷 **设计选择**（校验器强制不随包） |

---

## 2. 三处根因差异（为什么三列会分叉）

| # | 分叉点 | Hermes 做法 | v3 设想 | DSH 的裁决 | 依据 |
|---|---|---|---|---|---|
| 1 | **会话绑定落点** | 每个课程一个会话，靠人格约束 | 追加自定义会话事件 `professor/course-bound` | **否决**：事件类型闭集（54 项）+ 无法标 `ignorable` + `validateStoredEvents()` 对未知类型 `throw unsupported` → 追加会让日志**重启后无法解析**；改项目侧一文件一会话 | `docs/AUDIT.md §3` 四步证据链 |
| 2 | **技能目录宽度** | 21 个技能目录（含 devops / blockchain / social-media 等） | 未定义 | 收窄为 **6 个 `professor-*`**，发布**零别名** | `docs/SKILLS.md` |
| 3 | **课程身份** | 课程代码即身份，**无稳定 id** | `course_id` + `course_code` + `term` | 由代码**派生** `course_id`；解析器容忍真实漂移；`course_id`/`course_code` **不可被 update 改写** | `docs/AUDIT.md §3` |
| 4 | **能力声明方式** | 靠模型侧通用能力（PDF/PPT 由模型看） | 假定插件能抽取（PDF/Office/PPT） | 抽取**已接线**，但声明方式不变：**只声明插件自己的边界**。后端可用性来自**真实执行**（一次 import 探针 + `gs --version` + 一次结构化输出自测），逐格式播报；未观测到的后端进 `unobserved[]` 并给原因；**视觉与 OCR 仍为 `false`**，因为插件确实不渲染、不 OCR | `docs/AUDIT.md §1` 能力矩阵两列分列、§1.1 接线事实 |
| 5 | **配置解析** | 无固定格式 | 需要 YAML 读写 | 插件刻意无外部依赖 → **受控 YAML 子集**；锚点/标签/流式集合/块标量/多文档一律 `PROFESSOR_YAML_SUBSET` 报错而非猜；更高 `schema_version` 一律 `PROFESSOR_PROJECT_UNSUPPORTED` | `docs/AUDIT.md §3` |

---

## 3. 差距报告（逐条：现状 → 影响 → 闭合路径 → 成本）

| # | 差距 | 现状 | 影响 | 闭合路径 | 成本 |
|---|---|---|---|---|---|
| 1 | **PDF 的视觉校验不接线** | 只读文本层，从不渲染页面；`capabilities.pdf.visual` 恒 `false`、`pdf.inspected` 只认调用方显式声明 | 无法回答「这一页排版对不对」「图里画了什么」——**文本**能力不等于**视觉**能力 | 需要接栅格化（`gs -sDEVICE=png16m`）+ 图像读取 + 图形化证据记录；超出「文本抽取」范围，且会引入 OCR/视觉判断的诚实性风险 | **高**（新增能力面，非本插件当前定位） |
| 2 | **OCR 关闭** | 插件不接任何 OCR 引擎 | 扫描件与纯图片永远 `unsupported` | 接 OCR 引擎（宿主无 tesseract），并需定义「OCR 结果算不算读到了原文」的诚实口径 | 高（且与「不猜」原则冲突，需先设计） |
| 3 | **DOCX / XLSX 无页码** | 结构读 OOXML 不渲染版面 | 这两类文档的引用只能给行区间，给不了页码 | 需渲染或版面分析；当前**刻意不做**（按行数猜页码比缺席更糟） | 高 / 或不做 |
| 4 | **Office 版面信息缺失** | 表格还原为「行 × 列」文本 | 列宽、合并单元格跨度、批注、修订痕迹不在输出里 | 各库都提供了部分接口，但输出契约需要重新设计 | 中 |
| 5 | **会话绑定项目侧**（偏离 v3 §4.6） | `.professor/state/sessions/<session_id>.json` | 项目目录**搬移后**需按课程代码重新解析 | 换落点需上游开放会话事件类型注册（当前不可能） | **不可闭合**（取决于 Harness） |
| 6 | **读路径未围栏** | 只对**写**强制白名单 | 读边界依赖会话工作区与显式允许根 | 继承自运行时（读原语本身不围栏） | **不可闭合**（取决于 Harness） |
| 7 | **依赖载荷不随包** | 技能引用的学习状态文件必须位于**使用者可写**的 workspace | 新机器上需把 `PERSONAL_AGENT_ROOT` 指向那份 workspace | 已文档化（README §5 / `professor_paths` 可核对 `source`） | 低（配置） |
| 8 | **技能根相对优先级** | `BUNDLED_SKILL_RANK = 600` 高于用户根（400） | 本机若另装同名技能，生效的是本插件这份 | 内部常量镜像已注释来源且契约校验断言该值 | 低（随 Harness 变化需复核） |
| 9 | **仓库根 `*.bak-*` 备份** | 3 个备份文件仍在仓库里 | **不进分发**（`verify-distribution.mjs` 的 `FORBIDDEN` 逐条断言） | 随时可删（保留是历史记录） | 0 |
| 10 | **校验器对环境敏感**（本轮闭合） | `tools/verify-distribution.mjs` 继承环境里的 npm cache，在 `~/.npm` 不可写的机器上必然失败，靠手工加 `npm_config_cache` 绕过 | 「换一台机器就红」的假失败，掩盖真实回归 | 每次运行自建唯一 `mkdtemp` cache 并经 `npm_config_cache` 传给子进程；成功/失败路径都清理；**并用一个故意不可用的 cache 做回归自检**（断言它必然失败、隔离后必然成功） | 0（已闭合） |

**已闭合（本轮由端到端复核暴露并修复）**：课程 id/code 解析不一致、`state_update` 公布不可写形状、`kind: deep-dive` 被规划为零变更、单元合并跨读写往返重复、能力报告混入宿主断言、3 处文档与实现不一致 —— 详见 `docs/AUDIT.md §7.4`。

**已闭合（本轮的功能缺口）**：非文本抽取 runner 未接线、页码坐标无生产者、slide 坐标无生产者 —— 见下表。

| 原缺口 | 闭合方式 | 证据 |
|---|---|---|
| **非文本抽取 runner 未接线** | 复用已有 `ctx.shell` 接缝（LaTeX 已在用）实现 PDF/Office runner，**未新增预设行**、**未把运行时插件挂进预设**；后端可用性靠真实执行观测 | `test/extract-runtime.test.mjs` 16 项 + `test/extract-production.test.mjs` 19 项 + e2e 场景 19/21/22/23/27 |
| **页码坐标无生产者** | Ghostscript 用 `-dTextFormat=1` 拿逐页 `<page>` 标记（并自测确认该 build 真的支持，而不是只看版本号）；PyMuPDF 路径用 `get_text()` 逐页 | 真实 2 页 PDF → 分块 `page ∈ {1,2}` → 检索命中 `page: 2` → `SourceRef` `p.2` → 产物引用块含 `p.2`（e2e 场景 19/20/28） |
| **slide 坐标无生产者** | `python-pptx` 的张序即 `slide`（一基），逐张 `## Slide N: 标题` 入文档再映射回分块 | 真实 2 张 PPTX → 分块 `slide ∈ {1,2}` → 检索命中 `slide: 1` → 引用块含 `slide 2`（e2e 场景 22/28） |

三类新失败模式也同时被词汇化，不再有「失败被说成成功」的空隙：**后端缺席** → `unsupported`；**超时/取消** → `failed`（写明 `timed out after Nms`）；**捕获溢出** → `failed`（拒绝解析半截 JSON）；**加密** → `unsupported`（先查 OLE/CFB 头）；**无文本层** → `unsupported` 并点名 OCR。

---

## 4. 契约一致性：公布 = 实现（本轮新增的强约束）

上面 4 条「已闭合」缺陷有**同一个根因**：**公布的契约与实现不一致**。为此本轮加了三条会失败的回归门：

| 门 | 断言 | 文件 |
|---|---|---|
| 初始化顺序门 | 任何工具都不得在初始化前引用变量（TDZ）：每个课程工具必须返回**领域错误**而非 `ReferenceError` | `test/regressions.test.mjs` |
| 课程身份门 | 每个接受课程的**工具**都接受 id 或 code（4 种拼写），歧义时返回 `PROFESSOR_COURSE_AMBIGUOUS` 并列出候选，**绝不替用户选** | `test/regressions.test.mjs` |
| schema/实现一致门 | `professor_state_update` 的 `file` / `kind` 枚举**只**公布实际可写的形状；拒绝信息按文件给出可执行建议 | `test/state.test.mjs` |
| 版本一致门 | 包版本 / README / 诊断三方一致，且 `src/*.js` 与 `index.js` 不得硬编码本包版本；篡改 README 会让它失败（已实测） | `test/indexer.test.mjs` |
| 能力门控一致门 | Office 的可用性只有 `officeFormatAvailable()` 一个判定；**逐格式**生效，只有 `python-docx` 时 DOCX 可读、PPTX 报 `unsupported` 并点名 `python-pptx` | `test/extract-production.test.mjs`、e2e 场景 21–23 |
| npm cache 隔离门 | `verify-distribution.mjs` 只执行 `npm pack` / `npm install`；cache 来自运行时 `mkdtemp`；用一个故意不可用的 cache 断言**失败**、用隔离 cache 断言**成功**；成功与失败路径都清理 | `tools/verify-distribution.mjs` §2b / §7 |

这六条是**离线模块测试全绿、整机走一遍才暴露**（或**换一台机器才暴露**）的那一类缺陷的防线，也是 `tools/verify-e2e.mjs`（28 场景）存在的原因。

---

## 5. 安全结论汇总

| 要求（不可协商） | 落实 | 证据 |
|---|---|---|
| 写入只有一个通道 | 全部写经 `ctx.fs` + 逐调用 `ctx.sandboxPolicy.resolve({ session })` 盖章；插件不持有 `node:fs` 写通道 | `test/security.test.mjs`、`src/fs/gateway.js` |
| 课程原始材料**永不可写** | 写白名单只含 `<projectRoot>/.professor/` 与显式配置的输出根；源根被排除 | `test/paths.test.mjs`、e2e 场景 13 |
| 不越界 | 拒 `..`；符号链接经 realpath 规范化 + 逐条 `lstat`，不得越出边界 | `test/paths.test.mjs`、`test/indexer.test.mjs` |
| 并发不静默丢失 | `createIfAbsent`（no-replace 原语）与 `replaceIfVersion`（fs 版本令牌） | `test/security.test.mjs`、`test/state.test.mjs` |
| 不静默覆盖 | 产物默认 `never`；`versioned` 写 `-vN`；`allow` 需匹配 `expectedVersion` | `test/artifacts.test.mjs`、e2e 场景 14 |
| 不破坏用户数据 | 迁移**只读**源树、dry-run、追加式日志；归档**不删材料**；消失的索引文件标 `missing` 而非删除 | `test/migration.test.mjs` |
| 不泄漏敏感信息 | 诊断**不含**环境变量转储、密钥、文件内容、提示词、完整状态；分发包无秘密与个人绝对路径 | `verify-plugin-skills.mjs`、`tools/verify-distribution.mjs` |
| 不改 Hermes / Personal-Agent | 全程只读引用；迁移写 `.professor/` 而非源树；真实 profile 在 `verify:boot` 前后摘要比对**未变** | `tools/verify-runtime-boot.mjs` |
| 不伪造能力 | 未观测到的后端进 `unobserved[]` 并给原因；抽取失败按 `unsupported`/`failed` 分开且都不叫成功；编译四态诚实；`pdf.inspected` 只认调用方声明 | e2e 场景 9/16/24/25/26、`test/extract-e2e.test.mjs` |
| 抽取只读、绝不改源文件 | Ghostscript 加 `-dSAFER`；Office 库 `read_only=True` / `keep_links=False`；源路径在**任何进程启动前**过读策略，`..` 或读根之外直接拒绝且不执行命令 | `test/extract-production.test.mjs`（越界用例、源 PDF 字节哈希前后比对）、e2e 场景 19/21 |
| 绝不执行文档内容 | 不跑宏、不重算公式（`data_only=False`，公式照抄）、不跟随外部链接（`keep_links=False`）、不隐式 OCR | `src/extract/scripts/extract_office.py`、e2e 场景 23 |
| 有界资源占用 | 超时（探测 20 s / PDF 60 s / Office 60 s）、捕获上限（4 MiB + 512 KiB，触顶即拒解析）、页码上限 2000、XLSX 默认 24 表 / 2000 行 / 64 列 / 20000 单元格，触顶显式回报 | `test/extract-production.test.mjs`、e2e 场景 27 |
| 校验器不依赖、不损坏宿主环境 | 自带唯一 `mkdtemp` npm cache；不写 `.npmrc`、不用 `sudo`、不改全局 cache 所有权、不硬编码临时路径；成功与失败都清理 | `tools/verify-distribution.mjs` §2b / §7 |

---

## 6. 剩余限制（必须继续如实声明）

1. **PDF 的视觉校验不工作**：插件只读文本层，从不渲染页面，所以无法回答「这一页排版对不对」「图里画了什么」（差距 1）。文本抽取**已工作**，但那是文本能力。
2. **OCR 关闭**：扫描件与无文本层 PDF 一律 `unsupported`（差距 2，设计选择）。
3. **DOCX / XLSX 没有页码**：只有 PDF 的 `page` 与 PPTX 的 `slide` 是真实坐标（差距 3）。
4. **Office 版面信息缺失**：列宽、合并跨度、批注、修订痕迹不在输出里（差距 4）。
5. **会话绑定属项目**：项目目录搬移后需按课程代码重新解析（差距 5）。
6. **读路径未围栏**：读边界靠会话工作区与显式允许根（差距 6）。
7. **技能根优先级**：`BUNDLED_SKILL_RANK = 600` 是本机同名技能的胜出者（差距 8）。
8. **后端可用性取决于运行时**：PDF 需要打包 Python 的 `fitz` 或 `gs` 的 `txtwrite`；Office 需要打包 Python 的三个库（**逐格式**）。都不在时对应格式报 `unsupported` 并给原因——这是**如实降级**，不是伪造，但用户确实拿不到那部分文本。`professor_diagnostics` 的 `extraction.capabilities.probe` 就是查这件事的地方。
9. **`docs/` 不进分发**：`docs/PARITY.md` 与 `docs/AUDIT.md` 是仓库内设计记录，随包发布的只有 `index.js`/`src`/`skills`/`cordis.patch.yml`/`tools`/`test`/`verify-plugin-skills.mjs`。

`professor_diagnostics` 的 `notImplemented` 字段是上表的机器可读版本；README §5 与它保持一致，测试双向断言二者不得漂移。

---

## 7. 复核命令（全部以退出码 0 为准）

| 命令 | 项数 | 依赖 |
|---|---|---|
| `npm test` | **205** | 无 |
| `npm run verify:syntax` | 83 个文件 | 无 |
| `node verify-plugin-skills.mjs` | 39 | 无 |
| `node tools/verify-skill-sync.mjs` | 79 | 上游源在时装才跑锚点，否则跳过 |
| `node tools/verify-distribution.mjs` | **62** | 本地 npm，无网络；自带唯一 `mkdtemp` cache |
| `node tools/verify-e2e.mjs` | **28** | 无（真实临时 fixture；19–28 在缺后端时报 `SKIP` 并给出原因，绝不用 mock 假装通过） |
| `npm run verify:preset` | 32 | Harness 自带 Node |
| `npm run verify:composition` | 12 | Harness 自带 Node |
| `npm run verify:boot` | **27**（真实冷启动 ×2） | Harness 自带 Node + `dsh` 启动器 —— **组合层，不是启动层** |
| `npm run verify:host` | **44** | Harness 自带 Node；从 `app.asar` 导入实装 `assertSupportedJsonSchema` 与真实 `ToolRuntime` |
| `npm run verify:activation` | **24** | Harness 自带 Node；真实 Cordis 加载器在可丢弃 home 里挂载整棵树并读真实预设注册表 |
| `npm run verify:desktop` | **24** | Harness 自带 Node；把真实 `~/.dsh/profiles/desktop` 的 bundle 清单与 patch 层原样复制到可丢弃 home 启动（只读真实 profile） |

`npm run verify`（前六项）与 `npm run verify:harness`（后六项）本轮全部以退出码 0 通过，且**不需要任何额外环境变量**。

> ⚠️ **证据层级**：`--dump-config` 只打印组合后的树、**从不实例化插件**，所以它不是「完整启动」的证明。真实 schema/注册由 `verify:host` 覆盖，真实激活由 `verify:activation` 覆盖，桌面应用真正跑的五个 bundle 由 `verify:desktop` 覆盖；桌面 UI 观感仍需人工确认。详见 `docs/AUDIT.md` §7.3 与 §7.4 第 10 条。

里程碑与逐条验收映射见 `docs/PLAN.md`；宿主 API 的第一手证据与差距台账见 `docs/AUDIT.md`。
