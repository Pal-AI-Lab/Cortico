import { describeTools, type WorldDefinition } from '../../world.ts';
import { type QQConfigSection, QQ_DEFAULTS, QQ_SECRETS } from './config.ts';
import { QQWorld, QQ_TOOL_DECLS, enabledRosterIds } from './world.ts';
import { VISION_DEFAULTS, VisionService } from './vision.ts';
import { OpenRouterVLMClient } from './vlm.ts';

export const QQ: WorldDefinition<QQConfigSection> = {
  id: 'qq',
  label: 'QQ',
  defaults: () => ({ ...QQ_DEFAULTS, groups: [], privates: [], vision: { ...VISION_DEFAULTS } }),
  create: (ctx) => {
    const { cfg } = ctx;
    // 辅助视觉依赖开关与密钥;没有它时,主模型收图则由 QQWorld 自己下载图片附件。
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
        imageCapture: cfg.vision,
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
          restart: () => ctx.restart(),
        },
      },
    );
    return module;
  },
  describe: {
    tools: describeTools(QQ_TOOL_DECLS, {
      qq_draft: {
        zh: '起草一条 QQ 消息(文字、图片、语音或引用回复),先暂存不发。',
        en: 'Drafts a QQ message (text, image, voice or quote reply) and holds it unsent.',
      },
      qq_confirm: { zh: '把最近一份草稿发出去,或者作废。', en: 'Sends or discards the latest draft.' },
      qq_read_history: {
        zh: '读监听会话的历史消息:某条消息前后,或一段时间内。',
        en: 'Reads past messages in watched conversations, around one message or within a time range.',
      },
      qq_grep_history: {
        zh: '按关键词搜监听会话的历史消息,每处命中带前后几条。',
        en: 'Searches past messages in watched conversations by keyword, with a few messages around each hit.',
      },
      qq_view_image: {
        zh: '就一张图向辅助视觉模型追问;配好辅助视觉才有。',
        en: 'Asks the auxiliary vision model a question about an image; present only when auxiliary vision is set up.',
      },
    }),
    events: [
      {
        type: 'qq.message',
        description: {
          zh: '监听的群或私聊里来了消息;群里被@时立即投递。',
          en: 'A message in a watched group or private chat; delivered at once when the bot is mentioned in a group.',
        },
      },
      {
        type: 'qq.image',
        description: { zh: '消息里的图片下载完成后补发的附件。', en: 'An image from an earlier message, sent once its download finishes.' },
      },
      {
        type: 'qq.vision',
        description: { zh: '辅助视觉模型对一张图的描述。', en: "The auxiliary vision model's description of an image." },
      },
      {
        type: 'qq.transcript',
        description: { zh: '一条语音消息的转写结果,或转写失败的原因。', en: 'The transcript of a voice message, or why transcription failed.' },
      },
      {
        type: 'qq.reply.uncaptured',
        description: {
          zh: '被引用的消息不在记录里时,向协议端查到的原文或查询失败的原因。',
          en: 'For a quoted message missing from the record: the original fetched from the protocol end, or why the fetch failed.',
        },
      },
      {
        type: 'qq.forward',
        description: { zh: '转发的聊天记录展开后的内容。', en: 'The contents of a forwarded chat record.' },
      },
      {
        type: 'qq.recall',
        description: { zh: '群里有人撤回了一条消息。', en: 'Someone in a group recalled a message.' },
      },
      {
        type: 'qq.member',
        description: { zh: '有人加入或退出了群。', en: 'Someone joined or left a group.' },
      },
      {
        type: 'qq.emoji',
        description: { zh: '群里有人给一条消息贴了表情。', en: 'Someone in a group reacted to a message with an emoji.' },
      },
      {
        type: 'qq.poke',
        description: { zh: '群里有人戳了戳某人。', en: 'Someone in a group poked someone.' },
      },
      {
        type: 'qq.watch',
        description: { zh: '监听名单加入或移除了一个会话。', en: 'A conversation was added to or removed from the watch list.' },
      },
      {
        type: 'qq.self',
        description: { zh: 'bot 自己发出的 QQ 消息,只记录,不唤醒。', en: "The bot's own sent QQ message; recorded without waking the bot." },
      },
    ],
  },
};
