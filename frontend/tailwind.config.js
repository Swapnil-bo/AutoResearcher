/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Canvas — the near-black base with a touch of blue.
        bg: {
          DEFAULT: "#0a0a0f",
          deep: "#06060a",
          raised: "#0f1018",
          panel: "#111321",
          hover: "#171a2c",
          border: "#1f2340",
        },

        // Primary accent — cyan.
        cyan: {
          50: "#e6fbff",
          100: "#b8f2ff",
          200: "#7fe6ff",
          300: "#3ed7ff",
          400: "#00d4ff",
          500: "#00b8e6",
          600: "#0099c2",
          700: "#007a9c",
          800: "#005c75",
          900: "#003f50",
        },

        // Secondary accent — violet.
        violet: {
          50: "#f1ebff",
          100: "#ddd0ff",
          200: "#beaaff",
          300: "#9a7dff",
          400: "#7c3aed",
          500: "#6b2ed1",
          600: "#5822b0",
          700: "#45198c",
          800: "#321268",
          900: "#1f0a44",
        },

        // Text tiers.
        ink: {
          DEFAULT: "#e2e8f0",
          bright: "#ffffff",
          muted: "#94a3b8",
          dim: "#64748b",
          faint: "#475569",
        },

        // Agent state palette — used by AgentCard borders + glows.
        state: {
          idle: "#3f4358",
          running: "#00d4ff",
          done: "#22c55e",
          error: "#ef4444",
          cancelled: "#f59e0b",
        },
      },

      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },

      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },

      letterSpacing: {
        terminal: "0.18em",
        cyber: "0.35em",
      },

      borderRadius: {
        xl2: "1.125rem",
      },

      boxShadow: {
        "glow-cyan": "0 0 24px rgba(0, 212, 255, 0.35), 0 0 48px rgba(0, 212, 255, 0.12)",
        "glow-cyan-sm": "0 0 12px rgba(0, 212, 255, 0.35)",
        "glow-violet": "0 0 24px rgba(124, 58, 237, 0.4), 0 0 48px rgba(124, 58, 237, 0.12)",
        "glow-violet-sm": "0 0 12px rgba(124, 58, 237, 0.4)",
        "glow-success": "0 0 20px rgba(34, 197, 94, 0.35)",
        "glow-error": "0 0 20px rgba(239, 68, 68, 0.4)",
        "inset-line": "inset 0 1px 0 0 rgba(226, 232, 240, 0.04)",
        panel:
          "0 1px 0 0 rgba(226, 232, 240, 0.03) inset, 0 20px 60px -20px rgba(0, 0, 0, 0.6)",
      },

      backgroundImage: {
        // Signature cyan→violet sweep used on headings, buttons, rings.
        "gradient-brand":
          "linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%)",
        "gradient-brand-soft":
          "linear-gradient(135deg, rgba(0, 212, 255, 0.15) 0%, rgba(124, 58, 237, 0.15) 100%)",
        "gradient-panel":
          "linear-gradient(180deg, rgba(17, 19, 33, 0.9) 0%, rgba(10, 10, 15, 0.9) 100%)",
        // Terminal grid — set as bg-grid on panels that want the cyberpunk floor.
        "grid-faint":
          "linear-gradient(rgba(226, 232, 240, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(226, 232, 240, 0.035) 1px, transparent 1px)",
        "scanlines":
          "repeating-linear-gradient(0deg, rgba(0, 212, 255, 0.025) 0px, rgba(0, 212, 255, 0.025) 1px, transparent 1px, transparent 3px)",
      },

      backgroundSize: {
        grid: "40px 40px",
        "grid-sm": "24px 24px",
      },

      backdropBlur: {
        xs: "2px",
      },

      animation: {
        "pulse-glow": "pulse-glow 2.2s ease-in-out infinite",
        "border-sweep": "border-sweep 3s linear infinite",
        shimmer: "shimmer 2.4s linear infinite",
        "fade-in-up": "fade-in-up 0.5s ease-out both",
        "fade-in": "fade-in 0.35s ease-out both",
        caret: "caret 1.05s steps(1) infinite",
        "scan-line": "scan-line 4s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        "gradient-shift": "gradient-shift 8s ease infinite",
      },

      keyframes: {
        "pulse-glow": {
          "0%, 100%": {
            boxShadow:
              "0 0 0 1px rgba(0, 212, 255, 0.45), 0 0 18px rgba(0, 212, 255, 0.25)",
          },
          "50%": {
            boxShadow:
              "0 0 0 1px rgba(0, 212, 255, 0.85), 0 0 32px rgba(0, 212, 255, 0.55)",
          },
        },
        "border-sweep": {
          "0%": { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        caret: {
          "0%, 50%": { opacity: "1" },
          "51%, 100%": { opacity: "0" },
        },
        "scan-line": {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-6px)" },
        },
        "gradient-shift": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
      },

      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },

  plugins: [
    // Tiny plugin — adds `.text-gradient-brand` and a couple of helpers that
    // are awkward to express with pure utilities.
    function ({ addUtilities }) {
      addUtilities({
        ".text-gradient-brand": {
          "background-image": "linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%)",
          "-webkit-background-clip": "text",
          "background-clip": "text",
          "-webkit-text-fill-color": "transparent",
          color: "transparent",
        },
        ".bg-clip-text-transparent": {
          "-webkit-background-clip": "text",
          "background-clip": "text",
          "-webkit-text-fill-color": "transparent",
          color: "transparent",
        },
        ".mask-fade-b": {
          "mask-image":
            "linear-gradient(to bottom, black 70%, transparent 100%)",
          "-webkit-mask-image":
            "linear-gradient(to bottom, black 70%, transparent 100%)",
        },
        ".mask-fade-r": {
          "mask-image":
            "linear-gradient(to right, black 85%, transparent 100%)",
          "-webkit-mask-image":
            "linear-gradient(to right, black 85%, transparent 100%)",
        },
      });
    },
  ],
};
