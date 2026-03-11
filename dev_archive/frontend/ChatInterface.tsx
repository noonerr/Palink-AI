// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Bot, ChevronDown, Check, Sliders, Send, X, Image as ImageIcon, Paperclip,
  StopCircle, Brain, ChevronUp, Copy
} from 'lucide-react';

const CodeBlock = memo(({ inline, className, children, ...props }) => {
  const match = /language-(\w+)/.exec(className || '');
  const [copied, setCopied] = useState(false);
  if (inline || !match) return <code className="bg-gray-100 dark:bg-gray-800 text-pink-600 dark:text-pink-400 px-1.5 py-0.5 rounded text-[0.9em] font-mono border border-gray-200 dark:border-gray-700 mx-0.5 align-middle break-all" {...props}>{children}</code>;
  return (
    <div className="relative my-4 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-[#1e1e1e] shadow-sm group">
      <div className="flex justify-between px-3 py-1.5 bg-[#2d2d2d] text-xs text-gray-400 items-center select-none"><span className="font-mono font-bold text-gray-300">{match?.[1] || 'text'}</span><button onClick={()=>{navigator.clipboard.writeText(String(children));setCopied(true);setTimeout(()=>setCopied(false),2000)}} className="hover:text-white flex items-center gap-1 transition-colors">{copied ? <Check size={12}/> : <Copy size={12}/>}</button></div>
      <pre className="p-4 overflow-x-auto text-sm leading-relaxed text-gray-300 font-mono scrollbar-thin"><code>{children}</code></pre>
    </div>
  );
});

const ThinkingProcess = ({ content, streaming, t }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  useEffect(() => { if (streaming && content) setIsExpanded(true); }, [streaming]);
  if (!content) return null;
  return (
    <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#2c2c2c] overflow-hidden transition-all">
      <button onClick={() => setIsExpanded(!isExpanded)} className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-bold text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#333] transition-colors"><Brain size={14} className={streaming ? "animate-pulse text-purple-500" : "text-gray-400"}/><span>{t.thinking}</span><span className="ml-auto"></span>{isExpanded ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}</button>
      {isExpanded && (<div className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300 font-mono border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-[#222]"><ReactMarkdown components={{code:CodeBlock}}>{content}</ReactMarkdown></div>)}
    </div>
  );
};

export const ChatInterface = ({ token, user, sessionId, initialAttachments, onSessionChange, t, models, defaultModel, sessionType='chat', starterQuestions }) => {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [streaming, setStreaming] = useState(false);
    const [curModel, setCurModel] = useState(defaultModel || (models[0]?.id));
    const [attachments, setAttachments] = useState([]);
    const [suggestions, setSuggestions] = useState([]);
    const [contextUsage, setContextUsage] = useState({ used: 0, limit: 4096 });
    const bottomRef = useRef(null);
    const abortCtrl = useRef(null);
    const imgInputRef = useRef(null);
    const fileInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
    
    const messagesContainerRef = useRef(null);
    const [isUserScrolling, setIsUserScrolling] = useState(false);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const scrollTimeoutRef = useRef(null);
    
    const [generationParams, setGenerationParams] = useState({
        temperature: 0.6,
        top_p: 0.95,
        top_k: 40,
        repeat_penalty: 1.1,
        max_tokens: 2048
    });
    const [showParamsPanel, setShowParamsPanel] = useState(false);

    useEffect(() => {
        if(sessionId) { fetch(`/api/sessions/${sessionId}/messages`, { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then(d => { setMessages(d); setSuggestions([]); }); } 
        else { setMessages([]); if (initialAttachments?.length) setAttachments(initialAttachments); setSuggestions([]); }
    }, [sessionId]);

    const handleScroll = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        
        const { scrollTop, scrollHeight, clientHeight } = container;
        const atBottom = scrollHeight - scrollTop - clientHeight < 50;
        setIsAtBottom(atBottom);
        
        if (!atBottom) {
            setIsUserScrolling(true);
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }
            scrollTimeoutRef.current = setTimeout(() => {
                setIsUserScrolling(false);
            }, 3000);
        } else {
            setIsUserScrolling(false);
        }
    }, []);

    useEffect(() => { 
        if (!isUserScrolling || isAtBottom) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); 
        }
    }, [messages, streaming, suggestions, isUserScrolling, isAtBottom]);
    
    useEffect(() => {
        return () => {
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }
        };
    }, []);

    const handleUpload = async (e, type) => {
      const file = e.target.files?.[0]; if (!file) return; setUploading(true);
      const reader = new FileReader(); reader.onload = async (event) => { try { const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ filename: file.name, data: event.target.result }) }); if(res.ok) { const data = await res.json(); setAttachments(prev => [...prev, { type, url: data.url, name: file.name }]); } } catch(e) {} setUploading(false); }; reader.readAsDataURL(file); if(e.target.value) e.target.value = '';
    };

    const sendMessage = async (overrideText) => {
        const txt = overrideText || input;
        if((!txt.trim() && attachments.length === 0) || streaming || uploading) return;
        setInput(''); setAttachments([]); setStreaming(true); setSuggestions([]);
        
        let displayContent = txt;
        if (attachments.length > 0) { displayContent += "\n\n"; attachments.forEach(att => { displayContent += att.type === 'image' ? `![${att.name}](${att.url})\n` : `[📎 ${att.name}](${att.url})\n`; }); }
        
        setMessages(prev => [...prev, {role:'user', content:displayContent}, {role:'assistant', content:'', model: curModel}]);
        abortCtrl.current = new AbortController();
        let fullContent = ''; let fullReasoning = '';

        try {
            const res = await fetch('/api/chat', { 
                method: 'POST', 
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ 
                    session_id: sessionId, 
                    session_type: sessionType, 
                    message: txt, 
                    model: curModel, 
                    images: attachments.filter(a => a.type === 'image').map(a => a.url), 
                    files: attachments.filter(a => a.type === 'file').map(a => a.url),
                    temperature: generationParams.temperature,
                    top_p: generationParams.top_p,
                    top_k: generationParams.top_k,
                    repeat_penalty: generationParams.repeat_penalty,
                    max_tokens: generationParams.max_tokens
                }), 
                signal: abortCtrl.current.signal 
            });
            if (!sessionId) { setTimeout(onSessionChange, 1000); }
            const reader = res.body.getReader(); const dec = new TextDecoder();
            while(true) {
                const {done, value} = await reader.read(); if(done) break;
                const lines = dec.decode(value, {stream:true}).split('\n');
                for(const line of lines) {
                    if(line.startsWith('data: ')) {
                        const d = line.slice(6); if(d === '[DONE]') continue;
                        try { 
                            const j = JSON.parse(d); 
                            if (j.type === 'usage') {
                                setContextUsage({ used: j.context_used, limit: j.context_limit });
                                continue;
                            }
                            if (j.reasoning) fullReasoning += j.reasoning; 
                            if (j.content) fullContent += j.content; 
                            setMessages(prev => { const n = [...prev]; const last = n[n.length-1]; last.content = fullReasoning ? `<think>${fullReasoning}</think>${fullContent}` : fullContent; return n; }); 
                        } catch(e){}
                    }
                }
            }
            if (fullContent.length > 20) { fetch('/api/chat/suggestions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: fullContent, model: curModel }) }).then(r=>r.json()).then(setSuggestions).catch(()=>{}); }
        } catch(e) { if(e.name !== 'AbortError') setMessages(prev => { const n=[...prev]; n[n.length-1].content += `\n[Error: ${e.message}]`; return n; }); } finally { setStreaming(false); abortCtrl.current = null; }
    };
    
    const curModelObj = models.find(m => m.id === curModel) || { name: curModel };

    return (
        <div className="flex flex-col h-full bg-white dark:bg-[#121212]">
            {(messages.length > 0 || sessionId) && (
                <div className="h-14 flex items-center justify-between px-6 border-b border-gray-50 dark:border-gray-800 bg-white/80 dark:bg-[#121212]/80 backdrop-blur-md sticky top-0 z-20">
                     <div className="flex items-center gap-2">
                        <div className="relative">
                            <button 
                                onClick={() => setIsModelSelectorOpen(!isModelSelectorOpen)}
                                className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-[#222] hover:bg-gray-200 dark:hover:bg-[#333] rounded-full text-xs font-bold dark:text-gray-300 transition-colors"
                            >
                                <Bot size={14}/> 
                                {curModelObj.name}
                                <ChevronDown size={12} className={`transition-transform duration-200 ${isModelSelectorOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {isModelSelectorOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setIsModelSelectorOpen(false)}></div>
                                    <div className="absolute bottom-full left-0 mb-2 w-64 bg-white dark:bg-[#1c1c1c] rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 p-2 z-[9999] animate-in fade-in slide-in-from-bottom-2 duration-200 origin-bottom-left">
                                        <div className="max-h-80 overflow-y-auto">
                                            {models.map(m => (
                                                <button 
                                                    key={m.id} 
                                                    onClick={() => { setCurModel(m.id); setIsModelSelectorOpen(false); }}
                                                    className={`w-full text-left px-3 py-2.5 rounded-xl text-xs font-medium flex items-center gap-3 transition-colors ${curModel === m.id ? 'bg-black text-white dark:bg-white dark:text-black' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-[#2c2c2c]'}`}
                                                >
                                                    <span className="text-lg">
                                                        {m.icon?.startsWith('http') || m.icon?.startsWith('/') ? (
                                                            <img src={m.icon} alt="" className="w-5 h-5 object-contain" />
                                                        ) : (
                                                            m.icon || '🤖'
                                                        )}
                                                    </span>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="truncate">{m.name}</div>
                                                        <div className="text-[10px] opacity-50 truncate">{m.provider} • {m.context_length/1024}k{m.size ? ` • ${m.size}GB` : ''}</div>
                                                    </div>
                                                    {curModel === m.id && <Check size={14} className="ml-auto" />}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                        
                        <button 
                            onClick={() => setShowParamsPanel(!showParamsPanel)}
                            className="flex items-center gap-1 px-2 py-1.5 bg-gray-100 dark:bg-[#222] hover:bg-gray-200 dark:hover:bg-[#333] rounded-full text-xs font-bold dark:text-gray-300 transition-colors ml-2"
                            title="生成参数设置"
                        >
                            <Sliders size={14}/>
                        </button>
                        
                        {showParamsPanel && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowParamsPanel(false)}></div>
                                <div className="absolute top-full left-0 mt-2 w-72 bg-white dark:bg-[#1c1c1c] rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 p-4 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                                    <div className="flex items-center justify-between mb-4">
                                        <h3 className="text-sm font-bold dark:text-white">生成参数</h3>
                                        <button 
                                            onClick={() => setGenerationParams({
                                                temperature: 0.6,
                                                top_p: 0.95,
                                                top_k: 40,
                                                repeat_penalty: 1.1,
                                                max_tokens: 2048
                                            })}
                                            className="text-xs text-primary hover:underline"
                                        >
                                            重置默认
                                        </button>
                                    </div>
                                    
                                    <div className="space-y-4">
                                        <div>
                                            <div className="flex justify-between text-xs mb-1">
                                                <span className="text-gray-600 dark:text-gray-400">Temperature</span>
                                                <span className="font-mono dark:text-white">{generationParams.temperature}</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0"
                                                max="2"
                                                step="0.1"
                                                value={generationParams.temperature}
                                                onChange={(e) => setGenerationParams(prev => ({...prev, temperature: parseFloat(e.target.value)}))}
                                                className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                            />
                                            <div className="text-[10px] text-gray-400 mt-1">创造性 vs 确定性</div>
                                        </div>
                                        
                                        <div>
                                            <div className="flex justify-between text-xs mb-1">
                                                <span className="text-gray-600 dark:text-gray-400">Top P</span>
                                                <span className="font-mono dark:text-white">{generationParams.top_p}</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0"
                                                max="1"
                                                step="0.05"
                                                value={generationParams.top_p}
                                                onChange={(e) => setGenerationParams(prev => ({...prev, top_p: parseFloat(e.target.value)}))}
                                                className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                            />
                                        </div>
                                        
                                        <div>
                                            <div className="flex justify-between text-xs mb-1">
                                                <span className="text-gray-600 dark:text-gray-400">重复惩罚</span>
                                                <span className="font-mono dark:text-white">{generationParams.repeat_penalty}</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="1"
                                                max="2"
                                                step="0.1"
                                                value={generationParams.repeat_penalty}
                                                onChange={(e) => setGenerationParams(prev => ({...prev, repeat_penalty: parseFloat(e.target.value)}))}
                                                className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                            />
                                        </div>
                                        
                                        <div>
                                            <div className="flex justify-between text-xs mb-1">
                                                <span className="text-gray-600 dark:text-gray-400">最大Token</span>
                                                <span className="font-mono dark:text-white">{generationParams.max_tokens}</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="256"
                                                max="4096"
                                                step="256"
                                                value={generationParams.max_tokens}
                                                onChange={(e) => setGenerationParams(prev => ({...prev, max_tokens: parseInt(e.target.value)}))}
                                                className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {contextUsage.used > 0 && (
                            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                                <span>{t.context_usage}</span>
                                <span className="font-mono">{contextUsage.used}/{contextUsage.limit}</span>
                                <span className="text-xs opacity-70">{t.tokens}</span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            <div 
                ref={messagesContainerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto p-4 space-y-4"
            >
                {messages.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center">
                        <div className="text-5xl mb-4">💬</div>
                        <h2 className="text-xl font-bold dark:text-white mb-2">{t.welcome_greeting}</h2>
                        <p className="text-gray-500 dark:text-gray-400 mb-8 text-center max-w-md">{t.ai_disclaimer}</p>
                        {starterQuestions && starterQuestions.length > 0 && (
                            <div className="w-full max-w-md">
                                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 text-center">{t.random_prompts}</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {starterQuestions.map((q, idx) => (
                                        <button key={idx} onClick={() => sendMessage(q)} className="px-4 py-3 bg-gray-50 dark:bg-[#1c1c1c] border border-gray-200 dark:border-gray-800 rounded-xl text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#252525] transition-all">
                                            {q}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
                {messages.map((msg, idx) => {
                    const isUser = msg.role === 'user';
                    const hasReasoning = msg.content.includes('<think>');
                    const content = hasReasoning ? msg.content.replace(/<think>(.*?)<\/think>/s, '') : msg.content;
                    const reasoning = hasReasoning ? msg.content.match(/<think>(.*?)<\/think>/s)[1] : '';

                    return (
                        <div key={idx} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                            {(content.trim() || (streaming && idx === messages.length - 1)) && (
                                <div className={`max-w-[80%] ${isUser ? 'bg-black dark:bg-white text-white dark:text-black rounded-tl-2xl rounded-tr-lg rounded-bl-2xl p-4 shadow-sm' : 'bg-gray-50 dark:bg-[#1c1c1c] rounded-tl-2xl rounded-tr-2xl rounded-br-2xl rounded-bl-lg p-4 shadow-sm border border-gray-200 dark:border-gray-800'}`}>
                                    {!isUser && reasoning && (
                                        <ThinkingProcess content={reasoning} streaming={streaming && idx === messages.length - 1} t={t} />
                                    )}
                                    <ReactMarkdown components={{code:CodeBlock}}>{content}</ReactMarkdown>
                                </div>
                            )}
                        </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>

            <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-[#121212]">
                <div className="flex items-center gap-2 mb-2">
                    {attachments.map((att, idx) => (
                        <div key={idx} className="flex items-center gap-1 px-3 py-1 bg-gray-100 dark:bg-[#2c2c2c] rounded-full text-xs">
                            {att.type === 'image' ? '🖼️' : '📄'} {att.name}
                            <button onClick={() => setAttachments(attachments.filter((_, i) => i !== idx))} className="text-gray-400 hover:text-red-500">
                                <X size={12} />
                            </button>
                        </div>
                    ))}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={() => imgInputRef.current.click()} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-[#2c2c2c] text-gray-500 dark:text-gray-400">
                        <ImageIcon size={20} />
                    </button>
                    <input type="file" ref={imgInputRef} onChange={(e) => handleUpload(e, 'image')} accept="image/*" className="hidden" />
                    <button onClick={() => fileInputRef.current.click()} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-[#2c2c2c] text-gray-500 dark:text-gray-400">
                        <Paperclip size={20} />
                    </button>
                    <input type="file" ref={fileInputRef} onChange={(e) => handleUpload(e, 'file')} className="hidden" />
                    <div className="flex-1 relative">
                        <textarea 
                            value={input} 
                            onChange={(e) => setInput(e.target.value)} 
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    sendMessage();
                                }
                            }}
                            placeholder={t.ask_anything}
                            className="w-full px-4 py-3 rounded-xl bg-gray-50 dark:bg-[#1c1c1c] border border-gray-200 dark:border-gray-800 dark:text-white outline-none resize-none min-h-[60px] max-h-[200px]"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => sendMessage()} disabled={(!input.trim() && attachments.length === 0) || streaming || uploading} className="p-2.5 rounded-xl bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors">
                            <Send size={20} />
                        </button>
                        {streaming && (
                            <button onClick={() => { if (abortCtrl.current) abortCtrl.current.abort(); setStreaming(false); }} className="p-2.5 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors">
                                <StopCircle size={20} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {suggestions.length > 0 && (
                <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-[#121212]">
                    <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">{t.suggested_topics}</div>
                    <div className="flex flex-wrap gap-2">
                        {suggestions.map((s, idx) => (
                            <button key={idx} onClick={() => sendMessage(s)} className="px-3 py-1.5 bg-gray-50 dark:bg-[#1c1c1c] border border-gray-200 dark:border-gray-800 rounded-lg text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#252525] transition-all flex items-center justify-center h-[40px]">
                                {s}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
