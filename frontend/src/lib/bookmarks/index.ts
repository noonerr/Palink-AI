/**
 * Chat Bookmarks 模块入口
 * 基于 SillyTavern 的 bookmark 系统
 */

// 导出类型
export type {
  Bookmark,
  BookmarkGroup,
} from './manager';

// 导出类和实例
export { BookmarkManager, createBookmarkManager } from './manager';
import { bookmarkManager } from './manager';
export { bookmarkManager };

/**
 * React Hook: useBookmarks
 */
export function useBookmarks() {
  return {
    manager: bookmarkManager,
    createBookmark: bookmarkManager.createBookmark.bind(bookmarkManager),
    getBookmark: bookmarkManager.getBookmark.bind(bookmarkManager),
    getChatBookmarks: bookmarkManager.getChatBookmarks.bind(bookmarkManager),
    getAllBookmarks: bookmarkManager.getAllBookmarks.bind(bookmarkManager),
    updateBookmark: bookmarkManager.updateBookmark.bind(bookmarkManager),
    deleteBookmark: bookmarkManager.deleteBookmark.bind(bookmarkManager),
    searchBookmarks: bookmarkManager.searchBookmarks.bind(bookmarkManager),
    exportBookmarks: bookmarkManager.exportBookmarks.bind(bookmarkManager),
    importBookmarks: bookmarkManager.importBookmarks.bind(bookmarkManager),
  };
}
