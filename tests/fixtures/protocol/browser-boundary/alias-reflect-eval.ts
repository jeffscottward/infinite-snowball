const R = Reflect;

export const run = (source: string): unknown => R.get(globalThis, "eval")(source);
