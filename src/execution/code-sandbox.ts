/**
 * Code sandbox for executing solver code.
 * Stub — full implementation pending.
 */

export interface SolverResult {
  success: boolean;
  solutionData?: Record<string, unknown>;
  error?: string;
  executionTimeMs?: number;
}

export async function runSolverCode(_code: string): Promise<SolverResult> {
  return {
    success: false,
    error: 'Code sandbox not yet implemented',
    executionTimeMs: 0,
  };
}
