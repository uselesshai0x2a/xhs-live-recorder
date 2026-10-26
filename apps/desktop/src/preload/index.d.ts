import type { BrowserApi } from '../shared/browser'
import type { AppApi } from '../shared/app'
import type { TransportApi } from '../shared/query-error'
declare global {
  interface Window {
    recorder: TransportApi<AppApi>
    browser: TransportApi<BrowserApi>
  }
}
