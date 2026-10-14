import { CheckIcon, CircleAlertIcon, WrenchIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { ChatMessage } from "@/lib/chat/types";

type ModelToolPart = Extract<
	ChatMessage["parts"][number],
	{ type: "tool-getCurrentTime" | "tool-rollDice" }
>;

/** Compact view of one model tool call and its result. */
export function ModelToolCall({ part }: { part: ModelToolPart }) {
	const name = part.type.slice("tool-".length);
	return (
		<div className="flex w-fit max-w-full items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
			{part.state === "output-available" ? (
				<CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			) : part.state === "output-error" ? (
				<CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
			) : part.state === "input-streaming" ||
				part.state === "input-available" ? (
				<Spinner className="mt-0.5 size-4 shrink-0" />
			) : (
				<WrenchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			)}
			<div className="min-w-0">
				<code className="font-medium">{name}</code>
				<p className="text-muted-foreground">{describeToolPart(part)}</p>
			</div>
		</div>
	);
}

function describeToolPart(part: ModelToolPart): string {
	if (part.state === "output-error") return part.errorText;
	if (part.state !== "output-available") return "Running…";
	switch (part.type) {
		case "tool-getCurrentTime":
			return part.output.formatted;
		case "tool-rollDice":
			return `${part.output.rolls.join(", ")} (total ${part.output.total})`;
	}
}
