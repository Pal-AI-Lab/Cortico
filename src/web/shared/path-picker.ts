import type { Language } from '../../core/language.ts';

/** 浏览器控制台发起的一次主机原生路径选择。 */
export interface PathPickerOptions {
  kind: 'file' | 'directory';
  /** 原生对话框标题。 */
  title?: string;
  /** 当前配置值；优先用作对话框起始位置。 */
  currentPath?: string;
  /** 当前值为空时使用的建议部署目录。 */
  recommendedDir?: string;
  /** 可选文件后缀，如 `.gguf` 或 `.model3.json`。 */
  extensions?: string[];
}

export interface PathPicker {
  /** 返回主机绝对路径；用户取消时返回 null。缺省标题、文件类型标签与报错按 `language`。 */
  pick(options: PathPickerOptions, language: Language): Promise<string | null>;
}

export interface PathPickerResponse {
  path: string | null;
}

export const PATH_PICKER_ROUTE = '/api/path-picker';
