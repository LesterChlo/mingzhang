import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: 'src/main/index.ts', formats: ['es'] } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: 'src/preload/index.ts', formats: ['cjs'] } }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()]
  }
})
