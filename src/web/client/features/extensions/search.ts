/**
 * 扩展市场的文本搜索:整份结果已在内存里,这里只管怎么比。
 *
 * - 先规整:全角转半角、大小写合一、去掉拉丁字母的重音,`- _ . / @` 等分隔符当空格,
 *   所以 `desktop pet` 能找到 `cortico-world-desktop-pet`。
 * - 搜索词按空格切开,每个词都要在某一处命中(任意顺序)。
 * - 四个字母以上的拉丁词允许小错:去掉分隔符后连写能对上(`desktoppet`),或者跟某个词差
 *   一两个字母(`deepsek`)。中日韩文字照子串比,本来就不靠空格分词。
 * - 命中的位置决定档次:整个名字对上 > 名字里 > 标签、关键字、作者 > 描述、说明或靠容错。
 *   同档之间仍按用户选的排序。
 */

/** 规整后的文本,以及每个规整后字符对应原文的起止,高亮要用。 */
interface Folded { text: string; from: number[]; to: number[] }

const SEPARATORS = /[\s\-_./\\@:+,;|()[\]{}'"`~!?#&*=<>，。、；：！？（）【】《》「」『』·]/u;
const LATIN = /^[a-z0-9]+$/;

/** 逐个码点规整,记下每个结果字符来自原文哪里。 */
function foldMapped(text: string): Folded {
  let out = ''; const from: number[] = [], to: number[] = [];
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)!), end = i + ch.length;
    const piece = SEPARATORS.test(ch) ? ' ' : ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFKC').toLowerCase();
    for (let k = 0; k < piece.length; k++) { from.push(i); to.push(end); }
    out += piece; i = end;
  }
  return { text: out, from, to };
}

/** 规整一段文本,用来比对。 */
export function foldText(text: string): string {
  return foldMapped(text).text;
}

/** 搜索框里的词:规整、按空格切开、去重。 */
export function searchTerms(query: string): string[] {
  return [...new Set(foldText(query).split(' ').filter(Boolean))];
}

/** 两个词的编辑距离(相邻字母对调算一步),超过 `limit` 就提前放弃,返回 `limit + 1`。 */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before = Array.from({ length: b.length + 1 }, (_, j) => j), previous = before;
  for (let i = 1; i <= a.length; i++) {
    const row = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      row.push(value); best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    before = previous; previous = row;
  }
  return previous[b.length];
}

/** 一个包里可供搜索的文本,按档次分组。 */
export interface SearchFields {
  /** 包名与显示名 */
  names: readonly (string | undefined)[];
  /** 标签名、关键字、作者、发布者与维护者 */
  labels: readonly (string | undefined)[];
  /** 描述与官方说明 */
  text: readonly (string | undefined)[];
}

/** 档次:3 整个名字对上,2 每个词都在名字里,1 都在名字、标签或作者里,0 有词只在描述里或靠容错。 */
export type MatchRank = 0 | 1 | 2 | 3;

/** 预先规整好的字段,同一份结果反复搜时不必每次重算。 */
export interface PreparedFields { names: string[]; labels: string[]; text: string[]; words: string[]; compact: string[] }

export function prepareFields(fields: SearchFields): PreparedFields {
  const fold = (list: readonly (string | undefined)[]) => list.filter((v): v is string => !!v).map(foldText);
  const names = fold(fields.names), labels = fold(fields.labels), text = fold(fields.text);
  const words = [...new Set([...names, ...labels].flatMap(value => value.split(' ')).filter(word => LATIN.test(word)))];
  return { names, labels, text, words, compact: [...names, ...labels].map(value => value.replaceAll(' ', '')) };
}

/** 一个词能不能靠容错对上:连写对上,或与某个名字、标签里的词只差一两个字母。 */
function nearly(term: string, fields: PreparedFields): boolean {
  if (term.length < 4 || !LATIN.test(term)) return false;
  if (fields.compact.some(value => value.includes(term))) return true;
  const limit = term.length >= 8 ? 2 : 1;
  return fields.words.some(word => editDistance(term, word, limit) <= limit
    // 词还没打完时,拿同样长的开头比
    || (word.length > term.length && editDistance(term, word.slice(0, term.length), limit) <= limit));
}

/** 所有词都命中时返回档次,有词没命中返回 undefined。没有词时算全部命中。 */
export function matchRank(terms: readonly string[], fields: PreparedFields): MatchRank | undefined {
  if (!terms.length) return 0;
  const whole = terms.join(' ');
  if (fields.names.some(name => name.trim() === whole)) return 3;
  let rank: MatchRank = 2;
  for (const term of terms) {
    if (fields.names.some(value => value.includes(term))) continue;
    if (fields.labels.some(value => value.includes(term))) { rank = Math.min(rank, 1) as MatchRank; continue; }
    if (fields.text.some(value => value.includes(term)) || nearly(term, fields)) { rank = 0; continue; }
    return undefined;
  }
  return rank;
}

/** 原文里搜索词出现的位置(合并重叠),按原文下标给出 `[起, 止)`。容错对上的不标。 */
export function matchRanges(text: string, terms: readonly string[]): [number, number][] {
  if (!terms.length || !text) return [];
  const folded = foldMapped(text), found: [number, number][] = [];
  for (const term of terms) {
    for (let at = folded.text.indexOf(term); at >= 0; at = folded.text.indexOf(term, at + term.length)) found.push([folded.from[at], folded.to[at + term.length - 1]]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
  }
  return merged;
}
