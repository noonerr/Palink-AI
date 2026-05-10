import React, { useState, useEffect } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { api } from '@/services/api';
import { toast } from 'sonner';

interface AboutTabProps {
  t: Record<string, string>;
}
export const AboutTab: React.FC<AboutTabProps> = ({ t }) => {
  const [developerMode, setDeveloperMode] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await api.get('/api/users/me/settings');
        setDeveloperMode(settings.developer_mode === true);
      } catch (error) {
        console.error('Failed to fetch settings:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchSettings();
  }, []);

  const handleDeveloperModeToggle = async (checked: boolean) => {
    try {
      await api.put('/api/users/me/settings', { developer_mode: checked });
      setDeveloperMode(checked);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated'));
      toast.success(checked ? '开发者模式已开启' : '开发者模式已关闭');
    } catch (error) {
      console.error('Failed to update developer mode:', error);
      toast.error('保存开发者模式设置失败');
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="text-center py-12 animate-fade-in pr-2 pb-28">
        <div className="w-24 h-24 bg-gradient-to-br from-primary to-primary/60 rounded-3xl mx-auto flex items-center justify-center mb-6 shadow-xl shadow-primary/20">
          <span className="text-primary-foreground text-4xl font-bold">P</span>
        </div>
        <h2 className="text-2xl font-semibold mb-2">{t.about_title}</h2>
        <p className="text-muted-foreground mb-8">{t.about_desc}</p>
        <div className="flex justify-center gap-4 text-sm text-muted-foreground mb-8">
          <span>{t.version}</span>
          <span>•</span>
          <span>{t.privacy_policy}</span>
        </div>

        {/* 开发者模式开关 */}
        <div className="max-w-md mx-auto mt-8 p-4 border rounded-lg bg-card">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="developer-mode" className="text-base">
                开发者模式
              </Label>
              <p className="text-sm text-muted-foreground">
                启用后可在本地模型中看到测试模型，用于功能测试
              </p>
            </div>
            <Switch
              id="developer-mode"
              checked={developerMode}
           onCheckedChange={handleDeveloperModeToggle}
              disabled={loading}
        />
          </div>
        </div>
      </div>
    </ScrollArea>
  );
};
