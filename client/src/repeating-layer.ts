import type Phaser from 'phaser';

const artworkScale = 3;

interface LayerOptions {
  texture: string;
  frame?: string;
  y: number;
  depth: number;
  // How much larger to draw the artwork; 1 for art that is already upscaled.
  scale?: number;
  // Flip every other tile, so artwork whose edges don't match still repeats seamlessly.
  mirror?: boolean;
  // Flip every other row upside down, so a strip that shades from light to dark
  // meets the next copy at the same shade instead of a hard seam.
  mirrorRows?: boolean;
  // Shift each row sideways by its own fixed amount, so the rows' edges don't line up.
  staggerRows?: boolean;
}

// Fixed, irregular shift for each row, in artwork pixels.
function rowShift(row: number): number {
  return (row * 137 + row * row * 61) % 320;
}

export interface RepeatingLayer {
  resize(width: number, height: number): void;
  scroll(left: number, offset: number): void;
}

export function createRepeatingLayer(scene: Phaser.Scene, options: LayerOptions): RepeatingLayer {
  // Draw directly to the camera canvas to avoid rounding in an intermediate TileSprite canvas.
  return new ImageLayer(scene, options);
}

class ImageLayer implements RepeatingLayer {
  private images: Phaser.GameObjects.Image[] = [];
  private scale: number;
  private tileWidth: number;
  private tileHeight: number;
  private columns = 0;
  private left = 0;
  private offset = 0;

  constructor(private scene: Phaser.Scene, private options: LayerOptions) {
    const frame = scene.textures.get(options.texture).get(options.frame ?? '__BASE');
    this.scale = options.scale ?? artworkScale;
    this.tileWidth = frame.width * this.scale;
    this.tileHeight = frame.height * this.scale;
  }

  resize(width: number, height: number): void {
    // One extra column covers the partially visible tile at the left edge.
    // Images are reused during scrolling and belong to the scene's lifecycle.
    this.columns = Math.ceil(width / this.tileWidth) + 1;
    const rows = Math.ceil(height / this.tileHeight);
    const count = this.columns * rows;
    while (this.images.length > count) this.images.pop()!.destroy();
    while (this.images.length < count) {
      // Adding named frames (foreground trees, soil) changes Phaser's default
      // frame. New background copies must keep using the full artwork.
      const { texture, frame = '__BASE', y, depth } = this.options;
      this.images.push(this.scene.add.image(0, y, texture, frame)
        .setOrigin(0).setScale(this.scale).setDepth(depth));
    }
    for (let i = 0; i < count; i++) {
      const image = this.images[i];
      const row = Math.floor(i / this.columns);
      const visibleHeight = Math.min(this.tileHeight, height - row * this.tileHeight);
      // Phaser keeps a flipped image's crop at the bottom of the tile, leaving a gap
      // at the top, so flipped rows are drawn whole and run past the given height.
      if (visibleHeight < this.tileHeight && !this.flippedRow(row)) {
        image.setCrop(0, 0, image.width, visibleHeight / this.scale);
      } else {
        image.setCrop();
      }
    }
    this.scroll(this.left, this.offset);
  }

  private flippedRow(row: number): boolean {
    return !!this.options.mirrorRows && row % 2 === 0;
  }

  scroll(left: number, offset: number): void {
    this.left = left;
    this.offset = offset;
    for (let i = 0; i < this.images.length; i++) {
      const column = i % this.columns;
      const row = Math.floor(i / this.columns);
      const shifted = offset + (this.options.staggerRows ? rowShift(row) * artworkScale : 0);
      const first = Math.floor(shifted / this.tileWidth);
      const phase = shifted - first * this.tileWidth;
      this.images[i].setPosition(left - phase + column * this.tileWidth, this.options.y + row * this.tileHeight);
      // Parity of the tile's position in the world, so the pattern doesn't change while scrolling.
      if (this.options.mirror) this.images[i].setFlipX(Math.abs(first + column) % 2 === 1);
      if (this.options.mirrorRows) this.images[i].setFlipY(this.flippedRow(row));
    }
  }
}
