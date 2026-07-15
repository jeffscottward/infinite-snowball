let globalAlias: typeof globalThis;

export function run(source: string): unknown {
  globalAlias = globalThis;
  return globalAlias.eval(source);
}
