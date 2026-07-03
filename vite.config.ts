import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';

let GIT_HASH = 'unknown';
try { GIT_HASH = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* no git */ }

const REQUIRED_ENV = [
  'VITE_VAPID_PUBLIC_KEY',
  'VITE_PUSH_RELAY_TOKEN',
  'VITE_PUSH_SUBS_PATH',
] as const;

export default defineConfig(({ command }) => {
  // Only enforce push config in CI — local builds can omit it (push features degrade gracefully).
  if (command === 'build' && process.env.CI === 'true') {
    const missing = REQUIRED_ENV.filter(key => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables:\n${missing.map(k => `  ${k}`).join('\n')}`);
    }
  }

  return {
    define: {
      __GIT_HASH__: JSON.stringify(GIT_HASH),
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
  };
});
