# Professor 插件：项目目标与任务记忆

2026-10-12/13 N2 **第二次授权执行完毕，M1–M7 全部落地**（本条取代下方两条同日条目里「M2/M6/M7 NOT RUN」「0 付费请求」的说法；下方条目保留为当时的中间状态记录）。**第二笔新鲜授权**：AskUserQuestion 答「Authorize 8 more requests (Recommended)」→ `authorization.json`（`budget: 8`、`granted_at 2026-10-12T16:59:36.634Z`、`supersedes` 指向已归档的第一笔 `failed-observations/authorization-grant-1.json`）。**账本改为 `grants[]` 汇总制**：第一笔迁移为 legacy 条目、第二笔追加，`authorized_limit = 两笔之和 = 16`，`attempts[] = 16`，**每条都在请求发出前落盘**，剩余 **0**；并新增 `--only=M2`，避免重复消费已买到的 M1（M1 在第二次运行标 `NOT-INCLUDED`，其证据仍在 `failed-observations/run-1-model-report.json`）。**第二次运行结果**：M2 LaTeX 笔记**已交付** —— `professor_artifact_create` → `main.tex` 1041B(`23f71135e062`) / `content.tex` 6062B(`fa1d2e9eb7fb`) / `professor-metadata.tex` 555B(`5d499bed73d4`)，**三条 `bytes` 与独立读回全部一致**；工具链 `session_status`、`state_read`、`search`×3、`material_read`×3（1 次 `isError` 后成功重试）、`artifact_create`，**8 次请求跑满 8 轮**。**评分（对交付物本体，零成本 `model-regrade.json`）**：**M1 与 M2 均 8/8 PASS** —— M1 13 条引用、M2 25 条引用，两者覆盖页 1–4，四条 direct 断言（D1 `0.75` p1 / D2 `2.94` p2 / D3 `primary clustering` p2 / D4 `UNCERTAINTY` p3）**各自引用到自己那一页**，三类标签齐、无杜撰课程或来源、无无依据断言、不确定性原样传递。**首版判定保留为失败**：M1 原判 `G3/G6` 失败、M2 原判 `G1/G6` 失败，与修正判定**并排**写在同一份 `model-regrade.json`。**M4/M5（两次运行都成立）**：创建不动 `INDEX.md`、`professor_state_update` 返回 `written:false` + `… is read-only here …`（**预期负例=PASS**）、另行 `fs.appendFile` 才登记成功；源树 `added/removed/changed` 全空。**M6 编译：`compilation_succeeded`、`exit_code 0`、`latexmk -xelatex`、`requirement unicode-cjk`、Fandol 字体、`problems []`** —— PDF **130,705 字节**、独立 sha256 **`c6d35760460be3f58f90b7106118895de4ede1d10c5c55b5f63aa34fcafa1810`**（与工具报告字节数一致）。**M7 视觉检查：3/3 页逐页看过**（Claude 读取 1.5× 渲染的 `rendered/page-1..3.png`），**绑定到该 sha256**，并**通过生产工具声明** → `pdf.inspected: true`、`inspected_by: "caller-attestation"`、`inspected_pages: 3`，且**声明用的重编译没有改动字节**（前后 sha256 相同）。**诚实的负面发现（FO-8，未修复、未重跑）**：第 2 页 **Table 1 从未被排版** —— 模型把裸 `\begin{tabular}` 放进了会被渲染器转义的 section body，产物里打印成字面量 `\{}begin{center} \{}begin{tabular}…`、`$n$` 也没变成数学；**编译说成功、文本评分也过，只有看渲染页才看得出来**（`pdf.produced` ≠ 编译 ≠ 视觉成功的教科书案例）。**十项失败观察（FO-1…FO-10）全部先记录后修复**，原证据 `failed-observations/` 里含 `run-1-evidence.json`、`run-1-model-report.json`(`ffa0a9b6…`)、`run-2-model-report.json`(`a235bc23…`)、`authorization-grant-1.json`、`declaration-attempt-1/2.json`；修正写在**独立文件** `model-regrade.json` / `model-m7.json` / `model-m7-declaration.json`，**原判定不被抹掉、模型输出一个字节未改**。其中 FO-5/FO-6 同根：`executeTool` 成功返回 `{isError,content,value}`、失败返回 `{isError,error,content}`，读错层导致「编译成功却报无 PDF、M7 被跳过」。**验证（全 exit 0）**：`npm run verify` → **765 = 764 过 / 0 失败 / 1 跳过**（那 1 个跳过是既有的带日期 OCR 跳过，未重开）。**未变**：六技能、五预设、公共工具契约、用户模板、既有产物、原始 note-delivery / 教学 / latex-cjk 证据、S3/S5、跨平台推迟、Phase6/7 部分证据、Phase8 未关闭；**关闭 N2 不关闭 Phase 6 浏览器矩阵、Phase 7 有序 Mac 发布门、Phase 8 最终审计**。**下一步（若要修 FO-8）**：需**新的、新鲜的**授权与自己的数值预算；否则 FO-8 保持已记录未修复。

2026-10-12 N2 **授权后执行结果（本条更新并取代下方同日条目里「0 付费请求 / 模型半 NOT RUN」的说法；下方条目保留为当时的准备期记录）**。**新鲜且限定本块的人工授权**：AskUserQuestion 答「Authorize ≤8 requests (Recommended)」→ `docs/qa/2026-10-12-source-grounded-notes/authorization.json`（`block: source-grounded-note-delivery`、`budget: 8`、`granted_at 2026-10-12T14:39:42.510Z` ≥ `prepared_at 2026-10-12T13:53:09.944Z`，两个 gate 自检通过）。**执行**：路由只读解析为 `xiaomi-token-plan-cn / mimo-v2.6-flash`，`maxRetries 0`（失败不重试），**`counter.json` 8/8 次尝试逐条在请求发出前落盘**（M1 六轮 14:40:18–14:41:22，M2 两轮 14:41:35–14:41:39），无自动重试。**M1 Markdown 笔记：已交付并全绿** —— `professor_artifact_create` → `.professor/notes/csc3200/csc3200/csc3200.md`、**5649 字节**（工具报告的 bytes 与独立读回一致）、独立 sha256 `b8774f54b380524d1efd613f80de21c744b458c707908e1c13139f424ff1b66f`、`root_source: project-default`、`format_source: explicit-request`（格式确由**本次请求**显式给出）、`problems/warnings` 均空；对**交付物本体**评分 **8/8 PASS**（13 条引用全部指向注册 file_id、覆盖页 1–4 ⊆ 已检索页、D1 `0.75` p1 / D2 `2.94` p2 / D3 `primary clustering` p2 / D4 `UNCERTAINTY` p3 四条直接断言**各自引用到自己那一页**、三类标签齐、无杜撰课程或来源、无无依据断言、不确定性原样传递）。笔记完整复现第 2 页表格数值、逐字保留第 3 页不确定性并拒绝把表 2 当既定事实、把自撰解释标为「推断」。**M2 LaTeX 笔记：BUDGET-EXHAUSTED，未交付**（只跑到 `professor_session_status`/`state_read`/`search` 就耗尽预算，turn INCOMPLETE、无 artifact），因此 **M6 编译与 M7 视觉检查 NOT RUN，不声称 `pdf.produced`**。**M4/M5 已观察**：建前 `INDEX.md` 不存在、建后仍不存在（**创建≠登记**）；`professor_state_update` 对 `INDEX.md` 返回 `written:false` + `… is read-only here: read it with professor_state_read and edit it with the filesystem tools`（**预期负例=PASS**）；另行 fs appendFile 才登记成功（`registration_changed_index:true`）；源树 `added/removed/changed` 全空（**字节不变**），输出树只新增那一个 artifact、无任何既有文件被改。**五个夹具/评分器缺陷：先记录后修复**（`FAILED_OBSERVATIONS.md` FO-1…FO-5，原样证据留在 `failed-observations/`，其中 run-1 model report sha256 `ffa0a9b6…af00ef56`）：FO-3 **评分对象错了**（评的是聊天摘要而不是交付的文件，导致 G3/G6 假失败）、FO-4 **G6 谓词过严**（把按 basename 指称注册来源判为杜撰）、FO-5 **从信封而不是 `.value` 读域字段**（`refused_read_only` 误报 false）+ 案例 `requests_used` 只记最后一轮 + 与工具根本不返回的 `sha256` 做比较。修复后的再评分是**零成本、独立文件** `model-regrade.json`，原判定与修正判定**并排保留**；**模型输出一个字节都没被改过**。**验证（全 exit 0）**：`npm run verify` → **764 = 763 过 / 0 失败 / 1 跳过**（那个跳过是既有的带日期 OCR 跳过，未重开）。**预算状态**：授权 8、已用 8、剩余 **0**，runner 会拒绝继续 —— **停止条件被遵守，没有自行加预算**。**未变**：六技能、五预设、公共工具契约、用户模板、既有产物、原始 note-delivery / 教学 / latex-cjk 证据、S3/S5、跨平台推迟、Phase6/7 部分证据、Phase8 未关闭；**关闭 N2 不关闭 Phase 6 浏览器矩阵、Phase 7 有序 Mac 发布门、Phase 8 最终审计**。**下一步**：若要补 M2→M6→M7，需**新的、新鲜的**授权与**自己的**数值预算（旧授权不结转）；否则 M2/M6/M7 保持 NOT RUN。

2026-10-12 N2 源接地笔记（source-grounded）验收：**零成本半已执行并全绿，模型半 NOT RUN**（**0 付费请求、0 模型调用、0 全局依赖安装、0 真实 profile 写入、未提交 Git**）。新证据目录 `docs/qa/2026-10-12-source-grounded-notes/`（`REPORT.md` / `evidence.json` / `ANSWER_KEY.md` / `FAILED_OBSERVATIONS.md`）。**夹具**：`test/helpers/source-grounded-fixture.mjs` 在运行时按字面量生成 4 页合成 PDF（`CSC3200/01_Lectures/week03-hash-tables.pdf`，4703 字节，不提交二进制），每页页脚印 `Page n of 4`（**物理页源**），第 2 页是**真表格**（列定位 + 画线，4 列 × 4 行），第 3 页是**明确标注的不确定性** `UNCERTAINTY - UNVERIFIED … not independently confirmed`；每页开头 `---`（setext 标题）使索引**按页切块**，于是「引用了未检索的页」是**可判定的失败**而不是不可证伪的说法。答案键四类齐备：direct D1–D4（每条绑定页码 + 锚文本）、inferred I1–I2、supplemental S1、prohibited P1–P5。**登记与索引（只走生产工具）**：`professor_index_sync` → file_id `f_bfc3585aa6b23247`、`content_hash f680d2283c23f55b6b7f35402b38c888930ea07bfa048b10b48983e10c6471f3`（**独立 sha256 复算并比对一致**）、`index_status: indexed`、`course_binding csc3200/CSC3200`（唯一）；`professor_extract` → 4 条分页 excerpt（p1 450 字 / p2 339 / p3 315 / p4 224）；`professor_search` 5 条查询分别命中 p1/p2/p2/p3/p4；`professor_material_read(action:text)` → `coverage.text_complete [1,2,3,4]`、1460 字符、`unread []`。**12 项确定性检查全 PASS**（含源字节前后不变、真实 profile 14718 文件摘要前后一致 `42914099…`、工作区在系统临时目录且不等于 `process.cwd()`）。**本地证据检查先于任何模型请求，且顺序在代码里强制**：`test/source-grounded-notes.test.mjs` **18/18**（含 8 项评分器测试），做过**变异测试**（把某条 direct 断言的页码改掉 / 去掉表格画线 → 立刻变红，还原 → 变绿）；`test/helpers/source-grounded-gate.mjs` 拒绝沉默、别的块的批准、缺失或非数字预算、过期 `granted_at`、检查未绿的证据；`RequestBudget` 按**尝试**计费而非按成功。**两个失败观察先记录后修复**（`FAILED_OBSERVATIONS.md`，原证据原样保留在 `failed-observations/`）：**FO-1** `page-precise-read` 报 `0/4` —— 是**检查读错字段**（`result.pages[]` 是图片数组，正文在 `content.blocks[]`；工具自己的 `coverage` 本就声明 `text_complete [1,2,3,4]`），分类为检查缺陷而非工具缺陷；**FO-2** 第一次 readiness 跑完不退出 —— teardown 调了不存在的 `ctx.dispose()`，改为与 `tools/verify-teaching-model.mjs` 一致的 `ctx.fiber.dispose()` 对 5 秒超时竞速。两次都 **0 付费请求**，都没有「重跑到绿」。**零成本 readiness 已跑通并干净退出（`model-readiness.json`，exit 0）**：profile 安装（`npm pack` + 装进一次性 profile、隔离 npm cache）、boot、`course_setup` 五个生产工具、指令面 persona 2629 字、当前模型路由**只读**解析为 `xiaomi-token-plan-cn / mimo-v2.6-flash`、工作区源 sha256 与 evidence 完全一致。**模型半 NOT RUN**：`authorization.json` 不存在，`run-model.mjs --allow-model-calls` 直接 `NOT RUN: no authorization: silence is never authority for a paid request`、**exit 2**，不写 counter、不启动 profile；教学矩阵 counter（38/31）是**另一个块**的预算，未被当作授权。**编译与视觉检查均 NOT RUN**（没有模型笔记 → 没有 LaTeX 源 → `pdf.produced` 不声称、`pdf.inspected:false`；TeX 只做只读 PATH 探测：latexmk/xelatex/pdflatex/gs/python3 + PyMuPDF 1.28.2）。**验证（全 exit 0）**：`npm run verify` → syntax/skills/sync/dist/e2e + `npm test` **762 = 761 过 / 0 失败 / 1 跳过**（那 1 个跳过是**既有的、带日期的** OCR 跳过，未重开）；本块前基线为 744/743/1。中途 `verify:dist` **真实失败过一次**：`test/` 随包分发而 `docs/` 不随包，测试里 `../docs/qa/…` 的导入在安装副本中解析不到 —— 把纯逻辑移到 `test/helpers/source-grounded-{gate,grading}.mjs` 并改相对导入后修复（无 Git 提交）。**未变**：六技能、五预设、公共工具契约、用户模板、既有产物、原始 note-delivery / 教学 / latex-cjk 证据、S3/S5、跨平台推迟、Phase6/7 部分证据、Phase8 未关闭；**关闭 N2 不关闭 Phase 6 浏览器矩阵、Phase 7 有序 Mac 发布门、Phase 8 最终审计**。**下一步**：需**新鲜**明确授权写入 `authorization.json`（`block: source-grounded-note-delivery`、整数预算、`granted_at` 不早于 `2026-10-12T13:53:09.944Z`），然后跑 M1–M7。

2026-10-12 默认 LaTeX 交付缺陷修复（**0 付费请求、0 模型调用、0 依赖安装、0 真实 profile 写入、未提交 Git**）。**先复现后改码**：`docs/qa/2026-10-12-latex-cjk-fix/reproduce.mjs` 在任何产品改动之前跑出——英文 title+summary 的普通笔记，`renderContentTex` 照样生成 `\section*{概述}`/`材料范围`/`重要术语`/`易错点`/`自测问题`/`练习`，旧 wrapper 是 `article`+`inputenc`+`fontenc`，命令 `latexmk -pdf …`，**`compilation_failed`、exit 12、无 PDF**、`LaTeX Error: Unicode character 概 (U+6982)`；该失败原样留在 `evidence-repro.json`，分类为**产品缺陷**（不是预期负例，如实报告也不等于通过）。**修法（引擎/驱动/字体一起选）**：`src/artifacts/latex.js#renderMainTex` 现在带 `% dsh-professor-requirement: unicode-cjk`、`iftex`+`\RequireXeTeX`、`fontspec`、`xeCJK`，CJK 字体用 **TeX 发行版自带的 Fandol**（FandolSong/Hei/Fang/Kai，`kpsewhich` 核实；**不写死 macOS 字体名、不新增 `resources/` 文件、不需下载**），并从该 wrapper 移除 `inputenc`/`fontenc`（文档类仍是 `article`）。`src/latex/capabilities.js` 新增 `REQUIREMENT_ANY`/`REQUIREMENT_UNICODE_CJK`、`detectRequirement()`、`probeCjkFonts()`、`probeLatexRequirement()`：unicode-cjk 要求 **XeLaTeX 且有 CJK 字体**，缺任一 → `compiler_unavailable` 并点名原因，**绝不静默退回 pdfTeX**；`commandForEngine` 增加可选 `flavor` → `latexmk -xelatex`，不传则保持原 `latexmk -pdf` 逐字不变（`probeLatex`/`summarizeLatex` 未动）。`src/latex/compile.js` 透传 `flavor` 并在 `warnings` 里记录所依赖能力；`src/tools/latex.js` 经网关分类 `main.tex`、用 `probeFor(requirement)` 解析探测，并把 `requirement`/`flavor`/`cjk_fonts` 放进**既有 `compiler` 对象**——**工具 name/parameters/output schema 未变**。**用户模板保持原状**：只有插件自己生成的 wrapper 声明要求，用户 `main.tex` 不声明 → 仍是 `latexmk -pdf`；wrapper 生成后不覆盖，所以**改动前生成的旧产物仍按旧行为编译、不会被静默改写**。**回归（先 RED 后 GREEN，7 项，`test/latex.test.mjs` 26/26）**：wrapper 契约（含要求标记/xeCJK/fontspec/Fandol/**无** OS 字体名/**无** inputenc/`\RequireXeTeX`）、英文内容也会生成中文标题、用户模板不被重分类、**命令选择**（`flavor:'xelatex'`→`-xelatex`，无 flavor→`-pdf` 与原命令逐字一致、shell-escape 选项不变）、要求探测拒绝把 CJK 交给 pdfTeX（只有 latexmk/缺字体/通用探测不变）、工具用 `-xelatex` 驱动生成默认文档、能力不满足时 `compiler_unavailable` 且**零命令执行**。**零成本生产工具集成检查（一次性工作区、真实 fs 网关、真实 `/bin/sh` 接缝）**：英文笔记、中文笔记、4 页中英混排笔记全部 `created:true` + `compilation_succeeded`，PDF 分别 **36832 / 77697 / 115921 字节**（sha256 `d5254239…`/`6f0152f9…`/`3cf38641…`），三份都含 `main.tex`+`content.tex`+`professor-metadata.tex`；每个再建同名都被 `overwrite_policy: never` 拒绝且 `source_files_unchanged_after_clash: true`；用户模板 `detectRequirement==='any'`、**驱动仍为 `-pdf`**、ASCII 正文编译通过（43708 字节，`38b45332…`），其 +中文正文的 `compilation_failed` 如实记为**调用方模板的既有行为**（不为凑绿而改用户模板）；能力缺失返回 `compiler_unavailable`/`blocked_by:no-compiler`/`attempted:false`/零命令；wrapper 契约项通过。**视觉验收**：**逐页**看图检查混排 1–4、中文 1–2、英文 1–2 共 **8 页**（字形无缺字/标题/表格/列表/公式/换行/无裁切无重叠/页码），并**绑定到被检 PDF 的 sha256**——声明阶段重新编译后 `hash_identical: true`、`rewritten: false`（latexmk 报 up to date，未写文件），故声明的产物**就是**被检产物（不是只比字节数）。公式：`formulas` 字段**确实被排成数学**（三份都验过）；正文里写 `$…$`/`\…` **按设计被转义**（`escapeLatex` 防止正文里的 `$`/`_` 变成宏），产物源文件**未被改写**去凑绿。**验收报告口径更正**：编译失败的产品缺陷=**产品失败**，只能当证据、**不能计入交付通过**；预期负例仅限格式门/覆盖/路径/INDEX 只读；**`halted:false` 与 `observed` 都不是全过**——旧的 `note-delivery/REPORT.md` 保持不可变，其 N10 `OBSERVED` + `halted:false` **不构成完整交付验收**。**环境表述更正（执行时重新核对）**：增强运行时**确实存在且可原样复用、无需新安装**——`/tmp/professor-auto-prepare/env-e270c763ff8847c4562c/bin/python`（Py3.12、`docling-slim 2.137.0`、`rapidocr 3.10.0`、`pymupdf 1.28.2`、`pypdfium2 5.14.0`），模型 `…/models`，`state.json` 版本 `e270c763ff8847c4562c`；设 `DSH_PROFESSOR_ENHANCE_PYTHON`/`_BACKEND=pdfium`/`_ARTIFACTS` 且**保持 `DSH_PROFESSOR_PYTHON` 未设置**后，生产 OCR 测试 **1/1 通过、零跳过**。早先 `no prepared enhancement runtime configured` 的跳过是**某次未配置该运行时的运行**的带日期记录，保留原样、单独记账；**变量未设置或工作区无缓存只说明本次运行器没配置它，不等于机器上没有运行时**（README / `docs/v1/STATUS.md` / note-delivery 文档均已按此改写）。**文档**：`skills/professor-latex/SKILL.md` 编译门改为「先分类再选驱动」；`README.md` 工具行/编译命令/设计选择各加一条；`THIRD_PARTY_LICENSES.md` 新增「LaTeX typesetting runtime (Unicode/CJK)」节（Fandol=OFL-1.1、fontspec/xeCJK 等=LPPL，**均不随包再分发**，仅由 TeX 发行版在编译期解析）；无新增 skill、无新增 `resources/` 文件、分发检查无需改动。**验证（全部 exit 0）**：`npm run verify` → syntax **177** 文件、skills **39**、sync **89**、dist **70**、e2e **28/28**、`npm test` **744 = 744 过 / 0 失败 / 0 跳过**（含生产 OCR 测试）；`test/latex.test.mjs` **26/26**；评分 28/28、artifacts 24/24 未变；`git diff --check` 干净、0 staged。**未变**：六技能、五预设、公共工具名/参数/输出 schema、用户模板、既有产物、原始 note-delivery 与教学证据、S3/S5 仍 OPEN、跨平台仍推迟、Phase6/7 部分有证据、Phase8 未关闭、**不声称完整发布就绪**；**N2 仍 NOT RUN**（需新的明确授权 + 数值预算）。

2026-10-12 note-delivery 零成本验收执行（**0 付费请求、0 模型调用、0 依赖安装、0 真实 profile 写入、无 Git 操作**；执行器 `docs/qa/2026-10-12-note-delivery/run-zero-cost.mjs`，一次性工作区、真实 fs 网关、真实 `/bin/sh` shell 接缝、只走生产工具；结果 `note-delivery/REPORT.md` + `evidence.json`）。**先更正了执行说明**（`MATRIX.md` / `NEXT_BLOCK_PROMPT.md`）：(1) **预期负例 vs 停止条件**分列——N3 缺格式（跑两轮，返回结构化提问、`created:false`、零写入）、N4 五个非法目标、N6 `INDEX.md` 只读、N7 `overwrite_policy: never` 拒绝、N10 真实编译失败，**各自都是该例的 PASS 且绝不中断整块**；只有预算耗尽、正例意外失败、意外文件系统变更、真实 profile 变更才停止。(2) **按工具真实字段记录** `professor_latex_compile`：`verdict/attempted/blocked_by/engine/compiler/command/exit_code/timed_out/stdout/stderr/pdf/static/projectRoot/directory/main_file/summary/warnings/problems`——**没有 `backend`、没有顶层 `pdf_produced`**（`pdf.produced/path/bytes/inspected` 在 `pdf` 内）；任何归一化视图标 `derived` 并保留原始结果；哈希/stat 独立计算并标注来源。(3) **环境表述按实测改写**：本机**没有**已制备的哈希锁定 OCR 运行时（env 未设、无 `.professor-cache/enhance`、系统 Python 无 docling/rapidocr），**但已制备的运行时可原样复用、无需新安装**；`material-enhance-production` 的跳过归属**另一 shell 的带日期历史运行**，不再是当前项目限制。**执行结果**：PASS = N1（确定性部分）、N3×2、N4（5 非法拒绝 + 嵌套 `04_My-Notes/AI-Notes` + 项目默认 `.professor/notes`）、N5、N6（创建不动 INDEX、`state_update` 拒绝、独立编辑才登记）、N7（源字节不变、同名拒绝且字节保留）、N8、N9、N11（逐页看图后才声明）；**N10 两个诚实结论**——ASCII 版 `compilation_succeeded`（exit 0，`pdf.produced:true`，48639 字节，`sha256 d3bfd08c…`），含中文标题版 `compilation_failed`（exit 12，`LaTeX Error: Unicode character 概`：默认 `article`+`inputenc` 无 CJK 支持，而渲染器会输出「概述」等中文章节名）——如实记录、未重跑凑绿、**未改产品行为**。**N2 NOT RUN**（模型驱动），**无端到端模型验收**。**新鲜验证（全 exit 0）**：评分 28/28、artifacts 夹具 24/24、`npm run verify`（syntax 177 / skills 39 / sync 89 / dist 70 / e2e 28 / tests 737=736 过 0 失败 1 跳过、0 FAIL）、`verify:teaching-aggregate` 不变（`inputs_unchanged:true`、6/2、`all_passed:false`）、`git diff --check` 干净、0 staged、HEAD 仍 `b8850eb`。**保留限制未变**：S3/S5 仍 OPEN（不重开）、跨平台仍推迟、Phase6/7 部分有证据、Phase8 未关闭、归档≠永久删除。**下一步**：N2 需新的明确授权+数值预算；中文 LaTeX 编译需产品决定（CJK 引擎/导言或模板要求）；多页与中文 PDF 版面复检；Phase6 浏览器矩阵 → Phase7 完整发布序列 → Phase8 审计。

2026-10-12 第三轮离线更正（**0 付费请求、0 真实 profile 改动、未提交 Git**）：**A. 裁定证据绑定收紧**——`aggregateRuns()` 现在要求裁定引用的 run 里**确实存在该 case 的已执行观测**：`caseId` 未知、`runId` 未知、**该 case 不在所引 run 中**（`case absent from cited run`）、**所引观测是占位**（`cited observation was not executed`）、`basis` 缺失、状态本身是占位——任一命中即进 `rejected_adjudications` 且不生效。有效裁定逐条绑定到**它自己的那条观测**：只有**最新已执行观测**上的裁定才决定 `effective_status`（`slot.adjudication`）；较早观测上的裁定移入 `slot.historical_adjudications` 作为证据保留，**绝不**覆盖更新的结果（包括更新的 `FAILED`），且输入数组顺序不影响结果——不是 last-entry-wins。自动状态、`prior_failures`、拒绝原因、清单完整性判定、以及「范围结案 ≠ 全数通过」的区分全部保持不变。**B. 离线重建 + 前后哈希**：`report-run1/2/3.json`、`report.json`、`adjudications.json` 五个输入 sha256 **前后完全一致**，工具自带的输入哈希校验通过，未为通过新校验而改动任何旧证据。**结果：零变化**——8 条 case 行逐字段相同，标量相同（`counts.passed: 6`、`counts.open: 2` = S3/S5、`all_passed: false`、`automated.all_passed: false`、`decision: "Accept and close"` + `is_acceptance_of_full_pass: false`、`rejected_adjudications: []`）。即**仍为 6/8 通过、S3/S5 OPEN**，只是现在经受了更严的证据校验。**C. 矩阵 N4 更正**：原 N4 写「输出根不得位于任何已注册源根之内」，与 `src/artifacts/paths.js` 矛盾——契约明确允许**位于源根之内但显式命名了安全产物子目录**（`04_My-Notes/AI-Notes`）的配置根。已按现有契约改写：允许的 = 配置的 notes 根 / 选定课程自身源树内经校验的产物子目录 / 未配置时的项目自有 `.professor/notes` 回退；拒绝的 = 等于源根、包含源根、位于**别的课程**源树内、`.professor/state` 内、含 `..`；规范路径与写策略检查照旧；**绝不回退到进程工作目录**。**未改动任何产品行为**去迁就文本。N6 也按真实契约对齐：`professor_state_update` 对 `INDEX.md` 返回 read-only，登记必须是独立的文件系统步骤。**D. 夹具覆盖**：`test/artifacts.test.mjs` 原已覆盖有效嵌套课程根、项目默认根与四类非法目标；新增第五项「位于另一课程源树内的目标被拒绝」（同时断言同一根对拥有它的课程是合法的）。**E. 授权措辞放宽为诚实表述**：任何**明确指名本块并写清请求上限**的人类授权都有效，**不要求特定字面句子**；付费授权与零成本本地验证严格分开。**新鲜验证（全部 exit 0）**：`npm run verify` → syntax 177 文件、skills 39、sync 89、dist 70、e2e 28/28、`npm test` **737（736 过 / 0 失败 / 1 跳过）**；评分回归套件 **28/28**（本轮新增 4 项，先 RED 后 GREEN）；`git diff --check` 干净、0 staged。**唯一跳过的具体事实**：`test/material-enhance-production.test.mjs` 的「real enhancement recovers scanned text and borderless table cells…」，原因 **`no prepared enhancement runtime configured`**——`DSH_PROFESSOR_ENHANCE_PYTHON` 未设置，且任何 workspace 的 `.professor-cache/enhance` 下都没有哈希锁定的增强运行时（仓库里只有 `resources/enhance` 的清单与 lock）。制备它需要下载包与模型，本轮**未制备**，因此**生产 OCR 在本轮未被执行**，736 项通过不覆盖它。**不声称**：真实笔记交付与渲染 PDF 验收**尚未进行**；note-delivery 块仍未执行，需单独授权与预算。

2026-10-12 离线聚合修复 + 文档对齐 + 下一块准备（**0 付费调用、0 Git 操作、0 真实 profile 改动**）：**aggregateRuns() 修复**——`NOT-INCLUDED`/`UNEXECUTED` 占位只进 `history`（`executed:false`），不再当观测：不能变 `final_status`、不能进 `prior_failures`；过滤重跑因此保留各例**最近一次真实执行**结果**且**保留完整历史（S7/S8 恢复 run3 的 PASSED，run1 的 FAILED 仍在 `prior_failures`）。完整性改按 `EXPECTED_CASE_IDS`（8 例，`tools/teaching-model-matrix.mjs`，runner 与离线重建共用）判定：缺失/未执行/OPEN/INCOMPLETE 一律阻断 `all_passed`，未给清单时**永不**宣称全过。人工裁定必须绑定已知 `runId` + 书面 `basis`，否则进 `rejected_adjudications` 不生效；`automated`（筛查）与 `adjudication`（人工）并列保存、互不覆盖；`decision.is_acceptance_of_full_pass` 定义为 `all_passed`，「Accept and close」不会被读成八例全通过。**重建结果**（`npm run verify:teaching-aggregate`，离线，输入 sha256 前后比对、改动即拒写）：清单 8/8 完整、`counts.passed: 6`、`counts.open: 2`（S3/S5）、`all_passed: false`、`automated.all_passed: false`（S2 筛查 FAILED 保留，人工裁定 PASSED 并记录其两处误报依据）、`decision: Accept and close` + `is_acceptance_of_full_pass: false`、`inputs_unchanged: true`。新增 `tools/rebuild-teaching-aggregate.mjs`（npm script `verify:teaching-aggregate`，`--gate` 未全过则 exit 1）与 `docs/qa/2026-10-12-teaching-interaction/live-model/adjudications.json`（8 条裁定各绑定 run + basis + 来源）。**回归**：`test/teaching-model-grading.test.mjs` 新增 9 项（占位不覆盖已执行结果、占位不入 prior_failures、未执行必检例阻断全过、子集通过而清单不全不得全过、无清单不全过、OPEN/INCOMPLETE 阻断、人工裁定不抹自动失败、无据裁定被拒、结案与全过分列）+ 2 项守卫（占位识别、runner caseDefs 与清单一致），该文件 **24/24**；先 RED 9 失败后 GREEN。**现场核对清单**：**22 个 `professor_*` 工具 / 6 技能 / 5 教学预设**，由 `src/tools/*_TOOL_NAME` 点数并经 `verify:host`（registered===22）、`verify:dist`（fake.tools===22）、`verify:e2e`（names===22）三处独立断言一致；**修正三个验收器的过期期望清单（18/18/21 → 22）**，并在 `verify:activation` 增加「可见 `professor_*` 集合**恰好**等于期望清单」断言（缺一多一都失败）。**新鲜全量**（全部 exit 0）：`npm test` **732（731 过 / 0 失败 / 1 预先存在环境跳过** `no prepared enhancement runtime configured`**）**、`verify:e2e` 28/28、`verify:syntax` 177 文件、`verify:skills` 39、`verify:sync` 89、`verify:dist` 70、`verify:host` 65、`verify:harness` **266 检查 0 FAIL**、`verify:activation` 28、`verify:desktop` 24、`verify:packaged` 94、`verify:native-session` 47。**两处如实记录**：(a) 本轮一次误用 `import('./tools/verify-*.mjs')` 顺带执行了四个验证器，其中 `verify:packaged`/`verify:native-session` 因**未跟踪残留目录** `docs/qa/2026-10-10-material-reading-teaching/harness/.work/` 内 **1210 个 mode 000 文件**报 `EACCES` 而失败——属既有环境问题、非断言失败；已 `chmod u+rw` 恢复读取（**字节未变、无跟踪文件被改**），两门随后 ALL PASS。(b) 唯一跳过即上述增强运行时未制备（本 shell），与 2026-10-11「零跳过」记录的差别只在运行时是否已制备。**OCR 表述更正**：Mac **PDF OCR/增强已实现但只在读取路径**（`professor_material_read` 的 `enhance` → 随包 `enhance_pdf.py`，sha256 锁定模型、进程内禁网、哈希锁定 workspace 运行时自动制备）；**索引抽取 `professor_extract` 仍不 OCR**，扫描件/纯图片 `unsupported`、`capabilities.pdf.ocr` 恒 false；独立图片 OCR 与 Windows/Linux 宿主增强验收未完成（`professor_diagnostics.notImplemented` 三条如实列出）。**文档**：README 当前概览与工具/技能/预设/OCR 表述全部改为现场核对值（21/18/15 → 22、398/435/278 → 732 等）；`docs/v1/STATUS.md` 追加 2026-10-12 现状并将 Phase 6/7 记为**部分有证据、未整体完成**、Phase 8 与 Mac 发布就绪**保持未关闭**；`docs/v1/PHASE6.md` 追加同日条目；`docs/qa/2026-10-12-project-status/STATUS.md` 记录聚合修复与新验证。**历史条目一律未改写**。**保留边界**：跨平台按 2026-10-11 决定推迟；宿主 API 限制——**归档 ≠ 永久删除**；历史 `permissionRules/decision` 回放仍是旧未解项；S3/S5 保持 OPEN 不重开；本轮 0 付费调用、未提交 Git、未发布。**下一块已备未执行**：`docs/qa/2026-10-12-note-delivery/{MATRIX.md,NEXT_BLOCK_PROMPT.md}`（N1–N11：选定课程/来源、来源可溯内容、**本次**显式格式、实际输出根、创建成功、**INDEX 独立登记**、既有产物保全、诚实 Markdown/LaTeX 判定、仅在调用时观测到 TeX 才谈编译、仅在真的做了才声明视觉校验）。TeX/`gs`/PyMuPDF 仅做 PATH **只读**探测：本机均存在（`/Library/TeX/texbin`、`/usr/local/bin/gs`、PyMuPDF 1.28.2）——可用性探测 ≠ 通过检查。**执行需单独明确授权并写明请求上限**；本块准备消耗 0 请求。

2026-10-12 阶段结案（用户决定「Accept and close」，不再追加付费请求）：教学交互 live-model 验收最终记录为 **6/8 通过**（S1 预解析夹具范围、S4、S6、S7、S8、S2），**S3/S5 保持 OPEN**（窄缺口：S3 邻值校验缺失+计数未取整；S5 一处归因与代码矛盾+反例未标定义域）——不得宣称全数行为验收。权威记录：live-model/CORRECTED-ASSESSMENT.md（更正评估）、RETEST-RESULTS.md（复测与结案）、MATRIX-v2.md、INDEPENDENT-REVIEW.md；原始 run 报告/反本/counter 不可变。累计 31/38 付费请求（五次显式批准）。若未来重开 S3/S5，需新的明确批准。

2026-10-12 终轮微复测（第五次批准 ≤4 实用 3，counter 31/38，记录于 live-model/RETEST-RESULTS.md）：**S2 通过**（范围表「明确不列入」DP 与 3 份样卷历史分列、建议标注「建议，非官方」、唯一「必考」是否定用法「更不能说"必考"」——screener 两处误报（否定用语、章节枚举替代 1–4 区间）已分别记录并修复）；**S3、S5 窄缺口保持 OPEN**（S3：口径已定义、log₂n+1 在 n=8 验证且表格走到 n=1 端点，但未展示邻值校验且计数未取整；S5：反例真不终止、收敛侧有 n≥1 定义域语言，但一处归因与代码矛盾（「n 永不减小」旁为 n-1）且反例未标起始值/定义域）。阶段状态：S1（预解析夹具范围）、S4、S6、S7、S8、S2 通过；S3/S5 窄缺口未闭合。离线回归13/13（含否定用语与必考型用例）；全量 721（720 过 0 失败 1 预先存在跳过）。任何进一步复测需新的明确批准（建议 ≤3 请求仅 S3/S5，或用户接受窄缺口结案）。0 未授权付费调用；未提交 Git。

2026-10-12 复测执行（live-model/RETEST-RESULTS.md，第四次明确批准 ≤12 实用 6，counter 28/34）：**S7、S8 全过**（真实写入 written:true+unit+read-back 确认、完整轮次、S7 记录措辞已是「提示辅助完成（hint-assisted）；独立能力尚未验证」）；**S3、S5 部分达标保持 OPEN**（S3 原⌈log₂ n⌉矛盾已修、口径已定义，但未按要求展示 n=1/2 幂/邻值校验且精确次数仍含糊；S5 假不可达例已换为真不终止例（正起点），但未声明起始值/输入域——n<0 实际会终止）；**S2 仍 FAILED**（建议已标注「建议，非官方」、无据得分断言已消除，但「在范围内必考型基础」仍属无据频率断言）。已按最小修正补充指令（「必考型」计入频率断言、精确计数须展示校验、不终止声明须标定义域），本地 721 测试 720 过 0 失败 1 预先存在跳过。aggregate-assessment.json 记录跨 run 聚合（早期失败保留）。下一步：≤4 付费请求复测 S2/S3/S5（counter 34→38），须新的明确批准。0 未授权付费调用；未提交 Git。

2026-10-12 【更正，覆盖下方两条「live-model 验收完成/8 通过」记录】独立复审（live-model/INDEPENDENT-REVIEW.md）判定 NOT ACCEPTED：我此前的「8/8 通过」结论不成立。已写 live-model/CORRECTED-ASSESSMENT.md（独立命名、原 run 报告/反本/counter 不改动）——按四维（交互形态/教学正确性/领域操作/完整轮次）重判：S1（仅预解析夹具范围）、S4、S6 通过；S2（「单位时间得分稳定」「最容易因边界条件丢分」无据断言）、S3（⌈log₂ n⌉ 精确次数与自身 n=8→4 矛盾且未定义口径）、S5（f(0)→f(n+1) 基例 n==10 可达却称「取不到」）教学错误；S7 领域失败（kind:unit 缺 unit → written:false+problems，isError:false 假成功；「经两级提示后独立完成代码」违禁；轮次止于工具调用）；S8 written:true 但轮次不完整。runner 修复：tools/teaching-model-grading.mjs（13 项离线回归 RED→GREEN：isError:false 假成功/缺 unit/未完轮次/独立完成矛盾/过滤聚合/失败退出码）+ 运行器接线（written:true+read-back 必验、全量结果留存仅脱敏、INCOMPLETE 语义、report-runN 轮转、aggregate-assessment.json、过滤重跑不灭旧败、非全过即 exit 1、S2 无据断言检查、S3 精确口径检查、S5 假不可达检查、affirmative「提示后独立完成」检测含否定豁免）。教学指令一般化加固：例题先验证（声明输入域/起始值、递归全路径+进展度量、精确计数先定义口径再对 n=1/2 幂/邻值校验）、辅助记录固定措辞「提示辅助完成（hint-assisted）；独立能力尚未验证」、kind:unit 必带 unit 字段（title 不替代）、复习建议与证据结论分离（不无据断言得分效率/丢分率/频率）。本地复验：721 测试 720 过 0 失败 1 预先存在跳过、verify:skills/sync/dist 全 ALL PASS。MATRIX-v2.md 增补内容正确性标准；RETEST-PLAN.md 已备（S2/S3/S5/S7/S8、≤12 请求、**未执行**）。**0 新付费调用**；counter 保持 20/22 历史；复测须用户新的明确批准（不得从 counter 或提示推定授权）。未提交 Git。

2026-10-12 live-model 教学验收完成（报告：docs/qa/2026-10-12-teaching-interaction/live-model/EXECUTION-REPORT.md）：S1/S2 经两次夹具修正后于第 4 轮观测通过——模型完整产出评审正文：S1 明确证据边界（不推测「常考」、四类标注、缺卷不阻塞）；S2 严格分离「材料 A 已确认范围（第 5 章明确不考）」与「仅 3 份样卷的历史频率（不足以断定普遍规律）」，DP 冲突以公告为准、不泛化。**最终 8/8 用例均已观测且合 MATRIX 标准**（S7 措辞瑕疵与 S2 screener 误报均如实记录于报告；S2 误报源于正则不识「明确不考」同义表述，screener 已改）。三次显式授权合计 22 付费上限、实用 20（2 未用），0 重试，凭据仅内存，真实 profile 零改动。附带观察：模型按技能规定逐工具单轮收集上下文，工具循环预算须 ≥5 或预解析上下文。局限：单模型单次观测非统计保证；跨平台仍推迟。可选后续：S7 措辞微调、重复抽样（需另批预算）。未提交 Git。

2026-10-12 live-model 教学验收执行（报告：docs/qa/2026-10-12-teaching-interaction/live-model/EXECUTION-REPORT.md）：用户经 AskUserQuestion 明确批准 ≤12 付费请求后执行 `npm run verify:teaching-model -- --allow-model-calls`（route mimo-v2.6-flash，retryPolicy maxRetries 0，counter 12/12 恰好用尽，凭据仅内存）。**观测结果 6/8 用例合 MATRIX 标准**：S3 完整讲解（2208 字符、检查在其后）、S4 只要提示（78 字符单提示无答案）、S5 拒绝检查后续讲（无测验门）、S6「我懂了」被明确记为自述 weak 且不写状态、S7 提示辅助（evidence weak+两级提示+剩余缺口+标注 hint-assisted；措辞瑕疵「经两级提示后独立完成代码」记录在案）、S8 独立变式（evidence strong 明确限于本次任务、status learning 未标完成、接受等价两段二分法）。S1/S2 **UNRESOLVED**：两次付费尝试都因夹具未提供技能规定必用的只读工具（session/course/state）而成不完整轮次（工具尝试混入文本、无评审正文）——按规则不算通过；根因是夹具非教学行为。诚实更正两处 screener 误报（S7 子串误判、S8 仅看文本）。运行器修正：readonly 工具循环（S1/S2 预算≤3）、--only、报告留存 report-run1.json；修正后 node --check+708 测试不变。**剩余预算 0**——S1/S2 复测需另行批准 ≤6 付费请求（命令已备好）。未提交 Git；真实 profile 零改动。

2026-10-12 live-model 教学验收准备（报告：docs/qa/2026-10-12-teaching-interaction/live-model/PREP-REPORT.md）：按 NEXT_STEP_PROMPT 完成付费调用前的全部准备——`live-model/MATRIX.md`（8 用例+PASS/FAIL 标准+预算分配 11/12）、`TRANSCRIPTS.md`（精确学员发言+SCRIPTED 前缀夹具）、`materials/`（合成讲义/考试公告/3 份往年卷摘要）、`counter.json`（`authorization:"PENDING"`、`requests_used:0`、跨重启持久、先计费前自增）、以及门禁运行器 `tools/verify-teaching-model.mjs`（+npm script `verify:teaching-model`，须 harness asar-aware Node；`--allow-model-calls` 且 counter 为 approved 才可付费；retryPolicy maxRetries 0；凭据仅内存注入、报告脱敏；一次性 profile+tarball 安装插件；真实工具 setup）。dry-run（0 付费请求）exit 0：route 只读解析 xiaomi-token-plan-cn/mimo-v2.6-flash（text+image）、`professor_project_init`+`professor_course_manage`（SYN101 注册）真实成功、8 用例 surface 全捕获（composed professor-study sha256 随学习预设各异 + professor-review 供 S1-2）、cases 全 UNEXECUTED。修复两处仅 runner 缺陷：`readness`→`readiness` 拼写、macOS 临时目录 /var vs /private/var（realpath 临时基目录）。本地验证：verify:syntax 173 文件、npm test 708（707 过 0 失败 1 预先存在跳过）、verify:dist ALL PASS。**0 付费模型调用**——六次旧授权已用尽，本轮按「沉默不视为批准」停在授权前；8 用例观测行为 UNEXECUTED，不可称行为验收。下一步：用户明确批准（建议 ≤12 付费请求上限，可能产生费用）后执行 `npm run verify:teaching-model -- --allow-model-calls`。未提交 Git；未动真实 profile。

2026-10-12 P2 修复（承接 docs/qa/2026-10-12-teaching-interaction/REVIEW.md）：`builtin-exam-review` 预设原先无条件要求「先给出高频考点清单」，与 professor-review 的证据纪律矛盾。已替换为证据感知复习规划：先由讲义/大纲/老师强调/往年卷确认考试范围，复习优先级=已确认范围+课程反复出现的基础+个人薄弱；仅证据支持才称「常考」且注明证据范围（少量样卷≠普遍频率）；四类标注（已确认范围/老师强调、反复基础≠考试频率、个人练习重点、待确认相关性）；无考试证据时简短说明后直接概念型复习，不杜撰侧重/频率/分值/预测，不因缺往年卷阻塞，仅实质影响时才要材料；保留可跳过诊断、首缺口反馈、接受替代解法。验证（静态指令检查，非模型行为）：新增 4 项 composed-surface 检查先 RED 后 GREEN（teaching-interaction 共 23/23），定向 60/60，全量 708 项 707 过 0 失败 1 预先存在跳过，verify:skills/sync/dist 全 ALL PASS，打包 presets.js 与工作区逐字一致（证据子句在、缺陷短语 0 处）。未动用户偏好/已应用快设快照/工具接口/UI；0 付费调用；模型行为验收 UNVERIFIED——报告 §7 已备好 ≤12 轮的 live-model 验收提示词（5 组用例+停止条件），待单独授权。未提交 Git。

2026-10-12 教学交互改进（报告：docs/qa/2026-10-12-teaching-interaction/REPORT.md，设计：docs/qa/2026-10-11-teaching-design/RESEARCH.md）：按批准设计更新 `professor-study` 与四个教学预设（循序讲解/引导思考/考前复习/编程实践；快速答疑已符合故未改），并调和 skill/预设/compose 三层矛盾——新增「Respect the current request」（完整讲解/递进教学/理解检查/只要提示；显式要求覆盖保存节奏与引导偏好；正文先于可选练习）、「Incremental teaching」（直觉+例子→定义/假设/关键推理、从已有作答出发、只问实质影响下一步的信息、快速提问免仪式）、「Graduated assistance」（概念提示→局部步骤→部分演示→完整讲解四级；每提示一步；重复受挫升级不重复无效问题；缺前置直接补讲；禁固定轮数/计时；服从切换/停止）、「Understanding checks」（自己的话/小变式/边界情形；可跳过；禁例行「理解了吗」；作答前不揭晓）、「Feedback on attempts」（先肯定有效部分→首个实质缺口+具体下一步；接受替代正确解法；概念/记号/步骤/前置四类区分；例题先验证）、「State updates」证据三分类（自述=weak、有帮助完成=weak 注明协助、独立完成=strong；一次独立正确≠单元掌握；covered vs demonstrated；协助记入既有字段）；socratic 删除「始终在最后确认」强制仪式（保留「直接告诉我」直讲切换）。`composeSkill` turn_scope 保留 1–6 逐字（既有测试钉住）新增 7–8（hint-only/检查/切换停止即时服从；帮助向前升级）。`professor_state_update` 仅改 evidence 描述串（枚举/参数/输出不变）。**来源合规**：四个参考仓库（MIT×2、Apache-2.0、CC BY-SA 4.0）只取思路未复制/改编任何原文，全部措辞保持 `original:professor-v1`；THIRD_PARTY_LICENSES.md 新增研究来源与「若改编表达须先固定 commit+署名+CC BY-SA 同步共享」条款；skill-sources.json 记录 divergences，双侧锚点未动。**验证（本轮新鲜）**：新增 `test/teaching-interaction.test.mjs` 19 项静态指令覆盖（先 RED 18 失败→实现→GREEN 19/19）；`npm test` 704 项 703 过 0 失败 1 预先存在跳过（enhancement runtime 未配置）；verify:syntax 172 文件、verify:skills、verify:sync、verify:e2e 28/28、verify:dist（含安装副本 6 技能/5 预设/许可证声明断言）全 ALL PASS。**边界**：未改工具参数/架构/UI/六技能五预设数量；0 次付费模型调用（六次授权已用尽）——**模型教学行为验收 UNVERIFIED**，需另行授权；跨平台测试仍按 2026-10-11 决定推迟；未提交 Git。

2026-10-11 接手材料读取：完成独立文件、正文 text 动作与字符续读、完整计划缓存后按范围读取、正文全局缓存上限、扫描页真实页数保留、图片/矢量图视觉候选、路径选择保持课程归属、Windows PowerShell 引用与 Python 路径候选，并将 professor-study 接入读取→教学。最终 npm run verify exit0（641/641，E2E28/28，离线打包自测通过）、verify:host ALL PASS；真实 PDF/JPEG 后端测试执行。未提交/推送/真实安装；OCR/增强环境自动制备、六平台真机和真实模型验收仍未完成。详见 docs/qa/2026-10-11-material-reading-takeover/REPORT.md。

2026-10-10 材料读取验收复检（报告：docs/qa/2026-10-10-teaching-runtime-repair/REPORT.md §12）：修复四项验收发现。A **累计预算原子化**——`ledger.reserve/release/settle/capacity` 在同一非 await 步骤内检查并占用容量，选择循环按累计计数推进（原缺陷：4 已用/限 6 仍可再选 4 张、事后记账 8/6）；渲染 `maxTotalBytes` 改用 调用/轮次/会话 剩余容量的最小值（`RENDER_FLOOR_BYTES` 与脚本 `MIN_TOTAL_BYTES` 同为 1024，剩余低于地板则根本不启动渲染进程）；附件返回后按**实际字节**复核，不合规不交付；未结算预留在读取预算块之前释放 + `finally` 兜底。**字节口径**统一为 binary-encoded-image-bytes（`COST_UNIT`），预算块另给 `request_bytes.estimate`（base64）与宿主口径对照。B **并发**——三层：每会话 `withLock`（无关会话不排队、排队中被取消则拒绝执行）、同步 `claimPage/releaseClaim` 占位同一物理页、预留本身同步原子；账本变更全部落在不含 await 的块内。C **非连续页**——渲染管线改传显式页列表 `--pages 1,10`（`buildRenderPlan`/`runner`/`render_pages.py` 全链路），超发页丢弃，每个被请求页都有明确结果（`inspected/reused/not-delivered` + 9 种 suppression 码），越界页与非法输入分别报出。D **诚实完成声明**——报告新增 §12.4：`professor_material_read` 不约束宿主 `read_image`/`bash`（无受支持拦截点），问候与深度优先级仅是提示词规则、保持【未验证】，注册 22 工具不等于循环已修。**验证（本轮新鲜）**：单测 627/627（第一轮 609，+18）、`npm run verify` exit0（dist「22 个工具」、e2e 28/28）、`verify:harness` 8/8 ALL PASS、`verify:native-session`/`verify:home`/`verify:onboarding`/`verify:packaged`/`verify:customization` 全 exit0 ALL PASS；真实后端路径用 3 页 PDF 请求非连续 `[1,3]`，断言脚本收到 `--pages 1,3`、交付恰为 [1,3]、源 PDF 字节不变。**一次外部干扰如实记录**：首次 `verify:onboarding` 因并行 agent 写入 `docs/qa/2026-10-10-material-reading-teaching/` 触发"整棵检出前后一致"检查失败，静默后重跑 ALL PASS，本轮未改该目录。**边界**：`skills/**`、`professor-skills/**`、`cordis.patch.yml` 零改动；真实数据/会话/凭据零改动；0 次 Git 操作；**0 次付费模型调用**。复测需单独批准（建议 4 次串行，出现同页重复 ≥3 次或再次 IMAGE_OFFLOAD_REQUIRED 等任一停止条件即停，详见报告 §12.6）。项目整体未完成。
2026-10-10 教学运行时修复（诊断 docs/qa/2026-10-10-teaching-runtime-repair/DIAGNOSIS.md，报告同目录 REPORT.md）：确认机制——真实会话 20 条 assistant 消息 text 全空（无已读页面持久记录）；宿主 `IMAGE_OFFLOAD_REQUIRED`（20,971,520 字节上限）按最旧替换图像，占位文案含归一化本地路径，配合预设面 `read_image` 形成重复读图闭环（单页最多重复 5–6 次）；该会话 106 次调用中 `professor_extract`/`professor_search` 一次未用；讲义 55 页仅 4 个分块、2 个带页码；课程绑定会话对「你好」执行 1 次全量 + 4 次逐文件状态读取并重扫 193 项索引后开始讲课；`probeInterpreters` 首个能跑 probe 的解释器即胜出，使渲染（需 PyMuPDF）在真机不可用（文字层本机走 Ghostscript 仍可用，诊断初稿「文字层是坏的」已更正）。**插件侧修复**：新增第 22 个工具 `professor_material_read`（plan/pages/status，文本层优先、`sourceHash#page@variant` 台账确定性去重、`notes` 跨卸载续讲、调用/轮次/会话三级预算、`inspected/noted/text_only/unread/unreadable` 诚实覆盖、物理页码与页脚标号 `correspondence:'not-established'`、无附件/路由未解析/纯文本路由分别如实报状态、内存栅格化不落盘、摘录行有界）；解释器按能力选择（PDF 走有 fitz 的、Office 走有 Office 库的）；`professor_state_read` 会话级缓存按 `fs_version` 失效 + `first_study`；`professor_index_sync` 验证免重建（`status:'unchanged'` 不写盘，新增 `project_digest`、`force`，confirm 显式 force）；每轮注入段落改轮次优先级规则（替换无条件「先恢复状态」祈使句）；`composeSkill` 新增 `<professor_turn_scope>` 深度优先级与两种教学形态且不持久化；`builtin-progressive` 追加「先完整讲完正文」；新增 `src/telemetry.js`（白名单计数/代码，不记内容）与诊断 `material_reading` 小节。**验证（本轮新鲜）**：单测 609/609（基线 569，新增 40，含模拟回归「读页→卸载→再请求同页→有界复用」）、`npm run verify` exit 0（syntax/skills/sync/dist ALL PASS、e2e 28/28）、`verify:harness` 8/8 ALL PASS、`verify:native-session`/`verify:home`/`verify:onboarding`/`verify:customization`/`verify:memory-restart`/`verify:packaged` 全 exit 0 ALL PASS。**边界**：`skills/**`、`professor-skills/**`、`cordis.patch.yml` 零改动；未改宿主/asar；真实资料与会话只读、未出现在 git 变更列表；未提交 Git；**0 次付费模型调用**。**未验证**：真实模型是否停止重复读图、是否改用新工具、送达后解读正确性、真实宿主下 `budget.scope` 取值；复测需用户授权（建议 4 次串行、出现重复读图或再次 IMAGE_OFFLOAD 即停）。**项目整体未完成**；与另一 agent 的技能修订、以及未实施的 Docling 计划（其 `src/tools/material-read.js` 与工具名本轮已被占用）需协调。



2026-10-10 课程编号可编辑 + 启动下拉标签（报告：docs/qa/2026-10-10-editable-course-codes/REPORT.md）：「开始新的学习会话」下拉改显课程编号（值仍为不可变 course_id；缺码回退 ID 不回退名称；重复代码附学期 `CSC3200 · Year2Term1`，代码+学期双重复或缺学期附稳定 course_id 区分符）。「已配置的课程」编辑器新增「课程编号」字段，经既有 manageCourse 快照工作流保存（严格 allowlist 透传至 updateCourse）。校验规则：trim 后存储、空/纯空白/超 240/控制字符拒绝、大小写与自定义形态原样保留、不截断；同代码+同学期唯一、跨学期同代码合法且解析保持显式歧义；旧代码非别名，规范 course_id 永远可解析。身份保全实证（生产工具路径）：绑定记录/索引归属/源文件字节不变，project.yaml 仅 code 字段变化，sources/outputs/notes/state/memory 路径不变。保存失败保留草稿+可操作错误；单次快照令牌防护保持。验证：单测 569/569（+8）、E2E 28/28、verify:home 148 项 ALL PASS。视觉验收 NOT TESTED；第三方来源决定仍待用户批准。真实资料/会话零改动；未提交 Git。

2026-10-10 批量清除+学习预设两项增强（设计：docs/superpowers/specs/2026-10-10-bulk-clear-learning-presets-design.md；报告：docs/qa/2026-10-10-bulk-clear-learning-presets/REPORT.md）：A「全部清除」——Recent 旁一键清除全部非归档注册表行（含列表外），后端快照+单次限时令牌授权（不信任客户端 ID 列表），顺序批处理复用单行 clearRow 安全内核（present 先归档/absent 陈旧清理/unknown 保留行/active 跳过/准备中跳过），逐项结果+聚合计数，部分失败可安全重试（新快照新确认），快照后新建会话不入，墓碑防复活。B「学习预设」——五个内置教学模式（循序讲解/引导思考/考前复习/编程实践/快速答疑，原创 original:professor-v1）+用户库（professor.presets/1，profile 级，≤50 条，2048 预算拒绝不截断，乐观修订，损坏不覆写）；应用=合并快照进既有 customization overlay（professor-study，全局/课程 scope），applied 元数据 additive 兼容旧记录；保存≠激活；编辑/删除库定义不改已应用快照；手动编辑显示已自定义；恢复自动；全新用户经正常组合默认循序讲解。7 个新 strict 远程端点三层契约 parity。验证：单测 558/558（+37）、E2E 28/28、verify:dist ALL PASS（预设离线+许可证断言）、verify:home 148 项 ALL PASS（section 12：真实宿主预设下次组合生效/绑定与部署预设不变、批量清除计数吻合/后建会话存活/令牌单次/归档可恢复）。**来源门禁**：无可验证流行+可再分发候选（SOURCES.md），未引入任何第三方教学内容；THIRD_PARTY_LICENSES.md 随包声明原创；是否改编低流行来源（如 ClawHub study-tutor，MIT-0、指标不可验证）**待用户决定**。UI 视觉与模型教学回答 NOT TESTED。真实资料/会话零改动；未提交 Git；项目整体未完成。

2026-10-10 清除最近对话 + 搜索课程过滤修复：按 QA 报告（docs/qa/2026-10-10-stability-usability-qa01/REPORT.md）两项已确认问题完成修复并验证（报告：docs/qa/2026-10-10-recent-clear-search-repair/REPORT.md）。A「清除最近对话」补齐六层链路：Recent 行「清除」+确认对话框（归档语义、同步锁防双击）、client 内嵌/导出 remote 契约（`#clear/archive`）、后端 remote 端点、原生适配器 `workspaceRegistry.archiveSession(id, { stopActivity: false })`、注册表 archived 墓碑。**更正 QA 报告的一处结论**：宿主 0.2.0-rc.2 确有 `workspaceRegistry.archiveSession/unarchiveSession`（从 app.asar 只读提取核实），「宿主无 API」仅对永久删除成立，归档可用；原生聊天删除仍不受支持。活跃会话归档被宿主拒绝时保留 Professor 行并提示先结束/停止；原生会话已不存在时仅清除陈旧行、不重建原生会话；原生解档不会复活 Professor 行。B 搜索课程过滤改用 `resolveCourseFilter`（精确课程 ID 胜出 > 唯一别名/代码归一 > 歧义返回候选 > 未知显式报错），`CSC3200`/`csc3200` 等价命中，多学期同代码报 `PROFESSOR_COURSE_AMBIGUOUS` 带候选，未知过滤报 `PROFESSOR_COURSE_MISSING`（不再误导「未索引」），归属以当前文件索引为准、陈旧分块元数据不可越权。全新验证：单元 513/513（含 31 项新增）、聚焦修复测试 95/95、E2E 28/28、verify:dist ALL PASS、verify:home 127 项 ALL PASS（新增 section 11：一次性会话真实归档→行消失→重复清除幂等→launch 不复活→unarchive 可恢复且不回加行）。UI 视觉验收 NOT TESTED（行为由组件测试与真实宿主集成覆盖）；模型教学行为仍未验证。真实资料、真实会话、真实偏好零改动；本轮改动未提交 Git。项目整体（完整 Phase 6 矩阵等）仍未完成。

2026-10-09 设置排版更新：依据用户三张截图，设置改为顶部三分区导航，学习偏好常用项为语言/详细程度/讲解方式的可选下拉菜单，保留既有自定义值，任务类型/编程语言/补充偏好收入“更多设置”。课程名称和学期并列（窄屏单列），学习与保存按钮和归档/删除分组，归档勾选简化为“确认归档”。读取课程成功清除残留“正在加载课程…”提示。真实桌面确认偏好与课程卡片排版已生效，未保存真实偏好或删除资料。完整 verify 481/481、E2E 28/28。最近对话清除尚未实现：已异步询问用户是否接受列表移除+原生归档替代永久删除，未收到选择，不能视为批准。永久原生删除依然受宿主接口限制。实现和验证记录见 docs/v1/2026-10-09-settings-layout.md。

2026-10-09 接管修复检查点：课程删除与 UI 更新保留 Claude 已有实现，补上 Home 删除同步锁（React 重绘前双击也只提交一次）、确认窗口 Tab/Shift-Tab 循环与 Escape/取消恢复原按钮焦点、旧课程根目录资料的精确文件排除标记（不排除邻近资料）、搜索始终使用当前文件索引中的课程/分类归属（缓存片段归属更新失败也不漏搜）。新回归及完整 verify 481/481、E2E 28/28，隔离真实打包 verify:home ALL PASS。真实桌面验证 Tab 循环、Shift-Tab 和 Escape 返回 CSC3200 删除按钮；未删除真实课程或聊天。重新只读核对已安装 session Remote：无 delete 方法，原生聊天删除仍受宿主阻塞；旧 permissionRules/decision 回放问题未修复。详见 docs/v1/2026-10-09-review-corrections.md。当前工作区尚未提交 Git；未知来源 professor-skills/ 保留。完整 Phase 6 尚未验收，不可称项目全部完成。

2026-10-09 最新修复：Home 每门课直接“开始学习”；会话持久绑定按稳定课程 ID 解析，模型上下文独立于记忆开关包含当前课程，不再重新问选课；空学期重复扫描复用相同源文件夹的既有课程。真实桌面归档六个误建副本（可恢复，保留全部材料和记录），主页保留七门有效课程。完整 verify 465/465 及真实打包 Home 提示词验证通过；真实新 CSC3200 会话已直接回答当前课程并只询问主题。独立未解决项：旧测试会话重启时 permissionRules/decision 事件不能回放，未改写历史。详见 docs/v1/2026-10-09-selected-course-repair.md。此段优先于下方历史状态；本轮修复尚未提交 Git。

最后更新：2026-10-08（Asia/Shanghai）。这是交接快照，不代表未来环境状态。后续 agent 应先核对代码、Git 和运行环境，再继续操作。

## 最新接管：Phase 4 UI-first 范围已验收（2026-10-07）

### 当前 Phase 6（2026-10-08，课程/设置部分页面已接入）

2026-10-09 最新：材料定向入口已接入，launchMaterial严格请求→材料前后验证→Home原生会话→确认实际cwd/指纹/版本。客户端用原生sessions.using/conversation.input.for/addFiles追加文件引用chip，不覆写草稿/不自动发消息。审查退出/取消漏洞和codec错误均回归RED→GREEN修正。全量458/458、E2E28/28、定向32/32；最终打包Home通过。隔离浏览器学习/提问材料均显示Professor原生输入框lecture.txtchip；故意改动临时文件后入口拒绝过期材料。正向过程材料哈希不变，之后负向测试仅修改临时fixture，真实资料无改动。截图 /private/tmp/professor-material-native-handoff-accepted.jpg。完整Phase6矩阵及其余失败工作流仍待验收；原生引用不等同冻结附件，用户发送时读取仍由宿主负责。无桌面更新/模型调用/推送。

2026-10-09 新检查点：src/app/materials.js 材料ID重新校验基础模块，严查课程/文件ID、索引版本/root/哈希、相对路径、规范化项目/课程来源归属、读取策略、缺失/超预算/改动文件、验证途中连接/索引变化与取消。仅经 fs gateway 读取，无新存储或模型消息。8项定向测试通过；审查发现真实catalog.sources是字符串，改用summarizeCourses真实输出回归先失败再修正。尚未接Remote/原生材料上下文/UI，不可声称定向会话完成；observedVersion需在实际handoff再次guard。下一步实现此adapter并做隔离原生和浏览器验收。

最新验收（覆盖下方未验收/审批受限记录）：审批恢复，隔离真实打包浏览器完成两课程接入、编辑课程名称/学期、归档未确认拒绝/确认归档、恢复；另一课程草稿一直保留且未持久化。最终 YAML 核实 ID 不变和更新状态，两份原测试材料 SHA256 不变。新全量441/441、E2E28/28。截图 /private/tmp/professor-course-management-accepted.jpg，测试页/服务已清理。课程管理这一范围通过；材料定向会话和完整Phase6矩阵仍待完成。真实安装未更新，无推送/合并。

最新工作区补充：课程管理表单已接入文件夹分区，显式读取含归档清单、改名称/学期、勾选确认归档、恢复。复用偏好锁/清旧草稿/读取当前配置；定向45/45，全量441/441、E2E28/28。审查发现保存一门课会丢另一门课草稿，双课程测试先失败后修正，现只合并未受影响的脏字段到新配置令牌。实际浏览器课程管理尚未验收。上一轮Git提交因自动审批服务额度失败没有执行，HEAD仍3c54a7c，课程后端和表单都未提交但完整保留；不可误称已经Git保存。审批恢复后先完成浏览器验收与本地保存，无推送授权。

最新补充：宿主分区界面已保存于 3c54a7c；偏好/文件夹/记忆切换保留草稿，600px 实际无横向溢出，436/436。随后课程管理后端新增 courses/manageCourse，经原生工具支持编辑名称/学期、归档、恢复；服务端令牌绑定会话、课程ID、连接版本、项目位置和配置指纹。原生最终保存比较初始原始配置，并发覆盖回归 RED→GREEN。隔离打包 Home 管理链路通过；课程表单、材料定向上下文及完整 Phase6 矩阵仍未完成。归档保留 Home 摘要并返回 archived 状态，不能误认为删除。此段优先于下方历史记录；最新测试数量见 PHASE6.md。

最新UI检查点：设置可选/创建原生配置会话、输入文件夹、扫描、显式确认模糊课程、换文件夹确认、重建与诊断。确认时锁住偏好保存、清旧课程草稿，结束读取当前全局设置与权威课程。全量435/435、E2E28/28、定向36/36、打包Home通过。隔离浏览器实际两课程接入、课程偏好隔离/重读、重建健康、材料页/原生学习入口、第二项目不勾选拒绝/勾选切换通过；旧配置和三份原测试材料哈希不变。没有模型调用，真实桌面未更新。下一步课程管理、材料ID定向上下文、失败用例及完整Phase6矩阵。旧计数/待办为历史记录，最新事实见PHASE6.md。

最新后端检查点：workspaceCommand只允许发现/确认/重建/诊断，经登记且ready的原生Professor会话与既有工具权限流程执行。服务端保存会话绑定扫描提案（15分钟、最多20份），确认验证候选选择和连接版本，停用取消执行。全量430/430、E2E28/28、定向30/30，打包实际发现/确认/诊断/重建通过；复核无重要阻塞。这一轮没有文件夹表单或浏览器接入验收；下一步补会话选择、文件夹输入、歧义/换文件夹确认、执行状态，再课程管理和材料上下文。旧记录为历史检查点。真实桌面未更新。

最新检查点：设置页记忆开关已接通，需当前版本、禁止重复请求、保留记忆数据和未保存偏好草稿，活动会话刷新退化会单独提示。全量420/420、E2E28/28、定向58/58，打包宿主证明原生记忆上下文关闭清空/开启恢复；隔离浏览器关闭/返回重开/开启/草稿保留通过。复核无重要问题。Phase6仍待文件夹/课程管理、重建诊断、材料上下文和完整浏览器矩阵；下方计数与记忆开关待办为历史记录。真实桌面安装未更新。

本轮补齐记忆写入共享队列：全局设置与原生运行时不同存储 facet 不再同时接受相同版本写入。阻塞写入测试先复现后通过；定向35/35，全量415/415，真实隔离宿主记忆重启验证通过，独立审查无重要阻塞。记忆开关页面仍待接入，Phase 6 仍未完成；下方414为此前页面检查点历史计数。

已接入官方认证 course/settings/saveCustomization 接口和实际页面。课程信息、材料分页、项目隔离最近会话、原生学习/提问入口可用；设置支持六技能、全局/课程范围、五字段保存与重置。真实隔离浏览器证明全局保存、返回主页再打开仍保留、清空生效。全量414/414、E2E28/28；打包 Home 与技能定制重装/独立进程恢复通过，独立复核30/30无阻塞。**Phase 6 未完成**：文件夹接入歧义确认、课程管理、记忆开关、重建诊断、材料ID定向上下文和完整浏览器验收仍待补齐。课程页本轮是组件/后端证据，不声称浏览器课程验收；材料存在性尚未检查。真实桌面和原资料未修改。见 docs/v1/PHASE6.md。

### 后续 Phase 5（后端与原生内容/持久化已验收）

全量 398/398、E2E 28/28；打包原生 CSC3200/STA2001/通用技能内容隔离、重置、重新安装不覆盖、独立新进程恢复全部通过。修正 course_id 接入与不同 runtime facet 写锁共享；并发回归先失败后通过。独立审查无阻塞项，17/17 定向通过，完整宿主/Home/打包/原生/记忆/文件夹接入矩阵通过。当前会话优先级与不持久化是组合 API 证据，不是模型行为验证。没有设置 UI、真实桌面更新或模型调用。下一步 Phase 6 Course/Settings；边界见 docs/v1/PHASE5.md。

用户批准 UI-first 方案（聊天回复 `1`）：独立入口/Home/原生路由优先，原生会话暂时保留在普通列表。会话分离明确未完成；不得自动归档、修改日志、隐藏 DOM 或修改宿主。

独立 sidebar/Home、六模式 launcher、Continue/Recent、官方认证 Remote、共享存储和原生会话路由已接入。打包隔离宿主验证原生创建、预设、课程绑定、记忆准备、标题、同 ID 重试、删除拒绝和冷启动恢复。真实 Chrome 验证入口、表单、创建、继续学习、停用入口移除和重新启用记录保留。注册表只存元数据，不复制消息。普通会话不获得 Professor 工具或技能。

最新计数以 `docs/v1/STATUS.md` 的 Phase 4 最终验收条目为准；详细证据见 `docs/v1/PHASE4.md`。本轮修复表单漏渲染、导航失败重试重复创建、native cwd/workspace/catalog 接入、冷恢复预设、准备状态和共享存储生命周期等问题。真实课程、桌面配置和用户会话未修改，没有安装到真实桌面，没有模型调用。下一步 Phase 5 技能定制，再 Phase 6 Course/Settings；整个 v1 尚未完成。

## Phase 3 已验收（2026-10-07）

当前 agent 已接管原有未提交的 Phase 3 实现并完成收尾。文件夹发现/确认/重建三个工具已接入，总计 21 个 Professor 工具。课程代码建议、歧义确认、排除输出目录、按源哈希增量抽取、旧分块拒绝检索、配置并发保护、连接记录重启恢复均已有测试或真实宿主证据。详细记录见 `docs/v1/PHASE3.md`。

最新全量验证 **319/319**，端到端 **28/28**；打包、宿主、原生会话、Phase 2 记忆重启以及 Phase 3 接入/更新/重建/重启全部通过。真实课程资料、旧学习记录、桌面配置和用户日志未修改。没有模型调用、UI 或实时文件监视器；增量更新是显式按需调用。

下一阶段为 Phase 4 独立入口/Home 与原生会话路由。下文旧阶段报告属于历史，不应把旧“未开始”当作当前状态，也不能把后端完成当成整个 v1 发布就绪。

## 当前接管状态（2026-10-06）

用户已授权由当前 agent 接管并按计划推进，不再只生成交接提示词。Phase 0–1 已保存并验收；Phase 2 的既有实现已保留、修复并完成原生集成验收。最新全量验证 286/286、端到端 28/28，宿主/打包/原生会话/跨进程记忆恢复全部通过。详细记录见 `docs/v1/PHASE2.md`，最新阶段表见 `docs/v1/STATUS.md`，下文旧的“Phase 2 未开始”属于历史记录。

已通过一次真实打包跨进程记忆恢复：新原生会话读取持久偏好、课程指令和学习摘要，课程隔离、临时偏好拒绝、双会话共享存储均有证据。模型轮次未执行，不能称教学行为已验证。新增三个记忆工具后为 18 个 Professor 工具。源资料、旧学习记录和真实桌面配置未修改。

接管修复了验证脚本变量遮蔽、路径别名、未定义 workspace、真正并发写入、状态输出 undefined、异步预设识别、同步提示词回调契约、绑定刷新、上次会话上下文、预算和迭代器计数问题。最后命令结果以阶段台账后续条目为准；下一阶段是 Phase 3 文件夹接入与课程发现，不提前实施 UI。

## 最新规划优先级与执行交接（2026-10-05）

新的权威规划为仓库根目录 `Professor_Plugin_v1_Project_Plan.md`。目标已从可选 preset 升级为便携、独立入口、轻量 Home/Course/Settings、持久记忆、技能覆盖和原生 Harness 会话的学术插件。下文旧版核心完成情况不代表新规划 M0–M8 完成。

本次按新规划核查：M0 部分完成；M1 存在旧技能语义依赖需修正；M2/M3/M5 只有可复用底层；M4 独立 UI、M6 技能覆盖、M7 设置 UI 未实现；M8 全新安装产品验收未满足。课程管理技能仍指示旧 Registry/Knowledge 文件操作，LaTeX 技能仍建议旧 Personal-Agent 模板路径。先做官方宿主 API 可行性核查，不得用 DOM 或日志修改绕过。

分阶段英文执行提示词与验收条件：`docs/superpowers/plans/2026-10-05-professor-v1-agent-prompts.md`。用户将自行交给其他 agent 执行；本次仅审查和生成交接，不实施 v1 新功能。先执行 Phase 0，再按阶段报告推进。

## Phase 0 执行报告（2026-10-05）——已 Verified

**状态：Verified。分支 `feature/professor-portable-app`（自 `main` @ `f2cbd25` 新建）；本轮未创建提交。**

### 本轮实现

- 新增 `tools/verify-harness-api.mjs`（`npm run verify:api`）：可重复的**一次性真实宿主可行性探针**。在 `mktemp -d` 的 `DSH_HOME` 里用真实 Cordis 加载器（`dsh-app-boot#boot`）组合 shipped `web` 模板 + 本 bundle，断言 v1 依赖的 17 个宿主服务已挂载，并对有数据的服务做最小真实操作（客户端清单、会话创建、预设解析、存储域往返），最后用摘要证明真实 desktop profile 未被写入。
- 新增 `docs/v1/HARNESS_API_AUDIT.md`：supported/unsupported/unverified 矩阵 + Phase 1–8 的**约束性实现契约**。
- 新增 `docs/v1/STATUS.md`：阶段状态台账（Phase 0 = Verified，其余 Not started）。
- `package.json` 增加 `verify:api` script，并把它并入 `verify:harness`。
- **未改动** `src/`、`skills/`、`cordis.patch.yml` 或任何产品行为。

### 本轮实际验证（命令 / 退出码 / 计数）

- `npm run verify` → **exit 0**；其中 `npm test` **215/215 通过、0 失败**（约 30.7 s），`verify:e2e` 通过。
- `npm run verify:harness` → **exit 0**，六段全部 `ALL PASS`（preset / composition / boot / host / activation / desktop）。
- 新增 `npm run verify:api` → **exit 0，29 PASS / 0 FAIL**。
- `git diff --check` 干净。

**真实宿主 vs 模拟：** `npm test` 基本是假宿主契约测试，只证明插件自身契约；`verify:host` / `verify:activation` / `verify:desktop` / 新增 `verify:api` 都启动**真实已安装 Harness**。Phase 0 的可行性结论来自真实宿主运行 + 对已安装包的只读检查，不来自 mock。

**宿主身份：** 宿主 `0.2.0-rc.2`（`primary-runtime/runtime.json` 的 `desktopVersion`），自带 node `24.18.1`；desktop profile 的 bundle 为 `dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile`、`dsh-permission-rules@0.7.9`、`dsh-professor-spike`（`link:`）。

### 关键结论（可支撑后续阶段）

- 侧边栏入口、主视图挂载、客户端 bundle、设置页、配置持久化、插件自有版本化存储（`ctx.storageDomain`）、原生会话创建、**首轮前**预设选择（`ctx.agentPresets.select`）、会话导航、会话查询/标题、工作区注册表、插件 HTTP 路由、人类命令——**全部有受支持 API 与实证**。无阻塞项，无需改设计。
- 客户端扩展面：`dsh.client = {platform:'web', inject:[…]}`；只注册进已声明 slot（`sidebar.panellist` = 侧边栏图标，`main` = 由侧边栏 id 选中的中央面板，`settings.section` = 设置页）。
- 持久化契约：`ctx.storageDomain.open(DomainSpec)`；域名须匹配 `/^[a-z][a-z0-9_]*$/`（不能有连字符）；json 后端根为 `~/.dsh/storages/`；`invalidRecords: 'backup-and-skip'` 提供非破坏性的坏记录处理。
- 会话创建用 `prepare → 绑定预设/课程/记忆 → enter → announce`，可实现“部分失败不宣告错误首轮”。
- `ctx.storageDomain.open(DomainSpec)` 的命名约束与已安装实现的只读证据见 audit §6。

### 未修改的用户/源文件

**没有。** 未写入任何课程材料、旧 Registry、旧 Knowledge、真实 desktop profile、真实 `project.yaml` 或会话日志。探针以摘要前后比对真实 profile；失败会话日志只解压到 `/tmp`（原始 `.zstd` 只读打开）。

### 遗留失败 / 阻塞 / 风险

1. **无阻塞。** Phase 1–8 就绪。
2. 有意推迟到所属阶段的未验证项（audit §9）：本包端到端客户端 bundle 注册；启用/禁用后 UI 移除；会话隔离的具体组合；首个模型轮次前的 `agentPresets.select()` 时序；客户端 half 的干净 profile 打包。
3. **既有的、与本插件无关的宿主/插件不兼容：** profile 安装的第三方 `dsh-permission-rules@0.7.9`（其自身声明宿主范围 `<0.2.0`）运行在宿主 `0.2.0-rc.2` 上，追加了**未带 `ignorable` 标记**的 `permissionRules/decision` 事件，导致读路径拒绝该会话日志。只读 `scan` 结果：**扫描 20 个日志，2 个受影响，2 行**（`session-a466a3a2-…`、`session-d74f6e7b-…`，均为 `seq 23`）。修复需用上游 `repair`/`strip`，会**修改用户数据**，本轮**未执行**。**诊断已修正**：根因是越界的第三方插件事件，不是笼统的“宿主版本不匹配”，也不是 Professor 缺陷。风险：本 profile 中新会话可能同样变得不可恢复，Phase 4/7 验收应使用不含该插件的可丢弃 profile。
4. desktop 重放中既有的非 Professor 警告：`dsh-host-product-telemetry-otel` 缺 `$.serviceVersion`；`product-analytics` 等待 `productTelemetry`。

### Git

- 已新建分支 `feature/professor-portable-app`（自 `f2cbd25`）；`main` 仍指向 `f2cbd25`。**未** reset/clean/restore。
- **checkpoint 提交暂缓并已上报：** 工作树带有约 23 个已修改文件与十余个未跟踪路径，均为此前 agent 的成果（`PROJECT_MEMORY.md` 中记录的导入/格式门/偏好修复，以及 v1 计划与提示词文档）。是否将其纳入 `chore: checkpoint Professor pre-v1 app work` 属用户决策，按阶段提示词「ownership 不明确就先问、不要 stage」，本轮**未 stage 任何文件**，也未推送或发布。

### 下一阶段与前置条件

**Phase 1 — Self-contained identity and course-free bootstrap（M1）。** 前置条件已满足：无遗留数据的 profile 上 `ctx.skills`/`ctx.tools`/`ctx.fs` 已挂载（探针实证），存储契约已定义（audit §6）。Phase 1 必须先读 `docs/v1/HARNESS_API_AUDIT.md` 再动手。

## Phase 1 执行报告（2026-10-05 → 2026-10-06）——已实现并在真实宿主验证

**状态：真实宿主全绿（`npm run verify:harness` 8 段 `ALL PASS`，243 项检查，exit 0）。** 分支 `feature/professor-portable-app` 未变；本轮仍未创建提交（checkpoint 归属决策同 Phase 0，仍未 stage）。随后进行的「Phase 1 复查」发现并修复了两个验收缺口缺陷（见下一节），「二次复查」又修掉剩余两个（见再下一节）；二次复查后测试套件为 **263/263 全绿**，`verify:harness` 243 项与 `verify:packaged` 94 项均未变（本轮记录的沙箱拒绝现象**未复现**，保留为带日期的历史记录）。

### 本轮实现

- **根绑定显式化（`src/paths/roots.js`）**：`resolveProjectRoot` 改为 `async`，返回 `{ root, source, bound, reason }`。会话工作区**只有**存在 `.professor/`（或 `DSH_PROFESSOR_PROJECT` 指定）时才算 Professor 根。新增 `assertProjectBound`，抛域错误 `PROFESSOR_PROJECT_MISSING` 并点名工作区与修法。标记是 `.professor/` **目录**，不是 `project.yaml`——空壳目录不能冒充课程。
- **未绑定时整个课程工具面拒绝执行（`src/plugin.js`）**：新增 `requireCourseProject`，**11 个**课程工具使用它；4 个报告类工具（`professor_paths`/`professor_diagnostics`/`professor_project_init`/`professor_course_list`）保留报告用 resolver。`policiesFor(root, roots, { bound })` 在未绑定时把工作区从**读和写**两个根里都移除，作为第二道防线。11 个工具模块统一改为 `await resolveProject(exec)`。
- **Professor 自有应用存储（新增 `src/app/storage.js`）**：域 `professor_app` @ v1，一张 `app` 表；惰性打开（`apply` 从不打开）、失败记忆化、经 `ctx.effect` 释放；首次打开写一条 `bootstrap` 记录标明归属；`describe()` 供诊断使用。**经真实宿主证据后修正**：域自带零依赖 `valueSchema`（`APP_VALUE_SCHEMA`）——见「关键发现」第 1 条。
- **技能正文（不只是 JS）被审计改写**：`professor-course-management` 重写，权威改为经现有工具访问的 Professor 项目文档；必需的 `01_Learning`/Registry/模板/旧 Knowledge 操作全部移除，遗留导入收缩为唯一的 **Optional** 章节并经 `professor_course_manage` 执行。`professor-latex` 改为「配置的模板有效就用它，否则生成自包含项目」，不再有共享 `PERSONAL_AGENT_ROOT` 模板与 `06_Shared`。
- **人格重写（`cordis.patch.yml`）**：新增明确的两种模式段落、`## 权威与顺序`（点名 `.professor/project.yaml` 与 Professor 工具）、`## 未连接课程时`（未绑定=通用学术模式，不是故障）。旧的 `注册表 → INDEX → PROGRESS → KNOWLEDGE → MISTAKES → 源材料` 链已删除。
- **源同步校验被收紧而非静音**：`tools/skill-sources.json` 增加 `portability` 段与 4 条描述真实改动的 divergence；`tools/verify-skill-sync.mjs` 新增 portability 规则（非 Optional 章节出现遗留 token 即失败；声明的 Optional 章节不存在、或其中没有遗留 token，也失败；人格文件含禁用位置/机器路径失败）。
- **新增真实宿主探针** `tools/verify-app-storage.mjs`（`npm run verify:app-storage`），并入 `verify:harness`。`tools/verify-preset-activation.mjs` 增加「读真实 skills 注册表」一段。

### 真实宿主 vs 模拟（本轮实际验证）

- `npm run verify:harness` → **exit 0**，8 段全 `ALL PASS`（preset / composition / boot / host / activation / desktop / api / app-storage），共 243 项检查、0 FAIL。
- 新增 `verify:app-storage` → **44 项全过**：宿主的真实 `ctx.storageDomain` 接受随包 spec；bootstrap 落盘；字节落在 `<DSH_HOME>/storages/professor_app.json`；**关闭后重开**能找到既有标记且不重写；并发重开被拒（`already-open`）；记录往返；`close()` 幂等；无 `ctx.storageDomain` 的宿主报 `unavailable` 且不抛。
- `verify:activation` 新增段：真实 `ctx.skills.list({ scope })` 在预设作用域里恰好返回 6 个技能（course-management / latex / notes / research / review / study），且 provider 名不会冒充技能。
- `npm test` → **235 项，0 产品失败**；红的原因见「遗留失败」第 2 条。

### 关键发现（必须带到后续阶段）

1. **`valueSchema` 是必需的，不是可选的。** Phase 1 最初发布 `tables: { app: {} }`，依据是「裸表能开、能往返」——但那**只在同一次 `open()` 内成立**。宿主 domain 层在加载时对每条已存记录调用 `tableSpec.valueSchema.parse(raw)`（`dsh-storage-domain/lib/index.js` 的 open 期 `loadAll`），没有 schema 就是 `undefined.parse(raw)`，被包成 `invalid-record: … does not match its schema`。结果是：应用存储能开、能写，**但一旦落过盘就再也打不开**——即「重启后失效」。修正方式：自带零依赖校验器，只实现宿主实际调用的那一个 `parse()`。相关事实：同域**并发** `open()` 被拒（`already-open`）；`invalidRecords: 'backup-and-skip'` 在默认 `single` 布局**不被支持**（json 后端只在 `per-record` 布局实现 `backupRecord`），因此插件**不声明**它，而不是声明一个空操作。audit §6.1 已相应修正；`verify-app-storage` 钉住重开路径。
2. **沙箱 fs 拒绝——当前环境中未复现；保留为带日期的历史记录。** **当前（2026-10-06 复查重跑）：** `npm test` **256/256、0 失败**，`npm run verify:dist` **62/62、exit 0**（含此前失败的「装后自测」）。**`CODEBUDDY_BROKER_DENY` 完全未复现**，因此它不是本包的性质。*历史（2026-10-05）：* `npm test` 的失败**全部**是同一条错误：`CODEBUDDY_BROKER_DENY` / `Brokered host mkdir|rename requires an available runtime file rule`，来源是 WorkBuddy 自己的 fs shim（`node-brokered-fs-shim.cjs`），不是插件。判据：**每一次**失败都是同一个 code + message，**没有任何断言失败**；并发跑时 214/235（21 个拒绝），**无并发负载时 234/235（仅 1 个拒绝）**；单独跑这些文件全绿（`portable-core` 13/13、`session-binding` 8/8）。**对 Phase 7 的含义**：该现象是环境性的，因此发布环境里必须重新确认，而不能凭此假设它已消失。该验证器已改进：失败时会点名失败用例、计数与首个原因。
3. **可选能力与不支持平台已如实记录**：抽取与 LaTeX 走 `sh -c`，因此 Windows（`tool-bash` 在 win32 上 `disabled`）**没有**已验证的 shell 接缝；TeX / PDF / Ghostscript / Office 的可用性一律在**调用时观测**，缺失报 `unsupported` / `compiler_unavailable` / `not attempted` 并给原因，绝不跨 OS 承诺等价后端。
4. **工具失败会丢掉机器可读错误码。** 真实管线的物化结果是 `{ content, isError: true, error: { message } }`——**没有 `code`**。因此 `PROFESSOR_PROJECT_MISSING` 这类域错误码**无法**从工具返回值观测，只能看消息文本。需要机器可读拒绝码的后续阶段不能假设它能穿过工具边界。
5. **深度上限的文档与实现曾经不一致。** 注释说深度数的是**容器**（记录本身深度 1，其成员深度 2），但守卫写在标量分支之前，于是把最内层的**叶子**也算了一层，导致一个合法的 32 层容器记录在 `$.next…next.leaf` 被拒。现在只在「即将下探的值」上检查，与文档一致；两个边界都由 `test/app-storage-record.test.mjs` 钉住。
6. **同域并发 `open()` 被后端拒绝（`already-open`）**，加上插件实例在已挂载的整棵树生命周期内持有该域，意味着判活/耐久性探针**不能**在同一进程里第二次打开该域。`verify:packaged` 的做法是把包装进**第二个** profile 但不注册 bundle（包在盘上、插件未挂载），而不是与自己的被测对象打架。

### 便携存储位置与归属（文档化结论）

域 `professor_app` @ v1，一张 `app` 表，owner `dsh-professor-spike`，记录 schema `professor.app/1`。**落盘位置由宿主决定**：`<DSH_HOME>/storages/professor_app.json`（默认 `~/.dsh/storages/professor_app.json`）。**绝不在插件包内，也绝不在学术文件夹内。** 打开是惰性的，失败只记录状态不抛错——没有 `ctx.storageDomain` 的宿主仍能开始一个通用 Professor 会话。

### 未修改的用户/源文件

**没有。** 没有把任何课程材料、旧 Registry/Knowledge、`PATHS.md`、真实 `project.yaml`、真实 desktop profile 或会话日志当作必需项读取或写入。`verify:harness` 每一段都以摘要前后比对真实 profile；所有临时状态都在 `mktemp -d` 中并在退出时删除。

### Git

- 分支 `feature/professor-portable-app` 未变；`HEAD` == `main` == `f2cbd25`（`Save Professor plugin v0.12.0 verified baseline`），**领先 `main` 0 个提交**。工作树**未** reset/clean/restore，既有未提交成果全部保留。
- **checkpoint 提交仍暂缓并上报**（同 Phase 0 的归属决策）。本轮未 stage、未推送；`git diff --cached --name-only` 为空。
- `git diff --check` 干净。

### 下一阶段与前置条件

**Phase 2 — Persistent memory and bounded session context（M2）。** 前置已满足：持久化位置已确立**并已被证明能跨重开存活**（关键发现 1，不要回退它），未绑定会话也能持有 Professor 自有状态。Phase 2 必须复用它，不得引入第二套持久化机制，并保持全局偏好与课程记忆分离。三个必须带上的约束：域已定版为 1，升版需要显式迁移；后端拒绝同域并发 `open()`；工具失败不带错误码到调用方。所有写入必须走 `writeRecord()`（或同等校验路径），因为宿主写路径**不做任何校验**，坏值只会在**下一次打开**时爆出来。

---

## Phase 1 复查报告（2026-10-06）——两个验收缺口缺陷已复现并修复

**状态：Phase 1 可关闭。** 六条 Phase 1 验收标准全部有证据，且第 1 条现在是**强意义**上的满足——**打包产物**装进一次性 profile 后能注册 bundle、人格（且作用域正确）、6 个技能与 15 个工具，并能跨真实进程重启保住自己的存储。分支 `feature/professor-portable-app`；`HEAD` == `main` == `f2cbd25`；**未创建提交**（归属待定，见上）。

### 为什么会有这一轮

Phase 1 此前的「已验证」建立在**从源码目录**用 `link:` 挂载 bundle 的真实宿主运行上，这留下三个缺口：生命周期竞态从未被触发；随包 `valueSchema` 只查最外层 `typeof`；以及「安装后的包能用」从未真正拿安装后的包验证过。

### 缺陷 1：应用存储生命周期竞态（已修复）

`ensureOpen()` 发起宿主 `open()` 并保存 pending promise；此时落到 `close()` 会清掉 `opening` 但看不到尚未发布的 domain。当宿主最终交出 domain 时，被放弃的那次尝试把 domain 发布出去并把 `status` 置为 `'open'`——**在句柄已经关闭之后**。结果是存储自我复活，且已获得的 domain 从未释放。

**修法**：单调 `epoch` 守卫——每次 `close()` 递增，每次尝试认领；被放弃的尝试既不能收养 domain 也不能写状态。发布 domain 与 epoch 检查之间**没有 `await`**，所以 `close()` 只能落在它之前或之后，无法插入中间。归属规则是「**谁清空 `domain`，谁负责释放**」，bootstrap 在每个 `await` 之后重新检查 epoch，失效后立即停止写入。另新增 `writeRecord()` 作为经校验的写路径（宿主写路径不校验任何东西）。

**证据**：`test/app-storage-lifecycle.test.mjs`（新增，8 例）用显式 deferred promise 驱动交错，覆盖全部八条要求性质：不能复活、恰好释放一次、并发 `ensureOpen()` 共用一次尝试、重复 `close()` 安全、显式重开可用、陈旧尝试不能覆盖更新尝试的状态、失效后 bootstrap 停止写入、清理失败如实上报。

### 缺陷 2：校验并非无损（已修复）

`APP_VALUE_SCHEMA.parse()` 只比较 `typeof`，于是 `NaN`、`±Infinity`、`-0`、`{ x: undefined }`、`{ x: 1n }`、函数、symbol、稀疏数组、`Date`/`Map`/`Set`/RegExp/类型化数组/类实例、访问器与非枚举属性、循环引用**全部**被接受——而宿主写路径不校验任何东西，坏值会原样落盘，直到**下一次打开**才爆出来。

**修法**：`validateRecord()` 遍历整张可达图，拒绝任何不能经 `JSON.stringify` → `JSON.parse` 无损往返的值，并点名出错的 JSON 路径。长注释定义了可接受记录形状与 null 策略（`null` 在记录**内部**任意位置合法，但**不能**作为记录本身，因为 `null` 是介质的「从未写入」哨兵）。同时记录了两条已对真实宿主验证过的事实：**同域并发 `open()` 被拒**；`invalidRecords: 'backup-and-skip'` 在默认 `single` 布局是**空操作**（后端只在 `per-record` 实现 `backupRecord`），因此插件**不声明**它。

**第三个发现（由新测试抓出）**：深度上限的文档说数**容器**，但守卫写在标量分支之前，把最内层叶子也算了一层，导致合法的 32 层容器记录被拒。现已与文档一致，见关键发现 5。

**证据**：`test/app-storage-record.test.mjs`（新增，13 例）覆盖：合法嵌套与允许的 null、边界深度与其外一层、非有限数、嵌套 `undefined`/BigInt/函数/symbol、循环 vs. 重复但无环（DAG）、稀疏数组与数组额外属性、会改变形状的对象、会被丢弃的属性种类、null 原型对象；并通过一个「真做 `JSON.stringify`、且在 `open()` 时重校验每条记录」的假介质，证明合法记录能跨持久化与重开存活、`writeRecord` 在**到达介质之前**就拒绝非法值、以及随包 bootstrap 记录满足自己的 schema。

**这些回归测试真的能抓缺陷。** 两个新文件都在临时目录里对**未修复**的副本重跑过：那里 **21 例中 11 例失败**（生命周期 8 中 2、记录 13 中 9），而对着已修复源码 **21/21 通过**。

### 打包安装验收（新增 `npm run verify:packaged`）

`tools/packaged-profile.mjs` 放共享引导管线，`tools/verify-packaged-restore.mjs` 是「新进程」那一半，主验证器 `tools/verify-packaged-acceptance.mjs` 顺序执行：`npm pack` 并对确切 tarball 打指纹（sha256 + 文件清单）→ 把**那个 tarball** `npm install` 进一次性 profile，断言它是真目录而非符号链接、解析不回到源码目录、113 个随包文件**逐字节一致** → 断言干净房间（无 Hermes profile、无 `Personal-Agent`、无 Registry/Knowledge、无手工安装的 Professor 技能、无学术文件夹）→ 从**安装后的副本**启动真实 Cordis loader → 激活（预设声明且未 broken、人格读自宿主自己的 `ctx.systemPrompt.assemble({ scope })`、6 技能、15 工具、13 个子行全部 active）→ 证明**运行时**从安装目录解析资源 → 无课程行为（诚实诊断、课程工具被拒、宽松工具仍作答、磁盘上什么都没创建）→ 已挂载插件真实打开 `professor_app`（并发再开被拒）→ 在第二个未挂载插件的 profile 里做耐久性（写入、拒绝非法值且不损伤已存记录、关闭）→ **新进程**恢复记录且逐字节一致 → 前后指纹比对证明什么都没变。

**结果：exit 0、94 项检查、0 FAIL。** 三条新宿主发现已记录：工具失败丢掉错误码（见关键发现 4）；同域并发 `open()` 被拒导致耐久性探针必须另用未挂载的 profile（关键发现 6）；**`verify:packaged` 只产出注册/激活证据与真实执行证据，不驱动原生会话或模型轮次**，脚本每次运行都会把这一点打印成 `UNVERIFIED`，以免绿色运行被误读成「已跑过真实会话」。

### 本轮（2026-10-06 第一次复查）新鲜观测到的结果

> 以下是该次复查当天的观测值，保留为带日期的历史记录；**当前**计数见下一节二次复查的报告（`npm test` 263/263、`verify:harness` 243、`verify:packaged` 94）。

| 检查 | 命令 | 结果 |
|---|---|---|
| 自动化测试 | `npm test` | **256/256 通过、0 失败**，56.4 s（235 既有 + 21 新增） |
| 真实宿主（源码链接） | `npm run verify:harness` | **exit 0、243 项、0 FAIL**（preset 32 / composition 12 / boot 27 / host 48 / activation 27 / desktop 24 / api 29 / app-storage 44） |
| 真实宿主（打包产物） | `npm run verify:packaged` | **exit 0、94 项、0 FAIL** |
| 离线门禁 | `verify:syntax` / `verify:skills` / `verify:sync` / `verify:dist` / `verify:e2e` | **100 文件 / 39 / 89 / 62（exit 0） / 28 场景**，全部 `ALL PASS` |
| 空白卫生 | `git diff --check` | 干净 |
| **未验证** | 原生会话轮次、模型驱动的工具选择、Phase 4 UI | 由 `verify:packaged` 明确打印为 `UNVERIFIED`，归后续阶段 |

### 本轮修改的文件

`src/app/storage.js`（epoch 生命周期 + `validateRecord` + `writeRecord` + 深度上限移到容器）、`test/app-storage-lifecycle.test.mjs`（新增）、`test/app-storage-record.test.mjs`（新增）、`test/portable-core.test.mjs`（仅更新一处过时的拒绝消息期望，行为未变）、`tools/packaged-profile.mjs`（新增）、`tools/verify-packaged-acceptance.mjs`（新增）、`tools/verify-packaged-restore.mjs`（新增）、`package.json`（新增 `verify:packaged`）、`docs/v1/STATUS.md` 与本文。

**未修改任何用户/源文件。** `verify:packaged` 第 11 段在运行前后对源码目录 126 个文件做摘要比对、断言两份安装副本仍恰好是那 113 个文件、tarball 未被改动、真实 desktop profile 未变；所有临时状态都在 `mktemp -d` 与私有 npm cache 中并于退出时删除。

**一处方法学修正值得记下。** 第 11 段初稿曾比对用户真实 `~/.hermes` 与 `~/Personal-Agent` 的 `mtime`。该检查已被**删除（不成立）**：`~/.hermes` 是另一个无关网关进程在写的活目录（`gateway_state.json`、`kanban.db-wal`、`cron`），其 `mtime` 自己每秒都在变，因此比较会因与本轮完全无关的原因失败。它本想证明的性质现在由两条更可靠的路径证明：静态扫描本轮真正解析的运行时配置（2 份 profile manifest、2 份根入口树、2 份安装后的 patch）里有无遗留位置引用与一次性 home 与宿主安装之外的路径；以及动态启动一个完全不含这些目录的 home。那两个目录现在是**被观测并上报**，而不再是被断言。


## Phase 1 二次复查报告（2026-10-06）——剩余两个验收缺陷已复现并修复

**状态：Phase 1 可关闭，结论未变、证据补全。** 六条验收标准全部有证据；本次修掉的是**已被验收要求内部**的两个实现漏洞（不是验收清单本身的问题）：被顶替的生命周期完成不得覆盖新一代状态；任何会在 JSON 往返中丢失成员的记录不得以"合法"身份落盘。**没有把任何未满足的 Phase 1 要求挪到后续阶段**；原生会话、模型驱动工具选择、Phase 4 UI 三项**仍未验证**，`verify:packaged` 每次运行都会打印 `UNVERIFIED`。

分支 `feature/professor-portable-app`；`HEAD` == `main` == `f2cbd25`；**未创建提交**（归属决策同前两轮，仍未 stage）。

### 为什么会有这一轮

上一轮修掉了两个缺陷**类**（生命周期竞态、浅校验），但每个修法只被"它的第一版测试恰好用到的那种形状"验证过，各自留下一个洞：

1. 生命周期测试从未把**仍在进行中的释放**与**更新的一次打开**交叠，所以 `await handle.close()` 之后那句无条件 `status = 'closed'` 从未在"已有更新一代"的情况下被执行到；
2. 数组遍历器只按**形状**拒绝属性名（`/^(?:0|[1-9]\d*)$/`），而 `"4294967295"` 及以上**根本不是数组索引**——它们不计入 `length`、`JSON.stringify` 会默默丢掉；同时它用 `array[index]` 读元素，会在校验期**调用访问器的 getter**。

两个缺陷都**先写成失败测试**，再改实现。

### 缺陷 3：被顶替的 close 完成覆盖了更新一代的生命周期（已修复）

**复现**（`test/app-storage-lifecycle.test.mjs` 的「a stale close completion cannot overwrite a newer lifecycle」）：(1) 打开句柄 A 并等它稳定；(2) 发起 A 的 `close()` 并**让它的释放悬停**；(3) 发起并**完成**句柄 B 的新打开；(4) 再让 A 的释放结束。修复前存储报 `closed`，而 B **仍然可用**、能通过 `table()` 访问——断言处的表现是 `'closed' !== 'open'`。

**修法**：`close()` 把状态写入放进**同步段**（在释放被 `await` 之前），之后**不再写任何状态**。epoch 递增与该写入之间不可能插入别的东西，所以这次写入发生在"这次 close 正是当前生命周期"的时刻；其后的 `await` 不碰任何状态。这同时也是**调用方视角下诚实的**回报——同一时刻 `table()` 已不再返回句柄。释放失败仍通过 logger 上报，**绝不**通过污染"可能已经取代它的那一代"的状态来体现。释放逻辑合并进既有的 `releaseHandle(handle, 'during close')`，警告文案不变。

**归属规则一致地应用到另一条异步完成路径**：`bootstrapped = await bootstrap(...)` 形状相同——一次 `await` 之后的状态写入，可能由被顶替的尝试落到——现已按 epoch 守卫（`if (isCurrent()) bootstrapped = wrote`）。规则在模块的生命周期契约里只写一次：**生命周期只在它自己的 epoch 仍然当前时写状态。**

**两条测试，修复前都是红的。** 第二条（「a failed release on a superseded lifecycle is reported without corrupting the newer one」）覆盖需求里的"清理错误可观测且不破坏更新状态"：释放于 B 成为当前生命周期之后抛错，警告恰好出现一次，B 的状态与 reason 未被动过，B 仍可写。第一条还钉住"恰好释放一次"（`calls.closed === ['open#1','open#2']`：A 由它自己的 `close()` 释放，B 由更新那次释放）以及 B 是**真的可用**而不只是"被描述成 open"。

### 缺陷 4：非索引的数组属性被当作成员接受（已修复）

**复现**——需求原文的片段，现已成测试：

```js
const value = []
value['4294967295'] = 'lost'   // 2 ** 32 - 1：看着像索引，其实不是
validateRecord(value)          // 修复前：接受
JSON.stringify(value)          // "[]" —— 成员被默默丢掉
```

`"4294967295"` 不计入 `length`，`JSON.stringify` 也不输出它，于是记录可以"合法"却**丢了一个成员**——正是无损契约要防的那种失败。同一个遍历器还用 `array[index]` 读元素，从而调用访问器 getter。

**修法**：只有数组**真正可能有**的规范索引才算元素——名字须匹配 `/^(?:0|[1-9]\d*)$/` **且** `<= 2 ** 32 - 2`（`MAX_ARRAY_INDEX`；`length` 上限是 `2 ** 32 - 1`，所以低一位才是可能存在的最大索引）**且**小于该数组自己的 `length`。其余一律按"JSON 会丢掉的额外属性"拒绝。元素**描述符**现在先于元素读取被检查：非枚举元素照旧被拒，访问器元素**在 getter 从未被调用的情况下**被拒——在校验期运行被测代码、再信任一个后续读取未必复现的值，不叫校验。

**刻意没做的事：空洞检查原样保留。** 早先的草稿把"逐索引扫描空洞"改成"数元素个数 + 有界地找第一个洞"，理由是"巨大 `length` 会让扫描变得病态"。**先测量后发现这个理由不成立**：现有循环在**第一个洞**就短路，所以 `a[2 ** 32 - 2] = 1` 会在 `$[0]` 处以亚毫秒被拒。于是保留了更小的改动，改为把所依赖的边界钉住：`2 ** 32 - 2` 必须被当作**真实元素**（因此拒绝理由是 "sparse array" 而不是 "extra property"）——边界处的一个 off-by-one 就会破坏它。

**关于"测试变红"的如实说明。** 本轮共新增 **7** 条测试，其中 **5 条**修复前红、修复后绿（2 条生命周期 + 3 条记录：需求复现、访问器、持久化拒绝）；另外 **2 条修复前就是绿的**——数组索引边界/有界时间那条（旧空洞扫描本来就短路）、以及"普通数组仍被接受"那条。两条都作为回归**守卫**保留（后者专门防**过度拒绝**），且**都不算作修复的证据**。

**持久化。** `test/app-storage-record.test.mjs` 还通过"真做 `JSON.stringify`、且在 `open()` 时重校验每条记录"的假介质证明：两种有损形状都在**到达介质之前**被 `writeRecord` 拒绝——之后存储文本逐字节不变、被拒的 key 不存在、bootstrap 标记存活，且判定过程中**没有任何 getter 被调用**。

### 本轮新鲜观测到的结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 自动化测试 | `npm test` | **263/263 通过、0 失败**，约 63 s，**exit 0**（256 既有 + 7 新增） |
| 回归价值 | 7 条新测试对**未修复**副本 | 那里 **5 条失败**（生命周期 2、记录 3），另 2 条两边都过、已标注为守卫 |
| 真实宿主（源码链接） | `npm run verify:harness` | **exit 0、243 项、0 FAIL**，8 段全部 `ALL PASS` |
| 真实宿主（打包产物） | `npm run verify:packaged` | **exit 0、94 项、0 FAIL** |
| 离线门禁 | `verify:syntax` / `verify:skills` / `verify:sync` / `verify:dist` / `verify:e2e` | **100 文件 / 39 / 89 / 62（exit 0） / 28 场景**，全部 `ALL PASS` |
| 空白卫生 | `git diff --check` | 干净 |
| **未验证** | 原生会话轮次、模型驱动的工具选择、Phase 4 UI | 未变，仍由 `verify:packaged` 打印为 `UNVERIFIED`，归后续阶段 |

真实宿主链与打包验收**被重新执行**，因为存储模块正是它们的被测对象（`verify:app-storage` 把插件真实的 `createAppStorage()` 交给真实的 `ctx.storageDomain`；`verify:packaged` 通过安装后的副本做写入、拒绝与恢复）。两者检查数未变（243 / 94），说明这两个修法没有改变宿主可观测的行为。

### 本轮修改的文件

`src/app/storage.js`（`close()` 在同步段认领状态、释放 `await` 之后不再写状态；bootstrap 赋值按 epoch 守卫；新增 `MAX_ARRAY_INDEX` 与 `CANONICAL_ARRAY_INDEX`；`walkArray` 拒绝非索引属性、并在读取元素之前检查元素描述符；模块的记录形状表与生命周期契约同步记录这两条规则）、`test/app-storage-lifecycle.test.mjs`（`pendingService({ deferClose })` 让释放可以被悬停；**+2** 例）、`test/app-storage-record.test.mjs`（**+4** 例：需求复现与索引边界；`2 ** 32 - 1` 长度的边界；访问器元素与元素描述符拒绝；普通/嵌套/长数组。另加 1 例持久化拒绝）、`README.md`（测试计数 256 → 263；存储契约补上数组索引规则、访问器规则、生命周期归属规则；新增一条带日期的操作注意：长验证脚本会超过环境命令超时，`exit 137 / SIGTERM 且无输出`是超时而不是产品失败）、`docs/v1/STATUS.md` 与本文。

**未修改任何用户/源文件。** 两个新测试文件用的是假宿主与内存 fixture；真实宿主运行沿用既有验证器，它们以摘要比对真实 desktop profile、所有临时状态都在 `mktemp -d` 中。运行前后 `git status` 显示的既有已改/未跟踪路径集合完全一致（38 已改、23 未跟踪、0 已暂存）。

### 风险

1. **生命周期只在自己的 epoch 仍当前时才允许写状态**——现已在 `createAppStorage` 契约中写明，并在两条异步完成路径上落实（`close()` 的状态、打开尝试的 `bootstrapped`）。将来任何在 `await` 之后写入的字段都必须同样守卫，否则同一类缺陷会在新字段上重演。
2. **数组索引边界是 `2 ** 32 - 2`（含）**——再往上一位就是"看起来像数字的普通字符串属性"，JSON 会丢掉它。两侧都有测试钉住，off-by-one 无法再悄悄开始丢成员或接受成员。
3. **校验绝不调用访问器 getter**——对象属性和数组元素都按描述符拒绝。将来若有"简化"改成先读值，就等于把"校验期运行不可信代码"重新引回来。
4. **未修复的空洞扫描本来就在第一个洞短路**——记下来，因为早先的计划（按计数找洞）是被一个"测量后并不成立"的病态担忧驱动的：在这里优化之前先测量。
5. **`valueSchema` 是必需的**——沿用，未变（见关键发现 1）。
6. **沙箱 `CODEBUDDY_BROKER_DENY` 未复现**（263/263、62/62）。仍是环境性的；Phase 7 发布门必须在发布环境里重新确认，不能假设它已消失。
7. **工具失败丢掉机器可读错误码；同域并发 `open()` 被拒**——沿用，未变（关键发现 4 与 6）。
8. **操作层面，带日期（2026-10-06，本环境）：** `verify:dist`、`verify:packaged`、`verify:harness` 单次各需 1–3 分钟，超过环境默认命令超时。被外部杀掉时表现为 **exit 137 / SIGTERM 且完全没有输出**，看起来像产品失败，实际不是。请放宽超时、逐个重跑。`verify:dist` 曾以这种方式连续失败三次，之后在代码完全未变的情况下成功。
9. **既有的、与本插件无关的：** `dsh-permission-rules@0.7.9`（`permissionRules/decision`）与两条 desktop 激活警告——未变，见 Phase 0 遗留 3–4。

### Git

- 分支 **`feature/professor-portable-app`**；`HEAD` == `main` == **`f2cbd25`**（`Save Professor plugin v0.12.0 verified baseline`）；**领先 `main` 0 个提交**。
- 工作树：**38 个已修改、23 个未跟踪、0 已暂存**（用 `git diff --cached --name-only` 核对）。本轮没有新增文件也没有删除文件，所以计数与上一轮完全相同——变的只是三个本就已跟踪且已修改的文件（`src/app/storage.js`、`README.md`）和两个本就未跟踪的测试文件（外加两份记忆文档）的内容。
- 树里仍旧混合着此前 agent 的成果（`PROJECT_MEMORY.md` 中记录的导入/格式门/偏好修复、v1 计划与提示词文档），因此**staging 归属仍是用户的决策**。按需求，本轮**未 stage 任何文件、未创建任何提交**；上一轮报告中提出的那个问题仍然悬置。
- 工作树**未** reset/clean/restore，既有未提交成果全部保留。未推送、未发布。`git diff --check` 干净。

### Phase 1 能否关闭、Phase 2 能否开始

**能——上一轮的结论继续成立，且证据现在是完整的。** 两个洞位于**已被验收要求内部**的实现里，而不是验收清单本身；修掉之后，六条验收标准全部有证据，它们所守护的两条正确性属性也都有"不修就失败"的测试钉住。这一结论没有靠"把某项要求挪到后续阶段"换来，也没有任何验收项是靠部分证据宣称的：**原生会话、模型驱动工具选择、Phase 4 UI 仍未验证**，且每次 `verify:packaged` 运行都会如实打印。

**Phase 2 前置条件**：与上一轮相同，另加一条——复用 `professor_app` 时必须走 `writeRecord()`；若 Phase 2 在存储生命周期里新增**在 `await` 之后写入**的字段，必须按 epoch 守卫，因为那正是缺陷 3 的形状。

---

## Phase 1 三次复查报告（2026-10-06）——原生会话验收已补做，Phase 1 可正式关闭

**状态：Verified。分支 `feature/professor-portable-app`；checkpoint 已创建：`368b8dc` → `a63c925`（见下 Git）。**
本轮**未改动任何产品代码**，也没有重开已修复的两个存储缺陷——改动只加了一个验收验证器及其接线。

### 为什么会有这一轮

Phase 1 的验收原句是：*"actual installed package in an isolated real Harness profile **starts a
general Professor native session**, persona and six skills are available, no legacy data is read as a
requirement, and no course tree is created or guessed."*

此前两轮报告一边宣称 Phase 1 全部验收通过，一边（`verify:packaged` 每次运行都会打印）承认
**"a native conversation turn" 是 UNVERIFIED**。这两句话互相矛盾，矛盾点恰好落在验收句的**第一个从句**上：
其余部分（已安装包、隔离 profile、人格、六个技能、不读旧数据、不臆造课程树）都有真实证据，
*"starts a general Professor native session"* 没有——因为之前的运行证明的是 preset 的**注册与激活**，
而不是**某个会话确实运行在它之下**。本轮把这个从句真正跑了一遍，并把剩下的空洞放回它该在的位置。

### "原生会话"是什么，为什么这个区分要紧

由插件自己或测试辅助函数造出来的会话证明不了任何事——验收句要求的是**已安装包**开启会话。
所以验证器走宿主自己的工厂：

| 步骤 | 调用 | 为什么这是原生路径 |
|---|---|---|
| 创建 | `ctx.get('agents').create({ sessionId, meta: { cwd } })` | 宿主自己的构造入口：准备会话、经 `sessionPersistence` 后端持久化、围绕它构建 Agent 并发布 agent loop。`sessionId` **是必需的**，省略会失败：`agent id "undefined" does not match session id "session-1"`。 |
| 绑定 | `ctx.get('agentPresets').select(agent, 'professor')` | 按运行时的方式绑定，且必须**在首个 turn 之前**；之后会被拒绝（`agent-preset/locked`）。 |
| 读取 | `agent.loopCtx.systemPrompt.assemble(assembleContextFor(agent))` | 读取**会话自己解析出的**表面，用的是宿主自己的 `assembleContextFor`——与 `dsh-agent-loop` 在 `preStep()` 里的调用完全相同。 |

两个实测出来的陷阱必须记下来，因为**两个都是静默的**：

1. **权威的 scope token 就是 agent 对象本身。** `assembleContextFor(agent)` 返回 `{ agent, scope: agent }`。
   用 `agent.ctx`、或用 preset mount 的 key 去读同一个 assembly，会返回**默认部署人格而不是 preset 的**，且**不报错**。
   在已安装产物上实测：`scope: agent` 得到 **2056 字符 Professor 人格 / 28 个工具 / 6 个技能**；
   `agent.ctx` 得到 **54 字符编码 agent 人格 / 0 工具 / 0 技能**。
   `dsh-system-prompt` 的 `renderContextSections()` 同样是错的读取器（只含 render-hook sections），它返回 2 个 section，而实际 assembly 有 16 个。
2. **`pathToFileURL(import.meta.url)` 会把一个本来就是 URL 的值再编码一次**（`…/repo/file:/…/repo`），
   由此推出的 `cwd` 根本不存在，所有子进程都会报 `spawnSync npm ENOENT`——一个把路径错误说成"没装 npm"的报错。
   本轮发现并修复；新验证器第 1 节现在会**先**断言仓库根目录真实存在，再运行任何子进程，这类问题不会再伪装成 npm 故障。

### 新增的验证器

`tools/verify-native-session.mjs`，接线为 **`npm run verify:native-session`**。它打包真实 tarball、
装进一次性 profile（真实目录，并已验证不会解析回源码 checkout）、用真正的 Cordis loader 启动，
然后用九节内容：创建一个**原生、通用（无课程）的 Professor 会话**、一个**不选 preset 的对照原生会话**，
验证会话可持久化、没有臆造任何学术目录，以及机器上其它东西没有被改动
（源码 checkout 摘要、真实 desktop profile 摘要、tarball、安装后文件集合）。

### 证据分层（本轮新鲜观测）

分层是关键：它们**不可互相替代**，只有第 1–3 层属于 Phase 1。

| 层级 | 证明了什么 | 证据 | 结果 |
|---|---|---|---|
| 1 — 包激活 | 已安装包能在真实 profile 中挂载并激活 | `npm run verify:packaged` | **94 PASS / 0 FAIL**，exit 0 |
| 2 — 直接派发的工具测试 | 工具经真实 registry 管线调用时行为正确 | 同一运行 + `verify:native-session` 第 5 节 | PASS |
| 3 — **原生会话集成** | 已安装包**开启一个通用 Professor 原生会话**，且该会话自身的人格/工具/技能处于激活状态 | `npm run verify:native-session` | **47 PASS / 0 FAIL**，exit 0 |
| 4 — 模型观测行为 | **模型**做了什么：真实 turn、由模型选择的工具 | 无 | **UNVERIFIED**——一次性 profile 没有配置任何模型供应商（`defaultModel` 报告为 **ABSENT**）；一个 turn 需要凭据、网络与花费 |

第 3 层的实测细节：会话 header 由原生层自己盖章（id、`cwd`、`createdAt`）；选择前该会话**不**组合任何 preset，
选择后组合 `professor`；**原生会话日志**中记录 `agent-preset/selected`，内容为 `{"agentPreset":"professor"}`；
会话自己的 prompt 携带 2056 字符、以 `你是 Professor` 开头的人格，位于 `deployment:persona-prefix` section；
**15** 个 `professor_*` 工具全部可见并被提供给模型（合计 28 个）；列出**六个**内置技能；
经真实管线的一次工具调用成功，并报告 `projectBound: false`、`appStorage: 'open'`；
需要课程的工具被**描述性地拒绝**；而此前从未执行过的**对照会话**一样都拿不到
（54 字符编码人格、0 工具、0 技能）——说明这个表面是真正**按 scope 限定**的，不是全局的。
随后 `sessions.flush()` 在原生层自选的目录下写出 `session.v4.jsonl.zstd`，解压后的 header 指向本会话与这个非学术工作目录。

**第 4 层不是 Phase 1 的条款，也没有为了把这一行变绿而挪到后续阶段。** 权威规划已经明确指派：
Phase 4 负责 `agentPresets.select()` → 首个模型 turn 的**有序**调用序列；
Phase 7 负责 *"Where a model turn is required, obtain the normal model/network authorization and record
actual observed behavior."* 验证器每次运行都会把这三行 `UNVERIFIED` 打印进自己的输出，
使这条边界存在于产物里，而不只存在于本文档里。

### 本轮实际运行的命令（2026-10-06，全部新鲜）

| 命令 | 结果 |
|---|---|
| `npm test` | **263 / 263 通过**，0 失败，exit 0 |
| `npm run verify:e2e` | **28 / 28**，exit 0 |
| `npm run verify:packaged` | **94 PASS / 0 FAIL**，exit 0（3 条 `UNVERIFIED`，均为第 4 层 / Phase 4 UI） |
| `npm run verify:native-session` | **47 PASS / 0 FAIL**，exit 0（新增） |
| `npm run verify:harness` | **243 项检查、8 段 ALL PASS**，exit 0 |
| `npm run verify:dist` | **62 / 62**，exit 0 |
| `npm run verify:syntax` | 101 个文件可解析，ALL PASS |
| `npm run verify:skills` | ALL PASS |
| `npm run verify:sync` | ALL PASS |
| `git diff --check` | 干净 |

没有复用任何历史计数：上表每一个数字都来自本轮实际执行的命令。
`verify:native-session` 也确认了**两个入口都能用**（`npm run verify:native-session` 与直接用 harness 二进制调用）。

### 本轮修改的文件

- `tools/verify-native-session.mjs` —— **新增**；第 3 层验收验证器（9 节 + claims 块），47 条断言。
- `tools/packaged-profile.mjs` —— 扩展出原生会话辅助函数（`createNativeSession`、`selectPreset`、
  `sessionSurface`、`nativeSessionLog`、`loadAssembleContextFor`），让原生路径继续留在那个本就负责
  "tarball → 可运行 profile" 的模块里。
- `package.json` —— 新增 `verify:native-session` 脚本。
- `docs/v1/STATUS.md` —— 新增本节，并修正 Phase 1 清单行。
- `PROJECT_MEMORY.md` —— 本节（中文对应版）。
- `README.md` —— 计数与新增脚本。

### 未修改的用户 / 源文件

**没有。** 没有读写或迁移任何真实课程树、旧 Registry/Knowledge 数据、桌面配置或会话日志。
验证器第 9 节是**断言**而非承诺：运行后源码 checkout 逐字节一致、真实 desktop profile（`~/.dsh/profiles/desktop`）
未被写入、本次运行解析到的 5 个运行时配置源里没有任何旧学术路径引用。一次性 home 在所有退出路径上都会被删除。

### 风险

1. **第 4 层按设计仍然敞开**（见上）。它是这一行通往"四层全绿"的唯一障碍，而且**不是** Phase 1 的要求；它会在 Phase 7 成为阻塞项。
2. **一次性 profile 里没有配置任何模型供应商。** 复制用户真实凭据或复用真实 desktop profile 被需求明确禁止，本轮也没做。一次性 profile 生成的凭据文件只含 web 会话授权。
3. **没有 turn 时，原生会话持久化只刷新一部分。** `flush()` 之后日志文件里只有 header 事件；其余事件在原生内存日志里等待某个 turn 推进持久化。这就是为什么验证器从**原生会话日志**而非文件里断言 preset 选择，并在输出里写明这一点。
4. **`assembleContextFor` 是唯一正确的读取器**（上面实测陷阱 1）。将来任何用别的 scope token 读人格或工具列表的代码，都会静默地看到编码 agent 人格。`sessionSurface()` 的文档注释就是为了挡住这件事。
5. **操作层面——两种过载症状，2026-10-06 都实测到。** 重型验证器超过环境默认命令超时，被外部杀掉时表现为 **exit 137 / SIGTERM 且无输出**——超时，不是产品失败。另一类：在 **12 核但 load average 11** 的机器上，平时约 6 分钟的全量跑变成 **1 小时 45 分**，且有两项**不是断言失败、而是 fixture 超时**：`test/extract-production.test.mjs` 里 `spawnSync …/python3 ETIMEDOUT`（**917 秒**后），以及同因导致的 `verify:e2e` 场景 22 报 `no Office extractor for pptx … (the Python backend needs python-pptx)`。两者单独重跑都通过（`extract-production` **19/19**、`verify:e2e` **28/28**），机器较闲时 `npm test` **263/263**。**不要把 fixture 超时当成产品失败**——单独重跑该检查，并看失败形状（断言 vs. `spawnSync … ETIMEDOUT`）。这些验证器应在空闲机器上逐个运行。
6. **既有的、与本插件无关的**：`dsh-permission-rules@0.7.9` 与两条 desktop 激活警告——未变，见 Phase 0 遗留 3–4。

### Git

- 分支 **`feature/professor-portable-app`**；`HEAD` == `main` == **`f2cbd25`**（`Save Professor plugin v0.12.0 verified baseline`）；**领先 `main` 0 个提交**。
- 工作树：**38 个已修改、24 个未跟踪路径、0 已暂存**（`git diff --cached --name-only` 为空）。这 24 个未跟踪*路径*里有 3 个是目录（`docs/superpowers/`、`docs/v1/`、`src/app/`），所以工作树实际是 **63 个变更文件**（38 已修改 + 25 未跟踪）。本轮新增一个文件（`tools/verify-native-session.mjs`），未改动上一轮未动过的文件。
- **归属问题现在是被回答的，而不只是被复述。** 全部 63 个文件按修改时间只落在两个时代，且**没有任何文件同时属于两个时代**（用 `comm -12` 核对）：
  - **2026-10-01 17:43–19:18 —— v1 之前的修复：22 个文件**（14 已修改 + 8 未跟踪），作者时间**早于** v1 规划文档（2026-10-05 09:57）：即 `PROJECT_MEMORY.md` 中记录的导入/格式门/偏好修复。它们是自成一体的关注点：`src/migrations/repair-import.js` 只被 `tools/repair-import-config.mjs` 与 `test/repair-import.test.mjs` 引用，三者都在这个集合里。
  - **2026-10-05 10:41 起 —— v1 Phase 0 / Phase 1：41 个文件**（24 已修改 + 17 未跟踪），含 `src/app/storage.js`、v1 计划与提示词文档、`docs/v1/` 与各验证器。
  由于后一时代的成果是在前一时代改动**之上**写成的，若要拆成两个提交，必须把 v1 之前的那组放在**前面**；两组按文件互不重叠，因此该顺序是良定义的。
- **checkpoint 已按用户明确指示创建**（"按时代拆成两个提交"）。除此之外未暂存任何文件；文件清单由修改时间计算得出，不是手工挑选的。
  - `368b8dc` —— *Professor plugin: pre-v1 repairs to import, format gate and preferences* —— 2026-10-01 那批 22 个文件（14 改 + 8 新增），956 插入 / 44 删除。
  - `a63c925` —— *Professor v1 Phase 0 + Phase 1: portable identity, course-free bootstrap, app storage* —— 其余 41 个文件（24 改 + 17 新增），9453 插入 / 227 删除。
  - 两者与上面的划分逐文件一致：`22 + 41 = 63`，重叠 `0`，未归类 `0`。
- **⚠ 中间那个提交不是绿的，这一点如实记录而不是掩盖。** 在一个一次性 `git worktree` 中实测（真实工作树未被 checkout 或改动）：
  - 在 **`368b8dc`**：`npm test` → **211 通过 / 4 失败**，exit 1。四条失败是
    *artifact status reports roots, configuration source and existing files*、
    *every import result is lossless JSON…*、*registry import preserves per-course destinations…*、
    *a migrated course creates and lists notes only in its own configured destination* —— 也就是
    2026-10-01 那批更新过的 **artifacts / migration 测试**在断言**其 `src` 落在 2026-10-05 那批**的行为
    （`src/tools/artifacts.js`、`src/tools/courses.js` 等）。`verify:syntax` 通过（89 个文件）。
  - 在 **`a63c925`**（HEAD）：`npm test` → **263 通过 / 0 失败**，exit 0。
  所以这次按时代的拆分是对**作者归属**的忠实拆分，但不是"每个提交都绿"的拆分：最后那个提交才是已验证状态，第一个是归属步骤。**合并成一个提交即可消除这个红色中间态**；在未推送的分支上这是一条命令的事，交由用户决定。
- 工作树**未** reset/clean/restore，既有成果全部保留，且现在**干净**（0 已修改、0 未跟踪、0 已暂存）。未推送、未发布。`git diff --check` 干净。

### Phase 1 能否关闭、Phase 2 能否开始

**Phase 1 现在可以正式关闭。** 验收句的每一个从句都有证据，且都是在一个既无旧数据、也无学术目录的一次性 profile 中、针对打包产物产生的——包括此前完全无证据的那一个从句。矛盾是朝着诚实的方向解决的：没有把未执行的从句"升格"，而是把它执行了。为了让这一行变绿，没有在阶段之间搬运任何要求；剩下的空洞（第 4 层）按规划自己的措辞被如实记为 Phase 7/8 的要求。

**Phase 2 可以开始，但附带一条明确承认的待验收项：** 模型观测行为（模型 turn 与模型驱动工具选择）尚未验证，且在 Phase 7 关闭之前**需要用户授权**模型凭据、网络访问与花费。Phase 2 本身不需要该授权——它工作在第 1–3 层已经证明过的存储与上下文契约之上。

**带到 Phase 2 的前置条件：** 复用 `professor_app` 时必须走 `writeRecord()`；在存储生命周期里**在 `await` 之后写入**的字段必须按 epoch 守卫（缺陷 3 的形状）；agent 作用域的人格/工具贡献只能经 `assembleContextFor(agent)` 读取（风险 4）。

**这不是 v1 发布就绪声明。** Phase 2–8 尚未开始；没有发布门、没有 UI 外壳、也没有模型观测证据。本节唯一的主张是：Phase 1 自己的验收清单现在证据齐全。

---

## 1. 项目的具体目的

把用户在 Hermes 中使用的 Professor bot 的学术助教工作流迁移到 DeepSeek Harness，形成可安装、可选择、可验证的 Professor 插件。目标不是只复制一段人格提示词，而是将课程管理、材料读取、教学、学习记忆、笔记、考试复习和 LaTeX 交付串成可靠工作流。

用户关心实际使用效果是否符合原 Professor 的要求，而不仅是代码是否存在或测试是否通过。最终应能按课程连续学习、正确恢复上下文、引用真实材料、保存到正确位置，并诚实报告未完成或不支持的能力。

### 核心要求

- Professor 是可选预设；工具和技能只向 Professor 会话暴露，不影响普通编码会话。
- 中文优先的学术助教，支持讲义学习、问题引导、代码辅导、阅读、翻译、笔记和考试复习。
- 每门课拥有独立身份、材料目录、学习状态和产物归属；多门课程匹配时询问，不猜。
- 生成保存型产物前，本次请求没有明确选择格式，就询问 Markdown / LaTeX。历史选择或配置偏好不等于本次授权。
- 课程资料、原注册表和共享模板保持只读；写笔记不得静默覆盖已有文件。
- 学习状态只在有真实学习证据时更新；注册课程不等于已经学过课程，不得伪造进度。
- 引用和页码来自真实抽取结果；模型补充内容、练习来源、无法读取的材料必须明确区分。
- 迁移时保留课程偏好；迁移旧学习记录需另行核对，不直接覆盖或凭空重建。

不能仅凭现有文档的“基本 1:1”结论就宣布与 Hermes 完全一致。真实使用验收以及下述未完成项仍然重要。

## 2. 项目与运行环境

| 项目 | 当前值 |
|---|---|
| 仓库 | `/Users/<user>/Documents/Project/professor-harness-spike-plugin` |
| 包名 / 版本 | `dsh-professor-spike` / `0.12.0` |
| 宿主 | `/Applications/DeepSeek Harness.app` |
| 桌面 profile | `/Users/<user>/.dsh/profiles/desktop` |
| 安装位置 | `/Users/<user>/.dsh/profiles/desktop/node_modules/dsh-professor-spike` |
| 安装方式 | 符号链接到当前仓库；profile 已配置依赖与 bundle |
| 真实课程项目 | `/Users/<user>/Documents/courses/<academic-folder>` |
| 真实配置 | `/Users/<user>/Documents/courses/<academic-folder>/.professor/project.yaml` |
| 旧课程注册表 | `/Users/<user>/Personal-Agent/01_Learning/Registry` |
| 旧学习记录 | `/Users/<user>/Personal-Agent/01_Learning/Knowledge/<课程代码>` |

源码修改后需要重启 Harness 加载。当前是链接安装，通常不需要卸载或重新下载。不要擅自更换安装方式或修改其他 profile。

当前已注册且 active 的六门课程：CSC3001、CSC3200、CSC4801、GFN1000、PHY1001、STA2001。

## 3. 已实现的能力

当前插件有 15 个 `professor_*` 工具、6 个自带技能。仓库文档将 M0–M12 标记为已实施；这属于开发里程碑，不等同于所有真实场景已经验收。

工具覆盖：

- 项目初始化、课程注册/更新/归档/导入、课程查询。
- 当前会话课程绑定与绑定历史。
- 材料索引、文本抽取、带来源的预算受限检索。
- PROGRESS / KNOWLEDGE / MISTAKES / INDEX 学习状态读写与并发控制。
- Markdown、LaTeX 笔记和考试复习产物生成、产物查询、LaTeX 编译。
- 路径诊断、能力与健康诊断。

六个技能为 course-management、study、notes、review、research、latex，对应目录 `skills/professor-*`。

PDF 和 Office 文本抽取已经有生产路径及真实后端验证。PDF 页码、PPTX slide 坐标来自后端；扫描 PDF / 纯图片不支持 OCR，插件不提供 PDF/PPT 视觉验收。Office 版面信息不完整，DOCX/XLSX 不生成虚构页码。LaTeX 实际编译能力取决于机器上可用工具。

## 4. 本轮实际发现的问题与修复

用户简单测试的对话名为“已注册课程查询”，工作区是上述真实课程项目。最初查询课程，随后授权导入六门课程。本轮用户明确要求修复。

### 4.1 导入返回值被宿主拒绝：已修复并测试

表现：`professor_course_manage import` 报 `INVALID_TOOL_OUTPUT` / `value is not lossless JSON`。

原因：返回对象含 `undefined`，例如 import 分支的 `course`。正式导入可能已经写盘，随后返回值校验才失败。不要误判为“导入完全没发生”。检查表明 dry-run 本身未写入；旧对话把 dry-run 描述成仍会写盘，并不准确。

修复：将未使用的返回值初始化为可序列化的对象/数组。回归覆盖预览、正式导入、重复导入的 JSON 无损往返，并在真实宿主 schema 检查中验证实际返回值。

### 4.2 第一门课配置污染全项目：已修复

旧导入把 CSC3001 的笔记目录、格式和模板提升成全局默认，导致其他课程存在输出到 CSC3001 的风险。

修复：导入保存 `courses[].outputs`、`courses[].notes`；产物创建、LaTeX 和可写路径按所选课程解析；注册时的 notes_root 也属于该课程。新增防护拒绝将某课程产物写入另一课程材料根内。产物状态查询支持课程代码及分课程目录。

### 4.3 附加材料误归 exams：已修复

旧导入无条件把 Additional Course Materials 映射为 exams，污染了 CSC3200 的 `06_Code` 以及 CSC4801/PHY1001 的 `00_Course-Info`。

修复：普通附加材料归 `supplementary`；明确考试目录才归 exams。导入还发现实际存在的常规分类目录，不凭空创建材料目录。

### 4.4 格式门绕过询问：已修复

以前全局 concrete default 可直接选择 LaTeX。现在本次未传明确格式，就返回要求询问的结果且不写产物。每次生成都遵守此规则，而不是只首次询问。

### 4.5 课程偏好丢失与多行配置：已修复保存层

导入保存完整 `registry_fields` 数组，不丢弃 Special Instructions 等原始字段；课程列表可返回课程配置及原始字段。此处“保存可见”不等于已经证明模型在所有教学回答中都会遵守偏好。

预检另发现 YAML 子集无法读回多行说明。已增加安全转义及双引号解析修复，测试覆盖换行、引号、制表符和字面转义。

### 4.6 真实六门课程配置：已修复、保留备份

通过专用脚本预检、验证 YAML 往返和路径安全，再备份并修复现有 project.yaml。保留课程身份、状态、自定义分类和其他配置；各课使用自己的 `04_My-Notes/AI-Notes`。全局误提升的 CSC3001 输出/模板已解除，全局格式设为 ask。重复执行确认 `No changes needed`。

备份：

`/Users/<user>/Documents/courses/<academic-folder>/.professor/project.yaml.before-repair-2026-10-01T11-18-13-108Z.bak`

脚本：`tools/repair-import-config.mjs`，默认 dry-run；只有显式 `--apply` 才备份并修复。修复函数位于 `src/migrations/repair-import.js`。

没有修改原课程材料、旧 Registry 或旧 Knowledge，没有伪造/迁移学习状态。

## 5. 最近验证证据

2026-10-01 本轮运行结果：

- `npm run verify` 成功：语法、技能、同步、分发、端到端和单元测试。
- 端到端场景 **28/28** 通过。
- 最后一次 `npm test`：**215/215** 通过，0 失败。
- `npm run verify:harness` 六段验证均 ALL PASS：预设、profile composition、runtime boot、host schemas、preset activation、desktop activation。
- 真实宿主验证确认 Professor 的 15 个工具及依赖子插件正常激活。
- `git diff --check` 无问题。
- 已退出并重启桌面 Harness，Professor 在恢复的会话中显示为所选预设。

验证日志（临时目录可能被清理，不应当作长期唯一证据）：

```text
/private/tmp/professor-repair-verify.log
/private/tmp/professor-repair-final-tests.log
/private/tmp/professor-repair-harness.log
/private/tmp/professor-config-repair.log
```

宿主激活测试需要临时本机监听权限。在受限沙箱出现 listen EPERM 时，应区分环境权限与插件缺陷。本轮经授权权限执行通过，测试不调用模型，不写真实 desktop profile。

README 首段还写着旧的 209 项测试；应以本轮 215 项实际运行结果为准，后续可以更新文档。任何新修改后必须重新验证，不能沿用此处结果。

## 6. 当前阻塞：旧对话历史无法加载

重启后，原“已注册课程查询”对话出现：

```text
session contains event type "permissionRules/decision" (seq 23)
unknown to this harness and not marked ignorable;
refusing to interpret the log — it was likely written by a newer harness
```

对应 session：`session-a466a3a2-5f5d-45bc-a6c7-f01b1f8b7e33`。

原始日志：

`/Users/<user>/.dsh/sessions/--Users-<user>-Documents-courses-<academic-folder>--/session-a466a3a2-5f5d-45bc-a6c7-f01b1f8b7e33/session.v4.jsonl.zstd`

**已确认的是事件兼容性报错；宿主版本不匹配是待核实方向，不是已经查明的最终原因。** Professor 本身已加载，此错误属于宿主读取历史事件的路径，本轮未修复。

不要删除、过滤或把权限事件强行标记为可忽略来掩盖错误。应先只读核对安装的宿主版本、运行进程和日志 reader 对该事件的支持，再选择兼容版本或受支持的日志恢复方案。任何修改历史前先备份。

临时建议：在同一课程工作区新建 Professor 对话测试。**尚未完成新对话的模型端真实验收**，不要声称已完成。

## 7. Git 状态与保护要求

当前分支 `main`，已保存基线提交：

`f2cbd25 Save Professor plugin v0.12.0 verified baseline`

当前有大量已修改和未跟踪文件，包含之前其他 agent 的成果以及本轮修复；本轮未创建新 Git 提交。用户先前要求过 Git 保存，已有基线，但该提交不包含后续所有修复。

接手前运行 `git status --short` / `git diff`，不要把已有变更当作可清理垃圾。禁止 `reset --hard` 或批量还原。保存新提交前核对范围、验证结果，并遵守用户授权。

## 8. 后续工作的推荐顺序

1. 只读诊断并解决宿主旧对话事件兼容问题，保留原始日志。
2. 在同一课程工作区的新 Professor 对话进行真实验收：课程列表、导入 dry-run、明确课程、查询偏好、未指定格式生成请求应先询问。
3. 用户选择格式后，验证不同课程产物落到各自目录，且不会覆盖已有文件；考试检索不再包含代码/课程介绍。
4. 检查模型是否实际遵守保存的课程偏好。配置保存测试不能代替教学效果测试。
5. 如用户要求恢复旧学习记录，单独设计 Registry/Knowledge 与新状态的映射、冲突处理、备份和 dry-run；未经核对不得自动迁移。
6. 更新文档中的测试数及过度宽泛的完成声明；用户授权时提交当前修复。

## 9. 接手时优先阅读

- `README.md`：安装、工具面、结构和能力边界。
- `docs/PARITY.md`：Hermes / v3 / 插件对照，不应当作独立的最终验收证据。
- `docs/AUDIT.md`、`docs/PLAN.md`、`docs/SKILLS.md`：设计依据与验收映射。
- `src/tools/courses.js`、`src/migrations/personal-agent-registry.js`：导入与课程配置。
- `src/migrations/repair-import.js`、`tools/repair-import-config.mjs`：现有配置修复。
- `src/artifacts/paths.js`、`src/artifacts/format-gate.js`、`src/tools/artifacts.js`：输出隔离和格式询问。
- `src/project/yaml-lite.js`：配置往返。
- `test/migration.test.mjs`、`test/repair-import.test.mjs`、`test/yaml-roundtrip.test.mjs`、`test/artifacts.test.mjs`：本轮核心回归。
- `tools/verify-host-schemas.mjs`、`tools/verify-preset-activation.mjs`、`tools/verify-desktop-activation.mjs`：宿主兼容与激活证据。

交接结论：**本轮发现的插件导入、输出隔离、分类、格式门和偏好保存问题已修复并验证；整体项目不能宣布全部完成，旧对话历史兼容、模型端真实验收、旧学习状态迁移仍需分别处理。**


2026-10-11 material enhancement acceptance: bundled Docling/RapidOCR PDF enhance and hash-locked first-use workspace runtime preparation are now connected. Managed PDFium real scan/table/physical-page tests, warm-cache validation and six authorized model calls completed; latest full verification 685/685, zero skips, distribution and real-host schema checks pass. Final evidence is in docs/qa/2026-10-11-material-reading-takeover/FINAL_REPORT.md. Six-platform manual CI workflow is prepared but not run: no remote repository or Windows/Linux host is connected; Windows ARM64 currently requires x64 Python emulation. Native first-use installed-host acceptance passed: a clean installed plugin automatically prepared its runtime, recovered Chinese/English scan text, reused the prepared environment, and preserved source bytes.

2026-10-11 scope decision: user explicitly deferred cross-platform testing and asked to finish the Mac experience before optimizing the remaining Professor skills. Current Apple Silicon Mac acceptance is complete; Windows/Linux and macOS Intel are unverified, deferred, and no longer active blockers. Begin the next skill with professor-notes, reviewing its contract against artifact tools before changing behavior.

2026-10-11 next-skill repair started with professor-notes: removed the outdated saved-format bypass to match the already-approved explicit format gate (section 4.4), and routed note creation through professor_artifact_create with honest created/files handling. The shared professor-latex format paragraph now matches; other LaTeX workflow content is not yet audited/repaired. Two skill validators, bundled skill verification/sync and 32 relevant artifact/skill tests passed, zero skipped.

2026-10-11 bundled skills alignment complete: notes, LaTeX, review, research and course-management instructions now match the existing tool contracts; see docs/qa/2026-10-11-professor-skills/REPORT.md. Five skill validators, registration/sync checks, 66 targeted tests and full 685-test verification passed with no skips. Final tarball contains exactly six skills byte-identical to current workspace and matching source mapping. Independent review found and prompted correction of registration-time notes_root handling. No new paid model calls or installed-profile mutations; Windows/Linux tests remain deferred.

2026-10-11 teaching-interaction design research requested by user: read actual open-source skills from bstellato/ai-teaching-skills (MIT), Learning Commons agent-skills (Apache-2.0), Jellypod school-skills (MIT), and Gareth Manning education-agent-skills (CC BY-SA 4.0). Proposed bounded design focuses on intent-dependent direct/incremental/check teaching, targeted feedback, hints, optional teach-back/transfer, and assistance-aware state evidence. Research record: docs/qa/2026-10-11-teaching-design/RESEARCH.md and sources.json. No product changes yet; no new paid calls. Source main revisions/date are recorded; immutable commits unresolved, do not claim pinned imports. Avoid rigid answer refusals, forced checks, invented timer triggers, and invalid algebra examples.

2026-10-12 independent teaching-interaction acceptance: targeted 50/50 and fresh full verification 704/704 passed, zero skipped (used existing prepared OCR runtime); E2E/distribution/offline installed self-tests pass. One P2 remains: exam-review preset at src/skills/presets.js:69 requests high-frequency exam topics unconditionally without an evidence condition, conflicting with unconfirmed exam emphasis handling. Review report: docs/qa/2026-10-12-teaching-interaction/REVIEW.md. No product fixes or paid model calls in this review. Live-model behavior remains unverified; earlier six-call authorization exhausted.

2026-10-12 P2 correction independently accepted: exam-review instructions now require frequency evidence, name its scope, separate priorities and disclose missing evidence without blocking review. Fresh 54 targeted and 708 full tests passed with zero skips, E2E/distribution/offline installation pass; final package preset/compose/study bytes match sources and still ships six skills. See docs/qa/2026-10-12-teaching-interaction/REVIEW-2.md. Next-step English prompt is NEXT_STEP_PROMPT.md for eight live-model behavioral cases; proposed max 12 paid requests requires NEW explicit authorization. None executed in this review.

2026-10-12 independent LIVE review REJECTED all-8-pass claim: S7 genuine state_update written:false (missing unit), assisted record says 独立完成; S7/S8 final turns incomplete. S5 recursion example f(0) with increment and base10 actually terminates; S3 exact count contradicts fixture. S2 scope paraphrase screener false-positive is real, but unsupported scoring/error-rate assertions remain. Runner checks isError/proposed args, not domain write success or completed turn. See docs/qa/2026-10-12-teaching-interaction/live-model/INDEPENDENT-REVIEW.md and NEXT_CORRECTION_PROMPT.md. Local 38 tests/syntax passed; zero new model calls. Do not accept the execution report as complete or infer authorization from counter.json alone.

2026-10-12 whole-project review: corrected S7/S8 genuine writes/read-back/final turns verified from report-run3. Latest retest records 6/8 pass with S3/S5 OPEN and reported user Accept-and-close decision; scope closure is not full behavioral success. Found offline aggregator P2: filtered NOT-INCLUDED placeholders overwrite prior actual pass statuses; reproduced without model calls. Fresh full verify 721/721 zero skipped, targeted51, verify:host/home pass; Home browser/model/permanent-delete checks remain unverified. Project is Mac integration acceptance/release preparation, Phase6/7 partial and Phase8 not closed. README/status ledgers stale (including OCR unsupported claim). See docs/qa/2026-10-12-project-status/STATUS.md and NEXT_PROMPT.md. No new paid calls or product edits in this review.
