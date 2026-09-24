import type { WorldDefinition } from '../../world.ts';
import { type QQConfigSection, QQ_DEFAULTS, QQ_SECRETS, type QQRosterEntry } from './config.ts';
import { QQWorld, enabledRosterIds } from './world.ts';
import { VISION_DEFAULTS, VisionService, type VisionConfig } from './vision.ts';
import { OpenRouterVLMClient } from './vlm.ts';

export const QQ: WorldDefinition<QQConfigSection> = {
  id: 'qq',
  label: 'QQ',
  defaults: () => ({ ...QQ_DEFAULTS, groups: [], privates: [], vision: { ...VISION_DEFAULTS } }),
  create: (ctx) => {
    const { cfg } = ctx;
    // 辅助视觉依赖开关与密钥;图片附件捕获不依赖视觉服务。
    const openrouterKey = ctx.secret(QQ_SECRETS.vision);
    const vision = cfg.vision.enabled && openrouterKey
      ? new VisionService({
          vlm: new OpenRouterVLMClient(openrouterKey, {
            baseUrl: cfg.vision.baseUrl,
            model: cfg.vision.model,
            maxTokens: cfg.vision.maxTokens,
            timeoutMs: cfg.vision.timeoutMs,
          }),
          cfg: cfg.vision,
          dataDir: ctx.dataDir,
          timezone: ctx.timezone,
        })
      : undefined;
    const module = new QQWorld(
      {
        wsUrl: cfg.wsUrl,
        groups: enabledRosterIds(cfg.groups),
        privates: enabledRosterIds(cfg.privates),
        token: cfg.token,
        timezone: ctx.timezone,
      },
      {
        vision,
        imageCapture: {
          timeoutMs: cfg.vision.timeoutMs,
          maxImageBytes: cfg.vision.maxImageBytes,
          inlineWaitMs: cfg.vision.dedupPrecheckMs,
        },
        gate: {
          enabled: () => cfg.enabled,
          wsUrl: () => cfg.wsUrl,
          tokenSet: () => !!cfg.token,
          roster: () => ({ groups: cfg.groups, privates: cfg.privates }),
          setRoster: (groups, privates) => {
            // The running module receives only enabled entries; the full roster is persisted.
            module.setWatched(enabledRosterIds(groups), enabledRosterIds(privates));
            ctx.persist({ groups, privates });
            const gOn = groups.filter((e) => e.enabled).length;
            const pOn = privates.filter((e) => e.enabled).length;
            return `监听名单已更新:群${groups.length}个(启用${gOn})、私聊${privates.length}个(启用${pOn}),已写回config.json`;
          },
          setEnabled: (enabled) => ctx.persist({ enabled }),
          setConnection: (wsUrl, token) => {
            // 空串 = 保持原 token 不动
            ctx.persist(token === '' ? { wsUrl } : { wsUrl, token });
          },
          restart: () => { void ctx.restart(); },
        },
      },
    );
    return module;
  },
};
