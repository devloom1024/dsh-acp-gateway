#!/usr/bin/env node
// Verify that the self-hosted ACP registry stays in sync with package.json.
//
// Checks:
//   1. registry.json is valid JSON and has at least one agent.
//   2. Every agent version matches package.json version.
//   3. Every npx distribution package is pinned to package.json name@version.
//   4. The icon referenced by the first agent exists in the repository.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'))
}

const pkg = readJson('package.json')
const registry = readJson('registry.json')
const errors = []

if (!Array.isArray(registry.agents) || registry.agents.length === 0) {
  errors.push('registry.json: "agents" must be a non-empty array')
}

for (const [index, agent] of (registry.agents || []).entries()) {
  const where = `registry.json agents[${index}]`

  if (agent.version !== pkg.version) {
    errors.push(`${where}.version (${agent.version}) does not match package.json version (${pkg.version})`)
  }

  const npx = agent.distribution && agent.distribution.npx
  if (npx) {
    const expected = `${pkg.name}@${pkg.version}`
    if (npx.package !== expected) {
      errors.push(`${where}.distribution.npx.package should be "${expected}", got "${npx.package}"`)
    }
  }

  if (index === 0 && agent.icon) {
    // Only check repository-local icons referenced through the raw GitHub URL.
    const match = agent.icon.match(/\/main\/(.+)$/)
    if (match && !existsSync(resolve(root, match[1]))) {
      errors.push(`${where}.icon references missing file "${match[1]}"`)
    }
  }
}

if (errors.length > 0) {
  console.error('Registry check failed:')
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

console.log(`registry check ok: ${pkg.name}@${pkg.version} matches registry.json`)
