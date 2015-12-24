var request = require('request');
var util = require('util');
var chalk = require('chalk');
var circular = require('circular');

var kSystemHostname = require('os').hostname();
var kEnvironmentName = process.env.NODE_ENV || 'dev';
var opts = null;

function Transaction(type, parent) {
  this.id = require('uuid').v4();
  this.type = type;
  this.parent = parent || null;
  this._startTime = new Date().getTime();

  // support for passing in the parent transaction directly rather than needing the ID
  if (typeof (this.parent) === 'object' && this.parent != null) {
    if (typeof (this.parent.id) !== 'undefined') {
      this.parent = this.parent.id;
    }
  }
}

Transaction.prototype.setData = function setData(data) {
  this.data = data;
};

Transaction.prototype.end = function end() {
  var endTime = new Date().getTime();

  this.time = endTime - this._startTime;
  delete this._startTime;

  logger.trace(this);
};

Transaction.prototype.write = function write(level, data) {
  data.transaction = this.id;

  logger.write(level, data);
};

Transaction.prototype.factory = function factory(type, parent) {
  return new Transaction(type, parent);
};

Transaction.prototype.promise = function transactionPromise(promise) {
  var transaction = this;
  return promise.then(function() {
    transaction.end();
  }).catch(function(err) {
    transaction.write(err.level || 'error', {
      exception: err,
    });
    throw err; // throw it back
  });
};

function prettyStack(stack) {
  var lines = stack.split('\n');
  lines.shift();

  return lines.map(function(line) {
    return line.indexOf('/node_modules/') > -1 || line.indexOf('(native)') > -1 ? chalk.black(line) : chalk.gray(line);
  }).join('\n');
}

// method to write directly to the console for local logging
function writeLocal(level, data) {
  if (level === 'error') {
    console.error(chalk.red(util.inspect(data)));
  }  else if (level === 'warning') {
    console.error(chalk.yellow(util.inspect(data)));
  }  else if (level === 'info') {
    console.log(chalk.cyan(util.inspect(data)));
  }  else {
    console.log(chalk.white(util.inspect(data)));
  }

  if (data && data.stack) {
    console.log(prettyStack(data.stack));
  } else if (data && data.exception && data.exception.stack) {
    console.log(prettyStack(data.exception.stack));
  }
}

// method to attach constants to every trace and write
var formatData = function(data) {
  var dataOut = {};

  // basic clone of data so we don't attach system and hostname to original obj
  for (var k in data) {
    dataOut[k] = data[k];
  }

  dataOut.timestamp = new Date().toString();
  dataOut.system = opts.sysIdent;
  dataOut.hostname = kSystemHostname;
  dataOut.env = kEnvironmentName;

  return dataOut;
};

var logger = {
  init: function(sysIdent, base, key) {
    opts = {
      sysIdent: sysIdent,
      base: base,
      key: key,
    };
  },

  setWriteLocalEnabled: function(bool) {
    opts.writeLocal = bool || false;
  },

  setTraceLocalEnabled: function(bool) {
    opts.traceLocal = bool || false;
  },

  write: function(level, data, done) {
    if (!opts) return;

    var obj = {
      level: level,
      data: data,
    };

    if (data.transaction) {
      obj.transaction = data.transaction;
    }

    obj = formatData(obj);

    if (opts.writeLocal) writeLocal(level, obj);

    logger.commit('log', obj, done);
  },

  trace: function(transaction) {
    if (!opts) return;

    transaction = formatData(transaction);

    logger.commit('transaction', transaction);

    if (opts.traceLocal) writeLocal('trace', transaction);
  },

  commit: function(type, obj, done) {
    request({
      url: opts.base + '/' + type + '?key=' + opts.key,
      method: 'POST',
      body: JSON.stringify(obj, circular()),
      headers: {
        'content-type': 'application/json',
      },
    }, function(err/*, response, data*/) {
      if (done) done(err);
    });
  },

  createTransaction: function(type, parent) {
    return new Transaction(type, parent);
  },

  express: function(req, res, next) {
    var parentTransactionID = null;
    if (req.headers['x-parent-transaction']) {
      parentTransactionID = req.headers['x-parent-transaction'];
    }

    req.transaction = logger.createTransaction('express', parentTransactionID);

    req.logger = {
      write: function(level, data) {
        var object = {};

        // basic clone of data so we don't attach these props to the obj
        for (var k in data) {
          object[k] = data[k];
        }

        req.transaction.write(level, object);
      },
    };

    res.on('finish', function() {
      req.transaction.setData({
        request: {
          route: (req.route) ? req.route.path : '',
          method: req.method,
          url: req.url,
          headers: req.headers,
          params: req.params,
          query: req.query,
          body: req.body,
        },
        response: {
          status: res.statusCode,
        },
      });

      req.transaction.end();
    });

    next();
  },

  rabbitr: function(message, next) {
    var _ack = message.ack;
    var _reject = message.reject;
    var _send = message.send;
    var _rpcExec = message.rpcExec;

    var transaction = logger.createTransaction('Rabbitr', message.data._parentTransaction);
    message.transaction = transaction;
    delete message.data._parentTransaction;
    message.logger = {
      write: transaction.write.bind(transaction),
    };

    var completed = false;
    var trace = function(status) {
      // prevent us tracing twice in case theres a race condition on the client
      if (completed) return;
      completed = true;

      message.transaction.setData({
        topic: message.topic,
        data: message.data,
        status: status,
      });

      message.transaction.end();
    };

    // swizzle the ack and reject methods so they can trace once the message is complete
    message.ack = function(a1, a2, a3) {
      trace('ack');
      _ack(a1, a2, a3);
    };

    message.reject = function(a1, a2, a3) {
      trace('reject');
      _reject(a1, a2, a3);
    };

    // swizzle the send method to the message object so nested tracing can occur
    message.send = function(topic, data, cb) {
      // here we just attach the current transaction ID to the message data
      data._parentTransaction = message.transaction.id;

      _send(topic, data, cb);
    };

    // swizzle the rpcExec method to the message object so nested tracing can occur
    message.rpcExec = function(topic, data, opts, cb) {
      // here we just attach the current transaction ID to the message data
      data._parentTransaction = message.transaction.id;

      _rpcExec(topic, data, opts, cb);
    };

    next();
  },
};

process.on('uncaughtException', function(err) {
  writeLocal('error', {
    exception: err,
  });
  process.exit(1);
});

console.log('Added generic exception handler for FlightControl logger\n');

module.exports = logger;