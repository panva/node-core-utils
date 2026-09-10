import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { checkCapacity } from '../../lib/ci/capacity.js';

function config(fields = {}) {
  const values = {
    throttleEnabled: 'true', throttleOption: 'project',
    maxConcurrentTotal: '15', ...fields
  };
  return '<project><properties>' +
    '<hudson.plugins.throttleconcurrents.ThrottleJobProperty>' +
    Object.entries(values).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `<${key}>${value}</${key}>`).join('') +
    '</hudson.plugins.throttleconcurrents.ThrottleJobProperty>' +
    '</properties></project>';
}

function responses({
  running = 0, queued = 0, oneOff = 0, xml = config(), job = 'node-test-commit'
} = {}) {
  const jobURL = `https://ci.nodejs.org/job/${job}/`;
  const executors = count => Array.from({ length: count }, (_, i) => ({
    currentExecutable: { url: `${jobURL}${i + 1}/` }
  }));
  return [xml, {
    computer: [{
      executors: [...executors(running), { currentExecutable: null }, {
        currentExecutable: { url: 'https://ci.nodejs.org/job/node-test-commit-linux/1/' }
      }],
      oneOffExecutors: executors(oneOff)
    }]
  }, {
    items: [...Array.from({ length: queued }, () => ({ task: { url: jobURL } })),
      { task: { url: 'https://ci.nodejs.org/job/node-test-commit-linux/' } }]
  }];
}

async function check(options = {}) {
  const data = responses(options);
  const calls = [];
  const messages = [];
  const status = await checkCapacity({ log: text => messages.push(text) }, {
    async fetch(url, options) {
      assert.equal(options.method, undefined);
      assert.ok(options.signal instanceof AbortSignal);
      calls.push(url);
      const body = data.shift();
      return new Response(typeof body === 'string' ? body : JSON.stringify(body));
    }
  }, options.job);
  return { status, calls, messages };
}

describe('CI capacity', () => {
  it('uses the requested job for configuration, running builds, and queued builds', async() => {
    const { status, calls, messages } = await check({
      job: 'node-test-pull-request', running: 14, queued: 1
    });
    assert.equal(status, 2);
    assert.equal(calls[0], 'https://ci.nodejs.org/job/node-test-pull-request/config.xml');
    assert.deepEqual(messages, ['node-test-pull-request: 14 running, 1 queued, limit 15']);
  });

  for (const [options, expected] of [
    [{}, 0],
    [{ running: 14 }, 0],
    [{ running: 15 }, 2],
    [{ running: 16 }, 2],
    [{ running: 14, queued: 1 }, 2],
    [{ queued: 15 }, 2],
    [{ running: 14, oneOff: 1 }, 2]
  ]) {
    it(`counts running and queued builds: ${JSON.stringify(options)}`, async() => {
      const { status, calls } = await check(options);
      assert.equal(status, expected);
      assert.equal(calls.length, 3);
      assert.equal(new URL(calls[1]).searchParams.get('tree'),
        'computer[executors[currentExecutable[url]],oneOffExecutors[currentExecutable[url]]]');
      assert.equal(new URL(calls[2]).searchParams.get('tree'), 'items[task[url]]');
    });
  }

  for (const fields of [
    { maxConcurrentTotal: '0' },
    { maxConcurrentTotal: undefined },
    { maxConcurrentTotal: '-1' },
    { maxConcurrentTotal: 'garbage' },
    { maxConcurrentTotal: '1.5' },
    { maxConcurrentTotal: '9007199254740992' },
    { throttleEnabled: 'false' },
    { throttleEnabled: undefined },
    { throttleOption: undefined },
    { throttleOption: undefined, maxConcurrentTotal: '0' },
    { throttleOption: 'category' }
  ]) {
    it(`proceeds without inspecting builds for ${JSON.stringify(fields)}`, async() => {
      const { status, calls } = await check({ xml: config(fields), running: 99 });
      assert.equal(status, 0);
      assert.equal(calls.length, 1);
    });
  }

  for (const xml of ['', '<project><properties/></project>', '<html>Access denied</html>']) {
    it(`proceeds with unavailable throttle configuration: ${xml}`, async() => {
      assert.equal((await check({ xml })).status, 0);
    });
  }

  for (const failureAt of [0, 1, 2]) {
    it(`proceeds if lookup ${failureAt + 1} fails`, async() => {
      for (const failure of ['http', 'network', 'invalid-json']) {
        const data = responses({ running: 15 });
        let index = 0;
        const messages = [];
        const status = await checkCapacity({ log: text => messages.push(text) }, {
          async fetch() {
            if (index++ === failureAt) {
              if (failure === 'network') throw new Error('Connection failed');
              return new Response('unavailable', { status: failure === 'http' ? 503 : 200 });
            }
            const body = data[index - 1];
            return new Response(typeof body === 'string' ? body : JSON.stringify(body));
          }
        });
        assert.equal(status, 0);
        assert.match(messages.at(-1), /proceeding/);
      }
    });
  }
});

describe('ncu-ci capacity command', () => {
  for (const [options, expected] of [
    [{ running: 15 }, 2],
    [{ running: 14 }, 0],
    [{ xml: config({ maxConcurrentTotal: '0' }) }, 0],
    [{ xml: config({ throttleOption: undefined }) }, 0]
  ]) {
    it(`exits ${expected} without GitHub credentials: ${JSON.stringify(options)}`, t => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'ncu-capacity-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      writeFileSync(path.join(directory, 'ncurc'), '{}');
      const requestURL = new URL('../../lib/request.js', import.meta.url).href;
      const cliURL = new URL('../../bin/ncu-ci.js', import.meta.url).href;
      const script = `
        import Request from ${JSON.stringify(requestURL)};
        const responses = ${JSON.stringify(responses(options))};
        Request.prototype.fetch = async function(url, options) {
          if (!url.startsWith('https://ci.nodejs.org/') || options.method) {
            throw new Error('Only Jenkins GETs expected');
          }
          const body = responses.shift();
          return new Response(typeof body === 'string' ? body : JSON.stringify(body));
        };
        process.argv = [process.execPath, ${JSON.stringify(cliURL)}, 'capacity'];
        await import(${JSON.stringify(cliURL)});
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: directory,
        env: { ...process.env, XDG_CONFIG_HOME: directory },
        encoding: 'utf8',
        timeout: 10000
      });
      assert.ifError(result.error);
      assert.equal(result.status, expected, result.stderr);
      assert.match(result.stderr, /node-test-commit:/);
    });
  }
});
