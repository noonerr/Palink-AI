import { useState, useCallback } from 'react';
import type { CharacterChatMessage } from '@/types';

const MESSAGE_TAGS = [
  { type: 'action', start: '<|a|>', end: '</|a|>' },
  { type: 'thinking', start: '<|t|>', end: '</|t|>' },
  { type: 'action', start: '<|a|>', end: '<|/a|>' },
  { type: 'thinking', start: '<|t|>', end: '<|/t|>' },
  { type: 'modelReasoning', start: '<model_reasoning>', end: '</model_reasoning>' },
  { type: 'thinking', start: '<thinking>', end: '</thinking>' },
  { type: 'thinking', start: '<think>', end: '</think>' },
  { type: 'action', start: '<action>', end: '</action>' },
  { type: 'action', start: '[action]', end: '[/action]' },
] as const;

function decodeHtmlEntities(content: string): string {
  let result = content;
  for (let i = 0; i < 3; i++) {
    result = result
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return result;
}

export function getAllMessagePartIds(content: string): string[] {
  const processedContent = decodeHtmlEntities(content);

  type MessagePart = { type: string; id: string };
  const parts: MessagePart[] = [];
  let remainingContent = processedContent;
  let actionIndex = 0;
  let textIndex = 0;

  while (remainingContent.length > 0) {
    let bestMatch: { tag: typeof MESSAGE_TAGS[number]; startIdx: number; endIdx: number } | null = null;

    for (const tag of MESSAGE_TAGS) {
      const startIdx = remainingContent.indexOf(tag.start);
      if (startIdx !== -1) {
        const endIdx = remainingContent.indexOf(tag.end, startIdx + tag.start.length);
        if (endIdx !== -1) {
          if (!bestMatch || startIdx < bestMatch.startIdx) {
            bestMatch = { tag, startIdx, endIdx };
          }
        }
      }
    }

    if (bestMatch) {
      if (bestMatch.startIdx > 0) {
        const beforeText = remainingContent.substring(0, bestMatch.startIdx);
        if (beforeText.trim()) {
          parts.push({ type: 'text', id: `text-${textIndex++}` });
        }
      }

      let partId: string;
      if (bestMatch.tag.type === 'action') {
        partId = `action-${actionIndex++}`;
      } else if (bestMatch.tag.type === 'modelReasoning') {
        partId = 'modelReasoning';
      } else {
        partId = 'thinking';
      }

      parts.push({ type: bestMatch.tag.type, id: partId });
      remainingContent = remainingContent.substring(bestMatch.endIdx + bestMatch.tag.end.length);
    } else {
      if (remainingContent.trim()) {
        parts.push({ type: 'text', id: `text-${textIndex++}` });
      }
      break;
    }
  }

  return parts.map(part => part.id);
}

function rebuildContentWithoutParts(content: string, selectedParts: Set<string>): string {
  const decoded = decodeHtmlEntities(content);
  const partsToKeep: string[] = [];
  let remainingContent = decoded;
  let actionIndex = 0;
  let textIndex = 0;

  while (remainingContent.length > 0) {
    let bestMatch: { tag: typeof MESSAGE_TAGS[number]; startIdx: number; endIdx: number } | null = null;

    for (const tag of MESSAGE_TAGS) {
      const startIdx = remainingContent.indexOf(tag.start);
      if (startIdx !== -1) {
        const endIdx = remainingContent.indexOf(tag.end, startIdx + tag.start.length);
        if (endIdx !== -1) {
          if (!bestMatch || startIdx < bestMatch.startIdx) {
            bestMatch = { tag, startIdx, endIdx };
          }
        }
      }
    }

    if (bestMatch) {
      if (bestMatch.startIdx > 0) {
        const beforeText = remainingContent.substring(0, bestMatch.startIdx);
        const textId = `text-${textIndex++}`;
        if (!selectedParts.has(textId)) {
          partsToKeep.push(beforeText);
        }
      }

      let partId: string;
      if (bestMatch.tag.type === 'action') {
        partId = `action-${actionIndex++}`;
      } else if (bestMatch.tag.type === 'modelReasoning') {
        partId = 'modelReasoning';
      } else {
        partId = 'thinking';
      }

      const fullMatch = remainingContent.substring(
        bestMatch.startIdx,
        bestMatch.endIdx + bestMatch.tag.end.length
      );

      if (!selectedParts.has(partId)) {
        partsToKeep.push(fullMatch);
      }

      remainingContent = remainingContent.substring(bestMatch.endIdx + bestMatch.tag.end.length);
    } else {
      const textId = `text-${textIndex++}`;
      if (!selectedParts.has(textId)) {
        partsToKeep.push(remainingContent);
      }
      break;
    }
  }

  return partsToKeep.join('');
}

interface UseMessageSelectionOptions {
  messages: CharacterChatMessage[];
  handleDeleteMessage: (messageId: number, messageIndex: number) => Promise<void>;
  handleEditMessage: (messageId: number, messageIndex: number, newContent: string) => Promise<void>;
}

export function useMessageSelection({
  messages,
  handleDeleteMessage,
  handleEditMessage,
}: UseMessageSelectionOptions) {
  const [isMixedDeleteMode, setIsMixedDeleteMode] = useState(false);
  const [selectedWholeMessages, setSelectedWholeMessages] = useState<Set<number>>(new Set());
  const [selectedMessageParts, setSelectedMessageParts] = useState<Map<number, Set<string>>>(new Map());
  const [showDeleteMixedConfirm, setShowDeleteMixedConfirm] = useState(false);

  const toggleWholeMessageSelect = useCallback((messageIndex: number) => {
    const msg = messages[messageIndex];
    if (!msg) return;

    const isSelecting = !selectedWholeMessages.has(messageIndex);

    if (isSelecting) {
      setSelectedWholeMessages(prev => {
        const newSet = new Set(prev);
        newSet.add(messageIndex);
        return newSet;
      });

      const partsToSelect = getAllMessagePartIds(msg.content);
      if (partsToSelect.length > 0) {
        setSelectedMessageParts(prev => {
          const newMap = new Map(prev);
          newMap.set(messageIndex, new Set(partsToSelect));
          return newMap;
        });
      }
    } else {
      setSelectedWholeMessages(prev => {
        const newSet = new Set(prev);
        newSet.delete(messageIndex);
        return newSet;
      });
      setSelectedMessageParts(prev => {
        const newMap = new Map(prev);
        newMap.delete(messageIndex);
        return newMap;
      });
    }
  }, [messages, selectedWholeMessages]);

  const toggleMessagePartSelect = useCallback((messageIndex: number, partId: string) => {
    setSelectedMessageParts(prev => {
      const newMap = new Map(prev);
      const currentParts = newMap.get(messageIndex) || new Set();
      const newParts = new Set(currentParts);
      if (newParts.has(partId)) {
        newParts.delete(partId);
      } else {
        newParts.add(partId);
      }
      if (newParts.size === 0) {
        newMap.delete(messageIndex);
        setSelectedWholeMessages(prev => {
          const newSet = new Set(prev);
          newSet.delete(messageIndex);
          return newSet;
        });
      } else {
        newMap.set(messageIndex, newParts);
      }
      return newMap;
    });
  }, []);

  const selectAllPartsInMessage = useCallback((messageIndex: number) => {
    const msg = messages[messageIndex];
    if (!msg) return;

    const partsToSelect = getAllMessagePartIds(msg.content);

    setSelectedMessageParts(prev => {
      const newMap = new Map(prev);
      newMap.set(messageIndex, new Set(partsToSelect));
      return newMap;
    });

    if (partsToSelect.length > 0) {
      setSelectedWholeMessages(prev => {
        const newSet = new Set(prev);
        newSet.add(messageIndex);
        return newSet;
      });
    }
  }, [messages]);

  const handleMixedDelete = useCallback(() => {
    if (selectedWholeMessages.size === 0 && selectedMessageParts.size === 0) return;
    setShowDeleteMixedConfirm(true);
  }, [selectedWholeMessages, selectedMessageParts]);

  const confirmDeleteMixed = useCallback(async () => {
    try {
      const sortedIndices = Array.from(selectedWholeMessages).sort((a, b) => b - a);

      for (const idx of sortedIndices) {
        const msg = messages[idx];
        if (msg && msg.id !== undefined) {
          await handleDeleteMessage(msg.id as number, idx);
        }
      }

      const partIndices = Array.from(selectedMessageParts.keys()).sort((a, b) => b - a);

      for (const idx of partIndices) {
        if (!selectedWholeMessages.has(idx)) {
          const msg = messages[idx];
          if (msg && msg.id !== undefined) {
            const selectedParts = selectedMessageParts.get(idx) || new Set();
            const result = rebuildContentWithoutParts(msg.content, selectedParts);
            await handleEditMessage(msg.id, idx, result);
          }
        }
      }

      setSelectedWholeMessages(new Set());
      setSelectedMessageParts(new Map());
      setIsMixedDeleteMode(false);
    } catch (e) {
      console.error('Failed to delete:', e);
    } finally {
      setShowDeleteMixedConfirm(false);
    }
  }, [messages, selectedWholeMessages, selectedMessageParts, handleDeleteMessage, handleEditMessage]);

  const clearSelection = useCallback(() => {
    setSelectedWholeMessages(new Set());
    setSelectedMessageParts(new Map());
  }, []);

  return {
    isMixedDeleteMode,
    setIsMixedDeleteMode,
    selectedWholeMessages,
    selectedMessageParts,
    showDeleteMixedConfirm,
    setShowDeleteMixedConfirm,
    toggleWholeMessageSelect,
    toggleMessagePartSelect,
    selectAllPartsInMessage,
    handleMixedDelete,
    confirmDeleteMixed,
    clearSelection,
  };
}
