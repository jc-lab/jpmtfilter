declare module 'mailsplit' {
  import { PassThrough, Transform } from 'stream';

  export interface IHeaderItem {
    /**
     * lower-case key
     */
    key: string;
    /**
     * line (including key)
     */
    line: string;
  }

  export interface IDecodedHeaderItem {
    key: string;
    value: string;
  }

  export class Headers {
    public changed: boolean;
    public headers: Buffer;
    public parsed: boolean;
    public lines: any[];
    public mbox: boolean;
    public http: boolean;
    public libmime: any;

    constructor(headers, config);
    hasHeader(key: string): boolean;
    get(key: string): string[] | undefined;
    getDecoded(key: string): IDecodedHeaderItem[];
    getFirst(key: string): string | undefined;
    getList(): IHeaderItem[];
    add(key: string, value: string, index: number);
    addFormatted(key: string, line, index);
    remove(key: string): void;
    update(key: string, value: string, relativeIndex): void;
    build(lineEnd): Buffer;
  }

  export class MimeNode {
    public readonly type: string;
    public readonly root: boolean;
    public readonly parentNode: MimeNode | false;

    public readonly multipart: boolean;
    public readonly encoding: boolean;
    public readonly headers: Headers;
    public readonly contentType: string;
    public readonly flowed: boolean;
    public readonly rfc822: boolean;
    public readonly delSp: boolean;

    public readonly disposition: string;
    public readonly filename: string;

    public config: any;
    public libmime: any;

    public parentPartNumber: string[];
    public childPartNumbers: number;
    public readonly partNr: number[];

    getHeaders(): Buffer;
    setContentType(contentType: string): void;
    setCharset(charset: string): void;
    setFilename(filename: string): void;
    getDecoder(): any;
    getEncoder(encoding: string): any;
  }

  export class Splitter extends Transform {

  }
  export class Joiner extends Transform {

  }
  export class Rewriter extends Transform {
    constructor(filterFunc: (data: MimeNode) => boolean);
    processIncoming(data: Buffer, callback);
    createDecodePair(node);
    on(event: string, callback: (any: any) => void): this;
    on(event: 'node', listener: (decoder: {
      node: MimeNode,
      decoder: PassThrough,
      encoder: PassThrough
    }) => void): this;
  }

  export class Streamer extends Transform {
    constructor(filterFunc, streamAction);
  }
}
