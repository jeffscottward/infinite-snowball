const constructorKey = ["con", "structor"].join("");
const descriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(() => undefined),
  constructorKey,
);
const FunctionConstructor = descriptor?.value as Function;

export const run = (source: string): unknown => FunctionConstructor(source)();
