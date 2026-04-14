import React from 'react';
import { ChevronDown, Key, LogOut, Save, Shield, UploadCloud } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EMOJIS } from '@/components/views/settings-constants';
import type { User } from '@/types';

interface ProfileTabProps {
  t: Record<string, string>;
  user: User;
  avatarUrl: string;
  setAvatarUrl: (value: string) => void;
  avatarType: 'emoji' | 'image' | 'url';
  setAvatarType: (value: 'emoji' | 'image' | 'url') => void;
  newUsername: string;
  setNewUsername: (value: string) => void;
  showPasswordForm: boolean;
  setShowPasswordForm: (value: boolean) => void;
  pwdOld: string;
  setPwdOld: (value: string) => void;
  pwdNew: string;
  setPwdNew: (value: string) => void;
  handleImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleUpdateProfile: () => void;
  handleChangePassword: () => void;
  onLogout: () => void;
}

export const ProfileTab: React.FC<ProfileTabProps> = ({
  t,
  user,
  avatarUrl,
  setAvatarUrl,
  avatarType,
  setAvatarType,
  newUsername,
  setNewUsername,
  showPasswordForm,
  setShowPasswordForm,
  pwdOld,
  setPwdOld,
  pwdNew,
  setPwdNew,
  handleImageUpload,
  handleUpdateProfile,
  handleChangePassword,
  onLogout,
}) => {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 animate-fade-in pr-2">
        <h3 className="text-2xl font-semibold">{t.settings_profile}</h3>

        <GlassCard className="p-6">
          <div className="flex items-start gap-6">
            <Avatar className="w-20 h-20">
              <AvatarImage src={avatarUrl} />
              <AvatarFallback className="text-2xl bg-primary/10">{user.username?.[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>

            <div className="flex-1 space-y-4">
              <div className="flex gap-2">
                {(['emoji', 'image', 'url'] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setAvatarType(type)}
                    className={cn(
                      'px-3 py-1.5 text-xs rounded-full border transition-all',
                      avatarType === type
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {type === 'emoji' ? t.choose_emoji : type === 'image' ? t.upload_image : t.use_url}
                  </button>
                ))}
              </div>

              {avatarType === 'image' && (
                <label className="border-2 border-dashed border-border rounded-xl p-6 text-center hover:bg-secondary/50 transition-colors cursor-pointer block">
                  <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                  <UploadCloud className="mx-auto text-muted-foreground mb-2" size={24} />
                  <span className="text-sm text-muted-foreground">{t.click_to_upload}</span>
                </label>
              )}

              {avatarType === 'emoji' && (
                <div className="grid grid-cols-8 gap-2">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => setAvatarUrl(emoji)}
                      className={cn(
                        'p-2 hover:bg-secondary rounded-lg text-xl transition-all',
                        avatarUrl === emoji && 'bg-primary/10 ring-2 ring-primary'
                      )}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}

              {avatarType === 'url' && (
                <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://..." />
              )}
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-border/50">
            <label className="text-sm font-medium mb-2 block">{t.settings_username}</label>
            <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="Username" />
            <p className="text-xs text-muted-foreground mt-1">{t.settings_username_desc}</p>
          </div>

          <div className="mt-6 flex justify-end">
            <Button onClick={handleUpdateProfile}>
              <Save size={16} className="mr-2" />
              {t.save}
            </Button>
          </div>
        </GlassCard>

        <GlassCard className="p-6 border-destructive/50">
          <h4 className="font-semibold text-destructive mb-4 flex items-center gap-2">
            <Shield size={18} />
            {t.settings_danger_zone}
          </h4>

          <div
            className="flex items-center justify-between cursor-pointer py-3 border-b border-border/50"
            onClick={() => setShowPasswordForm(!showPasswordForm)}
          >
            <div className="flex items-center gap-2">
              <Key size={16} className="text-muted-foreground" />
              <span className="text-sm">{t.change_pwd}</span>
            </div>
            <ChevronDown size={16} className={cn('text-muted-foreground transition-transform', showPasswordForm && 'rotate-180')} />
          </div>

          {showPasswordForm && (
            <div className="mt-4 pt-4 border-t border-border/50 animate-fade-in">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input type="password" placeholder={t.old_pwd} value={pwdOld} onChange={(e) => setPwdOld(e.target.value)} />
                <Input type="password" placeholder={t.new_pwd} value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} />
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowPasswordForm(false);
                    setPwdOld('');
                    setPwdNew('');
                  }}
                >
                  {t.cancel || '取消'}
                </Button>
                <Button onClick={handleChangePassword}>{t.save || '保存'}</Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-2">
              <LogOut size={16} className="text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{t.logout}</p>
                <p className="text-xs text-muted-foreground">{t.logout_desc}</p>
              </div>
            </div>
            <Button variant="destructive" size="sm" onClick={onLogout}>
              {t.logout}
            </Button>
          </div>
        </GlassCard>
      </div>
    </ScrollArea>
  );
};
