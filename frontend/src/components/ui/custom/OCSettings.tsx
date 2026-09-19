import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  User,
  Save,
  Upload,
  Plus,
  Trash2,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { personaManager } from '@/lib/personas/manager';
import type { Persona } from '@/lib/personas/types';

// 旧「原创角色(OC)」本地数据：首次进入本页时一次性迁移为 Persona
const OC_STORAGE_KEY = 'palink_oc_data';
const OC_CONFIG_KEY = 'palink_oc_config';

// persona_description_position 采用 ST 1.18 枚举（personas.js:88-97）：
// IN_PROMPT 0 / AFTER_CHAR 1(废弃) / TOP_AN 2 / BOTTOM_AN 3 / AT_DEPTH 4 / NONE 9
// ⚠ 与旧 Palink 值域（0=对话中 / 1=系统提示末尾 / 2=聊天末尾）**数值冲突**，
// 2026-09-08 起前后端统一到 ST 枚举（后端装配同步按 ST 语义解释）。
// 「不注入」由上方 personaShow 开关控制，故不暴露 NONE=9。
const POSITION_OPTIONS = [
  { value: 4, label: '对话中（跟随上下文，深度 4）' },
  { value: 0, label: '系统提示末尾' },
  { value: 2, label: '作者注释顶部' },
  { value: 3, label: '聊天末尾（作者注释底部）' },
];

interface OCSettingsProps {
  token?: string;
  models?: unknown[];
  onUpdate?: () => void;
}

interface PersonaForm {
  name: string;
  description: string;
  avatar?: string;
  personaShow: boolean;
  position: number;
  depth: number;
  isDefault: boolean;
}

export function OCSettings({ onUpdate }: OCSettingsProps) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<PersonaForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  const syncFromManager = useCallback(() => {
    const list = personaManager.getAllPersonas();
    setPersonas(list);
    const activeIdNow = personaManager.getSettings().activePersonaId;
    setActiveId(activeIdNow);
    const active = list.find(p => p.id === activeIdNow) ?? null;
    setForm(active ? {
      name: active.name,
      description: active.description ?? '',
      avatar: active.avatar,
      personaShow: active.personaShow ?? false,
      position: active.personaDescriptionPosition ?? 4,
      depth: active.personaDescriptionDepth ?? 4,
      isDefault: !!active.isDefault,
    } : null);
    setDirty(false);
  }, []);

  // 初始化 + 旧 OC 数据一次性迁移
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await personaManager.init();
      if (cancelled) return;
      if (personaManager.getAllPersonas().length === 0) {
        const raw = localStorage.getItem(OC_STORAGE_KEY);
        if (raw) {
          try {
            const oc = JSON.parse(raw);
            if (oc?.name) {
              const descParts = [
                oc.traits ? `人物特点：${oc.traits}` : '',
                oc.personality ? `性格：${oc.personality}` : '',
                oc.hobbies ? `爱好：${oc.hobbies}` : '',
                oc.background ? `人物背景：${oc.background}` : '',
                ...(Array.isArray(oc.customFields)
                  ? oc.customFields.filter((f: { label?: string; value?: string }) => f?.label && f?.value)
                      .map((f: { label: string; value: string }) => `${f.label}：${f.value}`)
                  : []),
              ].filter(Boolean).join('\n');
              const migrated = personaManager.createPersona(oc.name, descParts, {
                avatar: oc.avatar,
                personaShow: true,
                // ST 枚举：4 = AT_DEPTH「对话中」（旧值 0 现语义为 IN_PROMPT，已切换）
                personaDescriptionPosition: 4,
                personaDescriptionDepth: 4,
                isDefault: true,
              });
              personaManager.selectPersona(migrated.id);
              localStorage.removeItem(OC_STORAGE_KEY);
              localStorage.removeItem(OC_CONFIG_KEY);
              toast.success('已将原「原创角色(OC)」资料迁移为人设卡');
            }
          } catch {
            // 迁移失败不影响正常使用
          }
        }
      }
      if (!cancelled) syncFromManager();
    })();
    return () => { cancelled = true; };
  }, [syncFromManager]);

  const doSave = useCallback(() => {
    if (!activeId || !form) return;
    personaManager.updatePersona(activeId, {
      name: form.name.trim() || '未命名',
      description: form.description,
      avatar: form.avatar,
      personaShow: form.personaShow,
      personaDescriptionPosition: form.position,
      personaDescriptionDepth: form.depth,
      isDefault: form.isDefault,
    });
    setDirty(false);
  }, [activeId, form]);

  const handleSave = useCallback(() => {
    doSave();
    setIsSaving(true);
    onUpdate?.();
    setTimeout(() => setIsSaving(false), 400);
    toast.success('人设已保存');
  }, [doSave, onUpdate]);

  const flushIfDirty = useCallback(() => {
    if (dirty) doSave();
  }, [dirty, doSave]);

  const handleSelect = useCallback((id: string) => {
    if (id === activeId) return;
    flushIfDirty();
    personaManager.selectPersona(id);
    syncFromManager();
  }, [activeId, flushIfDirty, syncFromManager]);

  const handleCreate = useCallback(() => {
    flushIfDirty();
    const created = personaManager.createPersona('新的人设', '', {
      personaShow: true,
      // ST 枚举：4 = AT_DEPTH「对话中」
      personaDescriptionPosition: 4,
      personaDescriptionDepth: 4,
    });
    personaManager.selectPersona(created.id);
    syncFromManager();
  }, [flushIfDirty, syncFromManager]);

  const handleDeleteClick = useCallback(() => {
    if (!activeId) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
    setConfirmDelete(false);
    personaManager.deletePersona(activeId);
    toast.success('人设已删除');
    syncFromManager();
  }, [activeId, confirmDelete, syncFromManager]);

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('请上传图片文件');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('图片大小不能超过 5MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setForm(prev => (prev ? { ...prev, avatar: dataUrl } : prev));
      setDirty(true);
    };
    reader.readAsDataURL(file);
  };

  const updateForm = (patch: Partial<PersonaForm>) => {
    setForm(prev => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  return (
    <div className="w-full animate-fade-in pb-28">
      {/* 顶部操作区：保存 —— 与 SettingsView 悬浮返回键镜像（fixed 仅移动端，md:static 回滚动流） */}
      <div
        className="fixed z-30 right-5 md:static flex items-center justify-end mb-4"
        style={{ top: 'calc(max(env(safe-area-inset-top), 8px) + 4px)' }}
      >
        <Button onClick={handleSave} disabled={isSaving || !form} className="h-8 md:h-9 rounded-md px-4 text-xs shrink-0 shadow-sm">
          <Save size={14} className="mr-1.5" />
          {isSaving ? '保存中...' : '保存'}
        </Button>
      </div>

      {/* 人设列表：选中即当前使用（ST 语义），激活者带对勾 */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {personas.map((p) => (
          <button
            key={p.id}
            onClick={() => handleSelect(p.id)}
            className={cn(
              'flex items-center gap-2 pl-1 pr-3 py-1 rounded-full border text-[13px] transition-all duration-200 active:scale-95',
              p.id === activeId
                ? 'bg-primary/10 border-primary text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            )}
          >
            <Avatar className="w-7 h-7 border border-border/50">
              {p.avatar ? (
                <AvatarImage src={p.avatar} alt={p.name} />
              ) : (
                <AvatarFallback className="bg-secondary/60">
                  <User size={13} className="text-muted-foreground" />
                </AvatarFallback>
              )}
            </Avatar>
            {p.name || '未命名'}
            {p.id === activeId && <Check size={12} className="text-primary shrink-0" />}
          </button>
        ))}
        <button
          onClick={handleCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-border text-[13px] text-muted-foreground hover:text-foreground transition-all duration-200 active:scale-95"
        >
          <Plus size={13} />
          新建人设
        </button>
      </div>

      {form ? (
        <div className="space-y-6 pb-6 max-w-2xl">
          {/* 头像 + 名称（无卡片包裹） */}
          <div className="flex items-center gap-4">
            <div className="relative shrink-0">
              <Avatar className="w-16 h-16 md:w-20 md:h-20 border border-border/50">
                {form.avatar ? (
                  <AvatarImage src={form.avatar} alt="Persona Avatar" />
                ) : (
                  <AvatarFallback className="bg-secondary/60">
                    <User size={24} className="text-muted-foreground" />
                  </AvatarFallback>
                )}
              </Avatar>
              <label className="absolute -bottom-1 -right-1 cursor-pointer">
                <input
                  type="file"
                  accept=".jpg,.jpeg,.png"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
                <div className="w-7 h-7 flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-transform duration-200 active:scale-95">
                  <Upload size={13} />
                </div>
              </label>
            </div>
            <div className="flex-1 min-w-0">
              <label className="text-[13px] font-medium text-muted-foreground">人设名称</label>
              <Input
                placeholder="对话中 AI 如何称呼你"
                value={form.name}
                onChange={(e) => updateForm({ name: e.target.value })}
                className="mt-1.5"
              />
            </div>
          </div>

          {/* 人设描述 */}
          <div>
            <p className="text-[13px] font-medium text-muted-foreground mb-1.5">人设描述</p>
            <Textarea
              placeholder="你是谁、性格、背景、说话方式等。开启注入后此内容会进入提示词；留空则只生效名称。"
              value={form.description}
              onChange={(e) => updateForm({ description: e.target.value })}
              rows={6}
            />
          </div>

          {/* 注入提示词开关 */}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">注入提示词</p>
              <p className="text-xs text-muted-foreground mt-0.5">关闭后仅人设名称生效（作为对话中的称呼）</p>
            </div>
            <Switch
              checked={form.personaShow}
              onCheckedChange={(checked) => updateForm({ personaShow: checked })}
            />
          </div>

          {/* 注入位置（对齐 ST persona_description_position 语义） */}
          {form.personaShow && (
            <div className="flex items-center justify-between gap-4">
              <p className="text-[13px] font-medium text-muted-foreground shrink-0">注入位置</p>
              <select
                value={form.position}
                onChange={(e) => updateForm({ position: Number(e.target.value) })}
                className="h-9 rounded-lg bg-secondary border border-border px-3 text-[13px] outline-none max-w-[70%]"
              >
                {POSITION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* 注入深度（仅 ST AT_DEPTH=4 时生效，personas.js:632） */}
          {form.personaShow && form.position === 4 && (
            <div className="flex items-center justify-between gap-4">
              <p className="text-[13px] font-medium text-muted-foreground shrink-0">注入深度</p>
              <input
                type="number"
                min={0}
                max={99}
                value={form.depth}
                onChange={(e) => updateForm({ depth: Math.max(0, Number(e.target.value) || 0) })}
                className="h-9 rounded-lg bg-secondary border border-border px-3 text-[13px] outline-none w-24 text-right"
              />
            </div>
          )}

          {/* 默认人设 */}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-snug">设为默认人设</p>
              <p className="text-xs text-muted-foreground mt-0.5">未指定时新会话使用该人设</p>
            </div>
            <Switch
              checked={form.isDefault}
              onCheckedChange={(checked) => updateForm({ isDefault: checked })}
            />
          </div>

          {/* 删除（两击确认） */}
          <div className="pt-2">
            <Button
              variant="ghost"
              onClick={handleDeleteClick}
              className={cn(
                'h-9 rounded-md px-3 text-xs',
                confirmDelete ? 'bg-destructive/10 text-destructive hover:bg-destructive/20' : 'text-destructive hover:bg-destructive/10'
              )}
            >
              <Trash2 size={14} className="mr-1.5" />
              {confirmDelete ? '再点一次确认删除' : '删除此人设'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="max-w-2xl py-10 text-center">
          <User size={28} className="mx-auto text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mt-3">
            还没有人设。点上方「新建人设」创建你的用户资料卡。
          </p>
        </div>
      )}
    </div>
  );
}
