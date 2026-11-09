import { pick, type Language } from 'cortico/core/language.ts';
import { webUiText as webUiZhHant, panelText as panelZhHant, configText as configZhHant } from './strings.zh-Hant.ts';
import { webUiText as webUiJa, panelText as panelJa, configText as configJa } from './strings.ja.ts';
import { webUiText as webUiKo, panelText as panelKo, configText as configKo } from './strings.ko.ts';
import { webUiText as webUiFr, panelText as panelFr, configText as configFr } from './strings.fr.ts';
import { webUiText as webUiDe, panelText as panelDe, configText as configDe } from './strings.de.ts';
import { webUiText as webUiEs419, panelText as panelEs419, configText as configEs419 } from './strings.es-419.ts';
import { webUiText as webUiPtBR, panelText as panelPtBR, configText as configPtBR } from './strings.pt-BR.ts';
import { webUiText as webUiIt, panelText as panelIt, configText as configIt } from './strings.it.ts';
import { webUiText as webUiRu, panelText as panelRu, configText as configRu } from './strings.ru.ts';

/** persona.ts 给 WebUI 的文案。 */
const webUiZh = {
  orientation: 'Persona的存在方式与元认知说明。',
  constitution: 'Persona 的长期原则。重载系统前缀或开始新上下文后生效。',
  memoryNote: '记忆约定:bot 的档案怎么存、什么时候会自动浮现。',
  workspaceLabel: '工作区(bot 自己写的记忆文件)',
  workspaceNote: '宪法之外的全部工作区文件不可恢复地删除;宪法与人格检查点不动',
  workspaceStat: (n: number) => `${n}个文件(宪法之外)`,
  workspaceCleared: (n: number) => `已删除 ${n} 个工作区文件;宪法未动`,
  firstTurnUser: '首轮·用户输入',
  firstTurnUserDesc: '合成首轮对话的 user 消息。与回复任一为空则整轮不注入。',
  firstTurnThinking: '首轮·思维链',
  firstTurnThinkingDesc: '合成首轮 assistant 的思维链(reasoning_content);为空则该轮不带。注:openai-responses-compat 方言不回传思维链,这段在该类端点上不出线。',
  firstTurnReply: '首轮·回复',
  firstTurnReplyDesc: '合成首轮对话的 assistant 回复正文。',
};
export const webUiEn: typeof webUiZh = {
  orientation: 'How the Persona exists and its metacognition notes.',
  constitution: 'The Persona\'s long-term principles. Changes take effect after a system prefix reload or when a new context starts.',
  memoryNote: 'Memory conventions: how the bot\'s files are stored and when they surface on their own.',
  workspaceLabel: 'Workspace (memory files the bot wrote itself)',
  workspaceNote: 'Every workspace file except the constitution is deleted irrecoverably; the constitution and persona checkpoints are untouched',
  workspaceStat: (n: number) => `${n} file${n === 1 ? '' : 's'} (besides the constitution)`,
  workspaceCleared: (n: number) => `Deleted ${n} workspace file${n === 1 ? '' : 's'}; the constitution is untouched`,
  firstTurnUser: 'First turn · user input',
  firstTurnUserDesc: 'The user message of the synthesized first turn. When either this or the reply is empty, the whole turn is not injected.',
  firstTurnThinking: 'First turn · reasoning',
  firstTurnThinkingDesc: 'The reasoning (reasoning_content) of the synthesized first assistant turn; empty = the turn carries none. The openai-responses-compat dialect does not return reasoning, so this part never goes on the wire for such endpoints.',
  firstTurnReply: 'First turn · reply',
  firstTurnReplyDesc: 'The assistant reply text of the synthesized first turn.',
};
export const webUiText = (language: Language) => pick(language, {
  zh: webUiZh, en: webUiEn, 'zh-Hant': webUiZhHant, ja: webUiJa, ko: webUiKo,
  fr: webUiFr, de: webUiDe, 'es-419': webUiEs419, 'pt-BR': webUiPtBR, it: webUiIt,
  ru: webUiRu,
});

/** config.ts 上下文阶段配置组的标题与说明。 */
const configZh = {
  title: '上下文与交接',
  description: '模型窗口与单次输出上限在「模型供应商」页配置。上下文达到模型硬限制时由 Core 强制交接。',
  maxTokens: '上下文阶段预算',
  maxTokensDesc: '上下文超过阶段预算 × 软阈值比例时先提示；下一批结束时仍超出则交接。',
  keepRatio: '交接保留比例',
  keepRatioDesc: '交接笔记的 token 预算 = 阶段预算 × 此比例。笔记保留最近内容，更早的部分只留计数。',
  softRatio: '软阈值比例',
  softRatioDesc: '上下文预警阈值 = 阶段预算 × 此比例。',
  firstTurn: '合成首轮对话',
  firstTurnDesc: '把部署 prompts/ 里的首轮对话(FIRST_TURN_USER / THINKING / REPLY)作为合成开头送进每次请求,不写入 session;内容为空时不送。',
};
export const configEn: typeof configZh = {
  title: 'Context and handoff',
  description: 'The model window and the output limit per response are set on the Model connections page. When the context reaches the model\'s hard limit, Core forces a handoff.',
  maxTokens: 'Context stage budget',
  maxTokensDesc: 'When the context exceeds stage budget × soft threshold ratio, a warning comes first; if it still exceeds it when the next batch ends, the handoff follows.',
  keepRatio: 'Handoff keep ratio',
  keepRatioDesc: 'Token budget of the handoff note = stage budget × this ratio. The note keeps the most recent content; earlier parts are kept only as counts.',
  softRatio: 'Soft threshold ratio',
  softRatioDesc: 'Context warning threshold = stage budget × this ratio.',
  firstTurn: 'Synthesized first turn',
  firstTurnDesc: 'Sends the first turn from the deployment\'s prompts/ (FIRST_TURN_USER / THINKING / REPLY) with every request as a synthesized opening, without writing it to the session; nothing is sent while it is empty.',
};
export const configText = (language: Language) => pick(language, {
  zh: configZh, en: configEn, 'zh-Hant': configZhHant, ja: configJa, ko: configKo,
  fr: configFr, de: configDe, 'es-419': configEs419, 'pt-BR': configPtBR, it: configIt,
  ru: configRu,
});

/** webUiSurface.ts 的面板标题、说明、读写回执与报错。 */
const panelZh = {
  workspace: '工作区',
  workspaceDesc: '保存时以 operator 署名提交到工作区的 Git 仓库。',
  history: '版本历史',
  saved: '已保存',
  removed: '已删除',
  renamed: '已改名',
  committed: (done: string, hash: string) => `${done}并提交(${hash})`,
  notCommitted: (done: string) => `${done}(git 未提交:无改动或不可用)`,
  missingArg: (what: string) => `缺少 ${what}`,
  movedOrDeleted: '文件已被移动或删除',
  changedBeforeSave: '文件已在别处被修改，请重新载入后再保存',
  changedBeforeRemove: '文件已在别处被修改，请重新载入后再删除',
  changedBeforeRename: '文件已在别处被修改，请重新载入后再改名',
  fileMissing: (path: string) => `文件不存在:${path}`,
  isDirectory: (path: string) => `${path} 是目录,不是文件`,
  tooLargeToPreview: '文件超过1MB,拒绝预览',
  binaryFile: '二进制文件,拒绝预览',
  contentNotString: 'content 必须是字符串',
  nulInText: '文本不能包含 NUL 字符',
  tooLargeToSave: '文件超过1MB，拒绝保存',
  nameTaken: '同名文件已经存在',
  unknownMethod: (panel: string, method: string) => `未知面板方法: ${panel}.${method}`,
  unknownPanel: (panel: string) => `未知面板: ${panel}`,
};
export const panelEn: typeof panelZh = {
  workspace: 'Workspace',
  workspaceDesc: 'Saving commits to the workspace Git repository, authored as operator.',
  history: 'Version history',
  saved: 'Saved',
  removed: 'Deleted',
  renamed: 'Renamed',
  committed: (done: string, hash: string) => `${done} and committed (${hash})`,
  notCommitted: (done: string) => `${done} (not committed to git: no changes or git unavailable)`,
  missingArg: (what: string) => `Missing ${what}`,
  movedOrDeleted: 'The file has been moved or deleted',
  changedBeforeSave: 'The file was changed elsewhere; reload it before saving',
  changedBeforeRemove: 'The file was changed elsewhere; reload it before deleting',
  changedBeforeRename: 'The file was changed elsewhere; reload it before renaming',
  fileMissing: (path: string) => `File does not exist: ${path}`,
  isDirectory: (path: string) => `${path} is a folder, not a file`,
  tooLargeToPreview: 'The file exceeds 1MB and is not previewed',
  binaryFile: 'Binary file, not previewed',
  contentNotString: 'content must be a string',
  nulInText: 'The text must not contain NUL characters',
  tooLargeToSave: 'The file exceeds 1MB and was not saved',
  nameTaken: 'A file with this name already exists',
  unknownMethod: (panel: string, method: string) => `Unknown panel method: ${panel}.${method}`,
  unknownPanel: (panel: string) => `Unknown panel: ${panel}`,
};
export const panelText = (language: Language) => pick(language, {
  zh: panelZh, en: panelEn, 'zh-Hant': panelZhHant, ja: panelJa, ko: panelKo, fr: panelFr,
  de: panelDe, 'es-419': panelEs419, 'pt-BR': panelPtBR, it: panelIt, ru: panelRu,
});
