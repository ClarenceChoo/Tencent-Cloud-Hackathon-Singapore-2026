declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    OPENAI_API_KEY?: string;
    PUBLIC_SITE_ORIGIN?: string;
    PUBLIC_PHONE_ORIGIN?: string;
    DASHBOARD_ALLOWED_EMAILS?: string;
  }
}
