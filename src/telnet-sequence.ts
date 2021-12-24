import { ConnectOptions, Telnet } from './telnet';
import { isString } from '@tubular/util';

export interface TelnetSequenceOptions extends ConnectOptions {
  echoToConsole?: boolean;
  sessionTimeout?: number;
}

export type TelnetSequenceSteps = { prompt: RegExp | string, response: string }[];

class Emitter<T> {
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

export class TelnetSequence {
  private step = 0;
  private _telnet: Telnet;

  constructor(
    private opts: TelnetSequenceOptions,
    private steps: TelnetSequenceSteps
  ) {
    this.opts.sessionTimeout = opts.sessionTimeout ?? 60000;
  }

  async process(lineReceiver: (line: string) => boolean,
                _escapeHandler?: (escapeSequence: string) => string): Promise<void> {
    const telnet = new Telnet();
    const lineSource = new Emitter<Error | string | null>();
    let buffer = '';
    let connected = false;
    let sessionTimer: any;
    const checkSessionTimeout = (restart = true): void => {
      if (sessionTimer)
        clearTimeout(sessionTimer);

      if (restart) {
        sessionTimer = setTimeout(() => {
          sessionTimer = undefined;
          connected = false;
          lineSource.emit(new Error('telnet session timeout'));
        }, this.opts.sessionTimeout);
      }
    };

    this._telnet = telnet;

    telnet.on('data', data => {
      data = data.toString().replace(/\r\r\n/g, '\n').replace(/\r\n?/g, '\n');
      buffer += data;

      if (this.opts.echoToConsole)
        process.stdout.write(data);

      let pos: number;

      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, pos + 1);

        lineSource.emit(line);
        buffer = buffer.substring(pos + 1);
      }

      if (buffer)
        lineSource.emit(buffer);

      buffer = '';
      checkSessionTimeout();
    });

    telnet.on('close', () => {
      connected = false;
      lineSource.emit(null);
    });

    telnet.on('end', () => {
      connected = false;
      lineSource.emit(null);
    });

    telnet.on('error', err => {
      connected = false;
      lineSource.emit(err instanceof Error ? err : new Error(err.toString));
    });

    telnet.on('timeout', () => {
      connected = false;
      lineSource.emit(new Error('telnet timeout'));
    });

    await telnet.connect(this.opts);
    connected = true;
    checkSessionTimeout();

    return new Promise<void>((resolve, reject) => {
      (async (): Promise<void> => {
        let line: Error | string | null;

        if (this.steps.length > 0 && this.steps[0].prompt === null) {
          await telnet.send(this.steps[0].response);
          ++this.step;
        }

        // eslint-disable-next-line no-unmodified-loop-condition
        while (connected && (line = await lineSource.get()) !== null) {
          if (line instanceof Error) {
            reject(line);
            checkSessionTimeout(false);
            return;
          }

          const prompt = this.steps[this.step]?.prompt;

          if (isString(prompt) && line.endsWith(prompt) ||
              prompt instanceof RegExp && prompt.test(line))
            await telnet.send(this.steps[this.step++].response);
          else if (lineReceiver(line))
            break;
        }

        checkSessionTimeout(false);
        resolve();
      })();
    });
  }

  get telnet(): Telnet { return this._telnet; }
}
