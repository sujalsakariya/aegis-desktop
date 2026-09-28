import { createRequire } from 'node:module'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiUrl = env.LICENSE_API_URL || 'http://localhost:3001'

  // electron/license.js and electron/updates.js read these at module load in the
  // MAIN process. A root-level `define` never reaches that bundle, so the keys
  // arrived as undefined and every signature check failed in a packaged build.
  // They have to be injected into the main and preload configs directly.
  const mainDefine = {
    'process.env.LICENSE_API_URL': JSON.stringify(apiUrl),
    'process.env.LICENSE_PUBLIC_KEY': JSON.stringify(env.LICENSE_PUBLIC_KEY || ''),
    'process.env.DEFINITION_SIGNING_PUBLIC_KEY': JSON.stringify(env.DEFINITION_SIGNING_PUBLIC_KEY || ''),
    'process.env.MIN_APP_VERSION': JSON.stringify(env.MIN_APP_VERSION || pkg.version),
  }

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __API_URL__: JSON.stringify(apiUrl),
    },
    plugins: [
      react(),
      tailwindcss(),
      electron({
        main: {
          entry: 'electron/main.js',
          vite: { define: mainDefine },
        },
        preload: {
          input: 'electron/preload.js',
          vite: { define: mainDefine },
        },
      }),
    ],
  }
})
