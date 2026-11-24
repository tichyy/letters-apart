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
 * Camera zoom for a full-resolution canvas, in device pixels per world unit. A world
 * unit is a fixed size in CSS pixels: 1 on touch screens, which are held close, and
 * 1.5 elsewhere. Browser zoom changes the size of a CSS pixel, so it zooms the world
 * along with the interface, and display scaling keeps art the same physical size.
 * Always a whole number: artwork is drawn at 2x, 3x and 6x, and a fractional zoom
 * makes art pixels uneven (at 1.5x the 3x layers came out 4 and 5 screen pixels
 * wide, and shimmered).
 */
export function canvasZoomFor(pixelRatio: number, touch: boolean): number {
  return Math.max(1, Math.round((touch ? 1 : 1.5) * pixelRatio));
}

/**
 * Size of one pixel of the interface font, in CSS pixels: 2 on touch screens and
 * about 2.4 elsewhere (40px text on a 2x laptop), rounded to whole device pixels so
 * the letters stay sharp. Like the world, it follows browser zoom.
 */
export function fontPixelFor(pixelRatio: number, touch: boolean): number {
  return Math.max(1, Math.round((touch ? 2 : 2.4) * pixelRatio)) / pixelRatio;
}

export class Viewport {
  constructor(private scene: Phaser.Scene, private resize: (layout: ViewLayout) => void) {}

  attach(): () => void {
    const parent = this.scene.game.canvas.parentElement!;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let frame = 0;
    let density: MediaQueryList | undefined;
    const coarse = matchMedia('(pointer: coarse)');
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

      // The interface is laid out for 2px font pixels and scaled from there.
      const fontPixel = fontPixelFor(window.devicePixelRatio || 1, coarse.matches);
      style.setProperty('--font-pixel', `${fontPixel}px`);
      style.setProperty('--ui-scale', String(fontPixel / 2));

      const bounds = parent.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const pixelRatio = window.devicePixelRatio || 1;
      if (pixelRatio !== lastPixelRatio) {
        density?.removeEventListener('change', schedule);
        density = matchMedia(`(resolution: ${pixelRatio}dppx)`);
        density.addEventListener('change', schedule);
        lastPixelRatio = pixelRatio;
      }
      const { width, height } = canvasSize(bounds.width, bounds.height, pixelRatio);
      const cameraZoom = canvasZoomFor(pixelRatio, coarse.matches);
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
    coarse.addEventListener('change', schedule, options);
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
