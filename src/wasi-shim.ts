// Fink WASM runner.
//
// The fink codegen produces a standalone module (no WASI imports) that exports:
//   fink_main — entry point (no params, no results)
//   result    — global i32 holding the final value written by $__halt
//
// TODO: swap to WASI preview1 once the compiler supports IO.

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function run(wasm: Uint8Array): Promise<RunResult> {
  const { instance } = await WebAssembly.instantiate(wasm.buffer, {})
  const exports = instance.exports as {
    fink_main: () => void
    result: WebAssembly.Global
  }
  try {
    exports.fink_main()
  } catch (e) {
    return { stdout: '', stderr: `Runtime error: ${e}`, exitCode: 1 }
  }
  const value = exports.result.value as number
  return { stdout: String(value), stderr: '', exitCode: 0 }
}
