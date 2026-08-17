import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { CharacterUIConfig, CharacterThemeConfig, Character } from '@/types';

interface CharacterUIContextType {
  uiConfig: CharacterUIConfig | null;
  setActiveCharacter: (character: Character | null) => void;
  applyUIConfig: (config: CharacterUIConfig) => void;
  resetUIConfig: () => void;
}

const CharacterUIContext = createContext<CharacterUIContextType | undefined>(undefined);

export const CharacterUIProvider = ({ children }: { children: React.ReactNode }) => {
  const [uiConfig, setUIConfig] = useState<CharacterUIConfig | null>(null);
  const [currentCharacterId, setCurrentCharacterId] = useState<string | null>(null);

  const setActiveCharacter = useCallback((character: Character | null) => {
    if (character) {
      setCurrentCharacterId(character.id);
      let config = character.ui_config || null;

      if (!config && character.extensions) {
        const fromExtensions = getCharacterUIConfig(character.extensions);
        if (fromExtensions) config = fromExtensions;
      }

      setUIConfig(config);
    } else {
      setCurrentCharacterId(null);
      setUIConfig(null);
    }
  }, []);

  const applyUIConfig = useCallback((config: CharacterUIConfig) => {
    setUIConfig(config);
  }, []);

  const resetUIConfig = useCallback(() => {
    setUIConfig(null);
  }, []);

  useEffect(() => {
    const styleId = 'character-ui-styles';
    let styleElement = document.getElementById(styleId) as HTMLStyleElement | null;

    if (uiConfig) {
      if (!styleElement) {
        styleElement = document.createElement('style');
        styleElement.id = styleId;
        document.head.appendChild(styleElement);
      }

      let css = '';

      if (uiConfig.theme) {
        const { primary_color, secondary_color, accent_color, text_color, bg_color, border_color } = uiConfig.theme;
        if (primary_color) css += `:root { --character-primary-color: ${primary_color}; }\n`;
        if (secondary_color) css += `:root { --character-secondary-color: ${secondary_color}; }\n`;
        if (accent_color) css += `:root { --character-accent-color: ${accent_color}; }\n`;
        if (text_color) css += `:root { --character-text-color: ${text_color}; }\n`;
        if (bg_color) css += `:root { --character-bg-color: ${bg_color}; }\n`;
        if (border_color) css += `:root { --character-border-color: ${border_color}; }\n`;
      }

      if (uiConfig.background) {
        const { type, image_url, image_blur, image_opacity, color } = uiConfig.background;
        if (type === 'color' && color) {
          css += `:root { --character-bg: ${color}; }\n`;
        }
      }

      if (uiConfig.custom_css) {
        css += uiConfig.custom_css + '\n';
      }

      styleElement.textContent = css;
    } else {
      if (styleElement) {
        styleElement.textContent = '';
      }
    }

    return () => {
      const existingStyle = document.getElementById(styleId);
      if (existingStyle) {
        existingStyle.remove();
      }
    };
  }, [uiConfig]);

  return (
    <CharacterUIContext.Provider value={{ uiConfig, setActiveCharacter, applyUIConfig, resetUIConfig }}>
      {children}
    </CharacterUIContext.Provider>
  );
};

export const useCharacterUI = () => {
  const context = useContext(CharacterUIContext);
  if (!context) {
    return { uiConfig: null, setActiveCharacter: () => {}, applyUIConfig: () => {}, resetUIConfig: () => {} };
  }
  return context;
};

export const getCharacterUIConfig = (extensions: Record<string, any> | undefined): CharacterUIConfig | undefined => {
  if (!extensions) return undefined;

  const uiConfig: CharacterUIConfig = {};

  if (extensions.palink_ui && typeof extensions.palink_ui === 'object') {
    const stUi = extensions.palink_ui;
    if (stUi.theme) uiConfig.theme = { ...stUi.theme };
    if (stUi.background) uiConfig.background = { ...stUi.background };
    if (stUi.message_bubbles) uiConfig.message_bubbles = { ...stUi.message_bubbles };
    if (stUi.effects) uiConfig.effects = { ...stUi.effects };
    if (stUi.custom_css) uiConfig.custom_css = stUi.custom_css;
  }

  if (extensions.tavern_ui && typeof extensions.tavern_ui === 'object') {
    const tu = extensions.tavern_ui;
    if (tu.theme && !uiConfig.theme) uiConfig.theme = { ...tu.theme };
    if (tu.background && !uiConfig.background) uiConfig.background = { ...tu.background };
    if (tu.message_bubbles && !uiConfig.message_bubbles) uiConfig.message_bubbles = { ...tu.message_bubbles };
    if (tu.effects && !uiConfig.effects) uiConfig.effects = { ...tu.effects };
    if (tu.custom_css && !uiConfig.custom_css) uiConfig.custom_css = tu.custom_css;
  }

  if (extensions.chroma && typeof extensions.chroma === 'object' && !uiConfig.theme) {
    const chroma = extensions.chroma;
    const theme: CharacterThemeConfig = {};
    if (chroma.primary_color) theme.primary_color = chroma.primary_color;
    if (chroma.secondary_color) theme.secondary_color = chroma.secondary_color;
    if (chroma.accent_color) theme.accent_color = chroma.accent_color;
    if (Object.keys(theme).length > 0) uiConfig.theme = theme;
  }

  if (extensions.custom_css && typeof extensions.custom_css === 'string' && !uiConfig.custom_css) {
    uiConfig.custom_css = extensions.custom_css;
  }

  return Object.keys(uiConfig).length > 0 ? uiConfig : undefined;
};
