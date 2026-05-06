import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,ts,tsx,md,mdx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        serif: ['var(--font-serif)'],
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        fg: 'var(--fg)',
        'fg-muted': 'var(--fg-muted)',
        'fg-subtle': 'var(--fg-subtle)',
        brand: 'var(--brand)',
        'brand-hover': 'var(--brand-hover)',
        'tag-tech': 'var(--tag-tech)',
        'tag-product': 'var(--tag-product)',
      },
      maxWidth: {
        content: 'var(--max-content)',
        wide: 'var(--max-wide)',
        page: 'var(--max-page)',
      },
      typography: () => ({
        DEFAULT: {
          css: {
            '--tw-prose-body': 'var(--fg)',
            '--tw-prose-headings': 'var(--fg)',
            '--tw-prose-lead': 'var(--fg-muted)',
            '--tw-prose-links': 'var(--brand)',
            '--tw-prose-bold': 'var(--fg)',
            '--tw-prose-code': 'var(--brand)',
            '--tw-prose-quotes': 'var(--fg-muted)',
            '--tw-prose-quote-borders': 'var(--border-strong)',
            '--tw-prose-borders': 'var(--border)',
            'h1, h2, h3, h4': { fontFamily: 'var(--font-serif)' },
            'code, pre': { fontFamily: 'var(--font-mono)' },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            code: {
              backgroundColor: 'var(--surface-2)',
              padding: '0.15em 0.4em',
              borderRadius: 'var(--radius-sm)',
              fontWeight: '400',
              fontSize: '0.875em',
              border: '1px solid var(--border)',
            },
            'pre code': {
              backgroundColor: 'transparent',
              padding: '0',
              borderRadius: '0',
              border: '0',
              fontSize: 'inherit',
              color: 'inherit',
            },
            'a code': { color: 'inherit' },
            maxWidth: 'none',
          },
        },
      }),
    },
  },
  plugins: [typography],
};
