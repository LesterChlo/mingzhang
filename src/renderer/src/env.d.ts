import type { MingZhangApi } from '../../shared/types'

declare global {
  interface Window {
    mz: MingZhangApi
  }
}

export {}
