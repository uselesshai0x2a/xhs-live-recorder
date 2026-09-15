export interface BrowserCandidate {
  keyWord: string
  userId: string | null
  name: string
  state: 'live' | 'offline' | 'unknown'
  roomId: string | null
  pageUrl: string | null
}

export interface BrowserEvidence {
  at: string
  kind: 'ready' | 'navigation' | 'query' | 'response' | 'error' | 'session' | 'visibility'
  message: string
}

export interface BrowserSnapshot {
  authVersion?: number
  cookieAvailable: boolean
  signedRequestObserved: boolean
  queryRunning: boolean
  foregroundUrl: string
  candidates: BrowserCandidate[]
  evidence: BrowserEvidence[]
}

export interface BrowserApi {
  snapshot(): Promise<BrowserSnapshot>
  open(url: string): Promise<void>
  search(keyWord: string): Promise<BrowserCandidate[]>
  showQueryPage(show: boolean): Promise<void>
  setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  subscribe(listener: (snapshot: BrowserSnapshot) => void): () => void
}
