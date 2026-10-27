import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectRuntimePackages } from './package-runtime-deps.mjs'

/** Check that appRoot's required runtime dependency closure is present inside appRoot. */
export function checkPackageRuntime(appRoot) {
  const packages = collectRuntimePackages(appRoot)
  return { appRoot: path.resolve(appRoot), packages }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const appRoot = path.resolve(process.cwd(), process.argv[2] ?? '.scratch/package-app')
  try {
    const result = checkPackageRuntime(appRoot)
    console.log(`Runtime closure OK: ${result.packages.length} packages in ${result.appRoot}`)
  } catch (error) {
    console.error(`Runtime closure check failed: ${error.message}`)
    process.exitCode = 1
  }
}
