import type { Postcard, Side, Stamp, Crop } from './protocol';
import { Connection, randomId } from './connection';
import { PhotoEditor } from './photo-editor';
import { postcardArt, stampArt } from './art';
import world from '../../world.json';

interface PendingWrite {
  side: Side;
  message: { type: 'write'; requestId: string; title: string; body: string; stamp: number;
    imageId: string | null; crop: Crop };
}

interface LibraryPages {
  previous?: () => boolean;
  next?: () => boolean;
  remove: (id: number, index: number) => boolean;
}

export class UI {
  readonly gameplay: HTMLElement;
  private panel = document.createElement('dialog');
  private hint: HTMLButtonElement;
  private galleryButton: HTMLButtonElement;
  private dropButton: HTMLButtonElement;
  private dropTimer?: number;
  private notice: HTMLElement;
  private toastTimer?: number;
  private toastAnimation?: Animation;
  private noticeWorldPosition?: { x: number; y: number };
  private events = new EventTarget();
  private submitting = false;
  private photo?: PhotoEditor;
  private pending?: PendingWrite;
  private side?: Side;
  private updateCompose?: () => void;
  private caretCleanup?: () => void;
  private galleryFromEnd = false;
  private galleryFront = true;
  private galleryIndex = 0;
  private libraryReader?: (cards: Postcard[], start: number, pages: LibraryPages) => void;
  private get photoDraftKey(): string { return `letters-draft-photo-${this.side}`; }

  constructor(
    private readonly send: (message: object) => boolean,
    private readonly join: (side: Side) => void,
    private readonly requestInteraction: (type?: 'interact' | 'gallery') => void,
    private readonly connection: Connection,
  ) {
    const root = document.querySelector<HTMLElement>('#interface')!;
    root.innerHTML = `
      <div id="notice" role="status" aria-live="polite"></div>
      <div id="gameplay">
        <div class="bottom">
          <button id="interact" class="interaction" hidden></button>
          <button id="gallery" class="interaction" hidden>Received postcards</button>
          <button id="drop" class="interaction" hidden></button>
        </div>
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
    this.gameplay = root.querySelector('#gameplay')!;
    this.hint = root.querySelector('#interact')!;
    this.galleryButton = root.querySelector('#gallery')!;
    this.dropButton = root.querySelector('#drop')!;
    this.notice = root.querySelector('#notice')!;
    root.append(this.panel);
    this.hint.onclick = () => this.interact();
    this.galleryButton.textContent = matchMedia('(any-pointer: coarse)').matches ? 'Received postcards' : 'F · Received postcards';
    this.galleryButton.onclick = () => this.openLibrary();
    this.dropButton.textContent = matchMedia('(any-pointer: coarse)').matches ? 'Hold to drop postcard' : 'Hold Q · Drop postcard';
    this.dropButton.addEventListener('pointerdown', event => {
      if (event.button === 0) this.holdDrop(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      this.dropButton.addEventListener(type, () => this.holdDrop(false));
    }
    this.panel.addEventListener('close', () => {
      if (this.panel.open) return;
      this.caretCleanup?.();
      this.caretCleanup = undefined;
      this.libraryReader = undefined;
      this.photo?.dispose();
      this.photo = undefined;
      this.updateCompose = undefined;
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

  /** The world is built: show it and its controls together. */
  revealWorld(): void {
    delete document.body.dataset.loading;
  }

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

  setGalleryAvailable(available: boolean): void { this.galleryButton.hidden = !available; }

  setDropAvailable(available: boolean): void {
    if (available === !this.dropButton.hidden) return;
    this.dropButton.hidden = !available;
    if (!available) this.holdDrop(false);
  }

  get noticeAnchor(): { x: number; y: number } | undefined {
    return this.notice.textContent ? this.noticeWorldPosition : undefined;
  }

  positionNotice(x: number, y: number): void {
    const bounds = this.notice.parentElement!.getBoundingClientRect();
    const halfWidth = this.notice.offsetWidth / 2;
    const height = this.notice.offsetHeight;
    // World messages leave the screen with their object instead of sticking to
    // the screen edge as the player walks away.
    this.notice.style.visibility = x < bounds.left || x > bounds.right ? 'hidden' : '';
    // Keep the message readable at the edges and within the mobile viewport.
    this.notice.style.left = `${Math.max(halfWidth + 16, Math.min(bounds.width - halfWidth - 16, x - bounds.left))}px`;
    this.notice.style.top = `${Math.max(height + 16, Math.min(bounds.height - 16, y - bounds.top))}px`;
  }

  openLibrary(): void {
    if (this.blocked || this.galleryButton.hidden) return;
    this.galleryFromEnd = false;
    this.galleryFront = true;
    this.galleryIndex = 0;
    this.requestInteraction('gallery');
  }

  interact(): void {
    if (!this.blocked) this.requestInteraction();
  }

  /** Dropping discards the card, so it takes a deliberate one-second hold. */
  holdDrop(held: boolean): void {
    clearTimeout(this.dropTimer);
    const holding = held && !this.blocked && !this.dropButton.hidden;
    this.dropButton.toggleAttribute('data-holding', holding);
    if (!holding) return;
    this.dropTimer = window.setTimeout(() => {
      this.dropButton.removeAttribute('data-holding');
      this.send({ type: 'drop' });
    }, 1000);
  }

  toast(text: string, anchor?: { x: number; y: number }): void {
    clearTimeout(this.toastTimer);
    const opacity = getComputedStyle(this.notice).opacity;
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
    this.toastAnimation?.cancel();
    this.noticeWorldPosition = anchor ? { ...anchor } : undefined;
    this.notice.style.visibility = '';
    if (!anchor) {
      this.notice.style.left = '';
      this.notice.style.top = '';
    }
    this.notice.textContent = text;
    this.toastAnimation = this.notice.animate([{ opacity }, { opacity: 1 }], {
      duration, easing: 'ease-out', fill: 'forwards',
    });
    this.toastTimer = window.setTimeout(() => {
      this.toastAnimation?.cancel();
      const fade = this.toastAnimation = this.notice.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration, easing: 'ease-in', fill: 'forwards',
      });
      void fade.finished.then(() => {
        if (this.toastAnimation === fade) this.notice.textContent = '';
      }).catch(() => {}); // A replacement message cancels the outgoing fade.
    }, 4500);
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

  replaced(side: Side): void {
    this.open('home', `
      <p class="eyebrow">LETTERS APART</p><h1>Playing somewhere else</h1>
      <p>Your home is open in another window or device.</p>
      <div class="home-choices"><button data-home>Play here instead</button></div>`);
    this.panel.querySelector<HTMLButtonElement>('[data-home]')!.onclick = () => {
      this.panel.close();
      this.join(side);
    };
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
    this.trackInsertion(form);
    const pack = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const reset = form.querySelector<HTMLButtonElement>('[type="reset"]')!;
    const preview = form.querySelector<HTMLElement>('.postcard-stamp')!;
    const update = () => {
      const selected = form.querySelector<HTMLInputElement>('[name="stamp"]:checked');
      sessionStorage.setItem('letters-draft', textarea.value);
      sessionStorage.setItem('letters-draft-title', title.value);
      if (selected) {
        preview.style.backgroundImage = `url('${stampArt[Number(selected.value) as Stamp]}')`;
        preview.setAttribute('aria-label', `Stamp ${selected.value}`);
        preview.hidden = false;
        sessionStorage.setItem('letters-draft-stamp', selected.value);
      } else {
        preview.hidden = true;
        preview.style.backgroundImage = '';
        sessionStorage.removeItem('letters-draft-stamp');
      }
      pack.disabled = this.submitting || !photo.ready || !textarea.value.trim() || !selected;
      reset.disabled = this.submitting;
      title.readOnly = textarea.readOnly = this.submitting;
      for (const input of form.querySelectorAll<HTMLInputElement>('[name="stamp"]')) input.disabled = this.submitting;
      photo.locked = this.submitting;
      photo.render();
    };
    const photo = this.photo = new PhotoEditor(form, this.connection, update, this.photoDraftKey);
    this.updateCompose = update;
    this.submitting = !!this.pending;
    update();
    photo.restore();
    form.oninput = update;
    form.addEventListener('compositionend', update);
    form.onreset = event => {
      event.preventDefault();
      if (this.submitting) return;
      if (form.dataset.side === 'front') photo.reset();
      else {
        title.value = '';
        textarea.value = '';
        title.style.fontSize = textarea.style.fontSize = '';
        for (const input of form.querySelectorAll<HTMLInputElement>('[name="stamp"]')) input.checked = false;
      }
      form.querySelector('#form-error')!.textContent = '';
      update();
    };
    form.onsubmit = event => {
      event.preventDefault();
      const selected = form.querySelector<HTMLInputElement>('[name="stamp"]:checked');
      if (this.submitting || !photo.ready || !textarea.value.trim() || !selected || !this.side) return;
      const pending: PendingWrite = { side: this.side, message: {
        type: 'write', requestId: randomId(), title: title.value.trim(), body: textarea.value.trim(),
        stamp: Number(selected.value), imageId: photo.photo?.id ?? null,
        crop: photo.photo ? { ...photo.photo.crop } : { x: 0.5, y: 0.5, zoom: 1 },
      } };
      if (!this.send(pending.message)) {
        this.error('Connection lost. Your draft is saved; try again when connected.');
        return;
      }
      this.pending = pending;
      sessionStorage.setItem('letters-pending-write', JSON.stringify(pending));
      this.submitting = true;
      update();
    };
    if (!matchMedia('(pointer: coarse)').matches) textarea.focus();
  }

  connected(side: Side): void {
    this.side = side;
    try {
      const pending = JSON.parse(sessionStorage.getItem('letters-pending-write') ?? 'null') as PendingWrite | null;
      this.pending = pending?.side === side ? pending : undefined;
    } catch {
      this.pending = undefined;
      sessionStorage.removeItem('letters-pending-write');
    }
    if (this.pending) this.send(this.pending.message);
  }

  written(requestId?: string): void {
    if (requestId && requestId !== this.pending?.message.requestId) return;
    this.pending = undefined;
    sessionStorage.removeItem('letters-pending-write');
    sessionStorage.removeItem('letters-draft');
    sessionStorage.removeItem('letters-draft-title');
    sessionStorage.removeItem('letters-draft-stamp');
    sessionStorage.removeItem(this.photoDraftKey);
    if (this.panel.dataset.kind === 'compose') this.panel.close();
    this.toast('Postcard packed. Deliver it to the other mailbox.',
      this.side ? { x: world.desks[this.side], y: 0 } : undefined);
  }

  gallery(cards: Postcard[], page: number, hasMore: boolean): void {
    const start = this.galleryFromEnd ? cards.length - 1 : Math.min(this.galleryIndex, cards.length - 1);
    this.galleryIndex = 0;
    this.galleryFromEnd = false;
    if (!cards.length) {
      if (this.libraryReader) this.panel.close();
      this.toast('Nothing to see here yet...',
        this.side ? { x: world.desks[this.side], y: 28 } : undefined);
      return;
    }
    const turnPage = (target: number, fromEnd: boolean): boolean => {
      if (!this.send({ type: 'gallery', page: target })) {
        this.toast('Connection lost. Reopen your library when connected.');
        return false;
      }
      this.galleryFromEnd = fromEnd;
      return true;
    };
    this.read(cards, start, {
      previous: page > 0 ? () => turnPage(page - 1, true) : undefined,
      next: hasMore ? () => turnPage(page + 1, false) : undefined,
      remove: (id, index) => {
        if (!this.send({ type: 'delete', id, page })) {
          this.toast('Connection lost. Please try again when connected.');
          return false;
        }
        this.galleryIndex = index;
        this.galleryFromEnd = cards.length === 1 && page > 0;
        return true;
      },
    });
  }

  read(cards: Postcard[], start = 0, pages?: LibraryPages): void {
    if (!cards[start]) return;
    if (pages && this.libraryReader) {
      this.libraryReader(cards, start, pages);
      return;
    }
    const form = this.postcard(cards[start].body, cards[start].stamp, false);
    const photo = this.photo = new PhotoEditor(form, this.connection, () => {});
    const previous = form.querySelector<HTMLButtonElement>('.postcard-previous')!;
    const next = form.querySelector<HTMLButtonElement>('.postcard-next')!;
    let remove: HTMLButtonElement | undefined;
    if (pages) {
      remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'postcard-delete';
      remove.setAttribute('aria-label', 'Delete postcard');
      remove.title = 'Delete postcard';
      form.querySelector('.postcard-stage')!.append(remove);
      remove.onclick = () => {
        if (!loading && current && pages?.remove(current.id, index)) {
          remove!.disabled = previous.disabled = next.disabled = true;
        }
      };
    }
    let index = -1;
    let current: Postcard | undefined;
    let loading = false;
    const markCurrent = () => !current || this.send({ type: 'read', id: current.id });
    const show = async (target: number) => {
      if (!this.panel.open || loading) return;
      if (!markCurrent()) {
        this.panel.close();
        this.error('Connection lost. Reopen your mailbox when connected.');
        return;
      }
      if (target < 0 || target >= cards.length) {
        const turnPage = target < 0 ? pages?.previous : pages?.next;
        if (turnPage?.()) previous.disabled = next.disabled = true;
        return;
      }
      const card = cards[target];
      if (!pages && form.dataset.side === 'front') form.querySelector<HTMLButtonElement>('.postcard-turn')!.click();
      loading = true;
      previous.disabled = next.disabled = true;
      if (remove) remove.disabled = true;
      const loaded = await photo.show(card.image ?? null, !!pages);
      loading = false;
      if (remove) remove.disabled = false;
      if (!this.panel.open || this.photo !== photo) return;
      if (pages && !loaded && current) {
        previous.disabled = index < 0 || (index === 0 && !pages.previous);
        next.disabled = index < 0 || (index === cards.length - 1 && !pages.next);
        this.toast('Could not load this postcard. Please try again.');
        return false;
      }
      index = target;
      current = card;
      form.classList.add('has-card');
      form.querySelector<HTMLInputElement>('.postcard-title')!.value = card.title;
      form.querySelector('textarea')!.value = card.body;
      this.fitPostcardText(form);
      const stamp = form.querySelector<HTMLElement>('.postcard-stamp')!;
      stamp.style.backgroundImage = `url('${stampArt[card.stamp]}')`;
      stamp.setAttribute('aria-label', `Stamp ${card.stamp}`);
      previous.disabled = index === 0 && !pages?.previous;
      next.disabled = index === cards.length - 1 && !pages?.next;
      return true;
    };
    previous.onclick = () => show(index - 1);
    next.onclick = () => show(index + 1);
    this.panel.onclose = () => {
      if (this.panel.open) return;
      if (this.panel.dataset.kind === 'postcard' && current) {
        markCurrent();
      }
      this.panel.onclose = null;
    };
    if (pages) {
      this.libraryReader = async (nextCards, nextStart, nextPages) => {
        const saved = { cards, pages, index };
        cards = nextCards;
        pages = nextPages;
        index = -1;
        if (!await show(nextStart) && this.panel.open && this.photo === photo) {
          ({ cards, pages, index } = saved);
          previous.disabled = index === 0 && !pages?.previous;
          next.disabled = index === cards.length - 1 && !pages?.next;
        }
      };
    }
    void show(start);
    if (pages) {
      const turn = form.querySelector<HTMLButtonElement>('.postcard-turn')!;
      turn.addEventListener('click', () => { this.galleryFront = form.dataset.side === 'front'; });
      if (this.galleryFront) turn.click();
    }
  }

  private postcard(body: string, stamp: Stamp | null, writing: boolean): HTMLFormElement {
    this.open(writing ? 'compose' : 'postcard', `
      <form class="postcard-editor" data-side="back">
        <div class="postcard-stage">
          <img class="postcard-art" src="${postcardArt.back}" alt="Postcard" draggable="false">
          <div class="postcard-photo" role="group" aria-label="Postcard photo" hidden>
            <img alt="Photo on the front of the postcard" draggable="false" hidden>
          </div>
          <div class="postcard-back">
            <input class="postcard-title" name="title" aria-label="Postcard title"
              maxlength="60" autocomplete="off" ${writing ? 'placeholder="A little title..."' : 'readonly'}>
            <textarea class="postcard-message" name="message" aria-label="Postcard message"
              maxlength="1000" required ${writing ? 'placeholder="Write a little note..."' : 'readonly'}></textarea>
            <span class="postcard-stamp" role="img" aria-label="Stamp ${stamp}"
              ${stamp ? `style="background-image: url('${stampArt[stamp]}')"` : 'hidden'}></span>
          </div>
          <button type="button" class="postcard-turn" aria-label="Turn postcard over" aria-pressed="false"></button>
          ${writing ? `<button type="reset" class="postcard-reset" aria-label="Reset message side" title="Reset message side"></button>
            <button type="submit" class="postcard-pack" aria-label="Put postcard in backpack" title="Put postcard in backpack" disabled></button>` : ''}
        </div>
        <input class="postcard-photo-input" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" hidden ${writing ? '' : 'disabled'}>
        <p class="postcard-photo-status" role="status" aria-live="polite" hidden></p>
        ${writing ? `<div class="postcard-stamps" role="group" aria-label="Choose a stamp">
          ${([1, 2, 3] as const).map(value => `<input type="radio" name="stamp" value="${value}"
            aria-label="Stamp ${value}" required ${value === stamp ? 'checked' : ''}
            style="background-image: url('${stampArt[value]}')">`).join('')}
        </div><p id="form-error" role="alert"></p>` : `<div class="postcard-navigation" aria-label="Mailbox navigation">
          <button type="button" class="postcard-previous" aria-label="Previous postcard" disabled></button>
          <button type="button" class="postcard-next" aria-label="Next postcard" disabled></button>
        </div>`}
      </form>`);
    const form = this.panel.querySelector('form')!;
    form.querySelector('textarea')!.value = body;
    if (!writing) this.readLarger(form);
    const turn = form.querySelector<HTMLButtonElement>('.postcard-turn')!;
    turn.onclick = () => {
      const front = form.dataset.side !== 'front';
      form.dataset.side = front ? 'front' : 'back';
      form.querySelector<HTMLImageElement>('.postcard-art')!.src = front ? postcardArt.front : postcardArt.back;
      form.querySelector<HTMLElement>('.postcard-back')!.hidden = front;
      form.querySelector<HTMLElement>('.postcard-photo')!.hidden = !front;
      form.querySelector<HTMLElement>('.postcard-photo-status')!.hidden = !front;
      const stamps = form.querySelector<HTMLElement>('.postcard-stamps');
      if (stamps) stamps.inert = front;
      const reset = form.querySelector<HTMLButtonElement>('.postcard-reset');
      if (reset) {
        reset.setAttribute('aria-label', front ? 'Reset photo side' : 'Reset message side');
        reset.title = front ? 'Reset photo side' : 'Reset message side';
      }
      this.photo?.render();
      if (!front) this.fitPostcardText(form);
      turn.setAttribute('aria-pressed', String(front));
    };
    return form;
  }

  private trackInsertion(form: HTMLFormElement): void {
    const back = form.querySelector<HTMLElement>('.postcard-back')!;
    const highlight = document.createElement('span');
    highlight.className = 'postcard-insertion';
    highlight.setAttribute('aria-hidden', 'true');
    const mirror = document.createElement('div');
    mirror.className = 'postcard-text-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    back.append(highlight, mirror);
    const events = new AbortController();
    let composing = false;
    const update = () => {
      const field = document.activeElement;
      highlight.hidden = true;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
          || !back.contains(field) || field.readOnly || composing
          || field.selectionStart === null || field.selectionStart !== field.selectionEnd) return;
      const style = getComputedStyle(field);
      const size = parseFloat(style.fontSize);
      Object.assign(mirror.style, {
        width: `${field.clientWidth}px`, fontFamily: style.fontFamily, fontSize: style.fontSize,
        fontWeight: style.fontWeight, fontStyle: style.fontStyle, lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        whiteSpace: field instanceof HTMLInputElement ? 'pre' : 'pre-wrap',
      });
      const index = field.selectionStart;
      const codePoint = field.value.codePointAt(index);
      const character = codePoint === undefined ? '' : String.fromCodePoint(codePoint);
      const marker = document.createElement('span');
      marker.textContent = character && character !== '\n' ? character : '\u00a0';
      mirror.replaceChildren(document.createTextNode(field.value.slice(0, index)), marker,
        document.createTextNode(field.value.slice(index + character.length)));
      const cell = marker.getBoundingClientRect();
      const origin = mirror.getBoundingClientRect();
      const inset = field instanceof HTMLInputElement ? (field.clientHeight - size) / 2 : 0;
      Object.assign(highlight.style, {
        left: `${Math.round(field.offsetLeft + cell.left - origin.left - field.scrollLeft)}px`,
        top: `${Math.round(field.offsetTop + inset + cell.top - origin.top + size * 0.3125 - field.scrollTop)}px`,
        width: `${Math.max(2, Math.round(cell.width))}px`, height: `${Math.round(size * 0.5)}px`,
      });
      highlight.hidden = false;
    };
    for (const event of ['input', 'focusin', 'focusout', 'keyup', 'pointerup', 'select', 'scroll']) {
      form.addEventListener(event, update, { capture: true, signal: events.signal });
    }
    form.addEventListener('reset', () => queueMicrotask(update), { signal: events.signal });
    form.addEventListener('compositionstart', () => { composing = true; update(); }, { signal: events.signal });
    form.addEventListener('compositionend', () => { composing = false; update(); }, { signal: events.signal });
    document.addEventListener('selectionchange', update, { signal: events.signal });
    const resize = new ResizeObserver(update);
    resize.observe(form);
    this.caretCleanup = () => { events.abort(); resize.disconnect(); };
    update();
  }

  /**
   * Page zoom is blocked (a zoomed dialog left the game stuck zoomed in), and the
   * card's text shrinks to fit a small area. Tapping it shows it in large type.
   */
  private readLarger(form: HTMLFormElement): void {
    const title = form.querySelector<HTMLInputElement>('.postcard-title')!;
    const message = form.querySelector('textarea')!;
    const reader = document.createElement('div');
    reader.className = 'postcard-reader';
    reader.tabIndex = -1;
    reader.hidden = true;
    const heading = document.createElement('h2');
    const body = document.createElement('p');
    reader.append(heading, body);
    form.append(reader);
    const open = () => {
      heading.textContent = title.value;
      heading.hidden = !title.value;
      body.textContent = message.value;
      reader.hidden = false;
      reader.scrollTop = 0;
      reader.focus();
    };
    const close = () => { reader.hidden = true; };
    for (const field of [title, message] as HTMLElement[]) {
      field.title = 'Read larger';
      field.addEventListener('click', open);
      field.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); open(); }
      });
    }
    reader.addEventListener('click', close);
    // Escape closes the large text first, then the postcard.
    const cancel = (event: Event) => {
      if (!reader.isConnected) this.panel.removeEventListener('cancel', cancel);
      else if (!reader.hidden) { event.preventDefault(); close(); }
    };
    this.panel.addEventListener('cancel', cancel);
  }

  private textOverflows(field: HTMLInputElement | HTMLTextAreaElement): boolean {
    return field.scrollHeight > field.clientHeight + 1 || field.scrollWidth > field.clientWidth + 1;
  }

  private fitPostcardText(form: HTMLFormElement): void {
    for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.postcard-title, .postcard-message')) {
      if (!field.clientWidth) continue;
      field.style.fontSize = '';
      // Keep older, longer postcards readable inside the same fixed area.
      for (let size = field.classList.contains('postcard-title') ? 6 : 5; this.textOverflows(field) && size > 1; size -= 0.125) {
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

  error(text: string, requestId?: string): void {
    if (requestId && requestId !== this.pending?.message.requestId) return;
    if (this.pending && !requestId) { this.toast(text); return; }
    if (requestId) {
      this.pending = undefined;
      sessionStorage.removeItem('letters-pending-write');
    }
    this.submitting = false;
    const submit = this.panel.querySelector<HTMLButtonElement>('[type="submit"]');
    if (submit) submit.disabled = !this.panel.querySelector('textarea')!.value.trim()
      || !this.panel.querySelector('[name="stamp"]:checked');
    const reset = this.panel.querySelector<HTMLButtonElement>('[type="reset"]');
    if (reset) reset.disabled = false;
    this.updateCompose?.();
    const error = this.panel.querySelector('#form-error');
    if (this.panel.open && error) error.textContent = text;
    else this.toast(text);
  }

  disconnected(): void {
    if (this.submitting) this.toast('Connection interrupted. Your postcard will retry when connected.');
  }

  private open(kind: string, html: string): void {
    this.caretCleanup?.();
    this.caretCleanup = undefined;
    this.libraryReader = undefined;
    this.photo?.dispose();
    this.photo = undefined;
    this.updateCompose = undefined;
    if (this.panel.open) this.panel.close();
    this.panel.dataset.kind = kind;
    this.panel.innerHTML = html;
    this.panel.showModal();
    this.syncGameplay();
  }
}
