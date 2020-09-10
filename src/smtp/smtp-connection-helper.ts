import * as streams from 'stream';
import * as crypto from 'crypto';
import * as os from 'os';
import { EventEmitter } from 'events';

import { SMTPStream } from './smtp-stream';
import base32 from 'base32.js';
import { SMTPServerDataStream } from 'smtp-server';

interface ISession {
  id: string;
  error?: string;
}

interface ILazyCommand {
  payload: string;
  callback?: () => void;
}

type NextHandler = () => void;
export type CommandHandler = (commandName: string, command: string, next: () => void) => void;
export type DataHandler = (dataStream: SMTPServerDataStream, next: (err, message) => void) => void;

export interface IOptions {
  readable: streams.Readable;
  writable: streams.Writable;
  id?: string;
  name?: string;
  banner?: string;
  lmtp?: boolean;
  commandHandler?: CommandHandler;
  dataHandler?: DataHandler;
  maxDataBytes?: number;
}

export class SmtpConnectionHelper extends EventEmitter {
  private _parser: SMTPStream;
  private _readable: streams.Readable;
  private _writable: streams.Writable;

  public name: string;
  public banner: string;

  private _id: string;
  private _lmtp: boolean;

  private _ready: boolean = false;
  private _closing: boolean = false;
  private _session: ISession;

  private _nextHandler: NextHandler | false = false;

  private _dataStream!: SMTPServerDataStream;
  private _maxDataBytes: number = 1048576 * 1000;

  private _openingCommand: string = '';
  private _unrecognizedCommands: number = 0;
  private _transactionCounter: number = 0;

  public commandHandler: CommandHandler | false = false;
  public dataHandler!: DataHandler;

  private _commandStateStack: string[] = [];
  private _lazyCommands: ILazyCommand[] = [];

  public constructor(options: IOptions) {
    super();
    this._readable = options.readable;
    this._writable = options.writable;
    this._parser = new SMTPStream();

    this._lmtp = options.lmtp || false;

    this.name = options.name || os.hostname();
    this.banner = options.banner || 'unknown';

    this._id = options.id || base32.encode(crypto.randomBytes(10)).toLowerCase();
    this._maxDataBytes = options.maxDataBytes || (1048576 * 1024);

    this._session = {
      id: this._id
    };

    if (options.commandHandler) {
      this.commandHandler = options.commandHandler;
    }
    if (options.dataHandler) {
      this.dataHandler = options.dataHandler;
    }

    this._parser.oncommand = this._onCommand.bind(this);
    this._readable
      .on('finish', () => {
        console.error('READABLE_FINISH_01');
      })
      .pipe(this._parser);
  }

  public init() {
    this.send(220, this.name + ' ESMTP ' + this.banner, () => {
      this._ready = true;
    });
  }

  public close() {
    if (!this._closing) {
      console.error('TP_CLOSE_01');
      this._writable.end();
      this._closing = true;
      this.emit('close');
    }
  }

  private _onCommand(buffer: Buffer, callback?: () => void) {
    const command = (buffer || '').toString();
    let commandName: string = command.split(' ')[0].toUpperCase();

    if (!this._ready) {
      // block spammers that send payloads before server greeting
      return this.send(421, this.name + ' You talk too soon');
    }

    // block malicious web pages that try to make SMTP calls from an AJAX request
    if (/^(OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT) \/.* HTTP\/\d\.\d$/i.test(command)) {
      return this.send(421, 'HTTP requests not allowed');
    }

    callback = callback || (() => false);

    // if (this._upgrading) {
    //   // ignore any commands before TLS upgrade is finished
    //   return callback();
    // }

    // detect handler from the command name
    switch (commandName) {
    case 'HELO':
    case 'EHLO':
    case 'LHLO':
      this._openingCommand = commandName;
      break;
    }
    if (this._lmtp) {
      switch (commandName) {
      case 'HELO':
      case 'EHLO':
        this.send(500, 'Error: ' + commandName + ' not allowed in LMTP server');
        return setImmediate(callback);
      case 'LHLO':
        commandName = 'EHLO';
        break;
      }
    }

    if (commandName === 'QUIT') {
      return this.handler_QUIT(command, callback);
    }

    if (commandName === 'DATA') {
      return this.handler_DATA(command, callback);
    }

    this._commandStateStack.push(commandName);

    if (this.commandHandler) {
      this.commandHandler(commandName, command, callback);
    } else {
      return setImmediate(callback);
    }
  }

  /**
   * Send data to socket
   *
   * @param {Number} code Response code
   * @param {String|Array} data If data is Array, send a multi-line response
   * @param callback
   * @param noStackResponse
   */
  public send(code: number, data: string | string[], callback?: () => void, noStackResponse?: boolean) {
    const _noStackResponse = noStackResponse || false;

    let payload: string;
    let responseCount = 1;

    if (Array.isArray(data)) {
      responseCount = data.length;
      payload = data.map((line, i, arr) => code + (i < arr.length - 1 ? '-' : ' ') + line).join('\r\n');
    } else {
      payload = ([] as any[])
        .concat(code || [])
        .concat(data || [])
        .join(' ');
    }

    if (code >= 400) {
      this._session.error = payload;
    }

    const temp = Buffer.from(payload + '\r\n');

    if (!_noStackResponse) {
      this._commandStateStack.splice(0, responseCount);
    }

    this._writable.write(temp, () => {
      if (code != 421) {
        this._processLazyCommand();
        if (callback) {
          callback();
        }
      }
    });

    if (code === 421) {
      this.close();
      if (callback) {
        callback();
      }
    }
  }

  public sendRaw(payload: string, callback?: () => void) {
    if (this._closing) {
      console.error('Aborted sendRaw because in closing', payload);
      if (callback) callback();
      return ;
    }
    const temp = payload + '\r\n';
    this._commandStateStack.shift();
    return this._writable.write(Buffer.from(temp), (err) => {
      if (err) {
        console.error('[ERR] writable write error', err, ' ::::: ', temp);
      }
      this._processLazyCommand();
      if (callback) callback();
    });
  }

  public sendLazy(code: number, data: string, callback?: () => void) {
    const payload = ([] as any[])
      .concat(code || [])
      .concat(data || [])
      .join(' ');

    this._lazyCommands.push({
      payload: payload,
      callback: callback
    });

    this._processLazyCommand();
  }

  private _processLazyCommand() {
    if (!this._commandStateStack.length) {
      const item = this._lazyCommands.shift();
      if (item) {
        this.sendRaw(item.payload, item.callback);
      }
    }
  }

  handler_QUIT(command: string, callback: () => void) {
    this.send(221, 'Bye');
    this.close();
    callback();
  }

  handler_DATA(command: string, callback: () => void) {
    this._dataStream = this._parser.startDataMode(this._maxDataBytes);

    const close = (err, message, closeNext?: () => void) => {
      if (typeof this._dataStream === 'object' && this._dataStream && this._dataStream.readable) {
        this._dataStream.removeAllListeners();
      }

      if (err) {
        // single error response when using SMTP
        this.send(err.responseCode || 450, err.message, closeNext);
      } else if (Array.isArray(message)) {
        // separate responses for every recipient when using LMTP
        message.forEach(response => {
          if (/Error\]$/i.test(Object.prototype.toString.call(response))) {
            this.send(response.responseCode || 450, response.message);
          } else {
            this.send(250, typeof response === 'string' ? response : 'OK: message accepted');
          }
        });
        if (closeNext) closeNext();
      } else {
        // single success response when using SMTP
        this.send(250, typeof message === 'string' ? message : 'OK: message queued', closeNext);
      }

      this._transactionCounter++;

      this._unrecognizedCommands = 0; // reset unrecognized commands counter

      if (typeof this._parser === 'object' && this._parser) {
        this._parser.continue();
      }
    };

    this.dataHandler(this._dataStream, (err, message) => {
      // ensure _dataStream is an object and not set to null by premature closing
      // do not continue until the stream has actually ended
      if (typeof this._dataStream === 'object' && this._dataStream && this._dataStream.readable) {
        this._dataStream.on('end', () => close(err, message));
        return;
      }
      close(err, message);
    });

    this.sendLazy(354, 'End data with <CR><LF>.<CR><LF>');
    callback();
  }
}
