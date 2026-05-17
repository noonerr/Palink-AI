import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, User, Tag, Globe, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

interface ImportPreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterData: {
    name: string;
    description?: string;
    personality?: string;
    background?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    avatar?: string;
    tags?: string[];
    creator?: string;
    source_platform?: string;
    creator_notes?: string;
    has_character_book?: boolean;
  } | null;
  onConfirm: (editedName: string) => void;
  onCancel: () => void;
}

const platformBadgeStyles: Record<string, { bg: string; text: string; label: string }> = {
  sillytavern: { bg: 'bg-indigo-500/20', text: 'text-indigo-400', label: 'SillyTavern' },
  'character.ai': { bg: 'bg-blue-500/20', text: 'text-blue-400', label: 'Character.AI' },
  chub: { bg: 'bg-purple-500/20', text: 'text-purple-400', label: 'Chub' },
  janitor: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', label: 'Janitor' },
  default: { bg: 'bg-gray-500/20', text: 'text-gray-400', label: 'Unknown' },
};

function getPlatformBadge(platform?: string) {
  const key = platform?.toLowerCase() || 'default';
  return platformBadgeStyles[key] || platformBadgeStyles.default;
}

function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

export function ImportPreviewModal({
  open,
  onOpenChange,
  characterData,
  onConfirm,
  onCancel,
}: ImportPreviewModalProps) {
  const [editedName, setEditedName] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (open && characterData) {
      setEditedName(characterData.name);
    }
  }, [open, characterData]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel();
    onOpenChange(false);
  };

  const handleConfirm = () => {
    onConfirm(editedName.trim() || characterData?.name || '');
    onOpenChange(false);
  };

  if (!mounted || !open || !characterData) {
    return null;
  }

  const platformBadge = getPlatformBadge(characterData.source_platform);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={handleClose}
      />

      <div className="relative glass-strong rounded-2xl w-full max-w-md max-h-[85vh] overflow-hidden flex flex-col shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold">导入角色预览</h2>
          <button
            onClick={handleClose}
            className="rounded-full p-1.5 hover:bg-white/10 transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5">
          <div className="flex items-center gap-4">
            <Avatar className="size-16 rounded-xl border border-white/20 shrink-0">
              <AvatarImage src={characterData.avatar} alt={characterData.name} />
              <AvatarFallback className="rounded-xl bg-white/10">
                <User className="size-7 text-muted-foreground" />
              </AvatarFallback>
            </Avatar>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5">
                <Badge
                  className={cn(
                    'border-0 text-[11px] px-2 py-0.5',
                    platformBadge.bg,
                    platformBadge.text
                  )}
                >
                  <Globe className="size-3 mr-1" />
                  {platformBadge.label}
                </Badge>
                {characterData.has_character_book && (
                  <Badge className="border-0 bg-amber-500/20 text-amber-400 text-[11px] px-2 py-0.5">
                    <BookOpen className="size-3 mr-1" />
                    含世界书
                  </Badge>
                )}
              </div>
              <Input
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                className="text-lg font-medium h-10 bg-white/5 border-white/10"
                placeholder="角色名称"
              />
            </div>
          </div>

          {characterData.creator && (
            <div className="text-xs text-muted-foreground">
              创作者：{characterData.creator}
            </div>
          )}

          {(characterData.description || characterData.personality) && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                描述
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {truncate(
                  characterData.description ||
                    characterData.personality ||
                    characterData.background,
                  150
                )}
              </p>
            </div>
          )}

          {characterData.first_mes && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                开场白
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {truncate(characterData.first_mes, 120)}
              </p>
            </div>
          )}

          {characterData.tags && characterData.tags.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <Tag className="size-3 inline mr-1" />
                标签
              </div>
              <div className="flex flex-wrap gap-1.5">
                {characterData.tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="text-[11px] px-2 py-0.5"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {characterData.creator_notes && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                创作者备注
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground bg-white/5 rounded-lg p-3 border border-white/5">
                {truncate(characterData.creator_notes, 200)}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-white/10">
          <Button variant="ghost" onClick={handleCancel} className="h-9">
            取消
          </Button>
          <Button onClick={handleConfirm} className="h-9">
            确认导入
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};
