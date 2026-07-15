const browserGlobal = globalThis;
const capability = "eval";

export function execute(source: string): unknown {
  return browserGlobal[capability](source);
}
