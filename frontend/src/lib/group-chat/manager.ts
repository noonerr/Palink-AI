/**
 * 群聊管理器
 * 管理群聊的创建、编辑、成员管理
 */

import type { GroupChat, GroupMember, GroupChatMessage, GroupMemberProfile } from './types';
import { GroupActivationStrategy, GroupGenerationMode } from './types';
import { createActivationStrategy, type ActivationStrategy } from './activation';
import { emitEvent } from '../event-bus';
import { getGlobalSillyTavernRuntime } from '../sillytavern/runtime';
import { api } from '@/services/api';

/**
 * 群聊管理器
 */
export class GroupChatManager {
  private groups: Map<string, GroupChat> = new Map();
  private activeGroupId: string | null = null;
  private strategies: Map<string, ActivationStrategy> = new Map();

  /**
   * 创建群聊
   */
  createGroup(name: string, options?: Partial<GroupChat>): GroupChat {
    const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const group: GroupChat = {
      id,
      name,
      members: [],
      activationStrategy: GroupActivationStrategy.NATURAL,
      generationMode: GroupGenerationMode.SWAP,
      allowSelfResponses: false,
      enableGroupExpressions: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      extensions: {},
      ...options,
    };

    this.groups.set(id, group);
    this.strategies.set(id, createActivationStrategy(group.activationStrategy));

    emitEvent('group:created', { groupId: id });
    // K-6 修复: 对齐 ST group-chats.js:319 —— 新建群聊后触发 group_chat_created（无参），
    // quick-reply 的"新群聊自动执行"依赖该事件。
    try {
      getGlobalSillyTavernRuntime()?.getEventSource().emit('group_chat_created');
    } catch { /* 运行时未初始化时静默跳过 */ }
    this._persistAsync(id);
    return group;
  }

  /**
   * 获取群聊
   */
  getGroup(id: string): GroupChat | undefined {
    return this.groups.get(id);
  }

  /**
   * 获取所有群聊
   */
  getAllGroups(): GroupChat[] {
    return Array.from(this.groups.values());
  }

  /**
   * 更新群聊
   */
  updateGroup(id: string, updates: Partial<GroupChat>): GroupChat | undefined {
    const group = this.groups.get(id);
    if (!group) return undefined;

    const updated = { ...group, ...updates, updatedAt: new Date().toISOString() };
    this.groups.set(id, updated);

    // 更新激活策略
    if (updates.activationStrategy !== undefined) {
      this.strategies.set(id, createActivationStrategy(updated.activationStrategy));
    }

    emitEvent('group:updated', { groupId: id });
    this._persistAsync(id);
    return updated;
  }

  /**
   * 删除群聊
   */
  deleteGroup(id: string): boolean {
    const deleted = this.groups.delete(id);
    if (deleted) {
      this.strategies.delete(id);
      if (this.activeGroupId === id) {
        this.activeGroupId = null;
      }
      emitEvent('group:deleted', { groupId: id });
      this._deleteFromBackendAsync(id);
    }
    return deleted;
  }

  /**
   * 添加成员
   */
  addMember(groupId: string, member: GroupMember): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    // 检查是否已存在
    if (group.members.some(m => m.characterId === member.characterId)) {
      return false;
    }

    group.members.push({
      ...member,
      position: member.position ?? group.members.length,
      probability: member.probability ?? 50,
    });
    group.updatedAt = new Date().toISOString();

    emitEvent('group:memberAdded', { groupId, characterId: member.characterId });
    this._persistAsync(groupId);
    return true;
  }

  /**
   * 移除成员
   */
  removeMember(groupId: string, characterId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    const index = group.members.findIndex(m => m.characterId === characterId);
    if (index < 0) return false;

    group.members.splice(index, 1);
    group.updatedAt = new Date().toISOString();

    emitEvent('group:memberRemoved', { groupId, characterId });
    this._persistAsync(groupId);
    return true;
  }

  /**
   * 更新成员
   */
  updateMember(groupId: string, characterId: string, updates: Partial<GroupMember>): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    const member = group.members.find(m => m.characterId === characterId);
    if (!member) return false;

    Object.assign(member, updates);
    group.updatedAt = new Date().toISOString();
    this._persistAsync(groupId);
    return true;
  }

  /**
   * 静音/取消静音成员
   */
  toggleMute(groupId: string, characterId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    const member = group.members.find(m => m.characterId === characterId);
    if (!member) return false;

    member.isMuted = !member.isMuted;
    group.updatedAt = new Date().toISOString();
    this._persistAsync(groupId);
    return true;
  }

  /**
   * 设置活跃群聊
   */
  setActiveGroup(groupId: string | null): void {
    this.activeGroupId = groupId;
  }

  /**
   * 获取活跃群聊
   */
  getActiveGroup(): GroupChat | null {
    if (!this.activeGroupId) return null;
    return this.groups.get(this.activeGroupId) ?? null;
  }

  /**
   * 获取激活策略
   */
  getStrategy(groupId: string): ActivationStrategy | undefined {
    return this.strategies.get(groupId);
  }

  /**
   * 获取活跃成员
   */
  getActiveMembers(groupId: string): GroupMember[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    return group.members.filter(m => !m.isMuted && !m.isDisabled);
  }

  /**
   * 选择下一个发言者
   */
  selectNextSpeaker(
    groupId: string,
    messages: GroupChatMessage[],
    lastSpeaker?: GroupMember,
  ): GroupMember | null {
    const strategy = this.strategies.get(groupId);
    const group = this.groups.get(groupId);
    if (!strategy || !group) return null;

    return strategy.selectSpeaker(group.members, messages, lastSpeaker);
  }

  /**
   * 重置策略状态
   */
  resetStrategy(groupId: string): void {
    const strategy = this.strategies.get(groupId);
    if (strategy && 'reset' in strategy) {
      (strategy as any).reset();
    }
  }

  // ============================================================
  // 后端同步方法
  // ============================================================

  /**
   * 异步持久化群组到后端（fire-and-forget，不阻塞调用方）
   */
  private _persistAsync(groupId: string): void {
    this.persistGroup(groupId).catch(error => {
      console.warn(`[GroupChatManager] 异步持久化群组 ${groupId} 失败:`, error);
    });
  }

  /**
   * 异步从后端删除群组（fire-and-forget，不阻塞调用方）
   */
  private _deleteFromBackendAsync(groupId: string): void {
    this.deleteFromBackend(groupId).catch(error => {
      console.warn(`[GroupChatManager] 异步删除群组 ${groupId} 失败:`, error);
    });
  }

  /**
   * 从后端同步群组列表
   * 页面加载时调用，恢复持久化的群组
   */
  async syncFromBackend(): Promise<void> {
    try {
      const data = await api.post<any>('/api/groups/get', {});
      // 后端遵守 ST 契约返回裸数组；兼容历史 {groups: [...]} 包装
      const groups = Array.isArray(data) ? data : (data?.groups ?? []);
      if (Array.isArray(groups)) {
        for (const bg of groups) {
          const group = this._backendToGroup(bg);
          if (group && !this.groups.has(group.id)) {
            this.groups.set(group.id, group);
            this.strategies.set(group.id, createActivationStrategy(group.activationStrategy));
          }
        }
      }
    } catch (error) {
      console.warn('[GroupChatManager] 从后端同步群组失败:', error);
    }
  }

  /**
   * 保存群组到后端
   */
  async persistGroup(groupId: string): Promise<boolean> {
    const group = this.groups.get(groupId);
    if (!group) return false;

    try {
      const payload = this._groupToBackend(group);
      const existing = await api.post<any>('/api/groups/get', {}).catch(() => null);
      // 兼容裸数组与 {groups} 包装
      const existingList = Array.isArray(existing) ? existing : (existing?.groups ?? []);
      const exists = Array.isArray(existingList) && existingList.some((g: any) => g.id === groupId);

      if (exists) {
        await api.post('/api/groups/edit', payload);
      } else {
        await api.post('/api/groups/create', payload);
      }
      return true;
    } catch (error) {
      console.error('[GroupChatManager] 保存群组到后端失败:', error);
      return false;
    }
  }

  /**
   * 从后端删除群组
   */
  async deleteFromBackend(groupId: string): Promise<boolean> {
    try {
      await api.post('/api/groups/delete', { id: groupId });
      return true;
    } catch (error) {
      console.error('[GroupChatManager] 从后端删除群组失败:', error);
      return false;
    }
  }

  /**
   * 加载群聊消息记录
   */
  async loadGroupMessages(groupId: string): Promise<GroupChatMessage[]> {
    try {
      const data = await api.post<any>('/api/groups/chats', { id: groupId });
      // 后端遵守 ST 契约返回裸数组；兼容历史 {chats: [...]} 包装
      const chats = Array.isArray(data) ? data : (data?.chats ?? []);
      if (Array.isArray(chats)) {
        return chats.map((c: any) => this._backendToMessage(c));
      }
      return [];
    } catch (error) {
      console.warn('[GroupChatManager] 加载群聊消息失败:', error);
      return [];
    }
  }

  /**
   * 后端数据 → GroupChat 转换
   */
  private _backendToGroup(bg: any): GroupChat | null {
    // 后端 ST 兼容格式: id 为 avatar key（palink-group-{uuid}.png），内部 id 在
    // group_id 字段；兼容历史 {groups} 内部格式（无 group_id 时回退 id）。
    const internalId = bg?.group_id ?? bg?.id;
    if (!internalId) return null;
    let members: GroupMember[] = [];
    try {
      // ST 兼容格式: members 为 avatar key 字符串数组（palink-{cid}.png），无 member_ids；
      // 内部格式: member_ids 为 JSON 字符串。两者兼容解析。
      let memberIds: string[] = [];
      const rawMemberIds = typeof bg.member_ids === 'string' ? JSON.parse(bg.member_ids) : (bg.member_ids ?? []);
      if (Array.isArray(rawMemberIds) && rawMemberIds.length) {
        memberIds = rawMemberIds.map((m: any) => {
          const s = String(m);
          return s.startsWith('palink-') && s.endsWith('.png') ? s.slice('palink-'.length, -4) : s;
        });
      } else if (Array.isArray(bg.members)) {
        memberIds = bg.members.map((m: any) => {
          const s = String(m);
          return s.startsWith('palink-') && s.endsWith('.png') ? s.slice('palink-'.length, -4) : s;
        });
      }
      const disabled: string[] = typeof bg.disabled_members === 'string' ? JSON.parse(bg.disabled_members) : (bg.disabled_members || []);
      const disabledIds = disabled.map((d: any) => {
        const s = String(d);
        return s.startsWith('palink-') && s.endsWith('.png') ? s.slice('palink-'.length, -4) : s;
      });
      members = memberIds.map((id, idx) => ({
        characterId: id,
        name: bg.member_names?.[id] || `Member ${idx + 1}`,
        isMuted: false,
        isDisabled: disabledIds.includes(id),
        probability: 50,
        position: idx,
      }));
    } catch {
      // ignore parse errors
    }

    return {
      id: internalId,
      name: bg.name || '未命名群组',
      description: bg.description,
      avatar: bg.avatar,
      members,
      activationStrategy: bg.activation_strategy ?? GroupActivationStrategy.NATURAL,
      generationMode: bg.generation_mode ?? GroupGenerationMode.SWAP,
      allowSelfResponses: bg.allow_self_responses ?? false,
      enableGroupExpressions: true,
      memberProfiles: (bg.member_profiles && typeof bg.member_profiles === 'object' && !Array.isArray(bg.member_profiles))
        ? bg.member_profiles as Record<string, GroupMemberProfile>
        : {},
      createdAt: bg.created_at || new Date().toISOString(),
      updatedAt: bg.updated_at || new Date().toISOString(),
      extensions: {},
    };
  }

  /**
   * GroupChat → 后端数据 转换
   */
  private _groupToBackend(group: GroupChat): any {
    // 收集成员 profile：member.profile 优先，否则使用 group.memberProfiles 中的存量值
    const memberProfiles: Record<string, GroupMemberProfile> = {
      ...(group.memberProfiles || {}),
    };
    for (const m of group.members) {
      if (m.profile) {
        memberProfiles[m.characterId] = m.profile;
      }
    }
    return {
      id: group.id,
      name: group.name,
      description: group.description || '',
      avatar: group.avatar || '',
      // 后端 GroupCreateRequest/GroupEditRequest 契约: members/disabled_members 为
      // 内部 character id 数组（非 JSON 字符串、非 avatar key）
      members: group.members.map(m => m.characterId),
      disabled_members: group.members.filter(m => m.isDisabled).map(m => m.characterId),
      allow_self_responses: group.allowSelfResponses,
      activation_strategy: group.activationStrategy,
      generation_mode: group.generationMode,
      member_profiles: memberProfiles,
    };
  }

  /**
   * 后端消息 → GroupChatMessage 转换
   */
  private _backendToMessage(c: any): GroupChatMessage {
    return {
      id: String(c.id ?? Date.now()),
      content: c.content || c.mes || '',
      role: c.is_user ? 'user' : 'assistant',
      name: c.name || (c.is_user ? 'User' : 'Assistant'),
      characterId: c.character_id || c.extra?.characterId,
      isUser: !!c.is_user,
      createdAt: c.created_at || c.send_date || new Date().toISOString(),
      swipes: c.swipes,
      swipeId: c.swipe_id,
      extra: c.extra,
    };
  }
}

/**
 * 创建群聊管理器实例
 */
export function createGroupChatManager(): GroupChatManager {
  return new GroupChatManager();
}

// 导出单例
export const groupChatManager = new GroupChatManager();
