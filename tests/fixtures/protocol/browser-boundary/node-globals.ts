export function readNodeGlobals(): unknown[] {
  return [
    Buffer,
    process,
    require,
    module,
    __dirname,
    __filename,
  ];
}
