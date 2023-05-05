/*  Mulfi-factor auth requires some rudimentary storage methods
    for a number of data types:

* "challenges" (described in challenge.js)
* account settings for MFA (described in mfa.js)
* session tokens (described in sessions.js)

Each data type requires the same three simple methods:

* read
* write
* delete

These could be implemented as tables in a relational database, but committing to a relational DB
is a big decision, so these methods are instead implemented using the filesystem, with each
file's path and naming convention implemented outside of this module.

Feel free to migrate all of these to a relational DB at some point in the future if you like.

*/

const Basic = module.exports;
const Fs = require("node:fs");
const Path = require("node:path");

var pathError = (cb) => {
    setTimeout(function () {
        cb(new Error("INVALID_PATH"));
    });
};

Basic.read = function (Env, path, cb) {
    if (!path) { return void pathError(cb); }
    Fs.readFile(path, 'utf8', (err, content) => {
        if (err) { return void cb(err); }
        cb(void 0, content);
    });
};

Basic.write = function (Env, path, data, cb) {
    if (!path) { return void pathError(cb); }
    var dirpath = Path.dirname(path);
    Fs.mkdir(dirpath, { recursive: true }, function (err) {
        if (err) { return void cb(err); }
        Fs.writeFile(path, data, cb);
    });
};

Basic.delete = function (Env, path, cb) {
    if (!path) { return void pathError(cb); }
    Fs.rm(path, cb);
};
