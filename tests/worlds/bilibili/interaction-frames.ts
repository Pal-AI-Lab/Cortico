/** Field 5 uses a Protobuf varint for the interaction type. */
export function interactionV2(type: number): Record<string, unknown> {
  return { cmd: 'INTERACT_WORD_V2', data: { pb: Buffer.from([0x28, type]).toString('base64') } };
}

export const ENTRY_INTERACTION_V2 = interactionV2(1);
