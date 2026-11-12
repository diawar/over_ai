import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const miniAppProxy = {
  target: process.env.MINI_APP_PROXY_TARGET ?? 'http://127.0.0.1:8001',
  changeOrigin: false,
  configure(proxy) {
    proxy.on('proxyReq', (proxyRequest, request) => {
      const host = request.headers.host ?? ''
      const forwardedProtocol = request.headers['x-forwarded-proto']
      const protocol = typeof forwardedProtocol === 'string' ? forwardedProtocol.split(',')[0].trim() : 'http'
      const sameOrigin = request.headers.origin === `${protocol}://${host}`

      // preview-app only accepts loopback Host/Origin. Normalize a verified same-origin
      // request from the public reverse proxy, while preserving foreign Origins so its
      // existing CSRF guard continues to reject cross-site POSTs.
      proxyRequest.setHeader('host', 'localhost:5173')
      if (sameOrigin) proxyRequest.setHeader('origin', 'http://localhost:5173')
    })
  },
}

const proxy = {
  '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: true },
  '/catalog-preview': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: true },
  '/mini-app': miniAppProxy,
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy, allowedHosts: process.env.CLOUDFLARE_TUNNEL_HOST ? [process.env.CLOUDFLARE_TUNNEL_HOST] : [] },
  preview: { port: 4173, proxy, allowedHosts: process.env.CLOUDFLARE_TUNNEL_HOST ? [process.env.CLOUDFLARE_TUNNEL_HOST] : [] },
  test: { environment: 'jsdom', setupFiles: './src/test-setup.ts', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
})
