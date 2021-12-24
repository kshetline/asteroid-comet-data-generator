export class Emitter<T> {
  private _resolve: any;
  private pending: T[] = [];

  emit(value: T): void {
    if (this._resolve) {
      this._resolve(value);
      this._resolve = undefined;
    }
    else
      this.pending.push(value);
  }

  async get(): Promise<T> {
    if (this.pending.length > 0)
      return this.pending.splice(0, 1)[0];

    return new Promise<T>(resolve => this._resolve = resolve);
  }
}
