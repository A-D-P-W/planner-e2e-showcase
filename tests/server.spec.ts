import { test, expect } from '@playwright/test';
import * as net from 'net';
import * as path from 'path';

// The demo server's own input handling. These tests need no browser, so they run once, in the "server" project.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveRequest, ROOT } = require('../scripts/serve-demo.js');

// Sends a request target exactly as written. A browser or an HTTP client would re-encode or normalise it first,
// which is the point of the attack inputs below, so these go over a raw socket.
function rawGet(baseURL: string, target: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => (raw += chunk));
    socket.on('end', () => resolve({ status: Number(raw.split(' ')[1]), body: raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    socket.on('error', reject);
  });
}

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

  test('no hostile path resolves to a file outside the demo folder', () => {
    const hostile = ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5cpackage.json',
      '/%2e%2e%2f%2e%2e%2fetc/passwd', '/....//package.json', '/%252e%252e%252fpackage.json', '//etc/passwd'];
    for (const target of hostile) {
      const r = resolveRequest(target);
      if (r.status === 200) expect(r.file.startsWith(ROOT + path.sep), target).toBe(true);
    }
  });
});

test.describe('the running server', () => {
  // Each crash input is followed by a normal request: a server that died would refuse that connection.
  for (const [target, status] of [['/%E0%A4%A', 400], ['/a%00b', 400]] as const) {
    test(`${target} gets ${status} and the server keeps serving`, async ({ baseURL }) => {
      expect((await rawGet(baseURL!, target)).status).toBe(status);
      expect((await rawGet(baseURL!, '/')).status).toBe(200);
    });
  }

  test('a sibling-prefix path gets 403', async ({ baseURL }) => {
    expect((await rawGet(baseURL!, '/..%2f' + path.basename(ROOT) + '-private%2fsecret.txt')).status).toBe(403);
  });

  test('an encoded "../" gets 403 and no file contents', async ({ baseURL }) => {
    const r = await rawGet(baseURL!, '/..%2fpackage.json');
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('planner-e2e-showcase');
  });
});