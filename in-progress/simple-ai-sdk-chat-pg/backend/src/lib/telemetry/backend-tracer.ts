import { trace } from "@opentelemetry/api";

/** Shared application instrumentation scope; uses the globally registered OTel SDK. */
export const tracer = trace.getTracer("@app/backend");
