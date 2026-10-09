declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    PRIVATE_DASHBOARD_ORIGIN?: string;
    PRIVATE_VOICE_SERVICE_TOKEN?: string;
    PUBLIC_SITE_ORIGIN?: string;
  }
}
