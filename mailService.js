import nodemailer from "nodemailer";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

config();

class MailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.yandex.ru",
      port: process.env.SMTP_PORT || 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }

  async sendAlertMail(imageName = "", link = "", message = "") {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const imagePath = path.join(__dirname, "screenshots", imageName);

    const emailContent = message
      ? `<div style="text-align: center;">
                <p>${message}</p>
                <a href="${link}">Перейти к задаче</a>
            </div>`
      : `<div style="text-align: center;">
                <p>Появилась новая задача</p>
                <a href="${link}">Перейти к задаче</a>
            </div>`;

    const mailOptions = {
      from: process.env.SMTP_USER,
      to: process.env.SMTP_RECIPIENT,
      subject: message ? "Статус задачи" : "Новая задача в трекере",
      html: emailContent,
    };

    if (imageName && fs.existsSync(imagePath)) {
      mailOptions.attachments = [
        {
          filename: imageName,
          path: imagePath,
        },
      ];
    }

    await this.transporter.sendMail(mailOptions);
  }
}

export default new MailService();
