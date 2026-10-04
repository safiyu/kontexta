// packages/core/src/decision/engine.ts
/**
 * Decision engine for classification, verdict evaluation, and scoring.
 *
 * Uses the inference runtime to load decision models on demand.
 * All methods return deterministic fallback values on failure.
 */

import { inferenceRuntime } from "../inference/runtime.js";
import type { ModelRuntimeConfig } from "../inference/types.js";
import type {
  ChoiceDecision,
  BinaryVerdict,
  ScoreRating,
} from "./types.js";

/** Default timeout for decision operations (ms). */
const DEFAULT_DECISION_TIMEOUT_MS = 500;

/**
 * Decision model configuration.
 */
const DECISION_MODEL_CONFIG: ModelRuntimeConfig = {
  modelId: "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
  device: "auto",
  timeoutMs: DEFAULT_DECISION_TIMEOUT_MS,
};

class DecisionEngine {
  /**
   * Check if a decision model is available and ready for inference.
   */
  async isAvailable(): Promise<boolean> {
    try {
      // The decision-model inference backends are not implemented yet, so we
      // can never actually score anything. Short-circuit BEFORE touching the
      // model session: getModelSession would otherwise attempt a (potentially
      // remote) model download on every call, from the intent router,
      // event triage, and topic pivot detector alike.
      if (!this.hasInferenceImplementation()) return false;

      const session = await inferenceRuntime.getModelSession(DECISION_MODEL_CONFIG);
      return session.instance !== null;
    } catch {
      return false;
    }
  }

  private hasInferenceImplementation(): boolean {
    return false;
  }

  /**
   * Cheap, I/O-free readiness check: true only when a concrete inference
   * implementation exists. Callers use this to avoid triggering model
   * downloads when there is nothing to run them against.
   */
  private isReady(): boolean {
    return this.hasInferenceImplementation();
  }

  /**
   * Lazily obtain the decision model session (loads on first use).
   */
  private session() {
    return inferenceRuntime.getModelSession(DECISION_MODEL_CONFIG);
  }

  /**
   * Classify context among multiple options.
   *
   * Constructs a prompt asking the model to choose the best option
   * given the context, then returns the selected option with confidence
   * and distribution.
   *
   * @param context - The context to classify
   * @param options - Available options to choose from
   * @returns ChoiceDecision with selected option, confidence, and distribution
   */
  async classifyChoice<T extends string = string>(
    context: string,
    options: T[],
  ): Promise<ChoiceDecision<T>> {
    try {
      // Check if model is loaded
      const session = this.isReady() ? await this.session() : null;

      // Fallback if model is not available
      if (!session?.instance) {
        return {
          selected: options[0] ?? ("unknown" as T),
          confidence: 0.5,
          distribution: Object.fromEntries(options.map((o) => [o, 1 / options.length])) as Record<T, number>,
        };
      }

      // Construct prompt for classification
      const prompt = `Given the following context, which option best describes it?\n\nContext: ${context}\n\nOptions: ${options.join(", ")}`;

      // Attempt inference (structure depends on loaded model)
      const result = await this.withTimeout(
        this.runClassification(session.instance, prompt),
        DEFAULT_DECISION_TIMEOUT_MS,
      );

      if (result) {
        return result as ChoiceDecision<T>;
      }

      // Model ran but returned nothing — fallback
      return {
        selected: options[0] ?? ("unknown" as T),
        confidence: 0.5,
        distribution: Object.fromEntries(options.map((o) => [o, 1 / options.length])) as Record<T, number>,
      };
    } catch {
      // Never throw — return deterministic fallback
      return {
        selected: options[0] ?? ("unknown" as T),
        confidence: 0.5,
        distribution: Object.fromEntries(options.map((o) => [o, 1 / options.length])) as Record<T, number>,
      };
    }
  }

  /**
   * Evaluate a binary verdict on whether context satisfies a question.
   *
   * @param context - The context to evaluate
   * @param question - The question to answer (yes/no)
   * @returns BinaryVerdict with verdict, confidence, and raw logit
   */
  async evaluateVerdict(
    context: string,
    question: string,
  ): Promise<BinaryVerdict> {
    try {
      const session = this.isReady() ? await this.session() : null;

      if (!session?.instance) {
        return { verdict: true, confidence: 0.5, logit: 0 };
      }

      const prompt = `Given the following context, answer the question with yes or no.\n\nContext: ${context}\n\nQuestion: ${question}`;

      const result = await this.withTimeout(
        this.runVerdict(session.instance, prompt),
        DEFAULT_DECISION_TIMEOUT_MS,
      );

      if (result) {
        return result as BinaryVerdict;
      }

      return { verdict: true, confidence: 0.5, logit: 0 };
    } catch {
      return { verdict: true, confidence: 0.5, logit: 0 };
    }
  }

  /**
   * Rate context against criteria on a 0–4 scale.
   *
   * @param context - The context to rate
   * @param criteria - The criteria to rate against
   * @returns ScoreRating with discrete score and continuous calibrated value
   */
  async rateScore(
    context: string,
    criteria: string,
  ): Promise<ScoreRating> {
    try {
      const session = this.isReady() ? await this.session() : null;

      if (!session?.instance) {
        return { score: 2, calibrated: 2.0 };
      }

      const prompt = `Rate the following context on a scale of 0-4 based on these criteria.\n\nContext: ${context}\n\nCriteria: ${criteria}`;

      const result = await this.withTimeout(
        this.runRating(session.instance, prompt),
        DEFAULT_DECISION_TIMEOUT_MS,
      );

      if (result) {
        return result as ScoreRating;
      }

      return { score: 2, calibrated: 2.0 };
    } catch {
      return { score: 2, calibrated: 2.0 };
    }
  }

  /**
   * Run classification inference.
   */
  private async runClassification(
    _instance: unknown,
    _prompt: string,
  ): Promise<ChoiceDecision<string> | undefined> {
    // TODO: Implement actual model inference when a decision model is available.
    // This placeholder returns undefined to trigger fallback.
    return undefined;
  }

  /**
   * Run binary verdict inference.
   */
  private async runVerdict(
    _instance: unknown,
    _prompt: string,
  ): Promise<BinaryVerdict | undefined> {
    // TODO: Implement actual model inference when a decision model is available.
    return undefined;
  }

  /**
   * Run rating inference.
   */
  private async runRating(
    _instance: unknown,
    _prompt: string,
  ): Promise<ScoreRating | undefined> {
    // TODO: Implement actual model inference when a decision model is available.
    return undefined;
  }

  /**
   * Wrap a promise with a hard timeout.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T | undefined> {
    return Promise.race([
      promise,
      new Promise<undefined>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Decision timeout")), timeoutMs);
      }),
    ]);
  }
}

// Export singleton instance
export const decisionEngine = new DecisionEngine();
