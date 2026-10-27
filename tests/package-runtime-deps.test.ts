import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectRuntimePackages, stageRuntimeApp } from '../scripts/package-runtime-deps.mjs'

let tempRoot = ''

function makeProject() {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mz-runtime-closure-'))
  return tempRoot
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writePackage(projectRoot: string, relativePath: string, manifest: Record<string, unknown>) {
  const packageDir = path.join(projectRoot, relativePath)
  writeJson(path.join(packageDir, 'package.json'), manifest)
  return packageDir
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('manifest-resolved runtime dependency staging', () => {
  it('stages the production closure and out while omitting undeclared and dev-only packages', () => {
    const projectRoot = makeProject()
    writeJson(path.join(projectRoot, 'package.json'), {
      name: 'synthetic-app', version: '3.4.5', type: 'module', main: 'out/main.js', license: 'MIT',
      productName: 'Synthetic', description: 'keep metadata',
      dependencies: { alpha: '1.0.0' }, devDependencies: { 'dev-only': '1.0.0' },
      scripts: { build: 'must not ship' }, build: { appId: 'must not ship' },
    })
    writePackage(projectRoot, 'node_modules/alpha', { name: 'alpha', version: '1.0.0', dependencies: { beta: '1.0.0' } })
    writePackage(projectRoot, 'node_modules/beta', { name: 'beta', version: '1.0.0' })
    writePackage(projectRoot, 'node_modules/dev-only', { name: 'dev-only', version: '1.0.0' })
    writePackage(projectRoot, 'node_modules/undeclared', { name: 'undeclared', version: '1.0.0' })
    mkdirSync(path.join(projectRoot, 'out'), { recursive: true })
    writeFileSync(path.join(projectRoot, 'out/main.js'), 'synthetic entry')

    const packages = collectRuntimePackages(projectRoot)
    expect(packages.map((pkg: { relativePath: string }) => pkg.relativePath).sort()).toEqual([
      'node_modules/alpha', 'node_modules/beta',
    ])
    expect(packages.every((pkg: { source: string }) => path.isAbsolute(pkg.source))).toBe(true)

    const staged = path.join(projectRoot, '.scratch', 'package-app')
    stageRuntimeApp(projectRoot, staged)
    const stagedManifest = JSON.parse(readFileSync(path.join(staged, 'package.json'), 'utf8'))
    expect(stagedManifest).toMatchObject({
      name: 'synthetic-app', version: '3.4.5', type: 'module', main: 'out/main.js',
      license: 'MIT', productName: 'Synthetic', dependencies: { alpha: '1.0.0' },
    })
    expect(stagedManifest).not.toHaveProperty('devDependencies')
    expect(stagedManifest).not.toHaveProperty('scripts')
    expect(stagedManifest).not.toHaveProperty('build')
    expect(existsSync(path.join(staged, 'out/main.js'))).toBe(true)
    expect(existsSync(path.join(staged, 'node_modules/alpha/package.json'))).toBe(true)
    expect(existsSync(path.join(staged, 'node_modules/beta/package.json'))).toBe(true)
    expect(existsSync(path.join(staged, 'node_modules/dev-only'))).toBe(false)
    expect(existsSync(path.join(staged, 'node_modules/undeclared'))).toBe(false)
    expect(collectRuntimePackages(staged)).toHaveLength(2)
  })

  it('rejects missing required dependencies but skips missing optional dependencies', () => {
    const projectRoot = makeProject()
    writeJson(path.join(projectRoot, 'package.json'), {
      dependencies: { 'required-missing': '1.0.0', 'optional-soft': '1.0.0' },
      optionalDependencies: { 'optional-soft': '1.0.0' },
    })
    expect(() => collectRuntimePackages(projectRoot)).toThrow(/required-missing/)

    writeJson(path.join(projectRoot, 'package.json'), {
      dependencies: { 'optional-soft': '1.0.0' },
      optionalDependencies: { 'optional-soft': '1.0.0' },
    })
    expect(collectRuntimePackages(projectRoot)).toEqual([])
  })

  it('does not resolve dependencies from node_modules outside appRoot', () => {
    const sandbox = makeProject()
    const projectRoot = path.join(sandbox, 'app')
    writeJson(path.join(projectRoot, 'package.json'), { dependencies: { external: '1.0.0' } })
    writePackage(sandbox, 'node_modules/external', { name: 'external', version: '1.0.0' })
    expect(() => collectRuntimePackages(projectRoot)).toThrow(/external/)
  })

  it('preserves nested versions, scoped paths, aliases, and installed required peers', () => {
    const projectRoot = makeProject()
    writeJson(path.join(projectRoot, 'package.json'), {
      dependencies: { '@scope/one': '1.0.0', '@scope/two': '1.0.0', 'renamed-edge': 'npm:actual-name@1.0.0' },
    })
    writePackage(projectRoot, 'node_modules/@scope/one', {
      name: '@scope/one', version: '1.0.0', dependencies: { lib: '^1' },
      peerDependencies: { 'peer-lib': '*', 'optional-peer': '*' },
      peerDependenciesMeta: { 'optional-peer': { optional: true } },
    })
    writePackage(projectRoot, 'node_modules/@scope/one/node_modules/lib', { name: 'lib', version: '1.1.0' })
    writePackage(projectRoot, 'node_modules/@scope/two', { name: '@scope/two', version: '1.0.0', dependencies: { lib: '^2' } })
    writePackage(projectRoot, 'node_modules/@scope/two/node_modules/lib', { name: 'lib', version: '2.2.0' })
    writePackage(projectRoot, 'node_modules/renamed-edge', { name: 'actual-name', version: '1.0.0' })
    writePackage(projectRoot, 'node_modules/peer-lib', { name: 'peer-lib', version: '1.2.0' })

    const paths = collectRuntimePackages(projectRoot).map((pkg: { relativePath: string }) => pkg.relativePath).sort()
    expect(paths).toEqual([
      'node_modules/@scope/one', 'node_modules/@scope/one/node_modules/lib',
      'node_modules/@scope/two', 'node_modules/@scope/two/node_modules/lib',
      'node_modules/peer-lib', 'node_modules/renamed-edge',
    ])
  })
})
