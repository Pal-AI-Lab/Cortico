/**
 * 推理项的本地估算只计一份推理:上游按签名块解出的推理计数,记下了完整推理文字就不再加签名块(#272)。
 */
import { describe, expect, it } from 'vitest';
import { record } from '../../src/protocol/open-responses/context.ts';
import { estimateMessagesTokens, estimateTokens } from '../../src/protocol/open-responses/tokens.ts';

const reasoning = (fields: Record<string, unknown>) =>
  record({ type: 'reasoning', id: 'r', summary: [], status: 'completed', ...fields } as never);

describe('estimateMessagesTokens 推理项', () => {
  it('有推理文字时不计签名块;只有摘要或什么都没有时签名块照计', () => {
    const block = 'x'.repeat(400);
    const text = [{ type: 'reasoning_text', text: '想了想' }];
    expect(estimateMessagesTokens([reasoning({ content: text, encrypted_content: block })]))
      .toBe(estimateMessagesTokens([reasoning({ content: text })]));
    expect(estimateMessagesTokens([reasoning({ summary: [{ type: 'summary_text', text: '摘要' }], encrypted_content: block })]))
      .toBe(8 + estimateTokens('摘要') + estimateTokens(block));
  });
});
