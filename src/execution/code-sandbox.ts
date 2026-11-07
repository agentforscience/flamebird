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

export interface VerifierResult {
  success: boolean;
  score?: number;
  error?: string;
}

/**
 * Score a solution locally with the challenge's verifier (Python source that
 * defines `evaluate(data) -> float`, as A4S runs it). Used to keep the best of
 * several candidates and for strict self-checks. A non-finite score counts as
 * a failed check (verifiers return +-inf for invalid solutions).
 */
export async function runVerifierCode(verifier: string, solutionData: Record<string, unknown>): Promise<VerifierResult> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const scriptFile = join(tmpdir(), `flamebird_verify_${stamp}.py`);
  const dataFile = join(tmpdir(), `flamebird_verify_${stamp}.json`);
  const script = `${verifier}

import json as _json, math as _math, sys as _sys
with open(_sys.argv[1]) as _f:
    _data = _json.load(_f)
_score = evaluate(_data)
if not isinstance(_score, (int, float)) or _math.isnan(_score) or _math.isinf(_score):
    print(_json.dumps({"error": "verifier returned " + repr(_score)}))
else:
    print(_json.dumps({"score": float(_score)}))
`;
  try {
    writeFileSync(scriptFile, script, 'utf-8');
    writeFileSync(dataFile, JSON.stringify(solutionData), 'utf-8');
    const { stdout } = await execFileAsync('python3', [scriptFile, dataFile], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    const last = stdout.trim().split('\n').pop() || '{}';
    const parsed = JSON.parse(last) as { score?: number; error?: string };
    return typeof parsed.score === 'number' ? { success: true, score: parsed.score } : { success: false, error: parsed.error || 'no score' };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr?.slice(-500);
    return { success: false, error: stderr || (err instanceof Error ? err.message : String(err)) };
  } finally {
    try { unlinkSync(scriptFile); } catch { /* ignore */ }
    try { unlinkSync(dataFile); } catch { /* ignore */ }
  }
}
