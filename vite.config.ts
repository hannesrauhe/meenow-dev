import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';

let GIT_HASH = 'unknown';
try { GIT_HASH = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* no git */ }

// Local dev against the PHP backend: run `php -S localhost:8080
// server/scripts/router.php` (from the repo root, needs server/vendor +
// server/config) and these paths get proxied like production's .htaccess does.
const PHP_BACKEND = 'http://localhost:8080';

export default defineConfig(() => ({
  define: {
    __GIT_HASH__: JSON.stringify(GIT_HASH),
  },
  server: {
    proxy: {
      '/api': PHP_BACKEND,
      '/oauth/token': PHP_BACKEND,
      '/push': PHP_BACKEND,
      '/xkcd.json': PHP_BACKEND,
      '/health': PHP_BACKEND,
    },
  },
    plugins: [
      VitePWA({
        registerType: 'prompt',
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        manifest: {
          id: '/',
          name: 'meenow',
          short_name: 'meenow',
          description: 'Daily spontaneous photo sharing with friends via Pixelfed',
          theme_color: '#FDFBF7',
          background_color: '#FDFBF7',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          icons: [
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png}'],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
}));
