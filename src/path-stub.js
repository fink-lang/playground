// Minimal browser stub for Node's 'path' module.
// monaco-textmate uses only path.basename (for debug strings).
export const sep = '/'
export const basename = (p) => (p || '').split('/').pop() || ''
export const dirname  = (p) => (p || '').replace(/\/[^/]*$/, '') || '.'
export const join     = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/')
export default { sep, basename, dirname, join }
