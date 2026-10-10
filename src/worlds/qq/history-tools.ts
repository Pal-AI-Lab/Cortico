import type {
  EventEnvelope,
  EventGrepQuery,
  EventRangeQuery,
  EventStoreReader,
  WorldHost,
  ToolDef,
} from '../../core/types.ts';
import { nowIso, parseTimeIn, renderEventLines } from '../../core/util.ts';
import {
  eventInConversation,
  parseConversationAddress,
  type Conv,
} from './conversation.ts';

interface HistoryToolDeps {
  source: string;
  host: () => WorldHost | undefined;
  /** 首条带这个平台 message_id 的事件的 ts;没记录过时为 undefined。 */
  messageTs: (messageId: string) => string | undefined;
  /** 不带偏移的时间参数按这个时区的墙钟读 */
  timezone: string;
}

const NOT_STARTED = '[tool failed] QQ module not started';
const TARGET_FORMAT = '"group:<id>" or "private:<id>"';

/** 时间参数换成带偏移的 ISO 时刻;没给时为 undefined。 */
function timeArg(raw: unknown, name: string, timezone: string): string | { error: string } | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const ms = parseTimeIn(timezone, raw);
  return Number.isNaN(ms) ? { error: `${name} "${raw}" is not an ISO 8601 time` } : nowIso(timezone, new Date(ms));
}

/** from_time / to_time 写进 query;参数读不出时返回错误文本。 */
function applyTimeRange(
  query: EventRangeQuery | EventGrepQuery,
  args: Record<string, unknown>,
  timezone: string,
): string | null {
  for (const [name, key] of [['from_time', 'fromTs'], ['to_time', 'toTs']] as const) {
    const time = timeArg(args[name], name, timezone);
    if (typeof time === 'object') return time.error;
    if (time !== undefined) query[key] = time;
  }
  return null;
}

const laterOf = (a: string | undefined, b: string): string => (a !== undefined && Date.parse(a) > Date.parse(b) ? a : b);
const earlierOf = (a: string | undefined, b: string): string => (a !== undefined && Date.parse(a) < Date.parse(b) ? a : b);

function parseConversationFilter(raw: unknown): Conv | { error: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const conversation = parseConversationAddress(raw);
  return conversation ?? {
    error: `"${raw.trim()}" is not a valid conversation; use ${TARGET_FORMAT} (numeric QQ group/user id, not a name)`,
  };
}

/**
 * query 范围内最后 limit 条事件,按游标升序;给了会话就只算该会话的。
 * 事件库不按会话过滤,所以从最新往前每次读 limit 条,凑够或读到头为止。
 */
export function readLatest(
  store: EventStoreReader,
  query: EventRangeQuery,
  conversation: Conv | null,
  limit: number,
): EventEnvelope[] {
  if (!conversation) return store.range({ ...query, limit });
  const picked: EventEnvelope[] = [];
  let toCursor = query.toCursor ?? store.latestCursor();
  while (picked.length < limit) {
    const page = store.range({ ...query, toCursor, limit });
    for (let i = page.length - 1; i >= 0 && picked.length < limit; i--) {
      if (eventInConversation(page[i], conversation)) picked.push(page[i]);
    }
    if (page.length < limit) break;
    toCursor = page[0].cursor - 1;
  }
  return picked.reverse();
}

/**
 * 邻域读取的两个入口:
 *  - around      = 平台 message_id(消息行首的 `#<id>`),中心是首条带这个号的事件
 *  - around_time = ISO 时间,取该时刻之后的第一条为中心(没有号可用时的入口)
 * 两者都不涉及 core 事件游标——游标是存储位置,不进 agent 的词表。
 */
function readAround(
  store: EventStoreReader,
  query: EventRangeQuery,
  args: Record<string, unknown>,
  aroundTime: string | undefined,
  conversation: Conv | null,
  messageTs: HistoryToolDeps['messageTs'],
): EventEnvelope[] {
  const inConversation = (event: EventEnvelope): boolean =>
    !conversation || eventInConversation(event, conversation);
  let center: EventEnvelope | undefined;
  if (args.around !== undefined && args.around !== null && String(args.around) !== '') {
    const mid = String(args.around).trim().replace(/^#/, '');
    const ts = messageTs(mid);
    if (ts === undefined) return [];
    center = store
      .range({ ...query, fromTs: laterOf(query.fromTs, ts), toTs: earlierOf(query.toTs, ts) })
      .find((event) => String(event.meta?.message_id ?? '') === mid && inConversation(event));
  } else if (aroundTime !== undefined) {
    center = store
      .range({ ...query, fromTs: laterOf(query.fromTs, aroundTime) })
      .find(inConversation);
    // 给的时刻晚于全部记录时,以最后一条为中心
    center ??= readLatest(store, query, conversation, 1)[0];
  }
  if (!center) return [];
  const before = args.before !== undefined ? Math.max(0, Number(args.before)) : 20;
  const after = args.after !== undefined ? Math.max(0, Number(args.after)) : 20;
  return [
    ...readLatest(store, { ...query, toCursor: center.cursor - 1 }, conversation, before),
    center,
    ...store.range({ ...query, fromCursor: center.cursor + 1 }).filter(inConversation).slice(0, after),
  ];
}

function createReadHistoryTool(deps: HistoryToolDeps): ToolDef {
  return {
    name: 'qq_read_history',
    description:
      'Read QQ history: the neighborhood of one message (around / around_time), or a time range. Optional conversation and sender filters.',
    tags: ['read'],
    parameters: {
      type: 'object',
      properties: {
        around: {
          type: 'string',
          description: 'A QQ message id — the `#<id>` at the start of a message line. Reads the messages around it.',
        },
        around_time: {
          type: 'string',
          description: 'ISO 8601 time: reads around the first message at or after it. Use when you have no message id.',
        },
        before: { type: 'number', description: 'With around/around_time: how many earlier messages (default 20).' },
        after: { type: 'number', description: 'With around/around_time: how many later messages (default 20).' },
        from_time: { type: 'string', description: 'Start time, ISO 8601.' },
        to_time: { type: 'string', description: 'End time, ISO 8601.' },
        sender: { type: 'string', description: 'Filter by QQ number.' },
        conversation: {
          type: 'string',
          description: `Filter by conversation: ${TARGET_FORMAT} (numeric QQ group/user id, not a name).`,
        },
        limit: { type: 'number', description: 'Max results, default 50.' },
      },
      required: [],
    },
    handler: async (args) => {
      const host = deps.host();
      if (!host) return NOT_STARTED;
      const filter = parseConversationFilter(args.conversation);
      if (filter && 'error' in filter) return `[bad input] ${filter.error}`;
      const conversation = filter || null;
      const limit = args.limit !== undefined ? Number(args.limit) : 50;

      const aroundTime = timeArg(args.around_time, 'around_time', deps.timezone);
      if (typeof aroundTime === 'object') return `[bad input] ${aroundTime.error}`;
      const hasAround =
        (args.around !== undefined && args.around !== null && String(args.around) !== '') ||
        aroundTime !== undefined;
      const query: EventRangeQuery = { source: deps.source, origin: 'external' };
      const rangeError = applyTimeRange(query, args, deps.timezone);
      if (rangeError) return `[bad input] ${rangeError}`;
      if (typeof args.sender === 'string') query.senderKey = args.sender;
      const events = hasAround
        ? readAround(host.store, query, args, aroundTime, conversation, deps.messageTs)
        : readLatest(host.store, query, conversation, limit);

      return events.length ? renderEventLines(events) : '(no matching messages)';
    },
  };
}

function createGrepHistoryTool(deps: HistoryToolDeps): ToolDef {
  return {
    name: 'qq_grep_history',
    description:
      'Keyword search over QQ history; each hit includes 3 messages of context on each side. Optional conversation and sender filters.',
    tags: ['read'],
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Keyword (plain substring match).' },
        sender: { type: 'string', description: 'Filter by QQ number.' },
        conversation: {
          type: 'string',
          description: `Filter by conversation: ${TARGET_FORMAT} (numeric QQ group/user id, not a name).`,
        },
        from_time: { type: 'string', description: 'Start time, ISO 8601.' },
        to_time: { type: 'string', description: 'End time, ISO 8601.' },
        limit: { type: 'number', description: 'Max hit groups, default 5.' },
      },
      required: ['keyword'],
    },
    handler: async (args) => {
      const host = deps.host();
      if (!host) return NOT_STARTED;
      const keyword = typeof args.keyword === 'string' ? args.keyword : '';
      if (!keyword) return '[bad input] keyword must not be empty';
      const filter = parseConversationFilter(args.conversation);
      if (filter && 'error' in filter) return `[bad input] ${filter.error}`;
      const conversation = filter || null;
      const limit = args.limit !== undefined ? Number(args.limit) : 5;

      const query: EventGrepQuery = {
        keyword,
        context: 3,
        source: deps.source,
        origin: 'external',
        limit: conversation ? undefined : limit,
      };
      if (typeof args.sender === 'string') query.senderKey = args.sender;
      const rangeError = applyTimeRange(query, args, deps.timezone);
      if (rangeError) return `[bad input] ${rangeError}`;

      let hits = host.store.grep(query);
      if (conversation) {
        hits = hits.filter((hit) => {
          const event = hit.events.find((item) => item.cursor === hit.hitCursor);
          return !!event && eventInConversation(event, conversation);
        });
        if (hits.length > limit) hits = hits.slice(0, limit);
      }
      hits = hits.map((hit) => ({
        ...hit,
        events: hit.events.filter(
          (event) =>
            event.source === deps.source &&
            event.origin === 'external' &&
            (!conversation || eventInConversation(event, conversation)),
        ),
      }));

      return hits.length
        ? hits.map((hit) => renderEventLines(hit.events)).join('\n---\n')
        : `(no messages containing "${keyword}")`;
    },
  };
}

export function createHistoryTools(deps: HistoryToolDeps): ToolDef[] {
  return [createReadHistoryTool(deps), createGrepHistoryTool(deps)];
}
