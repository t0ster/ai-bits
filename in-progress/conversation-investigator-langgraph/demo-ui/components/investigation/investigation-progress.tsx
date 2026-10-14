import type { InvestigationSnapshot } from "@/lib/investigation-api";
import type { InvestigationState } from "@/lib/use-investigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const stepNames: Readonly<
  Record<NonNullable<InvestigationSnapshot["next"]>, string>
> = {
  initialize: "Initializing investigation",
  interpret: "Resolving scope",
  clarify: "Waiting for your answer",
  investigate: "Choosing next step",
  search: "Searching conversations",
  read: "Reading evidence",
  draft: "Drafting report",
  validate: "Checking citations",
};

function investigationStatusLabel(
  status: InvestigationState["status"],
  snapshot: InvestigationSnapshot,
): string {
  switch (status) {
    case "failed":
      return "Failed";
    case "completed":
      return "Complete";
    case "awaiting-reply":
      return "Needs your input";
    default:
      if (snapshot.interrupts.length) return "Processing your reply";
      return snapshot.next ? stepNames[snapshot.next] : "Running";
  }
}

/** Show graph progress and an expandable native-state inspector for this prototype. */
export function InvestigationProgressView({
  snapshot,
  status,
}: {
  snapshot: InvestigationSnapshot;
  status: InvestigationState["status"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Progress</CardTitle>
        <div role="status" aria-live="polite">
          <Badge variant="secondary">
            {investigationStatusLabel(status, snapshot)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {snapshot.values.question && (
          <p className="text-sm">{snapshot.values.question}</p>
        )}
        {snapshot.values.scope && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>{snapshot.values.scope.query}</p>
            <p>
              {snapshot.values.scope.time_range.start.slice(0, 10)} →{" "}
              {snapshot.values.scope.time_range.end.slice(0, 10)} (end
              exclusive)
            </p>
            {snapshot.values.scope.agent_id && (
              <p>Agent: {snapshot.values.scope.agent_id}</p>
            )}
            {snapshot.values.scope.team_id && (
              <p>Team: {snapshot.values.scope.team_id}</p>
            )}
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {snapshot.values.search_history?.length ?? 0} searches ·{" "}
          {snapshot.values.read_conversations?.length ?? 0} conversations read
        </p>
        <Accordion type="single" collapsible>
          <AccordionItem value="snapshot">
            <AccordionTrigger>Inspect graph state</AccordionTrigger>
            <AccordionContent>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(snapshot, null, 2)}
              </pre>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
