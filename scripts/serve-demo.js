// Minimal static file server for the demo app. No dependencies.
// Usage: node scripts/serve-demo.js   (serves ./demo on http://127.0.0.1:4173)
// DEMO_ROOT=<folder> serves another folder instead (scripts/mutants.js uses this to serve broken copies of the app).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.DEMO_ROOT || path.join(__dirname, '..', 'demo'));
const PORT = Number(process.env.PORT) || 4173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Maps a request target to a file inside ROOT, or to an error status. Never throws: a request the server cannot
// parse gets 400 instead of crashing the process, which would take the server down for every later request.
//   400  the path is not valid percent-encoding (decodeURIComponent throws) or contains a null byte (fs throws)
//   403  the path resolves outside ROOT, for example an encoded "../" (%2f) or, on Windows, "..\" (%5c)
function resolveRequest(rawUrl, root = ROOT) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch (e) {
    return { status: 400 };
  }
  if (urlPath.includes('\0')) return { status: 400 };
  const relative = urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath;
  // resolve, not join + normalize: a decoded "../" must climb, so that the check below sees it and refuses it.
  const file = path.resolve(root, '.' + path.sep + relative);
  if (!file.startsWith(root + path.sep)) return { status: 403 };
  return { status: 200, file };
}

// The resolved path is checked again after following symlinks: a link inside the folder that points outside it is
// refused. ROOT itself may be a symlink (a temporary folder on macOS is one), so it is compared in real form too.
const ROOT_REAL = fs.realpathSync(ROOT);
function insideRoot(real) {
  const rel = path.relative(ROOT_REAL, real);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function handle(req, res) {
  const { status, file } = resolveRequest(req.url);
  if (status !== 200) {
    res.writeHead(status, { 'Content-Type': 'text/plain' }).end(status === 400 ? 'Bad request' : 'Forbidden');
    return;
  }
  fs.realpath(file, (err, real) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    if (!insideRoot(real)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
      return;
    }
    fs.readFile(real, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(real)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
}
if (require.main === module) {
  http.createServer(handle).listen(PORT, '127.0.0.1', () => {
    console.log(`Demo planner running at http://127.0.0.1:${PORT}/ (serving ${ROOT})`);
  });
}

module.exports = { resolveRequest, insideRoot, ROOT };