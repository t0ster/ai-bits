import { fromMarkdown } from "mdast-util-from-markdown";

type MarkdownNode =
	| ReturnType<typeof fromMarkdown>
	| ReturnType<typeof fromMarkdown>["children"][number];

function collectLiteralRanges(
	node: MarkdownNode,
	ranges: Map<number, number>,
): void {
	if (
		node.type === "code" ||
		node.type === "inlineCode" ||
		node.type === "html"
	) {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (start !== undefined && end !== undefined) ranges.set(start, end);
		return;
	}
	if ("children" in node) {
		for (const child of node.children) collectLiteralRanges(child, ranges);
	}
}

function findMathCloser(
	markdown: string,
	start: number,
	closer: string,
): number {
	for (let index = start; index < markdown.length; index++) {
		if (markdown.startsWith(closer, index)) return index;
		// A doubled backslash is a LaTeX line break, not a delimiter.
		if (markdown[index] === "\\") index++;
	}
	return -1;
}

/**
 * Normalize LaTeX math delimiters for display only; never rewrite stored messages.
 * Code and existing dollar math are opaque. Unclosed math is closed in this render
 * snapshot so streamed equals signs cannot become Markdown heading underlines.
 */
export function normalizeMathDelimiters(markdown: string): string {
	if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;

	// Source positions preserve fenced, indented, nested, and multi-backtick code
	// without trying to reproduce Markdown's code parsing with regular expressions.
	const literalRanges = new Map<number, number>();
	collectLiteralRanges(fromMarkdown(markdown), literalRanges);
	let normalized = "";
	let index = 0;
	while (index < markdown.length) {
		const literalEnd = literalRanges.get(index);
		if (literalEnd !== undefined) {
			normalized += markdown.slice(index, literalEnd);
			index = literalEnd;
			continue;
		}

		// An unmatched code-span opener may still be streaming. Keep its tail literal.
		if (markdown[index] === "`") {
			normalized += markdown.slice(index);
			break;
		}

		if (markdown.startsWith("$$", index)) {
			const closer = findMathCloser(markdown, index + 2, "$$");
			const end = closer === -1 ? markdown.length : closer + 2;
			normalized += markdown.slice(index, end);
			index = end;
			continue;
		}

		const blockMath = markdown.startsWith("\\[", index);
		if (blockMath || markdown.startsWith("\\(", index)) {
			const closer = findMathCloser(
				markdown,
				index + 2,
				blockMath ? "\\]" : "\\)",
			);
			const end = closer === -1 ? markdown.length : closer;
			const equation = markdown.slice(index + 2, end).trim();
			index = closer === -1 ? markdown.length : closer + 2;
			if (blockMath) {
				normalized += `\n\n$$\n${equation}\n$$\n\n`;
			} else {
				// Dollar runs must not merge with adjacent equations or currency.
				const before = normalized.endsWith("$") ? " " : "";
				const after = markdown[index] === "$" ? " " : "";
				// Newlines after an opening $$ would turn inline math into a fence.
				normalized += `${before}$$${equation.replace(/[\r\n]+/g, " ")}$$${after}`;
			}
			continue;
		}

		// Preserve escaped backslashes and dollar signs before looking for openers.
		const end = index + (markdown[index] === "\\" ? 2 : 1);
		normalized += markdown.slice(index, end);
		index = end;
	}
	return normalized;
}
