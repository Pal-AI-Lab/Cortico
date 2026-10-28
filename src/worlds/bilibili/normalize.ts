/** 将原始 cmd 转换为事件、累加计数或最新读数；不处理的命令返回 null。计数与读数由 World 聚合后随批次投递。 */
import type { TriggerMode } from '../../core/types.ts';
import { giftFrameData } from './gift-frame.ts';
import { pbFromBase64, pbInt, pbSub, pbText } from './protobuf.ts';

export interface LiveEvent {
  kind: 'event';

  type: string;
  trigger: TriggerMode;
  text: string;
  senderKey?: string;
  meta?: Record<string, unknown>;
  coalesce?: LiveEventCoalescing;
}

type LiveEventCoalescing =
  | { kind: 'danmaku'; key: string; body: string }
  /** yuan 为 null 时金额未知，合并正文省略金额。 */
  | { kind: 'gift'; key: string; gift: string; num: number; yuan: number | null };

/** 期间累加的次数 */
export type CountField = 'enter' | 'like' | 'freeGift';
/** 当前值,只留最新 */
export type GaugeField = 'watched' | 'online' | 'popularity' | 'fans' | 'likeTotal';

interface LiveCount {
  kind: 'count';
  field: CountField;
  by: number;
}

interface LiveGauge {
  kind: 'gauge';
  field: GaugeField;
  value: number;
}

/**
 * 进场/关注/分享的一个人。不是事件:World 决定它算新人欢迎、关注答谢,还是只进人流计数。
 * action 取自 msg_type(1 进场 2 关注 3 分享 4 特别关注 5 互粉),认不出的按进场。
 */
export interface LiveInteract {
  kind: 'interact';
  action: 'enter' | 'follow' | 'share';
  uid: number;
  uname: string;
  face: string;
  /** 本房间粉丝牌等级;V2 帧不带牌子,读不到为 0 */
  medalLevel: number;
}

export type Normalized = LiveEvent | LiveCount | LiveGauge | LiveInteract;

/** 1 元 = 1000 金瓜子 */
const COIN_PER_YUAN = 1000;

const IGNORED = new Set([
  'COMBO_SEND',
  'COMBO_END',
  'NOTICE_MSG',
  'SYS_MSG',
  'WIDGET_BANNER',
  'RECOMMEND_CARD',
  'GOTO_BUY_FLOW',
  'STOP_LIVE_ROOM_LIST',
  'HOT_ROOM_NOTIFY',
  'POPULAR_RANK_CHANGED',
  'ONLINE_RANK_V3',
  'ONLINE_RANK_TOP3',
  'UNIVERSAL_ASR_TEXT',
  'DM_INTERACTION',
  'LOG_IN_NOTICE',
  'ENTRY_EFFECT_MUST_RECEIVE',
]);

export interface NormalizeOptions {
  /** 礼物提到 flush 的门槛(元) */
  giftFlushYuan: number;
  /** 解析或金额换算告警，由调用方记录日志。 */
  warn?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * GUARD_BUY 金额的合理区间（元）。data.price 的单位尚未实证，换算结果超出区间时省略金额；单位需以真实原帧和平台逐笔金额核对。
 */
const GUARD_YUAN_MIN = 1;
const GUARD_YUAN_MAX = 30000;

export function normalize(msg: Record<string, unknown>, opts: NormalizeOptions): Normalized | null {

  const cmd = String(msg.cmd ?? '').split(':')[0];
  if (IGNORED.has(cmd)) return null;
  const data = obj(msg.data);

  switch (cmd) {
    case 'DANMU_MSG':
    case 'DANMU_MSG_MIRROR':
      return danmaku(msg);

    case 'SUPER_CHAT_MESSAGE': {
      const user = obj(data.user_info);
      const uid = audienceUid(data);
      const uname = str(user.uname) || '某位观众';
      const yuan = num(data.price);
      return {
        kind: 'event',
        type: 'bilibili.superchat',
        trigger: 'flush',
        text: `[醒目留言 ¥${yuan}|${uname}] ${str(data.message)}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          yuan,
          messageId: data.id,
          avatarUrl: imageUrl(user.face),
          guardLevel: num(user.guard_level),
          isAdmin: bool(user.manager),
        },
      };
    }

    case 'SUPER_CHAT_MESSAGE_DELETE':
      return {
        kind: 'event',
        type: 'bilibili.superchat-del',
        trigger: 'piggyback',
        text: '[醒目留言被删除]',
        meta: { ids: data.ids },
      };

    case 'GUARD_BUY': {
      const uid = audienceUid(data);
      const uname = str(data.username) || '某位观众';
      const gift = str(data.gift_name) || '大航海';
      const n = num(data.num) || 1;

      const price = num(data.price);
      const yuan = price / COIN_PER_YUAN;
      const yuanKnown = price > 0 && yuan >= GUARD_YUAN_MIN && yuan <= GUARD_YUAN_MAX;
      if (price > 0 && !yuanKnown) {
        opts.warn?.('GUARD_BUY price 换算越界,金额不入账', { price, yuan });
      }
      const guardLevel = num(data.guard_level);
      return {
        kind: 'event',
        type: 'bilibili.guard',
        trigger: 'flush',
        text: yuanKnown
          ? `[上舰 ¥${trim(yuan)}|${uname}] 开通了 ${gift}×${n}`
          : `[上舰|${uname}] 开通了 ${gift}×${n}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          gift,
          num: n,
          ...(yuanKnown ? { yuan } : {}),
          ...(guardLevel > 0 ? { guardLevel } : {}),
        },
      };
    }

    // 仅在帧明确表示续费时使用续费文案；缺失角色或等级时省略对应元数据。
    case 'USER_TOAST_MSG': {
      const sender = obj(data.sender_uinfo);
      const base = obj(sender.base);
      const uid = audienceUid(data);
      const uname = str(data.username) || str(base.name) || '某位观众';
      const role = str(data.role_name);
      const guardLevel = num(data.guard_level) || num(sender.guard_level);
      const renew = str(data.toast_msg).includes('续费');
      return guardToast({ uid, uname, role, guardLevel, renew, face: base.face });
    }

    case 'USER_TOAST_MSG_V2': {

      const sender = obj(data.sender_uinfo);
      const base = obj(sender.base);
      const guard = obj(data.guard_info);
      const uid = audienceUid(data);
      const uname = str(base.name) || '某位观众';
      const role = str(guard.role_name);
      const guardLevel = num(guard.guard_level);
      const renew = str(data.toast_msg).includes('续费');
      return guardToast({ uid, uname, role, guardLevel, renew, face: base.face });
    }

    case 'SEND_GIFT':
    case 'SEND_GIFT_V2': {

      const frame = giftFrameData(data, opts.warn);
      const sender = obj(frame.sender_uinfo);
      const base = obj(sender.base);
      const uid = audienceUid(frame);
      const uname = str(frame.uname) || str(base.name) || '某位观众';
      const gift = str(frame.giftName) || str(frame.gift_name) || '礼物';
      const n = num(frame.num) || 1;
      const coinType = str(frame.coin_type);

      if (coinType && coinType !== 'gold') return { kind: 'count', field: 'freeGift', by: n };
      const totalCoin = num(frame.total_coin);

      const yuanKnown = coinType === 'gold' && totalCoin > 0;
      const yuan = totalCoin / COIN_PER_YUAN;
      if (!yuanKnown) {
        opts.warn?.('礼物帧读不出金额,按未知金额成事件', { cmd, gift, uname, coinType });
      }
      const guardLevel = num(frame.guard_level);
      const tid = str(frame.tid);
      return {
        kind: 'event',
        type: 'bilibili.gift',

        trigger: yuanKnown && yuan >= opts.giftFlushYuan ? 'flush' : 'debounce',
        text: yuanKnown
          ? `[礼物 ¥${trim(yuan)}|${uname}] ${gift}×${n}`
          : `[礼物|${uname}] ${gift}×${n}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          gift,
          num: n,
          ...(yuanKnown ? { yuan } : {}),
          avatarUrl: imageUrl(base.face),
          guardLevel,
          isAdmin: bool(frame.is_admin),
          ...(tid ? { tid } : {}),
        },
        coalesce: {
          kind: 'gift',
          // 未知金额与已知金额分别归并。
          key: JSON.stringify([gift, yuanKnown ? unitCoinKey(totalCoin, n) : '金额未知']),
          gift,
          num: n,
          yuan: yuanKnown ? yuan : null,
        },
      };
    }

    case 'ENTRY_EFFECT': {
      // 舰长进场特效。copy_writing 形如 "欢迎舰长 <%昵称%> 进入直播间"
      const line = str(data.copy_writing).replace(/<%|%>/g, '').trim();
      if (!line) return null;
      return {
        kind: 'event',
        type: 'bilibili.enter-guard',
        trigger: 'debounce',
        text: `[进场] ${line}`,
        senderKey: senderKeyOf(audienceUid(data)),
        meta: { uid: audienceUid(data) },
      };
    }

    case 'INTERACT_WORD':
    case 'INTERACT_WORD_V2': {
      // 进场/关注/分享。V1 是 JSON,V2 把同样的东西放在 data.pb 的 protobuf 里
      // (字段号同 blivedm pb.InteractWordV2:1=uid 2=uname 5=msg_type 22.2.2=face)。
      // 解不出名字就退回只计数:计数是人流读数,不需要知道是谁。
      const who = interactWho(cmd, data);
      if (!who) return { kind: 'count', field: 'enter', by: 1 };
      return { kind: 'interact', ...who };
    }

    case 'LIKE_INFO_V3_CLICK':
      return { kind: 'count', field: 'like', by: 1 };

    case 'LIKE_INFO_V3_UPDATE':
      return { kind: 'gauge', field: 'likeTotal', value: num(data.click_count) };

    case 'WATCHED_CHANGE':
      return { kind: 'gauge', field: 'watched', value: num(data.num) };

    case 'ONLINE_RANK_COUNT':
      return { kind: 'gauge', field: 'online', value: num(data.count) };

    case 'POPULARITY_CHANGE':
      return { kind: 'gauge', field: 'popularity', value: num(data.popularity) };

    case 'ROOM_REAL_TIME_MESSAGE_UPDATE':
      return { kind: 'gauge', field: 'fans', value: num(data.fans) };

    case 'LIVE':
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'flush',
        text: '[直播间] 平台已推送开播指令:直播画面已对观众可见',
      };

    case 'PREPARING':
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'flush',
        text: '[直播间] 平台已推送下播指令:直播已结束,观众已经看不到直播画面;'
          + '此后的弹幕来自仍留在房间页的人,不代表直播还在进行',
      };

    case 'ROOM_CHANGE':
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'debounce',
        text: `[直播间] 标题/分区变更为「${str(data.title)}」(${str(data.area_name)})`,
        meta: { title: data.title, area: data.area_name },
      };

    case 'ROOM_SILENT_ON':
      return { kind: 'event', type: 'bilibili.room', trigger: 'flush', text: '[直播间] 已开启全员禁言' };

    case 'ROOM_SILENT_OFF':
      return { kind: 'event', type: 'bilibili.room', trigger: 'flush', text: '[直播间] 已关闭全员禁言' };

    case 'ROOM_BLOCK_MSG': {
      const uname = str(data.uname) || str(msg.uname) || '某位观众';
      return {
        kind: 'event',
        type: 'bilibili.block',
        trigger: 'debounce',
        text: `[房管] ${uname} 被禁言`,
        meta: { uname },
      };
    }

    case 'WARNING':
      return {
        kind: 'event',
        type: 'bilibili.warning',
        trigger: 'flush',
        text: `[平台警告] ${str(msg.msg) || '直播间收到一条超管警告'}`,
      };

    case 'CUT_OFF':
      return {
        kind: 'event',
        type: 'bilibili.warning',
        trigger: 'flush',
        text: `[直播被切断] ${str(msg.msg) || '直播已被平台切断'}`,
      };

    default:
      return null;
  }
}

/** 弹幕字段：正文 info[1]，发言人 info[2][0..1]，粉丝牌 info[3]，大航海等级 info[7]。uid 为 0 时不提供稳定身份键。 */
function danmaku(msg: Record<string, unknown>): LiveEvent | null {
  const info = Array.isArray(msg.info) ? (msg.info as unknown[]) : null;
  if (!info) return null;
  const text = str(info[1]).trim();
  if (!text) return null;
  const sender = Array.isArray(info[2]) ? (info[2] as unknown[]) : [];
  const uid = num(sender[0]);
  const uname = str(sender[1]) || '某位观众';
  const medal = Array.isArray(info[3]) ? (info[3] as unknown[]) : [];
  const userLevel = Array.isArray(info[4]) ? (info[4] as unknown[]) : [];
  const rich = obj(Array.isArray(info[0]) ? (info[0] as unknown[])[15] : undefined);
  const richUser = obj(rich.user);
  const richBase = obj(richUser.base);
  const guardLevel = num(info[7]);
  const badge = guardLevel > 0 ? '·舰长' : '';
  return {
    kind: 'event',
    type: 'bilibili.danmaku',
    trigger: 'debounce',
    text: `[弹幕|${uname}${badge}] ${text}`,
    senderKey: senderKeyOf(uid),
    meta: {
      uid,
      uname,
      guardLevel,
      isAdmin: bool(sender[2]),
      vip: bool(sender[3]),
      svip: bool(sender[4]),
      rank: num(sender[5]),
      nameColor: str(sender[7]),
      userLevel: num(userLevel[0]),
      avatarUrl: imageUrl(richBase.face),
      medal: medal.length
        ? {
            level: num(medal[0]),
            name: str(medal[1]),
            anchorName: str(medal[2]),
            roomId: num(medal[3]),
            color: num(medal[4]),
          }
        : null,
      body: text,
    },
    coalesce: { kind: 'danmaku', key: text, body: text },
  };
}

function guardToast(fields: {
  uid: number;
  uname: string;
  role: string;
  guardLevel: number;
  renew: boolean;
  face: unknown;
}): LiveEvent {
  const { uid, uname, role, guardLevel, renew } = fields;
  const roleText = role || '大航海';
  return {
    kind: 'event',
    type: 'bilibili.guard-renew',
    trigger: 'debounce',
    text: renew ? `[续费|${uname}] 续费了 ${roleText}` : `[上舰|${uname}] 上了 ${roleText}`,
    senderKey: senderKeyOf(uid),
    meta: {
      uid,
      uname,
      ...(role ? { role } : {}),
      ...(guardLevel > 0 ? { guardLevel } : {}),
      ...(renew ? { renew: true } : {}),
      avatarUrl: imageUrl(fields.face),
    },
  };
}

function interactAction(msgType: number): LiveInteract['action'] {
  if (msgType === 2 || msgType === 4 || msgType === 5) return 'follow';
  if (msgType === 3) return 'share';
  return 'enter';
}

function interactWho(cmd: string, data: Record<string, unknown>): Omit<LiveInteract, 'kind'> | null {
  if (cmd === 'INTERACT_WORD_V2') {
    const pb = pbFromBase64(data.pb);
    if (!pb) return null;
    const uid = pbInt(pb, 1) ?? 0;
    const uname = pbText(pb, 2).trim();
    if (uid <= 0 || !uname) return null;
    const base = pbSub(pbSub(pb, 22), 2);
    return {
      action: interactAction(pbInt(pb, 5) ?? 1),
      uid,
      uname,
      face: imageUrl(pbText(base, 2)),
      medalLevel: 0,
    };
  }
  const uid = num(data.uid);
  const uname = str(data.uname).trim();
  if (uid <= 0 || !uname) return null;
  const medal = obj(data.fans_medal);
  // 别的房间的牌子不算:只认挂在本房间(anchor_roomid 与本帧 roomid 一致)的牌子
  const ownRoom = num(medal.anchor_roomid) > 0 && num(medal.anchor_roomid) === num(data.roomid);
  return {
    action: interactAction(num(data.msg_type)),
    uid,
    uname,
    face: imageUrl(data.face ?? obj(obj(data.uinfo).base).face),
    medalLevel: ownRoom ? num(medal.medal_level) : 0,
  };
}

function senderKeyOf(uid: number): string | undefined {
  return uid > 0 ? String(uid) : undefined;
}

/** 付费事件的 uid 在不同 cmd 版本中所处层级不同。 */
function audienceUid(data: Record<string, unknown>): number {
  const values = [
    num(data.uid),
    num(obj(data.user_info).uid),
    num(obj(data.sender_uinfo).uid),
  ];
  return values.find((value) => value > 0) ?? 0;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bool(v: unknown): boolean {
  return v === true || v === 1;
}

function imageUrl(v: unknown): string {
  const raw = str(v);
  if (raw.startsWith('//')) return `https:${raw}`;
  return /^https?:\/\//i.test(raw) ? raw : '';
}

function unitCoinKey(totalCoin: number, count: number): string {
  let a = Math.abs(Math.round(totalCoin));
  let b = Math.abs(Math.round(count));
  const numerator = Math.round(totalCoin);
  const denominator = Math.round(count);
  while (b !== 0) [a, b] = [b, a % b];
  const divisor = a || 1;
  return `${numerator / divisor}/${denominator / divisor}`;
}

function trim(yuan: number): string {
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}
