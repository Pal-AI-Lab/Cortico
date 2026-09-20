import type { Editing } from './types.ts';

/** Drafts are scoped to the deployment and never retain API Key input. */
export function providerDrafts(storage: Storage, scope: string) {
  const key = `cortico:provider-drafts:v2:${scope}`;
  let values: Record<string, Editing> = {};
  try { values = JSON.parse(storage.getItem(key) ?? '{}'); } catch { /* A corrupt draft does not block saved connections. */ }
  if (!values || typeof values !== 'object' || Array.isArray(values)) values = {};
  const persist = () => storage.setItem(key, JSON.stringify(values));
  return {
    get(name: string): Editing | null {
      const value = values[name];
      return value && typeof value.name === 'string' && value.entry && typeof value.entry.kind === 'string' && value.raw
        ? structuredClone({ ...value, secretValue: '' }) : null;
    },
    set(value: Editing): void { values[value.original ?? '~draft'] = structuredClone({ ...value, secretValue: '' }); persist(); },
    remove(name: string): void { delete values[name]; persist(); },
    has(name: string): boolean { return !!values[name]; },
  };
}
