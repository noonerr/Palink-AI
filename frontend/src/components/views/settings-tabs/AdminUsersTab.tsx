import React from 'react';
import { Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { User } from '@/types';

interface AdminUsersTabProps {
  t: Record<string, string>;
  usersList: User[];
  handleDeleteUser: (userId: string) => void;
}

export function AdminUsersTab({ t, usersList, handleDeleteUser }: AdminUsersTabProps) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 animate-fade-in pr-2 pb-28">
        <h3 className="text-2xl font-semibold">{t.admin_users}</h3>

        <div className="space-y-2">
          {usersList.map((u) => (
            <GlassCard key={u.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <Avatar>
                    <AvatarImage src={u.avatar} />
                    <AvatarFallback>{u.username?.[0]?.toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{u.username}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.role}: {u.role} • 存储空间: {((u.storage_used || 0) / 1024 / 1024).toFixed(1)}MB • 对话: {u.chat_count}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      对话Tokens: {u.tokens_chat || 0} • 工作空间Tokens: {u.tokens_workspace || 0} • 角色扮演Tokens: {u.tokens_character || 0} • 总计: {u.tokens_total || 0}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => handleDeleteUser(u.id)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
};
