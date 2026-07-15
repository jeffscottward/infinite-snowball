export function run(source: string, globalAlias = globalThis): unknown {
  return globalAlias.eval(source);
}
