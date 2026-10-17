/**
 * 穿末地出口门后服务端发 win_game:值 1 播字幕,玩家已看过字幕时发 0。原版客户端两种都回
 * client_command PERFORM_RESPAWN,服务端收到才把人送回主世界;没收到就一直当她在出口门里。
 * 上游 mineflayer 只回值 1。
 *
 * 监听在 game.js 的 `inject` 里,只能改包:src/worlds/minecraft/dependency-patches.ts。
 */
import '../../../src/worlds/minecraft/dependency-patches.ts';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const mfRequire = createRequire(require_.resolve('mineflayer'));

/** 服务端与执行器都钉在这一版 */
const MC_VERSION = '1.20.6';

const registry = mfRequire('minecraft-data')(MC_VERSION) as { supportFeature(name: string): boolean };
const injectGame = mfRequire('./lib/plugins/game.js') as (bot: unknown, options: unknown) => void;

function ackAfter(gameMode: number): unknown[] {
  const written: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    registerChannel: () => {},
    write: (name: string, params: unknown) => { if (name === 'client_command') written.push(params); },
  });
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    registry,
    supportFeature: (name: string) => registry.supportFeature(name),
  });
  injectGame(bot, {});
  client.emit('game_state_change', { reason: 4, gameMode });
  return written;
}

describe('win_game 回执', () => {
  it('看过字幕后的值 0 也回 PERFORM_RESPAWN', () => {
    expect(ackAfter(0)).toEqual([{ actionId: 0 }]);
  });

  it('首次通关的值 1 照旧回', () => {
    expect(ackAfter(1)).toEqual([{ actionId: 0 }]);
  });
});
