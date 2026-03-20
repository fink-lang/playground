// Minimal WASI preview1 shim that runs compiled WASM inside a sandboxed
// iframe and relays stdout/stderr back to the parent via postMessage.
//
// Implements only the syscalls needed by typical Fink output:
//   fd_write, proc_exit, fd_close, fd_seek,
//   environ_sizes_get, environ_get, args_sizes_get, args_get

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

// The runner script embedded in the iframe via srcdoc.
// The closing </script> tag is intentionally split across the template
// literal and the string concatenation so the HTML parser does not
// interpret it as the end of the <script> element prematurely.
const RUNNER_HTML =
  `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<script>
'use strict';
let memory;

function fd_write(fd, iovs, iovs_len, nwritten_ptr) {
  const view = new DataView(memory.buffer);
  let total = 0, text = '';
  for (let i = 0; i < iovs_len; i++) {
    const ptr = view.getUint32(iovs + i * 8, true);
    const len = view.getUint32(iovs + i * 8 + 4, true);
    text += new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
    total += len;
  }
  view.setUint32(nwritten_ptr, total, true);
  parent.postMessage({ type: 'output', fd, text }, '*');
  return 0;
}

function noopZero() { return 0; }

function sizeGetZero(pc, pb) {
  const v = new DataView(memory.buffer);
  v.setUint32(pc, 0, true);
  v.setUint32(pb, 0, true);
  return 0;
}

window.addEventListener('message', async ({ data }) => {
  if (data.type !== 'run') return;

  const imports = {
    wasi_snapshot_preview1: {
      fd_write,
      proc_exit: (code) => { throw { __wasi_exit: code }; },
      fd_close:  noopZero,
      fd_seek:   () => 70, // ERRNO_SPIPE — seeks not supported
      environ_sizes_get: sizeGetZero,
      environ_get:       noopZero,
      args_sizes_get:    sizeGetZero,
      args_get:          noopZero,
    },
  };

  try {
    const result = await WebAssembly.instantiate(data.wasm, imports);
    memory = result.instance.exports.memory;
    result.instance.exports._start();
    parent.postMessage({ type: 'done', exitCode: 0 }, '*');
  } catch (e) {
    if (e && typeof e.__wasi_exit === 'number') {
      parent.postMessage({ type: 'done', exitCode: e.__wasi_exit }, '*');
    } else {
      parent.postMessage({ type: 'error', message: String(e) }, '*');
    }
  }
});

parent.postMessage({ type: 'ready' }, '*');
` + `</script></body></html>`

export function run(wasm: Uint8Array): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    iframe.setAttribute('sandbox', 'allow-scripts')
    document.body.appendChild(iframe)

    let stdout = ''
    let stderr = ''

    function cleanup(result?: RunResult, err?: Error) {
      window.removeEventListener('message', onMessage)
      document.body.removeChild(iframe)
      if (err) reject(err)
      else resolve(result!)
    }

    function onMessage(e: MessageEvent) {
      if (e.source !== iframe.contentWindow) return
      const { data } = e

      if (data.type === 'ready') {
        // Structured-clone the buffer so the original Uint8Array stays usable.
        iframe.contentWindow!.postMessage({ type: 'run', wasm: wasm.buffer }, '*')
      } else if (data.type === 'output') {
        if (data.fd === 1) stdout += data.text
        else if (data.fd === 2) stderr += data.text
      } else if (data.type === 'done') {
        cleanup({ stdout, stderr, exitCode: data.exitCode })
      } else if (data.type === 'error') {
        cleanup(undefined, new Error(data.message))
      }
    }

    window.addEventListener('message', onMessage)
    iframe.srcdoc = RUNNER_HTML
  })
}
