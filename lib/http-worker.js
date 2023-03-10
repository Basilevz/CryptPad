const process = require("node:process");
const Http = require("node:http");
const Default = require("./defaults");
const Path = require("node:path");
const Fs = require("node:fs");
const nThen = require("nthen");
const Util = require("./common-util");
const Logger = require("./log");

const DEFAULT_QUERY_TIMEOUT = 5000;
const PID = process.pid;

const response = Util.response(function (errLabel, info) {
    Env.Log.error(errLabel, info);
});

const guid = () => {
    return Util.guid(response._pending);
};

const sendMessage = (msg, cb, opt) => {
    var txid = guid();
    var timeout = (opt && opt.timeout) || DEFAULT_QUERY_TIMEOUT;
    var obj = {
        pid: PID,
        txid: txid,
        content: msg,
    };
    response.expect(txid, cb, timeout);
    process.send(obj);
};
const Log = {};
Logger.levels.forEach(level => {
    Log[level] = function (tag, info) {
        sendMessage({
            command: 'LOG',
            level: level,
            tag: tag,
            info: info,
        }, (err) => {
            if (err) {
                return void console.error(new Error(err));
            }
        });
    };
});

const EVENTS = {};

var Env = JSON.parse(process.env.Env);
EVENTS.ENV_UPDATE = function (data /*, cb */) {
    try {
        Env = JSON.parse(data);
    } catch (err) {
        Log.error('HTTP_WORKER_ENV_UPDATE', Util.serializeError(err));
    }
};

EVENTS.FLUSH_CACHE = function (data) {
    if (typeof(data) !== 'number') {
        return Log.error('INVALID_FRESH_KEY', data);
    }

    Env.FRESH_KEY = data;
    [ 'configCache', 'broadcastCache', ].forEach(key => {
        Env[key] = {};
    });
    [ 'officeHeadersCache', 'standardHeadersCache', 'apiHeadersCache', ].forEach(key => {
        Env[key] = undefined;
    });
};

process.on('message', msg => {
    if (!(msg && msg.txid)) { return; }
    if (msg.type === 'REPLY') {
        var txid = msg.txid;
        return void response.handle(txid, [msg.error, msg.value]);
    } else if (msg.type === 'EVENT') {
        // response to event...
        // ie. Update Env, flush cache, etc.
        var ev = EVENTS[msg.command];
        if (typeof(ev) === 'function') {
            return void ev(msg.data, () => {});
        }
    }
    console.error("UNHANDLED_MESSAGE", msg); // XXX
});


var applyHeaderMap = function (res, map) {
    for (let header in map) {
        if (typeof(map[header]) === 'string') { res.setHeader(header, map[header]); }
    }
};

var EXEMPT = [
    /^\/common\/onlyoffice\/.*\.html.*/,
    /^\/(sheet|presentation|doc)\/inner\.html.*/,
    /^\/unsafeiframe\/inner\.html.*$/,
];

var cacheHeaders = function (Env, key, headers) {
    if (Env.DEV_MODE) { return; }
    Env[key] = headers;
};

var getHeaders = function (Env, type) {
    var key = type + 'HeadersCache';
    if (Env[key]) { return Env[key]; }

    var headers = Default.httpHeaders(Env);

    headers['Content-Security-Policy'] = type === 'office'?
        Default.padContentSecurity(Env):
        Default.contentSecurity(Env);

    if (Env.NO_SANDBOX) { // handles correct configuration for local development
    // https://stackoverflow.com/questions/11531121/add-duplicate-http-response-headers-in-nodejs
        headers["Cross-Origin-Resource-Policy"] = 'cross-origin';
        headers["Cross-Origin-Embedder-Policy"] = 'require-corp';
    }

    // Don't set CSP headers on /api/ endpoints
    // because they aren't necessary and they cause problems
    // when duplicated by NGINX in production environments
    if (type === 'api') {
        cacheHeaders(Env, key, headers);
        return headers;
    }

    headers["Cross-Origin-Resource-Policy"] = 'cross-origin';
    cacheHeaders(Env, key, headers);
    return headers;
};

var setHeaders = function (req, res) {
    var type;
    if (EXEMPT.some(regex => regex.test(req.url))) {
        type = 'office';
    } else if (/^\/api\/(broadcast|config)/.test(req.url)) {
        type = 'api';
    } else {
        type = 'standard';
    }

    var h = getHeaders(Env, type);
    applyHeaderMap(res, h);
};

const Express = require("express");
var app = Express();

(function () {
if (!Env.logFeedback) { return; }

const logFeedback = function (url) {
    url.replace(/\?(.*?)=/, function (all, fb) {
        Log.feedback(fb, '');
    });
};

app.head(/^\/common\/feedback\.html/, function (req, res, next) {
    logFeedback(req.url);
    next();
});
}());

const { createProxyMiddleware } = require("http-proxy-middleware");

var proxyTarget = new URL('', 'ws:localhost');
proxyTarget.port = Env.websocketPort;

const wsProxy = createProxyMiddleware({
    target: proxyTarget.href,
    ws: true,
    logLevel: 'error',
});

app.use('/cryptpad_websocket', wsProxy);


app.use('/blob', function (req, res, next) {
/*  Head requests are used to check the size of a blob.
    Clients can configure a maximum size to download automatically,
    and can manually click to download blobs which exceed that limit.  */
    if (req.method === 'HEAD') {
        Express.static(Path.resolve(Env.paths.blob), {
            setHeaders: function (res /*, path, stat */) {
                res.set('Access-Control-Allow-Origin', Env.enableEmbedding? '*': Env.permittedEmbedders);
                res.set('Access-Control-Allow-Headers', 'Content-Length');
                res.set('Access-Control-Expose-Headers', 'Content-Length');
            }
        })(req, res, next);
        return;
    }

/*  Some GET requests concern the whole file,
    others only target ranges, either:

    1. a two octet prefix which encodes the length of the metadata in octets
    2. the metadata itself, excluding the two preceding octets
*/

/*
    // Example code to demonstrate the types of requests which are handled
    if (req.method === 'GET') {
        if (!req.headers.range) {
            // metadata
        } else {
            // full request
        }
    }
*/

    next();
});

app.use(function (req, res, next) {
/*  These are pre-flight requests, through which the client
    confirms with the server that it is permitted to make the
    actual requests which will follow */
    if (req.method === 'OPTIONS' && /\/blob\//.test(req.url)) {
        res.setHeader('Access-Control-Allow-Origin', Env.enableEmbedding? '*': Env.permittedEmbedders);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'DNT,X-CustomHeader,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Content-Range,Range,Access-Control-Allow-Origin');
        res.setHeader('Access-Control-Max-Age', 1728000);
        res.setHeader('Content-Type', 'application/octet-stream; charset=utf-8');
        res.setHeader('Content-Length', 0);
        res.statusCode = 204;
        return void res.end();
    }

    setHeaders(req, res);
    if (/[\?\&]ver=[^\/]+$/.test(req.url)) { res.setHeader("Cache-Control", "max-age=31536000"); }
    else { res.setHeader("Cache-Control", "no-cache"); }
    next();
});

// serve custom app content from the customize directory
// useful for testing pages customized with opengraph data
app.use(Express.static(Path.resolve('./customize/www')));
app.use(Express.static(Path.resolve('./www')));

// FIXME I think this is a regression caused by a recent PR
// correct this hack without breaking the contributor's intended behaviour.

var mainPages = Env.mainPages || Default.mainPages();
var mainPagePattern = new RegExp('^\/(' + mainPages.join('|') + ').html$');
app.get(mainPagePattern, Express.static('./customize'));
app.get(mainPagePattern, Express.static('./customize.dist'));

app.use("/blob", Express.static(Path.resolve(Env.paths.blob), {
    maxAge: Env.DEV_MODE? "0d": "365d"
}));

// XXX update atime?
app.use("/block", Express.static(Path.resolve(Env.paths.block), {
    maxAge: "0d",
}));

app.use("/customize", Express.static('customize'));
app.use("/customize", Express.static('customize.dist'));
app.use("/customize.dist", Express.static('customize.dist'));
app.use(/^\/[^\/]*$/, Express.static('customize'));
app.use(/^\/[^\/]*$/, Express.static('customize.dist'));

// if dev mode: never cache
var cacheString = function () {
    return (Env.FRESH_KEY? '-' + Env.FRESH_KEY: '') + (Env.DEV_MODE? '-' + (+new Date()): '');
};

var makeRouteCache = function (template, cacheName) {
    var cleanUp = {};
    var cache = Env[cacheName] = Env[cacheName] || {};

    return function (req, res) {
        var host = req.headers.host.replace(/\:[0-9]+/, '');
        res.setHeader('Content-Type', 'text/javascript');
        // don't cache anything if you're in dev mode
        if (Env.DEV_MODE) {
            return void res.send(template(host));
        }
        // generate a lookup key for the cache
        var cacheKey = host + ':' + cacheString();

        // FIXME mutable
        // we must be able to clear the cache when updating any mutable key
        // if there's nothing cached for that key...
        if (!cache[cacheKey]) {
            // generate the response and cache it in memory
            cache[cacheKey] = template(host);
            // and create a function to conditionally evict cache entries
            // which have not been accessed in the last 20 seconds
            cleanUp[cacheKey] = Util.throttle(function () {
                delete cleanUp[cacheKey];
                delete cache[cacheKey];
            }, 20000);
        }

        // successive calls to this function
        cleanUp[cacheKey]();
        return void res.send(cache[cacheKey]);
    };
};

var serveConfig = makeRouteCache(function () {
    return [
        'define(function(){',
        'return ' + JSON.stringify({
            requireConf: {
                waitSeconds: 600,
                urlArgs: 'ver=' + Env.version + cacheString(),
            },
            removeDonateButton: (Env.removeDonateButton === true),
            allowSubscriptions: (Env.allowSubscriptions === true),
            websocketPath: Env.websocketPath,
            httpUnsafeOrigin: Env.httpUnsafeOrigin,
            adminEmail: Env.adminEmail,
            adminKeys: Env.admins,
            inactiveTime: Env.inactiveTime,
            supportMailbox: Env.supportMailbox,
            defaultStorageLimit: Env.defaultStorageLimit,
            maxUploadSize: Env.maxUploadSize,
            premiumUploadSize: Env.premiumUploadSize,
            restrictRegistration: Env.restrictRegistration,
            httpSafeOrigin: Env.httpSafeOrigin,
            enableEmbedding: Env.enableEmbedding,
            fileHost: Env.fileHost,
            shouldUpdateNode: Env.shouldUpdateNode || undefined,
            listMyInstance: Env.listMyInstance,
            accounts_api: Env.accounts_api,
        }, null, '\t'),
        '});'
    ].join(';\n');
}, 'configCache');

var serveBroadcast = makeRouteCache(function () {
    var maintenance = Env.maintenance;
    if (maintenance && maintenance.end && maintenance.end < (+new Date())) {
        maintenance = undefined;
    }
    return [
        'define(function(){',
        'return ' + JSON.stringify({
            lastBroadcastHash: Env.lastBroadcastHash,
            surveyURL: Env.surveyURL,
            maintenance: maintenance
        }, null, '\t'),
        '});'
    ].join(';\n');
}, 'broadcastCache');

app.get('/api/config', serveConfig);
app.get('/api/broadcast', serveBroadcast);

var Define = function (obj) {
    return `define(function (){
    return ${JSON.stringify(obj, null, '\t')};
});`;
};

app.get('/api/instance', function (req, res) {
    res.setHeader('Content-Type', 'text/javascript');
    res.send(Define({
        name: Env.instanceName,
        description: Env.instanceDescription,
        location: Env.instanceJurisdiction,
        notice: Env.instanceNotice,
    }));
});

var four04_path = Path.resolve('./customize.dist/404.html');
var fivehundred_path = Path.resolve('./customize.dist/500.html');
var custom_four04_path = Path.resolve('./customize/404.html');
var custom_fivehundred_path = Path.resolve('./customize/500.html');

var send404 = function (res, path) {
    if (!path && path !== four04_path) { path = four04_path; }
    Fs.exists(path, function (exists) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (exists) { return Fs.createReadStream(path).pipe(res); }
        send404(res);
    });
};
var send500 = function (res, path) {
    if (!path && path !== fivehundred_path) { path = fivehundred_path; }
    Fs.exists(path, function (exists) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (exists) { return Fs.createReadStream(path).pipe(res); }
        send500(res);
    });
};

app.get('/api/updatequota', function (req, res) {
    if (!Env.accounts_api) {
        res.status(404);
        return void send404(res);
    }
    sendMessage({
        command: 'UPDATE_QUOTA',
    }, (err) => {
        if (err) {
            res.status(500);
            return void send500(res);
        }
        res.send();
    });
});

app.get('/api/profiling', function (req, res) {
    if (!Env.enableProfiling) { return void send404(res); }
    sendMessage({
        command: 'GET_PROFILING_DATA',
    }, (err, value) => {
        if (err) {
            res.status(500);
            return void send500(res);
        }
        res.setHeader('Content-Type', 'text/javascript');
        res.send(JSON.stringify({
            bytesWritten: value,
        }));
    });
});

app.use(function (req, res /*, next */) {
    Log.info('HTTP_404', req.url);
    res.status(404);
    send404(res, custom_four04_path);
});

// default message for thrown errors in ExpressJS routes
app.use(function (err, req, res /*, next*/) {
    Log.error('EXPRESSJS_ROUTING', {
        error: err.stack || err,
    });
    res.status(500);
    send500(res, custom_fivehundred_path);
});

var server = Http.createServer(app);

nThen(function (w) {
    server.listen(Env.httpPort, w());
    if (Env.httpSafePort) {
        server.listen(Env.httpSafePort, w());
    }
    server.on('upgrade', function (req, socket, head) {
        // TODO warn admins that websockets should only be proxied in this way in a dev environment
        // in production it's more efficient to have your reverse proxy (NGINX) directly forward
        // websocket traffic to the correct port (Env.websocketPort)
        wsProxy.upgrade(req, socket, head);
    });
}).nThen(function () {
    // TODO inform the parent process that this worker is ready

});
