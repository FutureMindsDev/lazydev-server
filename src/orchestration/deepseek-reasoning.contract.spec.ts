/**
 * Copyright (c) 2026 FutureMindsDev. All rights reserved.
 *
 * LazyDev™ is a trademark of FutureMindsDev.
 * Organization : https://github.com/FutureMindsDev
 *
 * Authors:
 *   Arkar Chan Myae  <https://github.com/arkar-chanmyae>
 *   Khin Me Me Latt  <https://github.com/KhinMeMeLatt>
 *
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 */

/* eslint-disable */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { LlmService } from './llm.service';

/**
 * Contract test against a mock DeepSeek server. The real API runs
 * deepseek-flash with thinking mode on and rejects any request whose
 * assistant history is missing the `reasoning_content` field — including
 * when the value is an empty string. This test pins that wire contract so a
 * future @langchain/* upgrade (or a regression in our converter patch) fails
 * in CI rather than in production after a patch-gate retry.
 */
describe('DeepSeek reasoning_content contract (mock server)', () => {
  const ENV_KEYS = [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'LLM_MODEL',
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  let server: http.Server;
  let requests: any[];

  const listen = () =>
    new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  beforeAll(async () => {
    requests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const payload = JSON.parse(body);
        requests.push(payload);

        const invalid = (payload.messages ?? []).find(
          (message: any) =>
            message.role === 'assistant' &&
            !Object.prototype.hasOwnProperty.call(
              message,
              'reasoning_content',
            ),
        );
        if (invalid) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message:
                  'The `reasoning_content` in the thinking mode must be passed back to the API.',
                type: 'invalid_request_error',
              },
            }),
          );
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-contract',
            object: 'chat.completion',
            created: 0,
            model: 'deepseek-flash',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'done',
                  reasoning_content: 'mock reasoning',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await listen();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    const { port } = server.address() as AddressInfo;
    process.env.OPENAI_API_KEY = 'test-deepseek-key';
    // detectProviderKind routes any URL containing "deepseek" to ChatDeepSeek.
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/deepseek`;
    process.env.LLM_MODEL = 'deepseek-flash';
    requests = [];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('echoes an empty-string reasoning_content on the retry payload', async () => {
    const model = new LlmService().getModel();
    const assistant = new AIMessage({
      content: 'Previous final summary.',
      additional_kwargs: { reasoning_content: '' },
    });

    const response = await model.invoke([
      new HumanMessage('Continue the patch.'),
      assistant,
    ]);

    expect(response.content).toBe('done');
    const sentAssistant = requests[0].messages.find(
      (message: any) => message.role === 'assistant',
    );
    expect(sentAssistant).toHaveProperty('reasoning_content', '');
  });

  it('echoes non-empty reasoning_content unchanged', async () => {
    const model = new LlmService().getModel();
    const assistant = new AIMessage({
      content: 'Previous final summary.',
      additional_kwargs: { reasoning_content: 'previous chain of thought' },
    });

    await model.invoke([
      new HumanMessage('Continue the patch.'),
      assistant,
    ]);

    const sentAssistant = requests[0].messages.find(
      (message: any) => message.role === 'assistant',
    );
    expect(sentAssistant.reasoning_content).toBe('previous chain of thought');
  });

  it('fails with a 400 when an assistant turn genuinely lacks reasoning_content', async () => {
    const model = new LlmService().getModel();
    const assistant = new AIMessage({ content: 'Synthesized turn.' });

    await expect(
      model.invoke([new HumanMessage('Continue the patch.'), assistant]),
    ).rejects.toThrow(/reasoning_content/);
  });
});
