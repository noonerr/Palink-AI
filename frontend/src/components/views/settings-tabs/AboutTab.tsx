import React, { useState, useEffect } from 'react';
import { FlaskConical } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { api, invalidateCache } from '@/services/api';
import { toast } from 'sonner';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface AboutTabProps {
  t: Record<string, string>;
}
export function AboutTab({ t }: AboutTabProps) {
  const [developerMode, setDeveloperMode] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await api.get('/api/users/me/settings', { cacheTtlMs: 30_000 });
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
      invalidateCache('/api/users/me/settings');
      invalidateCache('/api/models');
      setDeveloperMode(checked);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated'));
      toast.success(checked ? '开发者模式已开启' : '开发者模式已关闭');
    } catch (error) {
      console.error('Failed to update developer mode:', error);
      toast.error('保存开发者模式设置失败');
    }
  };

  return (
    <div className="text-center py-12 animate-fade-in pb-28">
        <div className="w-24 h-24 bg-gradient-to-br from-primary to-primary/60 rounded-3xl mx-auto flex items-center justify-center mb-6 shadow-xl shadow-primary/20">
          <span className="text-primary-foreground text-4xl font-bold">P</span>
        </div>
        <p className="text-muted-foreground mb-8">{t.about_desc}</p>
        <div className="flex justify-center gap-4 text-sm text-muted-foreground mb-8">
          <span>{t.version}</span>
          <span>•</span>
          <span>{t.privacy_policy}</span>
        </div>

        {/* 开发者模式开关 */}
        <div className="max-w-md mx-auto mt-8 text-left">
          <SettingsGroup label="开发者">
            <SettingsRow
              icon={<FlaskConical size={15} />}
              title="开发者模式"
            >
              <Switch
                checked={developerMode}
                onCheckedChange={handleDeveloperModeToggle}
                disabled={loading}
              />
            </SettingsRow>
          </SettingsGroup>
        </div>
    </div>
  );
};
