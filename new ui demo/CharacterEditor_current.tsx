/**
 * CharacterEditor — 角色编辑/创建表单
 * 从 CharacterView 提取的子组件
 */
import React from 'react';
import { X, Save, Image } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useMobileBottomPadding } from '@/hooks/useMobileBottomPadding';
import type { Character } from '@/types';

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
  const headerClass = "h-[64px] flex items-center justify-between px-6 border-b border-border/50 glass z-10 flex-shrink-0";
  const bottomPadding = useMobileBottomPadding();
  
  return (
    <div className="flex-1 flex flex-col w-full h-full overflow-hidden">
      <div className={headerClass}>
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
      
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className={`max-w-4xl mx-auto w-full ${bottomPadding}`}>
          <div className="p-8 glass-strong rounded-2xl space-y-8">
            <div className="flex items-start gap-8">
              <div className="relative">
                <div className="w-32 h-32 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl flex items-center justify-center text-5xl shadow-xl shadow-primary/10 ring-1 ring-primary/20 overflow-hidden">
                  {editingCharacter.avatar ? (
                    <img src={editingCharacter.avatar} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span>{editingCharacter.name?.[0]?.toUpperCase() || '?'}</span>
                  )}
                </div>
                <label className="absolute bottom-0 right-0 p-2.5 bg-primary rounded-full cursor-pointer hover:bg-primary/90 transition-colors shadow-lg shadow-primary/25">
                  <Image size={18} className="text-primary-foreground" />
                  <input 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    onChange={onImageUpload}
                  />
                </label>
              </div>
              
              <div className="flex-1 space-y-4">
                <div>
                  <label className="text-sm font-semibold mb-2 block">角色名称</label>
                  <Input 
                    placeholder="输入角色名称" 
                    value={editingCharacter.name || ''}
                    onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, name: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold mb-2 block">创建者</label>
                  <Input 
                    placeholder="角色创建者名称" 
                    value={editingCharacter.creator || ''}
                    onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, creator: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold mb-2 block">标签</label>
                  <Input 
                    placeholder="用逗号分隔多个标签" 
                    value={editingCharacter.tags?.join(', ') || ''}
                    onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, tags: e.target.value.split(',').map(t => t.trim()).filter(t => t) }))}
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold mb-2 block">用户称呼</label>
                  <Input 
                    placeholder="角色对你的称呼（留空则使用默认昵称）" 
                    value={editingCharacter.user_nickname || ''}
                    onChange={(e) => onSetEditingCharacter(prev => ({ ...prev, user_nickname: e.target.value }))}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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

            <div className="flex justify-end gap-4 pt-6 border-t border-border/50">
              <Button variant="secondary" onClick={onCancel}>
                取消
              </Button>
              <Button onClick={onSave}>
                <Save size={18} className="mr-2" />
                保存
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
