# 功能测试计划 (Feature Test Plan)

## ✅ 代码检查状态

### 服务状态
- ✅ 前端服务运行正常 (Port 3000)
- ✅ 后端服务运行正常 (Port 8000)
- ✅ 数据库健康 (PostgreSQL pgvector)

### TypeScript 编译
- ✅ Message.tsx - 无错误
- ✅ SmoothOutput.tsx - 无错误
- ✅ CodeBlock.tsx - 无错误
- ✅ ChatInput.tsx - 无错误
- ✅ ImageLightbox.tsx - 无错误

### 依赖检查
- ✅ katex (^0.16.45) - 已安装
- ✅ mermaid (^11.14.0) - 已安装
- ✅ remark-math (^6.0.0) - 已安装
- ✅ rehype-katex (^7.0.1) - 已安装
- ✅ react-markdown (^10.1.0) - 已安装

### CSS 样式
- ✅ .math-block - 已定义
- ✅ .mermaid-container - 已定义
- ✅ .lightbox-* - 已定义
- ✅ .attachment-* - 已定义
- ✅ .streaming-cursor - 已定义
- ✅ KaTeX CSS 导入顺序正确 (main.tsx 中 index.css 之前)

---

## 手动测试步骤 (Manual Testing Steps)

### 1️⃣ 测试 KaTeX 数学渲染 (Test KaTeX Math Rendering)

在聊天界面发送以下内容：

```
测试内联公式：$E=mc^2$

测试显示模式公式：
$$\int_{0}^{\infty} e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$

测试代码块公式：
\`\`\`math
\frac{d}{dx}(x^2) = 2x
\`\`\`
```

**预期结果:**
- 内联公式正确渲染在文本中
- 显示模式公式居中，字体更大
- 代码块中的 math 语言被识别为 KaTeX 渲染
- 有"Copy"按钮可复制公式源代码

---

### 2️⃣ 测试 Mermaid 图表渲染 (Test Mermaid Diagram Rendering)

在聊天界面发送以下内容：

```
\`\`\`mermaid
graph TD
    A[开始] --> B{判断}
    B -->|是| C[处理]
    B -->|否| D[跳过]
    C --> E[结束]
    D --> E
\`\`\`

\`\`\`mermaid
sequenceDiagram
    participant 用户
    participant 浏览器
    participant 服务器
    用户->>浏览器: 点击发送
    浏览器->>服务器: POST 请求
    服务器->>浏览器: 返回响应
    浏览器->>用户: 显示结果
\`\`\`
```

**预期结果:**
- Mermaid 图表正确渲染
- 支持流程图、时序图等各种图表类型
- 有"Copy"按钮可复制图表源代码
- 如果图表有错误，显示友好的错误提示

---

### 3️⃣ 测试图像预览/Lightbox (Test Image Preview/Lightbox)

发送包含图像的 Markdown：

```
![示例图像](https://via.placeholder.com/400x300)

![多个图像](https://via.placeholder.com/400x300)
```

**预期结果:**
- 点击图像打开 Lightbox 模态框
- 可以用箭头按钮导航到其他图像
- 按 ESC 关闭 Lightbox
- 支持键盘导航：
  - ← / → : 上一张/下一张
  - 空格 : 缩放
  - ESC : 关闭
- 有下载按钮可下载图像
- 显示当前图像编号 (1/2, 2/2 等)

---

### 4️⃣ 测试文件上传 (Test File Upload)

#### 方法 A: 拖放上传
1. 准备测试文件：
   - 图像文件 (.jpg, .png, .webp 等)
   - PDF 文件
   - Word 文档 (.docx)
   - ZIP 压缩包

2. 将文件拖放到聊天输入框

#### 方法 B: 点击上传按钮
1. 点击输入框右侧的回形针图标或图像图标
2. 选择文件

**预期结果:**
- 拖放时显示视觉反馈（背景色改变）
- 文件上传后显示预览卡片
- 预览卡片显示：
  - 文件类型图标（PDF、Word、Excel、Archive、Image）
  - 文件名
  - 文件大小（格式化为 KB/MB）
  - 图像文件显示缩略图
  - 删除按钮可移除文件

---

### 5️⃣ 测试流式输出 (Test Streaming Output)

1. 发送一个需要较长响应的问题
2. 观察 AI 的响应

**预期结果:**
- AI 响应逐字逐字地显示（不是一次性全部出现）
- 最后有一个闪烁的流式光标
- Markdown、KaTeX、Mermaid 在流式过程中实时解析
- 如果包含思考块，思考内容可折叠

---

### 6️⃣ 测试混合功能 (Test Combined Features)

发送包含多个特性的消息：

```
我来演示所有功能：

## Markdown 格式

这是**粗体**和*斜体*文本。

> 这是一个引用

- 列表项 1
- 列表项 2
  - 嵌套项

## 数学公式

欧拉公式：$e^{i\pi} + 1 = 0$

## 代码示例

\`\`\`python
def hello():
    print("Hello, World!")
\`\`\`

## 图表

\`\`\`mermaid
graph LR
    A[开始] --> B[处理] --> C[完成]
\`\`\`
```

**预期结果:**
- 所有特性在同一条消息中正确渲染
- 没有相互干扰或冲突

---

## ⚠️ 可能的问题和解决方案

### 问题 1: CSS 样式未应用
**症状:** 公式、图表、Lightbox 显示但样式不正确
**解决方案:**
- 清空浏览器缓存: `Ctrl+Shift+Delete`
- 刷新页面: `Ctrl+Shift+R` (强制刷新)
- 检查浏览器开发者工具 (F12) 的 Console 标签是否有错误

### 问题 2: KaTeX 渲染失败
**症状:** 公式显示为错误消息
**解决方案:**
- 检查公式语法是否正确
- 在浏览器 Console 中查看详细错误信息
- 查看 Network 标签确认 katex CSS 已加载

### 问题 3: Mermaid 渲染失败
**症状:** 显示"Rendering diagram..."或错误提示
**解决方案:**
- 检查 Mermaid 图表语法是否正确
- 在浏览器 Console 中查看错误信息
- 尝试简化图表结构

### 问题 4: Lightbox 不工作
**症状:** 点击图像无反应
**解决方案:**
- 确保图像 URL 有效（可以直接访问）
- 在浏览器 Console 中检查是否有错误
- 检查图像是否正确嵌入在 Markdown 中

### 问题 5: 文件上传失败
**症状:** 上传时出错或文件未显示
**解决方案:**
- 检查文件大小是否超过限制
- 在浏览器 Network 标签中检查上传请求的响应
- 查看浏览器 Console 中的错误日志

---

## 🔍 浏览器开发者工具检查 (Browser DevTools Inspection)

### 打开开发者工具
- Windows: `F12` 或 `Ctrl+Shift+I`
- Mac: `Cmd+Option+I`

### 检查项目

1. **Console 标签**: 检查是否有 JavaScript 错误
2. **Network 标签**: 
   - 检查 katex CSS 是否加载 (查看 `katex.min.css`)
   - 检查 mermaid JS 是否加载
   - 检查上传请求的响应状态
3. **Elements/Inspector 标签**:
   - 查找 `.math-block` 元素并检查其样式
   - 查找 `.mermaid-container` 并检查其样式
   - 查找 `.lightbox-overlay` 并检查其可见性

### 运行快速测试脚本

在 Console 中运行以下代码来验证库的加载：

```javascript
// 检查 KaTeX
console.log('KaTeX loaded:', typeof window.katex !== 'undefined');

// 检查 Mermaid
console.log('Mermaid loaded:', typeof mermaid !== 'undefined');

// 检查 react-markdown
console.log('React version:', React.version);

// 检查样式是否加载
const mathBlock = document.querySelector('.math-block');
console.log('Math block found:', mathBlock !== null);
console.log('Math block styles:', window.getComputedStyle(mathBlock || document.body));
```

---

## 📋 测试检查清单 (Checklist)

- [ ] KaTeX 内联公式 ($...$) 渲染正确
- [ ] KaTeX 显示公式 ($$...$$) 渲染正确
- [ ] Mermaid 流程图渲染正确
- [ ] Mermaid 时序图渲染正确
- [ ] 点击图像打开 Lightbox
- [ ] Lightbox 键盘导航工作
- [ ] Lightbox 缩放功能工作
- [ ] 文件拖放显示反馈
- [ ] 文件上传显示预览
- [ ] 图像文件显示缩略图
- [ ] 文件大小正确显示
- [ ] 流式输出逐字出现
- [ ] 流式输出中的 Markdown 正确渲染
- [ ] 混合功能无冲突

---

## 问题报告 (Bug Report Template)

如果发现问题，请记录以下信息：

```
**问题描述**: [详细描述问题]

**重现步骤**:
1. [第一步]
2. [第二步]
3. [第三步]

**预期行为**: [应该发生什么]

**实际行为**: [实际发生了什么]

**浏览器**: [浏览器名称和版本]

**Console 错误**: [从 F12 Console 中复制错误信息]

**截图**: [如果可能的话，附加截图]
```

---

## ✨ 完成后的改进项目 (Post-Completion Improvements)

一旦测试完成并通过，可以考虑以下改进：

1. **性能优化**
   - 大型公式和图表的虚拟化
   - 流式响应的优化
   - 图像懒加载

2. **UX 改进**
   - 文件上传进度条
   - 更多的快捷键支持
   - 暗色模式支持

3. **功能扩展**
   - 支持更多文件类型预览
   - 添加公式编辑器
   - 离线支持

---

**测试日期**: [请填入日期]
**测试人员**: [请填入名字]
**测试结果**: [✅ 通过 / ❌ 失败 / ⚠️ 有问题]
**备注**: [任何额外的注释]
