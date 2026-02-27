/**
 * LLM Cost Tracking
 * Monitors API usage and estimates costs based on provider pricing
 */

import type { LLMProvider } from '../llm/llm-client.js';

/**
 * Pricing per 1M tokens (as of January 2025)
 * Source: Provider pricing pages
 */
export const PRICING: Record<LLMProvider, { input: number; output: number }> = {
  // OpenRouter pricing (varies by model - these are averages for Claude/GPT-4 class)
  openrouter: {
    input: 3.00,    // $3/1M input tokens (Claude Sonnet 3.5)
    output: 15.00,  // $15/1M output tokens
  },
  // Anthropic direct pricing
  anthropic: {
    input: 3.00,    // $3/1M input tokens (Claude Sonnet 3.5)
    output: 15.00,  // $15/1M output tokens
  },
  // OpenAI pricing
  openai: {
    input: 2.50,    // $2.50/1M input tokens (GPT-4 Turbo)
    output: 10.00,  // $10/1M output tokens
  },
};

export interface CostStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  costByAction: Map<string, number>;
  tokensByAction: Map<string, number>;
}

export class CostTracker {
  private provider: LLMProvider;
  private stats: CostStats;
  private startTime: Date;

  constructor(provider: LLMProvider) {
    this.provider = provider;
    this.startTime = new Date();
    this.stats = {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      costByAction: new Map(),
      tokensByAction: new Map(),
    };
  }

  /**
   * Record an LLM API call
   */
  recordCall(
    actionType: string,
    inputTokens: number,
    outputTokens: number
  ): void {
    this.stats.totalCalls++;
    this.stats.totalInputTokens += inputTokens;
    this.stats.totalOutputTokens += outputTokens;
    this.stats.totalTokens += inputTokens + outputTokens;

    // Calculate cost for this call
    const pricing = PRICING[this.provider];
    const callCost =
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;

    this.stats.estimatedCost += callCost;

    // Track by action type
    const currentCost = this.stats.costByAction.get(actionType) || 0;
    this.stats.costByAction.set(actionType, currentCost + callCost);

    const currentTokens = this.stats.tokensByAction.get(actionType) || 0;
    this.stats.tokensByAction.set(actionType, currentTokens + inputTokens + outputTokens);
  }

  /**
   * Get current stats
   */
  getStats(): CostStats {
    return {
      ...this.stats,
      costByAction: new Map(this.stats.costByAction),
      tokensByAction: new Map(this.stats.tokensByAction),
    };
  }

  /**
   * Get formatted summary report
   */
  getSummary(): string {
    const runtime = Date.now() - this.startTime.getTime();
    const runtimeHours = runtime / (1000 * 60 * 60);
    const runtimeDays = runtimeHours / 24;

    const lines = [
      '='.repeat(60),
      '💰 LLM Cost Tracking Summary',
      '='.repeat(60),
      '',
      `Provider: ${this.provider}`,
      `Runtime: ${runtimeDays >= 1 ? `${runtimeDays.toFixed(1)} days` : `${runtimeHours.toFixed(1)} hours`}`,
      `Started: ${this.startTime.toISOString()}`,
      '',
      '📊 Usage Statistics:',
      `  Total API Calls: ${this.stats.totalCalls.toLocaleString()}`,
      `  Input Tokens:  ${this.stats.totalInputTokens.toLocaleString()}`,
      `  Output Tokens: ${this.stats.totalOutputTokens.toLocaleString()}`,
      `  Total Tokens:  ${this.stats.totalTokens.toLocaleString()}`,
      '',
      '💵 Estimated Cost:',
      `  Total: $${this.stats.estimatedCost.toFixed(4)}`,
      `  Per Hour: $${(this.stats.estimatedCost / Math.max(runtimeHours, 0.01)).toFixed(4)}/hr`,
      `  Per Day: $${(this.stats.estimatedCost / Math.max(runtimeDays, 0.01)).toFixed(2)}/day`,
      '',
    ];

    // Cost breakdown by action type
    if (this.stats.costByAction.size > 0) {
      lines.push('💸 Cost by Action Type:');
      const sorted = Array.from(this.stats.costByAction.entries())
        .sort((a, b) => b[1] - a[1]);

      for (const [action, cost] of sorted) {
        const tokens = this.stats.tokensByAction.get(action) || 0;
        const percentage = (cost / this.stats.estimatedCost) * 100;
        lines.push(`  ${action.padEnd(15)} $${cost.toFixed(4)} (${tokens.toLocaleString()} tokens, ${percentage.toFixed(1)}%)`);
      }
      lines.push('');
    }

    // Pricing reference
    const pricing = PRICING[this.provider];
    lines.push('📋 Current Pricing (per 1M tokens):');
    lines.push(`  Input:  $${pricing.input.toFixed(2)}`);
    lines.push(`  Output: $${pricing.output.toFixed(2)}`);
    lines.push('');
    lines.push('='.repeat(60));

    return lines.join('\n');
  }

  /**
   * Get projected monthly cost based on current usage rate
   */
  getMonthlyProjection(): number {
    const runtime = Date.now() - this.startTime.getTime();
    const runtimeDays = runtime / (1000 * 60 * 60 * 24);

    if (runtimeDays < 0.01) {
      return 0;  // Not enough data
    }

    const costPerDay = this.stats.estimatedCost / runtimeDays;
    return costPerDay * 30;
  }

  /**
   * Reset stats (for testing or new billing period)
   */
  reset(): void {
    this.startTime = new Date();
    this.stats = {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      costByAction: new Map(),
      tokensByAction: new Map(),
    };
  }
}

// Singleton instance
let instance: CostTracker | null = null;

export function createCostTracker(provider: LLMProvider): CostTracker {
  instance = new CostTracker(provider);
  return instance;
}

export function getCostTracker(): CostTracker {
  if (!instance) {
    throw new Error('Cost tracker not initialized. Call createCostTracker first.');
  }
  return instance;
}
