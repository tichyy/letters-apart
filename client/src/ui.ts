import type { Postcard, Side, Stamp } from './protocol';

export class UI {
  readonly gameplay: HTMLElement;
  private panel = document.createElement('dialog');
  private hint: HTMLButtonElement;
  private notice: HTMLElement;
  private toastTimer?: number;
  private events = new EventTarget();
  private submitting = false;

  constructor(
    private readonly send: (message: object) => boolean,
    private readonly join: (side: Side) => void,
    private readonly requestInteraction: () => void,
  ) {
    const root = document.querySelector<HTMLElement>('#interface')!;
    root.innerHTML = `
      <div id="notice" role="status" aria-live="polite"></div>
      <div id="gameplay">
        <div class="bottom"><button id="interact" class="interaction" hidden></button></div>
        <div class="touch-controls" aria-label="Movement controls">
          <div class="movement-controls">
            <button type="button" data-control="left" aria-label="Walk left">
              <span class="control-art" aria-hidden="true"></span>
            </button>
            <button type="button" data-control="right" aria-label="Walk right">
              <span class="control-art" aria-hidden="true"></span>
            </button>
          </div>
          <button type="button" data-control="jump" aria-label="Jump">
            <span class="control-art" aria-hidden="true"></span>
          </button>
        </div>
      </div>`;
    if (matchMedia('(any-pointer: coarse)').matches) {
      for (const action of ['left', 'right', 'jump']) {
        const pressed = new Image();
        pressed.src = `/ui/controls_${action}2.png`;
      }
    }
    this.gameplay = root.querySelector('#gameplay')!;
    this.hint = root.querySelector('#interact')!;
    this.notice = root.querySelector('#notice')!;
    root.append(this.panel);
    this.hint.onclick = () => this.interact();
    this.panel.addEventListener('close', () => {
      this.submitting = false;
      this.syncGameplay();
    });
    this.panel.addEventListener('cancel', event => {
      if (this.submitting || this.panel.dataset.kind === 'home') event.preventDefault();
    });
    this.panel.addEventListener('click', event => {
      if (event.target === this.panel && !this.submitting && this.panel.dataset.kind !== 'home') {
        this.panel.close();
      }
    });
  }

  get blocked(): boolean { return this.panel.open; }

  onDialogChange(listener: () => void): () => void {
    this.events.addEventListener('dialogchange', listener);
    return () => this.events.removeEventListener('dialogchange', listener);
  }

  private syncGameplay(): void {
    this.gameplay.hidden = this.blocked;
    this.events.dispatchEvent(new Event('dialogchange'));
  }

  setHint(text: string): void {
    this.hint.hidden = !text;
    this.hint.textContent = matchMedia('(any-pointer: coarse)').matches ? text.replace(/^E · /, '') : text;
  }

  interact(): void {
    if (!this.blocked) this.requestInteraction();
  }

  toast(text: string): void {
    clearTimeout(this.toastTimer);
    this.notice.textContent = text;
    this.toastTimer = window.setTimeout(() => { this.notice.textContent = ''; }, 4500);
  }

  chooseHome(occupied = false): void {
    this.open('home', `
      <p class="eyebrow">LETTERS APART</p><h1>Which way is home?</h1>
      <p>${occupied ? 'That home has someone in it. Choose the other side.' : 'Two homes. A little distance. Something to say.'}</p>
      <div class="home-choices"><button data-home="left">← Left home</button><button data-home="right">Right home →</button></div>
      <p class="small">Each of you chooses a different home.</p>`);
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-home]')) {
      button.onclick = () => {
        this.panel.close();
        this.join(button.dataset.home as Side);
      };
    }
  }

  compose(): void {
    const savedStamp = sessionStorage.getItem('letters-draft-stamp');
    const stamp = savedStamp === '1' ? 1 : savedStamp === '2' ? 2 : savedStamp === '3' ? 3 : null;
    const form = this.postcard(sessionStorage.getItem('letters-draft') ?? '', stamp, true);
    const title = form.querySelector<HTMLInputElement>('.postcard-title')!;
    title.value = sessionStorage.getItem('letters-draft-title') ?? '';
    this.fitPostcardText(form);
    const textarea = form.querySelector('textarea')!;
    for (const field of [title, textarea]) this.limitPostcardText(field);
    const pack = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const reset = form.querySelector<HTMLButtonElement>('[type="reset"]')!;
    const preview = form.querySelector<HTMLElement>('.postcard-stamp')!;
    const update = () => {
      const selected = form.querySelector<HTMLInputElement>('[name="stamp"]:checked');
      sessionStorage.setItem('letters-draft', textarea.value);
      sessionStorage.setItem('letters-draft-title', title.value);
      if (selected) {
        preview.style.backgroundImage = `url('/ui/stamp${selected.value}.png')`;
        preview.setAttribute('aria-label', `Stamp ${selected.value}`);
        preview.hidden = false;
        sessionStorage.setItem('letters-draft-stamp', selected.value);
      } else {
        preview.hidden = true;
        preview.style.backgroundImage = '';
        sessionStorage.removeItem('letters-draft-stamp');
      }
      pack.disabled = this.submitting || !textarea.value.trim() || !selected;
      reset.disabled = this.submitting;
    };
    update();
    form.oninput = update;
    form.addEventListener('compositionend', update);
    form.onreset = event => {
      event.preventDefault();
      if (this.submitting) return;
      title.value = '';
      textarea.value = '';
      title.style.fontSize = textarea.style.fontSize = '';
      for (const input of form.querySelectorAll<HTMLInputElement>('[name="stamp"]')) input.checked = false;
      form.querySelector('#form-error')!.textContent = '';
      update();
    };
    form.onsubmit = event => {
      event.preventDefault();
      const selected = form.querySelector<HTMLInputElement>('[name="stamp"]:checked');
      if (this.submitting || !textarea.value.trim() || !selected) return;
      if (!this.send({ type: 'write', title: title.value.trim(), body: textarea.value.trim(), stamp: Number(selected.value) })) {
        this.error('Connection lost. Your draft is saved; try again when connected.');
        return;
      }
      this.submitting = true;
      update();
    };
    if (!matchMedia('(pointer: coarse)').matches) textarea.focus();
  }

  written(): void {
    sessionStorage.removeItem('letters-draft');
    sessionStorage.removeItem('letters-draft-title');
    sessionStorage.removeItem('letters-draft-stamp');
    this.panel.close();
    this.toast('Postcard packed. Deliver it to the other mailbox.');
  }

  read(cards: Postcard[]): void {
    if (!cards.length) return;
    const form = this.postcard(cards[0].body, cards[0].stamp, false);
    const previous = form.querySelector<HTMLButtonElement>('.postcard-previous')!;
    const next = form.querySelector<HTMLButtonElement>('.postcard-next')!;
    let index = 0;
    const show = (target: number) => {
      const card = cards[target];
      if (!this.send({ type: 'read', id: card.id })) {
        this.panel.close();
        this.error('Connection lost. Reopen your mailbox when connected.');
        return;
      }
      index = target;
      form.querySelector<HTMLInputElement>('.postcard-title')!.value = card.title;
      form.querySelector('textarea')!.value = card.body;
      this.fitPostcardText(form);
      const stamp = form.querySelector<HTMLElement>('.postcard-stamp')!;
      stamp.style.backgroundImage = `url('/ui/stamp${card.stamp}.png')`;
      stamp.setAttribute('aria-label', `Stamp ${card.stamp}`);
      previous.disabled = index === 0;
      next.disabled = index === cards.length - 1;
    };
    previous.onclick = () => show(index - 1);
    next.onclick = () => show(index + 1);
    show(0);
  }

  private postcard(body: string, stamp: Stamp | null, writing: boolean): HTMLFormElement {
    this.open(writing ? 'compose' : 'postcard', `
      <form class="postcard-editor" data-side="back">
        <div class="postcard-stage">
          <img class="postcard-art" src="/ui/postcard1.png" alt="Postcard" draggable="false">
          <div class="postcard-back">
            <input class="postcard-title" name="title" aria-label="Postcard title"
              maxlength="60" autocomplete="off" ${writing ? '' : 'readonly'}>
            <textarea class="postcard-message" name="message" aria-label="Postcard message"
              maxlength="1000" required ${writing ? '' : 'readonly'}></textarea>
            <span class="postcard-stamp" role="img" aria-label="Stamp ${stamp}"
              ${stamp ? `style="background-image: url('/ui/stamp${stamp}.png')"` : 'hidden'}></span>
          </div>
          <button type="button" class="postcard-turn" aria-label="Turn postcard over" aria-pressed="false"></button>
          ${writing ? `<button type="reset" class="postcard-reset" aria-label="Reset postcard" title="Reset postcard"></button>
            <button type="submit" class="postcard-pack" aria-label="Put postcard in backpack" title="Put postcard in backpack" disabled></button>` : ''}
        </div>
        ${writing ? `<div class="postcard-stamps" role="group" aria-label="Choose a stamp">
          ${([1, 2, 3] as const).map(value => `<input type="radio" name="stamp" value="${value}"
            aria-label="Stamp ${value}" required ${value === stamp ? 'checked' : ''}
            style="background-image: url('/ui/stamp${value}.png')">`).join('')}
        </div><p id="form-error" role="alert"></p>` : `<div class="postcard-navigation" aria-label="Mailbox navigation">
          <button type="button" class="postcard-previous" aria-label="Previous postcard" disabled></button>
          <button type="button" class="postcard-next" aria-label="Next postcard" disabled></button>
        </div>`}
      </form>`);
    const form = this.panel.querySelector('form')!;
    form.querySelector('textarea')!.value = body;
    const turn = form.querySelector<HTMLButtonElement>('.postcard-turn')!;
    turn.onclick = () => {
      const front = form.dataset.side !== 'front';
      form.dataset.side = front ? 'front' : 'back';
      form.querySelector<HTMLImageElement>('.postcard-art')!.src = `/ui/postcard${front ? 2 : 1}.png`;
      form.querySelector<HTMLElement>('.postcard-back')!.hidden = front;
      if (!front) this.fitPostcardText(form);
      turn.setAttribute('aria-pressed', String(front));
    };
    for (const name of [
      'postcard2', 'button_rotate2', 'button_rotate3',
      ...(writing ? ['button_send2', 'button_send3', 'button_reset2', 'button_reset3']
        : ['button_left2', 'button_left3', 'button_right2', 'button_right3']),
    ]) {
      const image = new Image();
      image.src = `/ui/${name}.png`;
    }
    return form;
  }

  private textOverflows(field: HTMLInputElement | HTMLTextAreaElement): boolean {
    return field.scrollHeight > field.clientHeight + 1 || field.scrollWidth > field.clientWidth + 1;
  }

  private fitPostcardText(form: HTMLFormElement): void {
    for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.postcard-title, .postcard-message')) {
      if (!field.clientWidth) continue;
      field.style.fontSize = '';
      // Keep older, longer postcards readable inside the same fixed area.
      for (let size = 5; this.textOverflows(field) && size > 1; size -= 0.125) {
        field.style.fontSize = `${size - 0.125}cqw`;
      }
      field.scrollTop = field.scrollLeft = 0;
    }
  }

  private limitPostcardText(field: HTMLInputElement | HTMLTextAreaElement): void {
    let value = field.value;
    let start = 0;
    let end = 0;
    field.onbeforeinput = event => {
      if (event.isComposing) return;
      value = field.value;
      start = field.selectionStart ?? 0;
      end = field.selectionEnd ?? start;
    };
    const limit = (event: Event) => {
      if (event instanceof InputEvent && event.isComposing) return;
      if (this.textOverflows(field)) {
        field.value = value;
        field.setSelectionRange(start, end);
      }
      value = field.value;
      field.scrollTop = field.scrollLeft = 0;
    };
    field.addEventListener('input', limit);
    field.addEventListener('compositionend', limit);
  }

  error(text: string): void {
    this.submitting = false;
    const submit = this.panel.querySelector<HTMLButtonElement>('[type="submit"]');
    if (submit) submit.disabled = !this.panel.querySelector('textarea')!.value.trim()
      || !this.panel.querySelector('[name="stamp"]:checked');
    const reset = this.panel.querySelector<HTMLButtonElement>('[type="reset"]');
    if (reset) reset.disabled = false;
    const error = this.panel.querySelector('#form-error');
    if (this.panel.open && error) error.textContent = text;
    else this.toast(text);
  }

  disconnected(): void {
    if (this.submitting) this.error('Connection interrupted. Your draft is saved.');
  }

  private open(kind: string, html: string): void {
    if (this.panel.open) this.panel.close();
    this.panel.dataset.kind = kind;
    this.panel.innerHTML = html;
    this.panel.showModal();
    this.syncGameplay();
  }
}
