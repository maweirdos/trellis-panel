/** @type {import('tailwindcss').Config} */

// 上游令牌包 label 色系 8 族 × 5 槽位（bg/strong/hover/icon/text/border→截取常用 5 槽）
function labelColorSet() {
  const families = ['indigo', 'emerald', 'grey', 'crimson', 'yellow', 'orange', 'pink', 'purple']
  const slots = { '': 'bg', '-bg': 'bg', '-strong': 'bg-strong', '-hover': 'hover', '-icon': 'icon', '-text': 'text', '-border': 'border' }
  const out = {}
  for (const fam of families) {
    for (const [suffix, token] of Object.entries(slots)) {
      if (suffix === '-bg') continue
      out[`label-${fam}${suffix}`] = `var(--my-label-${fam}-${token})`
    }
  }
  return out
}

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
        },
        // 外壳语义色板（值见 src/renderer/src/my/my-tokens.css，
        // 随 [data-my-theme] 浅/深切换；不支持 alpha 修饰符）
        my: {
          canvas: 'var(--my-bg-canvas)',
          'surface-1': 'var(--my-bg-surface-1)',
          'surface-2': 'var(--my-bg-surface-2)',
          'layer-1': 'var(--my-bg-layer-1)',
          'layer-1-hover': 'var(--my-bg-layer-1-hover)',
          'layer-1-active': 'var(--my-bg-layer-1-active)',
          'layer-1-selected': 'var(--my-bg-layer-1-selected)',
          'layer-2': 'var(--my-bg-layer-2)',
          'layer-2-hover': 'var(--my-bg-layer-2-hover)',
          'layer-2-active': 'var(--my-bg-layer-2-active)',
          'layer-2-selected': 'var(--my-bg-layer-2-selected)',
          'layer-3': 'var(--my-bg-layer-3)',
          'layer-3-hover': 'var(--my-bg-layer-3-hover)',
          'layer-3-active': 'var(--my-bg-layer-3-active)',
          'layer-3-selected': 'var(--my-bg-layer-3-selected)',
          'layer-transparent': 'var(--my-bg-layer-transparent)',
          'layer-transparent-hover': 'var(--my-bg-layer-transparent-hover)',
          'layer-transparent-active': 'var(--my-bg-layer-transparent-active)',
          'layer-transparent-selected': 'var(--my-bg-layer-transparent-selected)',
          'layer-disabled': 'var(--my-bg-layer-disabled)',
          accent: 'var(--my-bg-accent-primary)',
          'accent-hover': 'var(--my-bg-accent-primary-hover)',
          'accent-active': 'var(--my-bg-accent-primary-active)',
          'accent-subtle': 'var(--my-bg-accent-subtle)',
          'accent-subtle-hover': 'var(--my-bg-accent-subtle-hover)',
          danger: 'var(--my-bg-danger-primary)',
          'danger-hover': 'var(--my-bg-danger-primary-hover)',
          'danger-subtle': 'var(--my-bg-danger-subtle)',
          'danger-subtle-hover': 'var(--my-bg-danger-subtle-hover)',
          warning: 'var(--my-bg-warning-primary)',
          'warning-subtle': 'var(--my-bg-warning-subtle)',
          success: 'var(--my-bg-success-primary)',
          'success-subtle': 'var(--my-bg-success-subtle)',
          info: 'var(--my-bg-info-primary)',
          'info-subtle': 'var(--my-bg-info-subtle)',
          backdrop: 'var(--my-bg-backdrop)',
          primary: 'var(--my-txt-primary)',
          secondary: 'var(--my-txt-secondary)',
          tertiary: 'var(--my-txt-tertiary)',
          placeholder: 'var(--my-txt-placeholder)',
          disabled: 'var(--my-txt-disabled)',
          'accent-text': 'var(--my-txt-accent-primary)',
          'accent-text-secondary': 'var(--my-txt-accent-secondary)',
          'on-color': 'var(--my-txt-on-color)',
          'success-text': 'var(--my-txt-success-primary)',
          'warning-text': 'var(--my-txt-warning-primary)',
          'danger-text': 'var(--my-txt-danger-primary)',
          'info-text': 'var(--my-txt-info-primary)',
          'icon-primary': 'var(--my-txt-icon-primary)',
          'icon-secondary': 'var(--my-txt-icon-secondary)',
          'icon-tertiary': 'var(--my-txt-icon-tertiary)',
          'icon-placeholder': 'var(--my-txt-icon-placeholder)',
          'icon-accent': 'var(--my-txt-icon-accent-primary)',
          'icon-on-color': 'var(--my-txt-icon-on-color)',
          line: 'var(--my-border-subtle)',
          'line-1': 'var(--my-border-subtle-1)',
          'line-strong': 'var(--my-border-strong)',
          'line-strong-1': 'var(--my-border-strong-1)',
          'line-accent': 'var(--my-border-accent-strong)',
          'line-accent-subtle': 'var(--my-border-accent-subtle)',
          'line-danger': 'var(--my-border-danger-strong)',
          'line-success': 'var(--my-border-success-strong)',
          'line-warning': 'var(--my-border-warning-strong)',
          'line-info': 'var(--my-border-info-strong)',
          urgent: 'var(--my-priority-urgent)',
          high: 'var(--my-priority-high)',
          medium: 'var(--my-priority-medium)',
          low: 'var(--my-priority-low)',
          none: 'var(--my-priority-none)',
          unlit: 'var(--my-priority-unlit)',
          ...labelColorSet()
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
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)'
      }
    }
  },
  plugins: []
}
