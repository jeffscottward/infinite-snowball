const {
  window: { eval: run },
} = globalThis;

export const execute = (source: string): unknown => run(source);
