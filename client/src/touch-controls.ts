type Action = 'left' | 'right' | 'jump';

export class TouchControls {
  private pointers = new Map<number, { button: HTMLButtonElement; action: Action }>();
  private jumpRequested = false;

  constructor(private root: HTMLElement, private blocked: () => boolean) {}

  attach(): () => void {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-control]')) {
      const action = button.dataset.control as Action;
      button.addEventListener('pointerdown', event => {
        if (this.blocked() || event.button !== 0) return;
        event.preventDefault();
        this.pointers.set(event.pointerId, { button, action });
        button.setPointerCapture(event.pointerId);
        button.toggleAttribute('data-held', true);
        if (action === 'jump') this.jumpRequested = true;
      }, options);
      const release = (event: PointerEvent) => {
        this.pointers.delete(event.pointerId);
        button.toggleAttribute('data-held', [...this.pointers.values()].some(pointer => pointer.button === button));
      };
      button.addEventListener('pointerup', release, options);
      button.addEventListener('pointercancel', release, options);
      button.addEventListener('lostpointercapture', release, options);
    }
    // Game controls are held repeatedly; native selection and menus interrupt play.
    for (const event of ['contextmenu', 'selectstart', 'dragstart']) {
      this.root.addEventListener(event, event => event.preventDefault(), options);
    }
    return () => {
      controller.abort();
      this.release();
    };
  }

  private held(action: Action): boolean {
    return [...this.pointers.values()].some(pointer => pointer.action === action);
  }

  get left(): boolean { return this.held('left'); }
  get right(): boolean { return this.held('right'); }

  jump(): boolean {
    const jump = this.jumpRequested || this.held('jump');
    this.jumpRequested = false;
    return jump;
  }

  release(): void {
    const pointers = [...this.pointers.entries()];
    this.pointers.clear();
    this.jumpRequested = false;
    for (const [id, { button }] of pointers) {
      button.removeAttribute('data-held');
      if (button.hasPointerCapture(id)) button.releasePointerCapture(id);
    }
  }
}
