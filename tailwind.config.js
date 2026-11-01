/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    // One type scale. Anything outside it is a mistake.
    fontSize: {
      xs: ['12px', { lineHeight: '16px' }],
      sm: ['14px', { lineHeight: '20px' }],
      base: ['16px', { lineHeight: '24px' }],
      '2xl': ['24px', { lineHeight: '32px' }],
      '4xl': ['40px', { lineHeight: '44px', letterSpacing: '-0.02em' }],
    },
    // One radius system: card 24 > inner 16 > control 12 (each step is the parent minus its 4-8px inset).
    borderRadius: {
      none: '0',
      full: '9999px',
      card: '24px',
      inner: '16px',
      control: '12px',
      badge: '8px',
    },
    extend: {
      colors: {
        brand: '#1083FF',
        up: '#97CB3D',
        down: '#F44708',
        // Depth: each nesting level is one step lighter. No borders, no transparency.
        canvas: '#050F20',
        card: '#0C1B35',
        raised: '#13264A',
        hover: '#1B3463',
      },
      fontFamily: {
        sans: ['Akt', 'Manrope', 'ui-sans-serif', 'sans-serif'],
        num: ['Manrope', 'Akt', 'ui-sans-serif', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
