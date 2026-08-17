import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download } from 'lucide-react';
import { appendUploadToken } from '@/lib/uploadUrls';

interface ImageLightboxProps {
  images: string[];
  currentIndex: number;
  isOpen: boolean;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
}

export function ImageLightbox({
  images,
  currentIndex,
  isOpen,
  onClose,
  onIndexChange
}: ImageLightboxProps) {
  const [activeIndex, setActiveIndex] = useState(currentIndex);
  const [isZoomed, setIsZoomed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const maxIndex = Math.max(images.length - 1, 0);
    setActiveIndex(Math.min(Math.max(currentIndex, 0), maxIndex));
    setImageLoaded(false);
    setIsZoomed(false);
  }, [currentIndex, images.length, isOpen]);

  const navigateNext = useCallback(() => {
    if (images.length === 0) return;
    const nextIndex = (activeIndex + 1) % images.length;
    setActiveIndex(nextIndex);
    setImageLoaded(false);
    setIsZoomed(false);
    onIndexChange?.(nextIndex);
  }, [activeIndex, images.length, onIndexChange]);

  const navigatePrev = useCallback(() => {
    if (images.length === 0) return;
    const prevIndex = (activeIndex - 1 + images.length) % images.length;
    setActiveIndex(prevIndex);
    setImageLoaded(false);
    setIsZoomed(false);
    onIndexChange?.(prevIndex);
  }, [activeIndex, images.length, onIndexChange]);

  const toggleZoom = useCallback(() => {
    setIsZoomed(prev => !prev);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          navigatePrev();
          break;
        case 'ArrowRight':
          navigateNext();
          break;
        case ' ':
          e.preventDefault();
          toggleZoom();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, navigateNext, navigatePrev, onClose, toggleZoom]);

  useEffect(() => {
    if (isOpen) return;
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    setDownloading(false);
  }, [isOpen]);

  useEffect(() => {
    return () => {
      downloadAbortRef.current?.abort();
    };
  }, []);

  const handleDownload = useCallback(async () => {
    if (downloading || images.length === 0 || activeIndex >= images.length) return;

    downloadAbortRef.current?.abort();
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    let objectUrl: string | null = null;
    setDownloading(true);
    try {
      const response = await fetch(appendUploadToken(images[activeIndex]), {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Download failed (${response.status})`);
      }
      const blob = await response.blob();
      objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `image-${activeIndex + 1}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Failed to download image:', error);
      }
    } finally {
      if (objectUrl) {
        const urlToRevoke = objectUrl;
        window.setTimeout(() => window.URL.revokeObjectURL(urlToRevoke), 0);
      }
      if (downloadAbortRef.current === controller) {
        downloadAbortRef.current = null;
      }
      setDownloading(false);
    }
  }, [activeIndex, downloading, images]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    setTouchStart({ x: touch.clientX, y: touch.clientY });
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStart) return;

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = Math.abs(touch.clientY - touchStart.y);

    if (Math.abs(deltaX) > 50 && deltaY < 50) {
      if (deltaX > 0) {
        navigatePrev();
      } else {
        navigateNext();
      }
    }

    setTouchStart(null);
  }, [touchStart, navigatePrev, navigateNext]);

  if (!isOpen || images.length === 0) return null;

  const currentImage = images[activeIndex];

  return (
    <div
      className="lightbox-overlay"
      ref={containerRef}
      onClick={(e) => {
        if (e.target === containerRef.current) {
          onClose();
        }
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="lightbox-content">
        <button
          className="lightbox-close"
          onClick={onClose}
          title="Close (ESC)"
          aria-label="Close lightbox"
        >
          <X size={24} />
        </button>

        {images.length > 1 && (
          <>
            <button
              className="lightbox-nav prev"
              onClick={navigatePrev}
              title="Previous image (←)"
              aria-label="Previous image"
            >
              <ChevronLeft size={24} />
            </button>

            <button
              className="lightbox-nav next"
              onClick={navigateNext}
              title="Next image (→)"
              aria-label="Next image"
            >
              <ChevronRight size={24} />
            </button>
          </>
        )}

        <div className="lightbox-toolbar">
          <button
            onClick={toggleZoom}
            title={isZoomed ? 'Zoom out (Space)' : 'Zoom in (Space)'}
            aria-label={isZoomed ? 'Zoom out' : 'Zoom in'}
          >
            {isZoomed ? <ZoomOut size={20} /> : <ZoomIn size={20} />}
          </button>
          <button
            onClick={handleDownload}
            title="Download image"
            aria-label="Download image"
            disabled={downloading}
          >
            <Download size={20} />
          </button>
        </div>

        <img
          src={appendUploadToken(currentImage)}
          alt={`Image ${activeIndex + 1} of ${images.length}`}
          className={`lightbox-image ${isZoomed ? 'zoomed' : ''}`}
          onClick={toggleZoom}
          onLoad={() => setImageLoaded(true)}
          draggable={false}
          style={{ opacity: imageLoaded ? 1 : 0.5 }}
        />

        {images.length > 1 && (
          <div className="lightbox-counter">
            {activeIndex + 1} / {images.length}
          </div>
        )}
      </div>
    </div>
  );
};
