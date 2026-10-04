/** 比较 npm 的标准 SemVer；无法比较时不猜测是否有更新。 */
export function newerVersion(latest: string, installed: string): boolean | null {
  const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const a = parse(latest);
  const b = parse(installed);
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i++) {
    const left = BigInt(a[i]);
    const right = BigInt(b[i]);
    if (left !== right) return left > right;
  }
  if (!a[4] && !b[4]) return false;
  if (!a[4]) return true;
  if (!b[4]) return false;
  const left = a[4].split('.');
  const right = b[4].split('.');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    const xNumeric = /^(0|[1-9]\d*)$/.test(left[i]);
    const yNumeric = /^(0|[1-9]\d*)$/.test(right[i]);
    if (xNumeric && yNumeric) return BigInt(left[i]) > BigInt(right[i]);
    if (xNumeric !== yNumeric) return !xNumeric;
    return left[i] > right[i];
  }
  return left.length > right.length;
}
