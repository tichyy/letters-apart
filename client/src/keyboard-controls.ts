const jumpKeys = ['Space', 'ArrowUp', 'KeyW'];
const gameKeys = ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyE', ...jumpKeys];

export class KeyboardControls {
  private keys = new Set<string>();
  private jumpRequested = false;

  constructor(private blocked: () => boolean, private interact: () => void) {}

  attach(): () => void {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    window.addEventListener('keydown', event => {
      if (this.blocked() || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!gameKeys.includes(event.code)) return;
      event.preventDefault();
      this.keys.add(event.code);
      if (jumpKeys.includes(event.code) && !event.repeat) this.jumpRequested = true;
      if (event.code === 'KeyE' && !event.repeat) this.interact();
    }, options);
    window.addEventListener('keyup', event => this.keys.delete(event.code), options);
    return () => {
      controller.abort();
      this.release();
    };
  }

  get left(): boolean { return this.keys.has('ArrowLeft') || this.keys.has('KeyA'); }
  get right(): boolean { return this.keys.has('ArrowRight') || this.keys.has('KeyD'); }

  jump(): boolean {
    const jump = this.jumpRequested || jumpKeys.some(key => this.keys.has(key));
    this.jumpRequested = false;
    return jump;
  }

  release(): void {
    this.keys.clear();
    this.jumpRequested = false;
  }
}
