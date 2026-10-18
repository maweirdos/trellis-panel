/** @type {import('tailwindcss').Config} */

// label 色系 8 族 × 5 槽位（bg/strong/hover/icon/text/border）
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
        // 外壳语义色板（值见 src/renderer/src/my/my-tokens.css，
        // 随 [data-my-theme] 浅/深切换；不支持 alpha 修饰符）
        my: {
          shell: 'var(--my-bg-shell)',
          sidebar: 'var(--my-bg-sidebar)',
          'shell-line': 'var(--my-border-shell)',
          'navigation-hover': 'var(--my-bg-navigation-hover)',
          'navigation-selected': 'var(--my-bg-navigation-selected)',
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
          'on-accent': 'var(--my-txt-on-accent)',
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
      fontFamily: { sans: ['var(--my-font-sans)'], mono: ['var(--my-font-mono)'] },
      fontWeight: { normal: 'var(--my-weight-normal)', medium: 'var(--my-weight-medium)', semibold: 'var(--my-weight-semibold)', bold: 'var(--my-weight-semibold)' },
      animation: {
        'fade-in': 'fadeIn var(--my-motion-fast) var(--my-ease-out)',
        'slide-in': 'slideIn var(--my-motion-normal) var(--my-ease-out)'
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
        xs: 'var(--my-shadow-raised-100)', sm: 'var(--my-shadow-raised-100)',
        DEFAULT: 'var(--my-shadow-raised-100)', md: 'var(--my-shadow-raised-200)',
        lg: 'var(--my-shadow-raised-300)', xl: 'var(--my-shadow-overlay-100)', '2xl': 'var(--my-shadow-overlay-200)'
      },
      transitionDuration: { DEFAULT: 'var(--my-motion-fast)', 150: 'var(--my-motion-fast)', 200: 'var(--my-motion-normal)', 300: 'var(--my-motion-slow)' },
      transitionTimingFunction: { DEFAULT: 'var(--my-ease-out)', out: 'var(--my-ease-out)', 'in-out': 'var(--my-ease-standard)' },
      // The same variables drive existing utilities and every future UI consumer.
      spacing: {
        '0.5': 'var(--my-space-2)', 1: 'var(--my-space-4)', '1.5': 'var(--my-space-6)',
        2: 'var(--my-space-8)', '2.5': 'var(--my-space-10)', 3: 'var(--my-space-12)',
        '3.5': 'var(--my-space-14)', 4: 'var(--my-space-16)', 5: 'var(--my-space-20)',
        6: 'var(--my-space-24)', 7: 'var(--my-space-28)', 8: 'var(--my-space-32)',
        9: 'var(--my-space-36)', 10: 'var(--my-space-40)', 11: 'var(--my-space-44)',
        12: 'var(--my-space-48)', 14: 'var(--my-space-56)', 16: 'var(--my-space-64)',
        ...Object.fromEntries([20,24,28,32,36,40,44,48,52,56,60,64,72,80,96].map(step=>[step, `var(--my-space-${step * 4})`])),
        'my-header': 'var(--my-workspace-header-height)', 'my-icon': 'var(--my-icon-control-size)',
        'my-control': 'var(--my-control-height)', 'my-field': 'var(--my-field-height)',
        'my-page': 'var(--my-page-inset)'
      },
      fontSize: Object.fromEntries(['2xs', 'xs', 'sm', 'md', 'lg', 'title', 'xl', 'display'].map((size) => [
        `my-${size}`, [`var(--my-text-${size})`, {
          lineHeight: ['lg', 'title', 'xl', 'display'].includes(size) ? 'var(--my-line-heading)' : 'var(--my-line-ui)',
          letterSpacing: ['title', 'xl', 'display'].includes(size) ? 'var(--my-tracking-tight)' : 'var(--my-tracking-normal)'
        }]
      ])),
      lineHeight: { normal: 'var(--my-line-ui)', tight: 'var(--my-line-tight)', relaxed: 'var(--my-line-document)', 'my-ui': 'var(--my-line-ui)', 'my-chat': 'var(--my-line-chat)', 'my-document': 'var(--my-line-document)' },
      borderRadius: Object.fromEntries([
        ...['xs', 'sm', 'inset', 'md', 'lg', 'xl', 'menu', '3xl', '4xl'].map((size) => [`my-${size}`, `var(--my-radius-${size})`]),
        ...[['none','none'],['sm','sm'],['DEFAULT','inset'],['md','md'],['lg','lg'],['xl','xl'],['2xl','3xl'],['3xl','4xl'],['full','full']].map(([name, token]) => [name, `var(--my-radius-${token})`])
      ]),
      zIndex: { 'my-modal': 'var(--my-z-modal)', 'my-menu': 'var(--my-z-menu)', 'my-tooltip': 'var(--my-z-tooltip)' }
    }
  },
  plugins: []
}
