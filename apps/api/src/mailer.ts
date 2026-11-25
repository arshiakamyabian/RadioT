import nodemailer from 'nodemailer';
import type { Env } from './env.js';

export interface Mailer {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export function createMailer(env: Env): Mailer {
  if (!env.SMTP_URL) {
    return {
      async send(message) {
        console.info(`[mail] to=${message.to} subject=${message.subject}\n${message.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport(env.SMTP_URL);
  return {
    async send(message) {
      await transport.sendMail({ from: env.MAIL_FROM, ...message });
    },
  };
}
