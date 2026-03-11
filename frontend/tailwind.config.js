/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        // Aurora 主题色
        aurora: {
          cyan: '#00f2ff',
          blue: '#0044ff',
          purple: '#8800ff',
          green: '#00ff88',
        },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        'aurora': '0 8px 25px rgba(0, 242, 255, 0.25)',
        'glass': '0 4px 15px rgba(0, 0, 0, 0.1)',
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        // Aurora Blob 浮动动画
        "aurora-float-1": {
          "0%": { transform: "translate3d(0, 0, 0) rotate(0deg)" },
          "50%": { transform: "translate3d(30px, 40px, 0) rotate(5deg)" },
          "100%": { transform: "translate3d(-20px, 15px, 0) rotate(-5deg)" },
        },
        "aurora-float-2": {
          "0%": { transform: "translate3d(0, 0, 0) rotate(0deg)" },
          "50%": { transform: "translate3d(-30px, -30px, 0) rotate(-5deg)" },
          "100%": { transform: "translate3d(20px, -20px, 0) rotate(5deg)" },
        },
        "aurora-float-3": {
          "0%": { transform: "translate3d(0, 0, 0) rotate(0deg)" },
          "50%": { transform: "translate3d(20px, -20px, 0) rotate(8deg)" },
          "100%": { transform: "translate3d(-15px, 20px, 0) rotate(-8deg)" },
        },
        // Aurora Blob 变形动画
        "aurora-morph": {
          "0%": { borderRadius: "50%" },
          "25%": { borderRadius: "40% 60% 60% 40% / 40% 40% 60% 60%" },
          "50%": { borderRadius: "50% 50% 30% 70% / 30% 70% 30% 70%" },
          "75%": { borderRadius: "60% 40% 40% 60% / 60% 60% 40% 40%" },
          "100%": { borderRadius: "45% 55% 60% 40% / 45% 50% 55% 50%" },
        },
        // 淡入动画
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in-down": {
          from: { opacity: "0", transform: "translateY(-10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // 脉冲动画
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.7" },
        },
        // 闪烁动画（用于状态指示器）
        "blink": {
          "0%": { opacity: "1" },
          "50%": { opacity: "0.3" },
          "100%": { opacity: "1" },
        },
        // 旋转动画（用于加载状态）
        "spin-slow": {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        // 进度环动画
        "ring-spin": {
          "0%": { strokeDashoffset: "0" },
          "100%": { strokeDashoffset: "-440" },
        },
        // 滑入动画
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(20px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-20px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        // Toast 动画
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // 模态框缩放动画
        "modal-scale": {
          from: { opacity: "0", transform: "scale(0.9)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        // Aurora 动画
        "aurora-float-1": "aurora-float-1 14s ease-in-out infinite alternate",
        "aurora-float-2": "aurora-float-2 12s ease-in-out infinite alternate",
        "aurora-float-3": "aurora-float-3 16s ease-in-out infinite alternate",
        "aurora-morph": "aurora-morph 10s ease-in-out infinite alternate",
        // 通用动画
        "fade-in": "fade-in 0.3s ease-out",
        "fade-in-up": "fade-in-up 0.4s ease-out",
        "fade-in-down": "fade-in-down 0.4s ease-out",
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "blink": "blink 1s infinite",
        "spin-slow": "spin-slow 3s linear infinite",
        "ring-spin": "ring-spin 1.5s linear infinite",
        "slide-in-right": "slide-in-right 0.3s ease-out",
        "slide-in-left": "slide-in-left 0.3s ease-out",
        "fade-up": "fade-up 0.3s ease-out",
        "modal-scale": "modal-scale 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
      },
      backdropBlur: {
        xs: '2px',
      },
      transitionTimingFunction: {
        'aurora': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
