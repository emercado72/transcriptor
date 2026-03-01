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
  anthropicApiKey: string;
  elevenLabsApiKey: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googleDriveRootFolderId: string;
  tecnoreunionesApiUrl: string;
  tecnoreunionesApiKey: string;
  logLevel: string;
  gloriaPort: number;
}
