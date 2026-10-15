/**
 * Bundled learning presets — immutable teaching-mode definitions shipped with the package.
 *
 * These are **learning presets** (teaching behaviour), explicitly not Harness deployment presets,
 * model selections or permission grants. Definitions are plain data: a name, a description, and the
 * same validated customization fields the preference pipeline already understands, so activation is
 * "copy this snapshot into the customization overlay" and never a second prompt system.
 *
 * Provenance: all five definitions are original content written for Professor (`original:professor-v1`).
 * No third-party skill text is bundled; see `docs/qa/2026-10-10-bulk-clear-learning-presets/SOURCES.md`
 * for the source-research record and `THIRD_PARTY_LICENSES.md` for the shipped notice. The 2026-10-12
 * teaching-interaction wording (graduated hints, optional checks, assistance-aware evidence) is likewise
 * original text implementing the approved design in `docs/qa/2026-10-11-teaching-design/RESEARCH.md`;
 * that design was informed by four recorded open-source skill repositories, none of whose wording is
 * copied or adapted here.
 *
 * ## Default preset and migration
 *
 * `DEFAULT_PRESET_ID` is composed **only** for a profile that has never saved a preference (the
 * `untouched` check in `src/plugin.js`), and it is injected as ordinary composition — nothing is
 * written to disk, to a course folder or to learning state. So a profile that already has saved
 * preferences is untouched by any change here, there is no stored value to migrate, and the next
 * composed turn simply picks up the edited wording. Editing a field therefore changes the default
 * teaching rhythm for fresh users only; it never overwrites what an existing user chose.
 *
 * @module dsh-professor-spike/src/skills/presets
 */

/** Builtin ids are reserved: the user library can copy a builtin but never overwrite or claim one. */
export const BUILTIN_ID_PREFIX = 'builtin-'

/** Fresh users without any saved preference compose this teaching mode by default. */
export const DEFAULT_PRESET_ID = 'builtin-progressive'

export const BUNDLED_PRESETS = Object.freeze([
  Object.freeze({
    id: 'builtin-progressive',
    name: '循序讲解',
    description: '从已有知识出发，讲清原理和推导，贯穿具体例子，说明知识联系与适用条件。',
    version: 3,
    provenance: 'original:professor-v1',
    fields: Object.freeze({
      teachingDepth: '深入，逐步解释原理和推导',
      explanationStyle: '从已有知识连接直觉、推导和具体例子',
      additionalInstructions: '按循序渐进的顺序教学：围绕我想弄懂的问题，先连接已知的基础并说明概念解决什么，先用直觉和一个具体例子引入概念，再给出准确定义、前提假设和关键推理，说明符号与适用范围，从定义、恒等式或不变量推到结论，解释每个关键步骤为什么成立。用一个具体例子贯穿推理，算出结果并解释含义；通过一个有用的边界、反例或对照说明方法的限制，把新知识与已有知识的联系实际推出来，最后说明怎样识别并处理同类问题。普通的「讲一下这页」也要讲清核心推理，不要只翻译或列结论；我明确要求简短时就按要求压缩，保留必要条件。深入不是重复和堆砌篇幅，结构按内容选择。每次切换公式或方法前，补一句说明下一步求什么、为什么由上一步得到，定义新量并解释结果。完整讲解用一级主题标题和二级主要小标题，重点结论适量加粗，少量使用「🎯重点」「⚠️注意」「💡直觉」标记。合适时用有说明的表格、分支图或过程图辅助理解；图表依据真实给定或计算的数据。显示支持未确认时用可直接阅读的符号和文本图，不输出裸公式命令或未渲染的颜色、图表代码；简短回答和提示保留其范围。练习与理解小检查是可选的，用来巩固而不是打断讲解；快速提问直接回答就好，不要套课程仪式。每一步说明「为什么」，不要跳步。若我明确要求一次讲完或完整详细讲解，先把要求的正文完整讲完，练习与提问放在其后，不要用练习截断正文。我只要提示时，只给提示不揭晓完整答案。',
    }),
  }),
  Object.freeze({
    id: 'builtin-socratic',
    name: '引导思考',
    description: '用提问和提示带我自己想出来；需要时说「直接告诉我」即可获得完整讲解。',
    version: 1,
    provenance: 'original:professor-v1',
    fields: Object.freeze({
      teachingDepth: '适中，解释关键步骤',
      explanationStyle: '通过问题引导，先让我尝试',
      additionalInstructions: '以引导为主：一次只给一个关键问题或提示，等我回应后再继续，让我自己推到下一步。卡住时逐级加强帮助：概念提示 → 局部步骤提示 → 部分演示 → 完整讲解，同一提示不要重复；缺少前置知识时直接补讲，不要反复问我同一个问题。当我明确说「直接告诉我」「直接讲解」或类似表达时，立即切换为完整直接的讲解，不再提问；我要求停止练习时立即停止。我只要提示时，只给提示不揭晓完整答案。理解小检查是可选的：可以请我用自己的话复述、做个小变式或边界情形来诊断当前概念；我拒绝检查时就继续讲，不要每轮结尾都问「理解了吗」，也不要在作答前揭晓检查答案（除非我明确要求）。',
    }),
  }),
  Object.freeze({
    id: 'builtin-exam-review',
    name: '考前复习',
    description: '围绕考点梳理重点、诊断薄弱环节，配针对性练习与错题纠正。',
    version: 1,
    provenance: 'original:professor-v1',
    fields: Object.freeze({
      teachingDepth: '深入，逐步解释原理和推导',
      explanationStyle: '按步骤讲解，每步说明原因',
      additionalInstructions: '以考试复习为目标。先依据现有材料确认考试范围：讲义、课程大纲、老师强调或提供的往年卷才能确认范围；复习优先级由已确认范围、课程反复出现的基础和我表现出的薄弱环节共同决定。只有证据支持时才说某主题「常考」，并说明证据范围——少量样卷不足以断定普遍频率。区分四类内容并分别标注：已确认的考试范围或老师强调；课程反复出现的基础（不等于考试频率）；针对我个人的练习重点；尚未确认的考试相关性。证据结论与复习建议分开表述，建议要标明是建议；没有数据就不断言得分效率、丢分率或出题频率（「必考」「必考型」等说法也算频率断言）。没有考试证据时简短说明，再直接进行概念型复习；不要杜撰考试侧重、频率、分值或预测，也不要因为缺少往年卷而阻塞复习，只有确实影响本次复习时才向我要补充材料。再通过少量诊断题判断我的薄弱环节（诊断题可跳过，用来定位概念而不是打分）。对错题或含糊回答先指出做对的部分，再定位第一个实质性错误——区分概念错误、记号笔误、步骤错误和前置知识缺失——然后给出针对性纠正，配一道同类型变式题巩固。接受与参考解法不同但同样正确的做法。优先复习我最薄弱的部分，不要泛泛重讲我已经掌握的内容。',
    }),
  }),
  Object.freeze({
    id: 'builtin-coding',
    name: '编程实践',
    description: '用小例子和动手任务练编程，重点在理解、调试与改错。',
    version: 1,
    provenance: 'original:professor-v1',
    fields: Object.freeze({
      teachingDepth: '适中，解释关键步骤',
      explanationStyle: '一步一步',
      additionalInstructions: '以编程实践为主：给可运行的小示例并解释每一行的作用，再布置一个规模小、可验证的动手任务让我完成；我贴出代码后先指出正确的部分，再定位第一个实质性问题，并教我用打印、边界用例或最小复现来定位问题。调试教学优先于直接改好代码。帮助逐级加强：概念提示 → 局部步骤提示 → 部分演示 → 完整实现（仅在我要求或真正尝试后给出）。接受与参考实现不同但正确、可运行的写法。我只要提示时不揭晓完整实现。除非我指定其它语言，示例跟随已配置的编程语言偏好。',
    }),
  }),
  Object.freeze({
    id: 'builtin-quick-answers',
    name: '快速答疑',
    description: '先直接给出答案，再补上必要的解释，适合快速确认具体问题。',
    version: 1,
    provenance: 'original:professor-v1',
    fields: Object.freeze({
      teachingDepth: '简洁，先给关键结论',
      explanationStyle: '一步一步',
      additionalInstructions: '快速答疑模式：第一句先给出明确答案或结论，然后再补充必要的推导、前提和易错点。不要用长篇铺垫引入答案。若问题本身有歧义，先用一句话确认所问的内容再作答。仅在我追问时才展开完整推导。',
    }),
  }),
])

export const BUILTIN_IDS = Object.freeze(BUNDLED_PRESETS.map((preset) => preset.id))

/** Look up a bundled definition. Returns undefined for unknown or user ids. */
export function bundledPreset(id) {
  return BUNDLED_PRESETS.find((preset) => preset.id === id)
}
