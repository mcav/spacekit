'use strict';

const WebSocket = require('ws');
const net = require('net');
const backoff = require('backoff');

/**
 * A SpaceKitRelay proxies data between a SpaceKitServer and local servers.
 * Only TLS traffic is proxied; each app server must serve its own certificate.
 * (The SpaceKitServer does allow ACME (LetsEncrypt) traffic through.)
 *
 *     [SpaceKitServer] <------ws-------- [SpaceKitRelay]
 *             |            internet          /   \
 *             |                             /     \
 *          client                       tls-app  tls-app
 */
class SpaceKitRelay {
  constructor (argv) {
    this.argv = argv;
    this.url = `wss://${argv.endpoint}/`;

    this.outgoingSockets = new Map();

    this.backoff = backoff.fibonacci({
      randomisationFactor: 0.4,
      initialDelay: 1000,
      maxDelay: 5 * 60000
    });
    this.backoff.on('backoff', (number, delay) => {
      console.log(`Reconnecting in ${delay}ms.\n`);
    });
    this.backoff.on('ready', this.connect.bind(this));
    this.connect();
  }

  connect () {
    console.log(`Connecting to ${this.url}...`);
    this.ws = new WebSocket(this.url, 'spacekit', {
      headers: { 'x-spacekit-host': this.argv.hostname }
    });
    this.ws.on('open', () => {
      console.log(`Connected!`);
      this.backoff.reset();
    });
    let currentMessageHeader = null;
    this.ws.on('message', (data) => {
      if (!currentMessageHeader) {
        currentMessageHeader = JSON.parse(data);
      } else {
        this.handleMessage(currentMessageHeader, data);
        currentMessageHeader = null;
      }
    });
    this.ws.on('close', () => {
      console.log(`Lost connection to server.`);
      this.backoff.backoff();
    });
    this.ws.on('error', () => {
      console.log(`Failed to connect to server.`);
      this.backoff.backoff();
    });
  }

  sendMessage (header, body) {
    if (this.ws.readyState === WebSocket.OPEN) {
      console.log('SEND', header, body && body.length);
      this.ws.send(JSON.stringify(header));
      this.ws.send(body || new Buffer(0));
    }
  }

  handleMessage (header, body) {
    let id = header.connectionId;
    let socket = this.outgoingSockets.get(id);
    console.log('msg', JSON.stringify(header));

    if (header.type === 'open') {
      socket = net.connect(header.port);
      this.outgoingSockets.set(id, socket);
      socket.on('data', (data) => {
        this.sendMessage({
          connectionId: id,
          type: 'data'
        }, data);
      });
      socket.on('close', () => {
        this.sendMessage({
          connectionId: id,
          type: 'close'
        }, null);
      });
      socket.on('error', () => {
        this.sendMessage({
          connectionId: id,
          type: 'close'
        }, null);
      });
    } else if (header.type === 'data') {
      socket.write(body);
    } else if (header.type === 'close') {
      socket.end();
      this.outgoingSockets.delete(id);
    }
  }
}

module.exports = SpaceKitRelay;
