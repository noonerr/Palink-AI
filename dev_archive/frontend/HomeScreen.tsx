// @ts-nocheck
import React, { useState } from 'react';
import { Cpu, Database, HardDrive, ArrowUp, ChevronDown, Sparkles, Check } from 'lucide-react';

const Button = ({ children, onClick, variant="primary", className="", icon: Icon, size="md", disabled, title, ...props }) => {
    const sizeClasses = { sm: "px-3 py-1.5 text-xs h-8", md: "px-4 py-2 text-sm h-10", lg: "px-6 py-3 text-base h-12", icon: "p-2 h-10 w-10 justify-center" };
    const variants = {
        primary: "bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 shadow-sm border border-transparent",
        secondary: "bg-white dark:bg-[#2c2c2c] text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-[#3a3a3a] shadow-sm",
        ghost: "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#2c2c2c] hover:text-black dark:hover:text-white",
        danger: "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30",
        outline: "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 bg-transparent"
    };
    return (<button onClick={onClick} disabled={disabled} title={title} className={`flex items-center gap-2 rounded-xl font-medium transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${sizeClasses[size] || sizeClasses.md} ${variants[variant]} ${className}`} {...props}>{Icon && <Icon size={size === 'sm' ? 14 : 18} />}{children}</button>);
};

interface HomeScreenProps {
  t: Record<string, string>;
  models: any[];
  onSelectModel: (modelId: string) => void;
  onSelectStarter?: (question: string) => void;
  starterQuestions: string[];
  currentModelId: string;
  onSendMessage: (message: string) => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  t,
  models,
  onSelectModel,
  onSelectStarter,
  starterQuestions,
  currentModelId,
  onSendMessage
}) => {
  const [input, setInput] = useState('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  
  const currentModel = models.find(m => m.id === currentModelId) || models[0] || { 
    name: 'AI Assistant', 
    icon: '🤖', 
    description: t.welcome_greeting, 
    context_length: 4096 
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-white dark:bg-[#121212] p-4 relative overflow-hidden">
      <div className="w-full max-w-2xl flex flex-col items-center z-10 -mt-16 animate-in fade-in slide-in-from-bottom-8 duration-700">
        
        <div className="mb-10 text-center flex flex-col items-center gap-6">
          <div className="w-28 h-28 rounded-[32px] mx-auto flex items-center justify-center text-6xl overflow-hidden transform hover:scale-105 transition-transform duration-500">
            {currentModel.avatar ? (
              currentModel.avatar.startsWith('http') || currentModel.avatar.startsWith('data:') || currentModel.avatar.startsWith('/') ? 
              <img src={currentModel.avatar} className="w-full h-full object-cover"/> : 
              <span className="text-6xl">{currentModel.avatar}</span>
            ) : (
              currentModel.icon?.startsWith('http') || currentModel.icon?.startsWith('/') ? 
              <img src={currentModel.icon} className="w-full h-full object-cover"/> : 
              (currentModel.icon || '🤖')
            )}
          </div>
          <div className="flex flex-col items-center">
            <h1 className="text-3xl font-extrabold dark:text-white mb-2 tracking-tight flex items-center gap-2">
              {currentModel.name}
            </h1>
            <div className="flex items-center gap-2 text-xs font-mono text-gray-400 bg-gray-100 dark:bg-[#1e1e1e] px-2 py-1 rounded-md mb-2 flex-wrap">
              <Cpu size={12}/> {currentModel.id}
              <div className="h-3 w-px bg-gray-300 dark:bg-gray-600 mx-1"/>
              <Database size={12}/> {Math.round(currentModel.context_length / 1024)}K Context
              {currentModel.size && (
                <>
                  <div className="h-3 w-px bg-gray-300 dark:bg-gray-600 mx-1"/>
                  <HardDrive size={12}/> {currentModel.size}GB
                </>
              )}
            </div>
            <p className="text-gray-400 dark:text-gray-500 text-base max-w-md mx-auto leading-relaxed">
              {currentModel.description || t.welcome_greeting}
            </p>
          </div>
        </div>

        <div className="w-full relative group">
          <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-[28px] blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-700"/>
          <div className="relative w-full bg-white dark:bg-[#1c1c1c] rounded-[24px] shadow-2xl shadow-gray-200/50 dark:shadow-black/20 border border-gray-100 dark:border-gray-800 p-2 transition-all focus-within:ring-2 focus-within:ring-black/5 dark:focus-within:ring-white/10 hover:shadow-xl dark:hover:shadow-black/30">
            <textarea 
              value={input} 
              onChange={e => setInput(e.target.value)} 
              onKeyDown={e => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); onSendMessage(input); } }} 
              placeholder={t.ask_anything} 
              className="w-full bg-transparent border-none outline-none resize-none px-5 py-4 text-lg dark:text-white placeholder-gray-400/80 min-h-[64px] max-h-[200px]" 
              rows={1}
            />
            <div className="flex justify-between items-center px-3 pb-1">
              <div className="relative">
                <button 
                  onClick={() => setIsModelMenuOpen(!isModelMenuOpen)} 
                  className="flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-gray-100 dark:hover:bg-[#2c2c2c] text-xs font-bold text-gray-500 dark:text-gray-400 transition-all active:scale-95"
                >
                  <span className="opacity-70 text-base">
                    {currentModel.icon?.startsWith('http') || currentModel.icon?.startsWith('/') ? (
                      <img src={currentModel.icon} alt="" className="w-4 h-4 object-contain inline-block" />
                    ) : (
                      currentModel.icon || '🤖'
                    )}
                  </span>
                  {currentModel.name}
                  <ChevronDown size={14} className={`opacity-50 transition-transform duration-300 ${isModelMenuOpen ? 'rotate-180' : ''}`}/>
                </button>
                {isModelMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={()=>setIsModelMenuOpen(false)}/>
                    <div className="absolute bottom-full left-0 mb-2 w-72 bg-white dark:bg-[#1c1c1c] rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-800 p-2 z-[9999] animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 origin-bottom-left">
                      <div className="max-h-64 overflow-y-auto p-1 space-y-1">
                        {models.map(m => (
                          <button 
                            key={m.id} 
                            onClick={()=>{onSelectModel(m.id); setIsModelMenuOpen(false);}} 
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${currentModelId===m.id ? 'bg-black/5 dark:bg-white/10 font-bold dark:text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-[#2c2c2c]'}`}
                          >
                            <span className="text-lg">
                              {m.icon?.startsWith('http') || m.icon?.startsWith('/') ? (
                                <img src={m.icon} alt="" className="w-5 h-5 object-contain" />
                              ) : (
                                m.icon || '🤖'
                              )}
                            </span>
                            <div className="flex flex-col items-start overflow-hidden">
                              <span className="truncate w-full">{m.name}</span>
                              <span className="text-[10px] opacity-50 truncate w-full flex gap-1">
                                <span className="truncate">{m.provider}</span> • {m.context_length/1024}k
                              </span>
                            </div>
                            {currentModelId===m.id && <Check size={14} className="ml-auto opacity-50"/>}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button 
                  onClick={()=>onSendMessage(input)} 
                  disabled={!input.trim()} 
                  icon={ArrowUp} 
                  className="!p-2.5 !rounded-xl !h-auto"
                />
              </div>
            </div>
          </div>
        </div>

        {starterQuestions && starterQuestions.length > 0 && (
          <div className="mt-12 w-full max-w-2xl">
            <h3 className="text-center text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center justify-center gap-2 opacity-60">
              <Sparkles size={12}/> {t.suggested_topics}
            </h3>
            <div className="flex flex-wrap justify-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-700">
              {starterQuestions.map((q, idx) => (
                <button 
                  key={idx} 
                  onClick={() => onSendMessage(q)} 
                  className="px-5 py-3 bg-gray-50 dark:bg-[#1c1c1c] border border-gray-100 dark:border-gray-800 rounded-2xl text-sm font-medium text-gray-600 dark:text-gray-300 hover:scale-105 hover:bg-white dark:hover:bg-[#252525] hover:shadow-md transition-all"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
