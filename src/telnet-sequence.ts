import { isString } from '@tubular/util';
import { Emitter } from './emitter';
import { ConnectOptions, Telnet } from 'telnet-client-ks';

export interface TelnetSequenceOptions extends ConnectOptions {
  echoToConsole?: boolean;
  lineCompletionDelay?: number;
  sessionTimeout?: number;
  stripControls?: boolean;
}

export type TelnetSequenceSteps = { prompt: RegExp | string, response: string }[];

export class TelnetSequence {
  private opts: TelnetSequenceOptions = {};
  private step = 0;
  private _telnet: Telnet;

  constructor(
    opts: TelnetSequenceOptions,
    private steps: TelnetSequenceSteps
  ) {
    Object.assign(this.opts, opts);
    this.opts.lineCompletionDelay = opts.lineCompletionDelay ?? 50;
    this.opts.sendTimeout = 300000;
    this.opts.timeout = 300000;
    this.opts.sessionTimeout = opts.sessionTimeout ?? 60000;
    this.opts.stripControls = true;
    this.opts.shellPrompt = null;
    this.opts.newlineReplace = '\n';
  }

  async process(lineReceiver: (line: string) => boolean | void): Promise<void> {
    const telnet = new Telnet();
    const lineSource = new Emitter<Error | string | null>();
    let buffer = '';
    let connected = false;
    let sessionTimer: any;
    let lineTimer: any;
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
      if (lineTimer) {
        clearTimeout(lineTimer);
        lineTimer = undefined;
      }

      buffer += data.toString();

      if (this.opts.echoToConsole)
        process.stdout.write(data);

      let pos: number;

      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, pos + 1);

        lineSource.emit(line);
        buffer = buffer.substring(pos + 1);
      }

      if (buffer) {
        lineTimer = setTimeout(() => {
          lineTimer = undefined;

          if (buffer) {
            lineSource.emit(buffer);
            buffer = '';
            checkSessionTimeout();
          }
        }, this.opts.lineCompletionDelay);
      }

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

        // `connected` is modified, but asynchronously outside of this loop.
        // eslint-disable-next-line no-unmodified-loop-condition
        while (connected && (line = await lineSource.get()) !== null) {
          if (line instanceof Error) {
            checkSessionTimeout(false);
            reject(line);
            return;
          }

          while (this.step < this.steps.length &&
                 this.steps[this.step].prompt == null && this.steps[this.step].response == null)
            ++this.step;

          const prompt = this.steps[this.step]?.prompt;

          if (isString(prompt) && line.endsWith(prompt) ||
              prompt instanceof RegExp && prompt.test(line))
            await telnet.send(this.steps[this.step++].response);
          else if (lineReceiver(line))
            break;
        }

        checkSessionTimeout(false);
        resolve();
      })().catch(err => reject(err));
    });
  }

  get telnet(): Telnet { return this._telnet; }
}
