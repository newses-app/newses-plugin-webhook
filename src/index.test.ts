import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PublishedChangedEvent } from '@newses/plugin-api';
import { fixtureEntry, runHook, runTest } from '@newses/plugin-api/testing';
import { describe, expect, it } from 'vitest';
import plugin, { DEBOUNCE_SECONDS, userSettings } from './index.js';

const HOOK = 'https://hooks.example/build/abc123';

const event: PublishedChangedEvent = {
  userId: 1,
  feedUrl: 'https://reader.example/public/feeds/k3y',
  published: [
    fixtureEntry({ id: 7, title: 'Seven', link: 'https://news.example/7', published: true }),
  ],
  unpublished: [3],
};

/** Runs the published.changed hook with `settings`, answering with `status`; the request made. */
async function called(settings: Record<string, unknown>, status = 204) {
  const requests: Request[] = [];
  await runHook(plugin, 'published.changed', event, {
    userSettings: { url: HOOK, ...settings },
    hosts: ['hooks.example'],
    fetch: (input) => {
      requests.push(input as Request);
      return Promise.resolve(new Response(null, { status }));
    },
  });
  const [request] = requests;
  if (!request) throw new Error('no request');
  return { request, body: await request.text() };
}

describe('webhook plugin', () => {
  it('has the version package.json has, and waits 2 minutes for more changes', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.hooks['published.changed']?.debounceSeconds).toBe(DEBOUNCE_SECONDS);
    expect(DEBOUNCE_SECONDS).toBe(120);
  });

  it('posts the feed and the changed articles as JSON, never their content', async () => {
    const { request, body } = await called({});
    expect(request.method).toBe('POST');
    expect(request.url).toBe(HOOK);
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('x-newses-event')).toBe('published.changed');
    expect(request.headers.get('x-newses-signature')).toBeNull();
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toEqual({
      event: 'published.changed',
      feedUrl: 'https://reader.example/public/feeds/k3y',
      entries: [
        {
          id: 7,
          published: true,
          title: 'Seven',
          link: 'https://news.example/7',
          publishedAt: '2026-01-01T08:00:00.000Z',
        },
        { id: 3, published: false },
      ],
      sentAt: expect.any(String) as string,
    });
  });

  it('sends build hooks an empty object, and GitHub a repository dispatch', async () => {
    const hook = await called({ format: 'buildHook', method: 'PUT' });
    expect(hook.request.method).toBe('PUT');
    expect(hook.body).toBe('{}');

    const github = await called({ format: 'github', authorization: 'Bearer ghp_x' });
    expect(github.request.headers.get('accept')).toBe('application/vnd.github+json');
    expect(github.request.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(github.request.headers.get('authorization')).toBe('Bearer ghp_x');
    expect(JSON.parse(github.body)).toEqual({
      event_type: 'newses-published-feed',
      client_payload: {
        event: 'published.changed',
        feedUrl: event.feedUrl,
        published: 1,
        unpublished: 1,
        sentAt: expect.any(String) as string,
      },
    });
  });

  it('sends its header, and signs the body with the signing key', async () => {
    const { request, body } = await called({
      headerName: 'X-Api-Key',
      headerValue: 'k-123',
      signingKey: 'shh',
    });
    expect(request.headers.get('x-api-key')).toBe('k-123');
    expect(request.headers.get('x-newses-signature')).toBe(
      `sha256=${createHmac('sha256', 'shh').update(body).digest('hex')}`,
    );
  });

  it('fills a body template with JSON values', async () => {
    const json = await called({
      template: '{"text": "Feed changed", "url": {{feedUrl}}, "added": {{published}}}',
    });
    expect(JSON.parse(json.body)).toEqual({ text: 'Feed changed', url: event.feedUrl, added: 1 });
    expect(json.request.headers.get('content-type')).toBe('application/json');

    const text = await called({ template: 'changed: {{published}} in, {{unpublished}} out' });
    expect(text.body).toBe('changed: 1 in, 1 out');
    expect(text.request.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('fails, to be tried again, on any answer but 2xx, saying what came back', async () => {
    await expect(called({}, 503)).rejects.toThrow('HTTP 503');
    await expect(called({}, 302)).rejects.toThrow('redirects are not followed');
    await expect(
      runHook(plugin, 'published.changed', event, {
        userSettings: { url: 'https://elsewhere.example/' },
        hosts: ['hooks.example'],
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      }),
    ).rejects.toThrow(TypeError);
  });

  it('sends a test call and reports its status', async () => {
    const bodies: string[] = [];
    const test = (status: number) =>
      runTest(plugin, {
        userSettings: { url: HOOK },
        hosts: ['hooks.example'],
        fetch: async (input) => {
          bodies.push(await (input as Request).text());
          return new Response(null, { status, statusText: status === 204 ? 'No Content' : '' });
        },
      });
    expect((await test(204)).value).toEqual({ ok: true, message: 'HTTP 204 No Content' });
    expect((await test(401)).value).toEqual({ ok: false, message: 'HTTP 401' });
    expect(JSON.parse(bodies[0] ?? '')).toMatchObject({
      event: 'test',
      feedUrl: null,
      entries: [],
    });
  });
});

describe('settings', () => {
  const parse = (settings: Record<string, unknown>) =>
    userSettings.safeParse({ url: HOOK, ...settings }).success;

  it('take an http(s) address, a header, and a template of known placeholders', () => {
    expect(parse({})).toBe(true);
    expect(parse({ url: 'ftp://hooks.example/' })).toBe(false);
    expect(parse({ headerName: 'X-Api-Key', headerValue: 'v' })).toBe(true);
    expect(parse({ headerName: 'Bad Header', headerValue: 'v' })).toBe(false);
    expect(parse({ headerName: 'Content-Type', headerValue: 'v' })).toBe(false);
    expect(parse({ headerValue: 'v' })).toBe(false);
    expect(parse({ template: '{"a": {{entries}}, "b": {{ sentAt }}}' })).toBe(true);
    expect(parse({ template: '{"a": {{content}}}' })).toBe(false);
    expect(parse({ format: 'slack' })).toBe(false);
  });
});
