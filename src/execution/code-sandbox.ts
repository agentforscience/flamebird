/**
 * Code sandbox for executing solver Python code locally.
 *
 * Flow: write code to temp file → spawn python3 with timeout →
 * parse stdout as JSON → return solutionData
 */

import { execFile } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SolverResult {
  success: boolean;
  solutionData?: Record<string, unknown>;
  error?: string;
  executionTimeMs?: number;
}

const TIMEOUT_MS = 90_000; // 90 seconds — generous for optimization code

export async function runSolverCode(code: string): Promise<SolverResult> {
  const tmpFile = join(tmpdir(), `flamebird_solver_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
  const start = Date.now();

  try {
    writeFileSync(tmpFile, code, 'utf-8');

    const { stdout, stderr } = await execFileAsync(
      'python3',
      [tmpFile],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10 MB stdout buffer
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
        },
      }
    );

    const executionTimeMs = Date.now() - start;

    // Sanitize Python's non-standard JSON tokens (NaN, Infinity, -Infinity → null)
    const sanitize = (s: string) => s
      .replace(/\bNaN\b/g, 'null')
      .replace(/\bInfinity\b/g, 'null')
      .replace(/-Infinity\b/g, 'null');

    // Find the last line that looks like JSON (solver may print debug to stdout too)
    const lines = stdout.trim().split('\n').filter(l => l.trim());
    let solutionData: Record<string, unknown> | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(sanitize(lines[i].trim()));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          solutionData = parsed as Record<string, unknown>;
          break;
        }
      } catch {
        // not JSON, keep looking
      }
    }

    if (!solutionData) {
      // Try parsing the entire stdout as JSON
      try {
        const parsed = JSON.parse(sanitize(stdout.trim()));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          solutionData = parsed as Record<string, unknown>;
        }
      } catch {
        const preview = stdout.slice(0, 300);
        const errPreview = stderr?.slice(0, 200) || '';
        return {
          success: false,
          error: `No JSON object found in stdout. Output: ${preview}${errPreview ? ` | stderr: ${errPreview}` : ''}`,
          executionTimeMs,
        };
      }
    }

    return { success: true, solutionData, executionTimeMs };

  } catch (err: unknown) {
    const executionTimeMs = Date.now() - start;

    if (err && typeof err === 'object' && 'killed' in err && (err as NodeJS.ErrnoException & { killed: boolean }).killed) {
      return {
        success: false,
        error: `Solver timed out after ${TIMEOUT_MS / 1000}s`,
        executionTimeMs,
      };
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr?.slice(0, 500) || '';
    return {
      success: false,
      error: stderr || errorMsg,
      executionTimeMs,
    };

  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}
