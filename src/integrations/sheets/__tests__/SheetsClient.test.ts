/**
 * Tests for SheetsClient - Google Sheets integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SheetsClient, createSheetsClient, type SheetsConfig } from '../SheetsClient.js';
import { FatalError, ProviderError } from '@/core/errors.js';

const sheetsMocks = vi.hoisted(() => ({
  get: vi.fn(),
  batchUpdate: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: vi.fn().mockImplementation(() => ({
        getClient: vi.fn(),
      })),
    },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        values: {
          get: sheetsMocks.get,
          batchUpdate: sheetsMocks.batchUpdate,
        },
      },
    }),
  },
}));

describe('SheetsClient', () => {
  let client: SheetsClient;

  const config: SheetsConfig = {
    spreadsheetId: 'test-spreadsheet-id',
    sheetName: 'Sheet1',
    columns: {
      topic: 1,
      targetAudience: 2,
      keywordHints: 3,
      constraints: 4,
      status: 5,
      error: 6,
    },
    credentials: {
      client_email: 'test@test.iam.gserviceaccount.com',
      private_key: 'test-key',
      project_id: 'test-project',
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    client = new SheetsClient(config);
    await client.initialize();
  });

  describe('initialize', () => {
    it('initializes the client successfully', async () => {
      const newClient = new SheetsClient(config);
      await expect(newClient.initialize()).resolves.toBeUndefined();
    });
  });

  describe('readNextPendingRow', () => {
    it('returns null when no pending rows exist', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [['Topic', 'Audience', 'Keywords', 'Constraints', 'Status']],
        },
      });

      const result = await client.readNextPendingRow();

      expect(result).toBeNull();
    });

    it('returns the first pending row', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Test Topic', 'Developers', 'test, keyword', 'Keep simple', 'pending'],
          ],
        },
      });
      sheetsMocks.batchUpdate.mockResolvedValueOnce({});

      const result = await client.readNextPendingRow();

      expect(result).not.toBeNull();
      expect(result?.topic).toBe('Test Topic');
      expect(result?.targetAudience).toBe('Developers');
      expect(result?.keywordHints).toEqual(['test', 'keyword']);
      expect(result?.constraints).toBe('Keep simple');
      expect(result?.rowNumber).toBe(2);
    });

    it('skips rows that are not pending', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Done Topic', 'Developers', '', '', 'done'],
            ['In Progress Topic', 'Developers', '', '', 'in_progress'],
            ['Pending Topic', 'Developers', '', '', 'pending'],
          ],
        },
      });
      sheetsMocks.batchUpdate.mockResolvedValueOnce({});

      const result = await client.readNextPendingRow();

      expect(result).not.toBeNull();
      expect(result?.topic).toBe('Pending Topic');
      expect(result?.rowNumber).toBe(4);
    });

    it('marks the row as in_progress', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Test Topic', 'Developers', '', '', 'pending'],
          ],
        },
      });
      sheetsMocks.batchUpdate.mockResolvedValueOnce({});

      await client.readNextPendingRow();

      expect(sheetsMocks.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'test-spreadsheet-id',
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            {
              range: 'Sheet1!E2',
              values: [['in_progress']],
            },
          ],
        },
      });
    });

    it('throws ValidationError for missing required fields', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['', '', '', '', 'pending'], // Missing topic and audience
          ],
        },
      });

      await expect(client.readNextPendingRow()).rejects.toThrow(FatalError);
    });

    it('handles empty keyword hints', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Test Topic', 'Developers', '', '', 'pending'],
          ],
        },
      });
      sheetsMocks.batchUpdate.mockResolvedValueOnce({});

      const result = await client.readNextPendingRow();

      expect(result?.keywordHints).toEqual([]);
    });

    it('parses comma-separated keyword hints', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Test Topic', 'Developers', 'keyword1, keyword2, keyword3', '', 'pending'],
          ],
        },
      });
      sheetsMocks.batchUpdate.mockResolvedValueOnce({});

      const result = await client.readNextPendingRow();

      expect(result?.keywordHints).toEqual(['keyword1', 'keyword2', 'keyword3']);
    });
  });

  describe('markRowDone', () => {
    it('marks a row as done', async () => {
      sheetsMocks.batchUpdate.mockResolvedValueOnce({});

      await client.markRowDone(2);

      expect(sheetsMocks.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'test-spreadsheet-id',
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            {
              range: 'Sheet1!E2',
              values: [['done']],
            },
          ],
        },
      });
    });
  });

  describe('markRowError', () => {
    it('marks a row as error with message', async () => {
      sheetsMocks.batchUpdate.mockResolvedValueOnce({});

      await client.markRowError(2, 'Test error message');

      expect(sheetsMocks.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'test-spreadsheet-id',
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            {
              range: 'Sheet1!E2',
              values: [['error']],
            },
            {
              range: 'Sheet1!F2',
              values: [['Test error message']],
            },
          ],
        },
      });
    });
  });

  describe('hasDuplicateTopic', () => {
    it('returns false when no duplicate exists', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Different Topic', 'Developers', '', '', 'done'],
          ],
        },
      });

      const result = await client.hasDuplicateTopic('Test Topic');

      expect(result).toBe(false);
    });

    it('returns true when duplicate exists in done rows', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Test Topic', 'Developers', '', '', 'done'],
          ],
        },
      });

      const result = await client.hasDuplicateTopic('Test Topic');

      expect(result).toBe(true);
    });

    it('returns true when duplicate exists in in_progress rows', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Test Topic', 'Developers', '', '', 'in_progress'],
          ],
        },
      });

      const result = await client.hasDuplicateTopic('Test Topic');

      expect(result).toBe(true);
    });

    it('ignores pending rows for duplicate detection', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Test Topic', 'Developers', '', '', 'pending'],
          ],
        },
      });

      const result = await client.hasDuplicateTopic('Test Topic');

      expect(result).toBe(false);
    });

    it('is case-insensitive', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['TEST TOPIC', 'Developers', '', '', 'done'],
          ],
        },
      });

      const result = await client.hasDuplicateTopic('test topic');

      expect(result).toBe(true);
    });

    it('normalizes whitespace', async () => {
      sheetsMocks.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Topic', 'Audience', 'Keywords', 'Constraints', 'Status'],
            ['Test   Topic', 'Developers', '', '', 'done'],
          ],
        },
      });

      const result = await client.hasDuplicateTopic('Test Topic');

      expect(result).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws ProviderError on API failure', async () => {
      sheetsMocks.get.mockRejectedValueOnce(new Error('API Error'));

      await expect(client.readNextPendingRow()).rejects.toThrow(ProviderError);
    });

    it('throws FatalError when not initialized', async () => {
      const uninitializedClient = new SheetsClient(config);

      await expect(uninitializedClient.readNextPendingRow()).rejects.toThrow(FatalError);
    });
  });
});

describe('createSheetsClient', () => {
  it('creates a SheetsClient instance', () => {
    const client = createSheetsClient({
      spreadsheetId: 'test',
      sheetName: 'Sheet1',
      columns: {
        topic: 1,
        targetAudience: 2,
        keywordHints: 3,
        constraints: 4,
        status: 5,
      },
      credentials: {
        client_email: 'test@test.com',
        private_key: 'key',
        project_id: 'project',
      },
    });

    expect(client).toBeInstanceOf(SheetsClient);
  });
});
