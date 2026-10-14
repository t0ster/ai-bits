import { SpanStatusCode } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Normalizes explicit stream failures before any exporter sees the completed span. */
export class ModelStreamStatusProcessor implements SpanProcessor {
  /** Uses the pinned SDK's onEnding hook while span status is still mutable. */
  onEnding(span: Span): void {
    const finishReasons = span.attributes["gen_ai.response.finish_reasons"];
    if (
      span.attributes["gen_ai.operation.name"] !== "chat" ||
      !Array.isArray(finishReasons) ||
      !finishReasons.some((reason) => reason === "error") ||
      span.status.code === SpanStatusCode.ERROR
    ) {
      return;
    }
    const status = {
      code: SpanStatusCode.ERROR,
      message: "Model stream finished with an error.",
    };
    span.setStatus(status);
  }

  /** No start-time state is retained. */
  onStart(): void {}
  /** Exporters registered after this processor own delivery. */
  onEnd(): void {}
  /** This processor has no buffered work. */
  async forceFlush(): Promise<void> {}
  /** This processor owns no resources. */
  async shutdown(): Promise<void> {}
}
