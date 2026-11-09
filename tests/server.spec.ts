import { test, expect } from '@playwright/test';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

// The demo server's own input handling. These tests need no browser, so they run once, in the "server" project.
// eslint-disable-next-line @typescript-eslint/no-var-requires
// SERVE_DEMO: scripts/mutants.js points this (and the web server) at a mutated copy of the server.
const { resolveRequest, insideRoot, ROOT, handle } = require(process.env.SERVE_DEMO ? path.resolve(process.env.SERVE_DEMO) : '../scripts/serve-demo.js');

// Sends a request target exactly as written. A browser or an HTTP client would re-encode or normalise it first,
// which is the point of the attack inputs below, so these go over a raw socket.
function rawGet(baseURL: string, target: string, method = 'GET'): Promise<{ status: number; body: string; head: string }> {
  const { hostname, port } = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => (raw += chunk));
    socket.on('end', () => resolve({ status: Number(raw.split(' ')[1]), head: raw.split('\r\n\r\n')[0].toLowerCase(), body: raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    socket.on('error', reject);
  });
}

test.describe('symlink containment', () => {
  test('a real path outside the demo folder is refused, one inside is allowed', () => {
    const real = fs.realpathSync(ROOT);
    expect(insideRoot(path.join(real, 'trip.json'))).toBe(true);
    expect(insideRoot(path.join(real, '..', 'package.json'))).toBe(false);
    expect(insideRoot(real + '-private' + path.sep + 'x.json')).toBe(false);
    expect(insideRoot(real)).toBe(false);
    expect(insideRoot(path.dirname(real))).toBe(false);
  });
});

test.describe('request path handling', () => {
  test('"/" serves the app\'s index.html', () => {
    expect(resolveRequest('/')).toEqual({ status: 200, file: path.join(ROOT, 'index.html') });
  });

  test('malformed percent-encoding is a 400, not an exception', () => {
    expect(resolveRequest('/%E0%A4%A')).toEqual({ status: 400 });
  });

  test('a null byte is a 400, not an exception', () => {
    expect(resolveRequest('/a%00b')).toEqual({ status: 400 });
  });

  test('an encoded "../" is refused with 403', () => {
    expect(resolveRequest('/..%2fpackage.json')).toEqual({ status: 403 });
    expect(resolveRequest('/demo/..%2f..%2fpackage.json')).toEqual({ status: 403 });
  });

  // A sibling folder whose name starts with the demo folder's name (demo-private next to demo). A check written as
  // file.startsWith(ROOT) without the separator would serve it; the expected 403 is stated here, not computed.
  test("a sibling folder that shares the demo folder's name prefix is refused with 403", () => {
    const sibling = path.basename(ROOT) + '-private';
    expect(resolveRequest('/..%2f' + sibling + '%2fsecret.txt')).toEqual({ status: 403 });
  });

  // Each hostile target with its stated result (status, and for a 200 the exact file), not the code's own predicate.
  const inDemo = (rel: string) => ({ status: 200, file: path.join(ROOT, rel) });
  const hostile: [string, object][] = [
    ['/../package.json', inDemo('package.json')],                 // the URL parser removes the dot segment first
    ['/%2e%2e/package.json', inDemo('package.json')],             // same: %2e%2e is a dot segment to the URL parser
    ['/..%2fpackage.json', { status: 403 }],
    ['/..%5cpackage.json', process.platform === 'win32' ? { status: 403 } : inDemo('..\\package.json')],
    ['/%2e%2e%2f%2e%2e%2fetc/passwd', { status: 403 }],
    ['/....//package.json', inDemo('..../package.json')],
    ['/%252e%252e%252fpackage.json', inDemo('%2e%2e%2fpackage.json')], // decoded once, never twice
    ['//etc/passwd', inDemo('passwd')],                            // "//etc" is a host to the URL parser
  ];
  for (const [target, expected] of hostile) {
    test(`hostile path ${target} gets its stated result`, () => {
      expect(resolveRequest(target)).toEqual(expected);
    });
  }
});

test.describe('the running server', () => {
  // A symlink inside the demo folder that points outside it. The link is made for this test and removed after it.
  test('a symlink that leads outside the demo folder gets 403 and no file contents', async ({ baseURL }) => {
    const link = path.join(ROOT, '__link-test.json');
    fs.rmSync(link, { force: true });
    try {
      fs.symlinkSync(path.join(ROOT, '..', 'package.json'), link, 'file');
    } catch (e: any) {
      test.skip(e.code === 'EPERM', 'this machine does not allow symlinks for this user');
      throw e;
    }
    try {
      const r = await rawGet(baseURL!, '/__link-test.json');
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('planner-e2e-showcase');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
  // A hard link inside the demo folder to a file outside it: its real path is inside, so only the link count shows it.
  test('a hard link to a file outside the demo folder gets 403 and no file contents', async ({ baseURL }) => {
    const link = path.join(ROOT, '__hard-test.json');
    fs.rmSync(link, { force: true });
    try { fs.linkSync(path.join(ROOT, '..', 'package.json'), link); } catch (e: any) { test.skip(e.code === 'EXDEV' || e.code === 'EPERM', 'cannot hard-link here'); throw e; }
    try {
      const r = await rawGet(baseURL!, '/__hard-test.json');
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('planner-e2e-showcase');
    } finally { fs.rmSync(link, { force: true }); }
  });
  // A FIFO: a blocking open waits for a writer and holds a threadpool thread; four of them stopped the server.
  test('a FIFO gets 404 and four of them do not stop the server', async ({ baseURL }) => {
    test.skip(process.platform === 'win32', 'no FIFOs in the Windows file system');
    const fifo = path.join(ROOT, '__fifo-test.json');
    fs.rmSync(fifo, { force: true });
    require('child_process').execFileSync('mkfifo', [fifo]);
    try {
      for (let i = 0; i < 4; i++) expect((await rawGet(baseURL!, '/__fifo-test.json')).status).toBe(404);
      expect((await rawGet(baseURL!, '/')).status).toBe(200);
    } finally { fs.rmSync(fifo, { force: true }); }
  });
  // Each crash input is followed by a normal request: a server that died would refuse that connection.
  for (const [target, status] of [['/%E0%A4%A', 400], ['/a%00b', 400]] as const) {
    test(`${target} gets ${status} and the server keeps serving`, async ({ baseURL }) => {
      expect((await rawGet(baseURL!, target)).status).toBe(status);
      expect((await rawGet(baseURL!, '/')).status).toBe(200);
    });
  }

  // A symlinked DIRECTORY inside the demo folder: the last path component is a real file, so only the real-path check
  // (not O_NOFOLLOW, which looks at the last component) can refuse it.
  test('a file reached through a symlinked directory outside the demo folder gets 403', async ({ baseURL }) => {
    const link = path.join(ROOT, '__link-dir');
    // Remove only the link itself, never what it points to (rmdir on a junction, unlink on a symlink).
    const removeLink = () => { try { fs.lstatSync(link); } catch { return; } if (process.platform === 'win32') fs.rmdirSync(link); else fs.unlinkSync(link); };
    removeLink();
    try {
      fs.symlinkSync(path.join(ROOT, '..'), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e: any) {
      test.skip(e.code === 'EPERM', 'this machine does not allow symlinks for this user');
      throw e;
    }
    try {
      const r = await rawGet(baseURL!, '/__link-dir/package.json');
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('planner-e2e-showcase');
    } finally {
      removeLink();
    }
  });

  test('methods other than GET and HEAD get 405 with an Allow header', async ({ baseURL }) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await rawGet(baseURL!, '/', method);
      expect(r.status, method).toBe(405);
      expect(r.head, method).toContain('allow: get, head');
    }
  });

  test('a file that does not exist gets 404, not 403', async ({ baseURL }) => {
    const r = await rawGet(baseURL!, '/__no-such-file.json');
    expect(r.status).toBe(404);
    expect(r.body).toContain('Not found'); // the body is sent chunked, so it carries chunk-size lines
  });

  test('HEAD gives the size and no body', async ({ baseURL }) => {
    const r = await rawGet(baseURL!, '/trip.json', 'HEAD');
    expect(r.status).toBe(200);
    expect(r.head).toContain('content-length: ' + fs.statSync(path.join(ROOT, 'trip.json')).size);
    expect(r.body).toBe('');
  });

  test('served files carry X-Content-Type-Options: nosniff', async ({ baseURL }) => {
    for (const target of ['/', '/trip.json']) {
      const r = await rawGet(baseURL!, target);
      expect(r.status, target).toBe(200);
      expect(r.head, target).toContain('x-content-type-options: nosniff');
    }
  });

  test('served files carry the Content-Type of their extension', async ({ baseURL }) => {
    for (const [target, type] of [['/', 'text/html; charset=utf-8'], ['/trip.json', 'application/json; charset=utf-8']]) {
      expect((await rawGet(baseURL!, target)).head, target).toContain('content-type: ' + type);
    }
  });

  test('an encoded "../" gets 403 and no file contents', async ({ baseURL }) => {
    const r = await rawGet(baseURL!, '/..%2fpackage.json');
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('planner-e2e-showcase');
  });
});
// In-process: one fs call is wrapped so that a change lands at an exact point between the containment check and the
// read. No timing, no retries: the same interleaving every run.
const call = (url: string, method = 'GET'): Promise<{ status: number; body: string; headers?: any }> => new Promise(resolve => {
  const res: any = { writeHead(code: number, headers?: any) { this.code = code; this.headers = headers; return this; }, end(b?: any) { resolve({ status: this.code, body: b ? String(b) : '', ...(method === 'HEAD' ? { headers: this.headers } : {}) }); } };
  handle({ method, url }, res);
});
// the fs module object the server holds (a TypeScript `import * as fs` is a copy, so patching it would change nothing)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeFs = require('fs');
test.describe('the handler reads the file it checked', () => {
  // Per-process names: parallel workers each get their own pair, so one test's swap never touches another's file.
  const file = path.join(ROOT, `__swap-test-${process.pid}.json`), decoy = path.join(ROOT, `__swap-decoy-${process.pid}.json`);
  test.afterEach(() => { fs.rmSync(file, { force: true }); fs.rmSync(decoy, { force: true }); });

  test('a file replaced right after the check is not what gets served', async () => {
    fs.writeFileSync(file, 'CHECKED-FILE'); fs.writeFileSync(decoy, 'SWAPPED-IN!!');   // same length: no short read
    const real = nodeFs.realpathSync;
    // swapped: the replace succeeded inside the handler. refused: the OS would not replace the open file (Windows).
    let swapped = false, refused = '';
    nodeFs.realpathSync = (...a: any[]) => {
      const r = real(...a); nodeFs.realpathSync = real;
      try { fs.renameSync(decoy, file); swapped = true; } catch (e: any) { refused = e.code; }
      return r;
    };
    try {
      const r = await call(`/__swap-test-${process.pid}.json`);
      expect(r.body).not.toContain('SWAPPED-IN');
      if (process.platform === 'win32') {
        // Windows refuses to replace a file another handle has open, so the swap cannot land after the open.
        expect(swapped).toBe(false);
        expect(['EPERM', 'EACCES', 'EBUSY']).toContain(refused);
        expect(r).toEqual({ status: 200, body: 'CHECKED-FILE' });
      } else {
        expect(swapped).toBe(true); // the swap happened inside the handler, so the test can fail
        expect(process.platform === 'linux' ? r : r.status).toEqual(process.platform === 'linux' ? { status: 200, body: 'CHECKED-FILE' } : 403);
      }
    } finally { nodeFs.realpathSync = real; }
  });

  test('a read shorter than the size from fstat gets 500, not a truncated 200', async () => {
    fs.writeFileSync(file, 'TWELVE-BYTES');
    const read = nodeFs.read;
    nodeFs.read = (fd: number, buf: Buffer, off: number, len: number, pos: number, cb: any) => read(fd, buf, off, len - 1, pos, cb);
    try { expect(await call(`/__swap-test-${process.pid}.json`)).toEqual({ status: 500, body: 'File changed while reading' }); }
    finally { nodeFs.read = read; }
  });
});
// In-process: one fs call fails on purpose, so each error path runs with its stated status.
test.describe('the handler error paths', () => {
  test('an fstat error after the open gets 404, not a crash', async () => {
    const fstat = nodeFs.fstatSync;
    nodeFs.fstatSync = () => { nodeFs.fstatSync = fstat; throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); };
    try { expect(await call('/trip.json')).toEqual({ status: 404, body: 'Not found' }); }
    finally { nodeFs.fstatSync = fstat; }
  });

  test('a read error gets 404, not a 500 or a partial 200', async () => {
    const read = nodeFs.read;
    nodeFs.read = (fd: number, buf: Buffer, off: number, len: number, pos: number, cb: any) => process.nextTick(cb, Object.assign(new Error('injected EIO'), { code: 'EIO' }));
    try { expect(await call('/trip.json')).toEqual({ status: 404, body: 'Not found' }); }
    finally { nodeFs.read = read; }
  });

  test('HEAD answers from fstat and never reads the file', async () => {
    const read = nodeFs.read;
    let reads = 0;
    nodeFs.read = (...a: any[]) => { reads++; return read(...a); };
    try {
      const r = await call('/trip.json', 'HEAD');
      expect(r.status).toBe(200);
      expect(r.body).toBe('');
      expect(r.headers['Content-Length']).toBe(fs.statSync(path.join(ROOT, 'trip.json')).size);
      expect(reads).toBe(0);
    } finally { nodeFs.read = read; }
  });
});
