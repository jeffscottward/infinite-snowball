export function execute(source: string): unknown {
  return globalThis.eval(source);
}
