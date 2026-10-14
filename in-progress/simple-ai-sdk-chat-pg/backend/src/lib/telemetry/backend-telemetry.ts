import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOnSampler,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";
import { ModelStreamStatusProcessor } from "./model-stream-status-processor";

/** Start tracing before loading database/application modules; the server owns shutdown. */
export function startBackendTelemetry(environment: NodeJS.ProcessEnv): {
  shutdown: () => Promise<void>;
} {
  // Credentials stay inside the SDK; deployments without Langfuse keep general tracing.
  const langfuseProcessors =
    environment.LANGFUSE_PUBLIC_KEY && environment.LANGFUSE_SECRET_KEY
      ? [new LangfuseSpanProcessor()]
      : [];
  const sdk = new NodeSDK({
    // This backend exports traces only; SDK defaults otherwise start OTLP metrics/logs.
    metricReaders: [],
    logRecordProcessors: [],
    resource: resourceFromAttributes({
      "service.name": "simple-ai-sdk-chat-pg",
      "deployment.environment.name": environment.NODE_ENV ?? "development",
    }),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      new ModelStreamStatusProcessor(),
      // General OTel traces print to stdout; Langfuse receives them only when configured.
      new SimpleSpanProcessor(new ConsoleSpanExporter()),
      ...langfuseProcessors,
    ],
    instrumentations: [
      new PgInstrumentation({
        enhancedDatabaseReporting: false,
        // Trace database work belonging to a request/turn, not unparented startup work.
        requireParentSpan: true,
      }),
    ],
  });
  sdk.start();
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
  return { shutdown: () => sdk.shutdown() };
}
