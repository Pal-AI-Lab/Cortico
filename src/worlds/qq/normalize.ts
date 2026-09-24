/**
 * QQ群消息归一化:OneBot segment数组 ⇄ agent的纯文本世界。
 * 全部纯函数,便于单测。
 *
 * 入站:segment数组渲染成一行可读文本(谁、几点、@了谁、回复了哪条)。
 * 出站:agent的纯文本(+可选引用游标)编译回segment数组。
 * 出站不编译“@某人”为 at 段；agent 写出的 @ 文本按普通文本发送。
 */
import { shortTime } from '../../core/util.ts';
import { QFACE_NAMES } from './qface-map.ts';


/** OneBot消息段:{type, data} */
export interface Segment {
  type: string;
  data: Record<string, unknown>;
}

/** OneBot v11 群消息事件(只列归一化用到的字段) */
export interface OneBotGroupMessage {
  post_type: string;
  message_type?: string;
  group_id?: number;
  user_id: number;
  message_id: number;
  /** unix秒 */
  time?: number;
  sender?: { nickname?: string; card?: string };
  message: Segment[];
  raw_message?: string;
}


/** JSON 卡片的通用字段；字段缺失时调用方渲染 `[json]`。 */
interface JsonCardInfo {
  /** 腾讯协议提供的卡片回退文本，如 "[分享]标题"。 */
  prompt?: string;
  /** 封面图URL,取自meta.<动态key>.preview(key名随卡片类型而变,故只取meta下第一个) */
  previewUrl?: string;
}

/**
 * 解析 JSON 卡片的通用 prompt 与 meta.*.preview 字段。
 * 解析失败或字段缺失时返回空对象，调用方渲染 `[json]`。
 */
export function parseJsonCard(data: Record<string, unknown>): JsonCardInfo {
  const raw = data.data;
  if (typeof raw !== 'string' || !raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;
  const prompt = typeof obj.prompt === 'string' && obj.prompt ? obj.prompt : undefined;

  let previewUrl: string | undefined;
  const meta = obj.meta;
  if (meta && typeof meta === 'object') {
    for (const v of Object.values(meta as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const preview = (v as Record<string, unknown>).preview;
        if (typeof preview === 'string' && preview) {
          previewUrl = preview.startsWith('//') ? `https:${preview}` : preview;
          break;
        }
      }
    }
  }
  return { prompt, previewUrl };
}

/** json段的文本渲染策略:输入解析出的卡片信息,输出正文里的占位文本 */
export type JsonCardRenderPolicy = (info: JsonCardInfo) => string;


/** 图片segment的渲染策略函数:输入segment.data,输出占位文本 */
export type ImageRenderPolicy = (data: Record<string, unknown>) => string;

/**
 * 生成图片渲染策略:
 * - 取不到图 → 降级 `[图片]`
 * - 主模型支持图像或 World 配置了视觉模型 → 正文保留图片 URL 标记
 * 主模型能力通过 host.modelFacts 查询； World 自带视觉不进入 core 契约。
 */
export function makeImagePolicy(canUseImages: boolean): ImageRenderPolicy {
  if (canUseImages) {
    return (data) => {
      const url =
        typeof data.url === 'string' && data.url
          ? data.url
          : typeof data.file === 'string'
            ? data.file
            : '';
      return url ? `[图片 ${url}]` : '[图片]';
    };
  }
  return () => '[图片]';
}


export interface RenderContext {
  /** bot自己的QQ号 */
  selfId: number;
  /** bot 自己在本会话的显示名(群=该群 card;私聊=nickname),渲染 "@<名>(你)" 用 */
  selfName: string;
  timezone: string;
  /**
   * 会话标签,拼进 `[<label> HH:MM]` 前缀以标明消息来自哪个会话。
   * 群 = `群「群名」`;私聊 = `私聊`(1:1,发言人由后面的显示名承载)。
   */
  convLabel: string;
  /**
   * 这条平台 message_id 是否已被记录(QQ 消息身份即平台自身 message_id)。
   * 查不到时,对应的引用回复走异步取原文。
   */
  knowsMessage: (messageId: number | string) => boolean;
  /** 已知称呼解析(可选):@别人时尝试用称呼替代QQ号 */
  nameOf?: (qq: string) => string | undefined;
  /** 图片渲染策略(能力协商产物);缺省=降级`[图片]` */
  renderImage?: ImageRenderPolicy;
  /** json卡片渲染策略(封面图接入外挂视觉用);缺省=只显示prompt文本,无封面图占位 */
  renderJsonCard?: JsonCardRenderPolicy;
}

interface RenderedIncoming {
  /** 例: `#842485102 [群「茶话会」 21:32] 阿明(12345): 在吗` */
  text: string;
  /** 消息里@了bot自己(→urgent立即投递) */
  mentionedSelf: boolean;
}

/** 一个渲染片段:token(记号类,如@xx/[图片])与原样文本在拼接时空格规则不同 */
interface Part {
  text: string;
  isToken: boolean;
}

/** 拼接片段:token与相邻片段之间保证有一个空格分隔;text-text直接相连 */
function joinParts(parts: Part[]): string {
  let out = '';
  let prevToken = false;
  for (const p of parts) {
    if (!p.text) continue;
    if (
      out.length > 0 &&
      (prevToken || p.isToken) &&
      !out.endsWith(' ') &&
      !p.text.startsWith(' ')
    ) {
      out += ' ';
    }
    out += p.text;
    prevToken = p.isToken;
  }
  return out;
}

/**
 * 为缺少 RenderContext 的独立消息生成可读正文。
 * 结果不带发言人或时间，不解析 @ 名称，也不输出图片 URL。
 */
export function renderSegmentsPlain(segments: Segment[]): string {
  const parts: Part[] = [];
  for (const seg of segments ?? []) {
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text':
        parts.push({ text: String(data.text ?? ''), isToken: false });
        break;
      case 'at': {
        const qq = String(data.qq ?? '');
        parts.push({ text: qq === 'all' ? '@全体成员' : `@${qq}`, isToken: true });
        break;
      }
      case 'image':
        parts.push({ text: '[图片]', isToken: true });
        break;
      case 'record':
        parts.push({ text: '[语音]', isToken: true });
        break;
      case 'face': {
        const name = QFACE_NAMES[String(data.id ?? '')];
        parts.push({ text: name ? `[表情:${name}]` : '[QQ表情]', isToken: true });
        break;
      }
      case 'reply':
        parts.push({ text: '[回复某条消息]', isToken: true });
        break;
      case 'forward':
        parts.push({ text: '[转发消息]', isToken: true });
        break;
      case 'node':
        parts.push({ text: '[嵌套转发消息]', isToken: true });
        break;
      case 'json': {
        const { prompt } = parseJsonCard(data);
        parts.push({ text: prompt ? `[分享:${prompt}]` : '[json]', isToken: true });
        break;
      }
      default:
        parts.push({ text: `[${seg.type}]`, isToken: true });
        break;
    }
  }
  return joinParts(parts);
}

/**
 * 群消息 → `[HH:MM] 显示名(QQ号): 正文` + 是否@自己。
 * 显示名 = sender.card || sender.nickname || QQ号。昵称和群昵称不能作为身份依据,
 * 消息来源的QQ号(私聊来源/群消息发言人来源同理)始终随行以防身份混淆。
 */
export function renderIncoming(
  msg: OneBotGroupMessage,
  ctx: RenderContext,
): RenderedIncoming {
  const renderImage = ctx.renderImage ?? (() => '[图片]');
  let mentionedSelf = false;
  const parts: Part[] = [];

  for (const seg of msg.message ?? []) {
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text': {
        parts.push({ text: String(data.text ?? ''), isToken: false });
        break;
      }
      case 'at': {
        const qq = String(data.qq ?? '');
        if (qq === String(ctx.selfId)) {
          mentionedSelf = true;
          parts.push({ text: `@${ctx.selfName}(你)`, isToken: true });
        } else if (qq === 'all') {
          // @全体成员不是对 bot 的定向提及，不触发 urgent。
          parts.push({ text: '@全体成员', isToken: true });
        } else {
          const name = ctx.nameOf?.(qq);
          parts.push({ text: `@${name ?? qq}`, isToken: true });
        }
        break;
      }
      case 'reply': {
        const mid = String(data.id ?? '');
        parts.push({
          text: ctx.knowsMessage(mid)
            ? `[回复#${mid}]`
            : '[回复某条未被记录的消息,原文正在查询中...]',
          isToken: true,
        });
        break;
      }
      case 'image': {
        parts.push({ text: renderImage(data), isToken: true });
        break;
      }
      // 语音条的音频不随消息到达,取回它要另一次动作调用;这里只说这是一条语音。
      case 'record': {
        parts.push({ text: '[语音]', isToken: true });
        break;
      }
      case 'face': {
        const name = QFACE_NAMES[String(data.id ?? '')];
        parts.push({ text: name ? `[表情:${name}]` : '[QQ表情]', isToken: true });
        break;
      }
      case 'forward': {
        parts.push({ text: '[转发的聊天记录,正在展开中...]', isToken: true });
        break;
      }
      case 'json': {
        const info = parseJsonCard(data);
        const rendered = ctx.renderJsonCard
          ? ctx.renderJsonCard(info)
          : info.prompt
            ? `[分享:${info.prompt}]`
            : '[json]';
        parts.push({ text: rendered, isToken: true });
        break;
      }
      default: {
        // 未知segment类型:保留类型名占位,不丢信息也不崩
        parts.push({ text: `[${seg.type}]`, isToken: true });
        break;
      }
    }
  }

  const displayName =
    msg.sender?.card || msg.sender?.nickname || String(msg.user_id);
  const when =
    typeof msg.time === 'number' ? new Date(msg.time * 1000) : new Date();
  const body = joinParts(parts);
  // 行首的 `#<message_id>` 是这条消息在 QQ 上的真身份:引用回复哪条,就把这个
  // 号回传给 draft(reply_to)。它由 World 渲染(平台自己的 ID),不是 core 的存储位置。
  const idTag = msg.message_id !== undefined ? `#${msg.message_id} ` : '';
  return {
    text: `${idTag}[${ctx.convLabel} ${shortTime(ctx.timezone, when)}] ${displayName}(${msg.user_id}): ${body}`,
    mentionedSelf,
  };
}


interface OutgoingArgs {
  text: string;
  /** 引用回复的平台 message_id(draft(reply_to) 收到的就是这个号) */
  reply_to_message_id?: number | string;
  /** 图片base64(不含data:前缀);有则编译成image段(OneBot base64://) */
  image_base64?: string;
  /** 语音base64(不含data:前缀);有则整条消息只有这一个record段 */
  record_base64?: string;
}

/**
 * 出站 → segment数组:reply段(如有)在前,然后image段(如有),最后text段
 * (text非空才加——支持只发图不带字)。
 * 语音条独占一条消息:QQ 的 record 段不与别的段同发,给了它就只发它。
 * 不做 @ 编译：agent 写出的“@某人”作为纯文本原样发出。
 */
export function buildOutgoing(args: OutgoingArgs): Segment[] {
  if (args.record_base64) {
    return [{ type: 'record', data: { file: `base64://${args.record_base64}` } }];
  }
  const segments: Segment[] = [];
  if (args.reply_to_message_id !== undefined) {
    segments.push({ type: 'reply', data: { id: String(args.reply_to_message_id) } });
  }
  if (args.image_base64) {
    segments.push({ type: 'image', data: { file: `base64://${args.image_base64}` } });
  }
  if (args.text) {
    segments.push({ type: 'text', data: { text: args.text } });
  }
  return segments;
}
