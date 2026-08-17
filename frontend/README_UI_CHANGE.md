# Palink AI - Aurora Glass UI 重构文档

## 概述

本次更新将 Palink AI 的前端 UI 完整重构为 **Aurora Glass** 主题，视觉风格完全基于 `index背景参考.html`，实现了：

- **Aurora 多层 Blob 动态背景** - 带有浮动和变形动画
- **玻璃拟态 (Glassmorphism)** - 半透明背景与模糊效果
- **Kinetic 动效按钮** - 鼠标跟随微位移效果
- **深色/浅色主题切换** - 完整的主题系统
- **移动端自动降级** - 性能优化与适配

---

## 文件变更清单

### 新增/修改的核心文件

| 文件路径 | 变更类型 | 说明 |
|---------|---------|------|
| `src/components/ui/custom/AuroraBackground.tsx` | 重写 | Aurora Blob 背景组件 |
| `src/components/ui/custom/GlassContainer.tsx` | 重写 | 玻璃拟态容器组件 |
| `src/components/ui/custom/KineticButton.tsx` | 新增 | Kinetic 动效按钮 |
| `src/components/ui/custom/ThemeProvider.tsx` | 新增 | 主题管理 Provider |
| `src/App.tsx` | 重写 | 主应用组件整合 |
| `tailwind.config.js` | 修改 | 添加动画配置 |
| `src/index.css` | 重写 | CSS 变量与动画样式 |

### 保留的文件（无需修改）

- `src/components/views/ChatView.tsx` - 功能完整保留
- `src/components/views/SettingsView.tsx` - 功能完整保留
- `src/components/views/WorkspaceView.tsx` - 功能完整保留
- `src/components/views/AuthScreen.tsx` - 功能完整保留
- `src/components/ui/custom/Sidebar.tsx` - 已兼容 glass 类

---

## 安装与启动

### 1. 安装依赖

项目没有新增 npm 依赖，使用现有依赖即可：

```bash
cd frontend
npm install
```

### 2. 启动开发服务器

```bash
npm run dev
```

### 3. 构建生产版本

```bash
npm run build
```

---

## 主题配置

### CSS 变量

在 `src/index.css` 中定义了完整的主题变量：

```css
:root {
  /* 核心颜色 */
  --background: 0 0% 100%;
  --foreground: 240 10% 3.9%;
  --primary: 187 100% 50%;  /* Aurora Cyan */
  
  /* Aurora 主题色 */
  --aurora-cyan: #00f2ff;
  --aurora-blue: #0044ff;
  --aurora-purple: #8800ff;
  --aurora-green: #00ff88;
  
  /* 玻璃效果 */
  --glass-bg: rgba(255, 255, 255, 0.6);
  --glass-border: rgba(0, 0, 0, 0.1);
}

.dark {
  --background: 240 10% 3.9%;
  --foreground: 0 0% 98%;
  --glass-bg: rgba(20, 20, 25, 0.6);
  --glass-border: rgba(255, 255, 255, 0.1);
}
```

### 切换主题

主题切换会自动保存到 localStorage：

```typescript
// 使用 ThemeProvider
const { theme, toggleTheme, setTheme } = useTheme();

// 切换
<button onClick={toggleTheme}>切换主题</button>

// 设置指定主题
setTheme('dark');
setTheme('light');
```

---

## 组件使用指南

### 1. AuroraBackground - 动态背景

```tsx
import { AuroraBackground } from '@/components/ui/custom/AuroraBackground';

// 基础用法
<AuroraBackground />

// 禁用动画（用于性能敏感场景）
<AuroraBackground reducedMotion />
```

**特性：**
- 三个渐变 Blob 层（青、紫、绿）
- 自动检测移动端并降级
- 支持 `prefers-reduced-motion` 媒体查询

### 2. GlassContainer - 玻璃容器

```tsx
import { GlassContainer, GlassCard, GlassButton } from '@/components/ui/custom/GlassContainer';

// 基础容器
<GlassContainer>
  内容
</GlassContainer>

// 不同强度
<GlassContainer intensity="light">...</GlassContainer>
<GlassContainer intensity="medium">...</GlassContainer>
<GlassContainer intensity="strong">...</GlassContainer>

// 带悬停效果
<GlassContainer hover rounded="xl">
  悬停会轻微上浮
</GlassContainer>

// 玻璃卡片（简化版）
<GlassCard hover>
  卡片内容
</GlassCard>

// 玻璃按钮
<GlassButton variant="primary" onClick={handleClick}>
  点击我
</GlassButton>
```

**Props：**
- `intensity`: 'light' | 'medium' | 'strong' - 玻璃透明度
- `rounded`: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full' - 圆角大小
- `hover`: boolean - 是否启用悬停效果
- `border`: boolean - 是否显示边框
- `shadow`: boolean - 是否显示阴影

### 3. KineticButton - 动效按钮

```tsx
import { KineticButton } from '@/components/ui/custom/KineticButton';

<KineticButton 
  variant="send"  // 'send' | 'recv' | 'primary' | 'secondary'
  size="md"       // 'sm' | 'md' | 'lg'
  onClick={handleClick}
>
  按钮文字
</KineticButton>
```

**特性：**
- 桌面端：鼠标跟随微位移效果
- 移动端：简化为缩放效果
- 使用 requestAnimationFrame 优化性能

### 4. ThemeProvider - 主题管理

```tsx
import { ThemeProvider, useTheme, ThemeToggle } from '@/components/ui/custom/ThemeProvider';
import { LanguageProvider, useLanguage, LanguageToggle } from '@/components/ui/custom/ThemeProvider';

// 包裹应用
<ThemeProvider>
  <LanguageProvider>
    <App />
  </LanguageProvider>
</ThemeProvider>

// 在组件中使用
function MyComponent() {
  const { theme, toggleTheme, isDark } = useTheme();
  const { lang, toggleLang } = useLanguage();
  
  return (
    <>
      <ThemeToggle />
      <LanguageToggle />
    </>
  );
}
```

---

## 动画参数调整

### 修改 Aurora Blob 动画

在 `tailwind.config.js` 中：

```javascript
keyframes: {
  "aurora-float-1": {
    "0%": { transform: "translate3d(0, 0, 0) rotate(0deg)" },
    "50%": { transform: "translate3d(30px, 40px, 0) rotate(5deg)" },
    "100%": { transform: "translate3d(-20px, 15px, 0) rotate(-5deg)" },
  },
}
```

### 修改动画速度

在组件中：

```tsx
// 调整动画时长（秒）
<div 
  className="animate-aurora-float-1"
  style={{ animationDuration: '20s' }}  // 更慢
/>
```

### 禁用特定动画

```css
/* 在特定元素上禁用动画 */
.no-animation {
  animation: none !important;
}
```

---

## 性能优化

### 已实现的优化

1. **硬件加速**
   - 使用 `transform3d()` 和 `will-change`
   - 启用 GPU 加速

2. **移动端降级**
   - 自动检测触摸设备
   - 减少动画复杂度

3. **Reduced Motion 支持**
   - 尊重用户 `prefers-reduced-motion` 设置
   - 自动禁用动画

4. **CSS  containment**
   - 使用 `contain: layout style paint`

### 手动性能调优

```tsx
// 在低端设备上禁用背景动画
<AuroraBackground reducedMotion={isLowEndDevice} />

// 使用 CSS 变量动态调整
<style>{`
  :root {
    --aurora-opacity: 0.1;  /* 降低透明度 */
  }
`}</style>
```

---

## 浏览器兼容性

### 支持特性

| 特性 | Chrome | Firefox | Safari | Edge |
|-----|--------|---------|--------|------|
| backdrop-filter | 76+ | 103+ | 9+ | 79+ |
| CSS Variables | 49+ | 31+ | 9.1+ | 15+ |
| transform3d | 12+ | 10+ | 4+ | 12+ |

### 降级方案

对于不支持 `backdrop-filter` 的浏览器：

```css
@supports not (backdrop-filter: blur(20px)) {
  .glass {
    background: rgba(255, 255, 255, 0.95);
  }
  .dark .glass {
    background: rgba(30, 30, 35, 0.95);
  }
}
```

---

## 回滚指南

如需回滚到旧版本 UI：

### 方法 1：Git 回滚

```bash
# 查看提交历史
git log --oneline

# 回滚到特定提交
git revert <commit-hash>

# 或重置到之前的状态
git reset --hard <commit-hash>
```

### 方法 2：手动恢复

1. 恢复 `src/App.tsx` 到旧版本
2. 恢复 `src/index.css` 到旧版本
3. 恢复 `tailwind.config.js` 到旧版本
4. 删除新增组件文件：
   - `src/components/ui/custom/AuroraBackground.tsx`
   - `src/components/ui/custom/GlassContainer.tsx`
   - `src/components/ui/custom/KineticButton.tsx`
   - `src/components/ui/custom/ThemeProvider.tsx`

### 方法 3：保留功能，仅禁用视觉效果

在 `src/index.css` 中添加：

```css
/* 禁用所有动画 */
* {
  animation: none !important;
  transition: none !important;
}

/* 禁用玻璃效果 */
.glass, .glass-strong {
  backdrop-filter: none !important;
  background: hsl(var(--background)) !important;
}

/* 隐藏 Aurora 背景 */
.aurora-container {
  display: none !important;
}
```

---

## 测试清单

### 功能测试

- [ ] Aurora 背景在深色/浅色主题下正确显示
- [ ] 玻璃容器有正确的模糊效果
- [ ] Kinetic 按钮在桌面端有微位移效果
- [ ] 主题切换正常工作并持久化
- [ ] 语言切换正常工作
- [ ] 所有页面（Chat/Workspace/Settings）正常加载
- [ ] 登录/登出功能正常

### 性能测试

- [ ] 在移动设备上动画流畅
- [ ] 没有明显的卡顿或掉帧
- [ ] 内存占用没有异常增长

### 兼容性测试

- [ ] Chrome/Edge 最新版
- [ ] Firefox 最新版
- [ ] Safari 最新版
- [ ] 移动端浏览器

---

## 故障排除

### 问题：背景动画卡顿

**解决方案：**
1. 检查是否启用了硬件加速
2. 在移动设备上自动降级已启用
3. 尝试减少 Blob 数量或降低模糊半径

### 问题：玻璃效果不显示

**解决方案：**
1. 检查浏览器是否支持 `backdrop-filter`
2. 确认元素有背景色或背景图
3. 检查父元素是否有 `overflow: hidden`

### 问题：主题切换不生效

**解决方案：**
1. 确认 ThemeProvider 正确包裹应用
2. 检查 localStorage 是否被禁用
3. 查看控制台是否有错误信息

---

## 更新日志

### v18.0 - Aurora Glass (2025-02-06)

- 新增 Aurora 动态背景组件
- 新增 GlassContainer 玻璃拟态容器
- 新增 KineticButton 动效按钮
- 新增 ThemeProvider 主题管理
- 重写全局样式系统
- 优化移动端性能
- 支持 prefers-reduced-motion

---

## 开发者联系方式

如有问题或建议，请提交 Issue 或联系开发团队。
