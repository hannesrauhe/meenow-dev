import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';

const GIT_HASH = execSync('git rev-parse --short HEAD').toString().trim();

export default defineConfig({
  base: '/',
  define: {
    __GIT_HASH__: JSON.stringify(GIT_HASH),
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
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
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}'],
      },
    }),
  ],
});
