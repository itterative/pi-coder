const path = require('path');

function isMusl() {
    if (process.platform !== 'linux') return false;
    return !process.report?.getReport?.().header?.glibcVersionRuntime;
}

const napi = Number(process.versions.napi) >= 6 ? 'napi-v6' : 'napi-v3';
const libc = process.platform === 'linux' && isMusl() ? 'linuxmusl' : process.platform;
const target = `${napi}-${libc}-${process.arch}`;
const binding = path.join(__dirname, 'binding', target, 'node_sqlite3.node');

try {
    module.exports = require(binding);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No vendored sqlite3 binary for ${target}: ${message}`);
}
