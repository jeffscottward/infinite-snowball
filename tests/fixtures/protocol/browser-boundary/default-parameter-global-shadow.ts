export function run(source: string, globalAlias = globalThis): unknown {
  var globalThis: unknown;
  return globalAlias.eval(source);
}
