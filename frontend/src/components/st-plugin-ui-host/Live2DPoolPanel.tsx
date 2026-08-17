import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';

/**
 * Live2D 模型池面板
 *
 * 展示服务器托管的 Live2D 模型池（backend/app/api/live2d_pool.py），
 * 用户无需上传模型文件，即可把池中远程模型绑定到任意角色。
 *
 * 绑定原理（对齐 galgame 界面插件的机制）：
 * - 插件通过角色名 charCode 哈希（与 CharacterChat.tsx 中 this_chid 算法一致）
 *   识别当前角色，加载时调用 getLive2DModel(characterId)；
 * - 绑定即向插件 IndexedDB（GalgameUIPluginDB -> live2dModels，主键 modelId）
 *   写入 { modelId: <哈希>, source: "remote", modelUrl: <服务器URL> }；
 * - 插件 Live2DManager._isRemoteModelData 识别 remote 模型并按 URL 加载。
 *
 * 服务器模型文件为同源静态资源（GET /api/live2d-pool/files/...），
 * 插件运行时在主 window 内 fetch，无 CORS 问题。
 */

const GALGAME_DB = 'GalgameUIPluginDB';
const GALGAME_STORE = 'live2dModels';

interface PoolModel {
  id: string;
  name: string;
  description: string;
  tags: string[];
  modelUrl: string;
  previewUrl: string | null;
  sizeBytes: number;
  createdAt: string;
}

interface BoundModel {
  modelId: string;
  characterName?: string;
  modelName?: string;
  modelUrl?: string;
  boundAt?: string;
  [key: string]: unknown;
}

/** 与 CharacterChat.tsx 一致的插件角色 ID 哈希算法 */
function pluginCharacterId(name: string): string {
  const hash = Array.from(name || '').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return String(hash || 1);
}

function openGalgameDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GALGAME_DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readRemoteBindings(): Promise<BoundModel[]> {
  const db = await openGalgameDb();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(GALGAME_STORE, 'readonly');
      const req = tx.objectStore(GALGAME_STORE).getAll();
      req.onsuccess = () => {
        const all = (req.result || []) as BoundModel[];
        resolve(all.filter((m) => m.source === 'remote'));
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function bindModel(record: BoundModel): Promise<void> {
  const db = await openGalgameDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALGAME_STORE, 'readwrite');
    tx.objectStore(GALGAME_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function unbindModel(modelId: string): Promise<void> {
  const db = await openGalgameDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALGAME_STORE, 'readwrite');
    tx.objectStore(GALGAME_STORE).delete(modelId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function formatSize(bytes: number): string {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface CharacterOption {
  id: string;
  name: string;
}

export function Live2DPoolPanel() {
  const [models, setModels] = useState<PoolModel[]>([]);
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  const [bindings, setBindings] = useState<BoundModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCharId, setSelectedCharId] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [modelRes, charRes, b] = await Promise.all([
        api.get<{ models: PoolModel[] }>('/api/live2d-pool/models'),
        api.get<CharacterOption[]>('/api/characters?fields=basic'),
        readRemoteBindings().catch(() => []),
      ]);
      setModels(modelRes.models || []);
      setCharacters(Array.isArray(charRes) ? charRes : []);
      setBindings(b);
    } catch (e) {
      console.warn('[Live2DPoolPanel] 加载失败:', e);
      toast.error('加载 Live2D 模型池失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedCharacter = characters.find((c) => c.id === selectedCharId);

  const handleBind = useCallback(
    async (model: PoolModel) => {
      if (!selectedCharacter) {
        toast.error('请先选择要绑定的角色');
        return;
      }
      const modelId = pluginCharacterId(selectedCharacter.name);
      try {
        await bindModel({
          modelId,
          source: 'remote',
          modelUrl: model.modelUrl,
          characterName: selectedCharacter.name,
          modelName: model.name,
          boundAt: new Date().toISOString(),
        });
        setBindings(await readRemoteBindings().catch(() => []));
        toast.success(`已将「${model.name}」绑定到「${selectedCharacter.name}」`);
        // 通知插件运行时重载，使新绑定立即生效
        window.dispatchEvent(new Event('userSettingsUpdated'));
      } catch (e) {
        console.error('[Live2DPoolPanel] 绑定失败:', e);
        toast.error('绑定失败，请稍后重试');
      }
    },
    [selectedCharacter],
  );

  const handleUnbind = useCallback(async (binding: BoundModel) => {
    try {
      await unbindModel(binding.modelId);
      setBindings(await readRemoteBindings().catch(() => []));
      toast.success(`已解除绑定（${binding.characterName || binding.modelId}）`);
      window.dispatchEvent(new Event('userSettingsUpdated'));
    } catch (e) {
      console.error('[Live2DPoolPanel] 解除绑定失败:', e);
      toast.error('解除绑定失败');
    }
  }, []);

  const handleUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('name', file.name.replace(/\.(zip|7z)$/i, ''));
        const res = await api.post<{ model: PoolModel }>(
          '/api/live2d-pool/upload',
          form,
        );
        toast.success(`模型「${res.model.name}」上传成功`);
        void refresh();
      } catch (e) {
        console.error('[Live2DPoolPanel] 上传失败:', e);
        toast.error(`上传失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [refresh],
  );

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Live2D 模型池</div>
          <div className="text-xs text-muted-foreground">
            服务器托管模型，选择角色后点击「绑定」即可使用（也可自行上传 zip 模型包）
          </div>
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
            }}
          />
          <button
            className="text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground hover:bg-accent"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '上传中...' : '上传模型'}
          </button>
          <button
            className="text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground hover:bg-accent"
            onClick={() => void refresh()}
            disabled={loading}
          >
            刷新
          </button>
        </div>
      </div>

      {/* 绑定操作区 */}
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-2">
        <label className="text-xs text-muted-foreground shrink-0">绑定到角色:</label>
        <select
          className="flex-1 min-w-0 text-xs px-2 py-1 rounded bg-background border border-border"
          value={selectedCharId}
          onChange={(e) => setSelectedCharId(e.target.value)}
        >
          <option value="">选择角色...</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {selectedCharacter && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            插件 ID: {pluginCharacterId(selectedCharacter.name)}
          </span>
        )}
      </div>

      {/* 模型池网格 */}
      {loading ? (
        <div className="text-xs text-muted-foreground italic">加载中...</div>
      ) : models.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          模型池为空，点击右上角「上传模型」添加 Live2D 模型 zip 包
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
          {models.map((m) => (
            <div
              key={m.id}
              className="rounded-md border border-border bg-background p-2 flex gap-2"
            >
              <div className="w-14 h-16 shrink-0 rounded overflow-hidden bg-muted/40 flex items-center justify-center">
                {m.previewUrl ? (
                  <img src={m.previewUrl} alt={m.name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-lg">🎭</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate">{m.name}</div>
                <div className="text-[10px] text-muted-foreground line-clamp-2">
                  {m.description || '（无描述）'}
                </div>
                <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {formatSize(m.sizeBytes)} · {m.tags?.join(' / ') || '未分类'}
                </div>
                <button
                  className="mt-1 text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  disabled={!selectedCharacter}
                  onClick={() => void handleBind(m)}
                >
                  绑定到此角色
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 已绑定列表 */}
      {bindings.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1">已绑定（{bindings.length}）</div>
          <div className="space-y-1">
            {bindings.map((b) => (
              <div
                key={b.modelId}
                className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-2 py-1"
              >
                <span className="text-xs truncate">
                  {b.characterName || `角色 #${b.modelId}`}
                  <span className="text-muted-foreground"> → </span>
                  {b.modelName || '远程模型'}
                </span>
                <button
                  className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 shrink-0"
                  onClick={() => void handleUnbind(b)}
                >
                  解除
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Live2DPoolPanel;
