import React from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';

interface AboutTabProps {
  t: Record<string, string>;
}

export const AboutTab: React.FC<AboutTabProps> = ({ t }) => {
  return (
    <ScrollArea className="h-full">
      <div className="text-center py-12 animate-fade-in pr-2 pb-28">
        <div className="w-24 h-24 bg-gradient-to-br from-primary to-primary/60 rounded-3xl mx-auto flex items-center justify-center mb-6 shadow-xl shadow-primary/20">
          <span className="text-primary-foreground text-4xl font-bold">P</span>
        </div>
        <h2 className="text-2xl font-semibold mb-2">{t.about_title}</h2>
        <p className="text-muted-foreground mb-8">{t.about_desc}</p>
        <div className="flex justify-center gap-4 text-sm text-muted-foreground">
          <span>{t.version}</span>
          <span>•</span>
          <span>{t.privacy_policy}</span>
        </div>
      </div>
    </ScrollArea>
  );
};
