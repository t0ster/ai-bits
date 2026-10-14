import { randomInt } from "node:crypto";
import { chatModelToolSchemas } from "@app/shared";
import { tool } from "ai";

/** Model-callable tools; schemas are shared with the UI message type. */
export const chatModelTools = {
  getCurrentTime: tool({
    ...chatModelToolSchemas.getCurrentTime,
    description: "Get the current date and time in an IANA time zone.",
    execute: ({ timeZone }) => {
      const now = new Date();
      // Throws RangeError for unknown zones; the model receives a tool error.
      const formatted = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(now);
      return { timeZone, iso: now.toISOString(), formatted };
    },
  }),
  rollDice: tool({
    ...chatModelToolSchemas.rollDice,
    description: "Roll one or more dice with the given number of sides.",
    execute: ({ count, sides }) => {
      const rolls = Array.from({ length: count }, () =>
        randomInt(1, sides + 1),
      );
      return { rolls, total: rolls.reduce((sum, roll) => sum + roll, 0) };
    },
  }),
};
