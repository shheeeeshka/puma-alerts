import os from "os";
import fs from "fs";
import logger from "./logger.js";

export const sleep = (sec = 0) =>
  new Promise((resolve) => setTimeout(resolve, sec * 1000));

export const getFormattedDate = () => {
  const now = new Date();
  return now.toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 19);
};

export const isRunningOnHosting = () => {
  return (
    !!process.env.HOSTING ||
    !!process.env.PWD?.includes("home") ||
    os.hostname().includes("host") ||
    process.env.NODE_ENV === "production"
  );
};

export async function getChromePath() {
  const possiblePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/usr/bin/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);

  for (const path of possiblePaths) {
    if (fs.existsSync(path)) {
      return path;
    }
  }

  throw new Error("Chrome не найден");
}

export async function cleanupScreenshot(path) {
  try {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
      logger.debug(`Удален скриншот: ${path}`);
    }
  } catch (error) {
    logger.error({ error }, "Ошибка удаления скриншота");
  }
}

export function checkSprintWhitelist(taskTitle, sprintWhitelist) {
  if (sprintWhitelist.length === 0) return true;

  const sprintNumbers = taskTitle.match(/\[(\d+)\]/g);
  if (!sprintNumbers) return false;

  return sprintNumbers.some((sprint) => {
    const sprintNumber = sprint.replace(/[\[\]]/g, "");
    return sprintWhitelist.includes(sprintNumber);
  });
}
