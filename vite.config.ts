import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

const removePlatformFromRollupOptions = () => ({
  name: 'remove-platform-from-rollup-options',
  // CRX プラグインが注入する platform は Rollup 入力オプションに存在しないため除去する。
  configResolved(config: {
    build?: {
      rollupOptions?: Record<string, unknown>
      rolldownOptions?: Record<string, unknown>
    }
    environments?: Record<
      string,
      {
        build?: {
          rollupOptions?: Record<string, unknown>
          rolldownOptions?: Record<string, unknown>
        }
      }
    >
  }) {
    const stripPlatform = (options?: Record<string, unknown>) => {
      if (!options) return
      if ('platform' in options) {
        delete options.platform
      }
    }

    stripPlatform(config.build?.rollupOptions)
    stripPlatform(config.build?.rolldownOptions)

    if (!config.environments) return
    for (const envConfig of Object.values(config.environments)) {
      stripPlatform(envConfig.build?.rollupOptions)
      stripPlatform(envConfig.build?.rolldownOptions)
    }
  },
})

const buildManifest = (mode: string) => {
  const env = loadEnv(mode, process.cwd(), '')
  const clientId = env.MTH_GOOGLE_OAUTH_CLIENT_ID || env.VITE_GOOGLE_OAUTH_CLIENT_ID

  if (!clientId) {
    console.warn('MTH_GOOGLE_OAUTH_CLIENT_ID is not set. Using manifest.json as-is.')
    return manifest
  }

  return {
    ...manifest,
    oauth2: {
      ...(manifest.oauth2 ?? {}),
      client_id: clientId,
    },
  }
}

export default defineConfig(({ mode }) => ({
  server: {
    cors: true,
    strictPort: true,
    port: 5173,
  },
  plugins: [
    react(),
    crx({ manifest: buildManifest(mode) }),
    removePlatformFromRollupOptions(),
  ],
}))