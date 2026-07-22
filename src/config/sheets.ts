/**
 * Configuration types and defaults for Google Sheets integration.
 *
 * @see architecture/03-module-flow.md - Sheet Reader module
 */

import { z } from 'zod';

const googleAuthCredentialsSchema = z.object({
  client_email: z.string(),
  private_key: z.string(),
  project_id: z.string(),
});

/** Column mapping for the spreadsheet. */
export interface SheetsColumnConfig {
  /** Column number (1-based) for the topic field. */
  readonly topic: number;
  /** Column number (1-based) for the target audience field. */
  readonly targetAudience: number;
  /** Column number (1-based) for the keyword hints field. */
  readonly keywordHints: number;
  /** Column number (1-based) for the constraints field. */
  readonly constraints: number;
  /** Column number (1-based) for the status field. */
  readonly status: number;
  /** Column number (1-based) for the error message field (optional). */
  readonly error?: number;
}

/** Configuration for the Sheets client. */
export interface SheetsClientConfig {
  /** Google Sheets spreadsheet ID. */
  readonly spreadsheetId: string;
  /** Sheet name/tab (default: 'Sheet1'). */
  readonly sheetName: string;
  /** Column mapping for required fields. */
  readonly columns: SheetsColumnConfig;
  /** Service account credentials JSON (parsed). */
  readonly credentials: {
    readonly client_email: string;
    readonly private_key: string;
    readonly project_id: string;
  };
}

/** Default column mapping for a standard Blogspage topic brief sheet. */
export const DEFAULT_SHEETS_COLUMNS: SheetsColumnConfig = {
  topic: 1,
  targetAudience: 2,
  keywordHints: 3,
  constraints: 4,
  status: 5,
  error: 6,
};

/**
 * Creates a SheetsClientConfig from environment variables.
 *
 * Required environment variables:
 * - GOOGLE_SHEETS_SPREADSHEET_ID
 * - GOOGLE_SHEETS_CREDENTIALS (JSON string)
 *
 * Optional environment variables:
 * - GOOGLE_SHEETS_SHEET_NAME (default: 'Sheet1')
 */
export function createSheetsConfigFromEnv(env: NodeJS.ProcessEnv): SheetsClientConfig | null {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const credentialsJson = env.GOOGLE_SHEETS_CREDENTIALS?.trim();
  const sheetName = env.GOOGLE_SHEETS_SHEET_NAME?.trim() || 'Sheet1';

  if (!spreadsheetId || !credentialsJson) {
    return null;
  }

  try {
    const credentials = googleAuthCredentialsSchema.parse(JSON.parse(credentialsJson) as unknown);

    return {
      spreadsheetId,
      sheetName,
      columns: DEFAULT_SHEETS_COLUMNS,
      credentials,
    };
  } catch {
    throw new Error('Failed to parse GOOGLE_SHEETS_CREDENTIALS as JSON');
  }
}
