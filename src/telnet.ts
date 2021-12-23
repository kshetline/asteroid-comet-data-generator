// This is a stripped-down version of this project: https://github.com/mkozjak/node-telnet-client
// ...with improved feature negotiation.

import events from 'events';
import { createConnection, Socket, SocketConnectOpts } from 'net';
import { QueryablePromise } from './queryable-promise';

export interface SendOptions {
  maxBufferLength?: number;
  ors?: string;
  timeout?: number;
  waitFor?: string | RegExp | false;
  waitfor?: string | RegExp | false;
}

export interface ConnectOptions extends SendOptions {
  debug?: boolean;
  echoLines?: number;
  execTimeout?: number;
  extSock?: any;
  failedLoginMatch?: string | RegExp;
  host?: string;
  initialCTRLC?: boolean;
  initialCtrlC?: boolean;
  initialLFCR?: boolean;
  irs?: string;
  localAddress?: string;
  loginPrompt?: string | RegExp;
  negotiationMandatory?: boolean;
  pageSeparator?: string | RegExp;
  password?: string;
  passwordPrompt?: string|RegExp;
  port?: number;
  sendTimeout?: number;
  shellPrompt?: string | RegExp;
  sock?: Socket;
  socketConnectOptions?: SocketConnectOpts;
  stripShellPrompt?: boolean;
  username?: string;
}

const defaultOptions: ConnectOptions = {
  debug: false,
  echoLines: 1,
  execTimeout: 2000,
  host: '127.0.0.1',
  initialCtrlC: false,
  initialLFCR: false,
  irs: '\r\n',
  localAddress: '',
  loginPrompt: /login[: ]*$/i,
  maxBufferLength: 1048576,
  negotiationMandatory: true,
  ors: '\n',
  pageSeparator: '---- More',
  password: 'guest',
  passwordPrompt: /password[: ]*$/i,
  port: 23,
  sendTimeout: 2000,
  shellPrompt: /(?:\/ )?#\s/,
  stripShellPrompt: true,
  timeout: 2000,
  username: 'root',
  waitFor: false
};

Object.freeze(defaultOptions);

function stringToRegex(opts: any): void {
  ['failedLoginMatch', 'loginPrompt', 'passwordPrompt', 'shellPrompt', 'waitFor'].forEach(key => {
    const value = opts[key];

    opts[key] = typeof value === 'string' ? new RegExp(value) : value;
  });
}

export class Telnet extends events.EventEmitter {
  private opts = Object.assign({}, defaultOptions);
  private socket: Socket;

  connect(opts: ConnectOptions): Promise<void> {
    let promise: QueryablePromise<void>;

    return promise = new QueryablePromise<void>((resolve, reject) => {
      Object.assign(this.opts, opts ?? {});
      this.opts.initialCtrlC = opts.initialCTRLC && this.opts.initialCtrlC;
      stringToRegex(this.opts);

      // If socket is provided and in good state, just reuse it.
      if (this.opts.extSock) {
        if (!this.checkSocket(this.opts.extSock))
          return reject(new Error('socket invalid'));

        this.socket = this.opts.extSock;
        this.emit('ready');

        resolve();
      }
      else {
        this.socket = createConnection({
          port: this.opts.port,
          host: this.opts.host,
          localAddress: this.opts.localAddress,
          ...this.opts.socketConnectOptions
        }, () => {
          this.emit('connect');

          if (this.opts.initialCtrlC === true) this.socket.write('\x03');
          if (this.opts.initialLFCR === true) this.socket.write('\r\n');
        });
      }

      this.socket.setTimeout(this.opts.timeout, () => {
        if (!promise.isSettled) {
          /* if cannot connect, emit error and destroy */
          if (this.listeners('error').length > 0)
            this.emit('error', 'Cannot connect');

          this.socket.destroy();
          return reject(new Error('Cannot connect'));
        }

        this.emit('timeout');
        return reject(new Error('Timeout'));
      });

      this.socket.on('data', data => {
        if ((data = this.parseData(data))) {
          if (!promise.isSettled)
            resolve();

          this.emit('data', data);
        }
      });

      this.socket.on('error', error => {
        if (this.listeners('error').length > 0)
          this.emit('error', error);

        if (!promise.isSettled)
          reject(error);
      });

      this.socket.on('end', () => {
        this.emit('end');

        if (!promise.isSettled)
          reject(new Error('Socket ends'));
      });

      this.socket.on('close', () => {
        this.emit('close');

        if (!promise.isSettled)
          reject(new Error('Socket closes'));
      });
    });
  }

  async send(data: Buffer | string, opts?: SendOptions): Promise<void> {
    this.opts.ors = opts?.ors || this.opts.ors;
    data += this.opts.ors;

    return this.write(data, opts);
  }

  async write(data: Buffer | string, opts?: SendOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      Object.assign(this.opts, opts || {});
      this.opts.waitFor = opts?.waitfor ?? opts?.waitFor ?? false;
      stringToRegex(this.opts);

      if (this.socket.writable) {
        let response = '';
        const sendHandler = (data: Buffer): void => {
          response += data.toString();

          if (this.opts.waitFor instanceof RegExp && this.opts.waitFor.test(response)) {
            this.removeListener('data', sendHandler);
            resolve();
          }
        };

        this.socket.on('data', sendHandler);

        try {
          this.socket.write(data, () => {
            if (!this.opts.waitFor || !opts) {
              setTimeout(() => {
                if (response === '') {
                  this.socket.removeListener('data', sendHandler);
                  reject(new Error('response not received'));
                  return;
                }

                this.socket.removeListener('data', sendHandler);
                resolve();
              }, this.opts.sendTimeout);
            }
          });
        }
        catch (e) {
          this.socket.removeListener('data', sendHandler);
          reject(new Error('send data failed'));
        }
      }
      else {
        reject(new Error('socket not writable'));
      }
    });
  }

  getSocket(): Socket {
    return this.socket;
  }

  end(): Promise<void> {
    return new Promise(resolve => {
      this.socket.end(() => resolve);
    });
  }

  destroy(): Promise<void> {
    return new Promise(resolve => {
      this.socket.destroy();
      resolve();
    });
  }

  parseData(chunk: Buffer): Buffer {
    if (chunk[0] === 255 && chunk[1] !== 255)
      chunk = this.negotiate(chunk);

    return chunk;
  }

  negotiate(chunk: Buffer): Buffer {
    const packetLength = chunk.length;

    let negData = chunk;
    let cmdData = null;

    for (let i = 0; i < packetLength; i += 3) {
      if (chunk[i] !== 255) {
        negData = chunk.slice(0, i);
        cmdData = chunk.slice(i);
        break;
      }
    }

    const chunkHex = chunk.toString('hex');
    const defaultResponse = negData.toString('hex').replace(/fd/g, 'fc').replace(/fb/g, 'fd');
    let negResp = '';

    for (let i = 0; i < chunkHex.length; i += 6) {
      switch (chunkHex.substr(i + 2, 4)) {
        case 'fd18':
          negResp += 'fffb18';
          break;
        case 'fd1f':
          negResp += 'fffb1ffffa1f270f270ffff0';
          break;
        default:
          negResp += defaultResponse.substr(i, 6);
      }
    }

    if (this.socket.writable)
      this.socket.write(Buffer.from(negResp, 'hex'));

    return cmdData;
  }

  checkSocket(sock: any): boolean {
    return sock !== null &&
      typeof sock === 'object' &&
      typeof sock.pipe === 'function' &&
      sock.writable !== false &&
      typeof sock._write === 'function' &&
      typeof sock._writableState === 'object' &&
      sock.readable !== false &&
      typeof sock._read === 'function' &&
      typeof sock._readableState === 'object';
  }
}
