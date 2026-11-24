import type Phaser from 'phaser';

export interface ViewLayout {
  width: number;
  height: number;
  cameraZoom: number;
}

/**
 * The game canvas for a container of this CSS size, at the display's full resolution:
 * one canvas pixel per device pixel, so anything moving slower than an art pixel
 * (the clouds most of all) steps by the smallest amount the screen can show.
 */
export function canvasSize(cssWidth: number, cssHeight: number, pixelRatio: number): { width: number; height: number } {
  return { width: Math.ceil(cssWidth * pixelRatio), height: Math.ceil(cssHeight * pixelRatio) };
}

/**
 * Camera zoom for a full-resolution canvas, in device pixels per world unit. Phones
 * draw one CSS pixel per world unit, as round(pixelRatio) device pixels. Larger screens
 * choose from their device pixels alone, so browser zoom and display scaling resize
 * the interface but not the world: rounding a 2x display's zoom to a multiple of 2
 * left a laptop's 1520-pixel-tall window at zoom 2 (760 world units, far away) when
 * zoom 3 (507 units) was just as crisp.
 */
export function canvasZoomFor(width: number, height: number, pixelRatio: number): number {
  const pixelScale = Math.max(1, Math.round(pixelRatio));
  if (Math.ceil(width / pixelScale) <= 600) return pixelScale;
  return cameraZoomFor(width, height);
}

/**
 * World zoom for a view of this size in pixels. Always a whole number: artwork is
 * drawn at 2x, 3x and 6x, and a fractional zoom makes art pixels uneven
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
      // Compact screens show more of the world so the house does not fill the viewport.
      const { width, height } = canvasSize(bounds.width, bounds.height, pixelRatio);
      const cameraZoom = canvasZoomFor(width, height, pixelRatio);
      const layout = `${width}:${height}:${pixelRatio}:${cameraZoom}`;
      if (layout === lastLayout) return;
      lastLayout = layout;

      // Apply CSS sizing after resizing the backing canvas: Phaser's NONE mode
      // otherwise retains the previous CSS dimensions when the zoom equals one.
      this.scene.scale.resize(width, height).setZoom(1 / pixelRatio);
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
