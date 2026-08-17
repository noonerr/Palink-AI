import React, { useState, useEffect } from 'react';
import { Palette, Image, Zap, Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CharacterUIConfig } from '@/types';

interface CharacterUIEditorProps {
  config: CharacterUIConfig;
  onChange: (config: CharacterUIConfig) => void;
}

export const CharacterUIEditor = ({ config, onChange }: CharacterUIEditorProps) => {
  const [activeTab, setActiveTab] = useState('theme');

  const updateConfig = (updates: Partial<CharacterUIConfig>) => {
    onChange({ ...config, ...updates });
  };

  return (
    <div className="space-y-4">
      <Tabs defaultValue={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid grid-cols-4 mb-4">
          <TabsTrigger value="theme" className="flex items-center gap-1">
            <Palette size={14} /> <span className="hidden sm:inline">主题</span>
          </TabsTrigger>
          <TabsTrigger value="background" className="flex items-center gap-1">
            <Image size={14} /> <span className="hidden sm:inline">背景</span>
          </TabsTrigger>
          <TabsTrigger value="bubbles" className="flex items-center gap-1">
            <Settings size={14} /> <span className="hidden sm:inline">气泡</span>
          </TabsTrigger>
          <TabsTrigger value="effects" className="flex items-center gap-1">
            <Zap size={14} /> <span className="hidden sm:inline">特效</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="theme" className="space-y-4">
          <div className="space-y-3">
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">主色调</label>
              <div className="flex gap-2">
                <Input
                  type="color"
                  value={config.theme?.primary_color || '#3b82f6'}
                  onChange={(e) => updateConfig({ theme: { ...config.theme, primary_color: e.target.value } })}
                  className="w-16 h-10 p-0"
                />
                <Input
                  type="text"
                  value={config.theme?.primary_color || '#3b82f6'}
                  onChange={(e) => updateConfig({ theme: { ...config.theme, primary_color: e.target.value } })}
                  className="flex-1"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-muted-foreground mb-1 block">次色调</label>
              <div className="flex gap-2">
                <Input
                  type="color"
                  value={config.theme?.secondary_color || '#8b5cf6'}
                  onChange={(e) => updateConfig({ theme: { ...config.theme, secondary_color: e.target.value } })}
                  className="w-16 h-10 p-0"
                />
                <Input
                  type="text"
                  value={config.theme?.secondary_color || '#8b5cf6'}
                  onChange={(e) => updateConfig({ theme: { ...config.theme, secondary_color: e.target.value } })}
                  className="flex-1"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-muted-foreground mb-1 block">强调色</label>
              <div className="flex gap-2">
                <Input
                  type="color"
                  value={config.theme?.accent_color || '#10b981'}
                  onChange={(e) => updateConfig({ theme: { ...config.theme, accent_color: e.target.value } })}
                  className="w-16 h-10 p-0"
                />
                <Input
                  type="text"
                  value={config.theme?.accent_color || '#10b981'}
                  onChange={(e) => updateConfig({ theme: { ...config.theme, accent_color: e.target.value } })}
                  className="flex-1"
                />
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="background" className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">背景类型</span>
              <select
                value={config.background?.type || 'none'}
                onChange={(e) => updateConfig({
                  background: { ...config.background, type: e.target.value as any }
                })}
                className="bg-background border border-border rounded px-2 py-1 text-sm"
              >
                <option value="none">无</option>
                <option value="color">纯色</option>
                <option value="image">图片</option>
                <option value="aurora">极光</option>
              </select>
            </div>

            {config.background?.type === 'color' && (
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">背景色</label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    value={config.background?.color || '#1e293b'}
                    onChange={(e) => updateConfig({
                      background: { ...config.background, color: e.target.value }
                    })}
                    className="w-16 h-10 p-0"
                  />
                  <Input
                    type="text"
                    value={config.background?.color || '#1e293b'}
                    onChange={(e) => updateConfig({
                      background: { ...config.background, color: e.target.value }
                    })}
                    className="flex-1"
                  />
                </div>
              </div>
            )}

            {config.background?.type === 'image' && (
              <div className="space-y-3">
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">图片 URL</label>
                  <Input
                    type="text"
                    placeholder="https://..."
                    value={config.background?.image_url || ''}
                    onChange={(e) => updateConfig({
                      background: { ...config.background, image_url: e.target.value }
                    })}
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">
                    模糊度: {config.background?.image_blur || 0}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="20"
                    value={config.background?.image_blur || 0}
                    onChange={(e) => updateConfig({
                      background: { ...config.background, image_blur: Number(e.target.value) }
                    })}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">
                    透明度: {config.background?.image_opacity || 100}%
                  </label>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={config.background?.image_opacity || 100}
                    onChange={(e) => updateConfig({
                      background: { ...config.background, image_opacity: Number(e.target.value) }
                    })}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="bubbles" className="space-y-4">
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">用户气泡背景</label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    value={config.message_bubbles?.user_bg_color || '#3b82f6'}
                    onChange={(e) => updateConfig({
                      message_bubbles: { ...config.message_bubbles, user_bg_color: e.target.value }
                    })}
                    className="w-16 h-10 p-0"
                  />
                  <Input
                    type="text"
                    value={config.message_bubbles?.user_bg_color || '#3b82f6'}
                    onChange={(e) => updateConfig({
                      message_bubbles: { ...config.message_bubbles, user_bg_color: e.target.value }
                    })}
                    className="flex-1"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">用户气泡文字</label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    value={config.message_bubbles?.user_text_color || '#ffffff'}
                    onChange={(e) => updateConfig({
                      message_bubbles: { ...config.message_bubbles, user_text_color: e.target.value }
                    })}
                    className="w-16 h-10 p-0"
                  />
                  <Input
                    type="text"
                    value={config.message_bubbles?.user_text_color || '#ffffff'}
                    onChange={(e) => updateConfig({
                      message_bubbles: { ...config.message_bubbles, user_text_color: e.target.value }
                    })}
                    className="flex-1"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">角色气泡背景</label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    value={config.message_bubbles?.assistant_bg_color || '#475569'}
                    onChange={(e) => updateConfig({
                      message_bubbles: { ...config.message_bubbles, assistant_bg_color: e.target.value }
                    })}
                    className="w-16 h-10 p-0"
                  />
                  <Input
                    type="text"
                    value={config.message_bubbles?.assistant_bg_color || '#475569'}
                    onChange={(e) => updateConfig({
                      message_bubbles: { ...config.message_bubbles, assistant_bg_color: e.target.value }
                    })}
                    className="flex-1"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">角色气泡文字</label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    value={config.message_bubbles?.assistant_text_color || '#f8fafc'}
                    onChange={(e) => updateConfig({
                      message_bubbles: { ...config.message_bubbles, assistant_text_color: e.target.value }
                    })}
                    className="w-16 h-10 p-0"
                  />
                  <Input
                    type="text"
                    value={config.message_bubbles?.assistant_text_color || '#f8fafc'}
                    onChange={(e) => updateConfig({
                      message_bubbles: { ...config.message_bubbles, assistant_text_color: e.target.value }
                    })}
                    className="flex-1"
                  />
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="effects" className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">启用极光</span>
              <Switch
                checked={config.effects?.aurora_enabled || false}
                onCheckedChange={(checked) => updateConfig({
                  effects: { ...config.effects, aurora_enabled: checked }
                })}
              />
            </div>

            {config.effects?.aurora_enabled && (
              <div className="space-y-3 pt-2">
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">极光颜色 1</label>
                  <div className="flex gap-2">
                    <Input
                      type="color"
                      value={config.effects?.aurora_color1 || '#00f2ff'}
                      onChange={(e) => updateConfig({
                        effects: { ...config.effects, aurora_color1: e.target.value }
                      })}
                      className="w-16 h-10 p-0"
                    />
                    <Input
                      type="text"
                      value={config.effects?.aurora_color1 || '#00f2ff'}
                      onChange={(e) => updateConfig({
                        effects: { ...config.effects, aurora_color1: e.target.value }
                      })}
                      className="flex-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">极光颜色 2</label>
                  <div className="flex gap-2">
                    <Input
                      type="color"
                      value={config.effects?.aurora_color2 || '#4400ff'}
                      onChange={(e) => updateConfig({
                        effects: { ...config.effects, aurora_color2: e.target.value }
                      })}
                      className="w-16 h-10 p-0"
                    />
                    <Input
                      type="text"
                      value={config.effects?.aurora_color2 || '#4400ff'}
                      onChange={(e) => updateConfig({
                        effects: { ...config.effects, aurora_color2: e.target.value }
                      })}
                      className="flex-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">极光颜色 3</label>
                  <div className="flex gap-2">
                    <Input
                      type="color"
                      value={config.effects?.aurora_color3 || '#00ff88'}
                      onChange={(e) => updateConfig({
                        effects: { ...config.effects, aurora_color3: e.target.value }
                      })}
                      className="w-16 h-10 p-0"
                    />
                    <Input
                      type="text"
                      value={config.effects?.aurora_color3 || '#00ff88'}
                      onChange={(e) => updateConfig({
                        effects: { ...config.effects, aurora_color3: e.target.value }
                      })}
                      className="flex-1"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};
