import Phaser from 'phaser';
import world from '../../world.json';
import type { Direction, Motion, Player, Side } from './protocol';
import { createRepeatingLayer, type RepeatingLayer } from './repeating-layer';
import { Viewport, type ViewLayout } from './viewport';
import { DogFollower } from './dog-follower';
import { PartnerPlayback } from './partner-playback';
import { backgroundArt, cursorArt } from './art';
import { snapFollowerX } from './pixel-grid';
// Characters, dog, mailbox and houses in one atlas, packed by scripts/pack_sprites.py.
import spritesImage from '../../assets/sprites/sprites.png';
import spritesData from '../../assets/sprites/sprites.json';

const sides: Side[] = ['left', 'right'];
// Everything stands on top of the solid ground (art row 164), not sunk into it,
// so the grass leaves feet and paws visible.
const groundY = 9;
// The soil below the ground art: one row flipped upside down, one upright, then the
// dark top of the next flipped row, so the view ends on the second dark band.
const soilTop = 55;
const soilBottom = soilTop + 2 * 36 + 12;
// Both two-frame rest animations match the character's 750 ms idle cycle.
const dogRestFrameRate = 8 / 3;

export class WorldView {
  private sprites = new Map<Side, Phaser.GameObjects.Sprite>();
  private mailboxes = new Map<Side, Phaser.GameObjects.Sprite>();
  private dog!: Phaser.GameObjects.Sprite;
  private dogFollower?: DogFollower;
  private dogX?: number;
  private partner = new PartnerPlayback();
  private background!: Phaser.GameObjects.Image;
  private soil!: RepeatingLayer;
  // Speed is the share of camera movement; drift is the layer's own movement, in world units per second.
  private scenery: { layer: RepeatingLayer; speed: number; drift: number }[] = [];
  private cursorLayout = '';

  constructor(private scene: Phaser.Scene) {}

  preload(onLoadError: () => void): void {
    this.scene.load.atlas('sprites', spritesImage, spritesData);
    for (const [name, url] of Object.entries(cursorArt)) {
      this.scene.load.image(`cursor-${name}`, url);
    }
    for (const [layer, url] of Object.entries(backgroundArt)) {
      this.scene.load.image(layer, url);
    }
    this.scene.load.on('loaderror', onLoadError);
  }

  create(playerX: () => number): void {
    this.background = this.scene.add.image(0, 0, 'Sky').setOrigin(0).setDepth(-4);
    for (const [name, speed, drift, depth] of [['Clouds', 0.15, 4, -3], ['Bushes', 0.4, 0, -2], ['Trees', 0.7, 0, -1]] as const) {
      const layer = createRepeatingLayer(this.scene, { texture: name, y: -477, depth, mirror: name === 'Bushes' });
      this.scenery.push({ layer, speed, drift });
    }
    // The first background layer is foreground grass, overlapping feet and mailbox posts.
    // Mirror by flipping tiles, not by drawing a mirrored copy into a canvas: phones
    // can discard canvas memory while the page is in the background (e.g. the camera
    // is open), and the ground would come back blank. Image textures always reload.
    const ground = createRepeatingLayer(this.scene, { texture: 'Ground', y: -483, depth: 8, mirror: true });
    this.scenery.push({ layer: ground, speed: 1, drift: 0 });
    this.scene.textures.get('Ground').add('soil', 0, 0, 168, this.scene.textures.get('Ground').source[0].width, 12);
    this.soil = createRepeatingLayer(this.scene, { texture: 'Ground', frame: 'soil', y: soilTop, depth: 9, mirror: true, mirrorRows: true, staggerRows: true,
    });

    const trees = this.scene.textures.get('Trees');
    trees.add('foreground-small', 0, 61, 95, 75, 69);
    trees.add('foreground-large', 0, 152, 69, 102, 95);
    for (const [x, frame] of [[720, 'foreground-small'], [1680, 'foreground-large'], [2640, 'foreground-small']] as const) {
      this.scene.add.image(x, groundY, 'Trees', frame).setOrigin(0.5, 1).setScale(3).setDepth(6);
    }

    this.scene.anims.create({
      key: 'mail-use', frames: Array.from({ length: 6 }, (_, i) => ({ key: 'sprites', frame: `mail-${i + 1}` })),
      frameRate: 6,
    });
    for (const side of sides) {
      this.scene.add.image(world.desks[side], groundY, 'sprites', `house-${side}`).setOrigin(0.5, 1).setScale(6);
      const mailbox = this.scene.add.sprite(world.mailboxes[side], groundY, 'sprites', 'mail-6')
        .setOrigin(0.5, 42 / 44).setScale(2);
      this.mailboxes.set(side, mailbox);
      const prefix = `${side}-false`;
      const sprite = this.scene.add.sprite(world.desks[side], groundY, 'sprites', `${prefix}-1`)
        .setOrigin(0.5, 47 / 64).setScale(2).setDepth(5).setAlpha(0.35);
      this.sprites.set(side, sprite);
      for (const backpack of [false, true]) {
        for (const [action, start, count] of [
          ['idle', 1, 3], ['run', 4, 8], ['jump', 12, 3], ['fall', 15, 2], ['land', 17, 3],
        ] as const) {
          this.scene.anims.create({
            key: `${side}-${backpack}-${action}`,
            frames: Array.from({ length: count }, (_, i) => ({ key: 'sprites', frame: `${side}-${backpack}-${start + i}` })),
            frameRate: action === 'idle' ? 4 : action === 'land' ? 20 : 12,
            repeat: action === 'land' ? 0 : -1,
          });
        }
      }
      sprite.play(`${prefix}-idle`).setFlipX(side === 'right');
    }

    for (const [action, count, frameRate] of [['idle', 2, dogRestFrameRate], ['run', 4, 12], ['sit', 2, dogRestFrameRate]] as const) {
      this.scene.anims.create({
        key: `dog-${action}`, frames: Array.from({ length: count }, (_, i) => ({ key: 'sprites', frame: `dog-${action}-${i + 1}` })),
        frameRate, repeat: -1,
      });
    }
    this.dog = this.scene.add.sprite(world.desks.left - 52, groundY, 'sprites', 'dog-idle-1')
      .setOrigin(0.5, 1).setScale(2).setDepth(5).setAlpha(0.35).play('dog-idle');

    const viewport = new Viewport(this.scene, layout => this.resize(layout, playerX()));
    this.scene.events.once(Phaser.Scenes.Events.SHUTDOWN, viewport.attach());
  }

  private resize({ width, height, cameraZoom }: ViewLayout, playerX: number): void {
    this.resizeCursors(2 * cameraZoom);
    const camera = this.scene.cameras.main.setOrigin(0, 0).setRoundPixels(false).setZoom(cameraZoom);
    const visibleWidth = width / camera.zoom;
    const visibleHeight = height / camera.zoom;
    // Keep the ground two thirds down, but lower it on tall screens so the view
    // never shows soil past soilBottom.
    const top = -Math.max(Math.round(height * 0.66), Math.ceil(height - soilBottom * camera.zoom)) / camera.zoom;
    camera.setScroll(0, top);
    // Cover the view using uniform, whole-pixel scaling instead of stretching
    // the sky differently on each axis in portrait and landscape.
    const skyScale = Math.max(3, Math.ceil(visibleWidth / this.background.width), Math.ceil(visibleHeight / this.background.height));
    this.background.setY(top).setScale(skyScale);
    this.soil.resize(visibleWidth, soilBottom - soilTop);
    for (const { layer } of this.scenery) {
      layer.resize(visibleWidth, 540);
    }
    this.followPlayer(playerX);
  }

  // Scale is in device pixels per cursor art pixel, like the full-resolution canvas.
  private resizeCursors(pixelScale: number): void {
    const density = window.devicePixelRatio || 1;
    const layout = `${pixelScale}:${density}`;
    if (layout === this.cursorLayout) return;
    this.cursorLayout = layout;
    // Match the world's physical pixel grid and prevent native cursor resampling.
    const logicalScale = pixelScale / density;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    for (const [name, fallback] of [['pointer', 'default'], ['hover', 'pointer'], ['grab', 'grabbing']]) {
      const source = this.scene.textures.get(`cursor-${name}`).getSourceImage() as HTMLImageElement;
      canvas.width = source.width * pixelScale;
      canvas.height = source.height * pixelScale;
      context.imageSmoothingEnabled = false;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      document.documentElement.style.setProperty(`--cursor-${name}`,
        `image-set(url("${canvas.toDataURL()}") ${density}x) ${5 * logicalScale} ${2 * logicalScale}, ${fallback}`);
    }
  }

  followPlayer(playerX: number): void {
    const camera = this.scene.cameras.main;
    const visibleWidth = this.scene.scale.width / camera.zoom;
    const halfWidth = Math.min(visibleWidth, world.width) / 2;
    const center = Phaser.Math.Clamp(playerX, halfWidth, world.width - halfWidth);
    // Align camera movement to screen pixels.
    const left = Math.round((center - visibleWidth / 2) * camera.zoom) / camera.zoom;
    camera.scrollX = left;
    this.background.setX(left);
    // Cover only the viewport, scrolling each pattern at its own depth.
    const seconds = this.scene.time.now / 1000;
    for (const { layer, speed, drift } of this.scenery) {
      const offset = Math.round((left * speed + seconds * drift) * camera.zoom) / camera.zoom;
      layer.scroll(left, offset);
    }
    this.soil.scroll(left, left);
  }

  noticeAnchor(position: { x: number; y: number }): { x: number; y: number } {
    const camera = this.scene.cameras.main;
    const canvas = this.scene.game.canvas.getBoundingClientRect();
    // Above the interactable object, converted from world units to CSS pixels.
    return {
      x: canvas.left + (position.x - camera.scrollX) * camera.zoom * canvas.width / this.scene.scale.width,
      y: canvas.top + (groundY + position.y - 104 - camera.scrollY) * camera.zoom * canvas.height / this.scene.scale.height,
    };
  }

  recordPartner(player: Player, reset: boolean): void {
    this.partner.push(player, reset);
  }

  renderPlayers(players: Player[], side: Side, local: Motion, direction: Direction, delta: number): void {
    const zoom = this.scene.cameras.main.zoom;
    for (const player of players) {
      const own = player.side === side;
      const { x, y, vy, landingTicks, moving, facing } = own
        ? { ...local, moving: direction !== 0, facing: direction }
        : this.partner.advance(Math.min(delta, 100));
      const sprite = this.sprites.get(player.side)!;
      // Snap drawing to the zoomed pixel grid, keeping movement precise.
      sprite.setPosition(Math.round(x * zoom) / zoom, Math.round((groundY + y) * zoom) / zoom)
        .setAlpha(player.connected ? 1 : 0.35);
      if (facing) sprite.setFlipX(facing === -1);
      const action = y < 0 ? (vy < 0 ? 'jump' : 'fall') : landingTicks > 0 ? 'land' : moving ? 'run' : 'idle';
      const animation = `${player.side}-${player.carrying}-${action}`;
      if (action !== 'land' || sprite.anims.currentAnim?.key !== animation) sprite.play(animation, true);
      // Use the physics clock so a repeated jump doesn't cut the landing clip short.
      if (action === 'land') sprite.anims.setProgress(1 - landingTicks / world.landingTicks);
      if (player.side === 'left') this.renderDog({ x, y }, moving ? (sprite.flipX ? -1 : 1) : 0, player.connected, delta);
    }
  }

  private renderDog(owner: Pick<Motion, 'x' | 'y'>, direction: Direction, connected: boolean, delta: number): void {
    this.dogFollower ??= new DogFollower(owner.x, direction, world);
    const { x, y, vy, landingTicks, moving, sitting, flipX } = this.dogFollower.update(owner, direction, connected, delta / 1000);
    let footOffset = 0;
    if (y < 0 || landingTicks > 0) {
      const frame = y < 0
        ? Phaser.Math.Clamp(Math.floor((vy + this.dogFollower.jumpSpeed) / (2 * this.dogFollower.jumpSpeed) * 6) + 1, 1, 6)
        : landingTicks > world.landingTicks / 2 ? 6 : 7;
      this.dog.anims.stop();
      this.dog.setTexture('sprites', `dog-jump-${frame}`);
      // Jump artwork moves inside its canvas; align its feet with the dog's jump arc.
      footOffset = (32 - [32, 32, 26, 16, 21, 32, 32][frame - 1]) * 2;
    } else if (sitting) {
      this.dog.play('dog-sit', true);
    } else {
      this.dog.play(moving ? 'dog-run' : 'dog-idle', true);
    }
    const zoom = this.scene.cameras.main.zoom;
    // Following: use the owner's rendered pixel grid, or a steady gap would alternate
    // by one screen pixel. Still (e.g. sitting): use its own position, or the owner
    // moving around it would shift it by one pixel back and forth.
    const still = x === this.dogX;
    this.dogX = x;
    this.dog.setPosition(snapFollowerX(x, owner.x, zoom, still), Math.round((groundY + y + footOffset) * zoom) / zoom)
      .setFlipX(flipX).setAlpha(connected ? 1 : 0.35);
  }

  useMailbox(side: Side): void {
    this.mailboxes.get(side)?.play('mail-use', true);
  }
}
