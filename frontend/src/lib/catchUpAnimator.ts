export default class CatchUpAnimator {
  private onUpdate: (content: string) => void;
  private _isRunning = false;
  private targetContent = '';
  private currentLength = 0;
  private animStartLength = 0;
  private animStartTime = 0;
  private animDuration = 0;
  private rafId = 0;

  constructor(onUpdate: (displayedContent: string) => void) {
    this.onUpdate = onUpdate;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  start(targetContent: string, currentDisplayed: string): void {
    this.cancelRaf();

    this.targetContent = targetContent;
    this.currentLength = currentDisplayed.length;

    const delta = targetContent.length - currentDisplayed.length;

    if (delta <= 0) {
      this.onUpdate(targetContent);
      this._isRunning = false;
      return;
    }

    if (delta < 50) {
      this.onUpdate(targetContent);
      this._isRunning = false;
      return;
    }

    this._isRunning = true;
    this.animStartLength = this.currentLength;
    this.animStartTime = performance.now();
    this.animDuration = Math.min(3000, delta * 2);
    this.rafId = requestAnimationFrame(this.tick);
  }

  appendContent(newContent: string): void {
    if (!this._isRunning) return;

    this.targetContent += newContent;

    const remaining = this.targetContent.length - this.currentLength;
    if (remaining <= 0) return;

    this.animStartLength = this.currentLength;
    this.animStartTime = performance.now();
    this.animDuration = Math.min(3000, remaining * 2);
  }

  stop(): void {
    if (!this._isRunning) return;
    this.cancelRaf();
    this.onUpdate(this.targetContent);
    this._isRunning = false;
  }

  private tick = (): void => {
    const elapsed = performance.now() - this.animStartTime;
    const progress = Math.min(1, elapsed / this.animDuration);

    const newLength =
      this.animStartLength +
      Math.floor((this.targetContent.length - this.animStartLength) * progress);

    this.currentLength = newLength;
    this.onUpdate(this.targetContent.substring(0, newLength));

    if (progress >= 1) {
      this.onUpdate(this.targetContent);
      this._isRunning = false;
      return;
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  private cancelRaf(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }
}
