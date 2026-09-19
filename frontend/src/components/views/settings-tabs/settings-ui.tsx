import React from 'react';
import { cn } from '@/lib/utils';

/**
 * 设置内页统一原语：与设置主菜单同一套 iOS 分组语言。
 * SettingsGroup = 组标签 + 白卡组（发丝分隔）
 * SettingsRow  = 图标座 + 标题/说明 + 右侧控件（或 wide 时控件换行铺满）
 * Segmented    = 胶囊分段控件（与 ProfileTab 头像切换同款）
 */

export function SettingsGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground/80">{label}</p>}
      <div className="overflow-hidden rounded-2xl border border-border/50 bg-card divide-y divide-border/40">{children}</div>
    </div>
  );
}

export function SettingsRow({ icon, title, desc, children, onClick }: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
  onClick?: () => void;
}) {
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-3 text-left min-h-[52px]',
        onClick && 'active:bg-secondary/70 cursor-pointer'
      )}
    >
      {icon !== undefined && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          {icon}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] font-medium leading-snug">{title}</span>
        {desc && <span className="mt-0.5 block text-xs text-muted-foreground leading-relaxed">{desc}</span>}
      </span>
      {children !== undefined && <span className="shrink-0 flex items-center">{children}</span>}
    </Tag>
  );
}

/** 控件在标题下方整行铺满的行（分段选项多时用） */
export function SettingsRowWide({ icon, title, desc, children }: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        {icon !== undefined && (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            {icon}
          </span>
        )}
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-medium leading-snug">{title}</span>
          {desc && <span className="mt-0.5 block text-xs text-muted-foreground leading-relaxed">{desc}</span>}
        </span>
      </div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: {
  options: { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 p-1 bg-secondary/60 rounded-xl">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2.5 py-1 text-xs font-medium rounded-lg transition-all whitespace-nowrap',
            value === o.value ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
