import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "var(--brand, #667eea)",
          fg: "var(--brand-fg, #ffffff)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
