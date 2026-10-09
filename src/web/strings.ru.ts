import type { en } from './strings.ts';

const pluralRules = new Intl.PluralRules('ru');
const plural = (n: number, one: string, few: string, many: string) => {
  const form = pluralRules.select(n);
  return form === 'one' ? one : form === 'many' ? many : few;
};

export const serverText: Partial<typeof en> = {
  paused: 'Приостановлено: события по-прежнему сохраняются и ставятся в очередь, пробуждения не доставляются',
  resumed: 'Возобновлено: накопленные события доставляются одним пакетом',
  exitSupervised: 'Процесс сейчас завершится; лаунчер запустит его снова',
  exitSupervisedPaused: 'Процесс сейчас завершится; лаунчер запустит его снова с приостановленной доставкой событий, поэтому возобновите её в управлении запуском',
  exitUnsupervised: 'Процесс сейчас завершится; цикл лаунчера не обнаружен, поэтому его нужно запустить снова вручную',
  shutdownSkipped: (n: number, labels: string[]) =>
    `Локальное выключение завершено, но ${n} ${plural(n, 'шаг не выполнен', 'шага не выполнены', 'шагов не выполнено')}: ${labels.join(', ')}`,
  shutdownComplete: (n: number) => `Локальное выключение завершено (выполнены все шаги: ${n})`,
  externalUnverified: (items: string[]) => `; [P0] ${items.join('; ')}`,
  externalItem: (label: string, status: string, detail: string, manualAction: string) =>
    `${label}=${status} (${detail}). Ручное действие: ${manualAction}`,
  externalVerified: '; все проверки внешнего состояния подтвердили завершение',
};
