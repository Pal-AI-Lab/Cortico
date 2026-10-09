import { pick, type Language } from '../../core/language.ts';
import { text as zhHant } from './strings.zh-Hant.ts';
import { text as ja } from './strings.ja.ts';
import { text as ko } from './strings.ko.ts';
import { text as fr } from './strings.fr.ts';
import { text as de } from './strings.de.ts';
import { text as es419 } from './strings.es-419.ts';
import { text as ptBR } from './strings.pt-BR.ts';
import { text as it } from './strings.it.ts';
import { text as ru } from './strings.ru.ts';

/** 给操作员看的文案。中文逐字保留现状(测试断言它们)。 */
const zh = {
  // ── 配置组 ─────────────────────────────────────────────────────────
  configTitle: '终端 · 控制台口令',
  configDescription:
    '口令是控制台指示的凭据:World 给每条终端消息自动加上 [console|PIN:……] 标记,'
    + '同一串数字进她的系统前缀供比对。对得上的照办,自称控制台却对不上的当普通外部输入。'
    + '操作员不用手打口令,也不该在别处提起它。',
  pinTitle: '控制台口令(六位数字)',
  pinDescription:
    '空 = 不启用:消息不带标记,前缀里也没有可比对的口令。不是六位数字的值一律当未配置'
    + '(控制台徽标会说「格式不对」)。',
  // ── 控制台露出:灯、徽标、面板、模板 ────────────────────────────────
  lampLabel: '对话通道',
  lampOnline: (n: number) => `${n} 人在线`,
  lampNobody: '无人在线',
  badgeOnline: '在线',
  badgeOnlineValue: (n: number) => `${n} 人`,
  badgePin: '口令',
  pinEnabled: '已启用',
  pinMalformed: '格式不对',
  pinUnset: '未设置',
  moduleLabel: '终端对话',
  promptDocTitle: '终端 · 环境提示词',
  promptDocDescription: '终端对话环境的常驻事实。',
  pinVarDescription: '本场的控制台口令(worlds.terminal.pin);没配置或形状不对时展开成模板里的缺省文案。',
  // ── 流上的系统提示与关闭理由 ───────────────────────────────────────
  greeting: '已连接。请发送 {type:"hello", name:"你的名字"} 报上名字。',
  botOffline: 'bot下线',
  left: (name: string) => `${name} 离开了对话`,
  joined: (name: string) => `${name} 进入了对话`,
  notJson: '消息不是合法JSON,已忽略',
  malformed: '消息格式不对,已忽略',
  emptyName: '名字不能为空',
  hello: (name: string) => `你好,${name}。`,
  helloFirst: '请先发送 hello 设置名字',
  imagesRejected: (reason: string) => `图片未发送: ${reason}`,
  botNotConnected: 'bot尚未连接,消息未送达',
  deliveryFailed: (err: string) => `消息未送达: ${err}`,
  modelBlind: (model: string) => `当前模型 ${model} 不接收图像,她只看到每张图的文字说明`,
  unknownType: (type: string) => `未知消息类型: ${type}`,
  // ── 图片解析的拒收理由 ─────────────────────────────────────────────
  imagesNotArray: 'images 必须是数组',
  tooManyImages: (max: number) => `一条消息最多 ${max} 张图`,
  unsupportedImage: (mime: string) => `不支持的图片格式: ${mime}`,
  imageNoBase64: '图片缺少 base64 内容',
  imageEmpty: '图片内容为空',
  imageTooLarge: (mb: number) => `单张图片超过 ${mb}MB`,
  // ── 流式通道名不对时的错误(措辞会带给对端) ────────────────────────
  unknownPanel: (panel: string) => `未知通道: ${panel}`,
};

export const en: typeof zh = {
  configTitle: 'Terminal · Console PIN',
  configDescription:
    'The PIN is the credential behind console instructions: the module stamps every terminal message with a '
    + '[console|PIN:……] marker, and the same digits go into her system prefix for comparison. A match is obeyed; '
    + 'anything claiming to be the console without a match is ordinary external input. '
    + 'Operators never type the PIN by hand and should not mention it elsewhere.',
  pinTitle: 'Console PIN (six digits)',
  pinDescription:
    'Empty = disabled: messages carry no marker and the prefix has no PIN to compare against. '
    + 'Any value that is not six digits counts as unset (the console badge says "malformed").',
  lampLabel: 'Chat channel',
  lampOnline: (n) => `${n} online`,
  lampNobody: 'Nobody online',
  badgeOnline: 'Online',
  badgeOnlineValue: (n) => (n === 1 ? '1 person' : `${n} people`),
  badgePin: 'PIN',
  pinEnabled: 'Enabled',
  pinMalformed: 'Malformed',
  pinUnset: 'Not set',
  moduleLabel: 'Terminal chat',
  promptDocTitle: 'Terminal · Environment prompt',
  promptDocDescription: 'Standing facts about the terminal chat environment.',
  pinVarDescription: 'This session\'s console PIN (worlds.terminal.pin); expands to the template\'s default text when unset or malformed.',
  greeting: 'Connected. Send {type:"hello", name:"your name"} to introduce yourself.',
  botOffline: 'bot offline',
  left: (name) => `${name} left the chat`,
  joined: (name) => `${name} joined the chat`,
  notJson: 'Message is not valid JSON; ignored',
  malformed: 'Malformed message; ignored',
  emptyName: 'Name must not be empty',
  hello: (name) => `Hello, ${name}.`,
  helloFirst: 'Send hello to set a name first',
  imagesRejected: (reason) => `Images not sent: ${reason}`,
  botNotConnected: 'The bot is not connected yet; message not delivered',
  deliveryFailed: (err) => `Message not delivered: ${err}`,
  modelBlind: (model) => `The current model ${model} does not accept images; she only sees each image's text description`,
  unknownType: (type) => `Unknown message type: ${type}`,
  imagesNotArray: 'images must be an array',
  tooManyImages: (max) => `At most ${max} images per message`,
  unsupportedImage: (mime) => `Unsupported image format: ${mime}`,
  imageNoBase64: 'Image is missing its base64 content',
  imageEmpty: 'Image content is empty',
  imageTooLarge: (mb) => `A single image exceeds ${mb}MB`,
  unknownPanel: (panel) => `Unknown channel: ${panel}`,
};
export const text = (language: Language) => pick(language, {
  zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
});
