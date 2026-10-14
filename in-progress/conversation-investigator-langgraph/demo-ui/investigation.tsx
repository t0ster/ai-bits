import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InvestigationQuestionForm } from "@/components/investigation/investigation-question-form";
import { InvestigationClarificationForm } from "@/components/investigation/investigation-clarification-form";
import { InvestigationProgressView } from "@/components/investigation/investigation-progress";
import { InvestigationReportView } from "@/components/investigation/investigation-report";
import { useInvestigation } from "@/lib/use-investigation";
import type { InvestigationState } from "@/lib/use-investigation";
import { chatPath, investigationPath, replacePath } from "@/lib/routes";

/** Investigation page reuses backend operations; URL identity survives reload without resubmission. */
export function Investigation({
  investigationId,
}: {
  readonly investigationId: string | null;
}) {
  const investigation = useInvestigation(investigationId, {
    onCreated: (id) => replacePath(investigationPath(id)),
  });
  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-5 py-8 sm:px-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Conversation investigator · Demo
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Investigate your conversations
          </h1>
        </div>
        <nav className="flex gap-2" aria-label="Demo navigation">
          <Button variant="ghost" asChild>
            <a href={chatPath()}>Chat demo</a>
          </Button>
          <Button variant="outline" asChild>
            <a href={investigationPath()}>New investigation</a>
          </Button>
        </nav>
      </header>
      {investigation.status === "new" ? (
        <div className="space-y-5">
          {investigation.error && (
            <SubmissionError message={investigation.error.message} />
          )}
          <InvestigationQuestionForm
            disabled={investigation.submitting}
            submitting={investigation.submitting}
            onSubmit={investigation.start}
          />
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-4">
            {investigation.status !== "loading" && investigation.snapshot ? (
              <InvestigationProgressView
                snapshot={investigation.snapshot}
                status={investigation.status}
              />
            ) : (
              <p role="status">Loading investigation…</p>
            )}
            <p className="break-all text-xs text-muted-foreground">
              Investigation: {investigation.id}
            </p>
            <p className="text-xs text-muted-foreground">
              You can refresh or bookmark this page. Accepted work continues in
              the background.
            </p>
          </aside>
          <section
            className="min-w-0 space-y-5"
            aria-label="Investigation outcome"
          >
            <InvestigationOutcome investigation={investigation} />
          </section>
        </div>
      )}
    </main>
  );
}

function InvestigationOutcome({
  investigation,
}: {
  readonly investigation: Exclude<InvestigationState, { status: "new" }>;
}) {
  switch (investigation.status) {
    case "loading":
      return null;
    case "running":
      return investigation.live ? (
        <Alert>
          <AlertTitle>Investigation in progress</AlertTitle>
          <AlertDescription>
            Searching and reading conversations, then checking the evidence. The
            report will appear here.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>Investigation running in the background</AlertTitle>
          <AlertDescription>
            Live updates are not connected. Refresh the page to check progress.
          </AlertDescription>
        </Alert>
      );
    case "awaiting-reply":
      return (
        <>
          {investigation.error && (
            <SubmissionError message={investigation.error.message} />
          )}
          <InvestigationClarificationForm
            question={investigation.question}
            disabled={investigation.submitting}
            submitting={investigation.submitting}
            onSubmit={investigation.reply}
          />
        </>
      );
    case "completed":
      return <InvestigationReportView report={investigation.report} />;
    case "failed":
      return (
        // TODO: Add Retry for failed investigations once the backend supports
        // it (see TODO in packages/investigation/jobs.py).
        <Alert variant="destructive">
          <AlertTitle>Investigation stopped</AlertTitle>
          <AlertDescription>{investigation.error.message}</AlertDescription>
        </Alert>
      );
  }
}

function SubmissionError({ message }: { readonly message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Submission not accepted</AlertTitle>
      <AlertDescription>{message} You can submit again.</AlertDescription>
    </Alert>
  );
}
