import React from 'react';
import { ChevronDown, ChevronRight, Image as ImageIcon, Key, LogOut, Save, Shield, UploadCloud, User as UserIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EMOJIS } from '@/components/views/settings-constants';
import { SettingsGroup, SettingsRow, SettingsRowWide, Segmented } from './settings-ui';
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

export function ProfileTab({
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
}: ProfileTabProps) {
  return (
    <div className="animate-fade-in pb-28 max-w-lg mx-auto">
      {/* 顶部操作区：保存（事件与回调不变） */}
      <div className="flex items-center justify-end mb-4">
        <Button onClick={handleUpdateProfile} className="h-8 md:h-9 rounded-md px-4 text-xs">
          <Save size={14} className="mr-1.5" />
          {t.save || '保存更改'}
        </Button>
      </div>

      {/* 轻量头部：头像 + 昵称（无卡片无横幅） */}
      <div className="flex flex-col items-center pb-6">
        <Avatar className="w-16 h-16 ring-2 ring-border/50">
          {avatarType !== 'emoji' && <AvatarImage src={avatarUrl} />}
          <AvatarFallback className={cn('text-2xl bg-gradient-to-br from-primary/15 to-primary/5', avatarType === 'emoji' && 'text-3xl')}>
            {avatarType === 'emoji' && avatarUrl ? avatarUrl : user.username?.[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <p className="mt-2 text-base font-semibold truncate max-w-full">{newUsername || user.username}</p>
        <p className="text-xs text-muted-foreground">@{user.username}</p>
      </div>

      <div className="space-y-4 md:space-y-6">
        {/* 头像 */}
        <SettingsGroup label={t.avatar || '头像'}>
          <SettingsRowWide icon={<ImageIcon size={15} />} title="头像样式" desc="表情、本地图片或图片链接">
            <Segmented
              value={avatarType}
              onChange={setAvatarType}
              options={[
                { value: 'emoji', label: '表情' },
                { value: 'image', label: '图片' },
                { value: 'url', label: '链接' },
              ]}
            />
          </SettingsRowWide>

          {avatarType === 'image' && (
            <div className="px-4 py-4">
              <label className="block">
                <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                <div className="border-2 border-dashed border-border/80 hover:border-border rounded-xl p-5 text-center cursor-pointer transition-all duration-200 hover:bg-secondary/30 group">
                  <UploadCloud className="mx-auto text-muted-foreground/60 mb-1.5 size-6 group-hover:text-muted-foreground transition-colors" />
                  <p className="text-sm font-medium leading-snug">点击上传图片</p>
                  <p className="text-xs text-muted-foreground mt-0.5">支持 JPG、PNG、GIF</p>
                </div>
              </label>
            </div>
          )}

          {avatarType === 'emoji' && (
            <div className="px-4 py-4">
              <div className="grid grid-cols-8 gap-1.5">
                {EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => setAvatarUrl(emoji)}
                    className={cn(
                      'aspect-square flex items-center justify-center rounded-xl text-lg transition-all duration-200',
                      avatarUrl === emoji
                        ? 'bg-primary text-primary-foreground shadow-sm scale-105'
                        : 'hover:bg-secondary/80 active:scale-95'
                    )}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}

          {avatarType === 'url' && (
            <div className="px-4 py-4">
              <Input
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://example.com/avatar.png"
                className="rounded-xl"
              />
            </div>
          )}
        </SettingsGroup>

        {/* 账号 */}
        <SettingsGroup label={t.account || '账号'}>
          <SettingsRowWide icon={<UserIcon size={15} />} title="用户名" desc="聊天与应用内展示的昵称">
            <Input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="输入用户名"
              className="rounded-xl"
            />
          </SettingsRowWide>
        </SettingsGroup>

        {/* 安全 */}
        <SettingsGroup label={t.security || '安全'}>
          <SettingsRow
            icon={<Key size={15} />}
            title={t.change_pwd || '修改密码'}
            onClick={() => setShowPasswordForm(!showPasswordForm)}
          >
            <ChevronDown
              size={16}
              className={cn(
                'text-muted-foreground/60 transition-transform duration-200',
                showPasswordForm && 'rotate-180'
              )}
            />
          </SettingsRow>

          {showPasswordForm && (
            <div className="px-4 py-4 space-y-4 border-t border-border/40 bg-secondary/20">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input type="password" placeholder={t.old_pwd || '当前密码'} value={pwdOld} onChange={(e) => setPwdOld(e.target.value)} className="rounded-xl" />
                <Input type="password" placeholder={t.new_pwd || '新密码'} value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} className="rounded-xl" />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 md:h-9 rounded-md"
                  onClick={() => { setShowPasswordForm(false); setPwdOld(''); setPwdNew(''); }}
                >
                  {t.cancel || '取消'}
                </Button>
                <Button size="sm" className="h-8 md:h-9 rounded-md" onClick={handleChangePassword}>
                  {t.save || '保存'}
                </Button>
              </div>
            </div>
          )}
        </SettingsGroup>

        {/* 会话 */}
        <SettingsGroup label={t.session || '会话'}>
          <SettingsRow
            icon={<LogOut size={15} className="text-destructive" />}
            title={<span className="text-destructive">{t.logout || '退出登录'}</span>}
            onClick={onLogout}
          >
            <ChevronRight size={16} className="text-muted-foreground/50" />
          </SettingsRow>
        </SettingsGroup>
      </div>
    </div>
  );
};
