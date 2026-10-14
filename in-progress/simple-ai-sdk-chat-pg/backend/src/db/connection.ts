import { drizzle } from "drizzle-orm/node-postgres";
import { err, errAsync, ResultAsync } from "neverthrow";
import pg from "pg";
import { config } from "@/config";
import { type ChatResult, type ChatResultAsync, chatError } from "@/errors";
import { messages, threads } from "./schema";

const postgres = new pg.Pool({ connectionString: config.databaseUrl });
// Idle connection errors have no request/span owner. pg discards the failed
// client; handling its error event keeps a database restart from killing chat.
postgres.on("error", () => {
  console.error("Chat database idle connection failed; client discarded.");
});

/** Drizzle client for the chat database. */
export const db = drizzle(postgres, {
  schema: { threads, messages },
});

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseTransactionConfig = Parameters<typeof db.transaction>[1];

class DatabaseTransactionCallbackDefect {
  constructor(readonly cause: unknown) {}
}

/** Runs a database operation and converts failures to chat errors. */
export function query<T>(operation: () => PromiseLike<T>): ChatResultAsync<T> {
  return ResultAsync.fromThrowable(
    async () => await operation(),
    chatError.anyError,
  )();
}

/** Runs a database transaction without swallowing callback defects. */
export function transaction<T, E>(
  callback: (transaction: DatabaseTransaction) => Promise<ChatResult<T, E>>,
  transactionConfig?: DatabaseTransactionConfig,
): ChatResultAsync<T, E> {
  const guardedCallback = async (
    transaction: DatabaseTransaction,
  ): Promise<ChatResult<T, E>> => {
    try {
      return await callback(transaction);
    } catch (cause) {
      throw new DatabaseTransactionCallbackDefect(cause);
    }
  };

  let transactionPromise: Promise<ChatResult<T, E>>;
  try {
    transactionPromise =
      transactionConfig === undefined
        ? db.transaction(guardedCallback)
        : db.transaction(guardedCallback, transactionConfig);
  } catch (cause) {
    return errAsync(chatError.anyError(cause));
  }

  const classifiedPromise: Promise<ChatResult<T, E>> = transactionPromise.then(
    (result): ChatResult<T, E> => result,
    (cause): ChatResult<T> => {
      if (cause instanceof DatabaseTransactionCallbackDefect) {
        throw cause.cause;
      }
      return err(chatError.anyError(cause));
    },
  );

  return ResultAsync.fromSafePromise(classifiedPromise).andThen(
    (result) => result,
  );
}

/** Closes the chat database connection. */
export function closeChatDatabase(): ChatResultAsync<void> {
  return query(() => postgres.end()).map(() => undefined);
}
