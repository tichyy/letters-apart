import Phaser from 'phaser';
import world from '../../world.json';
import { Connection } from './connection';
import type { Direction, Input, Message, Motion, Player, Side } from './protocol';
import { UI } from './ui';

const sides: Side[] = ['left', 'right'];
const stepTime = 1000 / world.tickRate;
const groundY = 12;

function move(state: Motion, input: Input): Motion {
  let { vy, jumpChain, landingTicks } = state;
  if (state.y === 0) {
    if (!input.jump) jumpChain = 0;
    landingTicks = Math.max(0, landingTicks - 1);
    if (input.jump && landingTicks === 0) {
      vy = -world.jumpSpeed;
      jumpChain = Math.min(jumpChain + 1, world.maxJumpChain);
    }
  }
  vy += world.gravity / world.tickRate;
  const y = Math.min(0, state.y + vy / world.tickRate);
  if (state.y < 0 && y === 0) landingTicks = world.landingTicks;
  const speed = world.speed * (1 + Math.max(0, jumpChain - 1) * world.jumpBoost);
  return {
    x: Phaser.Math.Clamp(state.x + input.direction * speed / world.tickRate, world.minX, world.maxX),
    y, vy: y === 0 ? 0 : vy, jumpChain, landingTicks,
  };
}

export class WorldScene extends Phaser.Scene {
  private sprites = new Map<Side, Phaser.GameObjects.Sprite>();
  private mailboxes = new Map<Side, Phaser.GameObjects.Sprite>();
  private mailFlags = new Map<Side, Phaser.GameObjects.Text>();
  private players: Player[] = [];
  private remote: { time: number; player: Player }[] = [];
  private pending: Input[] = [];
  private outgoing: Input[] = [];
  private seq = 0;
  private interaction: number | null = null;
  private local: Motion = { x: 0, y: 0, vy: 0, jumpChain: 0, landingTicks: 0 };
  private accumulator = 0;
  private keys = new Set<string>();
  private background!: Phaser.GameObjects.Image;
  private soil!: Phaser.GameObjects.TileSprite;
  private scenery: { sprite: Phaser.GameObjects.TileSprite; speed: number }[] = [];
  private active = false;

  constructor(private connection: Connection, private ui: UI) {
    super('world');
  }

  preload(): void {
    for (const layer of ['Sky', 'Clouds', 'Bushes', 'Trees', 'Ground']) {
      this.load.image(layer, `/background/bg_Autumn/Layers/${layer}.png`);
    }
    for (const side of sides) {
      this.load.image(`house-${side}`, `/buildings/house${side === 'left' ? 'A' : 'B'}.png`);
      for (const backpack of [false, true]) {
        const folder = `${side === 'left' ? 'A' : 'B'}${backpack ? 'withBackpack' : ''}`;
        const prefix = `${side}-${backpack}`;
        for (let frame = 1; frame <= 19; frame++) {
          const action = frame <= 3 ? 'idle' : frame <= 11 ? 'run' : frame <= 14 ? 'jump' : frame <= 16 ? 'fall' : 'land';
          this.load.image(`${prefix}-${frame}`, `/player/${folder}/${action}/player${frame}.png`);
        }
      }
    }
    for (let frame = 1; frame <= 6; frame++) {
      this.load.image(`mail-${frame}`, `/mailbox/mailbox-close-anim0${frame}.png`);
    }
    this.load.on('loaderror', () => this.ui.toast('Some artwork could not load. Please refresh.'));
  }

  create(): void {
    this.background = this.add.image(0, 0, 'Sky').setOrigin(0);
    for (const [layer, speed] of [['Clouds', 0.15], ['Bushes', 0.4], ['Trees', 0.7]] as const) {
      const texture = layer === 'Bushes' ? this.mirroredTexture(layer) : layer;
      const sprite = this.add.tileSprite(0, -477, world.viewWidth, 540, texture).setOrigin(0).setTileScale(3);
      this.scenery.push({ sprite, speed });
    }
    // The first background layer is foreground grass, overlapping feet and mailbox posts.
    const ground = this.add.tileSprite(0, -483, world.viewWidth, 540, this.mirroredTexture('Ground'))
      .setOrigin(0).setTileScale(3).setDepth(8);
    this.scenery.push({ sprite: ground, speed: 1 });
    this.textures.get('Ground-repeat').add('soil', 0, 0, 168, 640, 12);
    this.soil = this.add.tileSprite(0, 55, world.width, 1000, 'Ground-repeat', 'soil')
      .setOrigin(0).setTileScale(3).setDepth(8);

    const trees = this.textures.get('Trees');
    trees.add('foreground-small', 0, 61, 95, 75, 69);
    trees.add('foreground-large', 0, 152, 69, 102, 95);
    for (const [x, frame] of [[720, 'foreground-small'], [1680, 'foreground-large'], [2640, 'foreground-small']] as const) {
      this.add.image(x, groundY, 'Trees', frame).setOrigin(0.5, 1).setScale(3).setDepth(6);
    }

    this.anims.create({
      key: 'mail-use', frames: Array.from({ length: 6 }, (_, i) => ({ key: `mail-${i + 1}` })),
      frameRate: 6,
    });
    for (const side of sides) {
      this.add.image(world.desks[side], groundY, `house-${side}`).setOrigin(0.5, 1).setScale(6);
      const mailbox = this.add.sprite(world.mailboxes[side], groundY, 'mail-6')
        .setOrigin(0.5, 42 / 44).setScale(2);
      this.mailboxes.set(side, mailbox);
      this.mailFlags.set(side, this.add.text(world.mailboxes[side], groundY - 86, '✉', {
        fontFamily: 'GameFont, monospace', fontSize: '22px', color: '#fff0ae',
        stroke: '#653d35', strokeThickness: 3,
      }).setOrigin(0.5).setVisible(false));
      const prefix = `${side}-false`;
      const sprite = this.add.sprite(world.desks[side], groundY, `${prefix}-1`)
        .setOrigin(0.5, 47 / 64).setScale(2).setDepth(5).setAlpha(0.35);
      this.sprites.set(side, sprite);
      for (const backpack of [false, true]) {
        for (const [action, start, count] of [
          ['idle', 1, 3], ['run', 4, 8], ['jump', 12, 3], ['fall', 15, 2], ['land', 17, 3],
        ] as const) {
          this.anims.create({
            key: `${side}-${backpack}-${action}`,
            frames: Array.from({ length: count }, (_, i) => ({ key: `${side}-${backpack}-${start + i}` })),
            frameRate: action === 'idle' ? 4 : action === 'land' ? 20 : 12,
            repeat: action === 'land' ? 0 : -1,
          });
        }
      }
      sprite.play(`${prefix}-idle`).setFlipX(side === 'right');
    }

    this.resize();
    this.scale.on('resize', this.resize, this);
    // Observe the container directly: mobile orientation events can precede layout.
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width && height) this.scale.resize(width, height);
    });
    observer.observe(document.querySelector('#game')!);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => observer.disconnect());
    window.addEventListener('keydown', event => {
      if (this.ui.blocked) return;
      if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyE', 'Space', 'ArrowUp', 'KeyW'].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (['Space', 'ArrowUp', 'KeyW'].includes(event.code) && !event.repeat) this.ui.jumpRequested = true;
      if (event.code === 'KeyE' && !event.repeat) this.ui.interact();
    });
    window.addEventListener('keyup', event => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.stop());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      this.accumulator = 0;
    });
    this.active = true;
  }

  private mirroredTexture(key: string): string {
    // Alternating the artwork with its reflection makes the repeat edges meet.
    const source = this.textures.get(key).getSourceImage() as HTMLImageElement;
    const texture = this.textures.createCanvas(`${key}-repeat`, source.width * 2, source.height)!;
    const context = texture.context;
    context.drawImage(source, 0, 0);
    context.translate(source.width * 2, 0);
    context.scale(-1, 1);
    context.drawImage(source, 0, 0);
    texture.refresh();
    return texture.key;
  }

  private resize(): void {
    const { width, height } = this.scale;
    // Keep pixels whole; narrow screens show less of the world.
    const zoom = Math.max(1, Math.floor(height / 540));
    const visibleWidth = width / zoom;
    const visibleHeight = height / zoom;
    const top = -Math.round(height * 0.66) / zoom;
    this.cameras.main.setRoundPixels(false).setZoom(zoom).setScroll(0, top);
    this.cameras.main.scrollY = top + (visibleHeight - height) / 2;
    this.background.setY(top).setDisplaySize(visibleWidth, visibleHeight);
    this.soil.setSize(world.width, Math.max(12, visibleHeight * 0.34));
    // Draw parallax at screen resolution to avoid resampling it twice.
    for (const { sprite } of this.scenery) {
      sprite.setSize(width, Math.ceil(540 * zoom)).setScale(1 / zoom).setTileScale(3 * zoom);
    }
    this.followPlayer();
  }

  private followPlayer(): void {
    const camera = this.cameras.main;
    const visibleWidth = this.scale.width / camera.zoom;
    const halfWidth = Math.min(visibleWidth, world.width) / 2;
    const center = Phaser.Math.Clamp(this.local.x, halfWidth, world.width - halfWidth);
    // Align camera movement to screen pixels.
    camera.scrollX = Math.round((center - this.scale.width / 2) * camera.zoom) / camera.zoom;
    const left = camera.scrollX + (this.scale.width - visibleWidth) / 2;
    this.background.setX(left);
    // Cover only the viewport, scrolling each pattern at its own depth.
    for (const { sprite, speed } of this.scenery) {
      sprite.setX(left);
      sprite.tilePositionX = Math.round(left * speed * camera.zoom) / sprite.tileScaleX;
    }
  }

  receive(message: Message): void {
    if (message.type !== 'welcome' && message.type !== 'state') return;
    this.players = message.players;
    const own = this.players.find(player => player.side === this.connection.side);
    if (!own) return;
    if (message.type === 'welcome') {
      this.seq = own.ack;
      this.interaction = null;
      this.pending = [];
      this.outgoing = [];
      this.local = { ...own };
      this.accumulator = 0;
      this.remote = [];
    } else {
      this.pending = this.pending.filter(input => input.seq > own.ack);
      this.local = this.pending.reduce<Motion>(move, own);
    }
    // Interact only after the server has applied the movement already shown locally.
    if (this.interaction !== null && own.ack >= this.interaction) {
      this.interaction = null;
      this.connection.send({ type: 'interact' });
    }
    const partner = this.players.find(player => player.side !== own.side)!;
    this.remote.push({ time: performance.now(), player: partner });
    if (this.remote.length > 20) this.remote.shift();
    this.ui.setStatus(`${own.side === 'left' ? 'Left' : 'Right'} home · ${
      own.carrying ? 'Postcard in backpack' : own.unread ? 'You have mail' : partner.connected ? 'Together here' : 'Waiting for your other half'
    }`);
  }

  interact(): void {
    if (!this.connection.ready || this.interaction !== null) return;
    const side = this.connection.side!;
    if (![world.desks[side], world.mailboxes.left, world.mailboxes.right].some(x => this.nearby(x))) return;
    this.flush();
    this.interaction = this.seq;
  }

  stop(): void {
    this.interaction = null;
    this.keys.clear();
    this.ui.releaseControls();
    this.flush();
    this.connection.send({ type: 'stop' });
  }

  private flush(): void {
    if (this.outgoing.length && this.connection.send({ type: 'input', inputs: this.outgoing })) {
      this.outgoing = [];
    }
  }

  private direction(): Direction {
    if (this.ui.blocked || document.hidden) return 0;
    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA') || this.ui.direction === -1;
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD') || this.ui.direction === 1;
    return left === right ? 0 : left ? -1 : 1;
  }

  update(_time: number, delta: number): void {
    if (!this.active || !this.connection.ready || !this.players.length) {
      this.ui.setHint('');
      return;
    }
    const direction = this.direction();
    this.accumulator += Math.min(delta, 100);
    while (this.accumulator >= stepTime && this.pending.length < 120) {
      this.accumulator -= stepTime;
      const jump = this.ui.jumpRequested || this.ui.jumpHeld
        || ['Space', 'ArrowUp', 'KeyW'].some(key => this.keys.has(key));
      const input = { seq: ++this.seq, direction, jump: !this.ui.blocked && jump };
      this.ui.jumpRequested = false;
      this.pending.push(input);
      this.outgoing.push(input);
      this.local = move(this.local, input);
      if (this.outgoing.length >= 2) this.flush();
    }

    // Render the partner one snapshot interval behind, blending actual received positions.
    const renderTime = performance.now() - 65;
    while (this.remote.length > 2 && this.remote[1].time <= renderTime) this.remote.shift();
    const zoom = this.cameras.main.zoom;
    for (const player of this.players) {
      const own = player.side === this.connection.side;
      let { x, y, vy, landingTicks } = own ? this.local : player;
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
      this.mailFlags.get(player.side)!.setVisible(player.unread > 0);
    }
    this.followPlayer();
    this.updateHint();
  }

  private nearby(x: number): boolean {
    return Math.hypot(this.local.x - x, this.local.y) <= world.radius;
  }

  private updateHint(): void {
    const side = this.connection.side!;
    const own = this.players.find(player => player.side === side)!;
    const other = side === 'left' ? 'right' : 'left';
    let hint = '';
    if (this.nearby(world.desks[side]) && !own.carrying) hint = 'E · Write a postcard';
    else if (this.nearby(world.mailboxes[side])) hint = own.unread ? 'E · Read your mail' : 'E · Check your mailbox';
    else if (this.nearby(world.mailboxes[other]) && own.carrying) hint = 'E · Deliver your postcard';
    this.ui.setHint(this.ui.blocked ? '' : hint);
  }

  useMailbox(side: Side): void {
    this.mailboxes.get(side)?.play('mail-use', true);
  }
}
