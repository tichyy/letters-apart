import Phaser from 'phaser';
import world from '../../world.json';
import type { Connection } from './connection';
import { Controls } from './controls';
import { LocalPrediction } from './local-prediction';
import { WorldView } from './world-view';
import type { Message, Player, Side } from './protocol';
import type { UI } from './ui';

export class WorldScene extends Phaser.Scene {
  private view = new WorldView(this);
  private controls: Controls;
  private prediction: LocalPrediction;
  private players: Player[] = [];
  private active = false;

  constructor(private connection: Connection, private ui: UI) {
    super('world');
    this.controls = new Controls(ui);
    this.prediction = new LocalPrediction(connection);
  }

  preload(): void {
    this.view.preload(() => this.ui.toast('Some artwork could not load. Please refresh.'));
  }

  create(): void {
    this.view.create(() => this.prediction.position.x);
    const detachControls = this.controls.attach(() => this.stop(), () => this.prediction.resetClock());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, detachControls);
    this.active = true;
    this.ui.revealWorld();
  }

  receive(message: Message): void {
    if (message.type !== 'welcome' && message.type !== 'state') return;
    this.players = message.players;
    const own = this.players.find(player => player.side === this.connection.side);
    if (!own) return;
    const fresh = message.type === 'welcome';
    this.prediction.reconcile(own, fresh);
    const partner = this.players.find(player => player.side !== own.side)!;
    this.view.recordPartner(partner, fresh);
  }

  interact(type: 'interact' | 'gallery' = 'interact'): void {
    if (!this.connection.ready) return;
    const side = this.connection.side!;
    if (type === 'gallery' && !this.nearby(world.desks[side])) return;
    if (![world.desks[side], world.mailboxes.left, world.mailboxes.right].some(x => this.nearby(x))) return;
    this.prediction.sendAfterInputs(type);
  }

  stop(): void {
    this.controls.release();
    this.prediction.stop();
  }

  update(_time: number, delta: number): void {
    if (!this.active || !this.connection.ready || !this.players.length) {
      // Reconnecting, you can keep typing: keep the bubbles where they were.
      this.ui.chat.render(this.active && this.connection.side ? this.view.bubbleAnchors(this.connection.side) : {});
      this.ui.setHint('');
      this.ui.setGalleryAvailable(false);
      return;
    }
    const frame = this.prediction.advance(delta, this.controls);
    if (frame.stalled) {
      this.connection.connect(this.connection.side!);
      return;
    }
    const { pose } = frame;
    this.view.renderPlayers(this.players, this.connection.side!, pose, this.controls.direction(), delta);
    this.view.followPlayer(pose.x);
    this.ui.chat.render(this.view.bubbleAnchors(this.connection.side!));
    const anchor = this.ui.noticeAnchor;
    if (anchor) {
      const { x, y } = this.view.noticeAnchor(anchor);
      this.ui.positionNotice(x, y);
    }
    this.updateHint();
  }

  private nearby(x: number): boolean {
    const { position } = this.prediction;
    return Math.hypot(position.x - x, position.y) <= world.radius;
  }

  private updateHint(): void {
    const side = this.connection.side!;
    const own = this.players.find(player => player.side === side)!;
    const other = side === 'left' ? 'right' : 'left';
    let hint = '';
    if (this.nearby(world.desks[side]) && !own.carrying) hint = 'E · Write a postcard';
    else if (this.nearby(world.mailboxes[side])) hint = own.unread ? 'E · Read your mail' : 'E · Check your mailbox';
    else if (this.nearby(world.mailboxes[other]) && own.carrying) hint = 'E · Deliver your postcard';
    this.ui.setHint(this.ui.captured ? '' : hint);
    this.ui.setGalleryAvailable(!this.ui.captured && this.nearby(world.desks[side]));
    this.ui.setDropAvailable(!this.ui.captured && own.carrying);
  }

  useMailbox(side: Side): void {
    this.view.useMailbox(side);
  }
}
