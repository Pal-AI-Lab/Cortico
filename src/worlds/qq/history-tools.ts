import type {
  EventEnvelope,
  EventGrepQuery,
  EventRangeQuery,
  EventStoreReader,
  WorldHost,
  ToolDef,
} from '../../core/types.ts';
import { renderEventLines } from '../../core/util.ts';
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
}

const NOT_STARTED = '[tool failed] QQ module not started';
const TARGET_FORMAT = '"group:<id>" or "private:<id>"';

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
      .range({
        ...query,
        fromTs: query.fromTs !== undefined && query.fromTs > ts ? query.fromTs : ts,
        toTs: query.toTs !== undefined && query.toTs < ts ? query.toTs : ts,
      })
      .find((event) => String(event.meta?.message_id ?? '') === mid && inConversation(event));
  } else if (typeof args.around_time === 'string' && args.around_time) {
    const at = args.around_time;
    center = store
      .range({ ...query, fromTs: query.fromTs !== undefined && query.fromTs > at ? query.fromTs : at })
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

      const hasAround =
        (args.around !== undefined && args.around !== null && String(args.around) !== '') ||
        (typeof args.around_time === 'string' && args.around_time !== '');
      const query: EventRangeQuery = { source: deps.source, origin: 'external' };
      if (typeof args.from_time === 'string') query.fromTs = args.from_time;
      if (typeof args.to_time === 'string') query.toTs = args.to_time;
      if (typeof args.sender === 'string') query.senderKey = args.sender;
      const events = hasAround
        ? readAround(host.store, query, args, conversation, deps.messageTs)
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
      if (typeof args.from_time === 'string') query.fromTs = args.from_time;
      if (typeof args.to_time === 'string') query.toTs = args.to_time;

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
