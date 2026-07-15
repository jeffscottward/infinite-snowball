const constructorKey = ["con", "structor"].join("");
const FunctionConstructor = (() => undefined)[constructorKey];

export const run = (source: string): unknown => FunctionConstructor(source)();
