import { getSession, updateSession } from "@tanstack/react-start/server";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 5;
type AppSessionData = {
	userId?: string;
	threadId?: string;
};

function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
	);
}

function appSessionConfig() {
	const password = process.env.SESSION_SECRET;
	if (!password || password.length < 32) {
		throw new Error(
			"Session configuration invalid: set SESSION_SECRET to at least 32 characters.",
		);
	}
	return {
		name: "user-id",
		password,
		maxAge: SESSION_MAX_AGE_SECONDS,
		sessionHeader: false as const,
		cookie: {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax" as const,
			path: "/",
		},
	};
}

/** Returns the anonymous chat user ID from the sealed session, creating one when absent. */
export async function getOrCreateChatUserId(): Promise<string> {
	const session = await getSession<AppSessionData>(appSessionConfig());
	if (isUuid(session.data.userId)) return session.data.userId;
	const userId = crypto.randomUUID();
	await updateSession<AppSessionData>(appSessionConfig(), { userId });
	return userId;
}

/** Reads the selected chat thread ID without making a backend request. */
export async function getSessionThreadId(): Promise<string | undefined> {
	const session = await getSession<AppSessionData>(appSessionConfig());
	return isUuid(session.data.threadId) ? session.data.threadId : undefined;
}

/** Selects or clears the durable chat thread without changing the visitor ID. */
export async function setSessionThreadId(
	threadId: string | null,
): Promise<void> {
	await updateSession<AppSessionData>(appSessionConfig(), {
		threadId: threadId ?? undefined,
	});
}
