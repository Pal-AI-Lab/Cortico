/** config.json 的 `worlds.console` 节。WebUI 热改就地写这个对象,World 每次用时现读。 */
export interface ConsoleConfigSection {
  enabled: boolean;
  /** 控制台口令,六位数字;空 = 不启用。 */
  pin: string;
}

/** World 默认关闭;是否挂载由部署装配配置决定。口令默认空,要人来配。 */
export const CONSOLE_DEFAULTS: ConsoleConfigSection = { enabled: false, pin: '' };
