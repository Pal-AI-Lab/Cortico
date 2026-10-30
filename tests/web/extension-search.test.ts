/** The extension market's text search (`console/advanced/features/extensions/search.ts`). */
import { describe, expect, it } from 'vitest';
import { editDistance, foldText, matchRank, matchRanges, prepareFields, searchTerms } from '../../src/web/client/features/extensions/search.ts';

const fields = (over: { names?: string[]; labels?: string[]; text?: string[] }) => prepareFields({ names: [], labels: [], text: [], ...over });

describe('extension search', () => {
  it('folds width, case, accents and separators', () => {
    expect(foldText('Ｃortico-World_Desktop.Pet')).toBe('cortico world desktop pet');
    expect(foldText('Café')).toBe('cafe');
    expect(foldText('桌宠')).toBe('桌宠');
    expect(searchTerms('  QQ  语音 qq ')).toEqual(['qq', '语音']);
  });
  it('needs every word somewhere, in any order', () => {
    const qq = fields({ names: ['cortico-world-qq', 'QQ 群聊'], labels: ['语音', '即时通讯'], text: ['OneBot 适配器'] });
    expect(matchRank(searchTerms('语音 qq'), qq)).toBe(1);
    expect(matchRank(searchTerms('qq onebot'), qq)).toBe(0);
    expect(matchRank(searchTerms('qq 直播'), qq)).toBeUndefined();
  });
  it('ranks a whole-name match above a name match above a tag or description match', () => {
    const terms = searchTerms('qq 群聊');
    expect(matchRank(terms, fields({ names: ['QQ 群聊'] }))).toBe(3);
    expect(matchRank(terms, fields({ names: ['QQ 群聊增强'] }))).toBe(2);
    expect(matchRank(terms, fields({ names: ['qq'], labels: ['群聊'] }))).toBe(1);
    expect(matchRank(terms, fields({ names: ['qq'], text: ['支持群聊'] }))).toBe(0);
  });
  it('forgives small slips in longer Latin words only', () => {
    const pet = fields({ names: ['cortico-world-desktop-pet'], labels: ['deepseek'] });
    expect(matchRank(['desktoppet'], pet)).toBe(0);
    expect(matchRank(['deepsek'], pet)).toBe(0);
    expect(matchRank(['dsektop'], pet)).toBe(0);
    expect(matchRank(['deskt0'], pet)).toBe(0);
    expect(matchRank(['pex'], pet)).toBeUndefined();
    expect(matchRank(['zzzzzz'], pet)).toBeUndefined();
  });
  it('bounds the edit distance and counts a swap as one step', () => {
    expect(editDistance('deepsek', 'deepseek', 1)).toBe(1);
    expect(editDistance('dsektop', 'desktop', 1)).toBe(1);
    expect(editDistance('abc', 'xyzabc', 1)).toBe(2);
  });
  it('finds matches in the original text, merging overlaps', () => {
    expect(matchRanges('Ｑｑ 群聊 qq', ['qq'])).toEqual([[0, 2], [6, 8]]);
    expect(matchRanges('desktop-pet', ['desk', 'sktop'])).toEqual([[0, 7]]);
  });
});
