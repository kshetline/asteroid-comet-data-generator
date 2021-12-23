export class QueryablePromise<T> extends Promise<T> {
  private _isRejected = false;
  private _isResolved = false;
  private _isSettled = false;

  then<TResult1 = T, TResult2 = never>(
    onResolved?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    const newResolved = onResolved && ((value: T): TResult1 | PromiseLike<TResult1> => {
      this._isResolved = true;
      this._isSettled = true;
      return onResolved(value);
    });
    const newRejected = onRejected && ((reason: any): TResult2 | PromiseLike<TResult2> => {
      this._isRejected = true;
      this._isSettled = true;
      return onRejected(reason);
    });

    return super.then(newResolved, newRejected);
  }

  catch<TResult = never>(
    onRejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null
  ): Promise<T | TResult> {
    const newRejected = onRejected && ((reason: any): TResult | PromiseLike<TResult> => {
      this._isRejected = true;
      this._isSettled = true;
      return onRejected(reason);
    });

    return super.catch(newRejected);
  }

  finally(
    onFinally?: (() => void) | undefined | null
  ): Promise<T> {
    const newFinally = onFinally && ((): void => {
      this._isSettled = true;
      return onFinally();
    });

    return super.finally(newFinally);
  }

  get isRejected(): boolean { return this._isRejected; }
  get isResolved(): boolean { return this._isResolved; }
  get isSettled(): boolean { return this._isSettled; }
}
