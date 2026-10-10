export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_URL: string;
  EMAIL_FROM: string;
  DEV_MODE: string;
  RESEND_API_KEY?: string;
  ADMIN_TOKEN?: string;
}
