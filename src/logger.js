import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  messageKey: "message",
  encoding: "utf-8",
});

export default logger;
