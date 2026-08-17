/**
 * Chat Bookmarks - 聊天书签系统
 * 基于 SillyTavern 的 bookmark 系统
 */

import { emitEvent } from '../event-bus';

// ============================================================
// 类型定义
// ============================================================

export interface Bookmark {
  id: string;
  chatId: string;
  messageId: number;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkGroup {
  id: string;
  name: string;
  bookmarks: Bookmark[];
}

// ============================================================
// BookmarkManager 类
// ============================================================

export class BookmarkManager {
  private bookmarks: Map<string, Bookmark> = new Map();
  private groups: Map<string, BookmarkGroup> = new Map();

  /**
   * 创建书签
   */
  createBookmark(
    chatId: string,
    messageId: number,
    name: string,
    description?: string
  ): Bookmark {
    const id = `bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const bookmark: Bookmark = {
      id,
      chatId,
      messageId,
      name,
      description,
      createdAt: now,
      updatedAt: now,
    };

    this.bookmarks.set(id, bookmark);
    emitEvent('bookmark:created', { bookmarkId: id });
    return bookmark;
  }

  /**
   * 获取书签
   */
  getBookmark(id: string): Bookmark | undefined {
    return this.bookmarks.get(id);
  }

  /**
   * 获取聊天的所有书签
   */
  getChatBookmarks(chatId: string): Bookmark[] {
    return Array.from(this.bookmarks.values()).filter(b => b.chatId === chatId);
  }

  /**
   * 获取所有书签
   */
  getAllBookmarks(): Bookmark[] {
    return Array.from(this.bookmarks.values());
  }

  /**
   * 更新书签
   */
  updateBookmark(id: string, updates: Partial<Pick<Bookmark, 'name' | 'description'>>): Bookmark | undefined {
    const bookmark = this.bookmarks.get(id);
    if (!bookmark) return undefined;

    const updated = {
      ...bookmark,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.bookmarks.set(id, updated);
    emitEvent('bookmark:updated', { bookmarkId: id });
    return updated;
  }

  /**
   * 删除书签
   */
  deleteBookmark(id: string): boolean {
    const deleted = this.bookmarks.delete(id);
    if (deleted) {
      emitEvent('bookmark:deleted', { bookmarkId: id });
    }
    return deleted;
  }

  /**
   * 创建书签组
   */
  createGroup(name: string): BookmarkGroup {
    const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const group: BookmarkGroup = {
      id,
      name,
      bookmarks: [],
    };

    this.groups.set(id, group);
    return group;
  }

  /**
   * 将书签添加到组
   */
  addToGroup(bookmarkId: string, groupId: string): boolean {
    const bookmark = this.bookmarks.get(bookmarkId);
    const group = this.groups.get(groupId);
    if (!bookmark || !group) return false;

    // 检查是否已在组中
    if (group.bookmarks.some(b => b.id === bookmarkId)) {
      return false;
    }

    group.bookmarks.push(bookmark);
    return true;
  }

  /**
   * 从组中移除书签
   */
  removeFromGroup(bookmarkId: string, groupId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    const index = group.bookmarks.findIndex(b => b.id === bookmarkId);
    if (index < 0) return false;

    group.bookmarks.splice(index, 1);
    return true;
  }

  /**
   * 获取所有组
   */
  getGroups(): BookmarkGroup[] {
    return Array.from(this.groups.values());
  }

  /**
   * 搜索书签
   */
  searchBookmarks(query: string): Bookmark[] {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.bookmarks.values()).filter(bookmark =>
      bookmark.name.toLowerCase().includes(lowerQuery) ||
      bookmark.description?.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * 导出书签
   */
  exportBookmarks(): string {
    const data = {
      bookmarks: Array.from(this.bookmarks.values()),
      groups: Array.from(this.groups.values()),
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * 导入书签
   */
  importBookmarks(json: string): number {
    try {
      const data = JSON.parse(json);
      let imported = 0;

      if (Array.isArray(data.bookmarks)) {
        for (const bookmark of data.bookmarks) {
          if (bookmark.id && bookmark.chatId && bookmark.messageId) {
            this.bookmarks.set(bookmark.id, bookmark);
            imported++;
          }
        }
      }

      if (Array.isArray(data.groups)) {
        for (const group of data.groups) {
          if (group.id && group.name) {
            this.groups.set(group.id, group);
          }
        }
      }

      emitEvent('bookmark:imported', { count: imported });
      return imported;
    } catch (error) {
      console.error('[Bookmark] Import failed:', error);
      return 0;
    }
  }

  /**
   * 清除聊天的所有书签
   */
  clearChatBookmarks(chatId: string): void {
    const bookmarks = this.getChatBookmarks(chatId);
    for (const bookmark of bookmarks) {
      this.bookmarks.delete(bookmark.id);
    }
  }

  /**
   * 清除所有书签
   */
  clearAll(): void {
    this.bookmarks.clear();
    this.groups.clear();
  }
}

/**
 * 创建书签管理器实例
 */
export function createBookmarkManager(): BookmarkManager {
  return new BookmarkManager();
}

// 导出单例
export const bookmarkManager = new BookmarkManager();
