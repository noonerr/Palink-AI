import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import {
  Plug,
  Globe,
  Trash2,
  RefreshCw,
  Power,
  Wrench,
  Plus,
  X,
  ChevronDown,
  Zap,
  Terminal,
  Link,
} from 'lucide-react';

interface MCPServer {
  id: string;
  name: string;
  description: string;
  type: 'sse' | 'stdio' | 'streamable-http';
  url: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  enabled: boolean;
  identifier: string;
  author: string;
  createdAt: string;
  status?: 'connected' | 'disconnected' | 'connecting' | 'error';
}

interface MCPTool {
  type: string;
  identifier: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

interface MCPTabProps {
  t?: Record<string, string>;
}

type MCPFormType = 'sse' | 'streamable-http' | 'stdio';

interface MCPInstallForm {
  name: string;
  description: string;
  type: MCPFormType;
  url: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

const defaultForm = (): MCPInstallForm => ({
  name: '',
  description: '',
  type: 'sse',
  url: '',
  command: '',
  args: [],
  cwd: '',
  env: {},
  headers: {},
});

export function MCPTab({ t: _t }: MCPTabProps) {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [serverTools, setServerTools] = useState<Record<string, MCPTool[]>>({});
  const [showInstall, setShowInstall] = useState(false);
  const [installForm, setInstallForm] = useState(defaultForm());
  const [installStep, setInstallStep] = useState<'form' | 'success'>('form');
  const [marketQuery, setMarketQuery] = useState('');
  const [marketResults, setMarketResults] = useState<any[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>([]);
  const [headerPairs, setHeaderPairs] = useState<{ key: string; value: string }[]>([]);

  const fetchServers = useCallback(async () => {
    try {
      const data = await api.get('/api/mcp/servers');
      setServers(data.servers || []);
    } catch {
      toast.error('获取 MCP 服务器失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchServers(); }, [fetchServers]);

  const fetchServerTools = async (serverId: string) => {
    try {
      const data = await api.get(`/api/mcp/servers/${serverId}/tools`);
      setServerTools(prev => ({ ...prev, [serverId]: data.tools || [] }));
    } catch {
      toast.error('获取工具列表失败');
    }
  };

  const toggleEnabled = async (server: MCPServer) => {
    try {
      await api.patch(`/api/mcp/servers/${server.id}`, { enabled: !server.enabled });
      fetchServers();
    } catch {
      toast.error('操作失败');
    }
  };

  const testConnection = async (serverId: string) => {
    try {
      const result = await api.post(`/api/mcp/servers/${serverId}/test`, {});
      if (result.connected) {
        toast.success(`连接成功，发现 ${result.tools?.length || 0} 个工具`);
        fetchServerTools(serverId);
      } else {
        toast.error(`连接失败: ${result.error}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '测试失败');
    }
  };

  const deleteServer = async (serverId: string) => {
    try {
      await api.delete(`/api/mcp/servers/${serverId}`);
      toast.success('已删除');
      fetchServers();
    } catch {
      toast.error('删除失败');
    }
  };

  const connectServer = async (serverId: string) => {
    try {
      await api.post(`/api/mcp/servers/${serverId}/connect`, {});
      toast.success('已连接');
      fetchServers();
      fetchServerTools(serverId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '连接失败');
    }
  };

  const disconnectServer = async (serverId: string) => {
    try {
      await api.post(`/api/mcp/servers/${serverId}/disconnect`, {});
      toast.success('已断开');
      fetchServers();
    } catch {
      toast.error('断开失败');
    }
  };

  const searchMarket = async () => {
    if (!marketQuery.trim()) return;
    setMarketLoading(true);
    try {
      const data = await api.get(`/api/mcp/marketplace/search?query=${encodeURIComponent(marketQuery)}&limit=20`);
      setMarketResults(data.items || data.plugins || []);
    } catch {
      toast.error('市场搜索失败');
    } finally {
      setMarketLoading(false);
    }
  };

  const handleInstall = async () => {
    const form = { ...installForm };
    form.env = {};
    envPairs.forEach(p => { if (p.key) form.env[p.key] = p.value; });
    form.headers = {};
    headerPairs.forEach(p => { if (p.key) form.headers[p.key] = p.value; });

    try {
      await api.post('/api/mcp/servers', form);
      toast.success('MCP 服务器已安装');
      setInstallStep('success');
      fetchServers();
      setTimeout(() => {
        setShowInstall(false);
        setInstallForm(defaultForm());
        setEnvPairs([]);
        setHeaderPairs([]);
        setInstallStep('form');
      }, 1500);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '安装失败');
    }
  };

  const installFromMarket = (item: any) => {
    const config = item.installConfig || item.config || {};
    setInstallForm({
      name: item.name || item.identifier || '',
      description: item.description || '',
      type: config.type || 'sse',
      url: config.url || '',
      command: config.command || '',
      args: config.args || [],
      cwd: '',
      env: {},
      headers: {},
    });
    if (config.env) {
      const pairs = Object.entries(config.env).map(([key, val]: [string, any]) => ({
        key,
        value: val?.default || '',
      }));
      setEnvPairs(pairs);
    }
    setShowInstall(true);
  };

  const openInstallDialog = (prefill?: Partial<typeof installForm>) => {
    if (prefill) setInstallForm(prev => ({ ...prev, ...prefill }));
    setShowInstall(true);
  };

  const closeInstallDialog = () => {
    setShowInstall(false);
    setInstallForm(defaultForm());
    setEnvPairs([]);
    setHeaderPairs([]);
    setInstallStep('form');
  };

  const typeIcon = (type: string) => {
    if (type === 'stdio') return <Terminal size={14} className="text-orange-500" />;
    if (type === 'streamable-http') return <Zap size={14} className="text-blue-500" />;
    return <Link size={14} className="text-green-500" />;
  };

  const typeLabel = (type: string) => {
    if (type === 'stdio') return 'Stdio';
    if (type === 'streamable-http') return 'HTTP';
    return 'SSE';
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">MCP 服务器</h3>
          <p className="text-sm text-muted-foreground mt-1">管理 MCP 工具服务器，兼容 LobeChat MCP 命令体系</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setMarketQuery(''); setMarketResults([]); searchMarket(); }}>
            <Globe size={14} className="mr-1.5" />
            市场
          </Button>
          <Button size="sm" onClick={() => openInstallDialog()}>
            <Plus size={14} className="mr-1.5" />
            添加服务器
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {loading ? (
          <GlassCard className="p-8 text-center">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm text-muted-foreground">加载 MCP 服务器...</p>
          </GlassCard>
        ) : servers.length === 0 ? (
          <GlassCard className="p-8 text-center">
            <Plug size={48} className="mx-auto text-muted-foreground mb-4" />
            <h4 className="font-semibold mb-2">暂无 MCP 服务器</h4>
            <p className="text-sm text-muted-foreground mb-4">添加 MCP 服务器来扩展 AI 的工具能力</p>
            <div className="flex gap-2 justify-center">
              <Button onClick={() => openInstallDialog()} size="sm">
                <Plus size={14} className="mr-1.5" />
                手动添加
              </Button>
            </div>
          </GlassCard>
        ) : (
          servers.map(server => (
            <GlassCard key={server.id} className="overflow-hidden">
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => {
                  const next = expandedServer === server.id ? null : server.id;
                  setExpandedServer(next);
                  if (next && !serverTools[server.id] && server.status === 'connected') {
                    fetchServerTools(server.id);
                  }
                }}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {typeIcon(server.type)}
                  <span className="font-medium truncate">{server.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{typeLabel(server.type)}</span>
                  <span className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                    server.status === 'connected' ? "bg-green-500/15 text-green-600" :
                    server.status === 'error' ? "bg-red-500/15 text-red-600" :
                    "bg-muted text-muted-foreground"
                  )}>
                    {server.status === 'connected' ? '已连接' : server.status === 'error' ? '错误' : '未连接'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    onClick={() => toggleEnabled(server)}>
                    <Power size={14} className={server.enabled ? "text-green-500" : "text-muted-foreground"} />
                  </Button>
                  {server.status === 'connected' ? (
                    <Button size="icon" variant="ghost" className="h-7 w-7"
                      onClick={() => disconnectServer(server.id)}>
                      <RefreshCw size={14} />
                    </Button>
                  ) : (
                    <Button size="icon" variant="ghost" className="h-7 w-7"
                      onClick={() => connectServer(server.id)}>
                      <Plug size={14} />
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    onClick={() => testConnection(server.id)}>
                    <Wrench size={14} />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                    onClick={() => deleteServer(server.id)}>
                    <Trash2 size={14} />
                  </Button>
                  <ChevronDown size={14} className={cn("text-muted-foreground transition-transform", expandedServer === server.id && "rotate-180")} />
                </div>
              </div>

              {expandedServer === server.id && (
                <div className="px-4 pb-3 border-t border-border/50">
                  <div className="mt-2 text-xs text-muted-foreground space-y-1">
                    {server.description && <p>{server.description}</p>}
                    {server.url && <p><span className="font-medium">URL:</span> {server.url}</p>}
                    {server.command && <p><span className="font-medium">Command:</span> {server.command} {server.args?.join(' ')}</p>}
                    {server.identifier && <p><span className="font-medium">Identifier:</span> {server.identifier}</p>}
                  </div>
                  {serverTools[server.id] && serverTools[server.id].length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-1.5">可用工具 ({serverTools[server.id].length})</p>
                      <div className="space-y-1">
                        {serverTools[server.id].map(tool => (
                          <div key={tool.identifier} className="text-xs bg-muted/30 rounded px-2 py-1.5">
                            <span className="font-medium">{tool.name}</span>
                            {tool.description && <span className="text-muted-foreground ml-2">{tool.description.slice(0, 80)}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </GlassCard>
          ))
        )}
      </div>

      {marketResults.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <Globe size={14} />
            MCP 市场
          </h4>
          <div className="grid gap-2">
            {marketResults.map((item, idx) => (
              <GlassCard key={idx} className="p-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">{item.name || item.identifier}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{item.description}</p>
                  {item.toolsCount && <p className="text-[10px] text-muted-foreground mt-1">{item.toolsCount} 个工具</p>}
                </div>
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => installFromMarket(item)}>
                  <Plus size={12} className="mr-1" />
                  安装
                </Button>
              </GlassCard>
            ))}
          </div>
        </div>
      )}

      {showInstall && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={closeInstallDialog}>
          <GlassCard className="w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold">添加 MCP 服务器</h3>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={closeInstallDialog}>
                  <X size={14} />
                </Button>
              </div>

              {installStep === 'success' ? (
                <div className="text-center py-8">
                  <div className="text-green-500 text-4xl mb-3">✓</div>
                  <p className="font-medium">安装成功</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">名称 *</label>
                    <Input value={installForm.name} onChange={e => setInstallForm(p => ({ ...p, name: e.target.value }))} placeholder="My MCP Server" />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">传输类型</label>
                    <div className="flex gap-2">
                      {(['sse', 'streamable-http', 'stdio'] as const).map(type => (
                        <Button key={type} size="sm" variant={installForm.type === type ? 'default' : 'outline'}
                          onClick={() => setInstallForm(p => ({ ...p, type }))}>
                          {typeIcon(type)}
                          <span className="ml-1.5">{typeLabel(type)}</span>
                        </Button>
                      ))}
                    </div>
                  </div>

                  {(installForm.type === 'sse' || installForm.type === 'streamable-http') && (
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">服务器 URL *</label>
                      <Input value={installForm.url} onChange={e => setInstallForm(p => ({ ...p, url: e.target.value }))} placeholder="https://..." />
                    </div>
                  )}

                  {installForm.type === 'stdio' && (
                    <>
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">命令 *</label>
                        <Input value={installForm.command} onChange={e => setInstallForm(p => ({ ...p, command: e.target.value }))} placeholder="npx / uvx / python" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">参数</label>
                        <Input value={installForm.args.join(' ')} onChange={e => setInstallForm(p => ({ ...p, args: e.target.value.split(' ').filter(Boolean) }))} placeholder="-y @modelcontextprotocol/server-github" />
                      </div>
                    </>
                  )}

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">环境变量</label>
                    {envPairs.map((pair, idx) => (
                      <div key={idx} className="flex gap-2">
                        <Input className="flex-1" placeholder="KEY" value={pair.key} onChange={e => { const n = [...envPairs]; n[idx].key = e.target.value; setEnvPairs(n); }} />
                        <Input className="flex-1" placeholder="VALUE" value={pair.value} onChange={e => { const n = [...envPairs]; n[idx].value = e.target.value; setEnvPairs(n); }} />
                        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => setEnvPairs(p => p.filter((_, i) => i !== idx))}>
                          <X size={12} />
                        </Button>
                      </div>
                    ))}
                    <Button size="sm" variant="outline" onClick={() => setEnvPairs(p => [...p, { key: '', value: '' }])}>
                      <Plus size={12} className="mr-1" />
                      添加
                    </Button>
                  </div>

                  <Button className="w-full" onClick={handleInstall} disabled={!installForm.name || (!installForm.url && !installForm.command)}>
                    安装
                  </Button>
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
};
