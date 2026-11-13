import type {
  AIProvider,
  GenerateResult,
  GenerateStructuredParams,
} from '../../src/modules/ai/provider.js';
import type { AgentDecision } from '../../src/modules/engine/decision.js';
import { setAIForTesting } from '../../src/modules/ai/index.js';

export function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reply: 'Hello! How can I help?',
    detectedLanguage: 'en',
    intent: 'question',
    sentiment: 'neutral',
    isSpamOrIrrelevant: false,
    leadUpdate: null,
    leadStatusSuggestion: null,
    leadScore: null,
    tags: [],
    shouldEscalate: false,
    escalationReason: null,
    internalNote: null,
    courseRegistration: null,
    sendPrivateReply: false,
    privateReplyText: null,
    sendImageId: null,
    ...overrides,
  };
}

/** Deterministic AI provider for tests. Mocks are test-only (spec §41). */
export class StubAIProvider implements AIProvider {
  readonly name = 'anthropic';
  calls: GenerateStructuredParams<unknown>[] = [];
  private queue: Array<Partial<AgentDecision>> = [];
  refuseNext = false;

  respondWith(decision: Partial<AgentDecision>): void {
    this.queue.push(decision);
  }

  /**
   * Forget everything from the previous test.
   *
   * Without this the stub is shared state across a whole file: recorded calls
   * accumulate, so `expect(ai.calls).toHaveLength(0)` fails on the first test
   * that follows one which answered anything, and — worse — a queued response
   * that the previous test never consumed is served to the NEXT test, which
   * then asserts against an answer it did not ask for. Six of the nine
   * end-to-end flow tests were failing for exactly that reason, including both
   * Instagram flows, which is how the integration suite stopped being able to
   * catch an Instagram regression at all.
   */
  reset(): void {
    this.calls = [];
    this.queue = [];
    this.refuseNext = false;
  }

  async generateStructured<T>(params: GenerateStructuredParams<T>): Promise<GenerateResult<T>> {
    this.calls.push(params as GenerateStructuredParams<unknown>);
    if (this.refuseNext) {
      this.refuseNext = false;
      return {
        output: undefined as T,
        model: 'stub',
        usage: { inputTokens: 10, outputTokens: 0 },
        refused: true,
        refusalReason: 'stub refusal',
      };
    }
    const next = this.queue.shift() ?? {};
    const decision = makeDecision(next);
    const validated = params.schema.parse(decision);
    return {
      output: validated,
      model: 'stub-model',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}

export function installStubAI(): StubAIProvider {
  const stub = new StubAIProvider();
  setAIForTesting({ providers: { anthropic: stub }, embeddings: null });
  return stub;
}
