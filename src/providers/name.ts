/** New connection names are portable directory names; unchanged historical keys are exempt. */
export function validateProviderName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
    return 'Use English letters, digits, - or _; start with a letter or digit. Spaces are not allowed.';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name))
    return 'This name is reserved by Windows.';
  return null;
}

/**
 * 密钥变量名缺省时的默认名,按端点名派生。读取是进程环境优先:所有端点共用一个默认名时,
 * 环境里的一个值会遮蔽每个端点各自的 `.env`,按名派生后互不遮蔽。
 */
export function defaultSecretName(name: string): string {
  return `CORTICO_KEY_${name.toUpperCase().replace(/-/g, '_')}`;
}
