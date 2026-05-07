import React from 'react';
import { Bot, ChevronDown, HelpCircle, Save, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { ModelSelector } from '@/components/ui/custom/ModelSelector';
import { Switch } from '@/components/ui/switch';
import type { Model } from '@/types';

interface AdminDefaultsTabProps {
  t: Record<string, string>;
  models: Model[];
  defChat: string;
  setDefChat: (value: string) => void;
  defWs: string;
  setDefWs: (value: string) => void;
  defOutline: string;
  setDefOutline: (value: string) => void;
  defCharacterParse: string;
  setDefCharacterParse: (value: string) => void;
  defCharacterTranslate: string;
  setDefCharacterTranslate: (value: string) => void;
  defCharacterChat: string;
  setDefCharacterChat: (value: string) => void;
  dailyTopicModel: string;
  setDailyTopicModel: (value: string) => void;
  defSummarization: string;
  setDefSummarization: (value: string) => void;
  defOCAnalysis: string;
  setDefOCAnalysis: (value: string) => void;
  allowOCAnalysis: boolean;
  setAllowOCAnalysis: (value: boolean) => void;
  handleSaveDefaults: () => void;
  startersExpanded: boolean;
  setStartersExpanded: (value: boolean) => void;
  starterQuestions: string[];
  setStarterQuestions: (value: string[]) => void;
  handleSaveStarters: () => void;
}

export const AdminDefaultsTab: React.FC<AdminDefaultsTabProps> = ({
  t,
  models,
  defChat,
  setDefChat,
  defWs,
  setDefWs,
  defOutline,
  setDefOutline,
  defCharacterParse,
  setDefCharacterParse,
  defCharacterTranslate,
  setDefCharacterTranslate,
  defCharacterChat,
  setDefCharacterChat,
  dailyTopicModel,
  setDailyTopicModel,
  defSummarization,
  setDefSummarization,
  defOCAnalysis,
  setDefOCAnalysis,
  allowOCAnalysis,
  setAllowOCAnalysis,
  handleSaveDefaults,
  startersExpanded,
  setStartersExpanded,
  starterQuestions,
  setStarterQuestions,
  handleSaveStarters,
}) => {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 animate-fade-in pr-2 pb-28">
        <h3 className="text-2xl font-semibold">{t.admin_defaults}</h3>

        <GlassCard className="p-6">
          <div className="space-y-4">
            {[
              { label: t.def_chat_model, value: defChat, set: setDefChat },
              { label: t.def_ws_model, value: defWs, set: setDefWs },
              { label: t.def_outline_model, value: defOutline, set: setDefOutline },
              { label: '解析/翻译人物卡默认模型', value: defCharacterParse, set: setDefCharacterParse },
              { label: '人物卡翻译默认模型', value: defCharacterTranslate, set: setDefCharacterTranslate },
              { label: '角色扮演默认模型', value: defCharacterChat, set: setDefCharacterChat },
              { label: '每日话题生成模型', value: dailyTopicModel, set: setDailyTopicModel },
              { label: '摘要生成默认模型', value: defSummarization, set: setDefSummarization },
            ].map((item, i) => (
              <div key={i} className="flex items-center justify-between py-3 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-3">
                  <Bot size={18} className="text-muted-foreground" />
                  <span>{item.label}</span>
                </div>
                <ModelSelector
                  models={models}
                  currentModel={item.value}
                  onSelect={(modelId: string) => item.set(modelId)}
                  size="sm"
                />
              </div>
            ))}
            <div className="flex items-center justify-between py-3 border-t border-border/50">
              <div className="flex items-center gap-3">
                <Sparkles size={18} className="text-muted-foreground" />
                <div>
                  <p>允许AI分析用户个人OC卡</p>
                  <p className="text-xs text-muted-foreground">启用后AI可以深度分析用户的原创角色设定</p>
                </div>
              </div>
              <Switch checked={allowOCAnalysis} onCheckedChange={setAllowOCAnalysis} />
            </div>
            {allowOCAnalysis && (
              <div className="flex items-center justify-between py-3 border-b border-border/50">
                <div className="flex items-center gap-3">
                  <Bot size={18} className="text-muted-foreground" />
                  <span>OC分析默认模型</span>
                </div>
                <ModelSelector models={models} currentModel={defOCAnalysis} onSelect={setDefOCAnalysis} size="sm" />
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-end">
            <Button onClick={handleSaveDefaults}>
              <Save size={16} className="mr-2" />
              {t.save}
            </Button>
          </div>
        </GlassCard>

        <div className="space-y-4">
          <button
            onClick={() => setStartersExpanded(!startersExpanded)}
            className="w-full flex items-center justify-between p-3 rounded-xl transition-all bg-secondary hover:bg-secondary/80"
          >
            <div className="flex items-center gap-3">
              <HelpCircle size={18} className="text-muted-foreground" />
              <span className="font-medium">{t.admin_starters}</span>
            </div>
            <ChevronDown
              size={18}
              className={cn(
                'text-muted-foreground transition-transform duration-300',
                startersExpanded && 'rotate-180'
              )}
            />
          </button>

          {startersExpanded && (
            <div className="animate-in slide-in-from-top-2 fade-in duration-300">
              <GlassCard className="p-6">
                <p className="text-sm text-muted-foreground mb-4">
                  如果设置了"每日话题生成模型"，可以自动每日生成。
                </p>
                <textarea
                  value={starterQuestions.join('\n')}
                  onChange={(e) => setStarterQuestions(e.target.value.split('\n'))}
                  className="w-full h-48 p-4 rounded-xl bg-secondary border-none outline-none resize-none font-mono text-sm"
                  placeholder={t.enter_question_placeholder}
                />
                <div className="mt-4 flex justify-end">
                  <Button onClick={handleSaveStarters}>
                    <Save size={16} className="mr-2" />
                    {t.save}
                  </Button>
                </div>
              </GlassCard>
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
};
