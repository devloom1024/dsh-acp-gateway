#!/usr/bin/env node
/**
 * Generate the portable-bundle vendor anchor `vendor/dsh-app/package.json`.
 *
 * `dsh-acp-server` uses `dshInstallAnchor()` to locate a `@deepseek-ai/dsh`
 * app whose dependency closure seeds the profile module farm
 * (`healProfilesModuleFallback`). When the server runs from its own
 * node_modules (npx install, or the offline archive) there is no installed
 * dsh app, so this anchor stands in for one: its `dependencies` list covers
 * every top-level package in the bundled node_modules, and the farm builder
 * resolves each one from this bundle. Missing entries are skipped by the
 * farm builder, so a superset list is safe.
 *
 * Usage (after the closure is present in ./node_modules):
 *   npm run vendor
 *
 * `DSH_VENDOR_MODULES` overrides the directory scanned (used by
 * scripts/package-offline.sh to generate the anchor from the staged closure).
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modulesDir = process.env.DSH_VENDOR_MODULES || join(root, 'node_modules')
const outFile = join(root, 'vendor', 'dsh-app', 'package.json')

const deps = {}
for (const name of readdirSync(modulesDir)) {
  if (name.startsWith('@')) {
    for (const sub of readdirSync(join(modulesDir, name))) {
      deps[`${name}/${sub}`] = '0.0.0'
    }
  } else {
    deps[name] = '0.0.0'
  }
}

const manifest = {
  name: '@deepseek-ai/dsh',
  version: require(join(root, 'package.json')).version,
  private: true,
  dependencies: deps,
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n')
console.log(`vendor anchor written: ${outFile} (${Object.keys(deps).length} packages)`)
