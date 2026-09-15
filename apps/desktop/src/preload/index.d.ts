import type { BrowserApi } from '../shared/browser'
import type { AppApi } from '../shared/app'
declare global {
  interface Window {
    recorder: AppApi
    browser: BrowserApi
  }
}
