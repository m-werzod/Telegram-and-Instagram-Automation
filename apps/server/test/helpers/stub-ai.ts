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
