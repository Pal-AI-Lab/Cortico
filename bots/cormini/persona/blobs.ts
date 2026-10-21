/** save_blob 工具的参数、权限检查与回执；附件存储由 WorkspaceBlobStore 提供。 */
import { LOG_SCHEME, blobScheme } from 'cortico/core/blobs.ts';
import type { BlobStore, CoreApi, ToolDef } from 'cortico/core/types.ts';

export const SAVE_BLOB_DECL: Omit<ToolDef, 'handler'> = {
  name: 'save_blob',
  description: 'Keep a binary you have seen (a log: handle from a [blob ...] line) in your workspace. '
    + 'Give the path to store it under (blobs/ is where such files live, e.g. blobs/stickers/cat.jpg); '
    + 'the receipt returns a mem: handle you can hand to tools later and note down. '
    + 'Log attachments can be cleared; what you save here stays with your memory.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'The log: handle as written in the [blob ...] line, e.g. log:1a2b3c4d (a unique prefix of 8+ hex digits after log: is enough).' },
      path: { type: 'string', description: 'Where to keep it, relative to your workspace, with an extension.' },
    },
    required: ['handle', 'path'],
  },
};

/** 将 log: 附件复制到工作区并返回 mem: 句柄；成功回执以 [saved] 开头，供写后提交钩子识别。 */
export function saveBlobTool(deps: {
  blobs: BlobStore;
  core: () => CoreApi | null;
  /** 写准入(同Persona的 writeGuard):返回理由就拒绝 */
  guard?: (path: string, role: string) => string | null;
}): ToolDef {
  return {
    ...SAVE_BLOB_DECL,
    handler: async (args, ctx) => {
      const given = String(args.handle ?? '').trim();
      const path = String(args.path ?? '').trim();
      if (!given) return '[save failed] handle 不能为空';
      // 只给了哈希时按 log: 句柄解析
      const handle = blobScheme(given) ? given : `${LOG_SCHEME}${given}`;
      if (!path) return '[save failed] path 不能为空';
      const denied = deps.guard?.(path, ctx.role) ?? null;
      if (denied) return `[save failed] ${denied}`;
      const core = deps.core();
      const got = core?.blob(handle) ?? null;
      if (!got) return `[save failed] 没有 ${handle} 这份二进制;句柄来自你看到过的 [blob ...] 行`;
      try {
        const saved = deps.blobs.put(path, got.bytes, got.mime);
        return `[saved] ${saved} ${got.mime} ${got.bytes.byteLength} 字节`;
      } catch (e) {
        return `[save failed] ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
