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
        // Names predate the 2026-05-12 rebrand and are kept for call-site
        // stability. The `amber.*` namespace now holds a muted infrastructure
        // gold (~#B4781E), and `surface.dark-tertiary` now points to navy.
        // See docs/superpowers/specs/2026-05-12-webui-rebrand-design.md.
        amber: {
          accent: "#B4781E",
          "accent-dark": "#8E5E14",
          "accent-light": "#E5C079",
          "accent-muted": "#2A1F0F",
        },
        surface: {
          dark: "#0A0F1A",
          "dark-secondary": "#121A2B",
          "dark-tertiary": "#0F274F",
          light: "#F4F3EF",
          "light-secondary": "#ECE9E2",
          "light-tertiary": "#E0DDD3",
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
export default config;
