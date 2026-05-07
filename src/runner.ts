// Tier-1 ƒink WASM runner.
//
// Instantiates a compiled fink module via the upstream JS host shim
// (src/fink.js) and imports the entry module. stdout/stderr writes from
// fink are captured via host overrides; the result of the module's last
// expression is surfaced in the run summary.
//
// Timing buckets (all milliseconds):
//   initMs   — init_wasm: WASM instantiation + host-shim wiring.
//   importMs — fink.import('./playground.fnk'): module initialization.

import { init_wasm } from './fink.js'

export interface RunResult {
  ok: boolean
  status: 'ok' | 'panic' | 'trap'
  message: string
  initMs: number
  importMs: number
  runMs: number | null
  stdout: string[]
  stderr: string[]
}

export async function run(bytes: Uint8Array): Promise<RunResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  let initMs = 0
  let importMs = 0

  try {
    const tInit = performance.now()
    const fink = await init_wasm(bytes, {
      stdout_write: (s: string) => stdout.push(s),
      stderr_write: (s: string) => stderr.push(s),
      panic: () => { throw new Error('fink panic: irrefutable pattern failed') },
    })
    initMs = performance.now() - tInit

    const tImport = performance.now()
    const [last_val, mod] = await fink.import('./playground.fnk')
    importMs = performance.now() - tImport

    let message = `last = ${formatLastVal(last_val)}`
    let runMs: number | null = null
    const main = (mod as { main?: unknown } | undefined)?.main
    if (typeof main === 'function') {
      const tRun = performance.now()
      const result = await (main as (arg: string) => Promise<unknown>)('playground')
      runMs = performance.now() - tRun
      message = `main → ${formatLastVal(result)}`
    }
    return { ok: true, status: 'ok', message, initMs, importMs, runMs, stdout, stderr }
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    const isPanic = msg.includes('fink panic') || msg.includes('host_panic')
    return {
      ok: false,
      status: isPanic ? 'panic' : 'trap',
      message: msg,
      initMs,
      importMs,
      runMs: null,
      stdout,
      stderr,
    }
  }
}

function formatLastVal(v: unknown): string {
  if (v === undefined) return '()'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'function') return 'fn'
  return '<value>'
}
