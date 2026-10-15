# 实施计划（依赖排序）

目标：把 Professor spike 插件做成交付级 DeepSeek Harness 实现，功能上尽可能接近 Hermes `professor` bot。
每个里程碑独立可验收；迁移过程中插件始终保持可用。

| M | 内容 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|
| **M0** | 模块化拆分（`src/*`）+ `node:test` 脚手架 + 语法门；冻结既有行为 | — | 契约校验通过；单一职责模块；无行为回归；语法门 `npm run verify:syntax`（81 个文件逐个 `node --check`） | ✅ |
| **M1** | 修 §8 的 2/3/17/18/19：删重复扫描工具与 4 个探针；每插件实例唯一、非递归、防抖、可降级的 watcher；校验器不再遗留描述符与 EMFILE | M0 | 校验器无警告通过；强制 EMFILE 用例优雅降级；watcher 测试断言「非递归 + 恰好一个描述符 + 突发合并为一次」 | ✅ |
| **M2** | 安全与文件边界：路径策略（读/写白名单、拒 `..`、符号链接不越界）；全部写入走 `ctx.fs` + `sandboxPolicy.resolve({session})`；`createIfAbsent`/`replaceIfVersion` 并发保护；不支持 schema 安全失败；确定性增量索引器 | M0 | 越界/穿越/符号链接逃逸/只读模式/并发丢失更新/原子恢复 等安全测试；源材料字节不变 | ✅ |
| **M3** | Professor 预设 + 人格：bundle 只插入一个 `@deepseek-ai/dsh-agent-preset`（`id: professor`，`order: 20`，11 行 plugins：persona / `dsh-professor-spike` / tool-fs / fs-search / bash / web / ask-user / todo / present / tool-skill + compaction 组）；插件与技能 provider 移入预设实现隔离；SOUL.md 提炼为约 1.4 KB 中文优先常驻策略 | M1 | `tools/verify-preset.mjs` 32 项通过（结构、schema、子插件在实装中可解析、`tool-todo` 必填配置、无机器路径、人格覆盖必需规则）；`tools/verify-profile-composition.mjs` 12 项用加载器自身算法组合并断言隔离；`tools/verify-runtime-boot.mjs` 27 项用真实 `dsh` 启动器在可丢弃 home 里冷启动两次（**只证明组合**：bundle 解析 + 兼容性评估 + patch 加载 + 组合逐字节一致 + 真实 profile 未被写）；**`tools/verify-host-schemas.mjs` 44 项用实装 `assertSupportedJsonSchema` 与真实 `ToolRuntime.register()` 验证并注册全部 15 个工具**；**`tools/verify-preset-activation.mjs` 24 项用真实 Cordis 加载器挂载整棵树并读真实预设注册表**（`professor` 未标 broken、13 个子行全部 active、预设作用域 28 个工具已注册） | ✅ **已验证（含真实激活）** |
| **M4** | 六个 `professor-*` 技能（study/notes/review/research/course-management/latex）：从 SOUL.md / MODES / SYSTEM / notes-manager / course-manager / latex-notes-quality / web-research-evidence / 模板文件提炼；剔除 7 个项目类与 Algorithm Coach 技能；不发布别名（决策与迁移表见 `docs/SKILLS.md`） | M3 | ✅ 79/79 双侧锚点同步校验通过（上游锚点失效即失败）、目录形状强制为 6、排除项确认未随包、契约校验通过 | ✅ |
| **M5** | 项目结构与课程注册：`.professor/project.yaml`（`schema_version: 1`，无依赖的受控 YAML 子集，未知语法/更高版本一律安全失败）；课程注册/列出/解析/更新/归档（归档不删材料）；从 Personal-Agent Registry **只读**导入，容忍真实漂移并回报未映射字段 | M2 | ✅ `professor_project_init`/`professor_course_manage`/`professor_course_list` 三个工具；**17 项**测试（`test/project.test.mjs` 8 + `test/courses.test.mjs` 9）覆盖 schema 版本安全、重复 id、学期/代码歧义、路径校验、导入幂等与非破坏性 | ✅ |
| **M6** | 会话—课程绑定（**偏离 v3 §4.6**，见 `docs/AUDIT.md §3`）：项目侧 `.professor/state/sessions/<session_id>.json`，`course_id/bound_at/reason/history[]`；绑定工具 `professor_session_bind`（bind/unbind/切换）与只读 `professor_session_status`；删除一切跨会话回退（无 `session_projcache`、无环境默认、无其它会话读取）；写入走 `replaceIfVersion` 版本守护 | M5 | ✅ 8 项测试：会话独立（B 不继承 A）、历史 append-only、重放可复现、并发写不静默丢失、无回退、损坏文件报错不重写、无 session id 硬失败、路径穿越拒绝 | ✅ |
| **M7** | 索引与虚拟分类：稳定 `file_id`、增量状态、确定性排序、排除 `.professor/`/隐藏/`node_modules`、逐条 `lstat` 遵守 `follow_symlinks:false`；课程归属与分类只由 `project.yaml` 的已注册源根/`category_rules` 推导，带 `classification_source` + `classification_confidence`，未匹配一律 `unassigned` | M5 | ✅ 8 项分类测试（含穿越拒绝、前缀不误配、最具体规则优先且与注册顺序无关、摘要零桶位、归档后仍归属）+ 端到端 4 文件归属 | ✅ |
| **M8** | 抽取与检索：能力探测型抽取（文本直读；**PDF 经 `ctx.shell` 走 PyMuPDF → Ghostscript txtwrite 双后端**；**Office 经 `ctx.shell` 走打包 Python，逐格式判定**；图片与无文本层 PDF 一律 `unsupported` 且**OCR 关闭**）；标题感知分块（稳定 `chunk_id`、代码块不切开、硬上限）；预算受限检索（`max_chunks`/`max_sources` 硬预算 + 过滤前置 + 确定性排序 + 诊断） | M7 | ✅ **49 项**测试：`test/extract.test.mjs` 9 + `test/extract-e2e.test.mjs` 5 + `test/extract-runtime.test.mjs` 16（argv 单引号引用、候选顺序、探针解析、Ghostscript 结构化标记解析、失败分类）+ `test/extract-production.test.mjs` 19（坐标映射与 `coordinate_ambiguous`、失败词汇、越界路径在任何进程启动前被拒，以及**真实后端集成**：真实 PDF/DOCX/PPTX/XLSX 走完整链路）。**runner 已接线**：复用已有 `ctx.shell`，**未新增预设行**，模型拿不到通用抽取工具；诊断报 `pdf`/`office` 能力块与 `probe` 证据（观测到的路径、版本、被淘汰候选的原因） | ✅ 已验证 |
| **M9** | 溯源：`SourceRef` 四类来源（local/external/user/model-inference）+ 练习题标注（原题/改编题/新编）；只含**已知**字段（未知 page/slide 省略而非猜测）；PDF/PPTX 抽取器产出坐标 → 分块携带 `page`/`slide`（起始行归属，跨页诚实给 `page_range`，越界标 `coordinate_ambiguous`）；冲突**展示不合并**；产物引用块（`资料依据`，区分 external 与 model-inference） | M8 | ✅ **10 项**测试（`test/provenance.test.mjs`：来源/坐标校验、原题约束、格式化标签、页码映射与未知省略、runner 透传、冲突检测、引用块组装、端到端 search→SourceRef）+ 生产路径坐标由真实后端生产并到达产物引用块（e2e 场景 20、22、28：真实 PDF 的 `p.2`、真实 PPTX 的 `slide 2`）。**坐标现在有生产者**；DOCX/XLSX 仍无页码，因为结构读 XML 不渲染版面——这是设计选择，已记入 `notImplemented` | ✅ 已验证 |
| **M10** | 学习状态服务：容忍标题漂移的解析（真实 `**Field:**` 后置 `**`、`##`/`# 1.` 混用、单字符表分隔、`## File Inventory` 挂载点、子区块标题注入）；`entry_id` 合并不重复；`revision` + `replaceIfVersion` 并发拒绝；压缩（重复单元折叠、慢性错误转 resolved、过期深挖清理）；**轻量提问 `evidence: none` 一律拒绝写入** | M6, M9 | ✅ **14 项**测试（`test/state.test.mjs`：字段不泄漏标记、标题漂移容忍、表分隔、**KNOWLEDGE/MISTAKES 结构原样保留**、evidence 门、entry_id 合并、**错误计数递增与深挖去重**、压缩保留历史、字段改写往返、轻量零变更、并发不丢更新、会话不继承、**单元跨读写往返合并**、**schema 与实现一致（不公布不可写的形状）**） | ✅ |
| **M11** | 产物：Markdown/LaTeX 笔记（格式门、写入配置输出根、绝不静默覆盖、溯源、深挖标记）；LaTeX 模板复制与校验 + `latexmk` 编译门与诚实报错；考试复习产物 | M10 | ✅ **42 项**测试（`test/artifacts.test.mjs` 23 + `test/latex.test.mjs` 19）：格式门（`default_format: ask` 每次都问）、输出根安全（拒 `..`/符号链接逃逸/与源根重叠/`.professor/state`）、不静默覆盖（默认 `never`，`versioned` 出 `-vN`，`allow` 需匹配 `expectedVersion`）、笔记与复习内容契约（练习题 原题/改编题/新编 标注）、模板只读且跳过 `latexmkrc`、编译四态判定（`source_generated`/`compiler_unavailable`/`compilation_failed`/`compilation_succeeded`）、PDF 是否「已检查」只认调用方声明 | ✅ 已验证 |
| **M12** | 诊断、迁移、打包、文档：`professor_diagnostics` 补全（索引健康、抽取支持矩阵、未解析路径、状态冲突、迁移失败、provider 健康）；迁移日志；README 全量重写；版本策略与 `private` 决策；干净环境安装测试；**28 个端到端场景**；对照矩阵与差距报告 | 全部 | ✅ `test/migration.test.mjs` 9 项（dry-run 零写入、计划 + 日志落盘、幂等 `no-op`、源摘要随源变、未映射字段聚合与 `only` 过滤、**源树逐字节不变**、缺注册表域错误、诊断迁移状态、手写日志分类）+ `test/regressions.test.mjs` 6 项（初始化前引用回归门 + 课程 id/code 契约）+ `tools/verify-distribution.mjs` **62 项**（`private` + `files` 白名单、无备份产物、无秘密与个人路径、离线安装 tarball、装后自测 205/205、装后 `apply()` 注册 15 工具 + 6 技能、**npm cache 隔离的回归自检**）+ `tools/verify-e2e.mjs` **28 个场景**（后 10 个覆盖生产抽取链路，缺后端时如实 `SKIP` 而不假装通过）+ `tools/verify-syntax.mjs` 81 个文件语法门 + README 重写 + **`docs/PARITY.md`（三列对照：Hermes Professor / v3 目标设计 / 本实现 + 差距的闭合路径 + 安全结论汇总 + 剩余限制）** | ✅ 已验证 |

## 全局验收（Definition of Done）映射

| 要求 | 归属里程碑 |
|---|---|
| 专用 Professor 预设可加载且行为隔离 | M3 |
| 课程可注册与解析 | M5 |
| 会话可独立绑定课程 | M6 |
| 材料可增量索引与检索 | M7/M8 |
| 支持格式经真实能力抽取 | M8 |
| 每条检索片段带可用溯源 | M9 |
| 学习状态可安全读取与选择性更新 | M10 |
| 续学行为由持久状态驱动 | M6/M10 |
| Markdown/LaTeX 产物安全生成 | M11 |
| 考试复习工作流 | M11 |
| 原始材料不变 | M2 起持续断言 |
| 并发写不静默丢失 | M2/M10 |
| 迁移自 Personal-Agent 且有测试 | M5/M12 |
| 干净环境可安装 | M12 |
| README 与包元数据准确 | M12 |
| 校验器无阻断性警告 | M1 |
| 单元/集成/安全/打包/端到端测试通过 | 全程 |
| 对照矩阵与差距报告 | M12（`docs/PARITY.md`） |
