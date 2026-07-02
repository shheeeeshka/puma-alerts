import { config } from "dotenv";

config();

const allowedWaitUntil = [
  "load",
  "domcontentloaded",
  "networkidle0",
  "networkidle2",
];

export const CONFIG = {
  autoAssign: process.env.AUTO_ASSIGN !== "0",
  sprintWhitelist: process.env.SPRINT_WHITELIST
    ? process.env.SPRINT_WHITELIST.split(",").map((s) => s.trim())
    : [],
  maxTasks: parseInt(process.env.MAX_TASKS) || 4,
  targetBoardUrl: process.env.TARGET_BOARD_URL,
  taskWidgetTitle: process.env.TASK_WIDGET_TITLE?.trim() || "Обычные задачи",
  navigationWaitUntil: allowedWaitUntil.includes(
    process.env.NAVIGATION_WAIT_UNTIL
  )
    ? process.env.NAVIGATION_WAIT_UNTIL
    : "domcontentloaded",
  navigationTimeoutMs: parseInt(process.env.NAVIGATION_TIMEOUT_MS, 10) || 30000,
  userAgent:
    process.env.USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export default CONFIG;
