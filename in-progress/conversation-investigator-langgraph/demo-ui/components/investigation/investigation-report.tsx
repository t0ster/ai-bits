import type { InvestigationReport as Report } from "@/lib/investigation-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";

/** Render persisted findings and verbatim citations without interpreting source text as HTML. */
export function InvestigationReportView({ report }: { report: Report }) {
  return (
    <section className="space-y-5" aria-label="Investigation report">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Investigation report</CardTitle>
            <Badge variant="secondary">Complete</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap leading-relaxed">
            {report.summary}
          </p>
        </CardContent>
      </Card>
      {report.findings.length === 0 && (
        <p className="text-muted-foreground">
          No supported findings for this scope.
        </p>
      )}
      {report.findings.map((finding, index) => (
        <Card key={`${index}-${finding.title}`}>
          <CardHeader>
            <CardTitle>
              {index + 1}. {finding.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="whitespace-pre-wrap leading-relaxed">
              {finding.explanation}
            </p>
            <Accordion type="multiple">
              {finding.citations.map((citation, citationIndex) => (
                <AccordionItem
                  key={`${citation.conversation_id}-${citationIndex}`}
                  value={`citation-${citationIndex}`}
                >
                  <AccordionTrigger>
                    Evidence {citationIndex + 1} · {citation.conversation_id}
                  </AccordionTrigger>
                  <AccordionContent className="space-y-3">
                    <blockquote className="whitespace-pre-wrap border-l-2 pl-4 leading-relaxed">
                      {citation.quote}
                    </blockquote>
                    <p className="break-all text-xs text-muted-foreground">
                      Entries: {citation.transcript_entry_ids.join(", ")}
                    </p>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
