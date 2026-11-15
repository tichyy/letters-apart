import Phaser from 'phaser';
import world from '../../world.json';
import type { Direction, Motion, Player, Side } from './protocol';
import { createRepeatingLayer, type RepeatingLayer } from './repeating-layer';
import { Viewport, type ViewLayout } from './viewport';

const sides: Side[] = ['left', 'right'];
const groundY = 12;

export class WorldView {
  private sprites = new Map<Side, Phaser.GameObjects.Sprite>();
  private mailboxes = new Map<Side, Phaser.GameObjects.Sprite>();
  private remote: { time: number; player: Player }[] = [];
  private background!: Phaser.GameObjects.Image;
  private soil!: RepeatingLayer;
  private scenery: { layer: RepeatingLayer; speed: number }[] = [];

  constructor(private scene: Phaser.Scene) {}

  preload(onLoadError: () => void): void {
    for (const layer of ['Sky', 'Clouds', 'Bushes', 'Trees', 'Ground']) {
      this.scene.load.image(layer, `/background/bg_Autumn/Layers/${layer}.png`);
    }
    for (const side of sides) {
      this.scene.load.image(`house-${side}`, `/buildings/house${side === 'left' ? 'A' : 'B'}.png`);
      for (const backpack of [false, true]) {
        const folder = `${side === 'left' ? 'A' : 'B'}${backpack ? 'withBackpack' : ''}`;
        const prefix = `${side}-${backpack}`;
        for (let frame = 1; frame <= 19; frame++) {
          const action = frame <= 3 ? 'idle' : frame <= 11 ? 'run' : frame <= 14 ? 'jump' : frame <= 16 ? 'fall' : 'land';
          this.scene.load.image(`${prefix}-${frame}`, `/player/${folder}/${action}/player${frame}.png`);
        }
      }
    }
    for (let frame = 1; frame <= 6; frame++) {
      this.scene.load.image(`mail-${frame}`, `/mailbox/mailbox-close-anim0${frame}.png`);
    }
    this.scene.load.on('loaderror', onLoadError);
  }

  create(playerX: () => number): void {
    this.background = this.scene.add.image(0, 0, 'Sky').setOrigin(0).setDepth(-4);
    for (const [name, speed, depth] of [['Clouds', 0.15, -3], ['Bushes', 0.4, -2], ['Trees', 0.7, -1]] as const) {
      const texture = name === 'Bushes' ? this.mirroredTexture(name) : name;
      const layer = createRepeatingLayer(this.scene, { texture, y: -477, depth });
      this.scenery.push({ layer, speed });
    }
    // The first background layer is foreground grass, overlapping feet and mailbox posts.
    const ground = createRepeatingLayer(this.scene, { texture: this.mirroredTexture('Ground'), y: -483, depth: 8 });
    this.scenery.push({ layer: ground, speed: 1 });
    this.scene.textures.get('Ground-repeat').add('soil', 0, 0, 168, 640, 12);
    this.soil = createRepeatingLayer(this.scene, { texture: 'Ground-repeat', frame: 'soil', y: 55, depth: 9 });

    const trees = this.scene.textures.get('Trees');
    trees.add('foreground-small', 0, 61, 95, 75, 69);
    trees.add('foreground-large', 0, 152, 69, 102, 95);
    for (const [x, frame] of [[720, 'foreground-small'], [1680, 'foreground-large'], [2640, 'foreground-small']] as const) {
      this.scene.add.image(x, groundY, 'Trees', frame).setOrigin(0.5, 1).setScale(3).setDepth(6);
    }

    this.scene.anims.create({
      key: 'mail-use', frames: Array.from({ length: 6 }, (_, i) => ({ key: `mail-${i + 1}` })),
      frameRate: 6,
    });
    for (const side of sides) {
      this.scene.add.image(world.desks[side], groundY, `house-${side}`).setOrigin(0.5, 1).setScale(6);
      const mailbox = this.scene.add.sprite(world.mailboxes[side], groundY, 'mail-6')
        .setOrigin(0.5, 42 / 44).setScale(2);
      this.mailboxes.set(side, mailbox);
      const prefix = `${side}-false`;
      const sprite = this.scene.add.sprite(world.desks[side], groundY, `${prefix}-1`)
        .setOrigin(0.5, 47 / 64).setScale(2).setDepth(5).setAlpha(0.35);
      this.sprites.set(side, sprite);
      for (const backpack of [false, true]) {
        for (const [action, start, count] of [
          ['idle', 1, 3], ['run', 4, 8], ['jump', 12, 3], ['fall', 15, 2], ['land', 17, 3],
        ] as const) {
          this.scene.anims.create({
            key: `${side}-${backpack}-${action}`,
            frames: Array.from({ length: count }, (_, i) => ({ key: `${side}-${backpack}-${start + i}` })),
            frameRate: action === 'idle' ? 4 : action === 'land' ? 20 : 12,
            repeat: action === 'land' ? 0 : -1,
          });
        }
      }
      sprite.play(`${prefix}-idle`).setFlipX(side === 'right');
    }

    const viewport = new Viewport(this.scene, layout => this.resize(layout, playerX()));
    this.scene.events.once(Phaser.Scenes.Events.SHUTDOWN, viewport.attach());
  }

  private mirroredTexture(key: string): string {
    // Alternating the artwork with its reflection makes the repeat edges meet.
    const source = this.scene.textures.get(key).getSourceImage() as HTMLImageElement;
    const texture = this.scene.textures.createCanvas(`${key}-repeat`, source.width * 2, source.height)!;
    const context = texture.context;
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0);
    context.translate(source.width * 2, 0);
    context.scale(-1, 1);
    context.drawImage(source, 0, 0);
    texture.refresh();
    return texture.key;
  }

  private resize({ width, height, cameraZoom }: ViewLayout, playerX: number): void {
    const camera = this.scene.cameras.main.setOrigin(0, 0).setRoundPixels(false).setZoom(cameraZoom);
    const visibleWidth = width / camera.zoom;
    const visibleHeight = height / camera.zoom;
    const top = -Math.round(height * 0.66) / camera.zoom;
    camera.setScroll(0, top);
    // Cover the view using uniform, whole-pixel scaling instead of stretching
    // the sky differently on each axis in portrait and landscape.
    const skyScale = Math.max(3, Math.ceil(visibleWidth / this.background.width), Math.ceil(visibleHeight / this.background.height));
    this.background.setY(top).setScale(skyScale);
    this.soil.resize(visibleWidth, Math.max(12, visibleHeight * 0.34));
    for (const { layer } of this.scenery) {
      layer.resize(visibleWidth, 540);
    }
    this.followPlayer(playerX);
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
    for (const { layer, speed } of this.scenery) {
      const offset = Math.round(left * speed * camera.zoom) / camera.zoom;
      layer.scroll(left, offset);
    }
    this.soil.scroll(left, left);
  }

  recordPartner(player: Player, reset: boolean): void {
    if (reset) this.remote = [];
    this.remote.push({ time: performance.now(), player });
    if (this.remote.length > 20) this.remote.shift();
  }

  renderPlayers(players: Player[], side: Side, local: Motion, direction: Direction): void {
    // Render the partner one snapshot interval behind, blending actual received positions.
    const renderTime = performance.now() - 65;
    while (this.remote.length > 2 && this.remote[1].time <= renderTime) this.remote.shift();
    const zoom = this.scene.cameras.main.zoom;
    for (const player of players) {
      const own = player.side === side;
      let { x, y, vy, landingTicks } = own ? local : player;
      let moving = own ? direction !== 0 : player.moving;
      let facing = own ? direction : player.facing;
      if (!own && this.remote.length >= 2) {
        const [a, b] = this.remote;
        const fraction = Phaser.Math.Clamp((renderTime - a.time) / Math.max(1, b.time - a.time), 0, 1);
        x = Phaser.Math.Linear(a.player.x, b.player.x, fraction);
        y = Phaser.Math.Linear(a.player.y, b.player.y, fraction);
        vy = Phaser.Math.Linear(a.player.vy, b.player.vy, fraction);
        landingTicks = Phaser.Math.Linear(a.player.landingTicks, b.player.landingTicks, fraction);
        moving = b.player.moving;
        facing = b.player.facing;
      }
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
    }
  }

  useMailbox(side: Side): void {
    this.mailboxes.get(side)?.play('mail-use', true);
  }
}
