export function compile(source: string): (...args: unknown[]) => unknown {
  return new globalThis.Function(source) as (...args: unknown[]) => unknown;
}
