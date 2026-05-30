import type { Config } from "tailwindcss";
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        // Kept under the `amber` namespace for backwards-compat with the
        // many `text-amber-accent` / `bg-amber-accent` / `border-amber-accent`
        // call-sites; the actual color is now a vivid orange so the UI
        // reads bright instead of dull.
        amber: {
          accent: "#F97316",
          "accent-dark": "#C2410C",
          "accent-light": "#FFE2C8",
          "accent-muted": "#3D1F0B",
        },
        surface: {
          dark: "#1A1A1A",
          "dark-secondary": "#141414",
          "dark-tertiary": "#252525",
          light: "#FFFFFF",
          "light-secondary": "#FAFAFA",
          "light-tertiary": "#F5F5F5",
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
export default config;
