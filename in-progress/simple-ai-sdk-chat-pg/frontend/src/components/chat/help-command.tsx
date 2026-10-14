import { Button } from "@/components/ui/button";

const examplePrompts = [
	"What time is it in Tokyo?",
	"Roll 3 six-sided dice.",
	"Explain durable chat threads in two sentences.",
];

/** Static `/help` command output; rendered without a model call. */
export function HelpCommand({
	onFollowUp,
	disabled,
}: {
	onFollowUp: (prompt: string) => void;
	disabled: boolean;
}) {
	return (
		<div className="space-y-3">
			<p className="font-medium">Simple AI SDK Chat</p>
			<ul className="list-disc space-y-1 pl-5 text-muted-foreground">
				<li>Threads persist in Postgres and survive reloads.</li>
				<li>
					The model can call <code>getCurrentTime</code> and{" "}
					<code>rollDice</code>.
				</li>
				<li>Failed responses can be retried in place.</li>
				<li>
					<code>/help</code> is answered by the backend without the model.
				</li>
			</ul>
			<div className="flex flex-wrap gap-2">
				{examplePrompts.map((prompt) => (
					<Button
						disabled={disabled}
						key={prompt}
						onClick={() => onFollowUp(prompt)}
						size="sm"
						variant="outline"
					>
						{prompt}
					</Button>
				))}
			</div>
		</div>
	);
}
