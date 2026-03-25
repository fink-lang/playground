// Fink → WASM compiler. The compile() function is backed by the playground
// WASM crate (fink_playground_wasm). Call setCompileModule() once the crate
// is initialised (see main.ts) so compile() can delegate to it.

type WasmModule = { compile: (src: string) => Uint8Array }

let wasmMod: WasmModule | null = null

export function setCompileModule(mod: WasmModule): void {
  wasmMod = mod
}

export async function compile(src: string): Promise<Uint8Array | null> {
  if (!wasmMod) return null
  return wasmMod.compile(src)
}
