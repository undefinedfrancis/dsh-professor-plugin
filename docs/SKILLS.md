# Professor 技能目录（M4）

本 bundle 随包发布 **6 个**技能，全部以 `professor-` 前缀命名，来源是 Hermes Professor 人格（`SOUL.md`）与 Personal-Agent 的技能/代理文档。所有技能的 `invocation` 保持 Harness 默认（`modelInvocable: true`、`userInvocable: true`）。

## 目录

| 技能 | 用途 | 上游来源 |
|---|---|---|
| `professor-course-management` | 课程身份、路径、注册表、生命周期、Knowledge 初始化、INDEX 结构同步。**不教学、不写笔记。** | `05_Skills/learning/course-manager`、`01_Learning/Registry/{COURSES.md,COURSES_TEMPLATE.md}` |
| `professor-study` | 教学本身：PPT / PROBLEM / CODING-TUTOR / READING / TRANSLATE 五种模式、恢复顺序、轻量提问判定、提示梯度、证据门槛的状态更新、续学。 | `study-session`、`04_Agents/Learning-Agent/{MODES,SYSTEM}.md`、SOUL.md |
| `professor-notes` | 笔记生成：格式门、输出位置、绝不静默覆盖、溯源分离、深挖标记、配套状态更新。 | `notes-manager`、`course-manager` |
| `professor-review` | 考试复习：证据驱动的优先级图、小块引导循环、练习题标注、独立复习产物。 | SOUL.md（复习行为仅存在于人格文档）、`notes-manager` |
| `professor-research` | 联网检索的触发条件、证据记录协议、引用与引用节制、课程材料优先。 | `research/web-research-evidence` |
| `professor-latex` | LaTeX：解析并**复制**模板、生成契约、静态审查、编译门、诚实结论行。 | `latex-notes-quality`、`notes-manager`、`06_Shared/Templates/LaTeX/Course-Notes/Default/*` |

## 兼容别名：不提供

**决策：不发布任何别名**，6 个 `professor-*` 就是全部目录。理由是用户把本插件限定为「课程 Professor」，再挂 5 个别名会让目录重新膨胀成两套名字。

迁移对照（仅文档用途，不随包提供）：

| 旧技能名 | 现在 |
|---|---|
| `study-session` | `professor-study` |
| `notes-manage` | `professor-notes` |
| `courses-manage`（源目录名 `course-manager`） | `professor-course-management` |
| `latex-notes-quality` | `professor-latex` |
| `web-research-evidence` | `professor-research` |
| （无上游对应） | `professor-review` |

## 刻意排除的上游技能

`algorithm-coach`、`agent-handoff`、`hermes-routing`、`project-discovery`、`project-orchestrator`、`project-verification`、`safe-opencode-execution`。

理由：Algorithm Coach 在 Hermes 中是**另一个 bot**（独立身份与记忆），其余是项目开发工作流。把它们纳入会让学术核心行为被稀释，也不符合「只要课程 Professor」的范围决定。校验器会确保它们不会随包发布。

## 有意偏离（逐条）

1. **课程模板文件名**：上游技能引用 `COURSE_TEMPLATE.md`，而注册表里的真实文件名是 `COURSES_TEMPLATE.md`。插件采用**真实文件名**，因此与磁盘一致而不是与上游笔误一致。
2. **模式目录与教学流程合并**：上游把模式目录（`MODES.md`）与会话流程（`study-session`）分开；插件合并为一个 `professor-study`，因为预设只暴露一个学习入口。
3. **教学文本从笔记技能中剥离**：上游 `notes-manager` 同时承担教学；这里移到 `professor-study`，`professor-notes` 只管产物。
4. **格式门取值语义**：上游注册表字段可能写 `Ask every time`；插件执行「字面值为 `LaTeX`/`Markdown` 才自动采用，否则每次询问」。
5. **复习行为成为独立技能**：上游复习行为只写在人格文档里；插件把它显式化为按需加载的技能。
6. **路径参数化**：默认 LaTeX 模板等路径写成 `${PERSONAL_AGENT_ROOT}/...`，由插件在交付时注入真实值，而不是写死个人绝对路径。
7. **编译经 Harness shell**：Harness 没有 LaTeX 能力seam，编译走 `tool-bash`；技能保留上游要求的诚实结论行（未执行就必须说未执行）。

## 同步与偏离校验

```bash
node tools/verify-skill-sync.mjs          # 79 项检查
node tools/verify-skill-sync.mjs --skill professor-notes
```

`tools/skill-sources.json` 为每个技能声明**双侧锚点**：

- `sourceAnchor` 必须在**上游文件**中仍然命中——上游规则一旦改动，这里就会失败，强制重新审阅移植，而不是悄悄漂移；
- `pluginPattern` 必须在**随包技能**中命中——重构时若丢了某个行为，也会失败。

校验器同时强制目录形状：恰好 6 个技能、frontmatter 合法（name 与目录一致、description 可用、kebab-case）、被排除的上游技能不得随包。

上游文件不存在时报告 `SKIP`（该机器没有依赖工作区），但**存在却不再匹配**一律 `FAIL`。

## 维护规则

2026-10-15 LaTeX 内容接口接管：`professor-latex` 与 `professor-notes` 优先使用
`sections/examples/derivations[].body_tex` 在创建时直接生成公式、表格、提示框和图示；仅
`format: "latex"` 接受此例外，普通 `body` 继续转义，Markdown 不使用该字段。片段验证只检查
文档边界、环境平衡和 shell escape；不代替公式审查、编译和 PDF 图像检查。模板与课程源文件只读。
`failure_class: environment` 时停止修文档并报告环境阻塞；部分页面检查须报告覆盖范围。
记录检查后只有返回 `reused_prior_compile: true` 才能确认未重复编译：来源指纹与实际 PDF 哈希
均需一致；来源/PDF 改变或预检查不确定时重新取得编译及图像证据。
对照与本地 reference application 见 `docs/qa/2026-10-15-latex-takeover/skill-application.md`；
未运行付费 Harness 模型，不将静态应用等同于真实模型行为验收。

2026-10-15：默认 LaTeX 项目采用随包的 `resources/latex/default/main.tex`，基于用户提供的
`CSC3001note2.tex`：双行大标题、横线、紧凑段落，新增较大的蓝色主标题、粗体小标题与
「重点 / 注意 / 例题」提示框，保留代码、表格和 TikZ 支持。原文件单独作为参考随包保留；
生成时课程、标题和学期来自当前元数据，不继承参考文件的课程和作者。已配置且可用的自定义模板
仍优先。`professor-latex` 明确默认文件和环境名称，数学、表格与图示优先通过 LaTeX 专用 `body_tex` 片段生成，后续修改仅在生成副本里完成；编译成功
与 PDF 版式检查仍分别验证。生成中文默认项目需要 XeLaTeX 和 TeX 分发里的 Fandol 字体。

2026-10-14：`professor-study` 与 `professor-notes` 加强讲解深度：从前置知识和符号含义出发，
给出推导依据、贯穿的具体例子、可使用的知识联系、适用条件与边界，以及迁移到同类问题的方法。
普通的「讲一下这页」和学习笔记请求也适用；明确要求简短、提示、检查、翻译或公式速查时，保留该范围。
内置「循序讲解」升级为 version 2，默认深度为「深入，逐步解释原理和推导」。
既有保存偏好仍是快照，不会被自动覆盖；需要新版预设时，在教学设置中重新应用「循序讲解」。
已加载技能的旧会话可能继续沿用旧文本，建议在新 Professor 会话中验证。源码链接安装读取当前目录；
以 tarball 安装的副本需要先更新插件包并重启。

验收采用相同材料和问题的讲解样例对比，并单独检查简短回答、只要提示和公式速查的范围。
样例是显式提供技能的 Codex 子代理模拟；它们不等于所配置模型在真实 Harness 中自动加载技能的验收。

同日版式补充：内置「循序讲解」为 version 3。完整讲解采用一级主题标题与二级主要小标题，
关键结论选择性加粗，少量使用「直觉 / 重点 / 注意」标记，并明确说明每步求什么、为什么成立及结果含义。
图表服务于推理：优先可直接阅读的表格、分支图和过程图；复杂图片须实际生成并检查，不能链接占位路径。
数学、颜色和图示语法适配目标显示器；不支持或支持未确认时，采用可读符号与文字，不把裸 LaTeX、HTML
或 Mermaid 当作已显示的内容。Markdown 表格中的条件概率竖线须转义，避免拆成错误的列。
这轮没有修改宿主的全局字体或样式；具体字号由宿主决定。保存过的预设仍需重新应用才能切到新版快照。

2026-10-12：`professor-study` 与四个教学预设按批准的教学交互设计（`docs/qa/2026-10-11-teaching-design/RESEARCH.md`）
更新：尊重当前请求（完整讲解 / 递进教学 / 理解检查 / 只要提示）、循序渐进（直觉+例子→定义/假设/关键推理、
从已有作答出发）、四级帮助阶梯（概念提示→局部步骤→部分演示→完整讲解，禁止固定轮数/计时门槛）、
可跳过的定向理解检查（禁止例行「理解了吗」结尾）、首缺口具体反馈（接受替代正确解法）、
以及诚实学习证据（自述 / 有帮助完成 / 独立完成三者区分，沿用 none/weak/strong 与既有字段）。
所有新措辞均为 Professor 原创（`original:professor-v1`）；设计参考的四个开源仓库及其许可证见
`THIRD_PARTY_LICENSES.md`，未复制或改编任何第三方原文。回归测试见 `test/teaching-interaction.test.mjs`
（静态指令覆盖，非模型行为验收）。

2026-10-11：`professor-study` 已接入插件内置 `professor_material_read` 的
plan → text → 按需 enhance/pages → notes/status → 教学流程。正文读取有字符游标和上限；
独立文件不要求课程注册。PDF 图像送达与模型理解分开表述。Docling/RapidOCR 增强已接入，
首次使用自动准备工作区私有缓存（需要宿主 Python 3.12 和下载网络），依赖与模型固定版本并校验。
Windows ARM64 需要 x64 Python 模拟运行；真实 Windows/Linux 宿主验收仍须单独完成，不能仅凭锁文件宣称全平台验收通过。

- 修改任何随包技能后，必须跑 `verify-skill-sync.mjs`。
- 若确属有意修改，更新 `skill-sources.json` 中对应的 `sourceAnchor`/`pluginPattern`，并在该技能的 `divergences` 里写明原因。
- 新增技能必须同时补 `skills` 映射、更新本文档的目录表，并确保 `verify-plugin-skills.mjs` 的期望清单同步。
