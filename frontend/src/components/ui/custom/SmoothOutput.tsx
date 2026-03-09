import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { CodeBlock } from './CodeBlock';

interface SmoothOutputProps {
  content: string;
  streaming?: boolean;
}

export const SmoothOutput: React.FC<SmoothOutputProps> = ({
  content,
  streaming = false
}) => {
  const [displayContent, setDisplayContent] = useState('');

  useEffect(() => {
    if (!streaming) {
      setDisplayContent(content);
      return;
    }
    setDisplayContent(content);
  }, [content, streaming]);

  return (
    <div className="markdown-content">
      {streaming ? (
        <div className="whitespace-pre-wrap">
          {displayContent}
          <span className="inline-block w-0.5 h-4 bg-primary/60 ml-0.5 animate-pulse align-middle" />
        </div>
      ) : (
        <ReactMarkdown components={{ code: CodeBlock }}>
          {displayContent}
        </ReactMarkdown>
      )}
    </div>
  );
};
