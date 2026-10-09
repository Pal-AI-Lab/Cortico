import { pick, type Language } from '../core/language.ts';
import { serverText as zhHant } from './strings.zh-Hant.ts';
import { serverText as ja } from './strings.ja.ts';
import { serverText as ko } from './strings.ko.ts';
import { serverText as fr } from './strings.fr.ts';
import { serverText as de } from './strings.de.ts';
import { serverText as es419 } from './strings.es-419.ts';
import { serverText as ptBR } from './strings.pt-BR.ts';
import { serverText as it } from './strings.it.ts';
import { serverText as ru } from './strings.ru.ts';

/** 服务端直接回给操作者的几句话:运行控制回执与关机账的总结行,按请求的界面语言。API 协议错误不在此列。 */
const zh = {
  paused: '已暂停:事件照常落库排队,不投递唤醒',
  resumed: '已继续:积压事件一次性投递',
  exitSupervised: '进程即将退出,启动器随即重新拉起',
  exitSupervisedPaused: '进程即将退出,启动器随即重新拉起;回来时事件投递是暂停的,要在运行状态里按继续',
  exitUnsupervised: '进程即将退出;没有检测到启动器循环,需要手动重新启动',
  shutdownSkipped: (n: number, labels: string[]) => `本地关机完成,但有 ${n} 步没走完:${labels.join('、')}`,
  shutdownComplete: (n: number) => `本地关机完成(${n} 步全部走完)`,
  externalUnverified: (items: string[]) => `；[P0] ${items.join('；')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status}（${detail}）。人工动作:${manualAction}`,
  externalVerified: '；外部状态均已确认结束',
};
export const en: typeof zh = {
  paused: 'Paused: events are still stored and queued, no wake is delivered',
  resumed: 'Resumed: the backlog is delivered in one batch',
  exitSupervised: 'The process is about to exit; the launcher will start it again',
  exitSupervisedPaused: 'The process is about to exit; the launcher will start it again with event delivery paused, so resume it in the run status',
  exitUnsupervised: 'The process is about to exit; no launcher loop was detected, so it must be started again by hand',
  shutdownSkipped: (n: number, labels: string[]) => `Local shutdown finished, but ${n} step(s) did not complete: ${labels.join(', ')}`,
  shutdownComplete: (n: number) => `Local shutdown finished (all ${n} steps completed)`,
  externalUnverified: (items: string[]) => `; [P0] ${items.join('; ')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status} (${detail}). Manual action: ${manualAction}`,
  externalVerified: '; every external state is confirmed ended',
};
export const serverText = (language: Language) => pick(language, {
  zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
});
