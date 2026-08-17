export function appendUploadToken(url: string): string {
  if (!url) return url;
  if (url.startsWith('/api/uploads/') || url.startsWith('/uploads/')) {
    const token = localStorage.getItem('palink_token');
    if (token) {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}token=${encodeURIComponent(token)}`;
    }
  }
  return url;
}
