import { parseDocument } from 'htmlparser2';

import { CI_DOMAIN } from './ci_type_parser.js';

function child(node, name) {
  return node?.children?.find(node => node.name === name);
}

function concurrencyLimit(xml) {
  const document = parseDocument(xml, { xmlMode: true });
  const project = document.children.find(node => node.type === 'tag');
  const throttle = child(child(project, 'properties'),
    'hudson.plugins.throttleconcurrents.ThrottleJobProperty');
  const value = name => child(throttle, name)?.children
    .filter(node => node.type === 'text').map(node => node.data).join('').trim();
  if (value('throttleEnabled') !== 'true' || value('throttleOption') !== 'project') {
    return undefined;
  }
  const limit = value('maxConcurrentTotal');
  if (!/^\d+$/.test(limit)) return undefined;
  const number = Number(limit);
  return Number.isSafeInteger(number) ? number : undefined;
}

// Only a confirmed full job should defer automation; unavailable data is advisory.
export async function checkCapacity(cli, request, job = 'node-test-commit') {
  const baseURL = `https://${CI_DOMAIN}`;
  const jobURL = `${baseURL}/job/${encodeURIComponent(job)}/`;
  async function read(url, tree) {
    if (tree) url += `?${new URLSearchParams({ tree })}`;
    const response = await request.fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Jenkins returned HTTP ${response.status}`);
    }
    return tree ? response.json() : response.text();
  }

  try {
    const limit = concurrencyLimit(await read(`${jobURL}config.xml`));
    if (limit === undefined) {
      cli.log(`${job}: concurrency limit could not be determined; proceeding`);
      return 0;
    }
    if (limit === 0) {
      cli.log(`${job}: no concurrency limit`);
      return 0;
    }
    const { computer } = await read(`${baseURL}/computer/api/json`,
      'computer[executors[currentExecutable[url]],oneOffExecutors[currentExecutable[url]]]');
    const running = computer.flatMap(({ executors, oneOffExecutors }) =>
      [...executors, ...oneOffExecutors])
      .filter(({ currentExecutable }) => currentExecutable?.url?.startsWith(jobURL)).length;
    const { items } = await read(`${baseURL}/queue/api/json`, 'items[task[url]]');
    const queued = items.filter(({ task }) => task.url === jobURL).length;
    cli.log(`${job}: ${running} running, ${queued} queued, limit ${limit}`);
    return running + queued >= limit ? 2 : 0;
  } catch (error) {
    cli.log(`${job}: unable to determine capacity (${error.message}); proceeding`);
    return 0;
  }
}
