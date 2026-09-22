/** 本地 OneBot v11 WebSocket 测试服务。支持群聊、私聊与消息查询,未知动作返回 1404。 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Segment } from '../../src/worlds/qq/normalize.ts';

export interface MockOneBotOptions {
  /** 0=随机端口(start()后读port拿实际值) */
  port?: number;
  /** 默认群号(emit*不传group_id时用) */
  groupId?: number;
  /** bot账号 */
  selfId?: number;
  selfNickname?: string;
  /** bot在群里的群昵称 */
  selfCard?: string;
  groupName?: string;
  /** 非空=校验 Authorization: Bearer <token>,不匹配直接断开 */
  token?: string;
}

export interface OutboxEntry {
  action: string;
  params: Record<string, unknown>;
  /** send_group_msg分配的消息id */
  message_id?: number;
}

export class MockOneBot {
  readonly opts: Required<Omit<MockOneBotOptions, 'port' | 'token'>> & {
    token?: string;
  };
  /** start()之后是实际监听端口 */
  port = 0;

  /** send_group_msg调用记录(测试断言用) */
  readonly outbox: OutboxEntry[] = [];

  private server?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private requestedPort: number;
  private messageIdSeq = 1000;
  /** get_msg 测试桩:message_id(字符串键)→ 预置返回值,见setMockMsg */
  private msgById = new Map<string, unknown>();
  /** get_forward_msg 测试桩:资源id → 预置返回值。按 v11 标准只认参数 `id`。 */
  private forwardById = new Map<string, unknown>();

  constructor(options: MockOneBotOptions = {}) {
    this.requestedPort = options.port ?? 0;
    this.opts = {
      groupId: options.groupId ?? 10001,
      selfId: options.selfId ?? 5000,
      selfNickname: options.selfNickname ?? 'bot',
      selfCard: options.selfCard ?? 'bot',
      groupName: options.groupName ?? '测试群',
      token: options.token,
    };
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: this.requestedPort,
      });
      this.server = server;
      server.on('error', reject);
      server.on('listening', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(this.port);
      });
      server.on('connection', (ws, req) => {
        if (this.opts.token) {
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${this.opts.token}`) {
            ws.close(1008, 'auth failed');
            return;
          }
        }
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => {});
        ws.on('message', (raw) => this.handleApiCall(ws, String(raw)));
      });
    });
  }

  async close(): Promise<void> {
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** 当前有客户端连着 */
  get connected(): boolean {
    return this.clients.size > 0;
  }


  private handleApiCall(ws: WebSocket, raw: string): void {
    let msg: { action?: string; params?: Record<string, unknown>; echo?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { action, echo } = msg;
    const params = msg.params ?? {};

    const ok = (data: unknown) =>
      this.send(ws, { status: 'ok', retcode: 0, data, echo });
    const fail = (retcode: number, message: string) =>
      this.send(ws, { status: 'failed', retcode, data: null, message, echo });

    switch (action) {
      case 'get_login_info':
        ok({ user_id: this.opts.selfId, nickname: this.opts.selfNickname });
        return;
      case 'get_group_info':
        ok({
          group_id: this.opts.groupId,
          group_name: this.opts.groupName,
          member_count: 42,
        });
        return;
      case 'get_group_member_info':
        ok({
          group_id: this.opts.groupId,
          user_id: params.user_id,
          card: this.opts.selfCard,
          nickname: this.opts.selfNickname,
        });
        return;
      case 'send_group_msg':
      case 'send_private_msg': {
        const message_id = ++this.messageIdSeq;
        this.outbox.push({ action, params, message_id });
        ok({ message_id });
        return;
      }
      case 'get_msg': {
        const data = this.msgById.get(String(params.message_id));
        if (data === undefined) fail(1404, '消息不存在');
        else ok(data);
        return;
      }
      case 'get_forward_msg': {
        const response = this.forwardById.get(String(params.id));
        if (response === undefined) fail(1404, '转发消息不存在');
        else ok(Array.isArray(response) ? { messages: response } : response);
        return;
      }
      default:
        fail(1404, '不支持的api');
        return;
    }
  }

  private send(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /** 预置 get_msg(message_id) 的返回值(测试模拟"取回原文"用) */
  setMockMsg(messageId: string | number, data: unknown): void {
    this.msgById.set(String(messageId), data);
  }

  /** 预置 get_forward_msg(id) 的 messages 数组(测试模拟"展开转发"用) */
  setMockForward(resId: string, messages: unknown[]): void {
    this.forwardById.set(resId, messages);
  }

  /** 预置完整返回值,用于覆盖标准OneBot `{ message: node[] }` 等协议形状。 */
  setMockForwardResponse(resId: string, response: unknown): void {
    this.forwardById.set(resId, response);
  }

  /** 广播任意事件JSON(测试非常规事件形状用) */
  emitRaw(event: Record<string, unknown>): void {
    const raw = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }


  /**
   * 推一条群消息事件。segments与text二选一(text是纯文本快捷参数)。
   * 返回分配的message_id。
   */
  emitGroupMessage(args: {
    user_id: number;
    nickname?: string;
    card?: string;
    text?: string;
    segments?: Segment[];
    group_id?: number;
    time?: number;
    message_id?: number;
  }): number {
    const message_id = args.message_id ?? ++this.messageIdSeq;
    const segments: Segment[] =
      args.segments ?? [{ type: 'text', data: { text: args.text ?? '' } }];
    this.emitRaw({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      group_id: args.group_id ?? this.opts.groupId,
      user_id: args.user_id,
      message_id,
      time: args.time ?? Math.floor(Date.now() / 1000),
      sender: {
        user_id: args.user_id,
        nickname: args.nickname ?? String(args.user_id),
        card: args.card ?? '',
      },
      message: segments,
      raw_message: args.text ?? '',
    });
    return message_id;
  }

  /** 推送私聊消息。 */
  emitPrivateMessage(args: {
    user_id: number;
    text: string;
    nickname?: string;
  }): number {
    const message_id = ++this.messageIdSeq;
    this.emitRaw({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      user_id: args.user_id,
      message_id,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: args.user_id, nickname: args.nickname ?? '' },
      message: [{ type: 'text', data: { text: args.text } }],
      raw_message: args.text,
    });
    return message_id;
  }

  /** 推撤回通知 */
  emitRecall(
    message_id: number,
    args: { user_id: number; group_id?: number; operator_id?: number },
  ): void {
    this.emitRaw({
      post_type: 'notice',
      notice_type: 'group_recall',
      group_id: args.group_id ?? this.opts.groupId,
      user_id: args.user_id,
      operator_id: args.operator_id ?? args.user_id,
      message_id,
      time: Math.floor(Date.now() / 1000),
    });
  }

  /** 推入群通知 */
  emitMemberJoin(user_id: number, group_id?: number): void {
    this.emitRaw({
      post_type: 'notice',
      notice_type: 'group_increase',
      sub_type: 'approve',
      group_id: group_id ?? this.opts.groupId,
      user_id,
      operator_id: 0,
      time: Math.floor(Date.now() / 1000),
    });
  }

  /** 推退群通知 */
  emitMemberLeave(user_id: number, group_id?: number): void {
    this.emitRaw({
      post_type: 'notice',
      notice_type: 'group_decrease',
      sub_type: 'leave',
      group_id: group_id ?? this.opts.groupId,
      user_id,
      operator_id: 0,
      time: Math.floor(Date.now() / 1000),
    });
  }

  /** 推表情回应通知(OneBot 扩展通知 group_msg_emoji_like) */
  emitEmojiLike(args: {
    message_id: number;
    user_id: number;
    emoji_id: string;
    group_id?: number;
  }): void {
    this.emitRaw({
      post_type: 'notice',
      notice_type: 'group_msg_emoji_like',
      group_id: args.group_id ?? this.opts.groupId,
      user_id: args.user_id,
      message_id: args.message_id,
      likes: [{ emoji_id: args.emoji_id, count: 1 }],
      time: Math.floor(Date.now() / 1000),
    });
  }

  /** 推群戳一戳通知(notify/poke) */
  emitPoke(args: {
    user_id: number;
    target_id: number;
    group_id?: number;
    rawInfo?: Array<Record<string, unknown>>;
  }): void {
    this.emitRaw({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      group_id: args.group_id ?? this.opts.groupId,
      user_id: args.user_id,
      target_id: args.target_id,
      raw_info: args.rawInfo,
      time: Math.floor(Date.now() / 1000),
    });
  }
}
