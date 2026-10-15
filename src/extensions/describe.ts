/**
 * 扩展包里的 describe.json:`pnpm describe:extension` 从扩展的 Definition 与干装载结果导出,`cortico.describe`
 * 写它的包内路径;`pnpm check:extension` 核对它与代码一致。索引仓的 Action 与 WebUI 的扩展市场只读这个文件,
 * 不执行扩展代码。按类别只有对应的字段。
 */
import type { DescribeText, EventDescribe, ToolDescribe } from '../core/types.ts';
import type { ProviderDescribe } from '../providers/base.ts';

/** 包里带的一份默认提示词:World 的环境提示词,Bot 的 Persona 模板。`content` 是模板原文。 */
export interface PromptDescribe {
  key: string;
  title: string;
  role?: 'envPrompt' | 'prefix';
  content: string;
}

export interface ExtensionDescribeFile {
  /** World 的全部工具;Bot 是 Persona 提供的工具。 */
  tools?: ToolDescribe[];
  /** World 会推出的事件。 */
  events?: EventDescribe[];
  provider?: ProviderDescribe & { title: string; description?: string };
  bot?: {
    /** 默认启用的 World id */
    worlds: string[];
    memory: { name: string; form: DescribeText };
  };
  prompts?: PromptDescribe[];
}
