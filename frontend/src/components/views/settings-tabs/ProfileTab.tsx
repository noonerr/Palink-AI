import React from 'react';
import { ChevronDown, Key, LogOut, Save, Shield, UploadCloud, User } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
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
    <ScrollArea className="h-full">
      <div className="space-y-8 animate-fade-in pr-2 pb-28 max-w-lg mx-auto">

        <div className="flex flex-col items-center text-center pt-4 pb-2">
          <div className="relative group">
            <Avatar className="w-24 h-24 ring-4 ring-primary/10 transition-all duration-300 group-hover:ring-primary/20 group-hover:scale-[1.02]">
              {avatarType !== 'emoji' && <AvatarImage src={avatarUrl} />}
              <AvatarFallback className={cn("text-3xl bg-gradient-to-br from-primary/15 to-primary/5", avatarType === 'emoji' && "text-4xl")}>
                {avatarType === 'emoji' && avatarUrl ? avatarUrl : user.username?.[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-primary rounded-full flex items-center justify-center shadow-lg shadow-primary/30">
              <User size={12} className="text-primary-foreground" />
            </div>
          </div>

          <h3 className="mt-5 text-xl font-semibold tracking-tight">{t.settings_profile}</h3>
          <p className="text-sm text-muted-foreground mt-1">@{user.username}</p>
        </div>

        <div className="bg-card/60 backdrop-blur-sm border border-border/50 rounded-2xl p-6 space-y-6">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider text-xs">头像</span>
            <div className="flex gap-1 p-1 bg-secondary/60 rounded-xl">
              {(['emoji', 'image', 'url'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setAvatarType(type)}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium rounded-lg transition-all",
                    avatarType === type
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {type === 'emoji' ? '表情' : type === 'image' ? '图片' : '链接'}
                </button>
              ))}
            </div>
          </div>

          {avatarType === 'image' && (
            <label className="block">
              <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
              <div className="border-2 border-dashed border-border/80 hover:border-border rounded-2xl p-8 text-center cursor-pointer transition-all hover:bg-secondary/30 group">
                <UploadCloud className="mx-auto text-muted-foreground/60 mb-3 size-8 group-hover:text-muted-foreground transition-colors" />
                <p className="text-sm text-muted-foreground/80 font-medium">点击上传图片</p>
                <p className="text-xs text-muted-foreground/40 mt-1">支持 JPG、PNG、GIF</p>
              </div>
            </label>
          )}

          {avatarType === 'emoji' && (
            <div className="grid grid-cols-8 gap-1.5">
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => setAvatarUrl(emoji)}
                  className={cn(
                    "aspect-square flex items-center justify-center rounded-xl text-lg transition-all",
                    avatarUrl === emoji
                      ? "bg-primary text-primary-foreground shadow-md scale-105"
                      : "hover:bg-secondary/80 active:scale-90"
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}

          {avatarType === 'url' && (
            <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://example.com/avatar.png" className="rounded-xl" />
          )}
        </div>

        <div className="bg-card/60 backdrop-blur-sm border border-border/50 rounded-2xl p-6 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider text-xs block mb-3">用户名</span>
            <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="输入用户名" className="rounded-xl h-12 text-base" />
          </label>
          <Button onClick={handleUpdateProfile} className="w-full rounded-xl h-11 font-medium" size="lg">
            <Save size={16} className="mr-2" />
            {t.save || '保存更改'}
          </Button>
        </div>

        <div className="bg-card/60 backdrop-blur-sm border border-border/50 rounded-2xl overflow-hidden">
          <div
            className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-destructive/[0.03] transition-colors select-none"
            onClick={() => setShowPasswordForm(!showPasswordForm)}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-destructive/10 flex items-center justify-center">
                <Key size={16} className="text-destructive" />
              </div>
              <div>
                <p className="text-sm font-medium">{t.change_pwd || '修改密码'}</p>
                <p className="text-xs text-muted-foreground mt-0.5">定期更新密码以保护账户安全</p>
              </div>
            </div>
            <ChevronDown size={16} className={cn('text-muted-foreground transition-transform duration-200', showPasswordForm && 'rotate-180')} />
          </div>

          {showPasswordForm && (
            <div className="px-6 pb-6 pt-2 space-y-4 animate-fade-in border-t border-border/30 mt-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input type="password" placeholder={t.old_pwd || '当前密码'} value={pwdOld} onChange={(e) => setPwdOld(e.target.value)} className="rounded-xl" />
                <Input type="password" placeholder={t.new_pwd || '新密码'} value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} className="rounded-xl" />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" size="sm" className="rounded-lg"
                  onClick={() => { setShowPasswordForm(false); setPwdOld(''); setPwdNew(''); }}
                >{t.cancel || '取消'}</Button>
                <Button size="sm" className="rounded-lg" onClick={handleChangePassword}>{t.save || '保存'}</Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-2 py-3">
          <div className="flex items-center gap-3">
            <LogOut size={18} className="text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{t.logout || '退出登录'}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t.logout_desc || '安全退出当前账户'}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10 rounded-xl" onClick={onLogout}>
            {t.logout || '退出'}
          </Button>
        </div>

      </div>
    </ScrollArea>
  );
};
