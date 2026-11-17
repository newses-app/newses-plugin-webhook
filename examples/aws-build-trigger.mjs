// A Lambda function, behind a function URL, that receives the webhook and starts an AWS CodeBuild
// project or CodePipeline pipeline, which need AWS SigV4 the webhook cannot sign. It accepts only
// calls signed with the webhook's signing key, in the Newses JSON format, sent in the last
// 5 minutes. Environment: SIGNING_KEY, and CODEBUILD_PROJECT or PIPELINE_NAME (or both).
// Runtime: Node.js 24, whose AWS SDK provides both clients.
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { CodePipelineClient, StartPipelineExecutionCommand } from '@aws-sdk/client-codepipeline';

const { SIGNING_KEY = '', CODEBUILD_PROJECT, PIPELINE_NAME } = process.env;
const MAX_AGE_MS = 5 * 60 * 1000;

const signed = (body, given) => {
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', SIGNING_KEY).update(body).digest('hex')}`,
  );
  const actual = Buffer.from(given ?? '');
  return (
    SIGNING_KEY !== '' && actual.length === expected.length && timingSafeEqual(actual, expected)
  );
};

export async function handler(request) {
  const body = request.isBase64Encoded
    ? Buffer.from(request.body ?? '', 'base64').toString('utf8')
    : (request.body ?? '');
  if (!signed(body, request.headers?.['x-newses-signature'])) return { statusCode: 401 };
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { statusCode: 400 };
  }
  // Each attempt is signed afresh, so retries pass; an old call replayed does not.
  if (!(Math.abs(Date.now() - Date.parse(payload.sentAt)) <= MAX_AGE_MS))
    return { statusCode: 400 };
  if (payload.event === 'test') return { statusCode: 204 };
  if (CODEBUILD_PROJECT)
    await new CodeBuildClient({}).send(new StartBuildCommand({ projectName: CODEBUILD_PROJECT }));
  if (PIPELINE_NAME)
    await new CodePipelineClient({}).send(
      new StartPipelineExecutionCommand({ name: PIPELINE_NAME }),
    );
  return { statusCode: 202 };
}
