
import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User,
  Save,
  Upload,
  Sparkles,
  Plus,
  Trash2,
  Bot,
  Brain,
  ChevronDown,
  Check
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import type { OCData, OCCustomField, OCConfig, Model } from '@/types';

const OC_STORAGE_KEY = 'palink_oc_data';
const OC_CONFIG_KEY = 'palink_oc_config';

const defaultCustomFields: OCCustomField[] = [
  { id: '1', label: '', value: '' },
  { id: '2', label: '', value: '' },
  { id: '3', label: '', value: '' },
];

const defaultOCData: OCData = {
  id: 'default',
  name: '',
  traits: '',
  personality: '',
  hobbies: '',
  background: '',
  customFields: defaultCustomFields,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const defaultOCConfig: OCConfig = {
  allowAIAnalysis: true,
  defaultAnalysisModel: '',
};

interface OCSettingsProps {
  token: string;
  models: Model[];
  onUpdate?: () => void;
}

export const OCSettings: React.FC<OCSettingsProps> = ({ token: _token, models, onUpdate }) => {
  const [ocData, setOCData] = useState<OCData>(defaultOCData);
  const [ocConfig, setOCConfig] = useState<OCConfig>(defaultOCConfig);
  const [isSaving, setIsSaving] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('profile');
  const [customAnalysisText, setCustomAnalysisText] = useState<string>('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState<boolean>(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const modelButtonRef = React.useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const savedOCData = localStorage.getItem(OC_STORAGE_KEY);
    const savedOCConfig = localStorage.getItem(OC_CONFIG_KEY);

    if (savedOCData) {
      try {
        setOCData(JSON.parse(savedOCData));
      } catch {
        setOCData(defaultOCData);
      }
    }

    if (savedOCConfig) {
      try {
        setOCConfig(JSON.parse(savedOCConfig));
      } catch {
        setOCConfig(defaultOCConfig);
      }
    }
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelDropdownOpen && modelButtonRef.current && !modelButtonRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [modelDropdownOpen]);

  const handleModelButtonClick = () => {
    if (modelButtonRef.current) {
      const rect = modelButtonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + window.scrollY + 8,
        left: rect.left + window.scrollX,
        width: rect.width,
      });
    }
    setModelDropdownOpen(!modelDropdownOpen);
  };

  const saveData = useCallback(() => {
    setIsSaving(true);
    const updatedData = {
      ...ocData,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(OC_STORAGE_KEY, JSON.stringify(updatedData));
    localStorage.setItem(OC_CONFIG_KEY, JSON.stringify(ocConfig));
    setTimeout(() => {
      setIsSaving(false);
      onUpdate?.();
    }, 500);
  }, [ocData, ocConfig, onUpdate]);

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      console.error('请上传图片文件');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      console.error('图片大小不能超过 5MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setOCData(prev => ({ ...prev, avatar: dataUrl }));
    };
    reader.readAsDataURL(file);
  };

  const handleCustomFieldChange = (id: string, field: 'label' | 'value', value: string) => {
    setOCData(prev => ({
      ...prev,
      customFields: prev.customFields.map(f =>
        f.id === id ? { ...f, [field]: value } : f
      ),
    }));
  };

  const addCustomField = () => {
    const newField: OCCustomField = {
      id: Date.now().toString(),
      label: '',
      value: '',
    };
    setOCData(prev => ({
      ...prev,
      customFields: [...prev.customFields, newField],
    }));
  };

  const removeCustomField = (id: string) => {
    setOCData(prev => ({
      ...prev,
      customFields: prev.customFields.filter(f => f.id !== id),
    }));
  };

  const handleAIAnalysis = async () => {
    if (!ocConfig.allowAIAnalysis) {
      console.error('请先在设置中启用AI分析功能');
      return;
    }

    if (!ocConfig.defaultAnalysisModel) {
      console.error('请先在设置中选择AI分析模型');
      return;
    }

    setIsAnalyzing(true);
    setAnalysisResult('');

    try {
      let prompt;
      if (customAnalysisText.trim()) {
        prompt = `请深度分析以下文本，提供专业的分析和建议：

${customAnalysisText}

请提供：
1. 内容完整性评估
2. 关键要点总结
3. 潜在的优化建议
4. 互动场景建议`;
      } else {
        prompt = `请深度分析以下原创角色(OC)设定，提供专业的角色扮演建议和优化意见：

角色名称：${ocData.name}
人物特点：${ocData.traits}
性格：${ocData.personality}
爱好：${ocData.hobbies}
人物背景：${ocData.background}
${ocData.customFields.filter(f => f.label && f.value).map(f => `${f.label}：${f.value}`).join('\n')}

请提供：
1. 角色设定的完整性评估
2. 角色扮演时的关键要点
3. 潜在的优化建议
4. 互动场景建议`;
      }

      const res = await api.stream('/api/chat', {
        message: prompt,
        model: ocConfig.defaultAnalysisModel,
        temperature: 0.7,
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let result = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.content) {
                  result += parsed.content;
                  setAnalysisResult(result);
                }
              } catch {}
            }
          }
        }
      }
    } catch (error) {
      console.error('Analysis error:', error);
      console.error('分析失败，请稍后重试');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-start md:items-center justify-between flex-shrink-0 mb-4 gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-xl md:text-2xl font-semibold flex items-center gap-2">
            <User className="text-primary shrink-0" />
            <span className="truncate">原创角色(OC)设置</span>
          </h3>
          <p className="text-xs md:text-sm text-muted-foreground mt-1 line-clamp-2">
            设定您的原创角色信息，AI将根据这些设定与您互动
          </p>
        </div>
        <Button onClick={saveData} disabled={isSaving} size="sm" className="shrink-0">
          <Save size={14} className="mr-1.5" />
          {isSaving ? '保存中...' : '保存'}
        </Button>
      </div>

      <div className="w-full flex-shrink-0">
        <div className="w-full grid grid-cols-2 bg-muted rounded-lg p-1 mb-4">
          <button
            onClick={() => setActiveTab('profile')}
            className={cn(
              "flex items-center justify-center gap-2 px-3 py-2.5 h-10 rounded-md text-sm font-medium transition-all",
              activeTab === 'profile' 
                ? "bg-background shadow-sm" 
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <User size={14} />
            基本信息
          </button>
          <button
            onClick={() => setActiveTab('analysis')}
            className={cn(
              "flex items-center justify-center gap-2 px-3 py-2.5 h-10 rounded-md text-sm font-medium transition-all",
              activeTab === 'analysis' 
                ? "bg-background shadow-sm" 
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Brain size={14} />
            AI分析
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden min-h-0">
        <AnimatePresence mode="wait">
          {activeTab === 'profile' ? (
            <motion.div
              key="profile"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="h-full overflow-y-auto scrollbar-hidden flex flex-col md:min-h-[600px]"
            >
              <div className="space-y-4 md:space-y-6 flex-1 pb-6">
          <Card>
            <CardHeader className="px-4 md:px-6">
              <CardTitle className="text-base md:text-lg">角色头像</CardTitle>
            </CardHeader>
            <CardContent className="px-4 md:px-6">
              <div className="flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-6">
                <div className="relative shrink-0">
                  <Avatar className="w-20 h-20 md:w-24 md:h-24 border-2 border-border">
                    {ocData.avatar ? (
                      <AvatarImage src={ocData.avatar} alt="OC Avatar" />
                    ) : (
                      <AvatarFallback className="text-2xl bg-gradient-to-br from-primary/20 to-primary/10">
                        <User size={28} className="text-primary" />
                      </AvatarFallback>
                    )}
                  </Avatar>
                  <label className="absolute -bottom-2 -right-2 cursor-pointer">
                    <input
                      type="file"
                      accept=".jpg,.jpeg,.png"
                      className="hidden"
                      onChange={handleAvatarUpload}
                    />
                    <div className="w-8 h-8 flex items-center justify-center rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/60 transition-colors">
                      <Upload size={14} />
                    </div>
                  </label>
                </div>
                <div className="flex-1 space-y-2 w-full">
                  <Label>角色名称</Label>
                  <Input
                    placeholder="输入您的角色名称"
                    value={ocData.name}
                    onChange={(e) => setOCData(prev => ({ ...prev, name: e.target.value }))}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
            <div className="space-y-2">
              <Label>人物特点</Label>
              <Textarea
                placeholder="描述角色的外貌特征、身体特点等"
                value={ocData.traits}
                onChange={(e) => setOCData(prev => ({ ...prev, traits: e.target.value }))}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>性格</Label>
              <Textarea
                placeholder="描述角色的性格特点、行为方式等"
                value={ocData.personality}
                onChange={(e) => setOCData(prev => ({ ...prev, personality: e.target.value }))}
                rows={3}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:gap-6">
            <div className="space-y-2">
              <Label>爱好</Label>
              <Textarea
                placeholder="描述角色的兴趣爱好、喜欢的事物等"
                value={ocData.hobbies}
                onChange={(e) => setOCData(prev => ({ ...prev, hobbies: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label>人物背景</Label>
              <Textarea
                placeholder="描述角色的成长背景、重要经历等"
                value={ocData.background}
                onChange={(e) => setOCData(prev => ({ ...prev, background: e.target.value }))}
                rows={4}
              />
            </div>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between px-4 md:px-6">
              <CardTitle className="text-base md:text-lg">自定义属性</CardTitle>
              <Button size="sm" variant="secondary" onClick={addCustomField}>
                <Plus size={14} className="mr-1" />
                添加
              </Button>
            </CardHeader>
            <CardContent className="px-4 md:px-6 space-y-4">
              {ocData.customFields.map((field, index) => (
                <div key={field.id} className="group relative space-y-2">
                  <div className="flex gap-2">
                    <Input
                      placeholder="属性名称"
                      value={field.label}
                      onChange={(e) => handleCustomFieldChange(field.id, 'label', e.target.value)}
                      className="flex-1"
                    />
                    {index >= 3 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
                        onClick={() => removeCustomField(field.id)}
                      >
                        <Trash2 size={16} className="text-destructive" />
                      </Button>
                    )}
                  </div>
                  <Textarea
                    placeholder="属性内容"
                    value={field.value}
                    onChange={(e) => handleCustomFieldChange(field.id, 'value', e.target.value)}
                    rows={2}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="analysis"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="h-full overflow-y-auto scrollbar-hidden flex flex-col md:min-h-[600px]"
            >
              <div className="space-y-4 md:space-y-6 flex-1 pb-6">
              <Card className="flex-1">
                <CardHeader className="px-4 md:px-6">
                  <CardTitle className="text-base md:text-lg">AI深度分析</CardTitle>
                </CardHeader>
                <CardContent className="px-4 md:px-6 space-y-4">
                  <div className="flex items-center justify-between p-4 bg-muted/30 rounded-xl">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">分析功能状态</p>
                      <p className="text-xs text-muted-foreground">
                        {ocConfig.allowAIAnalysis ? '已启用' : '已禁用'}
                      </p>
                    </div>
                    <Switch
                      checked={ocConfig.allowAIAnalysis}
                      onCheckedChange={(checked) =>
                        setOCConfig(prev => ({ ...prev, allowAIAnalysis: checked }))
                      }
                    />
                  </div>

                  {ocConfig.allowAIAnalysis && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label>分析模型</Label>
                        <div className="relative">
                          <button
                            ref={modelButtonRef}
                            type="button"
                            onClick={handleModelButtonClick}
                            className="w-full flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-secondary hover:bg-secondary/80 transition-all border border-border justify-between"
                          >
                            <span className="flex items-center gap-2">
                              <Bot size={16} />
                              {ocConfig.defaultAnalysisModel 
                                ? (() => { const m = models.find(m => m.id === ocConfig.defaultAnalysisModel); return m?.alias || m?.name || ocConfig.defaultAnalysisModel; })()
                                : '请选择模型'}
                            </span>
                            <ChevronDown 
                              size={14} 
                              className={`transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`}
                            />
                          </button>
                        </div>
                      </div>

                      {modelDropdownOpen && dropdownPosition && createPortal(
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.15 }}
                          style={{
                            position: 'fixed',
                            top: dropdownPosition.top,
                            left: dropdownPosition.left,
                            width: dropdownPosition.width,
                            zIndex: 9999,
                          }}
                          className="py-1 bg-secondary border border-border rounded-xl shadow-lg overflow-hidden"
                        >
                          {models.map((model) => (
                            <button
                              key={model.id}
                              type="button"
                              onClick={() => {
                                setOCConfig(prev => ({ ...prev, defaultAnalysisModel: model.id }));
                                setModelDropdownOpen(false);
                              }}
                              className={`w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-background transition-colors ${
                                ocConfig.defaultAnalysisModel === model.id ? 'bg-background' : ''
                              }`}
                            >
                              <span>{model.alias || model.name || model.id}</span>
                              {ocConfig.defaultAnalysisModel === model.id && (
                                <Check size={14} className="text-primary" />
                              )}
                            </button>
                          ))}
                        </motion.div>,
                        document.body
                      )}

                      <div className="space-y-2">
                        <Label>自定义分析文本（可选）</Label>
                        <Textarea
                          placeholder="在此粘贴或输入要分析的文本。如果留空，将分析OC设置中的基本信息。"
                          value={customAnalysisText}
                          onChange={(e) => setCustomAnalysisText(e.target.value)}
                          rows={4}
                        />
                      </div>

                      <Button
                        className="w-full"
                        onClick={handleAIAnalysis}
                        disabled={isAnalyzing || (!ocData.name && !customAnalysisText.trim())}
                      >
                        {isAnalyzing ? (
                          <>
                            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                            分析中...
                          </>
                        ) : (
                          <>
                            <Sparkles size={16} className="mr-2" />
                            开始AI分析
                          </>
                        )}
                      </Button>

                      {analysisResult && (
                        <Card>
                          <CardHeader className="px-4 md:px-6">
                            <CardTitle className="text-sm flex items-center gap-2">
                              <Bot size={16} />
                              分析结果
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="px-4 md:px-6">
                            <div className="text-sm whitespace-pre-wrap text-muted-foreground">
                              {analysisResult}
                            </div>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export const getOCData = (): OCData | null => {
  const saved = localStorage.getItem(OC_STORAGE_KEY);
  return saved ? JSON.parse(saved) : null;
};

export const getOCConfig = (): OCConfig => {
  const saved = localStorage.getItem(OC_CONFIG_KEY);
  return saved ? JSON.parse(saved) : defaultOCConfig;
};

