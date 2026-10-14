"use client";

import type { ComponentProps, ReactElement } from "react";
import { cn } from "@/lib/utils";

const DOT_DELAYS = ["-0.32s", "-0.16s", "0s"];

/** Shows the assistant typing indicator; callers own when it mounts and unmounts. */
export function TypingIndicator({
	variant = "bubble",
	className,
	...props
}: Omit<
	ComponentProps<"div">,
	"children" | "variant" | "role" | "aria-label"
> & {
	variant?: "bubble" | "bare";
}): ReactElement {
	const dots = DOT_DELAYS.map((delay) => (
		<span
			key={delay}
			aria-hidden
			className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
			style={{ animationDelay: delay, animationDuration: "1.1s" }}
		/>
	));

	if (variant === "bare") {
		return (
			<div
				data-slot="typing-indicator"
				data-variant="bare"
				role="status"
				aria-label="Assistant is typing"
				className={cn("flex gap-1", className)}
				{...props}
			>
				{dots}
			</div>
		);
	}

	return (
		<div
			data-slot="typing-indicator"
			data-variant="bubble"
			className={cn("w-fit rounded-lg bg-secondary px-4 py-3.5", className)}
			{...props}
		>
			<div
				role="status"
				aria-label="Assistant is typing"
				className="flex gap-1"
			>
				{dots}
			</div>
		</div>
	);
}
