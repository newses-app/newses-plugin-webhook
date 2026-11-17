import { createHmac } from 'node:crypto';
import type { PublishedChangedEvent } from '@newses/plugin-api';

/** How the body is made: Newses' JSON, an empty JSON object for build hooks, or GitHub's dispatch. */
export type Format = 'json' | 'buildHook' | 'github';

/** The settings that shape a request. */
export interface RequestSettings {
  url: string;
  method: 'POST' | 'PUT';
  format: Format;
  authorization?: string | undefined;
  headerName?: string | undefined;
  headerValue?: string | undefined;
  template?: string | undefined;
  signingKey?: string | undefined;
}

/** An entry that changed: those published with their title and link, those gone by id. */
export type ChangedEntry =
  | { id: number; published: true; title: string; link: string | null; publishedAt: string }
  | { id: number; published: false };

/** What a call says, before it becomes a body. */
export interface Payload {
  event: 'published.changed' | 'test';
  /** The user's published feed, once they have one and the server a public address. */
  feedUrl: string | null;
  entries: ChangedEntry[];
  /** When the call was made (ISO 8601); a receiver can refuse old ones. */
  sentAt: string;
}

/** The event GitHub `repository_dispatch` runs workflows for. */
export const GITHUB_EVENT_TYPE = 'newses-published-feed';

/** The placeholders a body template may use, each replaced by its value as JSON. */
export const TEMPLATE_FIELDS = [
  'event',
  'feedUrl',
  'entries',
  'published',
  'unpublished',
  'sentAt',
] as const;

const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

/** The placeholders in a template that are not fields. */
export function unknownPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1] ?? '')
    .filter((name) => !(TEMPLATE_FIELDS as readonly string[]).includes(name));
}

/** A published.changed event as a payload; content never leaves the server. */
export function payloadOf(event: PublishedChangedEvent, now: Date): Payload {
  return {
    event: 'published.changed',
    feedUrl: event.feedUrl,
    entries: [
      ...event.published.map((entry) => ({
        id: entry.id,
        published: true as const,
        title: entry.title,
        link: entry.link,
        publishedAt: entry.publishedAt,
      })),
      ...event.unpublished.map((id) => ({ id, published: false as const })),
    ],
    sentAt: now.toISOString(),
  };
}

/** The template with each placeholder replaced by its value as JSON. */
export function renderTemplate(template: string, payload: Payload): string {
  const values: Record<(typeof TEMPLATE_FIELDS)[number], unknown> = {
    event: payload.event,
    feedUrl: payload.feedUrl,
    entries: payload.entries,
    published: payload.entries.filter((entry) => entry.published).length,
    unpublished: payload.entries.filter((entry) => !entry.published).length,
    sentAt: payload.sentAt,
  };
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    name in values ? JSON.stringify(values[name as keyof typeof values]) : whole,
  );
}

/** The body: the template's when there is one, else the format's. */
export function bodyOf(settings: RequestSettings, payload: Payload): string {
  if (settings.template) return renderTemplate(settings.template, payload);
  switch (settings.format) {
    case 'buildHook':
      return '{}';
    case 'github':
      return JSON.stringify({
        event_type: GITHUB_EVENT_TYPE,
        client_payload: {
          event: payload.event,
          feedUrl: payload.feedUrl,
          published: payload.entries.filter((entry) => entry.published).length,
          unpublished: payload.entries.filter((entry) => !entry.published).length,
          sentAt: payload.sentAt,
        },
      });
    case 'json':
      return JSON.stringify(payload);
  }
}

const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** `sha256=` and the HMAC-SHA256 of the body with the key, in hex, as GitHub signs its webhooks. */
export const signature = (key: string, body: string) =>
  `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

/** The request a call makes: method, headers, and body. */
export function requestOf(settings: RequestSettings, payload: Payload): RequestInit {
  const body = bodyOf(settings, payload);
  const headers = new Headers({
    'Content-Type': isJson(body) ? 'application/json' : 'text/plain; charset=utf-8',
    'X-Newses-Event': payload.event,
  });
  if (settings.format === 'github') {
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
  }
  if (settings.headerName && settings.headerValue)
    headers.set(settings.headerName, settings.headerValue);
  if (settings.authorization) headers.set('Authorization', settings.authorization);
  if (settings.signingKey) headers.set('X-Newses-Signature', signature(settings.signingKey, body));
  return { method: settings.method, headers, body, redirect: 'manual' };
}

/** A response as people read it: `HTTP 204 No Content`. */
export const statusText = (response: Response) =>
  `HTTP ${String(response.status)}${response.statusText ? ` ${response.statusText}` : ''}`;
