// 上一版契约的写法:模块路径、实例方法名与 manifest 字段都用旧名。
import { pageIdFor } from 'cortico/web/shared/console-protocol.ts';

export default {
  id: 'previous-world',
  label: '上一版契约的 World',
  defaults: () => ({ enabled: false }),
  create: () => ({
    id: 'previous-world',
    envPromptVars: () => ({}),
    tools: () => [],
    start: async () => {},
    stop: async () => {},
    console: (language) => ({ label: `${pageIdFor('world', 'previous-world')} ${language}` }),
  }),
};
