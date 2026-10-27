import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_STAGING_RELATIVE_PATH = path.join('.scratch', 'package-app')

const APP_MANIFEST_FIELDS = [
  'name', 'version', 'description', 'author', 'license', 'repository', 'homepage',
  'main', 'type', 'engines', 'productName', 'private', 'dependencies',
  'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
]

function readManifest(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read package manifest at ${manifestPath}: ${error.message}`, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid package manifest at ${manifestPath}: expected an object`)
  }
  return parsed
}

function dependencyNames(manifest, packageDir) {
  const required = new Set()
  const optional = new Set()
  const addNames = (target, value, field) => {
    if (value === undefined) return
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid ${field} in ${path.join(packageDir, 'package.json')}`)
    }
    for (const name of Object.keys(value)) target.add(name)
  }

  addNames(required, manifest.dependencies, 'dependencies')
  addNames(required, manifest.peerDependencies, 'peerDependencies')
  addNames(optional, manifest.optionalDependencies, 'optionalDependencies')
  const peerMeta = manifest.peerDependenciesMeta ?? {}
  if (!peerMeta || typeof peerMeta !== 'object' || Array.isArray(peerMeta)) {
    throw new Error(`Invalid peerDependenciesMeta in ${path.join(packageDir, 'package.json')}`)
  }
  for (const [name, metadata] of Object.entries(peerMeta)) {
    if (metadata?.optional === true) optional.add(name)
  }
  for (const name of optional) required.delete(name)
  return { required: [...required], optional: [...optional] }
}

function packageNameParts(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0')) {
    throw new Error(`Invalid runtime dependency name: ${String(name)}`)
  }
  const parts = name.split('/')
  if (parts.length > 2 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid runtime dependency name: ${name}`)
  }
  if (parts.length === 2 && !parts[0].startsWith('@')) {
    throw new Error(`Invalid runtime dependency name: ${name}`)
  }
  return parts
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolvePackage(importerDir, edgeName, appRoot) {
  const parts = packageNameParts(edgeName)
  let cursor = importerDir
  while (isWithin(appRoot, cursor)) {
    const candidate = path.join(cursor, 'node_modules', ...parts)
    let stats
    try {
      stats = fs.lstatSync(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    if (stats) {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Runtime dependency ${JSON.stringify(edgeName)} resolves to a non-directory or link: ${candidate}`)
      }
      const manifestPath = path.join(candidate, 'package.json')
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`Runtime dependency ${JSON.stringify(edgeName)} has no package.json at ${candidate}`)
      }
      return candidate
    }
    if (cursor === appRoot) break
    const parent = path.dirname(cursor)
    if (parent === cursor || !isWithin(appRoot, parent)) break
    cursor = parent
  }
  return null
}

/** Resolve the app's runtime dependency closure from package manifests and on-disk package paths. */
export function collectRuntimePackages(projectRoot) {
  const appRoot = fs.realpathSync(path.resolve(projectRoot))
  const rootManifest = readManifest(appRoot)
  const selected = new Map()
  const visitedRealPaths = new Set([fs.realpathSync(appRoot)])
  const pending = [{ source: appRoot, manifest: rootManifest }]

  for (let index = 0; index < pending.length; index += 1) {
    const importer = pending[index]
    const { required, optional } = dependencyNames(importer.manifest, importer.source)
    for (const edgeName of required) {
      const source = resolvePackage(importer.source, edgeName, appRoot)
      if (!source) {
        throw new Error(`Missing required runtime dependency ${JSON.stringify(edgeName)} declared by ${path.join(importer.source, 'package.json')}`)
      }
      addPackage(source, edgeName, importer.source)
    }
    for (const edgeName of optional) {
      const source = resolvePackage(importer.source, edgeName, appRoot)
      if (source) addPackage(source, edgeName, importer.source)
    }
  }

  function addPackage(source, edgeName, importerDir) {
    const relative = path.relative(appRoot, source)
    if (!isWithin(appRoot, source) || !relative || path.isAbsolute(relative)) {
      throw new Error(`Resolved runtime dependency ${JSON.stringify(edgeName)} outside app root from ${importerDir}`)
    }
    const relativePath = relative.split(path.sep).join('/')
    if (!relativePath.startsWith('node_modules/')) {
      throw new Error(`Resolved runtime dependency ${JSON.stringify(edgeName)} outside node_modules: ${relativePath}`)
    }
    if (!selected.has(relativePath)) selected.set(relativePath, { source, relativePath })
    const canonical = fs.realpathSync(source)
    if (visitedRealPaths.has(canonical)) return
    visitedRealPaths.add(canonical)
    pending.push({ source, manifest: readManifest(source) })
  }

  return [...selected.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function assertSafeFreshStagingTarget(projectRoot, targetRoot) {
  const expected = path.resolve(projectRoot, APP_STAGING_RELATIVE_PATH)
  const requested = path.resolve(targetRoot)
  if (path.relative(expected, requested) !== '') {
    throw new Error(`Staging target must be exactly ${expected}; received ${requested}`)
  }
  const scratchDir = path.dirname(expected)
  if (fs.existsSync(scratchDir)) {
    const scratchStats = fs.lstatSync(scratchDir)
    if (scratchStats.isSymbolicLink() || !scratchStats.isDirectory()) {
      throw new Error(`Refusing unsafe staging parent: ${scratchDir}`)
    }
  }
  if (fs.existsSync(expected)) {
    const targetStats = fs.lstatSync(expected)
    if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
      throw new Error(`Refusing unsafe staging target: ${expected}`)
    }
    throw new Error(`Staging target already exists; refusing to clear it: ${expected}`)
  }
}

function isPrivateOrGeneratedEntry(name) {
  return /^\.env(?:\.|$)/u.test(name) || name === '.npmrc' || name === '.package-lock.json'
}

function copyTreeWithoutNestedModules(source, destination) {
  const stats = fs.lstatSync(source)
  if (stats.isSymbolicLink()) throw new Error(`Refusing to copy a symlink while staging: ${source}`)
  if (!stats.isDirectory()) {
    if (!stats.isFile()) throw new Error(`Unsupported file type while staging: ${source}`)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
    return
  }
  fs.mkdirSync(destination, { recursive: true })
  for (const name of fs.readdirSync(source).sort()) {
    if (name === 'node_modules' || isPrivateOrGeneratedEntry(name)) continue
    copyTreeWithoutNestedModules(path.join(source, name), path.join(destination, name))
  }
}

function sanitizedAppManifest(manifest) {
  const result = {}
  for (const field of APP_MANIFEST_FIELDS) {
    if (Object.hasOwn(manifest, field)) result[field] = manifest[field]
  }
  return result
}

/** Copy out/ and only the manifest-resolved runtime packages into the fixed staging app. */
export function stageRuntimeApp(projectRoot, targetRoot) {
  const appRoot = fs.realpathSync(path.resolve(projectRoot))
  const expectedTarget = path.resolve(appRoot, APP_STAGING_RELATIVE_PATH)
  assertSafeFreshStagingTarget(appRoot, targetRoot)
  const manifest = readManifest(appRoot)
  const packages = collectRuntimePackages(appRoot)
  const outDir = path.join(appRoot, 'out')
  if (!fs.existsSync(outDir) || !fs.lstatSync(outDir).isDirectory()) {
    throw new Error(`Build output directory is missing: ${outDir}`)
  }

  fs.mkdirSync(path.dirname(expectedTarget), { recursive: true })
  fs.mkdirSync(expectedTarget, { recursive: false })
  copyTreeWithoutNestedModules(outDir, path.join(expectedTarget, 'out'))
  fs.writeFileSync(path.join(expectedTarget, 'package.json'), `${JSON.stringify(sanitizedAppManifest(manifest), null, 2)}\n`)
  for (const item of packages) {
    copyTreeWithoutNestedModules(item.source, path.join(expectedTarget, ...item.relativePath.split('/')))
  }
  return packages
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url))
  const targetRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(projectRoot, APP_STAGING_RELATIVE_PATH)
  const packages = stageRuntimeApp(projectRoot, targetRoot)
  console.log(`Staged ${packages.length} runtime packages at ${targetRoot}`)
}
