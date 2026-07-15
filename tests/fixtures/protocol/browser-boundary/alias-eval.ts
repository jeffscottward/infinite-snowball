export function execute(source: string): unknown {
  const run = eval;
  return run(source);
}
