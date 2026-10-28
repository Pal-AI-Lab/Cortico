import { describe, expect, it } from 'vitest';
import { normalize } from '../../../src/worlds/bilibili/normalize.ts';

const OPTS = { giftFlushYuan: 1 };

/** 实测抓到的弹幕形状(裁到用得上的位置) */
function danmakuMsg(opts: { uid: number; uname: string; text: string; guard?: number }): Record<string, unknown> {
  const info: unknown[] = [];
  info[0] = [0, 1, 25, 16777215, Date.now()];
  (info[0] as unknown[])[15] = { user: { base: { face: '//i.example/avatar.jpg' } } };
  info[1] = opts.text;
  info[2] = [opts.uid, opts.uname, 0, 0, 0, 10000, 1, ''];
  info[3] = [20, 'yyqwq', '主播名', 123456];
  info[4] = [36];
  info[7] = opts.guard ?? 0;
  info[9] = { ts: 1786841602 };
  return { cmd: 'DANMU_MSG:4:0:2:2:2:0', info };
}

describe('归一化', () => {
  it('弹幕:debounce,uid 当身份键,舰长标出来', () => {
    const got = normalize(danmakuMsg({ uid: 10277445, uname: 'Ruiaks', text: '难绷', guard: 3 }), OPTS);
    expect(got).toMatchObject({
      kind: 'event',
      type: 'bilibili.danmaku',
      trigger: 'debounce',
      text: '[弹幕|Ruiaks·舰长] 难绷',
      senderKey: '10277445',
      coalesce: { kind: 'danmaku', key: '难绷', body: '难绷' },
      meta: {
        uid: 10277445,
        uname: 'Ruiaks',
        guardLevel: 3,
        isAdmin: false,
        vip: false,
        svip: false,
        rank: 10000,
        userLevel: 36,
        avatarUrl: 'https://i.example/avatar.jpg',
        medal: { level: 20, name: 'yyqwq', anchorName: '主播名', roomId: 123456 },
      },
    });
  });

  it('服务端脱敏(uid=0)时不给身份键——打码昵称会碰撞,不能当稳定键', () => {
    const got = normalize(danmakuMsg({ uid: 0, uname: '老***', text: '草' }), OPTS);
    expect(got).toMatchObject({ type: 'bilibili.danmaku', text: '[弹幕|老***] 草' });
    expect((got as { senderKey?: string }).senderKey).toBeUndefined();
  });

  it('空弹幕不成事件', () => {
    expect(normalize(danmakuMsg({ uid: 1, uname: 'a', text: '   ' }), OPTS)).toBeNull();
  });

  it('礼物:达到门槛插队,低于门槛走常规合批', () => {
    const gift = (coin: number): Record<string, unknown> => ({
      cmd: 'SEND_GIFT',
      data: { uname: '阿明', giftName: '小花花', num: 2, coin_type: 'gold', total_coin: coin, uid: 42 },
    });
    expect(normalize(gift(2000), OPTS)).toMatchObject({
      trigger: 'flush',
      text: '[礼物 ¥2|阿明] 小花花×2',
      senderKey: '42',
    });
    expect(normalize(gift(500), OPTS)).toMatchObject({ trigger: 'debounce', text: '[礼物 ¥0.50|阿明] 小花花×2' });
    expect(normalize(gift(500), OPTS)).toMatchObject({
      coalesce: { kind: 'gift', key: JSON.stringify(['小花花', '250/1']), gift: '小花花', num: 2, yuan: 0.5 },
    });
  });

  it('V2 礼物兼容仅在 sender_uinfo 提供的身份', () => {
    expect(normalize({
      cmd: 'SEND_GIFT_V2',
      data: {
        giftName: '小花花',
        num: 2,
        coin_type: 'gold',
        total_coin: 2000,
        sender_uinfo: {
          uid: 43,
          base: { name: '阿乙', face: '//i.example/gift-avatar.jpg' },
        },
      },
    }, OPTS)).toMatchObject({
      type: 'bilibili.gift',
      senderKey: '43',
      text: '[礼物 ¥2|阿乙] 小花花×2',
      meta: {
        uid: 43,
        uname: '阿乙',
        avatarUrl: 'https://i.example/gift-avatar.jpg',
      },
    });
  });

  it('免费礼物只进聚合计数', () => {
    expect(
      normalize({ cmd: 'SEND_GIFT', data: { uname: 'a', giftName: '小心心', num: 3, coin_type: 'silver' } }, OPTS),
    ).toEqual({ kind: 'count', field: 'freeGift', by: 3 });
  });

  it('醒目留言与上舰都插队', () => {
    expect(
      normalize(
        { cmd: 'SUPER_CHAT_MESSAGE', data: { price: 30, message: '点首歌', user_info: { uname: '阿明', uid: 7 } } },
        OPTS,
      ),
    ).toMatchObject({ type: 'bilibili.superchat', trigger: 'flush', text: '[醒目留言 ¥30|阿明] 点首歌', senderKey: '7' });
    expect(
      normalize({ cmd: 'GUARD_BUY', data: { username: '阿明', gift_name: '舰长', num: 1, guard_level: 3, uid: 7 } }, OPTS),
    ).toMatchObject({ type: 'bilibili.guard', trigger: 'flush', text: '[上舰|阿明] 开通了 舰长×1' });
  });

  it('上舰读 data.price 入账,金额进正文与 meta', () => {
    const got = normalize({
      cmd: 'GUARD_BUY',
      data: { username: '阿明', gift_name: '舰长', num: 1, guard_level: 3, uid: 7, price: 138000 },
    }, OPTS);
    expect(got).toMatchObject({
      type: 'bilibili.guard',
      text: '[上舰 ¥138|阿明] 开通了 舰长×1',
      meta: { yuan: 138, guardLevel: 3 },
    });
  });

  it('上舰金额换算越界时宁缺毋假:不填 yuan,只 warn 带原始 price', () => {
    const warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const got = normalize({
      cmd: 'GUARD_BUY',
      data: { username: '阿明', gift_name: '舰长', num: 1, uid: 7, price: 138_000_000 },
    }, { ...OPTS, warn: (message, data) => warns.push({ message, data }) });
    expect(got).toMatchObject({ type: 'bilibili.guard', text: '[上舰|阿明] 开通了 舰长×1' });
    expect((got as { meta?: Record<string, unknown> }).meta).not.toHaveProperty('yuan');
    expect((got as { meta?: Record<string, unknown> }).meta).not.toHaveProperty('guardLevel');
    expect(warns).toEqual([expect.objectContaining({ data: expect.objectContaining({ price: 138_000_000 }) })]);
  });

  it('TOAST V1:帧里明说续费才写续费,字段读得到就全进 meta', () => {
    expect(normalize({
      cmd: 'USER_TOAST_MSG',
      data: { uid: 7, username: '阿明', role_name: '舰长', guard_level: 3, toast_msg: '阿明 自动续费了舰长' },
    }, OPTS)).toMatchObject({
      type: 'bilibili.guard-renew',
      trigger: 'debounce',
      text: '[续费|阿明] 续费了 舰长',
      meta: { uid: 7, role: '舰长', guardLevel: 3, renew: true },
    });
  });

  it('TOAST 判不了续费就中性措辞,不断言续费', () => {
    expect(normalize({
      cmd: 'USER_TOAST_MSG',
      data: { uid: 7, username: '阿明', role_name: '舰长', guard_level: 3 },
    }, OPTS)).toMatchObject({ text: '[上舰|阿明] 上了 舰长' });
  });

  it('TOAST V2 字段读不出就省略,不拿兜底值伪装真值', () => {
    const got = normalize({
      cmd: 'USER_TOAST_MSG_V2',
      data: { sender_uinfo: { uid: 18, base: { name: '阿乙' } } },
    }, OPTS);
    expect(got).toMatchObject({ type: 'bilibili.guard-renew', text: '[上舰|阿乙] 上了 大航海' });
    const meta = (got as { meta: Record<string, unknown> }).meta;
    expect(meta).not.toHaveProperty('role');
    expect(meta).not.toHaveProperty('guardLevel');
    expect(meta).not.toHaveProperty('renew');
  });

  it('TOAST V2 的角色与档位只在 guard_info 里', () => {
    expect(normalize({
      cmd: 'USER_TOAST_MSG_V2',
      data: {
        sender_uinfo: { uid: 18, base: { name: '阿乙' } },
        guard_info: { guard_level: 3, role_name: '舰长' },
      },
    }, OPTS)).toMatchObject({ text: '[上舰|阿乙] 上了 舰长', meta: { guardLevel: 3, role: '舰长' } });
  });

  it('付费事件兼容 uid 在顶层或 sender_uinfo 的实测形状', () => {
    expect(normalize({
      cmd: 'SUPER_CHAT_MESSAGE',
      data: { uid: 17, price: 30, message: '点首歌', user_info: { uname: '阿明' } },
    }, OPTS)).toMatchObject({ senderKey: '17', meta: { uid: 17 } });
    expect(normalize({
      cmd: 'USER_TOAST_MSG_V2',
      data: { sender_uinfo: { uid: 18, base: { name: '阿乙' } } },
    }, OPTS)).toMatchObject({ senderKey: '18', meta: { uid: 18 } });
  });

  it('舰长进场剥掉 copy_writing 的标记', () => {
    expect(
      normalize({ cmd: 'ENTRY_EFFECT', data: { copy_writing: '欢迎舰长 <%阿明%> 进入直播间', uid: 7 } }, OPTS),
    ).toMatchObject({ type: 'bilibili.enter-guard', trigger: 'debounce', text: '[进场] 欢迎舰长 阿明 进入直播间' });
  });

  it('平台执法插队,但只成事件——收不收嘴是她自己的事', () => {
    expect(normalize({ cmd: 'CUT_OFF', msg: '因违规被切断' }, OPTS)).toMatchObject({
      type: 'bilibili.warning',
      trigger: 'flush',
      text: '[直播被切断] 因违规被切断',
    });
  });

  it('INTERACT_WORD_V2 解出 uid、名字、动作和头像', () => {
    const vint = (n: number): number[] => { const out: number[] = []; let v = n; while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; } out.push(v); return out; };
    const str = (field: number, s: string): number[] => { const b = [...Buffer.from(s, 'utf8')]; return [...vint((field << 3) | 2), ...vint(b.length), ...b]; };
    const int = (field: number, n: number): number[] => [...vint(field << 3), ...vint(n)];
    const msg = (field: number, inner: number[]): number[] => [...vint((field << 3) | 2), ...vint(inner.length), ...inner];
    const pb = (type: number) => Buffer.from([
      ...int(1, 123456), ...str(2, '路过的工友'), ...int(5, type), ...int(7, 1790000000),
      ...msg(22, msg(2, str(2, '//i0.hdslb.com/face.jpg'))),
    ]).toString('base64');
    expect(normalize({ cmd: 'INTERACT_WORD_V2', data: { pb: pb(1) } }, OPTS)).toEqual({
      kind: 'interact', action: 'enter', uid: 123456, uname: '路过的工友',
      face: 'https://i0.hdslb.com/face.jpg', medalLevel: 0,
    });
    expect(normalize({ cmd: 'INTERACT_WORD_V2', data: { pb: pb(2) } }, OPTS)).toMatchObject({ action: 'follow' });
    expect(normalize({ cmd: 'INTERACT_WORD_V2', data: { pb: pb(3) } }, OPTS)).toMatchObject({ action: 'share' });
    // 坏帧退回人流计数,不丢这一次进场
    expect(normalize({ cmd: 'INTERACT_WORD_V2', data: { pb: '!!!' } }, OPTS)).toEqual({ kind: 'count', field: 'enter', by: 1 });
  });

  it('INTERACT_WORD(V1)只认本房间的粉丝牌', () => {
    const base = { uid: 9, uname: '阿九', msg_type: 1, roomid: 24292304 };
    expect(normalize({ cmd: 'INTERACT_WORD', data: { ...base, fans_medal: { anchor_roomid: 24292304, medal_level: 12 } } }, OPTS))
      .toMatchObject({ kind: 'interact', action: 'enter', uid: 9, medalLevel: 12 });
    expect(normalize({ cmd: 'INTERACT_WORD', data: { ...base, fans_medal: { anchor_roomid: 1, medal_level: 20 } } }, OPTS))
      .toMatchObject({ medalLevel: 0 });
  });

  it('人流类只给计数与读数', () => {
    expect(normalize({ cmd: 'INTERACT_WORD_V2', data: {} }, OPTS)).toEqual({ kind: 'count', field: 'enter', by: 1 });
    expect(normalize({ cmd: 'LIKE_INFO_V3_CLICK', data: {} }, OPTS)).toEqual({ kind: 'count', field: 'like', by: 1 });
    expect(normalize({ cmd: 'WATCHED_CHANGE', data: { num: 288429 } }, OPTS)).toEqual({
      kind: 'gauge',
      field: 'watched',
      value: 288429,
    });
    expect(normalize({ cmd: 'ONLINE_RANK_COUNT', data: { count: 12 } }, OPTS)).toEqual({
      kind: 'gauge',
      field: 'online',
      value: 12,
    });
  });

  it('运营挂件与她自己的语音转写不推;没见过的 cmd 也不推', () => {
    for (const cmd of ['NOTICE_MSG', 'UNIVERSAL_ASR_TEXT', 'WIDGET_BANNER', 'SOME_NEW_CMD_2030']) {
      expect(normalize({ cmd, data: {} }, OPTS), cmd).toBeNull();
    }
  });

  // 开播与下播事件陈述平台侧状态及其后果，只报告事实。
  it('开播/下播指令:flush 成事件,措辞陈述平台状态与后果', () => {
    expect(normalize({ cmd: 'LIVE' }, OPTS)).toMatchObject({
      kind: 'event',
      type: 'bilibili.room',
      trigger: 'flush',
      text: expect.stringContaining('平台已推送开播指令'),
    });
    const preparing = normalize({ cmd: 'PREPARING' }, OPTS);
    expect(preparing).toMatchObject({
      kind: 'event',
      type: 'bilibili.room',
      trigger: 'flush',
    });
    const text = (preparing as { text: string }).text;
    expect(text).toContain('平台已推送下播指令');
    expect(text).toContain('看不到直播画面');
    // 反向证据要提前说破:留场弹幕不代表还在播
    expect(text).toContain('不代表直播还在');
    expect(text).not.toMatch(/收尾|告别|停止|快去/);
  });
});
