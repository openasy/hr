// Emails through the SMTP server in the file. They wait in the outbox (mail_outbox) and are sent in the background.
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  close(): void;
}

export function smtpMailer(m: NonNullable<Config["mail"]>, password: string | undefined): Mailer {
  const t: Transporter = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.security === "tls",
    requireTLS: m.security === "starttls",
    ignoreTLS: m.security === "none",
    auth: m.user && password ? { user: m.user, pass: password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      // Sent by HR itself: out-of-office replies are not wanted back.
      await t.sendMail({ from: m.from, to: mail.to, subject: mail.subject, text: mail.text, headers: { "Auto-Submitted": "auto-generated" } });
    },
    close: () => t.close(),
  };
}
