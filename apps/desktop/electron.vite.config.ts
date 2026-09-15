import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: ['@xhs-live-recorder/core'] } } },
  preload: {},
  renderer: {
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      hmr: { host: '127.0.0.1', clientPort: 5173 }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue(),
      {
        name: 'local-development-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace(
            "default-src 'self';",
            "default-src 'self'; connect-src 'self' ws://127.0.0.1:5173;"
          )
        }
      }
    ]
  }
})
