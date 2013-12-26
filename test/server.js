// Note
// 1. This file is only to run the portal test suite and explain how to 
// implement the portal server
// 2. It focuses on readability and explanation more than all and 
// contains some bad parts of JavaScript
// 3. Whereas JavaScript runs in a single thread, it doesn't in many 
// other environments. Mind thread-safety when you implement the server


// Let's create a web server and accept request
var on = {},
	http = require("http"),
	url = require("url"),
	ws = require("ws"),
	send = require("send"),
	wsServer = new ws.Server({noServer: true});

// Deal with static assets
on.asset = function(req, res) {
	// portal.js from / and the rest from /test/webapp/
	var root = __dirname + (/\/portal.js/.test(req.url) ? "/.." : "/webapp");
	send(req, url.parse(req.url).pathname).root(root).pipe(res);
};

// This server accepts request from http://localhost:8090/ 
// and serves static assets only for cross-origin test
http.createServer(on.asset).listen(8090);

// This web server accepts request from http://localhost:8080/
// and serves static assets for same-origin and plays a role of portal server
// The path, /test, is the path where we will implement the portal protocol
http.createServer(function(req, res) {
	if (/\/test/.test(req.url)) {
		on.http(req, res);
	} else {
		on.asset(req, res);
	}
})
.on("upgrade", function(req, socket, head) {
	if (/\/test/.test(req.url)) {
		wsServer.handleUpgrade(req, socket, head, function(ws) {
			// ws is ws.WebSocket similar to W3C WebSocket API
			on.ws(req, ws);
		});
	}
})
.listen(8080);

// From now on, everything is about writing the portal server
// You will see how to handle HTTP request and WebSocket, establish 
// transport and socket and its listener in the end


// Deal with HTTP request
on.http = function(req, res) {
	switch (req.method) {
	// GET method is used to establish and manage HTTP transport
	// The following plain text is typical GET request
	/*
	GET http://localhost:8080/test?when=open&transport=sse&heartbeat=false&lastEventId=0&id=4d6dfa0c-03fe-4193-9898-c96b28f895b2&_=1387121510854 HTTP/1.1
	Host: localhost:8080
	User-Agent: Mozilla/5.0 (Windows NT 6.3; WOW64; rv:25.0) Gecko/20100101 Firefox/25.0
	Accept: text/event-stream
	Accept-Language: en-US,en;q=0.5
	Accept-Encoding: gzip, deflate
	Referer: http://localhost:8080/?module=sse
	Connection: keep-alive
	Pragma: no-cache
	Cache-Control: no-cache
	 */
	case "GET":
		// Request URI is generated by urlBuilder option
		// Here only default behavior is considered
		// See portal.defaults.urlBuilder
		req.params = url.parse(req.url, true).query;
		
		// Set no-cache headers for old browsers
		nocache(req, res);
		// Set cors headers to enable streamxdr and longpollxdr or allow cross-origin request 
		cors(req, res);
		
		switch (req.params.when) {
		// Publish socket establishing HTTP transport
		// This HTTP response, res, is a persistent connection
		case "open":
			switch (req.params.transport) {
			// The server-sent events in HTML5, sse, is just yet another streaming technique
			case "sse":
			case "streamxhr":
			case "streamxdr":
			case "streamiframe":
				on.socket(socket(req.params, transports.stream(req, res)));
				break;
			case "longpollajax":
			case "longpollxdr":
			case "longpolljsonp":
				on.socket(socket(req.params, transports.longpoll(req, res)));
				break;
			default:
				// 501 Not Implemented
				res.statusCode = 501;
				res.end();
			}
			break;
		// Inject new request and response to long polling transport
		// In long polling, multiple request and response consist of a pseudo connection
		case "poll":
			// Certain browsers poll again after a few minutes of close for some reason
			// so check if there is socket first but not sure why it's so
			if (req.params.id in sockets) {
				sockets[req.params.id].transport.refresh(req, res);
			}
			break;
		// Detect disconnection
		// This works only if notifyAbort option is true
		// Since browser can't stop script tag used in longpolljsonp, server should 
		// complete the response on abort request. Otherwise, browser can't send any 
		// request due to restriction in the number of simultaneous connections 
		// specified in the spec. That's why notifyAbort is true in the test suite  
		// See portal.defaults.notifyAbort
		case "abort":
			// According to client and server, transport may detect disconnection or not
			// so check it first
			if (req.params.id in sockets) {
				sockets[req.params.id].close();
			}
			
			// notifyAbort request is done by script tag
			// Set content-type to text/javascript
			res.setHeader("content-type", "text/javascript; charset=utf-8");			
			// Close response
			res.end();
			break;
		default:
			// 501 Not Implemented
			res.statusCode = 501;
			res.end();
		}
		break;

	// POST method is used to emit HTTP transport's message event
	// The following plain text is typical POST request
	// Note that *\/* in Accept field was originally */*
	/*
	POST http://localhost:8080/test HTTP/1.1
	Host: localhost:8080
	User-Agent: Mozilla/5.0 (Windows NT 6.3; WOW64; rv:25.0) Gecko/20100101 Firefox/25.0
	Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*\/*;q=0.8 
	Accept-Language: en-US,en;q=0.5
	Accept-Encoding: gzip, deflate
	Content-Type: text/plain; charset=UTF-8
	Referer: http://localhost:8080/?module=sse
	Content-Length: 105
	Connection: keep-alive
	Pragma: no-cache
	Cache-Control: no-cache
	
	data={"id":10,"socket":"3b8e5bdd-8d59-4679-bc25-53ef563e264d","type":"echo","data":"data9","reply":false} 
	 */
	case "POST":
		// Set no-cache headers for old browsers
		nocache(req, res);
		// Set cors headers to enable streamxdr and longpollxdr or allow cross-origin request 
		cors(req, res);
		
		// Note that request's content type is text/plain not application/x-www-form-urlencoded
		// This is because XDomainRequest doesn't set content type header in a cross-origin connection 
		// so need to read body
		var body = "";
		req.on("data", function(chunk) {
			body += chunk;
		});
		req.on("end", function() {
			// In the above case, body variable is
			// data={"id":10,"socket":"3b8e5bdd-8d59-4679-bc25-53ef563e264d","type":"echo","data":"data9","reply":false}
			
			var // Take the rest after 'data='
				// Its value is generated by outbound option
				// Only default behavior is considered here
				// See portal.defaults.outbound
				text = /^data=(.+)/.exec(body)[1],
				id = /"socket":"([^\"]+)"/.exec(text)[1];
			
			// HTTP Transports are supplied with message event in POST request 
			if (id in sockets) {
				sockets[id].transport.emit("message", text);
			} else {
				// 500 Internal Server Error
				res.statusCode = 500;
			}
			// Close response
			res.end();
		});
		break;
	default:
		// 405 Method Not Allowed
		res.statusCode = 405;
		res.end();
	}
	
	function nocache(req, res) {
		// Precautions for old browsers
		res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
		res.setHeader("pragma", "no-cache");
		res.setHeader("expires", "0");
	}
	
	function cors(req, res) {
		// Applies to streamxdr and longpollxdr
		// Access-Control-Allow-Origin header should be either * or the value of the Origin request header
		// Note that these transport need this header even in same-origin connection 
		res.setHeader("access-control-allow-origin", req.headers.origin || "*");
		
		// Do if you want
		res.setHeader("access-control-allow-credentials", "true");
		if (req.headers["access-control-request-headers"]) {
			res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"]);
		}
	}
};

// Deal with WebSocket
// ws is opened WebSocket and its readyState is WebSocket.OPEN(1)
on.ws = function(req, ws) {
	// Publish socket establishing WebSocket transport
	// Simple, isn't it?
	on.socket(socket(url.parse(req.url, true).query, transports.ws(ws)));
};


// Transport provides an unified view of frame-based connection
// It is an EventEmitter and handles message and close event
var transports = {},
	events = require("events");

// WebSocket
// ws: WebSocket
transports.ws = function(ws) {
	var transport = new events.EventEmitter();
	
	// Delegate ws' event to transport
	ws.onclose = function() {
		transport.emit("close");
	};
	ws.onmessage = function(event) {
		transport.emit("message", event.data);
	};
	
	// Delegate transport's behavior to ws
	transport.send = function(data) {
		ws.send(data);
	};
	transport.close = function() {
		ws.close();
	};
	
	return transport;
};

// HTTP Streaming
// sse: Server-Sent Events
// streamxhr: XMLHttpRequest streaming
// streamxdr: XDomainRequest streaming
// streamiframe: Hidden Iframe streaming
transports.stream = function(req, res) {
	var // Prepare 2KB text for padding
		text2KB = Array(2048).join(" "),
		isAndroidLowerThan3 = /Android [23]./.test(req.headers["user-agent"]),
		transport = new events.EventEmitter();
	
	// The content-type headers should be 'text/event-stream' for sse and 'text/plain' for others
	// in fact 'text/plain' is required by streamiframe to prevent iframe tag from parsing response as HTML
	res.setHeader("content-type", "text/" + (req.params.transport === "sse" ? "event-stream" : "plain") + "; charset=utf-8");
	
	// Applies to: sse
	// The response should be encoded in utf-8 format
	// utf8 is default encoding in Node.js wisely
	
	// Applies to: streamxdr
	// Access-Control-Allow-Origin header should be either * or the value of the Origin request header
	// Done in on.http.GET
	
	// Applies to: streamxdr, streamiframe, streamxhr in Android browser lower than 3 
	// The padding is required, which makes the client-side transport be aware of change of the response
	// It should be greater than 1KB (4KB for Android browser lower than 3), be composed of white space 
	// character and end with \r, \n or \r\n. The client socket fires the open event when noticing padding
	res.write((isAndroidLowerThan3 ? text2KB : "") + text2KB + "\n");
	
	// This callback will be executed when either client or server closes transport
	function onclose() {
		transport.emit("close");
	}
	res.on("close", onclose);
	res.on("finish", onclose);
	
	transport.send = function(data) {
		// The response text should be formatted in the event stream format
		// See http://dev.w3.org/html5/eventsource/#parsing-an-event-stream
		// This is a requirement of sse, but the rest also accept that format for convenience
		// Though the interpretation of the format depends on streamParser option
		// See portal.defaults.streamParser
		var payload =
			// Android browser lower than 3 need 4KB padding at the top of each event
			(isAndroidLowerThan3 ? text2KB + text2KB : "") +
			// Break data up by \r, \n, or \r\n, append 'data: ' to the beginning of each line 
			data.split(/\r\n|[\r\n]/).map(function(chunk) {
				return "data: " + chunk + "\n";
			})
			.join("") +
			// Print \n to mark the end of a single data
			"\n";
		
		// Just to be sure, don't be confused with the chunked transfer encoding
		// It's the web server's business
		res.write(payload);
	};
	transport.close = function() {
		res.end();
	};
	
	return transport;
};


// HTTP Long polling
// longpollajax: AJAX long polling
// longpollxdr: XDomainRequest long polling
// longpolljsonp: JSONP long polling
transports.longpoll = function(req, res) {
	var // Current response 
		response,
		// Whether the current response has ended or not
		ended,
		// Whether data is written on the current response or not
		// if this is true, then 'ended' must be true but not vice versa
		written,
		// Close timer to prevent idle connection
		closeTimer,
		// Parameters of first request
		params = req.params,
		// Cached data for client that missed some data
		// It is optional unless the server sends data continuosly
		buffer = [],
		transport = new events.EventEmitter();
	
	// Expose this refresh method to re-use by on.http.GET.poll
	transport.refresh = function(req, res) {
		// The content-type header should be 'text/javascript' for longpolljsonp and 'text/plain' for the others
		// Note that the first request's params is used
		res.setHeader("content-type", "text/" + (params.transport === "longpolljsonp" ? "javascript" : "plain") + "; charset=utf-8");

		// Applies to: longpollxdr
		// Access-Control-Allow-Origin header should be either * or the value of the Origin request header
		// Done in on.http.GET:

		// This callback will be executed when either client or server closes transport
		function onclose() {
			// The current response's life ends
			// But this has nothing to do with 'written' 
			ended = true;
			
			// If the server didn't write anything, completion of this response should be regarded 
			// as the end of a connection. So, the client socket fires the close event if the response 
			// is empty and poll if not
			if (req.params.when === "poll" && !written) {
				transport.emit("close");
			}

			// Set a timer to fire close event between polls
			// If the client disconnects connection during dispatching event,
			// this connection will remain in limbo without the timer
			closeTimer = setTimeout(function() {
				transport.emit("close");
			}, 500);
		}
		res.on("finish", onclose);
		res.on("close", onclose);
		
		// The first request's 'when' parameter is 'open' and that of next request is 'poll'
		if (req.params.when === "open") {
			// The request should be completed immediately. The purpose of this is to tell 
			// the browser that the server is alive. The client socket fires the open event 
			// when the first request completes normally
			res.end();
		} else {
			// Reset the response, flags, timers as new request and response is supplied
			response = res;
			ended = written = false;
			clearTimeout(closeTimer);
			
			// Remove client-received events from buffer
			// Id of an event client-received is attached to lastEventIds parameter in the form 
			// of Comma-separated values (CSV)
			if (req.params.lastEventIds) {
				// Parse CSV to array
				req.params.lastEventIds.split(",").forEach(function(eventId) {
					buffer.forEach(function(message) {
						// Remove this message from buffer if client read it
						if (eventId === /"id":"([^\"]+)"/.exec(message)[1]) {
							// Same with buffer.remove(message)
							buffer.splice(buffer.indexOf(message), 1);
						}
					});
				});
			}
			
			// If there are cached data in buffer, flushes them in the form of JSON array
			if (buffer.length) {
				// This is not same with JSON.stringify(buffer). Elements in buffer are 
				// already JSON string
				transport.send("[" + buffer.join(",") + "]");
			}
		}
	};
	// We only defines the method. Execute it with the given first request and response
	transport.refresh(req, res);
	
	transport.send = function(data) {
		// Cache data if it's not sent from buffer
		// By default 'data' starts with { since it is generated by JSON.stringify
		// But it depends on inbound option
		// See portal.defaults.inbound
		if (!/^\[/.test(data)) {
			buffer.push(data);
		}
		
		// Only when the current response is not ended, it's possible to send
		// If the current response is ended, the data will be cached and sent in 
		// flushing buffer in next poll. This is the reason why the buffer is needed
		if (!ended) {
			// Flag the current response ends with data
			// The 'ended' will be true after response.end(payload)
			written = true;
			
			var payload =
				// In case of longpolljsonp, the response text is a JavaScript code snippet 
				// executing a given callback with data. The callback name is passed as the 
				// first request's callback parameter and the data should be escaped to 
				// a JavaScript string literal.
				// Note that the first request's params is used
				params.transport === "longpolljsonp" ? params.callback + "(" + JSON.stringify(data) + ");" :
				// For others, no formatting is needed
				data;

			// All the long polling transports has to finish the request after processing
			response.end(payload);
		}
	};
	transport.close = function() {
		// End response if possible
		if (!ended) {
			response.end();
		}
	};
	
	return transport;
};


// Socket provides an unified view of event-based connection 
// for the portal application developer. It is an EventEmitter 
// and a counterpart of client socket though there is API difference
var socket,
	sockets = {},
	uuid = require("node-uuid");

socket = function(params, transport) {
	var socket = new events.EventEmitter();
	
	// For HTTP transport
	// Used in on.http.GET.poll and on.http.POST
	socket.transport = transport;
	
	// If the underlying transport is closed
	transport.on("close", function() {
		// Delete the socket from the repository
		delete sockets[params.id];
		// Fires the close event to the socket
		socket.emit("close");
	});
	// If the underlying transport receives a message
	transport.on("message", function(data) {
		var // The latch prevents double reply 
			latch,
			// Convert JSON string into event object
			// By default client encodes data in JSON
			// See portal.defaults.outbound
			event = JSON.parse(data);
		
		// Fires it
		socket.emit(
			// Event type
			event.type, 
			// Event data
			event.data, 
			// If the event.reply is true, some measure should be available to return data to client 
			// This support enables to use socket.send(type, data, done, fail) signature in client
			!event.reply ? null : {
			done: function(result) {
				if (!latch) {
					// Prevents double reply
					latch = true;
					
					// Just send the reply event
					// The client's done callback whose event id is 'event.id' will be executed 
					// with 'result' since 'exception' is false
					socket.send("reply", {id: event.id, data: result, exception: false});
				}
			},
			fail: function(result) {
				if (!latch) {
					// Prevents double reply
					latch = true;
					
					// Just send the reply event
					// The client's fail callback whose event id is 'event.id' will be executed 
					// with 'result' since 'exception' is true
					socket.send("reply", {id: event.id, data: result, exception: true});
				}
			}
		});
	});
	
	// A map for reply callbacks
	socket.callbacks = {};
	socket.send = function(type, data, callback) {
		// If the event.reply is true, client will handle it as we did in the previous
		var event = {id: uuid.v4(), type: type, data: data, reply: !!callback};
		
		if (event.reply) {
			// This callback will be executed as reply by client
			// Now portal.js support only a single type of callback 
			// unlike socket.send in portal.js
			socket.callbacks[event.id] = callback;
		}
		
		// Convert event object to JSON string
		// By default client decodes event in JSON
		// See portal.defaults.inbound
		transport.send(JSON.stringify(event));
	};
	socket.close = function() {
		transport.close();
	};
	
	// Register the socket to the repository
	sockets[params.id] = socket;
	
	// Handle the rest of reply by client in the reply event
	socket.on("reply", function(reply) {
		if (reply.id in socket.callbacks) {
			// Execute the stored callback with data and delete it
			socket.callbacks[reply.id].call(socket, reply.data);
			delete socket.callbacks[reply.id];
		}
	});
	
	// If heartbeat param is not 'false' and is a number
	// FYI +'false' gives NaN and +'5000' gives 5000
	if (+params.heartbeat) {
		var heartbeatTimer; 
		
		// Set a heartbeat timer to close the socket after the heartbeat interval
		setHeartbeatTimer();
		// Client will send the heartbaet event periodically
		socket.on("heartbeat", function() {
			// Cancel the timer
			clearTimeout(heartbeatTimer);
			// Set the timer again
			setHeartbeatTimer();
			// As a response, send the heartbeat event
			socket.send("heartbeat");
		});
		
		function setHeartbeatTimer() {
			// +params.heartbeat is number
			heartbeatTimer = setTimeout(function() {
				socket.close();
			}, +params.heartbeat);
		}
		
		// Client will start to heartbeat on its open event first so just wait
	}
	
	return socket;
};


// Yay! 
// It's time to write the socket handler as an end-user
on.socket = function(socket) {
	socket.on("echo", function(data) {
		socket.send("echo", data);
	})
	.on("disconnect", function() {
		var self = this;
		setTimeout(function() {
			self.close();
		}, 100);
	})
	.on("reply-by-server", function(flag, reply) {
		reply[flag ? "done" : "fail"](flag);
	})
	.on("reply-by-client", function() {
		socket.send("reply-by-client", 1, function(type) {
			socket.send(type);
		});
	});
};