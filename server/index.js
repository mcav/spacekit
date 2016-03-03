'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocketServer = require('ws').Server;

const createTlsProxyServer = require('./tls-proxy-server');
const DynamicDNS = require('./dynamic-dns');
const WebSocketRelay = require('./web-socket-relay');

/**
 * The SpaceKitServer listens for TLS connections.
 *
 * If the hostname of the incoming connection is the hostname of SpaceKitServer,
 * we will handle the request ourselves. A WebSocket is a connection from a
 * client relay; an HTTP request goes to the API.
 *
 * Otherwise, we will transparently proxy that connection to one of the
 * connected client relays serving the requested hostname (if available).
 *
 * If configured, SpaceKitServer will update DNS records for incoming client
 * relays to point to their dynamic IP.
 */
class SpaceKitServer {

  constructor (argv) {
    this.relays = new Map(); // hostname -> WebSocketRelay
    this.argv = argv;

    // Listen for any incoming TLS connections.
    createTlsProxyServer(this.handleTlsConnection.bind(this)).listen(argv.port);

    // An HTTPS server will handle our API requests (and WebSocket upgrades).
    // Note: This server doesn't actually listen for requests; we hand it
    // established connections from the TLS proxy handler.
    this.httpsServer = https.createServer({
      key: fs.readFileSync(argv.key),
      cert: fs.readFileSync(argv.cert)
    });
    const wss = new WebSocketServer({ server: this.httpsServer });
    wss.on('connection', this.handleWebSocketConnection.bind(this));
    wss.on('headers', (headers) => {
      headers['Access-Control-Allow-Origin'] = '*';
    });

    function requestToString (req) {
      let lines = [];
      lines.push(`GET ${req.url} HTTP/1.0`);
      for (var i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
      }
      lines.push('');
      return lines.join('\r\n');
    }

    var proxy = http.createServer((req, res) => {
      let socket = req.socket;
      let head = requestToString(req);
      if (!req.url.startsWith('/.well-known/acme-challenge/')) {
        socket.write('HTTP/1.0 400\r\n\r\nnot supported');
        socket.end();
      } else {
        let hostname = req.headers['host'];
        let relay = this.relays.get(hostname);
        if (relay) {
          relay.addSocket(socket, hostname, 80);
          socket.emit('data', new Buffer(head, 'ascii'));
        } else {
          res.writeHead(500, 'no relays');
          res.end();
        }
      }
    });
    proxy.listen(80);

    // Configure the DNS updater, if applicable.
    if (argv.dnsZone) {
      this.dynamicDNS = new DynamicDNS(argv.dnsZone);
    }
  }

  /**
   * Handle a connection that needs to be forwarded to `hostname`.
   *
   * If this connection's hostname is SpaceKitServer's, we forward the request
   * to our own HTTPS server.
   *
   * Otherwise, pass the connection onto a client relay for that hostname,
   * if one is available.
   */
  handleTlsConnection (socket, hostname) {
    if (hostname === this.argv.hostname) {
      this.httpsServer.emit('connection', socket);
    } else {
      let relay = this.relays.get(hostname);
      if (relay) {
        relay.addSocket(socket, hostname);
      } else {
        socket.end();
      }
    }
  }

  /**
   * Handle an incoming connection from a client relay.
   *
   * The webSocket here will send events to any TLS sockets it is associated
   * with. (That magic happens in WebSocketRelay.)
   *
   * If we're configured to update DNS, do so now.
   */
  handleWebSocketConnection (webSocket) {
    let hostname = webSocket.upgradeReq.headers['x-spacekit-host'];
    let relay = new WebSocketRelay(webSocket);

    let existingRelay = this.relays.get(hostname);
    if (existingRelay) {
      existingRelay.webSocket.close(1001 /* 'going away' */);
    }

    this.relays.set(hostname, relay);
    webSocket.on('close', () => {
      this.relays.delete(hostname);
    });

    if (this.dynamicDNS) {
      this.dynamicDNS.pointHostnameToIp(
        hostname, webSocket._socket.localAddress);
    }
  }
}

module.exports = SpaceKitServer;

if (require.main === module) {
  const argv = require('yargs')
    .usage('Usage: npm run server -- --hostname HOSTNAME --key KEY.pem --cert CERT.pem')
    .help('h')
    .options('dnsZone', {
      describe: 'the AWS Hosted Zone ID, for dynamic DNS'
    })
    .options('port', {
      describe: 'the port to listen on',
      default: 443
    })
    .options('hostname', {
      describe: 'the hostname of this server, e.g. "api.spacekit.io"',
      demand: true
    })
    .options('key', {
      describe: 'the path to the TLS private key for this hostname',
      demand: true
    })
    .options('cert', {
      describe: 'the path to the TLS certificate for this hostname',
      demand: true
    })
    .argv;
  module.exports.instance = new SpaceKitServer(argv);
}
