import { definePlugin, multiline, secret, url } from '@newses/plugin-api';
import { z } from 'zod';
import {
  GITHUB_EVENT_TYPE,
  payloadOf,
  type RequestSettings,
  requestOf,
  statusText,
  TEMPLATE_FIELDS,
  unknownPlaceholders,
} from './request.js';

/** Changes within this many seconds of the first make one call. */
export const DEBOUNCE_SECONDS = 120;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the webhook sets itself, or that the request's framing owns. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  'transfer-encoding',
  'x-newses-event',
  'x-newses-signature',
]);

/** Each user's webhook. */
export const userSettings = z
  .object({
    url: url({ secret: true }),
    format: z.enum(['json', 'buildHook', 'github']).default('json'),
    method: z.enum(['POST', 'PUT']).default('POST'),
    authorization: secret().optional(),
    headerName: z
      .string()
      .max(100)
      .regex(HEADER_NAME, 'a header name, such as X-Api-Key')
      .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), 'a header the webhook sets')
      .optional(),
    headerValue: secret().optional(),
    template: multiline()
      .refine((template) => unknownPlaceholders(template).length === 0, {
        message: `placeholders are ${TEMPLATE_FIELDS.map((field) => `{{${field}}}`).join(', ')}`,
      })
      .optional(),
    signingKey: secret().optional(),
  })
  .refine((settings) => !settings.headerValue || settings.headerName, {
    message: 'a header value needs a header name',
    path: ['headerName'],
  });

/** Calls `settings.url` with the payload; returns the response, its body discarded. */
async function call(
  fetch: typeof globalThis.fetch,
  settings: RequestSettings,
  payload: Parameters<typeof requestOf>[1],
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(settings.url, { ...requestOf(settings, payload), signal });
  await response.body?.cancel();
  return response;
}

/** Why a response is not a success, for the user's settings. */
const failureOf = (response: Response) =>
  response.status >= 300 && response.status < 400
    ? `${statusText(response)}: redirects are not followed, so use the address it redirects to`
    : statusText(response);

/**
 * Calls a user's webhook when their published feed changes, 2 minutes after the first change,
 * with every change since: to rebuild a site that reads the feed, for example. A call answered
 * other than 2xx fails and is retried.
 */
export default definePlugin({
  id: 'webhook',
  // Keep in step with package.json; a test checks they match.
  version: '0.1.2',
  apiVersion: '^0.1',
  scopes: ['user'],
  hosts: ['api.github.com', 'api.netlify.com', 'api.cloudflare.com'],
  settings: { user: userSettings },
  messages: {
    en: {
      name: 'Webhook',
      description:
        'Calls an address of yours, on a host an admin approved, when your published feed changes: with the feed’s address and the titles and links of the articles that joined or left it, never their content.',
      'settings.url': 'Address',
      'settings.url.hint':
        'Called 2 minutes after your published feed changes. Stored as a secret, as build hook addresses hold tokens.',
      'settings.format': 'Format',
      'settings.format.hint': 'What the call sends, unless a body template replaces it.',
      'settings.format.option.json': 'Newses JSON: the feed and the articles that changed',
      'settings.format.option.buildHook':
        'Build hook: an empty JSON object (Netlify, Cloudflare Pages, AWS Amplify)',
      'settings.format.option.github': `GitHub repository_dispatch (${GITHUB_EVENT_TYPE})`,
      'settings.method': 'Method',
      'settings.authorization': 'Authorization header',
      'settings.authorization.hint': 'Sent as is, such as Bearer and a token; stored as a secret.',
      'settings.headerName': 'Another header',
      'settings.headerName.hint': 'The name of a header to send, such as X-Api-Key.',
      'settings.headerValue': 'Its value',
      'settings.headerValue.hint': 'Stored as a secret.',
      'settings.template': 'Body template',
      'settings.template.hint': `Replaces the body. ${TEMPLATE_FIELDS.map((field) => `{{${field}}}`).join(', ')} become their values as JSON.`,
      'settings.signingKey': 'Signing key',
      'settings.signingKey.hint':
        'Signs each call: X-Newses-Signature is sha256= and the HMAC-SHA256 of the body, in hex.',
    },
  },
  hooks: {
    'published.changed': {
      debounceSeconds: DEBOUNCE_SECONDS,
      async run(event, context) {
        const settings = context.userSettings;
        if (!settings) return;
        const response = await call(
          context.fetch,
          settings,
          payloadOf(event, new Date()),
          context.signal,
        );
        if (!response.ok) throw new Error(failureOf(response));
      },
    },
    test: {
      async run(context) {
        const settings = context.userSettings;
        if (!settings) return { ok: false, message: 'No webhook is set up' };
        const response = await call(
          context.fetch,
          settings,
          { event: 'test', feedUrl: null, entries: [], sentAt: new Date().toISOString() },
          context.signal,
        );
        return {
          ok: response.ok,
          message: response.ok ? statusText(response) : failureOf(response),
        };
      },
    },
  },
});
