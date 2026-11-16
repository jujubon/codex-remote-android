export function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}
