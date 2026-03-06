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
