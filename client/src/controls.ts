import { KeyboardControls } from './keyboard-controls';
import { TouchControls } from './touch-controls';
import type { Direction } from './protocol';
import type { UI } from './ui';

export class Controls {
  private keyboard: KeyboardControls;
  private touch: TouchControls;

  constructor(private ui: UI) {
    this.keyboard = new KeyboardControls(() => this.blocked, () => ui.interact(), () => ui.openLibrary(), held => ui.holdDrop(held), () => ui.chat.show());
    this.touch = new TouchControls(ui.gameplay, () => this.blocked);
  }

  // Typing in the chat stops the character, like a dialog.
  private get blocked(): boolean { return this.ui.blocked || this.ui.chat.open || document.hidden; }

  attach(stop: () => void, resetClock: () => void): () => void {
    const detachKeyboard = this.keyboard.attach();
    const detachTouch = this.touch.attach();
    const detachDialog = this.ui.onDialogChange(() => {
      this.release();
      if (this.blocked) stop();
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    window.addEventListener('blur', stop, options);
    window.addEventListener('pagehide', stop, options);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      resetClock();
    }, options);
    return () => {
      controller.abort();
      detachDialog();
      detachKeyboard();
      detachTouch();
    };
  }

  direction(): Direction {
    if (this.blocked) return 0;
    const left = this.keyboard.left || this.touch.left;
    const right = this.keyboard.right || this.touch.right;
    return left === right ? 0 : left ? -1 : 1;
  }

  jump(): boolean {
    const keyboard = this.keyboard.jump();
    const touch = this.touch.jump();
    return !this.blocked && (keyboard || touch);
  }

  release(): void {
    this.keyboard.release();
    this.touch.release();
  }
}
