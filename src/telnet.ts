// This is a stripped-down version of this project: https://github.com/mkozjak/node-telnet-client
// ...with improved feature negotiation.

import events from 'events';
import { createConnection, Socket } from 'net';

export class Telnet extends events.EventEmitter {
  private extSock: any;
  private initialCTRLC = false;
  private initialLFCR = false;
  private maxBufferLength: number;
  private ors: string;
  private sendTimeout: number;
  private socket: Socket;
  private timeout: number;
  private waitFor: RegExp;

  connect(opts: any): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let promisePending = true;
      const rejectIt = (reason: any): void => { promisePending = false; reject(reason); };
      const resolveIt = (): void => { promisePending = false; resolve(); };

      const host = (typeof opts.host !== 'undefined' ? opts.host : '127.0.0.1');
      const port = (typeof opts.port !== 'undefined' ? opts.port : 23);
      const localAddress = (typeof opts.localAddress !== 'undefined' ? opts.localAddress : '');
      const socketConnectOptions = (typeof opts.socketConnectOptions !== 'undefined' ? opts.socketConnectOptions : {});
      this.timeout = (typeof opts.timeout !== 'undefined' ? opts.timeout : 500);

      this.extSock = (typeof opts.sock !== 'undefined' ? opts.sock : undefined);
      this.ors = (typeof opts.ors !== 'undefined' ? opts.ors : '\n');
      this.initialLFCR = (typeof opts.initialLFCR !== 'undefined' ? opts.initialLFCR : false);
      this.initialCTRLC = (typeof opts.initialCTRLC !== 'undefined' ? opts.initialCTRLC : false);
      this.sendTimeout = (typeof opts.sendTimeout !== 'undefined' ? opts.sendTimeout : 2000);
      this.maxBufferLength = (typeof opts.maxBufferLength !== 'undefined' ? opts.maxBufferLength : 1048576);

      /* if socket is provided and in good state, just reuse it */
      if (this.extSock) {
        if (!this._checkSocket())
          return rejectIt(new Error('socket invalid'));

        this.socket = this.extSock;
        this.emit('ready');

        resolveIt();
      }
      else {
        this.socket = createConnection({
          port,
          host,
          localAddress,
          ...socketConnectOptions
        }, () => {
          this.emit('connect');

          if (this.initialCTRLC === true) this.socket.write(Buffer.from('03', 'hex'));
          if (this.initialLFCR === true) this.socket.write('\r\n');
        });
      }

      this.socket.setTimeout(this.timeout, () => {
        if (promisePending) {
          /* if cannot connect, emit error and destroy */
          if (this.listeners('error').length > 0)
            this.emit('error', 'Cannot connect');

          this.socket.destroy();
          return reject(new Error('Cannot connect'));
        }

        this.emit('timeout');
        return reject(new Error('timeout'));
      });

      this.socket.on('data', data => {
        if ((data = this.parseData(data))) {
          if (promisePending)
            resolveIt();

          this.emit('data', data);
        }
      });

      this.socket.on('error', error => {
        if (this.listeners('error').length > 0)
          this.emit('error', error);

        if (promisePending)
          rejectIt(error);
      });

      this.socket.on('end', () => {
        this.emit('end');

        if (promisePending)
          rejectIt(new Error('Socket ends'));
      });

      this.socket.on('close', () => {
        this.emit('close');

        if (promisePending)
          rejectIt(new Error('Socket closes'));
      });
    });
  }

  send(data: Buffer | string, opts?: any): Promise<void> {
    return new Promise((resolve, reject) => {
      if (opts && opts instanceof Object) {
        this.ors = opts.ors || this.ors;
        this.sendTimeout = opts.timeout || this.sendTimeout;
        this.maxBufferLength = opts.maxBufferLength || this.maxBufferLength;
        this.waitFor = (opts.waitFor ? (opts.waitFor instanceof RegExp ? opts.waitFor : RegExp(opts.waitFor)) : false);
      }

      data += this.ors;

      if (this.socket.writable) {
        let response = '';
        const sendHandler = (data: Buffer): void => {
          response += data.toString();

          if (this.waitFor && this.waitFor.test(response)) {
            this.removeListener('data', sendHandler);
            resolve();
          }
        };

        this.socket.on('data', sendHandler);

        try {
          this.socket.write(data, () => {
            if (!this.waitFor || !opts) {
              setTimeout(() => {
                if (response === '') {
                  this.socket.removeListener('data', sendHandler);
                  reject(new Error('response not received'));
                  return;
                }

                this.socket.removeListener('data', sendHandler);
                resolve();
              }, this.sendTimeout);
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

  _checkSocket(): boolean {
    return this.extSock !== null &&
      typeof this.extSock === 'object' &&
      typeof this.extSock.pipe === 'function' &&
      this.extSock.writable !== false &&
      typeof this.extSock._write === 'function' &&
      typeof this.extSock._writableState === 'object' &&
      this.extSock.readable !== false &&
      typeof this.extSock._read === 'function' &&
      typeof this.extSock._readableState === 'object';
  }
}
