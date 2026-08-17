import React from 'react';

export interface CharacterStatusBar {
  name: string;
  inner: string;
  parts: { label: string; value: string }[];
  clothes: { label: string; value: string }[];
  dev: { label: string; value: string }[];
}

function StatusSection({ title, color, items }: { title: string; color: string; items: { label: string; value: string }[] }) {
  return (
    <div className="mb-1">
      <div className="mb-0.5 mt-2 font-bold" style={{ color }}>
        {title}
      </div>
      {items.map((it, i) => (
        <div key={i} className="pl-2.5">
          {it.label}: {it.value}
        </div>
      ))}
    </div>
  );
}

/**
 * 角色状态栏面板（私密记录）。独立渲染，不依赖 SillyTavern regex 脚本链。
 * 仅展示由 <NSFW>...</NSFW> / <luomo_nsfw>...</luomo_nsfw> 解析出的结构化数据。
 */
export function StatusBarPanel({ data }: { data: CharacterStatusBar }) {
  return (
    <details
      className="mt-3 overflow-hidden rounded-md border border-white/15 bg-black/25 text-[#e2e2e2] backdrop-blur-sm"
      style={{ fontSize: '0.85em', fontFamily: 'inherit' }}
    >
      <summary
        className="cursor-pointer select-none px-3 py-2 font-bold outline-none"
        style={{ color: '#ffb8b8', borderBottom: '1px solid transparent' }}
      >
        [私密记录] {data.name || '角色'}状态 - 点击展开
      </summary>
      <div className="px-3.5 py-2.5 leading-relaxed" style={{ borderTop: '1px dashed rgba(255,255,255,0.1)' }}>
        {data.inner ? (
          <div className="mb-3 border-l-2 border-[#ff9999] pl-2 italic text-[#ffcccc]">内心os: {data.inner}</div>
        ) : null}
        <StatusSection title="部位" color="#ff9f43" items={data.parts} />
        <StatusSection title="衣着" color="#48dbfb" items={data.clothes} />
        <StatusSection title="开发情况" color="#1dd1a1" items={data.dev} />
      </div>
    </details>
  );
}

export default StatusBarPanel;
