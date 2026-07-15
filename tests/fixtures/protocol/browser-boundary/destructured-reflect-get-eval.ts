const { get } = Reflect;

export const run = (source: string): unknown => get(globalThis, "eval")(source);
