const descriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(() => undefined),
  "constructor",
);
const FunctionConstructor = descriptor?.value as Function;

export const run = (source: string): unknown => FunctionConstructor(source)();
