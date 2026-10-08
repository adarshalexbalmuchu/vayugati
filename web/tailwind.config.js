/** @type {import('tailwindcss').Config} */
//
// Vayu Gati design tokens, expressed as Tailwind theme extensions.
// This is the ONE place raw brand colour values live for the web app; keep it
// in sync with web/src/design/tokens.ts (used where Tailwind classes can't
// reach — inline SVG, chart/map code). See docs/DESIGN_SYSTEM.md.
//
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // brand: kept as an alias of `ink` so existing `bg-brand-*` usage across
        // the app automatically picks up the new Microsoft 365-style identity
        // (dark brown / cream) instead of the old indigo placeholder.
        brand: {
          50: '#F6EFE4',
          100: '#EDE0CB',
          200: '#DEC7A0',
          300: '#C9A876',
          400: '#A9814F',
          500: '#8A6238',
          600: '#6B4A2A',
          700: '#422B1C',
          800: '#341F14',
          900: '#241109',
        },
        // ink: the primary dark-brown brand ramp (#422B1C at 700)
        ink: {
          50: '#F6EFE4',
          100: '#EDE0CB',
          200: '#DEC7A0',
          300: '#C9A876',
          400: '#A9814F',
          500: '#8A6238',
          600: '#6B4A2A',
          700: '#422B1C',
          800: '#341F14',
          900: '#241109',
        },
        // sky: the secondary sky-blue brand ramp (#C4F1FF at 200)
        sky: {
          50: '#F2FCFF',
          100: '#E5F9FF',
          200: '#C4F1FF',
          300: '#9FE6FB',
          400: '#6ED4F0',
          500: '#3EBEDE',
          600: '#2A9BB9',
          700: '#1F7A92',
          800: '#1B5F71',
          900: '#16454F',
        },
        cream: '#F6EFE4',
        // accent: Outlook/Fluent-style primary blue — the ONLY colour used for
        // active nav states, focus rings, primary buttons, and selected rows
        // across the redesigned commander surfaces (Phase 11 UI pass). Main
        // surfaces stay white/slate; ink/sky/cream stay reserved for the logo
        // mark and legacy surfaces not yet redesigned (Field/Citizen).
        // See docs/DESIGN_SYSTEM.md.
        accent: {
          50: '#EFF6FC',
          100: '#DEECF9',
          200: '#C7E0F4',
          300: '#71AFE5',
          400: '#2B88D8',
          500: '#0F6CBD',
          600: '#0C5A9E',
          700: '#0A4A82',
          800: '#083861',
          900: '#062843',
        },
        // status: reserved ONLY for severity / operational state, never decoration
        status: {
          critical: '#DC2626',
          warning: '#D97706',
          success: '#16A34A',
          info: '#0284C7',
          neutral: '#64748B',
        },
        // India NAQI semantic bands (shared by badge, chart, map) — a distinct,
        // regulated public-communication scale; intentionally not merged with
        // the `status` tokens above. See docs/DESIGN_SYSTEM.md.
        aqi: {
          good: '#22c55e',
          satisfactory: '#84cc16',
          moderate: '#eab308',
          poor: '#f97316',
          verypoor: '#ef4444',
          severe: '#9333ea',
        },
      },
      fontFamily: {
        // Marketing site only; the app UI stays on `sans`.
        site: ['"DM Sans"', 'Inter', 'system-ui', 'sans-serif'],
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
        sans: [
          '"Segoe UI Variable"',
          '"Segoe UI"',
          'Inter',
          'Noto Sans Devanagari',
          'system-ui',
          '-apple-system',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.08)',
        'card-lg': '0 4px 6px -1px rgba(16,24,40,.06), 0 10px 24px -4px rgba(16,24,40,.10)',
        rail: '1px 0 0 rgba(16,24,40,.08)',
      },
      zIndex: {
        rail: '30',
        header: '40',
        dropdown: '50',
        modal: '60',
        toast: '70',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'none' } },
      },
      animation: {
        'fade-in': 'fade-in .3s ease-out',
      },
    },
  },
  plugins: [],
}
