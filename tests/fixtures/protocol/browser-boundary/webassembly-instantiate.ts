const wasmBytes = new Uint8Array([0, 97, 115, 109]);

export const executableModule = WebAssembly.instantiate(wasmBytes);
