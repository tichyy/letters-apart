import type Phaser from 'phaser';

export interface ViewLayout {
  width: number;
  height: number;
  cameraZoom: number;
}

/**
 * The game canvas for a container of this CSS size: each canvas pixel covers a
 * whole number of device pixels, so the canvas can be smaller than the CSS size.
 */
export function canvasSize(cssWidth: number, cssHeight: number, pixelRatio: number): { width: number; height: number } {
  const pixelScale = Math.max(1, Math.round(pixelRatio));
  return {
    width: Math.ceil(cssWidth * pixelRatio / pixelScale),
    height: Math.ceil(cssHeight * pixelRatio / pixelScale),
  };
}

/**
 * World zoom for a canvas of this size, in canvas pixels (see canvasSize): world
 * units visible = canvas pixels / zoom, whatever the display scaling. Always a whole number:
 * artwork is drawn at 2x, 3x and 6x, and a fractional zoom makes art pixels uneven
 * (at 1.5x the 3x layers came out 4 and 5 screen pixels wide, and shimmered).
 * Phones keep 1x; larger screens take the largest zoom that still shows 400 world
 * units of height.
 */
export function cameraZoomFor(width: number, height: number): number {
  if (width <= 600) return 1;
  return Math.max(1, Math.floor(height / 400));
}

export class Viewport {
  constructor(private scene: Phaser.Scene, private resize: (layout: ViewLayout) => void) {}

  attach(): () => void {
    const parent = this.scene.game.canvas.parentElement!;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let frame = 0;
    let density: MediaQueryList | undefined;
    let lastPixelRatio = 0;
    let lastLayout = '';

    const update = () => {
      frame = 0;
      // Keep the world tied to its container. Keyboard and browser chrome changes
      // move the HTML interface within the visual viewport without stretching it.
      const visual = window.visualViewport;
      const style = document.documentElement.style;
      style.setProperty('--viewport-width', `${visual?.width ?? window.innerWidth}px`);
      style.setProperty('--viewport-height', `${visual?.height ?? window.innerHeight}px`);
      style.setProperty('--viewport-left', `${visual?.offsetLeft ?? 0}px`);
      style.setProperty('--viewport-top', `${visual?.offsetTop ?? 0}px`);

      const bounds = parent.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const pixelRatio = window.devicePixelRatio || 1;
      if (pixelRatio !== lastPixelRatio) {
        density?.removeEventListener('change', schedule);
        density = matchMedia(`(resolution: ${pixelRatio}dppx)`);
        density.addEventListener('change', schedule);
        lastPixelRatio = pixelRatio;
      }
      // Each canvas pixel occupies a whole number of device pixels. Compact
      // screens show more of the world so the house does not fill the viewport.
      const pixelScale = Math.max(1, Math.round(pixelRatio));
      const { width, height } = canvasSize(bounds.width, bounds.height, pixelRatio);
      const cameraZoom = cameraZoomFor(width, height);
      const layout = `${width}:${height}:${pixelRatio}:${cameraZoom}`;
      if (layout === lastLayout) return;
      lastLayout = layout;

      // Apply CSS sizing after resizing the backing canvas: Phaser's NONE mode
      // otherwise retains the previous CSS dimensions when the zoom equals one.
      this.scene.scale.resize(width, height).setZoom(pixelScale / pixelRatio);
      this.resize({ width, height, cameraZoom });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(parent);
    window.addEventListener('resize', schedule, options);
    window.visualViewport?.addEventListener('resize', schedule, options);
    window.visualViewport?.addEventListener('scroll', schedule, options);
    update();
    return () => {
      controller.abort();
      observer.disconnect();
      density?.removeEventListener('change', schedule);
      cancelAnimationFrame(frame);
    };
  }
}
