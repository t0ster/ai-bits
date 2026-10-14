import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** Start from a natural-language question; dates can be clarified afterward. */
export function InvestigationQuestionForm({
  onSubmit,
  disabled,
  submitting,
}: {
  onSubmit: (question: string) => void;
  disabled: boolean;
  submitting: boolean;
}) {
  const [question, setQuestion] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>What would you like to investigate?</CardTitle>
        <CardDescription>
          Search support conversations and get findings backed by exact quotes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim()) onSubmit(question.trim());
          }}
        >
          <Label htmlFor="investigation-question">Question</Label>
          <Textarea
            id="investigation-question"
            placeholder="Find two examples of delayed refunds and explain what caused the delays."
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={disabled}
            rows={4}
          />
          <p className="text-sm text-muted-foreground">
            Include dates and optional agent or team IDs. Missing dates will
            prompt a clarification.
          </p>
          <Button disabled={disabled || !question.trim()}>
            {submitting ? "Submitting…" : "Start investigation"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
