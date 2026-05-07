import React, { useState, useCallback } from 'react';
import { X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageItem {
  url: string;
  name?: string;
}

interface ImageViewerProps {
  images: ImageItem[];
  onFullscreen?: (index: number) => void;
  compact?: boolean;
}

export const ImageThumbnails: React.FC<ImageViewerProps> = ({ images, onFullscreen, compact = false }) => {
  if (!images.length) return null;

  return (
    <div className={cn(
      "flex flex-wrap gap-2",
      compact ? "mt-1.5" : "mt-2.5"
    )}>
      {images.map((img, idx) => (
        <div
          key={idx}
          className={cn(
            "relative group rounded-lg overflow-hidden cursor-pointer border border-white/10",
            "transition-all duration-200 hover:ring-2 hover:ring-primary/50 hover:shadow-lg",
            compact ? "w-14 h-14" : "w-20 h-20"
          )}
          onClick={() => onFullscreen?.(idx)}
        >
          <img
            src={img.url}
            alt={img.name || `图片 ${idx + 1}`}
            className="w-full h-full object-cover"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
            <ZoomIn className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      ))}
    </div>
  );
};

interface FullscreenViewerProps {
  images: ImageItem[];
  initialIndex?: number;
  onClose: () => void;
}

export const FullscreenImageViewer: React.FC<FullscreenViewerProps> = ({
  images,
  initialIndex = 0,
  onClose,
}) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);

  const handlePrev = useCallback(() => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
    setZoom(1);
  }, [images.length]);

  const handleNext = useCallback(() => {
    setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
    setZoom(1);
  }, [images.length]);

  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + 0.5, 4));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - 0.5, 0.5));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowLeft') handlePrev();
    if (e.key === 'ArrowRight') handleNext();
    if (e.key === '+' || e.key === '=') handleZoomIn();
    if (e.key === '-') handleZoomOut();
  }, [onClose, handlePrev, handleNext, handleZoomIn, handleZoomOut]);

  if (!images.length) return null;

  const currentImage = images[currentIndex];

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      autoFocus
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        animation: 'fadeIn 0.2s ease-out',
      }}
    >
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
      >
        <X size={24} />
      </button>

      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 bg-black/50 rounded-full px-4 py-2 text-white text-sm">
        <span>{currentIndex + 1} / {images.length}</span>
        {currentImage?.name && (
          <span className="text-white/60 ml-2 truncate max-w-[200px]">{currentImage.name}</span>
        )}
      </div>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
        <button
          onClick={handleZoomOut}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        >
          <ZoomOut size={20} />
        </button>
        <span className="text-white text-sm min-w-[60px] text-center">{Math.round(zoom * 100)}%</span>
        <button
          onClick={handleZoomIn}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        >
          <ZoomIn size={20} />
        </button>
      </div>

      {images.length > 1 && (
        <>
          <button
            onClick={handlePrev}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          >
            <ChevronLeft size={28} />
          </button>
          <button
            onClick={handleNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          >
            <ChevronRight size={28} />
          </button>
        </>
      )}

      <div className="max-w-[90vw] max-h-[85vh] flex items-center justify-center overflow-auto">
        <img
          src={currentImage?.url}
          alt={currentImage?.name || `图片 ${currentIndex + 1}`}
          className="max-w-full max-h-[85vh] object-contain transition-transform duration-200"
          style={{ transform: `scale(${zoom})` }}
          draggable={false}
        />
      </div>
    </div>
  );
};

export function extractImagesFromContent(content: string): { textContent: string; images: ImageItem[] } {
  const images: ImageItem[] = [];
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  let textContent = content;

  while ((match = imageRegex.exec(content)) !== null) {
    const name = match[1];
    const url = match[2];
    images.push({ url, name });
  }

  textContent = content.replace(imageRegex, '').replace(/\n{3,}/g, '\n\n').trim();

  return { textContent, images };
}
