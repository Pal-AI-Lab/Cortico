import { pick, type Language } from 'cortico/core/language.ts';
import { consoleText as consoleZhHant, panelText as panelZhHant } from './strings.zh-Hant.ts';
import { consoleText as consoleJa, panelText as panelJa } from './strings.ja.ts';
import { consoleText as consoleKo, panelText as panelKo } from './strings.ko.ts';
import { consoleText as consoleFr, panelText as panelFr } from './strings.fr.ts';
import { consoleText as consoleDe, panelText as panelDe } from './strings.de.ts';
import { consoleText as consoleEs419, panelText as panelEs419 } from './strings.es-419.ts';
import { consoleText as consolePtBR, panelText as panelPtBR } from './strings.pt-BR.ts';
import { consoleText as consoleIt, panelText as panelIt } from './strings.it.ts';
import { consoleText as consoleRu, panelText as panelRu } from './strings.ru.ts';

/** persona.ts 给控制台的文案。 */
const consoleZh = {
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
export const consoleEn: typeof consoleZh = {
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
export const consoleText = (language: Language) => pick(language, {
  zh: consoleZh, en: consoleEn, 'zh-Hant': consoleZhHant, ja: consoleJa, ko: consoleKo,
  fr: consoleFr, de: consoleDe, 'es-419': consoleEs419, 'pt-BR': consolePtBR, it: consoleIt,
  ru: consoleRu,
});

/** consoleSurface.ts 的面板标题、说明、读写回执与报错。 */
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
