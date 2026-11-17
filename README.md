# Newses webhook plugin

A [Newses](https://newses.app) server plugin that calls a user's webhook when their published feed changes: to rebuild a site that reads the feed, for example. Changes within 2 minutes of the first make one call. The call carries the feed's address and the titles and links of the articles that joined or left it, never their content.

## Install

The server's operator installs it at an exact version, as `@newses/plugin-webhook@0.1.0`:

- Docker: add it to `PLUGINS` in `.env` and start with the plugins override ([Self-hosting](https://newses.app/guide/self-hosting#plugins)).
- AWS: add it to the stage's `plugins` in the deployment config, then `scripts/store-deploy-config.sh --apply --release STAGE` ([Plugins](https://newses.app/guide/plugins)).

Then, in Settings > Plugins:

1. An admin turns it on for the server, and approves the host of each webhook under "Approved hosts", such as `api.netlify.com`. It suggests `api.github.com`, `api.netlify.com`, and `api.cloudflare.com`.
2. Each user who wants a webhook turns it on for themselves under "For me", sets it up, saves, and presses "Send test".

Addresses on private networks are refused unless the operator allows them (`FETCH_ALLOW_PRIVATE_NETWORKS`).

## Settings

| Setting                   | What it does                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Address                   | The URL called, on an approved host; stored as a secret, as build hook addresses hold tokens |
| Format                    | Newses JSON (default), Build hook (an empty JSON object), or GitHub repository_dispatch      |
| Method                    | `POST` (default) or `PUT`                                                                    |
| Authorization header      | Sent as `Authorization`, as is, such as `Bearer` and a token; a secret                       |
| Another header, its value | One more header, such as `X-Api-Key`; the value is a secret                                  |
| Body template             | Replaces the body, below                                                                     |
| Signing key               | Signs each call, below; a secret                                                             |

A call answered with anything but a 2xx status fails, and is tried again after 1, 4, 16, and 64 minutes, then 4 and 6 hours. Redirects are not followed: use the address a webhook redirects to. After 10 failures in a row the webhook turns off for that user, and Settings > Plugins says what the last call got back, such as `HTTP 401 Unauthorized`.

## What it sends

Headers: `Content-Type` (`application/json`, or `text/plain; charset=utf-8` for a template that is not JSON), `X-Newses-Event` (`published.changed`, or `test` from "Send test"), and the headers set above.

Newses JSON:

```json
{
  "event": "published.changed",
  "feedUrl": "https://reader.example.com/public/feeds/abc",
  "entries": [
    {
      "id": 4211,
      "published": true,
      "title": "An article",
      "link": "https://news.example/an-article",
      "publishedAt": "2026-11-16T08:00:00.000Z"
    },
    { "id": 4187, "published": false }
  ],
  "sentAt": "2026-11-16T09:02:00.000Z"
}
```

- `feedUrl` is null until the user has a published feed and the server a `PUBLIC_URL`.
- `entries` lists those now in the feed, then the ids of those that left it (or were deleted). Ids are the user's.
- `sentAt` is when the call was made; every attempt is made afresh.
- "Send test" sends `"event": "test"`, with no feed and no entries.

### Body template

A template replaces the body. `{{event}}`, `{{feedUrl}}`, `{{entries}}`, `{{published}}` (how many joined), `{{unpublished}}` (how many left), and `{{sentAt}}` become their values as JSON, quotes included:

```text
{"text": "Published feed changed: {{published}} added, {{unpublished}} removed", "feed": {{feedUrl}}}
```

### Signing

With a signing key, `X-Newses-Signature` is `sha256=` and the HMAC-SHA256 of the body with the key, in hex, as GitHub signs its webhooks. A receiver computes the same over the raw body, compares the two in constant time, and refuses calls whose `sentAt` is old:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = Buffer.from(`sha256=${createHmac('sha256', key).update(rawBody).digest('hex')}`);
const given = Buffer.from(request.headers['x-newses-signature'] ?? '');
const valid = given.length === expected.length && timingSafeEqual(given, expected);
```

## Rebuilding a site

| Host                        | Set up                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Netlify                     | Site configuration > Build & deploy > Build hooks: add one, then use its address with the Build hook format. Approve `api.netlify.com`                                                                                                |
| Cloudflare Pages            | Settings > Builds > Deploy hooks: add one, then use its address with the Build hook format. Approve `api.cloudflare.com`                                                                                                              |
| AWS Amplify                 | App settings > Build settings > Incoming webhooks: create one for the branch, then use its address with the Build hook format. Approve its host, `webhooks.amplify.<region>.amazonaws.com`                                            |
| GitHub Actions              | Format GitHub repository_dispatch, address `https://api.github.com/repos/OWNER/REPO/dispatches`, Authorization `Bearer` and a fine-grained token with the repository's Contents permission (read and write). Approve `api.github.com` |
| AWS CodeBuild, CodePipeline | Through a Lambda function URL, below                                                                                                                                                                                                  |

A GitHub workflow that runs on the dispatch:

```yaml
on:
  repository_dispatch:
    types: [newses-published-feed]
```

The dispatch's `client_payload` holds `event`, `feedUrl`, `published` and `unpublished` (counts), and `sentAt`.

### AWS CodeBuild and CodePipeline

Starting a CodeBuild build (`StartBuild`) or a pipeline (`StartPipelineExecution`) needs AWS SigV4, which the webhook does not sign. A Lambda function behind a function URL does it with its own role, accepting only calls signed with the webhook's key: [examples/aws-build-trigger.mjs](examples/aws-build-trigger.mjs).

1. Create a Lambda function, Node.js 24, with the example as `index.mjs` and the handler `index.handler`.
2. Set its environment: `SIGNING_KEY` (a long random value: `openssl rand -hex 32`), and `CODEBUILD_PROJECT` or `PIPELINE_NAME`.
3. Allow its role `codebuild:StartBuild` on the project or `codepipeline:StartPipelineExecution` on the pipeline.
4. Add a function URL with auth type `NONE`; the signature is the check.
5. In the webhook: the function URL as the address, format Newses JSON, and the same signing key. Approve its host, `<url-id>.lambda-url.<region>.on.aws`.
6. "Send test" answers `HTTP 204`.

## Development

Node 24 and npm: `npm install`, then `npm run check` (lint, typecheck, format check, tests) and `npm run build`. Tests run the hooks as the server does with `@newses/plugin-api/testing`. Releases are version tags (`v1.2.3`), published to npm with provenance by the Publish workflow; the plugin's `version` in `src/index.ts` and `package.json` must match.

## Licence

AGPL-3.0-or-later, as Newses is.
