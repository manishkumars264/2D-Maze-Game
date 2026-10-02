/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - server.js
 * ----------------------------------------------------------------------------
 *  Zero-dependency static file server so the game can be served over HTTP
 * (some browsers restrict features on file://, and serving also lets you play
 * from another device on your LAN).
 *
 *  Usage:   node server.js [port]        (default 8080, binds 0.0.0.0)
 * ============================================================================
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const file = path.normalize(path.join(ROOT, urlPath));
  // never escape the project folder
  if (file.indexOf(ROOT + path.sep) !== 0 && file !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(file, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('Coastline Overdrive serving on http://localhost:' + PORT + '/');
});
