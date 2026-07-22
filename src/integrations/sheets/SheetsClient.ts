/**
 * Google Sheets API client for reading topic briefs.
 *
 * This client reads pending rows from a configured spreadsheet, marks them
 * as "in progress" to prevent duplicate processing, and normalizes them into
 * the BriefSection shape the pipeline expects.
 *
 * @see architecture/03-module-flow.md - Sheet Reader module
 * @see architecture/12-future-roadmap.md - Phase 5 scope
 */

import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import { FatalError, ProviderError } from '@/core/errors.js';

/** The normalized topic brief extracted from a sheet row. */
export interface TopicBrief {
  /** The main topic/title for the article. */
  readonly topic: string;
  /** Target audience for the article. */
  readonly targetAudience: string;
  /** SEO keyword hints for the article. */
  readonly keywordHints: readonly string[];
  /** Optional constraints or requirements. */
  readonly constraints?: string;
  /** The 1-based row number in the spreadsheet. */
  readonly rowNumber: number;
}

/** Row status markers in the spreadsheet. */
type RowStatus = 'pending' | 'in_progress' | 'done' | 'error';

/** Configuration for the Sheets client. */
export interface SheetsConfig {
  /** Google Sheets spreadsheet ID. */
  readonly spreadsheetId: string;
  /** Sheet name/tab (default: 'Sheet1'). */
  readonly sheetName: string;
  /** Column mapping for required fields. */
  readonly columns: {
    readonly topic: number;
    readonly targetAudience: number;
    readonly keywordHints: number;
    readonly constraints: number;
    readonly status: number;
    readonly error?: number;
  };
  /** Google Auth credentials (service account JSON). */
  readonly credentials: GoogleAuthCredentials;
}

/** Service account credentials for Google Auth. */
export interface GoogleAuthCredentials {
  readonly client_email: string;
  readonly private_key: string;
  readonly project_id: string;
}

/** Internal representation of a raw row from the spreadsheet. */
interface RawRow {
  readonly rowNumber: number;
  readonly values: string[];
}

function toCellString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

/**
 * Client for reading and updating Google Sheets rows.
 *
 * All operations are idempotent - marking a row "in_progress" twice is safe,
 * and reading only returns rows that are genuinely pending.
 */
export class SheetsClient {
  private readonly config: SheetsConfig;
  private sheets: sheets_v4.Sheets | null = null;

  constructor(config: SheetsConfig) {
    this.config = config;
  }

  /**
   * Initializes the Google Sheets API client.
   * Must be called before any other methods.
   */
  async initialize(): Promise<void> {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: this.config.credentials.client_email,
        private_key: this.config.credentials.private_key,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    await auth.getClient();
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  /**
   * Reads the next pending row from the spreadsheet and marks it as "in_progress".
   *
   * @returns The normalized topic brief, or null if no pending rows exist.
   * @throws {ProviderError} If the Sheets API fails.
   * @throws {FatalError} If the row data is invalid or missing required fields.
   */
  async readNextPendingRow(): Promise<TopicBrief | null> {
    this.ensureInitialized();

    try {
      const rawRows = await this.fetchAllRows();

      // Find the first pending row
      const pendingRow = rawRows.find((row) => this.getRowStatus(row) === 'pending');

      if (!pendingRow) {
        return null;
      }

      // Validate the row has required fields
      this.validateRow(pendingRow);

      // Mark as in_progress
      await this.updateRowStatus(pendingRow.rowNumber, 'in_progress');

      // Normalize to TopicBrief
      return this.normalizeRow(pendingRow);
    } catch (error) {
      if (error instanceof FatalError || error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError('sheet-reader', 'google-sheets', undefined, this.isRetryable(error));
    }
  }

  /**
   * Marks a row as "done" after successful processing.
   *
   * @param rowNumber - The 1-based row number.
   */
  async markRowDone(rowNumber: number): Promise<void> {
    await this.updateRowStatus(rowNumber, 'done');
  }

  /**
   * Marks a row as "error" with an error message.
   *
   * @param rowNumber - The 1-based row number.
   * @param errorMessage - The error message to record.
   */
  async markRowError(rowNumber: number, errorMessage: string): Promise<void> {
    this.ensureInitialized();

    try {
      const statusColumn = this.columnToLetter(this.config.columns.status);
      const errorColumn = this.config.columns.error
        ? this.columnToLetter(this.config.columns.error)
        : null;

      const updates: { range: string; value: string }[] = [
        { range: `${statusColumn}${rowNumber}`, value: 'error' },
      ];

      if (errorColumn) {
        updates.push({ range: `${errorColumn}${rowNumber}`, value: errorMessage });
      }

      await this.batchUpdate(updates);
    } catch (error) {
      throw new ProviderError('sheet-reader', 'google-sheets', undefined, this.isRetryable(error));
    }
  }

  /**
   * Checks if a specific row already has a topic (duplicate detection).
   *
   * @param topic - The topic to check.
   * @returns True if a row with this topic already exists with status "done" or "in_progress".
   */
  async hasDuplicateTopic(topic: string): Promise<boolean> {
    this.ensureInitialized();

    try {
      const rawRows = await this.fetchAllRows();
      const normalizedTopic = this.normalizeTopic(topic);

      return rawRows.some((row) => {
        const status = this.getRowStatus(row);
        if (status === 'pending' || status === 'error') {
          return false;
        }

        const rowTopic = this.getColumnValue(row, this.config.columns.topic);
        return rowTopic && this.normalizeTopic(rowTopic) === normalizedTopic;
      });
    } catch (error) {
      throw new ProviderError('sheet-reader', 'google-sheets', undefined, this.isRetryable(error));
    }
  }

  /**
   * Fetches all rows from the configured sheet.
   */
  private async fetchAllRows(): Promise<RawRow[]> {
    this.ensureInitialized();

    const response = await this.sheets!.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: this.config.sheetName,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return [];
    }

    // Skip header row, convert to RawRow format
    return rows.slice(1).map((values: unknown[], index: number) => ({
      rowNumber: index + 2, // +2 because: 1 for header, 1 for 1-based indexing
      values: Array.isArray(values) ? values.map((value) => toCellString(value)) : [],
    }));
  }

  /**
   * Updates the status column for a specific row.
   */
  private async updateRowStatus(rowNumber: number, status: RowStatus): Promise<void> {
    this.ensureInitialized();

    try {
      const statusColumn = this.columnToLetter(this.config.columns.status);
      await this.batchUpdate([{ range: `${statusColumn}${rowNumber}`, value: status }]);
    } catch (error) {
      throw new ProviderError('sheet-reader', 'google-sheets', undefined, this.isRetryable(error));
    }
  }

  /**
   * Performs a batch update of cell values.
   */
  private async batchUpdate(updates: { range: string; value: string }[]): Promise<void> {
    this.ensureInitialized();

    if (updates.length === 0) return;

    await this.sheets!.spreadsheets.values.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map((u) => ({
          range: `${this.config.sheetName}!${u.range}`,
          values: [[u.value]],
        })),
      },
    });
  }

  /**
   * Validates that a row has all required fields.
   */
  private validateRow(row: RawRow): void {
    const errors: string[] = [];

    const topic = this.getColumnValue(row, this.config.columns.topic);
    if (!topic || topic.trim().length === 0) {
      errors.push(`Row ${row.rowNumber}: Missing required field 'topic'`);
    }

    const targetAudience = this.getColumnValue(row, this.config.columns.targetAudience);
    if (!targetAudience || targetAudience.trim().length === 0) {
      errors.push(`Row ${row.rowNumber}: Missing required field 'targetAudience'`);
    }

    if (errors.length > 0) {
      throw new FatalError('sheet-reader', errors.join('; '));
    }
  }

  /**
   * Normalizes a raw row to a TopicBrief.
   */
  private normalizeRow(row: RawRow): TopicBrief {
    const keywordHintsValue = this.getColumnValue(row, this.config.columns.keywordHints);
    const keywordHints = keywordHintsValue
      ? keywordHintsValue
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      : [];

    const constraints = this.getColumnValue(row, this.config.columns.constraints)?.trim();

    return {
      topic: this.getColumnValue(row, this.config.columns.topic)!.trim(),
      targetAudience: this.getColumnValue(row, this.config.columns.targetAudience)!.trim(),
      keywordHints,
      ...(constraints && constraints.length > 0 ? { constraints } : {}),
      rowNumber: row.rowNumber,
    };
  }

  /**
   * Gets a column value from a row, safely handling missing columns.
   */
  private getColumnValue(row: RawRow, columnIndex: number): string | undefined {
    return row.values[columnIndex - 1]; // Convert 1-based to 0-based
  }

  /**
   * Gets the status of a row.
   */
  private getRowStatus(row: RawRow): RowStatus {
    const statusValue = this.getColumnValue(row, this.config.columns.status);
    if (!statusValue) return 'pending';

    const normalized = statusValue.toLowerCase().trim();
    if (normalized === 'done' || normalized === 'complete' || normalized === 'completed') {
      return 'done';
    }
    if (normalized === 'in_progress' || normalized === 'in progress') {
      return 'in_progress';
    }
    if (normalized === 'error' || normalized === 'failed') {
      return 'error';
    }
    return 'pending';
  }

  /**
   * Normalizes a topic for comparison (case-insensitive, whitespace-normalized).
   */
  private normalizeTopic(topic: string): string {
    return topic.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  /**
   * Converts a 1-based column index to a column letter (A, B, C, ..., Z, AA, AB, ...).
   */
  private columnToLetter(column: number): string {
    let letter = '';
    let temp = column;
    while (temp > 0) {
      const modulo = (temp - 1) % 26;
      letter = String.fromCharCode(65 + modulo) + letter;
      temp = Math.floor((temp - 1) / 26);
    }
    return letter;
  }

  /**
   * Determines if an error is retryable.
   */
  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      // Rate limit or server errors
      if (error.message.includes('429') || error.message.includes('503')) {
        return true;
      }
      // Network errors
      if (error.message.includes('ECONNRESET') || error.message.includes('ETIMEDOUT')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Ensures the client has been initialized.
   */
  private ensureInitialized(): void {
    if (!this.sheets) {
      throw new FatalError(
        'sheet-reader',
        'SheetsClient not initialized. Call initialize() first.',
      );
    }
  }
}

/**
 * Creates a SheetsClient from environment configuration.
 *
 * @param config - The application configuration.
 * @returns A configured SheetsClient instance.
 */
export function createSheetsClient(config: SheetsConfig): SheetsClient {
  return new SheetsClient(config);
}
