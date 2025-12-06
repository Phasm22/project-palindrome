/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./dashboard/**/*.{html,js}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Burnt orange theme
        primary: {
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316', // Main burnt orange
          600: '#ea580c', // Darker burnt orange
          700: '#c2410c', // Deep burnt orange
          800: '#9a3412',
          900: '#7c2d12',
          950: '#431407',
          gradient: {
            from: '#f97316',
            via: '#fb923c',
            to: '#fdba74',
          },
        },
        accent: {
          purple: '#a855f7',
          blue: '#3b82f6',
          cyan: '#06b6d4',
          emerald: '#10b981',
        },
        glow: {
          orange: 'rgba(249, 115, 22, 0.4)',
          purple: 'rgba(168, 85, 247, 0.4)',
          blue: 'rgba(59, 130, 246, 0.4)',
        },
      },
      fontFamily: {
        // Dramatic titles - Roboto SemiBold
        title: ['Roboto', 'Inter', 'SF Pro Display', 'system-ui', 'sans-serif'],
        // Body text - clean and readable
        body: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Oxygen', 'Ubuntu', 'Cantarell', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      fontWeight: {
        'title': '600', // SemiBold for dramatic titles
        'title-bold': '700', // Bold for extra emphasis
      },
      boxShadow: {
        'glow-orange': '0 0 20px rgba(249, 115, 22, 0.5)',
        'glow-purple': '0 0 20px rgba(168, 85, 247, 0.5)',
        'glow-blue': '0 0 20px rgba(59, 130, 246, 0.5)',
        'elevated': '0 1px 3px rgba(0,0,0,0.3), 0 10px 30px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05)',
        'elevated-hover': '0 4px 6px rgba(0,0,0,0.4), 0 15px 40px rgba(0,0,0,0.3), 0 0 20px rgba(249, 115, 22, 0.3)',
      },
      dropShadow: {
        'glow-orange': '0 0 8px rgba(249, 115, 22, 0.6)',
        'glow-purple': '0 0 8px rgba(168, 85, 247, 0.6)',
        'glow-blue': '0 0 8px rgba(59, 130, 246, 0.6)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}

