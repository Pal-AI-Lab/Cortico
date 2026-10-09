import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  loading: 'Загрузка…',
  optionCurrent: '(текущее)',
  ownerPersona: 'Persona',
  chooseFile: 'Выбрать файл',
  chooseDirectory: 'Выбрать папку',
  recommendedDir: (dir: string) => `Рекомендуемая папка: ${dir}`,
  download: 'Скачать',
  on: 'Включено',
  leaveBlank: 'Оставьте пустым',
  saving: 'Сохранение…',
  saveFailed: (err: string) => 'Ошибка: ' + err,
  emptyDefault: 'На этой странице нет параметров.',
  noSchema: 'Параметры не заданы.',
  restartWorld: 'вступит в силу после перезапуска World',
  restartProcess: 'вступит в силу после перезапуска',
  loadFailed: (err: string) => 'Не удалось загрузить конфигурацию: ' + err,
};
