// Tier-1 ƒink WASM runner.
//
// Instantiates a compiled fink module in the browser and calls its entry
// wrapper. Host imports are no-op stubs except `host_panic`, which throws —
// programs that compute pure results execute end-to-end; programs that try
// to do IO simply have their host calls swallowed for now.
//
// Output is wall-clock duration + status + any trap message. Once fink
// gains a JS-friendly bytes-readback helper we'll surface stdout/stderr
// here too.

export interface RunResult {
  ok: boolean
  status: 'ok' | 'panic' | 'trap' | 'no-entry'
  message: string
  durationMs: number
}

interface HostImports {
  env: {
    host_panic: (...args: unknown[]) => void
    host_channel_send: (...args: unknown[]) => void
    host_read: (...args: unknown[]) => void
    host_invoke_cont: (...args: unknown[]) => void
    host_resume: (...args: unknown[]) => void
  }
}

function makeImports(): HostImports {
  return {
    env: {
      host_panic: () => {
        throw new Error('fink panic: irrefutable pattern failed')
      },
      // No bytes-readback path yet — silently swallow. Once interop/js.wat
      // lands upstream we can copy bytes out via a memory-readback helper.
      host_channel_send: () => {},
      // No stdin source yet. The fink runtime expects host_read to settle
      // a future asynchronously; a missing settle just leaves the program
      // parked at that point. Programs that don't read stdin run cleanly.
      host_read: () => {},
      // The cont handshake delivers main's exit code and module-init result.
      // We discard both for now.
      host_invoke_cont: () => {},
      // Scheduler reentry hook — the runtime calls this when the task
      // queue is empty so the host can drive any pending IO / settle
      // host futures and re-fill the queue. With no IO and no async
      // futures, returning immediately is the correct behaviour: the
      // scheduler will then exit because the queue is still empty.
      host_resume: () => {},
    },
  }
}

// Find the entry wrapper export. compile_package emits each module's
// wrapper under its canonical URL. The entry's URL is `./<basename>`.
function findEntryWrapper(instance: WebAssembly.Instance): {
  name: string
  func: Function
} | null {
  const exports = instance.exports as Record<string, unknown>
  for (const name of Object.keys(exports)) {
    if (!name.startsWith('./')) continue
    const value = exports[name]
    if (typeof value === 'function') {
      return { name, func: value as Function }
    }
  }
  return null
}

/// Build an empty `$ByteArray` to pass as the wrapper's key.
///
/// JS cannot directly construct a WasmGC array — there is no
/// `WebAssembly.Array.new()` API in any browser as of mid-2025.
///
/// TODO(interop): only `interop/*.wat` exports are part of fink's
/// stable contract. The two `std/str.*` exports used here are internal
/// and *will* disappear under linker DCE / cleanup. Migrate to a
/// proper interop bootstrap export (e.g. an `interop/js.wat`
/// `_alloc_empty_bytes`) the moment one is available — currently
/// blocking the playground's tier-1 runner.
function makeEmptyByteArray(instance: WebAssembly.Instance): unknown {
  const exports = instance.exports as Record<string, unknown>
  const strEmpty = exports['std/str.fnk:str_empty'] as Function | undefined
  const bytes = exports['std/str.wat:bytes'] as Function | undefined
  if (!strEmpty || !bytes) {
    throw new Error('runtime missing str_empty / bytes exports — cannot bootstrap entry call')
  }
  return bytes(strEmpty())
}

function callEntry(entry: { name: string; func: Function }, key: unknown): void {
  entry.func(key, 0)
}

export async function run(bytes: Uint8Array): Promise<RunResult> {
  const t0 = performance.now()
  let instance: WebAssembly.Instance
  try {
    const result = await WebAssembly.instantiate(bytes, makeImports() as unknown as WebAssembly.Imports)
    instance = result.instance
  } catch (e) {
    return {
      ok: false,
      status: 'trap',
      message: `instantiate failed: ${(e as Error).message}`,
      durationMs: performance.now() - t0,
    }
  }

  const entry = findEntryWrapper(instance)
  if (!entry) {
    return {
      ok: false,
      status: 'no-entry',
      message: 'no entry wrapper export (expected one starting with "./")',
      durationMs: performance.now() - t0,
    }
  }

  try {
    const key = makeEmptyByteArray(instance)
    callEntry(entry, key)
  } catch (e) {
    const msg = (e as Error).message
    const isPanic = msg.includes('fink panic')
    return {
      ok: false,
      status: isPanic ? 'panic' : 'trap',
      message: msg,
      durationMs: performance.now() - t0,
    }
  }

  return {
    ok: true,
    status: 'ok',
    message: `ran ${entry.name}`,
    durationMs: performance.now() - t0,
  }
}
