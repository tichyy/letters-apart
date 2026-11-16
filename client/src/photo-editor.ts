import { Connection, HttpError, randomId } from './connection';
import type { Photo, UploadedPhoto } from './protocol';
import { defaultCrop, panPhoto, photoLayout, validCrop, zoomPhoto, type Point } from './photo-crop';

export class PhotoEditor {
  photo: Photo | null = null;
  busy = false;
  locked = false;
  private generation = 0;
  private controller?: AbortController;
  private url?: string;
  private pendingUpload?: { file: File; id: string };
  private disposed = false;
  private pointers = new Map<number, Point>();
  private gestureStart?: Point;
  private dragged = false;
  private resize: ResizeObserver;
  private readonly box: HTMLElement;
  private readonly image: HTMLImageElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;

  get ready(): boolean { return !this.busy && (!this.photo || !!this.url); }
  private get writing(): boolean { return this.key !== undefined; }

  constructor(
    form: HTMLFormElement,
    private readonly connection: Connection,
    private readonly changed: () => void,
    private readonly key?: string,
  ) {
    this.box = form.querySelector('.postcard-photo')!;
    this.image = this.box.querySelector('img')!;
    this.input = form.querySelector('.postcard-photo-input')!;
    this.status = form.querySelector('.postcard-photo-status')!;
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(this.box);
    this.input.onchange = () => {
      const file = this.input.files?.[0];
      this.input.value = '';
      if (file) void this.upload(file);
    };
    this.box.onclick = event => {
      if (!this.dragged || event.detail === 0) this.activate();
    };
    this.box.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.activate();
    });
    if (this.writing) this.gestures();
    this.render();
  }

  private activate(): void {
    if (this.locked || this.busy || this.disposed || this.box.hidden) return;
    if (this.writing) this.input.click();
    else if (this.photo && !this.url) void this.show(this.photo);
  }

  restore(): void {
    if (!this.key) return;
    try {
      const photo = JSON.parse(sessionStorage.getItem(this.key) ?? 'null');
      if (photo && /^[a-f0-9]{32}$/.test(photo.id) && photo.width > 0 && photo.height > 0 && validCrop(photo.crop)) {
        void this.show(photo);
      }
    } catch { sessionStorage.removeItem(this.key); }
  }

  private save(): void {
    if (!this.key) return;
    if (this.photo) sessionStorage.setItem(this.key, JSON.stringify(this.photo));
    else sessionStorage.removeItem(this.key);
  }

  private release(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    this.image.removeAttribute('src');
    this.image.hidden = true;
  }

  private begin(): { generation: number; signal: AbortSignal } {
    this.controller?.abort();
    this.controller = new AbortController();
    this.busy = true;
    this.status.textContent = '';
    this.pointers.clear();
    this.changed();
    this.render();
    return { generation: ++this.generation, signal: this.controller.signal };
  }

  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }

  private async upload(file: File): Promise<void> {
    if (this.locked || this.disposed) return;
    if (file.size > 20 * 1024 * 1024) {
      this.status.textContent = 'Choose a photo smaller than 20 MB.';
      return;
    }
    const old = this.photo;
    const previous = this.pendingUpload;
    const sameFile = previous && ['name', 'size', 'type', 'lastModified'].every(
      key => file[key as keyof File] === previous.file[key as keyof File],
    );
    const id = sameFile ? previous.id : randomId();
    this.pendingUpload = { file, id };
    const { generation, signal } = this.begin();
    let uploaded: UploadedPhoto | undefined;
    try {
      if (previous && !sameFile) await this.connection.discardPhoto(previous.id);
      uploaded = await this.connection.uploadPhoto(file, id, signal);
      if (!this.current(generation)) {
        if (uploaded.id !== this.photo?.id) void this.connection.discardPhoto(uploaded.id).catch(() => {});
        return;
      }
      const blob = await this.connection.readPhoto(uploaded.id, signal);
      if (!this.current(generation)) return;
      this.release();
      this.photo = { ...uploaded, crop: defaultCrop() };
      this.url = URL.createObjectURL(blob);
      this.image.src = this.url;
      this.image.hidden = false;
      this.pendingUpload = undefined;
      this.status.textContent = '';
      this.save();
      if (old && old.id !== uploaded.id) void this.connection.discardPhoto(old.id).catch(() => {});
    } catch (error) {
      if (this.current(generation)) this.status.textContent = this.message(error);
    } finally {
      if (this.current(generation)) {
        this.busy = false;
        this.render();
        this.changed();
      }
    }
  }

  async show(photo: Photo | null, retain = false): Promise<boolean> {
    if (!retain) {
      this.release();
      this.photo = photo;
    }
    this.pendingUpload = undefined;
    if (!photo) {
      this.controller?.abort();
      ++this.generation;
      this.release();
      this.photo = null;
      this.busy = false;
      this.status.textContent = '';
      this.render();
      return true;
    }
    const { generation, signal } = this.begin();
    let url: string | undefined;
    try {
      const blob = await this.connection.readPhoto(photo.id, signal);
      if (!this.current(generation)) return false;
      url = URL.createObjectURL(blob);
      const decoded = new Image();
      decoded.src = url;
      await decoded.decode();
      if (!this.current(generation)) return false;
      this.release();
      this.photo = photo;
      this.url = url;
      url = undefined;
      this.image.src = this.url;
      this.image.hidden = false;
      this.status.textContent = '';
      return true;
    } catch (error) {
      if (this.current(generation)) {
        if (this.writing && error instanceof HttpError && error.status === 404) {
          this.photo = null;
          this.save();
          void this.connection.discardPhoto(photo.id).catch(() => {});
        }
        this.status.textContent = this.message(error);
      }
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (this.current(generation)) {
        this.busy = false;
        this.render();
        this.changed();
      }
    }
  }

  reset(): void {
    const old = this.photo;
    const pending = this.pendingUpload;
    void this.show(null);
    this.save();
    this.changed();
    for (const id of new Set([old?.id, pending?.id])) {
      if (id) void this.connection.discardPhoto(id).catch(() => {});
    }
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.resize.disconnect();
    this.pointers.clear();
    this.release();
    if (this.pendingUpload) void this.connection.discardPhoto(this.pendingUpload.id).catch(() => {});
  }

  private message(error: unknown): string {
    return error instanceof Error && error.name !== 'AbortError'
      ? error.message : 'Photo interrupted. Please try again.';
  }

  render(): void {
    this.box.setAttribute('aria-busy', String(this.busy));
    this.box.classList.toggle('has-photo', !!this.url);
    this.box.classList.toggle('is-editable', this.writing && !!this.url && !this.locked && !this.busy);
    this.box.tabIndex = this.writing || (this.photo && !this.url) ? 0 : -1;
    if (!this.photo || !this.box.clientWidth || !this.box.clientHeight) return;
    const size = { width: this.box.clientWidth, height: this.box.clientHeight };
    const layout = photoLayout(this.photo, size, this.photo.crop);
    Object.assign(this.image.style, {
      width: `${layout.width / size.width * 100}%`, height: `${layout.height / size.height * 100}%`,
      left: `${layout.left / size.width * 100}%`, top: `${layout.top / size.height * 100}%`,
    });
  }

  private gestures(): void {
    const editable = () => !!this.photo && !!this.url && !this.locked && !this.busy;
    const viewport = () => ({ width: this.box.clientWidth, height: this.box.clientHeight });
    const update = () => { this.render(); this.save(); };
    this.box.onpointerdown = event => {
      if (this.pointers.size === 0) {
        this.dragged = false;
        this.gestureStart = { x: event.clientX, y: event.clientY };
      }
      if (!editable() || event.button !== 0 || this.pointers.size >= 2) return;
      if (this.pointers.size === 1) this.dragged = true;
      this.box.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.box.focus({ preventScroll: true });
      event.preventDefault();
    };
    this.box.onpointermove = event => {
      if (!editable() || !this.pointers.has(event.pointerId)) return;
      const old = [...this.pointers.values()];
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const next = [...this.pointers.values()];
      if (this.gestureStart && Math.hypot(event.clientX - this.gestureStart.x, event.clientY - this.gestureStart.y) > 6) {
        this.dragged = true;
      }
      if (!this.dragged) return;
      const midpoint = (points: Point[]) => points.length === 1 ? points[0]
        : { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const before = midpoint(old);
      const after = midpoint(next);
      const photo = this.photo!;
      if (old.length === 2) {
        const distance = (points: Point[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const oldDistance = distance(old);
        if (oldDistance > 1) {
          const rect = this.box.getBoundingClientRect();
          photo.crop = zoomPhoto(photo, viewport(), photo.crop, photo.crop.zoom * distance(next) / oldDistance,
            { x: before.x - rect.left, y: before.y - rect.top });
        }
      }
      photo.crop = panPhoto(photo, viewport(), photo.crop, after.x - before.x, after.y - before.y);
      update();
      event.preventDefault();
    };
    const release = (event: PointerEvent) => {
      if (event.type !== 'pointerup' && this.pointers.has(event.pointerId)) this.dragged = true;
      this.pointers.delete(event.pointerId);
    };
    this.box.onpointerup = release;
    this.box.onpointercancel = release;
    this.box.onlostpointercapture = release;
    this.box.addEventListener('wheel', event => {
      if (!editable()) return;
      event.preventDefault();
      const rect = this.box.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      this.photo!.crop = zoomPhoto(this.photo!, viewport(), this.photo!.crop,
        this.photo!.crop.zoom * Math.exp(-delta * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      update();
    }, { passive: false });
    this.box.onkeydown = event => {
      if (!editable()) return;
      const photo = this.photo!;
      const size = viewport();
      if (['+', '=', '-', '_'].includes(event.key)) {
        photo.crop = zoomPhoto(photo, size, photo.crop, photo.crop.zoom * (['+', '='].includes(event.key) ? 1.15 : 1 / 1.15),
          { x: size.width / 2, y: size.height / 2 });
      } else {
        const movement: Record<string, [number, number]> = {
          ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20],
        };
        if (!movement[event.key]) return;
        photo.crop = panPhoto(photo, size, photo.crop, ...movement[event.key]);
      }
      event.preventDefault();
      update();
    };
  }
}
