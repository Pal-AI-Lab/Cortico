/** New connection names are portable directory names; unchanged historical keys are exempt. */
export function validateProviderName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
    return 'Use English letters, digits, - or _; start with a letter or digit. Spaces are not allowed.';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name))
    return 'This name is reserved by Windows.';
  return null;
}
