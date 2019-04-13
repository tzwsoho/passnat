/* eslint-disable indent */

'use strict';

const net = require('net');

const misc = require('../misc/misc.js');
const logger = require('../logger/logger.js');
const encryptor = require('../encryptor/encryptor.js');
const io_reactor = require('../io_reactor/io_reactor.js');

const onData = function (self, data)
{
	while (self.read_bytes + data.length > self.read_buf.length)
	{
		const new_buf = Buffer.allocUnsafe(self.read_buf.length * 2);
		self.read_buf.copy(new_buf);
		self.read_buf = new_buf;
	}

	data.copy(self.read_buf, self.read_bytes);
	self.read_bytes += data.length;

	while (self.read_bytes >= 2)
	{
		const msg_len = self.read_buf.readUInt16LE(0);
		if (msg_len < 2)
		{
			logger.error('Message fatal error, disconnecting...');
			self.close();
			return;
		}

		// packet not complete
		if (msg_len > self.read_bytes)
		{
			break;
		}

		const packet = Buffer.allocUnsafe(msg_len);
		self.read_buf.copy(packet, 0, 0, msg_len);

		encryptor.decrypt(packet, packet.length - 2, 2);
		self.io_reactor.emitter.emit('request', self.io_reactor, self.socket, packet);

		// TODO memory overlap?
		self.read_buf.copy(self.read_buf, 0, msg_len);
		self.read_bytes -= msg_len;

		if (self.read_bytes < 0)
		{
			logger.error('Message length error: offset = %d, msg_len = %d', self.read_bytes, msg_len);
			self.close();
			return;
		}
	}
};

const tcp_connector = function ()
{
	this.id = undefined;
	this.socket = undefined;
	this.io_reactor = new io_reactor();

	this.read_buf = Buffer.allocUnsafe(Buffer.poolSize * 100);
	this.write_buf = Buffer.allocUnsafe(Buffer.poolSize * 100);
	this.read_bytes = 0;
	this.write_bytes = 0;
};

tcp_connector.getID = function (socket)
{
	return socket.localAddress + ':' + socket.localPort;
};

tcp_connector.prototype.start = function (ip, port, handlers, onConnect, onDisconnect, ...args)
{
	const self = this;
	this.io_reactor.config(handlers);
	this.socket = net.connect(port, ip);
	this.socket.setNoDelay(true);
	this.socket.on('connect', () =>
	{
		logger.debug('TCP Client connected to %s:%d!', ip, port);

		self.id = tcp_connector.getID(self.socket);
		if (misc.isFunction(onConnect))
		{
			onConnect(self.id, ...args);
		}
	})
	.on('close', (had_error) =>
	{
		logger.debug('TCP Client closed: had_error = %s', had_error);

		if (misc.isFunction(onDisconnect))
		{
			onDisconnect(self.id, ...args);
		}
	})
	// .on('end', () =>
	// {
	// 	logger.debug('Connection ended!');
	// })
	.on('data', (data) =>
	{
		onData(self, data);
	})
	.on('error', (err) =>
	{
		logger.error('TCP Client error:\n%s', err.stack);
	});
};

tcp_connector.prototype.send = function (msg_id, msg)
{
	msg.id = msg_id;
	return this.io_reactor.response(this.socket, msg);
};

tcp_connector.prototype.stop = function ()
{
	if (this.socket)
	{
		this.socket.destroy();
		this.socket.unref();
		this.socket.end();
	}
};

module.exports = tcp_connector;
