/**
 * 终端对话 World TerminalWorld。
 *
 * 定位:和QQ客户端同层级的外部平台。
 * 职责边界:Worldowns聊天协议(JSON行),不监听端口——连接由外面交进来。
 *
 * **唯一入口**:`stream(panel, socket)` —— 通用控制台页流式通道
 * (`ConsolePageContribution.stream`)。对话在框架眼里只是"一个带流的普通
 * 控制台页",框架不认识"聊天",也不为它留具名槽位。
 *
 * 连接宿主的形状压在 `ChatPeer` 这层薄适配上(文件末尾的 `streamPeer`),协议解析、
 * 名单、广播、历史回放都在这一份实现里。
 *
 * 命名统一为「终端」;`Web` 之名留给 CorticoWeb 延伸应用。
 *
 * 事件词表:
 *   terminal.message  操作员消息, origin:'internal' + trigger:'flush'(跳过合批安静窗口)
 *   (进出终端不投递事件:presence 噪音多次被判定不值得打扰bot)
 *   terminal.self     自己发出的消息回录, deliver:false
 *   terminal.invite   操作员按下终端页那颗按钮, origin:'internal' + trigger:'flush'
 *
 * 控制台通道的两条纪律:
 *   - 投递按 `internal`:这条通道装的不是"外面发生了什么",是操作员直接对她说话。
 *     loop 把 internal 项并进 user 消息,角色上高于落在工具回执区的外部事件。
 *     代价是 internal 项不参与重启补投(loop 只补 external),掉线期间的后台话不补看。
 *   - 配了口令就每条消息自带 `[控制台|PIN:******]` 标记,同一串数字经环境提示词模板
 *     进前缀供她比对。冒充控制台口吻的弹幕因此当场露馅。
 *
 * 语言分两层。给操作员看的(控制台声明、流上的系统提示、面板调用面的错误)按发起
 * 请求的界面语言取:`console(language)` 每次请求重算,每条流按握手时的语言记在
 * `ChatClient.language` 上,同一场对话里两个人可以各看各的语言。给模型看的(口令标记
 * `[console|PIN:******]`、回录正文、附件的文本形态、`terminal_send` 的回执、环境提示词
 * 模板 `ENV_PROMPT.md`)固定英文,不随任何设置变。
 *
 * 聊天协议(JSON行):
 *   客户端→ {type:'hello', name}                报名字(必须先于msg)
 *          {type:'msg', text, images?}         发消息;images 为 [{mime, base64, name?}],
 *                                              text 与 images 至少一样非空
 *          {type:'greet', label}               按下终端页那颗按钮;label 是按钮上当时显示的字
 *   服务端→ {type:'msg', from, text, ts, images?}  广播(用户消息回显+bot消息);
 *                                              images 为 [{ref, mime, name?}](ref 是附件句柄)
 *          {type:'sys', text}                  系统提示
 *
 * 图片进媒体库(core data/media/),事件只带引用;正文末尾标注张数,模型不接受
 * 图像时标注里同时写明她看不到,不让她对着一句"附图"猜内容。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BlobInput, EventEnvelope, World, WorldHost, WorldConsoleDecl, ToolDef } from '../../core/types.ts';
import type { ConfigGroup } from '../../core/config-schema.ts';
import type { ConsoleStream } from '../../web/shared/console-protocol.ts';
import { nowIso, shortTime } from '../../core/util.ts';
import { pick, type Language } from '../../core/language.ts';
import { TERMINAL_DEFAULTS, type TerminalConfigSection } from './config.ts';

/** 环境提示词模板。给模型的文本,固定英文。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 本 World 唯一的面板局部 id(一页内唯一即可,不带 World 名前缀)。 */
const PANEL_CHAT = 'chat';

/** 口令的形状:六位数字,别的一律当没配置。 */
const PIN_SHAPE = /^\d{6}$/;

/**
 * 模型可见的文本,固定英文:口令标记、回录正文、附件的文本形态、`terminal_send` 的回执。
 * 口令标记写在正文最前面,与普通行(`[HH:MM] 名字: …`)不同形,不易混淆。
 *
 * `invite` 引号里的按钮标签是例外:它逐字取自按下时界面上显示的字,随对方的界面语言走。
 * 被引用的标签是这件事的事实内容,和口令标记里的数字同类。
 */
const MODEL_TEXT = {
  pinMark: (pin: string) => `[console|PIN:${pin}]`,
  selfLine: (time: string, text: string) => `[${time}] you: ${text}`,
  inviteLine: (time: string, name: string, label: string, spokenBefore: boolean) =>
    `[${time}] ${name} pressed the "${label}" button on the terminal.`
    + (spokenBefore ? '' : ' Nothing has been said here before.')
    + ' You may say hello and introduce yourself.',
  imageFallback: (from: string, i: number, total: number) => `image ${i}/${total} from ${from}`,
  deliveredTo: (delivered: number, names: string[]) =>
    `Sent to the chat channel on the console's "Terminal" page; ${delivered} connection${delivered === 1 ? '' : 's'} online right now`
    + (names.length ? ` (${names.join(', ')})` : ''),
  deliveredToNobody:
    'Sent to the chat channel on the console\'s "Terminal" page; no connection is open right now, so nobody sees this at the moment; '
    + 'it is stored and will show up in the history for whoever connects next',
  sinceLastSend: (minutes: number, since: number) =>
    `The previous one went out ${minutes} minute${minutes === 1 ? '' : 's'} ago; since then `
    + (since === 0 ? 'nobody has said anything on the terminal' : `${since} message${since === 1 ? '' : 's'} from people arrived on the terminal`),
  joinFacts: (facts: string[]) => `${facts.join('; ')}.`,
};

/**
 * 给操作员看的文案,两种语言各一张表;`en: typeof zh` 由 tsc 保证键集与签名一致。
 * 中文逐字保留现状(测试断言它们)。
 */
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

const en: typeof zh = {
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

type TerminalText = typeof zh;
const text = (language: Language): TerminalText => pick(language, { zh, en });

/** 口令配置组,文案按界面语言给;id / owner / 键与取值规则两种语言完全一致。 */
export function terminalConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:terminal',
    owner: 'world:terminal',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.terminal.pin': {
          type: 'string',
          title: t.pinTitle,
          'x-hot': true,
          description: t.pinDescription,
        },
      },
    },
  };
}

/**
 * 一条对话连接的宿主适配。
 *
 * 存在的理由只有一个:让协议逻辑不知道自己跑在 `ws.WebSocket` 上还是跑在
 * `ConsoleStream` 上。两个实现都在本文件底部,各自五行。
 */
interface ChatPeer {
  /** 还能收发吗。已关/正在关一律 false。 */
  readonly open: boolean;
  /** 推一帧原始文本。可能抛(调用方按"发不出去即掉线"处理)。 */
  send(raw: string): void;
  /** 正常关闭,`reason` 尽量带给对端。 */
  close(reason: string): void;
  /** 出错时立刻掐断,不走挥手。 */
  drop(): void;
}

interface ChatClient {
  peer: ChatPeer;
  /** hello 完成前为 null,完成后为客户端声明的名称。 */
  name: string | null;
  /** 这条连接握手时的界面语言;流上给它的系统提示按此取。 */
  language: Language;
}



interface TerminalWorldOptions {
  /** 渲染[HH:MM]用的时区,默认Asia/Shanghai */
  timezone?: string;
  /** 出方消息的 from 字段;取部署配置的 displayName */
  botName?: string;
  /** 配置节;不给 = 按默认值(口令未配置)。 */
  cfg?: TerminalConfigSection;
}

const NAME_MAX = 32;
const TEXT_MAX = 4000;
/** 按钮标签进事件正文前的长度上限。 */
const LABEL_MAX = 40;

/** 一条消息最多带几张图,单张解码后的字节上限。与面板侧的上限一致。 */
const IMAGES_MAX = 8;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** 接收的图片格式:媒体库认得扩展名、主流多模态模型都吃的那几种。 */
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** 回显/回放帧里的一张图:ref 是附件句柄,客户端凭它经 `blob` 调用取字节。 */
interface WireImage {
  ref: string;
  mime: string;
  name?: string;
}

/** 一条事件落库后的图片附件 → 回显/回放帧里的 images。 */
function wireImagesOf(e: EventEnvelope): WireImage[] {
  return (e.blobs ?? [])
    .filter((b) => b.mime.startsWith('image/'))
    .map((b) => ({ ref: b.handle, mime: b.mime, ...(b.name ? { name: b.name } : {}) }));
}

/** `{type:'msg'}` 里 images 的解析结果:要么整批合法,要么一句拒收理由。 */
type ParsedImages =
  | { ok: true; images: Array<{ bytes: Buffer; mime: string; name?: string }> }
  | { ok: false; reason: string };

function parseImages(raw: unknown, t: TerminalText): ParsedImages {
  if (raw === undefined) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: t.imagesNotArray };
  if (raw.length > IMAGES_MAX) return { ok: false, reason: t.tooManyImages(IMAGES_MAX) };
  const images: Array<{ bytes: Buffer; mime: string; name?: string }> = [];
  for (const item of raw) {
    const img = (item ?? {}) as { mime?: unknown; base64?: unknown; name?: unknown };
    if (typeof img.mime !== 'string' || !IMAGE_MIMES.has(img.mime)) {
      return { ok: false, reason: t.unsupportedImage(String(img.mime)) };
    }
    if (typeof img.base64 !== 'string' || !img.base64) return { ok: false, reason: t.imageNoBase64 };
    const bytes = Buffer.from(img.base64, 'base64');
    if (bytes.length === 0) return { ok: false, reason: t.imageEmpty };
    if (bytes.length > IMAGE_MAX_BYTES) {
      return { ok: false, reason: t.imageTooLarge(IMAGE_MAX_BYTES / 1024 / 1024) };
    }
    const name = typeof img.name === 'string' && img.name.trim() ? img.name.trim().slice(0, 120) : undefined;
    images.push({ bytes, mime: img.mime, ...(name ? { name } : {}) });
  }
  return { ok: true, images };
}

export class TerminalWorld implements World {
  readonly id = 'terminal';
  private host: WorldHost | null = null;
  private readonly clients = new Set<ChatClient>();
  private readonly timezone: string;
  private readonly botName: string;
  private readonly cfg: TerminalConfigSection;
  /** 上一条 terminal_send 的时刻;null = 本场还没发过 */
  private lastSendAt: number | null = null;
  /** 本场收到的操作员消息条数,以及上一条 terminal_send 发出时的读数 */
  private operatorMessages = 0;
  private operatorMessagesAtLastSend = 0;

  constructor(opts: TerminalWorldOptions = {}) {
    this.timezone = opts.timezone ?? 'Asia/Shanghai';
    this.botName = opts.botName ?? 'bot';
    this.cfg = opts.cfg ?? { ...TERMINAL_DEFAULTS };
  }

  /** 生效中的口令;形状不对当没配置(模板的缺省文案会接管那一行)。 */
  private activePin(): string {
    const pin = this.cfg.pin.trim();
    return PIN_SHAPE.test(pin) ? pin : '';
  }

  /** 文本归 ENV_PROMPT.md，这里只报口令这一个值。 */
  envPromptVars(): Record<string, string> {
    return { 'terminal.pin': this.activePin() };
  }

  /** 控制台露出:在线人数与口令状态 + 一个通往对话页的面板。文案按这次请求的界面语言。 */
  console(language: Language = 'zh'): WorldConsoleDecl {
    const t = text(language);
    const online = this.onlineCount();
    const pin = this.activePin();
    // 形状不对时静默当未配置会让人以为口令已经生效,所以这里把两种"没生效"分开说。
    const pinState = pin ? t.pinEnabled : this.cfg.pin.trim() ? t.pinMalformed : t.pinUnset;
    return {
      label: t.moduleLabel,
      // 一条链路:这个渠道不连外部任何东西,挂上了就是通的。没人在线不是故障——
      // 灯报的是"能不能说上话",不是"此刻有没有人在说"。
      lamps: [{
        label: t.lampLabel,
        state: 'online',
        hint: online > 0 ? t.lampOnline(online) : t.lampNobody,
      }],
      badges: [
        { label: t.badgeOnline, value: t.badgeOnlineValue(online), tone: online > 0 ? 'on' : 'off' },
        // 口令本身不进徽标:控制台页面会被投屏、被截图。
        { label: t.badgePin, value: pinState, tone: pin ? 'on' : 'off' },
      ],
      // 流式面:终端页经 /ws/providers/world%3Aterminal/panels/chat 接进来。这一页没有自己的面板,
      // 对话只在终端页;这里只剩配置、模板、徽标与灯。
      stream: (panel, socket) => this.stream(panel, socket, language),
      promptDocs: [
        {
          key: 'worlds.terminal.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          // bot 侧的覆盖文件(worlds/terminal/ENV_PROMPT.md)整份优先。
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{
            name: 'terminal.pin',
            description: t.pinVarDescription,
          }],
        },
      ],
      config: [terminalConfigGroup(language)],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
  }

  async stop(): Promise<void> {
    // 关闭连接前清除 host，禁止 close 回调继续投递 presence 事件。
    this.host = null;
    for (const c of [...this.clients]) {
      try { c.peer.close(text(c.language).botOffline); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  /**
   * terminal_send 回执报告目标、当前连接者、距上次发送的时间及其后是否收到终端发言。没有已读回执，不能判断消息是否被阅读；终端 World 不推断其他 World 的直播状态，也不附加建议。
   */
  private deliveryFacts(delivered: number): string {
    const t = MODEL_TEXT;
    const facts: string[] = [];
    const names = [...this.clients]
      .filter((c) => c.peer.open && c.name !== null)
      .map((c) => c.name as string);
    facts.push(delivered > 0 ? t.deliveredTo(delivered, names) : t.deliveredToNobody);
    if (this.lastSendAt !== null) {
      const minutes = Math.round((Date.now() - this.lastSendAt) / 60_000);
      const since = this.operatorMessages - this.operatorMessagesAtLastSend;
      facts.push(t.sinceLastSend(minutes, since));
    }
    return t.joinFacts(facts);
  }

  /** 当前仍打开的客户端数(面板status可用) */
  onlineCount(): number {
    let n = 0;
    for (const c of this.clients) if (c.peer.open) n++;
    return n;
  }

  /**
   * 通用流式通道的入口。控制台把 `/ws/providers/worlds:terminal/panels/chat` 的连接
   * 包成 `ConsoleStream` 交进来,World 从这里接管整条连接的生命周期。
   *
   * 扇出语义由协议定死:**一条连接一次调用**,框架不广播也不去重——所以本 World
   * 自己持一个 `clients` 集合,同时在场的人在同一个对话里,互相看得见。
   *
   * 未知面板抛错:服务端会只关这一条连接并把措辞带给对端(1011)。
   * `language` 是握手那一刻浏览器的界面语言,这条流上的系统提示都按它给。
   */
  stream(panel: string, socket: ConsoleStream, language: Language = 'zh'): void {
    if (panel !== PANEL_CHAT) throw new Error(text(language).unknownPanel(panel));
    const client = this.attach(streamPeer(socket), language);
    socket.onMessage((text) => this.onFrame(client, text));
    socket.onClose(() => this.detach(client));
    this.greet(client);
  }

  tools(): ToolDef[] {
    return [
      {
        // 固定叫 terminal_send,与前缀文档里的「终端」同名
        name: 'terminal_send',
        description: 'Send text to everyone connected to the terminal.',
        tags: ['speak'],
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to send.' },
          },
          required: ['text'],
        },
        handler: async (args) => {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (!text) return '[send failed] text must not be empty';
          if (!this.host) return '[send failed] terminal module not started';
          const delivered = this.broadcast({
            type: 'msg',
            from: this.botName,
            text,
            ts: nowIso(this.timezone),
          });
          // 自己的消息回录:只落库不投递(不会把自己吵醒)
          this.host.pushEvent(
            {
              type: 'terminal.self',
              ts: nowIso(this.timezone),
              source: this.id,
              text: MODEL_TEXT.selfLine(shortTime(this.timezone), text),
              meta: { from: this.botName, body: text },
            },
            { deliver: false },
          ).catch((e) => this.host?.log.warn('自录事件落库失败', { err: String(e) }));
          const receipt = `[sent] ${this.deliveryFacts(delivered)}`;
          this.lastSendAt = Date.now();
          this.operatorMessagesAtLastSend = this.operatorMessages;
          return receipt;
        },
      },
    ];
  }

  // ── 连接生命周期(两条入口共用) ───────────────────────────────────────

  /** 登记一条新连接。回调的挂接归各自入口,因为那是宿主 API 唯一不同的地方。 */
  private attach(peer: ChatPeer, language: Language): ChatClient {
    const client: ChatClient = { peer, name: null, language };
    this.clients.add(client);
    return client;
  }

  /** 开场白在全部回调挂载后发送。 */
  private greet(client: ChatClient): void {
    this.sendJson(client.peer, { type: 'sys', text: text(client.language).greeting });
  }

  /** 连接结束:出名单、给还在场的人一句提示。进出不打扰bot。 */
  private detach(client: ChatClient): void {
    this.clients.delete(client);
    if (client.name === null || !this.host) return;
    const name = client.name;
    this.broadcastSys((t) => t.left(name), null);
  }

  /** 给在场的每条流一句系统提示,各按自己的语言;`except` 那条不发。 */
  private broadcastSys(line: (t: TerminalText) => string, except: ChatClient | null): void {
    for (const c of [...this.clients]) {
      if (c === except || !c.peer.open) continue;
      this.sendJson(c.peer, { type: 'sys', text: line(text(c.language)) });
    }
  }

  // ── 协议(两条入口共用的唯一一份) ───────────────────────────────────

  /**
   * 收到一帧原始文本。**这是协议解析的唯一入口**——`/ws/chat` 的 `RawData` 与
   * 流式通道的 `string` 在各自入口就已经归一成文本,到这里两条路完全同一份代码。
   */
  private onFrame(client: ChatClient, raw: string): void {
    const t = text(client.language);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendJson(client.peer, { type: 'sys', text: t.notJson });
      return;
    }
    if (parsed === null || typeof parsed !== 'object') {
      this.sendJson(client.peer, { type: 'sys', text: t.malformed });
      return;
    }
    const msg = parsed as Record<string, unknown>;

    if (msg.type === 'hello') {
      const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, NAME_MAX) : '';
      if (!name) {
        this.sendJson(client.peer, { type: 'sys', text: t.emptyName });
        return;
      }
      const firstHello = client.name === null;
      client.name = name;
      this.sendJson(client.peer, { type: 'sys', text: t.hello(name) });
      if (firstHello) this.replayHistory(client);
      // 给其他在场客户端一条提示;进出不打扰bot
      if (firstHello) this.broadcastSys((tt) => tt.joined(name), client);
      return;
    }

    if (msg.type === 'msg') {
      if (client.name === null) {
        this.sendJson(client.peer, { type: 'sys', text: t.helloFirst });
        return;
      }
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, TEXT_MAX) : '';
      const parsed = parseImages(msg.images, t);
      if (!parsed.ok) {
        this.sendJson(client.peer, { type: 'sys', text: t.imagesRejected(parsed.reason) });
        return;
      }
      if (!text && parsed.images.length === 0) return; // 空消息静默忽略
      if (!this.host) {
        this.sendJson(client.peer, { type: 'sys', text: t.botNotConnected });
        return;
      }
      // 图片随事件落库:core 分配句柄并把每张的文本形态接在正文后;回显与回放只带句柄。
      const visible = parsed.images.length > 0 && this.host.modelFacts.accepts(parsed.images[0].mime);
      const total = parsed.images.length;
      const from = client.name;
      const blobs: BlobInput[] = parsed.images.map((img, i) => ({
        bytes: img.bytes,
        mime: img.mime,
        ...(img.name ? { name: img.name } : {}),
        fallbackText: MODEL_TEXT.imageFallback(from, i + 1, total),
      }));
      // 操作员消息:落库 + internal 投递(进 user 区)+ flush(跳过合批安静窗口)。
      // 口令标记由 World 加,操作员不打;meta.from/body 供 hello 时历史回放还原,图片从落库的 blobs 取。
      const pin = this.activePin();
      const line = `[${shortTime(this.timezone)}] ${client.name}: ${text}`;
      // terminal_send 回执要报"上一条发出之后终端上有没有人说过话",按条数记比
      // 按时间戳比更准:事件库的 ts 只到秒,同秒的消息分不出先后。
      this.operatorMessages += 1;
      const host = this.host;
      host.pushEvent(
        {
          type: 'terminal.message',
          ts: nowIso(this.timezone),
          source: this.id,
          origin: 'internal',
          text: pin ? `${MODEL_TEXT.pinMark(pin)} ${line}` : line,
          senderKey: client.name,
          meta: { from: client.name, body: text },
          ...(blobs.length ? { blobs } : {}),
        },
        { trigger: 'flush' },
      ).then((envelope) => {
        // 回显广播给所有客户端(含发送者本人——前端以回显为准渲染);句柄在落库后才有。
        const wireImages = wireImagesOf(envelope);
        this.broadcast({
          type: 'msg', from: client.name, text, ts: envelope.ts,
          ...(wireImages.length ? { images: wireImages } : {}),
        });
      }).catch((e) => host.log.warn('消息事件投递失败', { err: String(e) }));
      if (total > 0 && !visible) {
        this.sendJson(client.peer, { type: 'sys', text: t.modelBlind(host.modelFacts.model()) });
      }
      return;
    }

    if (msg.type === 'greet') {
      if (client.name === null) {
        this.sendJson(client.peer, { type: 'sys', text: t.helloFirst });
        return;
      }
      if (!this.host) {
        this.sendJson(client.peer, { type: 'sys', text: t.botNotConnected });
        return;
      }
      // 标签逐字进事件正文,所以压成一行并截断;没有标签就没有可引用的事实,这一帧作废。
      const label = typeof msg.label === 'string' ? msg.label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) : '';
      if (!label) return;
      const host = this.host;
      host.pushEvent(
        {
          type: 'terminal.invite',
          ts: nowIso(this.timezone),
          source: this.id,
          origin: 'internal',
          text: MODEL_TEXT.inviteLine(shortTime(this.timezone), client.name, label, this.spokenBefore()),
          senderKey: client.name,
          meta: { from: client.name, label },
        },
        { trigger: 'flush' },
      ).catch((e) => host.log.warn('按钮事件投递失败', { err: String(e) }));
      return;
    }

    this.sendJson(client.peer, { type: 'sys', text: t.unknownType(String(msg.type)) });
  }

  /** 这个终端上有没有人说过话。末尾几十条够判断:这颗按钮只在事件库还空着时露面。 */
  private spokenBefore(): boolean {
    if (!this.host) return false;
    return this.host.store
      .range({ source: this.id, limit: 50 })
      .some((e) => e.type === 'terminal.message' || e.type === 'terminal.self');
  }

  /** hello 后回放最近的对话历史;发言人与正文读本 World 落库时写下的 meta.from/body。 */
  private replayHistory(client: ChatClient): void {
    if (!this.host) return;
    const events = this.host.store
      .range({ source: this.id, limit: 60 })
      .filter((e) => e.type === 'terminal.message' || e.type === 'terminal.self')
      .slice(-30);
    for (const e of events) {
      const { from, body } = e.meta as { from: string; body: string };
      const images = wireImagesOf(e);
      this.sendJson(client.peer, {
        type: 'msg', from, text: body, ts: e.ts, history: true,
        ...(images.length ? { images } : {}),
      });
    }
  }

  /** 返回实际送达的客户端数，并移除已关闭的连接。 */
  private broadcast(payload: unknown): number {
    const raw = JSON.stringify(payload);
    let n = 0;
    for (const c of [...this.clients]) {
      if (c.peer.open) {
        try {
          c.peer.send(raw);
          n++;
        } catch {
          this.clients.delete(c);
          c.peer.drop();
        }
      } else {
        // close 回调迟到前先移除已关闭的连接。
        this.clients.delete(c);
      }
    }
    return n;
  }

  private sendJson(peer: ChatPeer, payload: unknown): void {
    if (!peer.open) return;
    try { peer.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 宿主适配:把流式连接对象包成 ChatPeer
// ---------------------------------------------------------------------------

/**
 * 通用流式通道。
 *
 * `ConsoleStream` 的 `send` 已经保证"已关时静默丢弃、不抛",`close` 也不抛,
 * 所以这层几乎是恒等映射;`drop` 没有对应物(协议里没有 terminate),退成 close。
 */
function streamPeer(socket: ConsoleStream): ChatPeer {
  return {
    get open(): boolean { return socket.open; },
    send(raw: string): void { socket.send(raw); },
    close(reason: string): void { socket.close(reason); },
    drop(): void { try { socket.close('connection error'); } catch { /* ignore */ } },
  };
}
