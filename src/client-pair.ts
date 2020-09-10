import * as net from 'net';
import * as streams from 'stream';
import * as uuid from 'uuid';
import * as iconv from 'iconv-lite';
import { JSDOM } from 'jsdom';

import {Splitter, Rewriter, Joiner, IDecodedHeaderItem} from 'mailsplit';

import { SMTPServerDataStream } from 'smtp-server';
import { SmtpConnectionHelper } from './smtp/smtp-connection-helper';
import { SMTPStream } from './smtp/smtp-stream';

import { IGeneratedMailTracker, HandlerType, IMailCommandItem } from './handler';

import * as libqp from 'libqp';
import {splitLimited} from './utils';

export interface IAppConfig {
  handlerFunction: HandlerType;
  nexthopHost: string;
  nexthopPort: number;
  errorHandler: (clientPair: ClientPair, e: Error) => void;
}

type NextHopNextHandler = (args: {
  code: string,
  message: string
}, payload: Buffer, callback: () => void) => void;
interface ILazyCommand {
  command: string;
  handler: () => void;
}
interface INextHopConnection {
  socket: net.Socket;
  parser: SMTPStream;
  ready: boolean;
  closing: boolean;
  nextHandler: NextHopNextHandler | null;
  commandStateStack: string[];
  lazyCommand: ILazyCommand[];
}

interface IContext {
  messageId: string | undefined;
  trackerId: string;
  generatedTracker: Promise<IGeneratedMailTracker | null>;
}

function rfc1342Decode(_input: string) {
  const input = _input.trim();
  if (input.startsWith('=?')) {
    const a = input.substring(2).split('=?');
    const b = a[0].split('?');
    const charset = b[0];
    const encoding = b[1].toLowerCase();
    const payload: Buffer =
      (encoding === 'b') ? Buffer.from(b[2], 'base64') : libqp.decode(b[2]); // Q
    return iconv.decode(payload, charset);
  }
  return input;
}

const CONTENT_TYPE_REGEX = /^((\w+)\/([^;]+))((?:\s*;?\s*(?:[^;]+))*)$/;
const RESPONSE_354_REGEX = /^End data with (.*)$/;
interface IParsedContentType {
  mime: string;
  type: string;
  subtype: string;
  parameter: Record<string, string>;
}
function parseContentType(input: string | undefined): IParsedContentType | undefined {
  const parsed = input && CONTENT_TYPE_REGEX.exec(input);
  if (parsed) {
    const t1 = parsed[4] && parsed[4].split(';').splice(1);
    const parameters =
      t1 && t1.reduce((map, text) => {
        const arr = splitLimited(text.trim(), '=', 2);
        const key = arr[0];
        let value = arr[1];
        if (/charset/i.test(key)) {
          const temp = /"([^"]+)"/.exec(value);
          value = temp && temp[1] || value;
        }
        map[key] = value;
        return map;
      }, {});
    return {
      mime: parsed[3],
      type: parsed[1],
      subtype: parsed[2],
      parameter: parameters && parameters || {}
    };
  }
  return undefined;
}

export class ClientPair {
  private _config: IAppConfig;

  private _readable: streams.Readable;
  private _writable: streams.Writable;
  private _nextHopConn: INextHopConnection;

  private _connHelper: SmtpConnectionHelper;

  public constructor(config: IAppConfig, readable: streams.Readable, writable: streams.Writable) {
    this._config = config;
    this._readable = readable;
    this._writable = writable;
    const nextHopSock = net.createConnection({
      host: config.nexthopHost,
      port: config.nexthopPort
    });
    nextHopSock.on('error', (e) => {
      this.errorHandler(e);
    });
    nextHopSock.on('close', () => {
      console.error('TP_nextHopSock_CLOSE_01');
      this._writable.end();
    });
    this._connHelper = new SmtpConnectionHelper({
      readable, writable,
      commandHandler: this.onClientCommand.bind(this),
      dataHandler: this.onClientData.bind(this)
    });

    this._nextHopConn = {
      socket: nextHopSock,
      parser: new SMTPStream(),
      ready: false,
      closing: false,
      nextHandler: null,
      commandStateStack: [],
      lazyCommand: []
    };

    this._nextHopConn.parser.oncommand = this.onNextHopCommand.bind(this);

    this._nextHopConn.socket.pipe(this._nextHopConn.parser);
    this._connHelper
      .on('close', () => {
        console.error('TP_CONN_HELPER_ON_CLOSE_01');
        this.nextHopSendRaw('QUIT');
      });

    this._connHelper.init();
  }

  public close() {
    if (!this._nextHopConn.closing) {
      this._nextHopConn.socket.end();
    }
    if (this._writable) {
      this._writable.end();
    }
    if (this._writable instanceof net.Socket) {
      const socket: net.Socket = this._writable;
      socket.destroy();
    }
  }

  public errorHandler(e: Error) {
    this._config.errorHandler(this, e);
  }

  public onClientCommand(name: string, payload: string, callback: () => void) {
    const data = payload.substring(name.length + 1);
    this._commandList.push({
      command: name,
      data: data
    });
    this._nextHopConn.commandStateStack.push(name);
    this.nextHopSendRaw(payload, callback);
  }

  private _commandList: IMailCommandItem[] = [];
  public onClientData(dataStream: SMTPServerDataStream, next: (err, message, callback) => void) {
    const mailParser = new Splitter();
    const ctx: IContext = {
      messageId: undefined,
      trackerId: uuid.v4(),
      generatedTracker: null as any
    };
    ctx.generatedTracker = new Promise<any>((trackerResolve) => {
      let trackerReady: boolean = false;
      const trackerReject = (e) => {
        console.error(e);
        trackerResolve(null);
      };
      const mailRewriter = new Rewriter(
        (data) => {
          if (data.root && !trackerReady) {
            const headerKeySet = new Set(data.headers.getList().map(o => o.key));
            const headerList = [...headerKeySet.values()]
              .reduce((list: IDecodedHeaderItem[], cur) => {
                list.push(...data.headers.getDecoded(cur));
                return list;
              }, [] as IDecodedHeaderItem[]);
            const subject = data.headers.getFirst('subject');
            if (subject) {
              try {
                headerList.push({
                  key: '$subject:decoded',
                  value: rfc1342Decode(subject)
                });
              } catch (e) {
                console.warn('[WARN] subject decode failed: ', e);
              }
            }
            ctx.messageId = data.headers.getFirst('message-id');
            if (!ctx.messageId) {
              console.error('[WARN] No message-id');
            }
            try {
              Promise.resolve(this._config.handlerFunction({
                messageId: ctx.messageId as string,
                headers: headerList,
                commands: this._commandList
              }))
                .then(trackerResolve)
                .catch(trackerReject);
            } catch (trackerErr) {
              trackerReject(trackerErr);
            }
            trackerReady = true;
          }
          return (data.type === 'node' && /text\/html/i.test(data.contentType) && (!data.disposition));
        }
      );
      const mailJoiner = new Joiner();
      (new Promise<string>((resolve, reject) => {
        this.nextHopLazySendRaw('DATA', () => {
          this._nextHopConn.nextHandler = ({ code, message }, payload, callback) => {
            callback();
            if (code === '354') {
              const parsed = RESPONSE_354_REGEX.exec(message.toString());
              const endOfData = parsed && parsed[1]
                .replace(/<CR>/g, '\r')
                .replace(/<LF>/g, '\n') ||
                '\r\n.\r\n';
              resolve(endOfData);
            } else {
              reject(new Error('reject code = ' + code));
            }
          };
        });
      }))
        .then((endOfData) => {
          this._nextHopConn.nextHandler = ({code, message}, payload, callback) => {
            next(null, message, callback);
          };

          dataStream
            .pipe(mailParser)
            .pipe(mailRewriter)
            .on('node', (dp) => {
              const parsedContentType = parseContentType(dp.node.headers.getFirst('Content-Type'));
              const charset = parsedContentType && parsedContentType.parameter['charset'] || 'utf8';
              const textDecoder = iconv.getDecoder(charset);
              const textEncoder = iconv.getEncoder(charset);
              let textBuffer: string[] = [];
              ctx.generatedTracker
                .then((generatedTracker) => {
                  dp.decoder
                    .on('data', (data: Buffer) => {
                      if (generatedTracker) {
                        textBuffer.push(textDecoder.write(data));
                      } else {
                        dp.encoder.write(data);
                      }
                    })
                    .on('end', () => {
                      if (generatedTracker) {
                        const html = textBuffer.join(''); textBuffer = null as any;

                        const dom = new JSDOM(html);
                        const body = dom.window.document.querySelector('body') || dom.window.document.querySelector('html');

                        if ('html' in generatedTracker && generatedTracker.html) {
                          const element = dom.window.document.createElement('div');
                          element.innerHTML = generatedTracker.html;
                          (body || dom.window.document).appendChild(element);
                        } else if ('imageSrc' in generatedTracker) {
                          const img = dom.window.document.createElement('img');
                          img.src = generatedTracker.imageSrc;
                          if (generatedTracker.imageAlt) img.alt = generatedTracker.imageAlt;
                          if (generatedTracker.imageStyles) {
                            const styles = generatedTracker.imageStyles;
                            Object.keys(styles)
                              .forEach(k => {
                                img.style[k] = styles[k];
                              });
                          }
                          (body || dom.window.document).appendChild(img);
                        }

                        dp.encoder.write(textEncoder.write(dom.serialize()));
                        const last = textEncoder.end();
                        if (last) {
                          dp.encoder.write(last);
                        }
                      }
                      dp.encoder.end();
                    });
                });
            })
            .pipe(mailJoiner)
            .on('end', () => {
              this._nextHopConn.socket.write(Buffer.from(endOfData));
            })
            .pipe(this._nextHopConn.socket, { end: false });
        });
    });
  }

  private _processNextHopLazyCommand() {
    const item = this._nextHopConn.lazyCommand.shift();
    if (item) {
      this._nextHopConn.commandStateStack.push(item.command);
      this.nextHopSendRaw(item.command, item.handler);
    }
  }

  public nextHopLazySendRaw(command: string, handler: () => void) {
    this._nextHopConn.lazyCommand.push({
      command,
      handler
    });
    if (this._nextHopConn.commandStateStack.length === 0) {
      this._processNextHopLazyCommand();
    }
  }

  public onNextHopCommand(buffer: Buffer, next?: () => void) {
    const payload = buffer.toString();
    const splitpos = payload.indexOf(' ');
    const code = payload.substring(0, splitpos).toUpperCase();
    const message = payload.substring(splitpos + 1);

    this._nextHopConn.commandStateStack.splice(0, 1);

    const callback = () => {
      if (this._nextHopConn.commandStateStack.length === 0) {
        this._processNextHopLazyCommand();
      }
      if (next) {
        next();
      }
    };

    if (!this._nextHopConn.ready) {
      if (code === '220') {
        this._nextHopConn.ready = true;
      } else {
        this.errorHandler(new Error('Unknown startup response: ' + payload));
      }
      callback();
    } else {
      if (this._nextHopConn.nextHandler) {
        const handler = this._nextHopConn.nextHandler;
        this._nextHopConn.nextHandler = null;
        handler({
          code, message
        }, buffer, callback);
        return ;
      }
      this._connHelper.sendRaw(payload, callback);
    }
  }

  public nextHopSendRaw(line: string, callback?: () => void) {
    const payload = line + '\r\n';
    this._nextHopConn.socket.write(Buffer.from(payload), callback);
  }
}

