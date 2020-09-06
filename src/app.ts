import * as net from 'net';
import getopts from 'node-getopt';
import axios from 'axios';

import {
  HandlerType, IGeneratedMailTracker, IMailInformation
} from './handler';
import {
  ClientPair, IAppConfig
} from './client-pair';

const opts = getopts.create([
  ['', 'mode=spawned|socket', '', 'listen'],
  ['', 'listen-port=PORT'   , '', '10025'],
  ['', 'next-hop=HOST:PORT' , ''],
  ['', 'next-hop-host=HOST' , ''],
  ['', 'next-hop-port=PORT' , ''],
  ['', 'handler-file=PATH'  , ''],
  ['', 'handler-url=URL'    , ''],
  ['h' , 'help'             , 'display this help'],
]);

opts.bindHelp();

const parsedOptions = opts.parseSystem();

/**
 * APP_MODE
 * - socket  : listen tcp port
 * - spawned : use stdin/stdout
 */
const APP_MODE = parsedOptions.options['mode'] as string;

const LISTEN_PORT = parseInt(parsedOptions.options['listen-port'] as string);
const [ NEXT_HOP_HOST, NEXT_HOP_PORT ] = ((): [string, number] => {
  if (parsedOptions.options['next-hop']) {
    const a = parsedOptions.options['next-hop'] as string;
    const pos = a.lastIndexOf(':');
    const host = a.substring(0, pos);
    const port = a.substring(pos + 1);
    return [ host, parseInt(port) ];
  }
  return [ parsedOptions.options['next-hop-host'] as string, parseInt(parsedOptions.options['next-hop-port'] as string) ];
})();

const HANDLER_FILE = parsedOptions.options['handler-file'] as string | undefined;
const HANDLER_URL  = parsedOptions.options['handler-url'] as string;

function urlHandler(info: IMailInformation): Promise<IGeneratedMailTracker> {
  return axios.post(HANDLER_URL, info)
    .then(res => res.data);
}

const handlerFunction: HandlerType =
  HANDLER_FILE ? (() => {
    const module = require(HANDLER_FILE);
    return (module.default || module) as HandlerType;
  })() : urlHandler;

const appConfig: IAppConfig = {
  handlerFunction: handlerFunction,
  nexthopHost: NEXT_HOP_HOST,
  nexthopPort: NEXT_HOP_PORT,
  errorHandler: (clientPair, e) => {
    console.error(e);
    clientPair.close();
    if (APP_MODE === 'spawned') {
      process.exit(1);
    }
  }
};

if (APP_MODE === 'socket') {
  const server = net.createServer();
  server.on('connection', (socket) => {
    const client = new ClientPair(appConfig, socket, socket);
    socket.on('close', (hadError: boolean) => {
      // TODO: DO NOT CLOSE (LAZY CLOSE)
      client.close();
    });
    socket.on('error', (e: Error) => {
      client.errorHandler(e);
    });
  });
  server.listen(LISTEN_PORT);
} else if (APP_MODE === 'spawned') {
  const client = new ClientPair(appConfig, process.stdin, process.stdout);
} else {
  console.error(`Unknown APP_MODE: ${APP_MODE}`);
  process.exit(1);
}
