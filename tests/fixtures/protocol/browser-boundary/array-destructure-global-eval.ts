const [globalAlias] = [globalThis];

export const run = (source: string): unknown => globalAlias.eval(source);
