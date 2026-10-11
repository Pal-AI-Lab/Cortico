import type { Language } from '../../core/language.ts';
import type { ConfigGroup } from '../../core/types.ts';
import { cloneOverlayConfig } from './overlay/model.ts';
import { text } from './strings.ts';

export const BILIBILI_DEFAULTS = {
  // enabled 由Persona的装配层显式开启。
  enabled: false,
  /** 直播间号;短号与真实房间号都行,World 自己换算 */
  roomId: 0,
  /** 登录 cookie 的 SESSDATA;空值使用匿名接入。 */
  sessdata: '',
  /** 礼物使用 flush 投递的金额门槛,单位元。 */
  giftFlushYuan: 1,
  /** 相同弹幕与常规礼物进入总线前的固定归并窗 */
  coalesceWindowMs: 300,
  /** 固定窗内累计到此数量时立即冲刷 */
  coalesceMaxItems: 64,
  /** 高能榜拥挤代理的开启/退出水位 */
  audienceOnlineRankOn: 200,
  audienceOnlineRankOff: 170,
  /** 人数持续不高于退出线达到此时长后解除拥挤态,单位秒。 */
  audienceReleaseHoldSec: 120,
  /** 人数信号新鲜度与已拥挤时的最长陈旧保持 */
  audienceSignalFreshSec: 90,
  audienceActiveStaleHoldSec: 300,
  audienceEventLineBudget: 114,
  audienceEventTokenBudget: 1061,
  /** 重要观众常规互动占总批预算的上限比例,同时受剩余额度限制。 */
  audienceImportantShare: 0.5,
  overlay: cloneOverlayConfig(),
};

export function bilibiliConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:bilibili',
    owner: 'world:bilibili',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.bilibili.roomId': {
          type: 'integer',
          title: t.roomIdTitle,
          minimum: 0,
          maximum: 4294967295,
          'x-hot': false,
          description: t.roomIdDescription,
        },
        'worlds.bilibili.sessdata': {
          type: 'string',
          title: t.sessdataTitle,
          'x-hot': false,
          description: t.sessdataDescription,
        },
        'worlds.bilibili.giftFlushYuan': {
          type: 'number',
          title: t.giftFlushTitle,
          minimum: 0,
          maximum: 1000,
          'x-suffix': t.suffixYuan,
          'x-hot': true,
          description: t.giftFlushDescription,
        },
        'worlds.bilibili.coalesceWindowMs': {
          type: 'integer',
          title: t.coalesceWindowTitle,
          minimum: 0,
          maximum: 2000,
          multipleOf: 50,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
          description: t.coalesceWindowDescription,
        },
        'worlds.bilibili.coalesceMaxItems': {
          type: 'integer',
          title: t.coalesceMaxTitle,
          minimum: 1,
          maximum: 1000,
          'x-suffix': t.suffixItems,
          'x-hot': true,
          description: t.coalesceMaxDescription,
        },
        'worlds.bilibili.audienceOnlineRankOn': {
          type: 'integer',
          title: t.rankOnTitle,
          minimum: 1,
          maximum: 100000,
          'x-suffix': t.suffixPeople,
          'x-hot': true,
          description: t.rankOnDescription,
        },
        'worlds.bilibili.audienceOnlineRankOff': {
          type: 'integer',
          title: t.rankOffTitle,
          minimum: 0,
          maximum: 100000,
          'x-suffix': t.suffixPeople,
          'x-hot': true,
          description: t.rankOffDescription,
        },
        'worlds.bilibili.audienceReleaseHoldSec': {
          type: 'integer',
          title: t.releaseHoldTitle,
          minimum: 1,
          maximum: 1800,
          'x-suffix': 's',
          'x-hot': true,
          description: t.releaseHoldDescription,
        },
        'worlds.bilibili.audienceSignalFreshSec': {
          type: 'integer',
          title: t.signalFreshTitle,
          minimum: 1,
          maximum: 3600,
          'x-suffix': 's',
          'x-hot': true,
          description: t.signalFreshDescription,
        },
        'worlds.bilibili.audienceActiveStaleHoldSec': {
          type: 'integer',
          title: t.staleHoldTitle,
          minimum: 1,
          maximum: 3600,
          'x-suffix': 's',
          'x-hot': true,
          description: t.staleHoldDescription,
        },
        'worlds.bilibili.audienceEventLineBudget': {
          type: 'integer',
          title: t.lineBudgetTitle,
          minimum: 1,
          maximum: 5000,
          'x-suffix': t.suffixLinesPerBatch,
          'x-hot': true,
          description: t.lineBudgetDescription,
        },
        'worlds.bilibili.audienceEventTokenBudget': {
          type: 'integer',
          title: t.tokenBudgetTitle,
          minimum: 1,
          maximum: 100000,
          'x-suffix': t.suffixTokensPerBatch,
          'x-hot': true,
          description: t.tokenBudgetDescription,
        },
        'worlds.bilibili.audienceImportantShare': {
          type: 'number',
          title: t.importantShareTitle,
          minimum: 0.01,
          maximum: 1,
          'x-scale': 100,
          'x-suffix': '%',
          'x-hot': true,
          description: t.importantShareDescription,
        },
        'worlds.bilibili.overlay.enabled': {
          type: 'boolean',
          title: t.overlayEnabledTitle,
          'x-hot': false,
          description: t.overlayEnabledDescription,
        },
        'worlds.bilibili.overlay.port': {
          type: 'integer',
          title: t.overlayPortTitle,
          minimum: 0,
          maximum: 65535,
          'x-hot': false,
          description: t.overlayPortDescription,
        },
        'worlds.bilibili.overlay.agentNoticeMaxChars': {
          type: 'integer',
          title: t.noticeMaxTitle,
          minimum: 1,
          maximum: 5000,
          'x-suffix': t.suffixChars,
          'x-hot': true,
          description: t.noticeMaxDescription,
        },
      },
    },
  };
}

/** config.json 的 `worlds.bilibili` 节。 */
export type BilibiliConfigSection = typeof BILIBILI_DEFAULTS;
