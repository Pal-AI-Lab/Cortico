/** The World library's saved arrangement (`console/advanced/features/worlds/groups.ts`). */
import { describe, expect, it } from 'vitest';
import { addGroup, arrangeLayout, moveGroup, moveItem, readLayout, removeGroup, writeLayout, LAYOUT_STORAGE_KEY } from '../../src/web/client/features/worlds/groups.ts';

const names: Record<string, string> = { a: 'Alpha', b: 'Beta', c: 'Gamma', d: 'Delta', e: 'Epsilon' };
const name = (key: string) => names[key] ?? key;
const shape = (entries: ReturnType<typeof arrangeLayout>['entries']) => entries.map(entry => 'key' in entry ? entry.key : `${entry.group.name}[${entry.keys.join(',')}]`);

describe('World library layout', () => {
  it('keeps the given order the first time, then puts unseen keys first by name', () => {
    const first = arrangeLayout(undefined, ['c', 'a', 'b'], name);
    expect(shape(first.entries)).toEqual(['c', 'a', 'b']);
    const next = arrangeLayout(first.layout, ['c', 'a', 'b', 'e', 'd'], name);
    expect(shape(next.entries)).toEqual(['d', 'e', 'c', 'a', 'b']);
  });
  it('moves rows into and out of groups and moves whole groups', () => {
    const { layout } = arrangeLayout(undefined, ['a', 'b', 'c'], name);
    addGroup(layout, 'Chat', 'g');
    moveItem(layout, 'c', 'g', null);
    moveItem(layout, 'a', 'g', 'c');
    expect(shape(arrangeLayout(layout, ['a', 'b', 'c'], name).entries)).toEqual(['Chat[a,c]', 'b']);
    moveGroup(layout, 'g', null);
    moveItem(layout, 'c', null, 'b');
    expect(shape(arrangeLayout(layout, ['a', 'b', 'c'], name).entries)).toEqual(['c', 'b', 'Chat[a]']);
  });
  it('keeps an empty group and returns a removed group\'s rows to its place', () => {
    const { layout } = arrangeLayout(undefined, ['a', 'b'], name);
    addGroup(layout, 'Empty', 'e1');
    expect(shape(arrangeLayout(layout, ['a', 'b'], name).entries)).toEqual(['Empty[]', 'a', 'b']);
    moveItem(layout, 'b', 'e1', null);
    moveGroup(layout, 'e1', 'a');
    removeGroup(layout, 'e1');
    expect(shape(arrangeLayout(layout, ['a', 'b'], name).entries)).toEqual(['b', 'a']);
  });
  it('skips rows that are gone without forgetting their place', () => {
    const { layout } = arrangeLayout(undefined, ['a', 'b', 'c'], name);
    expect(shape(arrangeLayout(layout, ['a', 'c'], name).entries)).toEqual(['a', 'c']);
    expect(shape(arrangeLayout(layout, ['a', 'b', 'c'], name).entries)).toEqual(['a', 'b', 'c']);
  });
  it('round-trips through storage and ignores malformed data', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    const { layout } = arrangeLayout(undefined, ['a'], name);
    addGroup(layout, 'Kept', 'k'); layout.groups.k.collapsed = true;
    writeLayout(storage, layout);
    expect(readLayout(storage)).toEqual(layout);
    store.set(LAYOUT_STORAGE_KEY, '{"top":"x"}');
    expect(readLayout(storage)).toBeUndefined();
  });
});
