// ──────────────────────────────────────────────
// Template & Config Types
// ──────────────────────────────────────────────

export interface TemplateConfig {
  templateId: string;
  fontFamily: string;
  fontSize: number;
  titleFontSize: number;
  margins: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  headerText: string;
  footerText: string;
  lineSpacing: number;
}

export interface GlossaryEntry {
  term: string;
  replacement: string;
  context: string;
  clientId: string | null;
}

/**
 * Supported OpenRouter model IDs for per-agent overrides (Lina / Gloria).
 * Set LINA_MODEL or GLORIA_MODEL in .env.local to test alternatives.
 */
export type OpenRouterModelId =
  | 'anthropic/claude-sonnet-4.6'
  | 'google/gemini-3-flash-preview'
  | 'deepseek/deepseek-v3.2'
  | 'qwen/qwen3.5-plus-02-15'
  | (string & {});

export interface EnvConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisHost: string;
  redisPort: number;
  redisPassword: string;
  openaiApiKey: string;
  groqApiKey: string;
  groqModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  /** Model override for Lina (redaction + speaker reconciliation). Falls back to openrouterModel. */
  linaModel: string;
  /** Model override for Gloria (document review). Falls back to openrouterModel. */
  gloriaModel: string;
  elevenLabsApiKey: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googleRefreshToken: string;
  googleServiceAccountKeyFile: string;
  googleImpersonateEmail: string;
  googleDriveRootFolderId: string;
  tecnoreunionesApiUrl: string;
  tecnoreunionesApiKey: string;
  tecnoreunionesDbHost: string;
  tecnoreunionesDbUser: string;
  tecnoreunionesDbPass: string;
  tecnoreunionesDbName: string;
  logLevel: string;
  gloriaPort: number;
  s3Endpoint: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Prefix: string;
}
