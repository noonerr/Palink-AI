# Phase 2: UI 挂载点可见化

## 目标

让 ST 插件依赖的 DOM 挂载点（`#qr_bar`/`#extensions_settings`/`#send_textarea` 等）在 Palink 中可见可交互，插件 UI 不再"看似加载成功实则不可见"。

## Why

ST 插件通过 jQuery 选择器挂载 UI：
- Quick Reply 扩展渲染按钮到 `#qr_bar`（**当前完全缺失**，grep 0 命中）
- 各扩展设置面板渲染到 `#extensions_settings`（当前 `display:none` 隐藏，SillyTavernCompatRuntime.ts:1586-1602）
- 输入相关插件操作 `#send_textarea`（当前是虚拟元素，仅单向同步 setInputDraft，行 4706-4710）

导致：
- 插件 UI "看似加载成功实则不可见"
- Quick Reply 按钮栏完全不渲染
- 插件对输入框的写入不影响 Palink 真实输入框

## What Changes

### 改动点

#### 1. ADDED: `#qr_bar` 可见容器

**新建文件**：`frontend/src/components/st-plugin-ui-host/QrBar.tsx`

在聊天页输入框上方挂载一个可见的 `#qr_bar` 容器，供 Quick Reply 扩展渲染按钮。

```tsx
import { useEffect, useRef } from 'react';

export function QrBar() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.id = 'qr_bar';
      ref.current.className = 'palink-st-qr-bar';
      // 通知 ST 兼容运行时 qr_bar 已就绪
      window.dispatchEvent(new CustomEvent('palink:qr_bar_ready', {
        detail: { element: ref.current }
      }));
    }
  }, []);

  return (
    <div
      ref={ref}
      className="palink-st-qr-bar"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        padding: '4px 8px',
        minHeight: '36px',
        borderBottom: '1px solid var(--border-color, #e0e0e0)',
      }}
    />
  );
}
```

**挂载位置**：在 NativeRoleplayChat.tsx 的输入框组件上方插入 `<QrBar />`。

**样式**：与 Palink 输入框区域风格一致，支持移动端响应式。

#### 2. MODIFIED: `#extensions_settings` 可见化

**文件**：`frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`（行 1586-1602）

**当前实现**（隐藏容器）：
```javascript
container.style.cssText = 'display:none;';
```

**改为可见**：
- 不再 `display:none`
- 在 Palink 设置页新增"ST 扩展设置"入口，点击时把 `#extensions_settings2` 的内容渲染到可见区域
- 保留 `openThirdPartyExtensionMenuCompat`（行 1609）的 overlay 方案作为补充

**具体改动**：
```javascript
const ensureStExtensionSettingsHostCompat = () => {
  let host = document.getElementById('extensions_settings2');
  if (!host) {
    const container = document.createElement('div');
    container.id = 'extensions_settings_container';
    // 改为：默认隐藏，但有入口可显示
    container.style.cssText = 'position:fixed; top:-9999px; left:-9999px; visibility:hidden;';
    // 不用 display:none，因为某些插件会检测 offsetWidth
    const legacy = document.createElement('div');
    legacy.id = 'extensions_settings';
    legacy.setAttribute('data-palink-st-settings-host', 'legacy');
    host = document.createElement('div');
    host.id = 'extensions_settings2';
    host.setAttribute('data-palink-st-settings-host', 'primary');
    container.append(legacy, host);
    (document.body || document.documentElement).appendChild(container);
  }
  return host;
};
```

**新增设置页入口**：`frontend/src/pages/settings/st-extensions.tsx`

```tsx
import { useEffect, useState } from 'react';

export function StExtensionsSettings() {
  const [panelHtml, setPanelHtml] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // 从 #extensions_settings2 提取已加载插件的设置面板
    const host = document.getElementById('extensions_settings2');
    if (host) {
      setPanelHtml(host);
    }
  }, []);

  return (
    <div className="palink-st-extensions-settings">
      <h2>ST 扩展设置</h2>
      <div ref={(el) => {
        if (el && panelHtml) {
          el.innerHTML = '';
          el.appendChild(panelHtml);
        }
      }} />
    </div>
  );
}
```

#### 3. MODIFIED: `#send_textarea` 双向同步

**文件**：`frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`（行 2985-2992）

**当前实现**（单向：虚拟元素 → Palink 输入框）：
```javascript
send_textarea: createParentVirtualElementCompat('send_textarea', 'TEXTAREA', 'send_textarea', {
  dispatch(_event, eventType) {
    if (eventType === 'input' || eventType === 'change') {
      post({ type: 'st:setInputDraft', content: String(parentElementStore.send_textarea.value || '') });
    }
  },
}),
```

**改为双向**：
```javascript
send_textarea: createParentVirtualElementCompat('send_textarea', 'TEXTAREA', 'send_textarea', {
  dispatch(_event, eventType) {
    if (eventType === 'input' || eventType === 'change') {
      post({ type: 'st:setInputDraft', content: String(parentElementStore.send_textarea.value || '') });
    }
  },
}),
// 新增：监听 Palink 真实输入框变化，同步到虚拟元素
// 在 SillyTavernCompatRuntime 初始化时注册
window.addEventListener('palink:input_draft_changed', (event) => {
  parentElementStore.send_textarea.value = String(event.detail?.content ?? '');
});
```

**文件**：`frontend/src/components/ui/custom/CharacterCardRenderer.tsx`（行 3612-3618）

同样改为双向同步。

**真实输入框侧**：在 Palink 真实输入框的 `onChange` 中 dispatch `palink:input_draft_changed` 事件：

```tsx
// 在真实输入框组件中
<textarea
  onChange={(e) => {
    setDraft(e.target.value);
    window.dispatchEvent(new CustomEvent('palink:input_draft_changed', {
      detail: { content: e.target.value }
    }));
  }}
/>
```

#### 4. ADDED: 其他常用挂载点

为以下 ST 常用 DOM ID 创建虚拟/可见容器：

| DOM ID | 用途 | 类型 |
|---|---|---|
| `#form_shoud` | 表单容器 | 虚拟（不可见） |
| `#right-nav` | 右侧导航 | 虚拟（不可见） |
| `#extensions_settings2` | 扩展设置面板（主） | 可见（设置页入口） |
| `#extensions_settings` | 扩展设置面板（旧版） | 虚拟（兼容） |
| `#qr_bar` | Quick Reply 按钮栏 | 可见（聊天页） |
| `#send_textarea` | 输入框 | 虚拟（双向同步） |
| `#chat` | 聊天消息容器 | 虚拟（已有） |

**文件**：`frontend/src/lib/sillytavern/st-dom-hosts.ts`（新建）

统一管理所有 ST DOM 挂载点：

```typescript
export interface StDomHostConfig {
  id: string;
  type: 'visible' | 'virtual';
  mountPoint?: 'chat' | 'settings' | 'global';
  visibleContainer?: boolean;
}

export const ST_DOM_HOSTS: StDomHostConfig[] = [
  { id: 'extensions_settings2', type: 'visible', mountPoint: 'settings' },
  { id: 'extensions_settings', type: 'virtual', mountPoint: 'global' },
  { id: 'qr_bar', type: 'visible', mountPoint: 'chat' },
  { id: 'send_textarea', type: 'virtual', mountPoint: 'global' },
  { id: 'form_shoud', type: 'virtual', mountPoint: 'global' },
  { id: 'right-nav', type: 'virtual', mountPoint: 'global' },
  { id: 'chat', type: 'virtual', mountPoint: 'global' },
];

export function ensureStDomHosts(): void {
  ST_DOM_HOSTS.forEach(config => {
    if (!document.getElementById(config.id)) {
      const el = document.createElement(config.type === 'visible' ? 'div' : 'div');
      el.id = config.id;
      if (config.type === 'virtual') {
        el.style.cssText = 'position:fixed; top:-9999px; left:-9999px; visibility:hidden;';
      }
      document.body.appendChild(el);
    }
  });
}
```

## 验收标准

### 单元测试
- [ ] `frontend/src/components/st-plugin-ui-host/__tests__/QrBar.test.tsx`
  - test `#qr_bar` 容器被创建并可见
  - test ST Quick Reply 扩展能挂载按钮到 `#qr_bar`
- [ ] `frontend/src/lib/sillytavern/__tests__/st-dom-hosts.test.ts`
  - test 所有 ST DOM ID 都被创建
  - test visible 类型可见，virtual 类型不可见

### 集成测试
- [ ] Quick Reply 扩展的按钮栏在聊天页可见可点击
- [ ] ST 扩展设置面板在 Palink 设置页可见
- [ ] 插件修改 `#send_textarea` 的值同步到 Palink 真实输入框
- [ ] Palink 真实输入框的变化同步到 `#send_textarea`

### 回归测试
- [ ] 后端全量回归：512 passed, 45 skipped, 0 failed
- [ ] ST 验收脚本：220/220 passed
- [ ] 前端 TypeScript：修改的文件 0 错误

## 风险与注意事项

1. **`#qr_bar` 布局**：Quick Reply 按钮数量不定，需支持 flex-wrap，移动端要响应式。
2. **`#extensions_settings` 可见化**：不能直接 display:block，因为部分插件会检测 `offsetWidth`/`offsetHeight` 判断可见性。用 `position:fixed; top:-9999px; visibility:hidden;` 替代 `display:none`。
3. **双向同步死循环**：`#send_textarea` 双向同步要避免 A 改 B、B 改 A 的死循环。用标志位或事件去重。
4. **ST Native 模式**：iframe 内的 ST 已有真实 DOM，不需要虚拟挂载点。本 Phase 只影响 palink-native 模式。
5. **移动端适配**：`#qr_bar` 在移动端要适配屏幕宽度，按钮不溢出。

## 完成判定

- `#qr_bar` 容器在聊天页可见，Quick Reply 按钮能挂载
- `#extensions_settings` 在设置页可见，插件面板能渲染
- `#send_textarea` 双向同步正常工作
- 所有 ST 常用 DOM ID 都有对应容器
- 全量回归 0 failure
