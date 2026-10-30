/**
 * The names the System prompt page gives Cortico's persona templates. Every editor of these templates shows them
 * under the same name, so a template edited in two places reads as one thing.
 */
import { S } from './strings.ts';

export function sharedTemplate(key: string): { title: string; detail: string } | null {
  switch (key) {
    case 'constitution': return { title: S.constitutionTitle, detail: S.constitutionDesc };
    case 'orientation': return { title: S.orientationTitle, detail: S.orientationDesc };
    default: return null;
  }
}
