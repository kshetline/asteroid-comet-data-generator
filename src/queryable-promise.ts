export class QueryablePromise<T> extends Promise<T> {
  private _isRejected = false;
  private _isResolved = false;
  private _isSettled = false;

  constructor(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void) {
    super((resolve, reject) => executor(
      value => {
        resolve(value);
        this._isResolved = true;
        this._isSettled = true;
      },
      err => {
        reject(err);
        this._isRejected = true;
        this._isSettled = true;
      }
    ));

    this._isRejected = false;
    this._isResolved = false;
    this._isSettled = false;
  }

  get isRejected(): boolean { return this._isRejected; }
  get isResolved(): boolean { return this._isResolved; }
  get isSettled(): boolean { return this._isSettled; }
}
