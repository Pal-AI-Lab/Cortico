/**
 * 失败原因转述服务器断开理由的原文:登录阶段是 JSON 文本,1.20.3 起进入世界后是 NBT 组件;
 * 类别只从翻译键或原版英文措辞认。
 */
import { describe, expect, it } from 'vitest';
import { errorFailure, kickFailure, kickReasonText } from '../../../src/worlds/minecraft/link.ts';

describe('断开理由的原文', () => {
  it('登录阶段的 JSON 翻译键带参数照原样转出', () => {
    const raw = JSON.stringify({ translate: 'multiplayer.disconnect.outdated_client', with: ['1.21.1'] });
    expect(kickReasonText(raw).text).toBe('multiplayer.disconnect.outdated_client(1.21.1)');
    expect(kickFailure(raw)).toBe('被服务器断开(版本):multiplayer.disconnect.outdated_client(1.21.1)');
  });

  it('进入世界后的 NBT 组件取出文字,按原版措辞认出白名单', () => {
    const raw = {
      type: 'compound',
      value: { text: { type: 'string', value: 'You are not white-listed on this server!' } },
    };
    expect(kickFailure(raw)).toBe('被服务器断开(白名单):You are not white-listed on this server!');
  });

  it('插件自定义的理由认不出类别时只给原文', () => {
    const raw = JSON.stringify({ text: '', extra: [{ text: '服务器维护中' }, { text: ',请稍后' }] });
    expect(kickFailure(raw)).toBe('被服务器断开:服务器维护中,请稍后');
  });

  it('正版验证拒绝离线账号归为认证', () => {
    expect(kickFailure(JSON.stringify({ translate: 'multiplayer.disconnect.unverified_username' })))
      .toBe('被服务器断开(认证):multiplayer.disconnect.unverified_username');
  });
});

describe('连接错误', () => {
  it('网络错误码归为网络,原文保留地址', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 203.0.113.5:25570'), { code: 'ECONNREFUSED' });
    expect(errorFailure(err, 'socketClosed')).toBe('网络:connect ECONNREFUSED 203.0.113.5:25570');
  });

  it('没有错误时报连接关闭的理由', () => {
    expect(errorFailure(null, 'socketClosed')).toBe('连接关闭:socketClosed');
  });
});
