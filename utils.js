import os from "os";
import { execSync } from "child_process";
import fs from "fs";

export const sleep = (sec = 0) =>
  new Promise((resolve) => setTimeout(resolve, sec * 1000));

export const getFormattedDate = () => {
  const now = new Date();
  return now.toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 19);
};

export const isRunningOnHosting = () => {
  // Проверяем переменные окружения, характерные для хостингов
  return (
    !!process.env.HOSTING ||
    !!process.env.PWD?.includes("home") ||
    os.hostname().includes("host") ||
    process.env.NODE_ENV === "production"
  );
};

export const getChromePath = async () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // Пути для Render.com
  const renderPaths = [
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome'
  ];

  for (const path of renderPaths) {
    if (fs.existsSync(path)) return path;
  }

  throw new Error('Chrome не найден');
}

// export const getChromePath = async () => {
//   const platform = os.platform();

//   try {
//     switch (platform) {
//       case "darwin": // macOS
//         return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

//       case "win32":
//         // Попытка через реестр
//         try {
//           const regQuery = execSync(
//             'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve'
//           ).toString();

//           const chromePath = regQuery
//             .split("\n")
//             .find((line) => line.includes("REG_SZ"))
//             ?.split("REG_SZ")[1]
//             ?.trim();

//           if (chromePath && fs.existsSync(chromePath)) return chromePath;
//         } catch {}

//         // Стандартные пути для Windows
//         const winPaths = [
//           `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
//           `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
//           `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
//         ];

//         for (const p of winPaths) {
//           if (fs.existsSync(p)) return p;
//         }
//         break;

//       case "linux":
//         // Стандартные пути для Linux
//         const linuxPaths = [
//           "/usr/bin/google-chrome",
//           "/usr/bin/google-chrome-stable",
//           "/usr/bin/chromium",
//           "/usr/bin/chromium-browser",
//           "/snap/bin/chromium",
//         ];

//         for (const p of linuxPaths) {
//           if (fs.existsSync(p)) return p;
//         }
//         break;
//     }
//   } catch (error) {
//     console.error("Ошибка определения пути к Chrome:", error);
//   }

//   return null;
// };