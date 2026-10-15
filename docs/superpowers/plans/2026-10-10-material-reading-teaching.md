# 实施计划：材料识别增强与教学衔接（material-reading-teaching）· 第 2 修订版

2026-10-11 接手更新：用户已授权直接接手。现有材料台账生产代码已接通独立文件与正文
读取，`professor-study` 已明确读取→教学流程；本次 641/641 测试与分发校验通过。
本计划后面的“未改生产代码”属于此前调查轮的历史记录，不代表当前状态。
OCR 自动增强、全平台制备及真机/模型验收仍未完成，详见
`docs/qa/2026-10-11-material-reading-takeover/REPORT.md`。不得据本次核心回归通过宣称全平台完成。

日期：2026-10-10（Asia/Shanghai）
批准设计：`docs/superpowers/specs/2026-10-10-material-reading-teaching-design.md`（方向已批准）
上一版计划：本文件（第 1 修订版）；本轮依据六项评审意见与实验证据再次修订。
性质：**调查 + 受控实验 + 可执行实施计划**。**未改动任何生产代码、技能正文或真实桌面安装**。
基线：分支 `feature/professor-portable-app`，HEAD `b8850eb`；工作树既有未提交改动与未跟踪文件**全部保留**（未 reset/clean/restore）。本轮仅新增 `docs/qa/2026-10-10-material-reading-teaching/EXPERIMENTS.md` 并修订本文件。
**本计划状态：BLOCKED pending specified investigation（见 §13）**——不是 implementation-ready。

证据仓库：`docs/qa/2026-10-10-material-reading-teaching/EXPERIMENTS.md`（复现命令、版本、产物路径、观测结果）。
临时产物 `/tmp/prof-onnx-exp-1/` 可弃置，**不是**决策的唯一支撑。

---

## 0. 相对上一版的更正

| # | 上一版说法 | 本轮更正 | 证据 |
|---|---|---|---|
| C17 | 「profile-N（ONNX-only）为候选通用档案，E3 再定」 | **已实验否定**：docling 2.137.0 `StandardPdfPipeline` 运行期无条件 `import torch`（`accelerator_utils.decide_device:23`，被 RapidOCR/版面 ONNX 引擎/TableFormer 共同调用）→ profile-N ImportError 级不可用 | 【E4】EXPERIMENTS §X1 |
| C18 | 「B1：macOS x64 装不上（docling-parse ≥7.22.1 无 mac x86_64 轮子）」 | **降级为"质量闸"而非"安装闸"**：`uv pip compile --python-platform x86_64-apple-darwin --no-build` **解析成功**（torch 2.2.2 + torchvision 0.17.2 + onnxruntime 1.23.2 + opencv 4.11.0.86 + pypdfium2）。改用 pypdfium2 后端即可绕开 docling-parse；但**该后端与 docling-parse 行为不等价**（本样本阅读顺序一过一不过） | 【E3/E4】§X2、§X3 |
| C19 | 「B3：Windows/Linux 宿主是否存在未证实（feed 探测不可靠）」 | **已证实三套官方桌面构建**：mac-arm64 / mac-x64 / win-x64（feed 含 sha512+size+releaseDate）；linux-x64、linux-arm64、win-arm64 **404**。Linux 另有 npm `@deepseek-ai/dsh@0.2.0-rc.2` CLI 宿主（装载插件能力【待验】） | 【E2】§X4 |
| C20 | 「Windows 无 shell 接缝」（第 1 版遗留） | 维持更正：`ctx.shell` 在 win32 由 pwsh 提供；但**插件 POSIX 引号在 pwsh 下不成立**，必须方言化 | 【E1】§X5 |
| C21 | 「每次读取都要 `allowed-once`，审批不可用即拒绝」 | **错**。宿主原生 `read` 工具**从不请求审批**（`resolveRegularReadTarget` → `readText`，仅查 not-found/not-regular）；fs 沙箱只拦写。读根内读取**不得**触发新确认；只有越出读根的扩展才请求审批 | 【E1】§X6 |
| C22 | 「视觉尝试预算存在**文档缓存**里，耗尽后该文档不再投递图像」 | **错**：把一次性操作预算写进共享缓存会让后续读取永久失能。改为**按读取操作**（`op_id`）计账，缓存与操作态分离 | §6 |
| C23 | 「用 Python 下载并准备 Python」 | **自举无 Python**：`ctx.shell` + `curl`/`Invoke-WebRequest` + `tar` + sha256 取 CPython，再用该 Python 装 wheel；沙箱**不含网络限制**（`dsh-sandbox/README.md:167`），`ctx.fs` 无二进制写 | 【E1/E4】§X7、§4 |
| C24 | 「安装到 `~/.dsh/…`」 | 维持：默认 `workspace-write` 写不进（`writableRoots` = workspace+`/tmp`+`os.tmpdir()`），须走宿主升级授权；**绝不写入共享宿主运行时**（`<app>/Resources/runtime`、`$DSH_HOME/dsh-runtimes/dsh-primary-runtime`） | 【E1】§4.3 |
| C25 | 「模型表把"安装/解析/渲染/取消/恢复/离线"塞在同一格」 | 拆成**七级证据 × 六平台 × 逐能力**（§2、§10） | §2 |
| C26 | 「OCR 阈值 ≤3.0%、双栏逆序 ≤0.5% 等直接可用」 | **未经标注语料标定**；本样本 OCR CER 实测 **0.126**（两后端相同），远高于草案阈值 ⇒ 阈值须先做基线标定（T13a）后冻结 | 【E4】§X2、§12 |
| C27 | 「docling 表格 4×3 全对（沿用旧实验）」 | **旧结论不成立**：本轮两后端在本样本均导出 **0 行 0 列**（版面已给 table bbox）。须在标注语料重测 | 【E4】§X2 |
| C28 | 「RapidOCR `lang=['en','ch_sim']`」 | docling 2.137 只接受 `iso:*`，且**一次一种语言**；`ch_sim` 直接抛 `OcrLanguageNotSupportedError` | 【E4】§X2 |

---

## 1. 证据分级（本轮统一口径）

| 级 | 含义 | 本轮是否达到 |
|---|---|---|
| **E1** | 代码/文档检查（宿主 asar、包源码、本仓库源码，只读） | ✅ 大量 |
| **E2** | 包/发布元数据检查（PyPI JSON、GitHub Releases、npm registry、厂商 feed） | ✅ 大量 |
| **E3** | 依赖解析验证（`uv pip compile --python-platform … --no-build`，禁止源码构建） | ✅ 六平台中的 5 成功、1 失败（有求解器原文） |
| **E4** | 受控执行（本机一次性 /tmp 环境，合成样本） | ✅ macOS arm64 |
| **E5** | 真实宿主执行（在真实 Harness 运行时里跑） | ⬜ 本轮未做 |
| **E6** | 清洁安装验收（全新 `DSH_HOME` → 功能可用） | ⬜ |
| **E7** | 真实模型图像交付与解释（需用户授权的模型调用） | ⬜ |

**规则**：任何"支持/已验证/就绪"的说法必须标注到上表的某一级；**E2/E3 不能升格为"已支持"**。旧的合成解析实验只证明**解析机制**，**不证明**自动制备、取消、恢复、清洁安装。

---

## 2. 平台矩阵（能力 × 证据级，逐格独立）

状态：`✅E级` 已达成该级｜`⬜E级` 未达成｜`❌` 已证否｜`BLOCKER` 见 §13。

### 2.1 宿主层

| 能力 | macOS arm64 | macOS x64 | Windows x64 | Windows arm64 | Linux x64 | Linux arm64 |
|---|---|---|---|---|---|---|
| 官方构建存在 | ✅E2（374,053,565 B，sha512 在 feed） | ✅E2（390,853,725 B） | ✅E2（289,313,640 B） | ❌E2（404）→ **B3** | ❌E2（404，桌面）→ **B4** | ❌E2（404，桌面）→ **B4** |
| 替代宿主 | — | — | — | — | ⬜E2 npm `@deepseek-ai/dsh@0.2.0-rc.2` 存在；装载插件 ⬜E5 → **B4** | 同左 |
| `ctx.shell` 实现 | ✅E1 bash-sandbox | ✅E1 bash-sandbox | ✅E1 pwsh-sandbox（`-Command` 单 argv） | ⬜（依赖 B3） | ⬜ | ⬜ |
| 插件命令引号正确 | ✅E1 POSIX | ✅E1 POSIX | ⬜ **需方言化后 E5**（C20） | ⬜ | ⬜ | ⬜ |
| 载荷 Python 路径 | ✅E4 `…/python/bin/python3` 3.12.14 实测 | ⬜E5 | ⬜E5（期望 `dependencies/python/python.exe`，源码已核） | ⬜ | ⬜ | ⬜ |
| 宿主下载 Python 运行时 | ❌E1（不存在该机制）→ 走 §4 自举 | ❌E1 | ❌E1 | ❌E1 | ❌E1 | ❌E1 |

### 2.2 Tier A（基础：文字层 / 结构 / 渲染，不含 OCR）

| 能力 | macOS arm64 | macOS x64 | Windows x64 | Windows arm64 | Linux x64 | Linux arm64 |
|---|---|---|---|---|---|---|
| pymupdf 轮子 | ✅E2 | ✅E2 `macosx_10_15_x86_64` | ✅E2 | ✅E2（原生）/ ✅E2 `win_amd64`（模拟） | ✅E2 | ✅E2 |
| 依赖解析（wheels-only） | ⬜（Tier A 单独锁，T0 生成） | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 文字层解析 | ✅E4（既往实验） | ⬜E4/Z1 | ⬜E5/Z2 | ⬜E5/Z3 | ⬜E5/Z4 | ⬜E5/Z4 |
| 页渲染（≤2000px PNG） | ✅E4（本轮未单测，沿用 PyMuPDF 能力） | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 取消 / 超时 | ⬜E5（`exec.signal` 链路 E1 已核） | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 恢复（缓存/环境损坏） | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 离线 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### 2.3 Tier B（增强：OCR + 版面 + 表格 + bbox）

| 能力 | macOS arm64 | macOS x64 | Windows x64 | Windows arm64 | Linux x64 | Linux arm64 |
|---|---|---|---|---|---|---|
| 依赖解析（wheels-only, cp312） | ✅E3（79 包） | ✅E3（78 包） | ✅E3（79 包） | ❌E3 原生（求解器：无 `win_arm64` torch）→ 改用 x64 目标解析 ✅E3 → **B3** | ✅E3（96 包） | ✅E3（96 包，需剔除 `models-onnxruntime`） |
| 实装 + 跑通（pypdfium2 后端） | ✅E4（X2） | ⬜E4/Z1 | ⬜E5/Z2 | ⬜E5/Z3 | ⬜E5/Z4 | ⬜E5/Z4 |
| OCR 功能 | ✅E4（输出非空，中英均恢复） | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 版面 | ✅E4 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 表格结构 | ❌E4 本样本 0 行 0 列（两后端）→ **B5** | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 阅读顺序达标 | ⬜E4 本样本 pypdfium2 **不达标**、docling-parse 达标 → **B5** | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 取消 / 超时 / 恢复 / 离线 | ⬜E5 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 清洁安装 | ⬜E6 | ⬜E6/Z1 | ⬜E6/Z2 | ⬜E6/Z3 | ⬜E6/Z4 | ⬜E6/Z4 |

### 2.4 视觉与教学

| 能力 | 证据 |
|---|---|
| 工具结果携带 ImageBlock 送达链路 | ✅E1（`dsh-tools` render → `ToolResultMessage`；DeepSeek 适配器 `tool_result` 内容含图；pi-ai 适配器追加独立 user 消息） |
| 能力门禁与纯文本降级 | ✅E1（`resolveModelInfo` → `inputModalities.includes('image')`） |
| **真实模型收到并正确解释图像** | ⬜**E7 / Z6（需用户授权）** |
| 教学行为（起讲位置、原文/补充分离、不编造） | ⬜**E7 / Z6** |

### 2.5 最低系统版本（由所选轮子 tag 推导，【E3/E2】）

| 平台 | 约束 | 最低 |
|---|---|---|
| macOS arm64 | `onnxruntime 1.23.2`、`opencv 5.0.0.93`、`pypdfium2 5.14.0` → `macosx_13_0_arm64` | **macOS 13** |
| macOS x64 | 同上 `macosx_13_0_x86_64`；`torch 2.2.2` → `macosx_10_9_x86_64` | **macOS 13** |
| Linux x64/arm64 | `torch`/`onnxruntime`/`numpy`/`scipy`/`opencv` → `manylinux_2_28_*` | **glibc ≥ 2.28**（Ubuntu 20.04+/Debian 11+/RHEL8+）；**musl 不支持** |
| Windows x64 | `win_amd64` 轮子不编码 OS 版本 | **Windows 10 x64+**【E2 推断，Z2 确认】 |
| Windows arm64 | x64 模拟层 | **Windows 11 ARM64**【Z3 确认】 |

> uv 对 macOS **不接受目标版本**（默认 `macosx_13_0_*`），故 darwin-arm64 锁到 torch 2.11.0 而非 2.14.1——与"最低 macOS 13"一致，作为锁文件生成口径写死。

---

## 3. 后端与分发策略（本轮定案）

### 3.1 选定：**Profile-B（torch）+ pypdfium2 统一 PDF 后端**

```
Tier A : PyMuPDF（文字层 / 结构块 / find_tables / 页栅格化 / 加密检测）        —— 六平台必达
Tier B : docling-slim[format-pdf-pypdfium2,feat-ocr-rapidocr-onnx,convert-core]
         + docling-ibm-models + torch + torchvision + onnxruntime + RapidOCR(onnx)
         PDF 后端 = PyPdfiumDocumentBackend（显式传入，默认是 docling-parse）
```

**理由（均有证据）**
1. **profile-N 被实验证否**（C17）——torch 是运行期硬依赖，不是可选优化。
2. **pypdfium2 让六平台都可能落地**：docling-parse 在 macOS x64 缺轮子是既成事实；统一后端 = **六平台同一行为**，避免"各平台结果不同"。
3. **macOS x64 依赖可解**：`torch==2.2.2`（docling 下界）+ `torchvision==0.17.2` + `onnxruntime==1.23.2` + `opencv==4.11.0.86` 全部有 mac x86_64 轮子，且 wheels-only 解析成功。
4. **Windows arm64 走 x64 模拟**：以 `--python-platform x86_64-pc-windows-msvc` 生成锁，配 x64 CPython，Win11 ARM64 模拟执行。

### 3.2 质量闸（决定是否改回 docling-parse）

- **T13a** 在标注样本集上跑两个变体：`pypdfium2` 与 `docling-parse`（有轮子的平台），逐维记录阅读顺序/表格/OCR/坐标。
- **判定**：若 pypdfium2 满足 §12 阈值 → 维持统一 pypdfium2（**首选，六平台同行为**）。
- 若 pypdfium2 阅读顺序或表格不达标而 docling-parse 达标 → **切换为 docling-parse 统一后端**，其 macOS x64 缺口由**自建 `docling-parse` macOS x86_64 轮子**（CI Intel runner 构建，随离线包分发）解决；该轮子的构建与再分发许可须先核实（MIT 上游，需读 LICENSE）。
- 若两者都不达标 → 触发 B 计划（MinerU 4.0.11 同集对比，含许可与体积重审），由用户裁决。
- **任何变体在六平台必须同后端**；不允许"某平台悄悄降级"。

### 3.3 分发

- 插件包 `package.json#files` 增 `resources/enhance/**`（每平台锁文件、模型清单、许可证、离线校验清单）。
- **在线**：首次使用受控下载（清单 + sha256 + 重试 + 原子激活）；宣传口径写明首次联网与磁盘量。
- **离线**：`dist/professor-enhance-<os>-<arch>.tar.zst` = CPython + wheelhouse + 权重 + 许可证 + `SHA256SUMS`。
- **在线第三方识别回退**：v1 不启用；启用时必须披露 provider 设置、联网、按页计费、上传页范围，并明示**不等价于离线本地能力**。不内置任何账号密钥。

---

## 4. 运行时自举（不假设 Python 存在）

### 4.1 两阶段

| 阶段 | 前提 | 机制 |
|---|---|---|
| **S0 取运行时（无 Python）** | 仅有宿主 `ctx.shell` | 经 `ctx.shell` 执行平台下载器：POSIX `curl -fsSL --retry 3 -o <staging>.part <url>`；Windows `pwsh -Command "Invoke-WebRequest -Uri … -OutFile …"`（或 `curl.exe`，Win10 1803+ 自带）。随后 `shasum -a 256` / `Get-FileHash` 比对清单 sha256，`tar -xzf`（POSIX bsdtar / Windows 自带 `tar.exe`）解出 CPython，执行 `<runtime>/bin/python3 -V` 探针，通过后 `rename` 原子激活 |
| **S1 装依赖（有 Python）** | S0 完成 | `python -m pip install --require-hashes --no-index --find-links <wheelhouse> -r <lock>`（在线时先按清单下载 wheel，同样在 shell 侧落盘校验） |

- **为何必须经 `ctx.shell`**：`ctx.fs` **无二进制写**（只有 `writeText`/`readBytes`），插件自身无法落盘字节；shell 侧进程可以。
- **网络**：沙箱**不约束网络**（`dsh-sandbox/README.md:167`）→ 下载可达；代理走环境变量（curl）/ 系统代理（pwsh）。
- **权限从属**：全部动作在沙箱执行；写入目标在 `writableRoots` 之外时必须先取得宿主升级授权（§4.3）。**不使用** `ctx.subprocess` 绕过沙箱。
- **禁止**：写入或修改 `<app>/Resources/runtime/**`、`$DSH_HOME/dsh-runtimes/dsh-primary-runtime/**`（共享宿主运行时只读使用）。

### 4.2 运行时来源优先序

1. `DSH_PROFESSOR_PYTHON`（操作者显式覆盖，永远优先）
2. 载荷 Python（`workspace-dependencies` 同款布局；Windows `dependencies/python/python.exe`，POSIX `…/bin/python3`；必须 `probe_python` 通过）
3. **自举 CPython**：`astral-sh/python-build-standalone`，钉 `tag=20261009` + 每平台资产名 + sha256（六目标资产已核 E2：`aarch64/x86_64` × `apple-darwin`/`unknown-linux-gnu`/`pc-windows-msvc`）。**Windows arm64 使用 `x86_64-pc-windows-msvc` 资产**（配合 x64 模拟）。
4. `PATH` 上的解释器（仅当探针通过）

> 六目标资产存在【E2】；**下载/解压/执行本身【待验】**（T1/Z 系列）。**不假设任何宿主自带 Python。**

### 4.3 目录与授权

```
ENHANCE_ROOT（默认 $DSH_HOME/professor/enhance；DSH_PROFESSOR_ENHANCE_ROOT 覆盖）
  runtime/<pyver>-<os>-<arch>/      # 自举 CPython
  envs/<env-version>/               # venv，<env-version>=sha256(lock digest+platform)
  wheelhouse/<lock-digest>/  models/<manifest-version>/
  state.json   .staging/<uuid>/
```
- 默认 `workspace-write` 写不进 `ENHANCE_ROOT`（`writableRoots` = workspace + `/tmp` + `os.tmpdir()`）→ 工具 schema 暴露 `sandbox_permissions` + `justification`，经 `approveEscalation` 取得本次调用的更宽模式，作为 `sandboxPolicy` 传给 `ctx.shell.resolve`（`dsh-shell/lib/types/types.d.ts:74` 支持 per-call）。
- 审批不可用（`approval` 策略 `never` / 无 answerer / agent-less）→ **不阻断**：回落 `<workspace>/.professor-cache/enhance/`（沙箱天然可写），输出 `prepare.location_scope:'workspace'` 并说明"每个工作区各需一份"。
- 只读工作区且回落也失败 → `prepare.status='unavailable'` + 精确原因（不是静默降级）。

### 4.4 在线 / 离线 / 取消 / 恢复

| 项 | 机制 |
|---|---|
| 在线 | 清单驱动下载：3 次重试（1s/4s/16s 退避）、`Range` 断点续传、每片 sha256 校验、进度经 `ctx.jobs`（`kind:'professor-prepare'`）+ 结果字段 |
| 离线 | `DSH_PROFESSOR_ENHANCE_MIRROR=<dir>` → `--no-index --find-links`；或解包离线包，零网络 |
| 取消 | `exec.signal` → `shell.execute({signal})` → 进程终止；staging 不激活 |
| 中断 | `.staging/<uuid>` 幂等续做；启动清理 >24h 的陈旧 staging |
| 并发 | 内存单飞 + `<ENHANCE_ROOT>/.lock`（`O_EXCL`） |
| 原子激活 | 探针通过 → `rename(.staging/… → envs/<v>)` → 原子写 `state.json.current` |
| 回滚 | 探针失败/中断 → 保留旧 `current`、删 staging、报 `prepare.failed`+原因 |

### 4.5 体积（本机实测【E4】）

venv **1.1 GB**（含 torch；无 torch 的 374 MB 版本**不可用**）｜HF 权重 **506 MB**（layout-heron + docling-models）｜RapidOCR 权重随 wheel **30.4 MB**｜自举 CPython **≈100 MB**【E2 待测】｜离线包 **≈1.7–2.0 GB/平台**【待测】｜在线首用建议空闲磁盘 **≥ 4 GB**【待测】。

---

## 5. 授权序列（复用既有授权，不为每次读取新增确认）

### 5.1 分层事实（【E1】§X6）

- 宿主原生 `read`：`ctx.fs.resolve` → `stat` → `readText`，**无审批、无工作区限制、无根集合**；仅 `write`/`edit` 用 `sandbox_permissions` 升级。
- `ctx.fs` 沙箱栅栏只拦写。
- 本插件的读根集合（项目根 + 插件根 + `DSH_PROFESSOR_ALLOWED_ROOTS` + `config.extraReadRoots`）是**插件级、比宿主更严**的限制。

### 5.2 序列（实现必须照此）

1. **解析规范化**：`gateway.resolveTarget(path,{cwd,signal})` → `FsTarget`（宿主 realpath）；对原始拼写跑 `hasTraversal`。
2. **既有授权判定（不产生任何提示）**：
   - canonical ∈ 插件读根 **且** 通过课程隔离 → **直接读**。此路径**不得**调用 `ctx.approval.request`（与原生 `read` 行为一致）。
3. **扩展判定**：canonical ∉ 读根 → 这是"扩展"，调用 `ctx.approval.request({agent, toolName:'professor_material_read', callId, reason: 命名该 canonical 文件, signal})`：
   - `'allowed-once'` → 记录**插件强制的、仅本次调用、仅该 canonical 文件**的放行（见 5.3）。
   - `'rejected'|'cancelled'|'unavailable'` → 以精确原因拒绝（`access-denied` / `approval-unavailable`）。
4. **课程隔离（与根集合并行、不可被 3 绕过）**：该文件若在索引中且属于非本会话课程 → 拒绝并给同名候选。
5. **符号链接/路径变更**：放行后重新 `resolveTarget` 并比对 canonical；不一致 → `path-changed` 拒绝；链接落在放行路径之外 → 拒绝。
6. **起进程**：`runner` 再跑一次 `readPolicy.assert`（含 5.2-3 的文件放行）才启动解析/渲染。

### 5.3 单文件放行的性质（必须如实描述）

- 宿主 `ApprovalOutcome` 本身**不携带路径**（`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`）。把绑定到具体路径是**插件自行施加的行为**，输出里必须写成：
  `authorization: { source:'explicit-path', host_grant:'allowed-once', granted_for:'<canonical>', call_id, scope:'single-file-this-call' }`
  并在参考文档注明：**该路径绑定由 Professor 插件强制执行，宿主只提供一次性批准。**
- **绝不**因收到 `path` 参数就声称已授权；`host_grant` 非 `allowed-once` 时不得出现 `granted` 字样。
- **矛盾点的解法**（越出读根的独立文件被批准后必须可读）：放行记录是**对根集的临时、按文件的补充**，与根集并集参与第 6 步断言；**不**修改全局根集合、**不**放行其所在目录。

### 5.4 测试

| 用例 | 期望 |
|---|---|
| 读根内的独立文件（有/无 `.professor`） | 读取成功，**断言 `ctx.approval.request` 未被调用** |
| 越出读根 + 审批 `allowed-once` | 读取成功；输出含 `granted_for`；**同目录其它文件仍拒绝** |
| 越出读根 + `unavailable` | `approval-unavailable`，消息说明"需要扩展授权但审批不可用" |
| 越出读根 + `rejected` | `access-denied` |
| `../` 穿越 | `path contains a ".." segment` |
| 根内符号链接指向根外 | 拒绝 |
| 放行后 symlink 被替换 | `path-changed` 拒绝 |
| 跨课程 `file_id` / 已索引的他课程文件 | 拒绝 + 候选（即使已获单文件批准） |

---

## 6. 缓存 vs 操作态；视觉交付与核对（按操作计预算）

### 6.1 两个存储，永不混用

| | **抽取/渲染缓存**（共享、可持久） | **操作态**（每读取操作、短生命周期） |
|---|---|---|
| 键 | `sha256(content_hash ‖ range ‖ backend@version ‖ options_digest ‖ schema)` | `op_id`（读取阶段首次调用时铸造，含 session/agent） |
| 内容 | 结构块、质量告警、已渲染页 PNG、冲突报告 | 已投递图像清单、`attempts`、状态、`report` |
| 位置 | 项目模式 `.professor/cache/material-read/`；非项目 `<workspace>/.professor-cache/material-read/`；不可写回退 `os.tmpdir()/professor-material-read/<hash>/` | **内存**（进程内 Map），可选落盘 TTL 记录 |
| 生命周期 | LRU 512 MiB + TTL 30 天 | TTL 30 分钟或会话结束即弃；**失败/取消的操作直接丢弃** |
| 归属 | 缓存元数据**永不**决定课程归属 | 与 `op_id` 绑定，跨会话不可复用 |

### 6.2 视觉状态机（交付 ≠ 解释）

```
image_delivery.status : not-attempted | delivered | partial | unavailable | failed
visual_review.state   : none | awaiting-interpretation | interpreted | discrepancy | unresolved | not-performed
```

| 状态 | 只能由 | 证据 |
|---|---|---|
| `delivered` | 工具 **read 阶段** | `attachments.saveImage` 返回的 ref + `render()` 实际返回的 ImageBlock 数 + 能力门禁结果；写入 `op_id` 的 `delivered[]` |
| `awaiting-interpretation` | 工具 read 阶段 | 上一条 + 门禁可用 |
| `interpreted` | 工具 **verify 阶段** | 通过 §6.3 全部绑定校验的 `visual_report` |
| `discrepancy` | verify 阶段 | `report.discrepancies` 非空 |
| `unresolved` | verify 阶段 | 该 `op_id` 预算耗尽仍有分歧 |
| `not-performed` | read 阶段 | 纯文本路由 / 无 attachments / 渲染失败 / 未要求 |

**语义边界**：`interpreted` = 已交付 + 模型提交了与该图绑定的结构化解释，**不等于解释正确**；正确性只由 T13/Z6 的带真值样本度量。运行时**永不**输出"准确率/置信度"字段。

### 6.3 操作内预算与报告绑定（C22）

- **每个读取操作 `op_id` 最多 1 次视觉核对**；`op_id.attempts >= 1` 后：
  - 同 `op_id` 的第二次 verify → 拒绝 `operation-budget-exhausted`（**不新增** `saveImage`、**不新增** ImageBlock）。
  - 同 `op_id` 的 read 再次投递 → 拒绝（该操作已用完）。
- **不消耗文档预算**：同一份未变更文档的**新 `op_id`** 可以重新从缓存投递并再次核对（缓存命中，不重渲染）。
- **报告绑定**（全部满足才接受）：`op_id` 存在且未过期 ∧ 属于本会话/agent ∧ `source_hash` 相等 ∧ `range` 相等 ∧ `options_digest` 相等 ∧ `report.attachment_id ⊆ op.delivered[]` ∧ `report.page ∈ range`。
- **不匹配即拒绝**：`report-rejected: stale|mismatched-session|mismatched-range|unknown-attachment`。跨会话/跨操作/过期报告一律拒绝。
- **幂等**：同一 `op_id` 提交**完全相同**的报告 → 返回已存结果，不增加 `attempts`、不重复写状态。
- **并发**：`op_id` 级互斥（进程内锁）；第二次并发 verify 在锁内看到 `attempts>=1` 即拒绝。
- **失败/取消**：操作态随 `exec.signal` 中止而丢弃 → **不阻塞**后续读取（新 `op_id` 从零开始）。

### 6.4 反循环约定

工具结果只给**数据与机器字段**（`next_stage`、`budget_remaining`、`delivered_pages`），不写祈使句；流程说明只在 SKILL.md 与随包参考。**状态机优先于文案**：技能说"去核对"而 `budget_remaining=0` 时，工具返回终态 `unresolved`。`visual_*` 只写缓存/操作态，**不写** `.professor/state/**`。

### 6.5 必备测试（评审 2 要求的 5 项）

1. 同一 `op_id` 第二次 verify → 拒绝 `operation-budget-exhausted`，且断言无新 `saveImage`/ImageBlock。
2. 同一未变更文档新建 `op_id` → **可**再次投递（缓存命中，`render` 未被再次调用）。
3. 用其它 `op_id` / 其它会话的报告 → `report-rejected`，状态不变。
4. 改 `options_digest` 或 `content_hash` → 旧缓存键未命中（`cache:'miss'`），重新解析/渲染。
5. 操作被取消/失败 → 操作态被清除；随后新操作可正常读取与投递。

---

## 7. 独立文件模式（保留）

- `path` 模式在**无项目、无 `.professor`** 时必须可用；不创建课程注册、不写学习状态。
- 缓存位置见 §6.1（项目 / 工作区 / tmp 三级回退），输出恒报 `cache.{location,mode,status}`。
- **页图写入（因 `ctx.fs` 无二进制写）**：`render_pages.py` 经 `ctx.shell` 在沙箱可写根内写字节 → 插件 `gateway.readBytes(target,signal,maxBytes)` 读回 → `attachments.saveImage({data, mediaType:'image/png', name})`；插件侧元数据一律 `writeText`。
- 只读源：源目录永不写入；缓存不在源旁；树摘要前后一致断言。
- 测试：独立 PDF / 扫描 PDF / DOCX（DOCX 页码恒为 `null`，不编造）、只读源、只读工作区（回退 tmp 并如实标注）。

---

## 8. 自动增强触发器（保留，8 类）

| ID | 触发条件 | 证据字段 | 选择的增强 |
|---|---|---|---|
| TR-EMPTY | 页文字 <32 字符且有图像 XObject | `page_text_chars`,`image_count` | 该页 OCR |
| TR-MIX | 空文字层页占比 ≥0.3 或任一空页 | `empty_pages/total_pages` | 仅空页 OCR |
| TR-DIAGRAM | 有文字层且图像面积比 ≥0.05 或与图注共页 | `image_area_ratio`,`caption_tokens` | 渲染 + 视觉核对 |
| TR-FORMULA-IMG | 图像紧邻公式型文本 / 文本含图像公式迹象 | `image_text_proximity` | 渲染 + 视觉核对 |
| TR-TABLE-FLAT | 检出表格但 `cells==rows` 且每格独占一行 | `table_cells`,`grid_degenerate` | 该页结构化解析 |
| TR-COLUMN | ≥2 条贯穿纵向空白带，或左缘 ≥2 簇且 y 序冲突 | `gutter_count`,`order_conflict` | 结构化解析 + 顺序报告 |
| TR-GARBLED | 替换/控制字符占比 >0.02 或数学符号缺失 | `garbled_ratio`,`math_symbol_dropout` | OCR + 渲染复核 |
| TR-USER-VISUAL | `require_visual:true` 或用户显式要看图 | 输入参数 | 渲染 + 视觉核对 |

规则：每触发器返回 `{trigger, evidence, basis:'heuristic', pages}`；`basis` 只允许 `heuristic`；**运行时不输出准确率**；只增强命中页；预算 ≤6 渲染页/次、≤2000px、≤6 增强页/次、文字 ≤4 MiB、`render` 60s / `enhance` 120s、一次读取内 fallback ≤1 与视觉核对 ≤1；冲突按字符级 diff 报 `conflicts[]`，两份结果按 `origin` 分列**不合并**。

---

## 9. 许可与再分发检查（新增必办项）

| 项 | 要求 |
|---|---|
| 依赖许可清单 | 按**每平台锁文件**逐项记录 `name==version` + `license_expression`（缺失者读 LICENSE 文件并记 URL 与版权行）。已知：docling-slim/core/ibm-models **MIT**；torch 主体 BSD-3（含 Apache-2.0 WITH LLVM-exception 等）；torchvision BSD【需读 LICENSE】；numpy BSD-3 复合；scipy BSD；onnxruntime MIT；opencv-headless Apache-2.0；pypdfium2 BSD-3+Apache-2.0（PDFium）；rapidocr Apache-2.0；rtree MIT |
| 模型权重许可 | 按 `models/manifest.json` 的 pinned revision 逐仓库读 LICENSE（`docling-layout-heron`、`docling-models`/TableFormer）；旧记录 CDLA-Permissive-2.0 / Apache-2.0 **须重新核实**后写入 |
| OCR 权重 | PP-OCRv6（随 rapidocr wheel）Apache-2.0 |
| 运行时许可 | python-build-standalone（PSF-2.0）+ 其内含 Python 许可 |
| 再分发形态 | 在线包只声明 + 下载；离线包必须附 `THIRD_PARTY_LICENSES.md` 与 `SHA256SUMS` |
| 门槛 | `tools/verify-distribution.mjs` 新断言：六份锁文件存在且每行带 `--hash=sha256:`；模型清单含 `license` 字段；`THIRD_PARTY_LICENSES.md` 覆盖上述全部包；无密钥、无个人绝对路径 |
| 现状 | `THIRD_PARTY_LICENSES.md` **只覆盖学习预设**，增强依赖与权重**尚未声明** → T9 |

---

## 10. 文件级改动清单（获批后实施）

| 文件 | 变更 | 职责 |
|---|---|---|
| `src/extract/material-read/coordinator.js` | 新 | 定位→范围→快速解析→触发→增强→组装；`op_id` 生命周期；fallback ≤1、视觉 ≤1 |
| `src/extract/material-read/authorize.js` | 新 | §5 六步序列（既有授权优先，扩展才审批，单文件放行） |
| `src/extract/material-read/visual.js` | 新 | §6 状态机 + 操作态存储 + 报告绑定 + 幂等/并发/TTL |
| `src/extract/material-read/cache.js` | 新 | 抽取缓存键/隔离/失效/LRU+TTL/损坏重建 |
| `src/extract/material-read/quality.js`、`triggers.js` | 新 | §8 |
| `src/extract/material-read/render.js`、`enhance-docling.js` | 新 | 渲染与增强适配（pypdfium2 后端显式注入） |
| `src/extract/material-read/provision.js` | 新 | §4：S0/S1 编排、清单、锁、单飞、原子激活、回滚、进度 |
| `src/extract/material-read/platform.js` | 新 | 平台标识、引号方言、载荷布局、PBS 资产映射、最低系统版本 |
| `src/extract/scripts/bootstrap_runtime.py`→**改为 `bootstrap.sh` / `bootstrap.ps1`** | 新 | **S0 无 Python 自举**（下载+校验+解压+探针+原子激活） |
| `src/extract/scripts/provision.py` | 新 | S1：wheel 下载/`--require-hashes` 安装/权重校验/探针 |
| `src/extract/scripts/enhance_docling.py`、`render_pages.py`、`probe_enhance.py` | 新 | 增强解析 / 页渲染（PNG 直写沙箱可写目录）/ 探针 |
| `src/extract/backend.js` | 改 | **平台化引号**：`shellQuote(v,{dialect:'posix'|'powershell'})`、`argvToCommand(argv,{dialect})` |
| `src/extract/runtime.js` | 改 | 载荷布局按平台（`python.exe` vs `bin/python3`）、enhance venv 候选 |
| `src/extract/capabilities.js` | 改 | `ocr:false` 语义固定为"快速路径不执行 OCR"；新增 `ocr_enhance`/`enhance`；更新钉住旧文案的测试（有意契约变更） |
| `src/tools/material-read.js` | 新 | `professor_material_read`（`stage:'read'|'verify'`、`op_id`、`sandbox_permissions`+`justification`） |
| `src/plugin.js` | 改 | 注册第 22 个工具；装配 authorize/visual/provision；`extractTimeouts` 增 `enhance`/`render` |
| `skills/professor-study/SKILL.md` | 改 | 材料读取与教学衔接段（**获批后**才动） |
| `skills/professor-study/references/material-reading.md` | 新 | 随包参考：契约、状态语义、告警码、触发器、图像边界、授权语义 |
| `resources/enhance/**` | 新 | 六份锁文件、模型清单、离线校验清单 |
| `THIRD_PARTY_LICENSES.md` | 改 | §9 全部声明 |
| `tools/verify-distribution.mjs`、`tools/verify-home.mjs` | 改 | §9 门槛；工具注册、无视觉路由诚实降级、缓存不改课程状态 |
| `tools/verify-clean-install.mjs`（新）、`tools/gen-enhance-lock.mjs`（新） | 新 | 按 `--platform` 清洁安装验收；逐平台锁生成 |
| `test/material-read*.test.mjs`、`test/platform-*.test.mjs` | 新 | 见 §11 |

**技能参考交付（沿用上版定案）**：目录 `resourceBase` + SKILL.md 一句相对路径指引（宿主 `renderSkillContent` 已渲染 `<skill_resources>` 基目录提示）；不内联正文。**本轮不改技能正文。**

---

## 11. 可执行任务（文件 / 接口 / 测试 / 命令 / 期望 / 依赖）

> 接口以 JSDoc typedef 写在模块内。下述签名为**实现合同**。

### T0 锁文件、平台与清单钉死
- **文件**：`resources/enhance/requirements/<os>-<arch>.lock` ×6、`resources/enhance/models/manifest.json`、`tools/gen-enhance-lock.mjs`、`docs/qa/.../platform-*.md` ×6
- **接口**：`resolvePlatform({platform,arch}) → { id, dialect:'posix'|'powershell', pythonAsset, minOs, emulation:'native'|'x64' }`
- **测试**：六份锁存在且每行 `--hash=sha256:`；`--no-build` 解析可复现；`win-arm64` 锁用 x86_64 目标并在文件头注明"模拟执行"；模型清单含 `license`/`revision`/`bytes`/`sha256`
- **命令**：`node tools/gen-enhance-lock.mjs --all && node --test test/platform.test.mjs && npm run verify:dist`
- **期望**：6 份锁 + 清单生成；解析结果与 EXPERIMENTS §X3 一致
- **依赖**：无

### T1 无 Python 自举（S0）+ 制备（S1）
- **文件**：`src/extract/scripts/bootstrap.sh`、`bootstrap.ps1`、`src/extract/scripts/provision.py`、`probe_enhance.py`、`src/extract/material-read/provision.js`
- **接口**：
  - `bootstrapRuntime({ platform, manifest, destRoot, signal, sandboxPolicy, onProgress }) → Promise<{ status:'ready'|'failed', runtimePath, reason? }>`
  - `prepareEnhance({ root, mirror?, platform, signal, approval, onProgress }) → Promise<{ status:'prepared'|'not-prepared'|'unavailable', envPath, profile, location_scope, reason? }>`
  - `onProgress(e:{phase:'download'|'verify'|'extract'|'install'|'probe'|'activate', file?, received?, total?, pct?})`
- **测试**：**无 Python 的干净环境**下自举成功（构造 PATH 无 python 的 shell）；sha256 不符拒绝；3 次重试；离线镜像零网络；中断幂等续做；并发单飞；探针失败回滚（旧 `current` 保留）；审批不可用 → workspace 回落；**断言共享宿主运行时目录字节不变**
- **命令**：`node --test test/material-read-bootstrap.test.mjs test/material-read-provision.test.mjs`
- **期望**：全绿；`node tools/verify-clean-install.mjs --platform darwin-arm64` 通过
- **依赖**：T0

### T2 平台化引号
- **文件**：`src/extract/backend.js`、`src/extract/material-read/platform.js`、`test/extract-runtime.test.mjs`
- **接口**：`shellQuote(value:string, opts?:{dialect}) : string`；`argvToCommand(argv:string[], opts?) : string`
- **测试**：`posix` 用例**逐字不变**（不回归）；`powershell` 覆盖空格/单引号/`;`/`$`/反引号/中文路径/`--flag`；NUL 仍抛 `PROFESSOR_EXTRACT_ARGV_INVALID`；`quote-roundtrip`（真机）
- **命令**：`node --test test/extract-runtime.test.mjs`
- **期望**：绿（Windows 实际还原 ⬜Z2）
- **依赖**：无

### T3 页渲染
- **文件**：`src/extract/scripts/render_pages.py`、`src/extract/material-read/render.js`
- **接口**：`renderPages({python, scriptPath, sourcePath, from, to, outDir, maxSide, signal, run}) → { pages:[{page,path,width,height,bytes}], failed:[{page,reason}] }`
- **测试**：页范围裁剪；混合页；>2000px 拒绝；PNG 落沙箱可写目录 + `readBytes` 读回；超时归类 `timedOut`
- **命令**：`node --test test/material-read-render.test.mjs`
- **期望**：绿
- **依赖**：T0、T2

### T4 触发器与质量检查
- **文件**：`src/extract/material-read/triggers.js`、`quality.js`
- **接口**：`selectTriggers(probe) → {triggers:[{trigger,evidence,basis:'heuristic',pages}]}`；`evaluateQuality(blocks,pageMeta) → {warnings:[{code,page,detail}]}`
- **测试**：8 类各 1 正例 + 1 反例；断言输出**无** `score`/`confidence`/`accuracy` 字段
- **命令**：`node --test test/material-read-quality.test.mjs`
- **期望**：绿
- **依赖**：无

### T5 Tier A 与能力口径
- **文件**：`src/extract/capabilities.js`、`test/extract.test.mjs`
- **接口**：`summarizeCapabilities(caps) → {…, ocr:false, ocr_enhance:'available'|'not-prepared'|'unsupported-platform', enhance:{profile,prepared,reason?}}`
- **测试**：`ocr:false` 语义不变；新字段三态；**旧文案断言有意更新**（C25 同类契约变更，在提交说明中点名）
- **命令**：`node --test test/extract.test.mjs`
- **期望**：绿
- **依赖**：T1

### T6 增强适配器与缓存
- **文件**：`src/extract/material-read/enhance-docling.js`、`cache.js`、`src/extract/scripts/enhance_docling.py`
- **接口**：`enhance({backend:'docling', profile, pdfBackend:'pypdfium2'|'docling-parse', sourcePath, range, options, signal, cache}) → {blocks, conflicts, cache:'hit'|'write'|'skipped'}`；`cacheKey({contentHash,range,backendVersion,optionsDigest,schema}) → string`
- **测试**：合同夹具（结构块形状、bbox/页码有无）；缓存键**四向失效**；损坏重建；源只读（树摘要一致）；冲突报告形状；**pypdfium2 后端显式注入**（不依赖默认值）
- **命令**：`node --test test/material-read-enhance.test.mjs`
- **期望**：绿
- **依赖**：T0、T1、T4

### T7 授权序列
- **文件**：`src/extract/material-read/authorize.js`
- **接口**：`authorizeRead({spelling, cwd, exec, readPolicy, courseFilter, approval, signal}) → Promise<{ok:true, canonical, mode:'in-policy'|'granted', hostGrant?, callId?} | {ok:false, reason, code}>`
- **测试**：§5.4 全部 8 项，含"读根内**不调用** approval"的负向断言
- **命令**：`node --test test/material-read-authorize.test.mjs`
- **期望**：绿
- **依赖**：无

### T8 工具 `professor_material_read`
- **文件**：`src/tools/material-read.js`、`src/plugin.js`
- **输入**：`{file_id?, path?, course?, range?, mode?, stage:'read'|'verify', op_id?, require_visual?, visual_report?, sandbox_permissions?, justification?}`（`file_id`/`path` 互斥；`stage:'verify'` 必须带 `op_id`+`visual_report`）
- **输出**：见 §6/§7（`authorization{}`、`image_delivery`、`visual_review`、`op_id`、`budget_remaining`、`triggers`、`conflicts`、`cache`、`prepare`、`unresolved`、`failures`）
- **测试**：互斥校验；重名/跨课程；独立文件（不建 `.professor`）；显式页范围；源已变更；越界；DOCX/PPTX；`sandbox_permissions` 缺 `justification` 报错；四状态互不蕴含
- **命令**：`node --test test/material-read.test.mjs`
- **期望**：绿
- **依赖**：T1–T7

### T9 视觉状态机与操作态
- **文件**：`src/extract/material-read/visual.js`、`src/tools/material-read.js`（render 部分）
- **接口**：`deliverImages({attachments,llm,exec,opId,pages}) → {status, images:[{attachmentId,page,width,height}]}`；`recordVerification({op,report}) → {state, attemptsRemaining} | {rejected:'stale'|'mismatched-session'|…}`
- **测试**：**§6.5 五项必备测试** + 能力门禁（无能力不落库）+ 超张数截断 + render 文本不含祈使句
- **命令**：`node --test test/material-read-visual.test.mjs`
- **期望**：绿
- **依赖**：T8

### T10 许可与分发门槛
- **文件**：`THIRD_PARTY_LICENSES.md`、`resources/enhance/**`、`tools/verify-distribution.mjs`
- **测试**：§9 全部断言
- **命令**：`npm run verify:dist`
- **期望**：绿
- **依赖**：T0

### T11 技能与人格（**获批后**）
- **文件**：`skills/professor-study/SKILL.md`、`skills/professor-study/references/material-reading.md`、`cordis.patch.yml`（一句工具纪律）
- **测试**：正文含新段、无个人路径、参考随包；话术断言（原文/OCR/推断/补充分离；无 `interpreted` 不声称看懂图；预算耗尽不重试；授权语义表述与 §5.3 一致）
- **命令**：`npm run verify:skills && npm run verify:sync`
- **期望**：绿
- **依赖**：T8、T9

### T12 标注样本集与阈值标定（**先基线、后冻结**）
- **文件**：`test/fixtures/material-read/**`（8 类带真值）、`docs/qa/.../accuracy-baseline.md`
- **步骤**：**T12a 基线**：跑快速路径 + OCR 变体，逐维记录 CER/阅读顺序逆序率/表格单元格/公式符号/坐标 → **与用户确认后冻结阈值**；**T12b 判定**：`pypdfium2` vs `docling-parse` 双变体对照 → 触发 §3.2 判定
- **命令**：`node --test test/material-read-accuracy.test.mjs`
- **期望**：产出逐维数字与 critical-error 清单（**不接受**"准确率可接受"）
- **依赖**：T6、T8

### T13 真实宿主与清洁安装（六平台）
- **文件**：`tools/verify-clean-install.mjs`、`test/platform-<os>-<arch>.test.mjs` ×6、`docs/qa/.../platform-*.md`
- **每平台**：`quote-roundtrip`、`payload-python`、`tier-a-read`、`render-page`、`tier-b-scan`、`cancel-timeout`、`recovery`、`clean-install`、`offline`（§2.3）
- **命令**：`node tools/verify-clean-install.mjs --platform <os>-<arch>`；`node --test test/platform-*.test.mjs`
- **期望**：macOS arm64 先行；其余按 Z1–Z4 补齐（见 §13）
- **依赖**：T1–T12

### T14 真实模型视觉与教学验收（**需用户授权**）
- **文件**：`tools/verify-visual.mjs`、`docs/qa/.../visual-acceptance.md`、`teaching-acceptance.md`
- **测试**：已知图表/公式页解释与真值逐项对照；纯文本路由 `not-performed`；两种适配器图像位置（C7）；教学：起讲位置、原文/补充分离、缺口不编造、`.professor/state/**` 字节不变
- **命令**：`ELECTRON_RUN_AS_NODE=1 "<Harness>" tools/verify-visual.mjs`
- **期望**：逐项对照记录，**不接受"模型自称看到"**
- **依赖**：T9、T11；需用户批准模型费用

### T15 回归
- **测试**：`professor_extract` 批量语义、检索、增量索引、课程隔离、记忆、产物
- **命令**：`npm test && npm run verify:e2e && npm run verify:harness`
- **期望**：全绿
- **依赖**：T12–T14

### 依赖图
```
T0 ─┬─ T1 ─┬─ T3 ─┐      T2 ─┐
    │      ├─ T5 ─┤            │
    │      └─ T6 ─┼────────────┼─ T8 ─┬─ T9 ─┬─ T11 ─┐
    └─────────────┤            │      │      └──────┘
T4 ───────────────┘            │      │
T7 ────────────────────────────┘      ├─ T12 ─┬─ T13 ─ T15
T10 ──────────────────────────────────┘       └─ T14
```

---

## 12. 可测量验收标准（先标定、后冻结）

**critical（任一即不通过，必须修正或标 `unresolved`）**
- 公式中的数字/运算符/正负号错误或缺失（本轮已观测：扫描页丢失 `E = `）
- 变量名错误；整句丢失 >10 字
- 双栏跨栏行交错（本轮 pypdfium2 后端已观测 1 处）
- 表格缺行 / 错行归属 / 合并单元格丢失（本轮两后端均导出空表 → 待查根因）
- 页码错误；块坐标与标注完全无关
- 静默丢结构

**tolerable（不计失败）**：空格差异、连字符断行、页眉页脚噪声、标点全半角、上标排版形式、空单元格表示差异。

**数值阈值**：在 **T12a 基线**上与用户确认后冻结写入本节；当前草案值（OCR CER ≤3.0%、阅读顺序逆序率 ≤0.5%、表格单元格 ≥98%、公式符号 100%、页码 100%、bbox IoU≥0.5 占比 ≥95%）**未通过本轮样本**（实测 OCR CER 0.126），因此**不得**作为已达成结论，只能作为待标定的候选。

**教学**：从指定材料与页起讲；原文/补充可区分；`unresolved` 覆盖所讲页时不编造；`.professor/state/**` 字节不变。

**交付**：六平台各自的清洁安装报告（§2.3 八项）；无网络（有镜像）、无视觉路由、超时取消、源文件更新四类异常路径各一份记录。

---

## 13. 剩余阻塞项与确切解决步骤

| ID | 阻塞 | 确切解决步骤 | 决策点 |
|---|---|---|---|
| **B1** | macOS x64 的 Tier B **未实装**（只有依赖解析） | ① 在 Intel Mac 或 macOS x64 CI runner 建 venv；② `uv pip sync lock-darwin-x64.txt`；③ 跑 `verify-clean-install --platform darwin-x64` 与 `tier-b-scan`；④ 记录 torch 2.2.2 实装与耗时 → 写入 `platform-darwin-x64.md` | 未完成前 macOS x64 **不得**标"已支持" |
| **B2** | Windows x64 全链路未验（pwsh 引号、载荷 Python、制备、清洁安装） | ① Windows 10/11 x64 装 `win-x64` 官方包；② `quote-roundtrip`；③ 核 `runtime.json` 与 `dependencies/python/python.exe`；④ `verify-clean-install --platform win32-x64`；⑤ 记录 pwsh 引号方言实际行为并回填 T2 断言 | 引号方言以实测为准 |
| **B3** | Windows arm64：原生依赖不可解（无 `win_arm64` torch/opencv） | 方案 = **x64 模拟**：x64 CPython + `win_amd64` 轮子（锁已按 x86_64 目标可解析）+ win-x64 Harness（Win11 ARM64 模拟层）。步骤：① Win11 ARM64 真机；② 装 x64 CPython（pbs `x86_64-pc-windows-msvc`）；③ `uv pip sync` x64 锁；④ 全套平台测试；⑤ 在矩阵中**显式标注"模拟执行"**并测量性能差 | 若模拟不可接受 → 与用户重议（**不接受**"降级为只读基础"） |
| **B4** | Linux 无官方桌面构建 | 路径 = npm `@deepseek-ai/dsh@0.2.0-rc.2` CLI 宿主：① Linux glibc≥2.28 机器 `npm i -g @deepseek-ai/dsh`；② 验证能否装载本插件与 `ctx.shell`；③ 跑全套平台测试 → `platform-linux-x64.md`。若 CLI 不能装载插件 → 回报用户：**Linux 宿主可用性是外部依赖**，给出"等官方构建/CLI 支持"的具体请求与时间点，**不得**写成已接受限制 | 未验证前 Linux 不标支持 |
| **B5** | 精度未标定（OCR CER 0.126、表格空、pypdfium2 阅读顺序 1 处跨栏） | ① 建 8 类标注样本集；② T12a 跑基线（快速路径 / OCR / pypdfium2 / docling-parse 四变体）；③ 与用户确认阈值并冻结；④ 按 §3.2 选定后端变体；⑤ 未达标项要么修（OCR 预处理、`iso:zh` 语言策略、表格结构参数）要么标 `unresolved` 并上报 | 后端最终形态在此定案 |
| **B6** | 无 Python 自举路径**未实现**（仅有设计与本机工具存在性） | ① 实现 `bootstrap.sh`/`bootstrap.ps1`；② 在"PATH 无 python"的干净 shell 中验证 S0→S1 全链；③ 干净 `DSH_HOME` 清洁安装；④ Windows 侧同款 | 未完成前不得声称"自动准备" |
| **B7** | E7 真实模型视觉与教学验收（需用户授权） | 用户批准后：`tools/verify-visual.mjs` + `teaching-acceptance` | 未做前视觉/教学只到 E4 |

---

## 14. 需用户批准的设计修订

| ID | 修订 | 理由 |
|---|---|---|
| **A1** | `stage:'read'|'verify'` 二段式 + `op_id` 操作态 | 交付与解释分离；按操作计预算（C22） |
| **A2** | 分层能力口径与 B1–B7 的对外表述 | 禁止把平台缺口写成"已接受限制" |
| **A3** | 制备需一次宿主升级授权，否则回落工作区本地制备 | 沙箱默认写不进 `DSH_HOME` |
| **A4** | `authorization{}` 语义（含"路径绑定由插件强制"的说明） | 避免暗示"收到路径即授权" |
| **A5** | `NO_PDF_BACKEND_REASON` 等文案与既有断言的有意变更 | 契约变更必须显式 |
| **A6** | 技能参考用目录 `resourceBase` 交付 | 宿主契约已核 |
| **A7** | **统一 pypdfium2 后端**（若 T12b 判定通过）或**自建 macOS x86_64 docling-parse 轮子**（若不通过） | 二选一，T12b 出结论后定 |
| **A8** | 阈值在 T12a 基线后与用户共同冻结 | 当前草案值未通过实测 |

---

## 附录 · 复现入口

全部实验的**命令、版本、产物路径、观测输出**见 `docs/qa/2026-10-10-material-reading-teaching/EXPERIMENTS.md`（§X1–X8、§未执行实验 Z1–Z6）。要点复现：

```bash
# 逐平台依赖解析（wheels-only）
uv pip compile --python-version 3.12 --python-platform <PLATFORM> --no-build \
  --no-header -o lock-<PLATFORM>.txt requirements.txt

# ONNX-only 档案否定复现
uv pip install --python $VENV 'docling-slim[format-pdf-pypdfium2,feat-ocr-rapidocr-onnx,convert-core]'
$VENV/bin/python convert.py samples/text_table_fig.pdf out.json   # → No module named 'torch'

# 后端 A/B
DOCLING_BACKEND=pdfium  $VENV/bin/python convert.py samples/text_table_fig.pdf out-pdfium.json
DOCLING_BACKEND=docling $VENV/bin/python convert.py samples/text_table_fig.pdf out-docling.json

# 官方宿主构建探测
curl -s https://download.deepseek.com/dsh-desk/feeds/mac-x64/nightly-mac.yml
curl -s https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml
```

**本轮未修改**：任何 `src/**`、`skills/**`、`test/**`、`cordis.patch.yml`、真实桌面安装、工作树既有改动。
