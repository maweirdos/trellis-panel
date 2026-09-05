/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: 'rgb(var(--ink-950-rgb) / <alpha-value>)',
          900: 'rgb(var(--ink-900-rgb) / <alpha-value>)',
          850: 'rgb(var(--ink-850-rgb) / <alpha-value>)',
          800: 'rgb(var(--ink-800-rgb) / <alpha-value>)',
          750: 'rgb(var(--ink-750-rgb) / <alpha-value>)',
          700: 'rgb(var(--ink-700-rgb) / <alpha-value>)',
          600: 'rgb(var(--ink-600-rgb) / <alpha-value>)',
          500: 'rgb(var(--ink-500-rgb) / <alpha-value>)',
          400: 'rgb(var(--ink-400-rgb) / <alpha-value>)'
        },
        mist: {
          50: 'rgb(var(--mist-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--mist-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--mist-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--mist-300-rgb) / <alpha-value>)',
          400: 'rgb(var(--mist-400-rgb) / <alpha-value>)',
          500: 'rgb(var(--mist-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--mist-600-rgb) / <alpha-value>)'
        },
        leaf: {
          DEFAULT: 'rgb(var(--leaf-rgb) / <alpha-value>)',
          soft: 'rgb(var(--leaf-soft-rgb) / <alpha-value>)',
          dim: 'rgb(var(--leaf-dim-rgb) / <alpha-value>)',
          deep: 'rgb(var(--leaf-deep-rgb) / <alpha-value>)'
        }
      },
      fontFamily: {
        sans: [
          '"Segoe UI Variable Display"',
          '"Segoe UI"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif'
        ],
        mono: ['"Cascadia Code"', '"JetBrains Mono"', 'Consolas', 'monospace']
      },
      animation: {
        'fade-in': 'fadeIn .18s ease-out',
        'slide-in': 'slideIn .22s cubic-bezier(.2,.8,.3,1)'
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        slideIn: {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'translateX(0)' }
        }
      }
    }
  },
  plugins: []
}
