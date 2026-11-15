import type { Direction } from './protocol';
import type { UI } from './ui';

const jumpKeys = ['Space', 'ArrowUp', 'KeyW'];
const gameKeys = ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyE', ...jumpKeys];

export class Controls {
  private keys = new Set<string>();

  constructor(private ui: UI) {}

  attach(stop: () => void, resetClock: () => void): () => void {
    const keydown = (event: KeyboardEvent) => {
      if (this.ui.blocked) return;
      if (gameKeys.includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (jumpKeys.includes(event.code) && !event.repeat) this.ui.jumpRequested = true;
      if (event.code === 'KeyE' && !event.repeat) this.ui.interact();
    };
    const keyup = (event: KeyboardEvent) => this.keys.delete(event.code);
    const visibilitychange = () => {
      if (document.hidden) stop();
      resetClock();
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', visibilitychange);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', visibilitychange);
    };
  }

  direction(): Direction {
    if (this.ui.blocked || document.hidden) return 0;
    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA') || this.ui.direction === -1;
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD') || this.ui.direction === 1;
    return left === right ? 0 : left ? -1 : 1;
  }

  jump(): boolean {
    const jump = this.ui.jumpRequested || this.ui.jumpHeld
      || jumpKeys.some(key => this.keys.has(key));
    this.ui.jumpRequested = false;
    return !this.ui.blocked && jump;
  }

  release(): void {
    this.keys.clear();
    this.ui.releaseControls();
  }
}
