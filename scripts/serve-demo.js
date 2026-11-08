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

const send = (res, status, body, extra) => res.writeHead(status, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff', ...extra }).end(body);
// The file is opened ONCE and the containment check runs on the opened descriptor, so a path swapped after the check
// cannot change what is read (the old realpath-then-readFile pair read whatever the path named at read time).
//   Linux: /proc/self/fd/<fd> names the file that was actually opened.
//   elsewhere: realpath after open, then fstat and stat of that real path must be the same inode (dev+ino); a swap
//   between open and the check makes them differ and the request gets 403. [HYPOTHESIS on Windows: ino from fs.stat is
//   the NTFS file index; not driven here]
function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  const { status, file } = resolveRequest(req.url);
  if (status !== 200) return send(res, status, status === 400 ? 'Bad request' : 'Forbidden');
  fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), (err, fd) => {
    if (err) return send(res, err.code === 'ELOOP' ? 403 : 404, err.code === 'ELOOP' ? 'Forbidden' : 'Not found');
    const done = (code, body, headers) => fs.close(fd, () => (headers ? res.writeHead(code, headers).end(body) : send(res, code, body)));
    let real, st;
    try {
      st = fs.fstatSync(fd);
      if (!st.isFile()) return done(404, 'Not found');
      if (st.nlink > 1) return done(403, 'Forbidden'); // a hardlink can name a file outside ROOT; realpath cannot see it
      if (process.platform === 'linux') real = fs.realpathSync('/proc/self/fd/' + fd);
      else { real = fs.realpathSync(file); const s2 = fs.statSync(real); if (s2.dev !== st.dev || s2.ino !== st.ino) return done(403, 'Forbidden'); }
    } catch (e) { return done(404, 'Not found'); }
    if (!insideRoot(real)) return done(403, 'Forbidden');
    const headers = { 'Content-Type': TYPES[path.extname(real)] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.method === 'HEAD') return done(200, undefined, headers); // HEAD needs the size, not the bytes
    const data = Buffer.alloc(st.size);
    fs.read(fd, data, 0, st.size, 0, (err2, n) => {
      if (err2) return done(404, 'Not found');
      if (n !== st.size) return done(500, 'File changed while reading'); // truncated (or short read) after fstat
      done(200, data, headers);
    });
  });
}
if (require.main === module) {
  http.createServer(handle).listen(PORT, '127.0.0.1', () => {
    console.log(`Demo planner running at http://127.0.0.1:${PORT}/ (serving ${ROOT})`);
  });
}

module.exports = { resolveRequest, insideRoot, ROOT };