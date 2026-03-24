// Dependency checker and updater for the Fink playground.
//
// Usage:
//   node deps.mjs check    — show outdated npm, cargo, and fink deps
//   node deps.mjs update   — update all deps to latest
//
// The fink crate dependency is pinned to a git tag in crate/Cargo.toml.
// This script queries the GitHub releases API to detect newer versions
// and can rewrite the tag in-place.

import { execSync } from 'child_process'
import fs from 'fs'

const CARGO_TOML = 'crate/Cargo.toml'
const FINK_REPO = 'fink-lang/fink'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim()
  } catch (e) {
    // Some commands (npm outdated) exit non-zero when deps are outdated
    if (e.stdout) return e.stdout.trim()
    // Return stderr as message if command not found / failed
    if (e.stderr) return e.stderr.trim()
    throw e
  }
}

/** Read the pinned fink tag from crate/Cargo.toml. */
function readFinkTag() {
  const toml = fs.readFileSync(CARGO_TOML, 'utf8')
  const m = toml.match(/fink\s*=\s*\{[^}]*tag\s*=\s*"([^"]+)"/)
  return m ? m[1] : null
}

/** Rewrite the fink tag in crate/Cargo.toml. */
function writeFinkTag(newTag) {
  let toml = fs.readFileSync(CARGO_TOML, 'utf8')
  toml = toml.replace(
    /(fink\s*=\s*\{[^}]*tag\s*=\s*")([^"]+)(")/,
    `$1${newTag}$3`,
  )
  fs.writeFileSync(CARGO_TOML, toml)
}

/** Query the latest release tag from a GitHub repo. */
async function latestGitHubTag(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.tag_name ?? null
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function check() {
  console.log('npm outdated:')
  const npmOut = run('npm outdated', { cwd: '.' })
  console.log(npmOut || '  all up to date')

  console.log('\ncargo outdated (crate/):')
  const cargoOut = run('cargo outdated', { cwd: 'crate' })
  console.log(cargoOut || '  all up to date')

  console.log('\nfink git dependency:')
  const pinned = readFinkTag()
  if (!pinned) {
    console.log('  could not read pinned tag from Cargo.toml')
    return
  }

  const latest = await latestGitHubTag(FINK_REPO)
  if (!latest) {
    console.log(`  ${pinned} (failed to query GitHub API)`)
  } else if (latest === pinned) {
    console.log(`  fink ${pinned} ✓`)
  } else {
    console.log(`  fink ${pinned} → ${latest} available`)
  }
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function update() {
  // 1. npm
  console.log('npm update:')
  console.log(run('npm update'))

  // 2. fink git tag
  console.log('\nfink git dependency:')
  const pinned = readFinkTag()
  const latest = await latestGitHubTag(FINK_REPO)

  if (!pinned) {
    console.log('  could not read pinned tag from Cargo.toml')
  } else if (!latest) {
    console.log(`  ${pinned} (failed to query GitHub API — skipping)`)
  } else if (latest === pinned) {
    console.log(`  fink ${pinned} ✓ (already latest)`)
  } else {
    writeFinkTag(latest)
    console.log(`  fink ${pinned} → ${latest}`)
  }

  // 3. cargo update
  console.log('\ncargo update (crate/):')
  console.log(run('cargo update', { cwd: 'crate' }))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cmd = process.argv[2]

switch (cmd) {
  case 'check':
    await check()
    break
  case 'update':
    await update()
    break
  default:
    console.error('Usage: node deps.mjs [check | update]')
    process.exit(1)
}
