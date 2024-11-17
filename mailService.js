import nodemailer from "nodemailer";
import path from "path";

import { fileURLToPath } from "url";
import { config } from "dotenv";

config();

class MailService {
    constructor() {
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: true,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASSWORD,
            },
        });
    }

    async sendAlertMail(imageName = "", link = "") {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const imagePath = path.join(__dirname, "screenshots", imageName);

        console.log({ imageName, imagePath, email: process.env.SMTP_USER });

        await this.transporter.sendMail({
            from: process.env.SMTP_USER,
            to: process.env.SMTP_RECIPIENT,
            subject: `Добавлена новая задача!!`,
            text: "",
            html: `<div style="text-align: center; display: flex; flex-direction: column; gap: 50px;">
            <p>В Вашем аккаунте появилась новая задача в графе "Общие задачи"</p>
            <button style="padding: 10px 20px; font-size: 16px;">
                <a href="${link}" style="text-decoration: none; color: white;">Перейти к задаче</a>
            </button>
        </div>`,
            attachments: [
                {
                    filename: imageName,
                    path: imagePath,
                }
            ],
        });
    }
}

export default new MailService();