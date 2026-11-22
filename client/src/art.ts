import type { Stamp } from './protocol';
import postcardBack from '../../assets/ui/postcard1.png';
import postcardFront from '../../assets/ui/postcard2.png';
import stamp1 from '../../assets/ui/stamp1.png';
import stamp2 from '../../assets/ui/stamp2.png';
import stamp3 from '../../assets/ui/stamp3.png';
import handGrab from '../../assets/ui/hand_grab.png';
import handHover from '../../assets/ui/hand_hover.png';
import handPointer from '../../assets/ui/hand_pointer.png';
import sky from '../../assets/background/bg_Autumn/Layers/Sky.png';
// Upscaled by scripts/upscale_clouds.py, so the clouds can move by fractions of a pixel.
import clouds from '../../assets/background/bg_Autumn/Layers/Clouds_3x.png';
import bushes from '../../assets/background/bg_Autumn/Layers/Bushes.png';
import trees from '../../assets/background/bg_Autumn/Layers/Trees.png';
import ground from '../../assets/background/bg_Autumn/Layers/Ground.png';
import font from '../../assets/font.ttf';
import favicon from '../../assets/favicon.png';

// Every asset the game uses is imported, never fetched by a fixed path: the build
// then holds only what is used, gives each file a content-hashed name that can be
// cached for good, and inlines files under 4 KB (most of the interface art), so
// they need no request at all. style.css imports the rest of the interface art.
export const postcardArt = { back: postcardBack, front: postcardFront };
export const stampArt: Record<Stamp, string> = { 1: stamp1, 2: stamp2, 3: stamp3 };
export const cursorArt = { pointer: handPointer, hover: handHover, grab: handGrab };
export const backgroundArt = { Sky: sky, Clouds: clouds, Bushes: bushes, Trees: trees, Ground: ground };
export const fontUrl = font;
export const faviconUrl = favicon;

const decoded: HTMLImageElement[] = [];

/**
 * Decode the interface art before the game starts, so an <img> showing it never
 * paints a blank frame first. The images are kept so the browser keeps them decoded.
 */
export async function preloadArt(): Promise<void> {
  const urls = [...Object.values(postcardArt), ...Object.values(stampArt), ...Object.values(cursorArt)];
  await Promise.all(urls.map(async url => {
    const image = new Image();
    image.src = url;
    decoded.push(image);
    // A failed decode only costs that image's fade-in; it must not stop the game.
    await image.decode().catch(() => {});
  }));
}
