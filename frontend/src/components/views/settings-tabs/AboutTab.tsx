import React, { useState, useEffect } from 'react';
import { Download, FlaskConical } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { api, invalidateCache } from '@/services/api';
import { toast } from 'sonner';
import {
  exportPalinkDiag,
  palinkDiagEnabled,
  setPalinkDiagEnabled,
} from '@/components/ui/custom/smart-card-runtime/palink-diag';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface AboutTabProps {
  t: Record<string, string>;
}
export function AboutTab({ t }: AboutTabProps) {
  const [developerMode, setDeveloperMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [diagRecording, setDiagRecording] = useState(() => palinkDiagEnabled());

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await api.get('/api/users/me/settings', { cacheTtlMs: 30_000 });
        setDeveloperMode(settings.developer_mode === true);
        // [包W] 开发者模式打开 ⇒ 诊断记录全量开（只单向打开，不覆盖用户在本页设的手动开关）。
        if (settings.developer_mode === true) setPalinkDiagEnabled(true, true);
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
      setPalinkDiagEnabled(checked, true);
      window.dispatchEvent(new CustomEvent('userSettingsUpdated'));
      toast.success(checked ? '开发者模式已开启' : '开发者模式已关闭');
    } catch (error) {
      console.error('Failed to update developer mode:', error);
      toast.error('保存开发者模式设置失败');
    }
  };

  const handleDiagToggle = (checked: boolean) => {
    setPalinkDiagEnabled(checked, true);
    setDiagRecording(checked);
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
            {/* [包W 2026-10-19] 静默失败诊断：本机记录 + 手动开关 + 本地导出（零上传、零弹框）。 */}
            <SettingsRow
              icon={<Download size={15} />}
              title="记录静默失败"
              desc="开启后，兼容层里「什么都没发生」的路径会在控制台打一行汇总，可用 window.__palinkDiagDump() 读取或在此导出。只写本机，不上传任何地址。"
            >
              <Switch checked={diagRecording} onCheckedChange={handleDiagToggle} />
            </SettingsRow>
            <SettingsRow
              icon={<Download size={15} />}
              title="导出诊断"
              desc="把当前记录的静默失败下载为 JSON（含每条的「该谁修」归属标签），供排查与派单使用。"
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  exportPalinkDiag(`palink-diag-${new Date().toISOString().slice(0, 10)}.json`);
                }}
              >
                导出 JSON
              </Button>
            </SettingsRow>
          </SettingsGroup>
        </div>
    </div>
  );
};
