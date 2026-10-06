/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './assets/js/**/*.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']
      }
    }
  },
  // Subject accent classes are chosen at runtime by subjectAccent(), so the
  // scanner cannot see them in the markup.
  safelist: [
    { pattern: /^(bg|text|ring)-(indigo|emerald|amber|sky|rose|violet|teal)-(50|200|700)$/ },
    // Freshness badges (Latest / Yesterday / date added) are built in
    // assets/js/lib/freshness.js, also at runtime.
    { pattern: /^(bg|text|ring|border)-(emerald|amber|slate)-(50|100|200|300|500|600|700|800)$/ }
  ],
  plugins: []
};
