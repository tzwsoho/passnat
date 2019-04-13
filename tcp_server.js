/* eslint-disable indent */

'use strict';

const net = require('net');

const misc = require('../misc/misc.js');
const logger = require('../logger/logger.js');
const encryptor = require('../encryptor/encryptor.js');
const io_reactor = require('../io_reactor/io_reactor.js');

const getID = function (socket)
{
	return socket.remoteAddress + ':' + socket.remotePort;
};

const disconnect = function (self, conn)
{
	const c = self.all_connections[conn];
	if (misc.isUndefined(c) ||
		misc.isUndefined(c.s))
	{
		return false;
	}

	const s = c.s;
	s.destroy();
	s.end();
	s.unref();
};

const remove_socket = function (self, conn)
{
	const c = self.all_connections[conn];
	if (misc.isUndefined(c) ||
		misc.isUndefined(c.s) ||
		misc.isUndefined(c.rb) ||
		misc.isUndefined(c.wb) ||
		misc.isUndefined(c.ro) ||
		misc.isUndefined(c.wo))
	{
		return false;
	}

	delete self.all_connections[conn].s;
	delete self.all_connections[conn].rb;
	delete self.all_connections[conn].wb;
	delete self.all_connections[conn].ro;
	delete self.all_connections[conn].wo;
	delete self.all_connections[conn];
	return true;
};

const onData = function (self, socket, data)
{
	const conn = getID(socket);
	const c = self.all_connections[conn];
	if (misc.isUndefined(c))
	{
		return;
	}

	// logger.debug('Received %d bytes from %s', data.length, conn);

	while (c.ro + data.length > c.rb.length)
	{
		const new_buf = Buffer.allocUnsafe(c.rb.length * 2);
		c.rb.copy(new_buf);
		c.rb = new_buf;
	}

	data.copy(c.rb, c.ro);
	c.ro += data.length;

	while (c.ro >= 2)
	{
		const msg_len = c.rb.readUInt16LE(0);
		if (msg_len < 2)
		{
			logger.error('Message fatal error, disconnecting %s...', conn);
			disconnect(self, conn);
			return;
		}

		// packet not complete
		if (msg_len > c.ro)
		{
			break;
		}

		const packet = Buffer.allocUnsafe(msg_len);
		c.rb.copy(packet, 0, 0, msg_len);

		encryptor.decrypt(packet, packet.length - 2, 2);
		self.io_reactor.emitter.emit('request', self.io_reactor, conn, packet);

		// TODO memory overlap?
		c.rb.copy(c.rb, 0, msg_len);
		c.ro -= msg_len;

		if (c.ro < 0)
		{
			logger.error('Message length error: offset = %d, msg_len = %d', c.ro, msg_len);
			disconnect(self, conn);
		}
	}
};

const tcp_server = function ()
{
	this.listener = null;
	this.all_connections = {};
	this.io_reactor = new io_reactor();
};

tcp_server.getID = getID;
tcp_server.getInterface = function ()
{
	const ifs = require('os').networkInterfaces();
	for (let dev in ifs)
	{
		const ifc = ifs[dev];
		for (let i = 0; i < ifc.length; i++)
		{
			const alias = ifc[i];
			if ('IPv4' === alias.family &&
				'127.0.0.1' !== alias.address &&
				!alias.internal)
			{
				return alias;
			}  
		}
	}
};

tcp_server.prototype.start = function (port, handlers, onConnect, onDisconnect)
{
	this.io_reactor.config(handlers);

	const self = this;
	this.listener = net.createServer();
	this.listener.on('error', (err) =>
	{
		logger.error('TCP Server Listen error:\n%s', err.stack);
	})
	.on('connection', (socket) =>
	{
		socket.setNoDelay(true);
		// socket.setMaxListeners(0);

		const conn = getID(socket);
		logger.info('%s connected.', conn);

		self.all_connections[conn] = {};
		self.all_connections[conn].s = socket;
		self.all_connections[conn].rb = Buffer.allocUnsafe(Buffer.poolSize * 100);
		self.all_connections[conn].wb = Buffer.allocUnsafe(Buffer.poolSize * 100);
		self.all_connections[conn].ro = 0;
		self.all_connections[conn].wo = 0;

		if (misc.isFunction(onConnect))
		{
			onConnect(conn);
		}

		socket.on('data', (data) =>
		{
			onData(self, socket, data);
		})
		.on('timeout', () =>
		{
			logger.warn('%s timeout!', conn);

			disconnect(self, conn);
			remove_socket(self, conn);
		})
		.on('drain', () =>
		{
			// logger.warn('%s drain!', conn);
			socket.resume();
		})
		.on('error', (err) =>
		{
			if ('ECONNRESET' != err.code &&
				'ECONNREFUSED' != err.code &&
				'EHOSTUNREACH' != err.code &&
				'ETIMEDOUT' != err.code)
			{
				logger.error('TCP server error happend:\n%s', err.stack);
			}

			// disconnect(self, conn);
			// remove_socket(self, conn);
		})
		.on('close', (had_error) =>
		{
			if (misc.isFunction(onDisconnect))
			{
				onDisconnect(conn);
			}

			logger.debug('%s closed: had_error = %s', conn, had_error);

			disconnect(self, conn);
			remove_socket(self, conn);
		});
	})
	.close(() =>
	{
		self.listener.listen(port, '0.0.0.0', 511, () =>
		{
			logger.debug('TCP Server Listening on 0.0.0.0:%d...', port);
		});
	});
};

tcp_server.prototype.send = function (conn, id, msg)
{
	const socket = this.getSocket(conn);
	if (misc.isUndefined(socket))
	{
		return false;
	}

	msg.id = id;
	return this.io_reactor.response(socket, msg);
};

tcp_server.prototype.broadcast = function (msg_id, msg)
{
	msg.id = msg_id;
	for (let conn in this.all_connections)
	{
		if (this.all_connections[conn].s)
		{
			this.io_reactor.response(this.all_connections[conn].s, msg);
		}
	}
};

tcp_server.prototype.getSocket = function (conn)
{
	if (!this.all_connections[conn] ||
		!this.all_connections[conn].s)
	{
		return undefined;
	}

	return this.all_connections[conn].s;
};

tcp_server.prototype.closeConnection = function (conn)
{
	disconnect(this, conn);
};

tcp_server.prototype.stop = function ()
{
	if (misc.isNull(this.listener))
	{
		return;
	}

	this.listener.close();

	for (var f in this.all_connections)
	{
		disconnect(this, f);
	}
};

module.exports = tcp_server;
