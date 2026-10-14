import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Answer one specific saved interruption; submitting never creates a new investigation. */
export function InvestigationClarificationForm({
  question,
  disabled,
  submitting,
  onSubmit,
}: {
  question: string;
  disabled: boolean;
  submitting: boolean;
  onSubmit: (reply: string) => void;
}) {
  const [reply, setReply] = useState("");
  return (
    <Card className="border-amber-300">
      <CardHeader>
        <CardTitle>A little more detail</CardTitle>
        <CardDescription>{question}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (reply.trim()) onSubmit(reply.trim());
          }}
        >
          <Label htmlFor="clarification-reply">Your answer</Label>
          <Input
            id="clarification-reply"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            disabled={disabled}
            placeholder="For example, September 2026"
          />
          <Button disabled={disabled || !reply.trim()}>
            {submitting ? "Submitting…" : "Continue investigation"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
