import type Phaser from 'phaser';

const artworkScale = 3;

interface LayerOptions {
  texture: string;
  frame?: string;
  y: number;
  depth: number;
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
  private tileWidth: number;
  private tileHeight: number;
  private columns = 0;
  private left = 0;
  private offset = 0;

  constructor(private scene: Phaser.Scene, private options: LayerOptions) {
    const frame = scene.textures.get(options.texture).get(options.frame ?? '__BASE');
    this.tileWidth = frame.width * artworkScale;
    this.tileHeight = frame.height * artworkScale;
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
        .setOrigin(0).setScale(artworkScale).setDepth(depth));
    }
    for (let i = 0; i < count; i++) {
      const image = this.images[i];
      const row = Math.floor(i / this.columns);
      const visibleHeight = Math.min(this.tileHeight, height - row * this.tileHeight);
      if (visibleHeight < this.tileHeight) {
        image.setCrop(0, 0, image.width, visibleHeight / artworkScale);
      } else {
        image.setCrop();
      }
    }
    this.scroll(this.left, this.offset);
  }

  scroll(left: number, offset: number): void {
    this.left = left;
    this.offset = offset;
    const phase = ((offset % this.tileWidth) + this.tileWidth) % this.tileWidth;
    for (let i = 0; i < this.images.length; i++) {
      const column = i % this.columns;
      const row = Math.floor(i / this.columns);
      this.images[i].setPosition(left - phase + column * this.tileWidth, this.options.y + row * this.tileHeight);
    }
  }
}
