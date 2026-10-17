import { itemText, type ContextRecord } from './context.ts';

/** Approximate context occupancy shared by runtime and WebUI; excludes native wire overhead. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef)
    )
      cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.6 + other * 0.3);
}

export function estimateMessagesTokens(messages: readonly ContextRecord[]): number {
  return messages.reduce(
    (total, { item }) =>
      total +
      8 +
      estimateTokens(item.type === 'function_call' ? item.name + item.arguments : itemText(item)) +
      // The upstream counts the reasoning a signed block decodes to, not the block itself, so the
      // block stands in only when the full reasoning text was not recorded.
      (item.type === 'reasoning' && item.encrypted_content && !item.content?.some(part => 'text' in part && part.text)
        ? estimateTokens(item.encrypted_content)
        : 0),
    0,
  );
}
