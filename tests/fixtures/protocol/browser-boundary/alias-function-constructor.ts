export function compile(source: string): () => unknown {
  const Constructor = Function;
  return new Constructor(source) as () => unknown;
}
