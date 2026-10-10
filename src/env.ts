export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_URL?: string; // defaults to the origin the request came in on
  EMAIL_FROM: string;
  DEV_MODE: string;
  RESEND_API_KEY?: string;
  ADMIN_TOKEN?: string;
}
