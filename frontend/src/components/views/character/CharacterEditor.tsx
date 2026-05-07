/**
 * CharacterEditor — 角色编辑/创建表单
 * 从 CharacterView 提取的子组件
 */
import React, { useEffect, useRef, useCallback } from 'react';
import { X, Save, Image } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import type { Character } from '@/types';

// 弹簧效果参数（与 ChatViewMobile 保持一致）
const OVERSCROLL_RESISTANCE = 0.18;
const OVERSCROLL_DURATION_MS = 800;
const OVERSCROLL_SPRING_CURVE = 'cubic-bezier(0.18, 0.89, 0.32, 1)';

export interface CharacterEditorProps {
  selectedCharacter: Character | null;
  editingCharacter: Partial<Character>;
  onSetEditingCharacter: React.Dispatch<React.SetStateAction<Partial<Character>>>;
  onSave: () => void;
  onCancel: () => void;
  onImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const CharacterEditor: React.FC<CharacterEditorProps> = ({
  selectedCharacter,
  editingCharacter,
  onSetEditingCharacter,
  onSave,
  onCancel,
  onImageUpload,
}) => {
  const headerClass = "min-h-[64px] flex items-center justify-between px-6 border-b border-border/50 glass z-10 flex-shrink-0 py-2";
  const bottomPadding = useMobileBottomPadding();
  
  // 弹簧效果状态
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef(0);
  const lastTouchY = useRef(0);
  const lastTouchTime = useRef(0);
  const touchVelocityY = useRef(0);
  const isTouchingRef = useRef(false);
  const isBouncing = useRef(false);
  const overscrollYRef = useRef(0);

  // 直接操作 DOM 更新弹簧偏移
  const updateOverscrollDOM = useCallback((y: number, hasTransition: boolean, durationMs?: number) => {
    const el = scrollWrapRef.current;
    if (!el) return;
    overscrollYRef.current = y;
    if (hasTransition) {
      const dur = durationMs ?? OVERSCROLL_DURATION_MS;
      el.style.transition = `transform ${dur}ms ${OVERSCROLL_SPRING_CURVE}`;
    } else {
      el.style.transition = 'none';
    }
    el.style.transform = `translateY(${y}px)`;
  }, []);

  // 触摸开始
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    isTouchingRef.current = true;
    updateOverscrollDOM(overscrollYRef.current, false);
    touchStartY.current = e.touches[0].clientY;
    lastTouchY.current = e.touches[0].clientY;
    lastTouchTime.current = performance.now();
    touchVelocityY.current = 0;
  }, [updateOverscrollDOM]);

  // 触摸移动
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const el = scrollWrapRef.current;
    if (!el) return;

    const touchY = e.touches[0].clientY;
    const now = performance.now();
    const dt = now - lastTouchTime.current;
    if (dt > 0) {
      const instantV = (touchY - lastTouchY.current) / dt;
      touchVelocityY.current = touchVelocityY.current * 0.6 + instantV * 0.4;
    }
    lastTouchY.current = touchY;
    lastTouchTime.current = now;

    const delta = touchY - touchStartY.current;
    const scrollTop = el.scrollTop;
    const isAtTop = scrollTop <= 0;
    const isAtBottom = scrollTop + el.clientHeight >= el.scrollHeight - 1;

    const draggingPastTop = isAtTop && delta > 0;
    const draggingPastBottom = isAtBottom && delta < 0;

    if (!draggingPastTop && !draggingPastBottom) {
      if (isBouncing.current) {
        isBouncing.current = false;
        updateOverscrollDOM(0, true);
      }
      return;
    }

    isBouncing.current = true;
    e.preventDefault();

    const absDelta = Math.abs(delta);
    const progressiveResistance = OVERSCROLL_RESISTANCE / (1 + absDelta * 0.002);
    const y = delta * progressiveResistance;
    updateOverscrollDOM(y, false);
  }, [updateOverscrollDOM]);

  // 触摸结束
  const handleTouchEnd = useCallback(() => {
    isTouchingRef.current = false;
    touchStartY.current = 0;
    if (!isBouncing.current) {
      updateOverscrollDOM(0, true);
      return;
    }
    isBouncing.current = false;

    const velocity = touchVelocityY.current;
    const currentOffset = overscrollYRef.current;
    const absVelocity = Math.abs(velocity);
    const inertiaBoost = Math.min(absVelocity * 80, 40);
    const overshootY = currentOffset > 0
      ? Math.min(currentOffset + inertiaBoost, 120)
      : Math.max(currentOffset - inertiaBoost, -120);
    const bounceDuration = Math.min(OVERSCROLL_DURATION_MS + absVelocity * 200, 1200);

    updateOverscrollDOM(overshootY, true, bounceDuration * 0.25);

    setTimeout(() => {
      updateOverscrollDOM(0, true, bounceDuration * 0.75);
    }, bounceDuration * 0.25);

    touchVelocityY.current = 0;
  }, [updateOverscrollDOM]);

  // 触摸取消
  const handleTouchCancel = useCallback(() => {
    isTouchingRef.current = false;
    isBouncing.current = false;
    touchVelocityY.current = 0;
    updateOverscrollDOM(0, true);
    touchStartY.current = 0;
  }, [updateOverscrollDOM]);

  // 组件卸载/重置时清理
  useEffect(() => {
    const forceResetOverscroll = () => {
      isTouchingRef.current = false;
      isBouncing.current = false;
      updateOverscrollDOM(0, true);
      touchStartY.current = 0;
    };
    window.addEventListener('touchend', forceResetOverscroll, { passive: true });
    window.addEventListener('touchcancel', forceResetOverscroll, { passive: true });
    return () => {
      window.removeEventListener('touchend', forceResetOverscroll);
      window.removeEventListener('touchcancel', forceResetOverscroll);
    };
  }, [updateOverscrollDOM]);

  return (
    <div className="flex-1 flex flex-col w-full h-full overflow-hidden">
      <div className={headerClass} style={{ paddingTop: `max(env(safe-area-inset-top), 0px)` }}>
        <h1 className="text-base font-semibold text-foreground truncate">
          {selectedCharacter ? '编辑角色' : '创建角色'}
        </h1>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onCancel}>
            <X size={18} className="mr-2" />
            返回
          </Button>
        </div>
      </div>
      
      {/* 包裹滚动区域，添加弹簧效果 */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollWrapRef}
          className="absolute inset-0 overflow-y-auto px-6 py-6 will-change-transform"
          style={{ overscrollBehaviorY: 'none', touchAction: 'pan-y' }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
        >
          <div className={`max-w-4xl mx-auto w-full ${bottomPadding}`}>
            <div className="p-4 md:p-8 glass-strong rounded-2xl space-y-6 md:space-y-8">
              <div className="flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-8">
                <div className="relative shrink-0">
                  <div className="w-24 h-24 md:w-32 md:h-32 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl flex items-center justify-center text-4xl md:text-5xl shadow-xl shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
                    {editingCharacter.avatar ? (
                      <img src={editingCharacter.avatar} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span>{editingCharacter.name?.[0]?.toUpperCase() || '?'}</span>
                    )}
                  </div>
                  <label className="absolute bottom-0 right-0 p-2.5 bg-primary rounded-full cursor-pointer hover:bg-primary/90 active:bg-primary/80 transition-colors shadow-lg shadow-primary/25">
                    <Image size={18} className="text-primary-foreground" />
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={onImageUpload}
                    />
                  </label>
                </div>

                <div className="flex-1 space-y-3 md:space-y-4 w-full">
                  <div>
                    <label className="text-sm font-semibold mb-2 block">角色名称</label>
                    <Input
                      placeholder="输入角色名称"
                      value={editingCharacter.name || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, name: e.target.value }))}
                      className="touch-input"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold mb-2 block">创建者</label>
                    <Input
                      placeholder="角色创建者名称"
                      value={editingCharacter.creator || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, creator: e.target.value }))}
                      className="touch-input"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold mb-2 block">标签</label>
                    <Input
                      placeholder="用逗号分隔多个标签"
                      value={editingCharacter.tags?.join(', ') || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, tags: e.target.value.split(',').map(t => t.trim()).filter(t => t) }))}
                      className="touch-input"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold mb-2 block">用户称呼</label>
                    <Input
                      placeholder="角色对你的称呼（留空则使用默认昵称）"
                      value={editingCharacter.user_nickname || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, user_nickname: e.target.value }))}
                      className="touch-input"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                <div className="space-y-6">
                  <div>
                    <label className="text-sm font-semibold mb-2 block">角色描述</label>
                    <Textarea
                      placeholder="描述这个角色的外貌、特点等基本信息"
                      value={editingCharacter.description || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, description: e.target.value }))}
                      className="h-32"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold mb-2 block">性格特点</label>
                    <Textarea
                      placeholder="描述这个角色的性格特点"
                      value={editingCharacter.personality || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, personality: e.target.value }))}
                      className="h-32"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold mb-2 block">场景</label>
                    <Textarea
                      placeholder="角色所处的场景或环境"
                      value={editingCharacter.scenario || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, scenario: e.target.value }))}
                      className="h-32"
                    />
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <label className="text-sm font-semibold mb-2 block">背景故事</label>
                    <Textarea
                      placeholder="讲述这个角色的背景故事"
                      value={editingCharacter.background || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, background: e.target.value }))}
                      className="h-32"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold mb-2 block">第一条消息</label>
                    <Textarea
                      placeholder="角色的第一条消息，设定对话风格"
                      value={editingCharacter.first_mes || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, first_mes: e.target.value }))}
                      className="h-32"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold mb-2 block">系统提示</label>
                    <Textarea
                      placeholder="自定义系统提示词"
                      value={editingCharacter.system_prompt || ''}
                      onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, system_prompt: e.target.value }))}
                      className="h-32"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="text-sm font-semibold mb-2 block">对话示例</label>
                <Textarea
                  placeholder="使用 <START> 标记分隔不同示例对话，使用 {{char}} 和 {{user}} 作为占位符"
                  value={editingCharacter.mes_example || ''}
                  onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, mes_example: e.target.value }))}
                  className="h-48"
                />
              </div>

              <div className="flex flex-col sm:flex-row justify-end gap-3 pt-6 border-t border-border/50">
                <Button variant="secondary" onClick={onCancel} className="min-h-[44px] order-2 sm:order-1">
                  取消
                </Button>
                <Button onClick={onSave} className="min-h-[44px] order-1 sm:order-2">
                  <Save size={18} className="mr-2" />
                  保存
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
