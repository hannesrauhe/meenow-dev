/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,html}',
  ],
  theme: {
    extend: {
      colors: {
        cream: '#FDFBF7',
        ink: '#2D2D2D',
        'ink-muted': '#5A5A5A',
        gold: '#C9A96E',
        'gold-light': '#E8D5B0',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      minHeight: {
        dvh: '100dvh',
      },
    },
  },
  plugins: [],
};
