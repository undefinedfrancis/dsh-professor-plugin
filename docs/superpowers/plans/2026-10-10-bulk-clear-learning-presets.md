# 实施计划：批量清除最近对话 + 学习预设库

日期：2026-10-10（Asia/Shanghai） · 依据 `docs/superpowers/specs/2026-10-10-bulk-clear-learning-presets-design.md`
基线：HEAD `b8850eb`（未提交工作区，含既有改动）；历史基线 521 单测 / 28 E2E / 127 verify:home，需新鲜重测。

## 1. 变更文件

| 文件 | 变更 |
|---|---|
| `src/app/home.js` | 抽取单会话清除内核 `clearRow(row)`（复用既有安全语义）；新增 bulk：`clearAllSnapshot` / `clearAllStart` / `clearAllContinue`（快照令牌、操作句柄、顺序批处理、逐项容错） |
| `src/app/presets.js`（新） | 学习预设库模块：schema/校验/CRUD/乐观并发/applied 元数据（不动 customization 记录） |
| `src/skills/presets.js`（新） | 五个内置预设定义（不可变、离线；provenance 字段） |
| `src/app/views.js` | `presetLibrary` 读模型 + `presetSave/Delete/Apply` 经 customization store 落地；settings 响应附 applied 状态 |
| `src/app/remote.js` | 7 个新 strict 端点（clearAllSnapshot/Start/Continue、presetLibrary/Save/Delete/Apply）+ 受限 codec |
| `client/remote.js` + `client/client.js` 内嵌 | 与后端逐字段一致的契约（parity 测试钉住） |
| `src/plugin.js` | 装配 preset store 进 views/remote service；resolveCustomization 对「全新用户」注入默认预设字段（组合层，不落盘） |
| `client/client.js` | Recent 标题旁「全部清除」+ 确认对话框 + 进度/部分失败；设置页「学习预设」区（选择/预览/使用/新建/另存为/编辑/删除/恢复自动/已自定义） |
| `package.json` | `files` 增加 `THIRD_PARTY_LICENSES.md` |
| `THIRD_PARTY_LICENSES.md`（新） | 第三方来源署名/许可证声明（如有采用；否则声明全原创） |
| `tools/verify-home.mjs` | 新增 section 12：一次性会话批量清除 + 预设下次组合生效（真实宿主） |
| `tools/verify-distribution.mjs` | 断言打包产物含预设资产与许可证声明 |
| 测试（新/扩） | `test/bulk-clear.test.mjs`、`test/presets.test.mjs`（新）；扩展 `app-home`、`clear-existence-probe`、`app-view-remote`、`client-bundle`、`skill-customization-compose` |
| `docs/qa/2026-10-10-bulk-clear-learning-presets/` | REPORT.md、SOURCES.md、evidence/ |

## 2. 复用（不新建竞争管线）

- 单会话清除安全语义（present→先归档后墓碑 / absent→陈旧清理 / unknown→安全失败 / active→拒绝 / preparing→跳过 / 外来 ID→拒绝 / 墓碑防复活）：bulk 逐项调用同一内核。
- 原生适配器 `workspaceRegistry.archiveSession(id, { stopActivity:false })`、`probeSession` 三态：原样复用。
- 偏好管线：`createSkillCustomizationStore`（revision/evidence 门禁）、`composeSkill`、`resolveCustomization` 装配点；预设激活=写 customization overlay 快照，绝不改技能内容/课程身份/权限。
- 确认对话框 ConfirmDialog（焦点陷阱/Escape/焦点归还）；`HOME_RECENT_LIMIT` 截断只影响展示，快照取全量非归档行。

## 3. 数据 schema 与远程契约

**用户预设库**（app 存储域，独立键 `presets:library`，profile 级）：
`{ schema: 'professor.presets/1', revision: <int≥1>, presets: [ { id: ^[a-z0-9][a-z0-9-]{0,63}$, name≤80, description≤240, fields: validateCustomizationFields（含 additionalInstructions≤2048，绝不截断）, version: int≥1, provenance≤240? } ] }`，≤50 条；损坏/不支持 schema → `PROFESSOR_PRESETS_CORRUPT/UNSUPPORTED`，绝不覆写；写入用乐观 `expectedRevision`。

**applied 元数据**（独立键，additive）：`presetApplied:<customizationKey>` → `{ schema:'professor.preset-applied/1', presetId, presetVersion, overlayRevision, fields 快照 }`。旧 customization 记录逐字节兼容。手动保存偏好后 UI 比对快照显示「已自定义」；编辑/删除库定义不触碰已应用快照；课程作用域沿用 `namespace+courseId`；删课不动库。

**远程（全部 strict、有界）**：
- `clearAllSnapshot {}` → `{ token, count, previews≤5, expiresAt }`（服务端快照全部非归档行，单次有效、约 2 分钟过期、内存态）
- `clearAllStart { token }` → `{ operationId, outcomes≤5, counts{cleared,skipped,failed,remaining}, done }`（消费 token 恰一次）
- `clearAllContinue { operationId }` → 同上（同一快照游标续跑；并发重复请求合并/拒绝；句柄过期→报错不扩容）
- `presetLibrary { skill?, courseId? }` → `{ bundled, user≤50, userRevision, applied }`
- `presetSave { definition, expectedRevision }` → `{ userRevision }`（内置 id 拒绝覆写）
- `presetDelete { presetId, expectedRevision, confirmed:true }` → `{ userRevision }`
- `presetApply { presetId, courseId?, expectedRevision }` → `{ overlayRevision, applied }`（快照写入 professor-study overlay；保存≠激活）

## 4. 实施顺序

1. 抽取 `clearRow` 内核 → bulk 后端（快照/令牌/操作句柄/批）→ 后端测试
2. remote 三层契约（后端/导出/内嵌）→ parity + codec 测试
3. bulk UI（全部清除/确认/进度/部分失败/重试）→ client-bundle 测试
4. `src/skills/presets.js` 内置定义 + `src/app/presets.js` 库模块 → 库测试
5. views/remote preset 端点 + apply 落地 customization + applied 元数据 → 测试
6. 组合集成：resolveCustomization 默认注入 + 下次 get() 生效测试
7. 设置页 UI（学习预设）→ client-bundle 测试
8. 打包（THIRD_PARTY_LICENSES.md、dist 断言）；verify-home section 12
9. Stage 3 来源研究（真实检索，SOURCES.md）——与基础设施并行，未验证不引入第三方内容
10. 全量验证 + 报告

## 5. 回归测试清单（要点）

Bulk：超展示上限行数全含；无外来/原生-only 会话；快照后新建会话不入；取消零请求；精确 N 计数确认；双击/重复请求单次执行；混合成功/active/preparing/失败逐项结果；unknown 不隐藏未归档聊天（适配器+Home 联合）；归档失败保留行；令牌校验/过期/重放/续跑范围；批处理续跑；墓碑防 launch 复活；原生归档可恢复；无关会话与课程数据不变。
Presets：五内置离线可用；选择/预览/应用与下次组合一致；不触发重选课程；新建/编辑/复制/删除跨重启持久；删除库定义不影响已应用快照；revision 拒绝陈旧写；全局/课程隔离；手动编辑显示已自定义；旧偏好数据保留；恶意文本不能改权限/课程身份；2048 预算；分发含 provenance/许可证。

## 6. 第三方来源门禁（Stage 3）

候选（2026-10-10 已知）：Jellypod-Inc/school-skills（MIT、7 stars）、benrosche/socratic-tutor（MIT、2 stars、含 server 依赖）、ClawHub jiangkaiqi2005/study-tutor（未验证）。要求：真实扩展检索 GitHub/ClawHub；记录 URL/作者/行为/stars·downloads·ratings+采集日期/指标归属（仓库 vs 单技能）/许可证文件 URL/锁定 commit/依赖与外部服务/取舍理由。选定者按不可信内容审读、核验 LICENSE 文件（README 徽章不足）、去安装/遥测/破坏性/权限变更/重选课程指令，仅导入教学偏好并保留署名。**不可验证足够流行且可再分发 → 不静默替代**：内置五模式以原创定义交付，SOURCES.md 如实记录限制并在最终报告征求用户决定。

## 7. 验证与 UI 验收

验证：聚焦测试 → 全量单测 → syntax/skills/sync → 远程 parity → dist（打包安装断言）→ E2E → verify:home（含新 section 12）。全部一次性夹具/隔离 profile。
UI 验收：宽/窄、明/暗（如安全可用）、长中英文名、Recent 进度与确认/错误态、预设编辑器/预览、键盘与焦点恢复。视觉渲染无安全环境则标 NOT TESTED，不用组件测试冒充。真实桌面对话零变更；模型教学回答维持 NOT TESTED（禁付费调用）。
