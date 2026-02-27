/**
 * Content Similarity Detection
 * Prevents agents from posting repetitive or duplicate comments
 */

import type { RuntimeDatabase } from '../db/database.js';

/**
 * Calculate Jaccard similarity between two texts using word overlap
 * Returns 0.0 (completely different) to 1.0 (identical)
 *
 * @param text1 - First text
 * @param text2 - Second text
 * @returns Similarity score 0.0-1.0
 */
export function calculateSimilarity(text1: string, text2: string): number {
  // Extract words (alphanumeric sequences)
  const words1 = new Set(
    text1
      .toLowerCase()
      .match(/\w+/g) || []
  );

  const words2 = new Set(
    text2
      .toLowerCase()
      .match(/\w+/g) || []
  );

  if (words1.size === 0 || words2.size === 0) {
    return 0;
  }

  // Jaccard similarity: |intersection| / |union|
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Check if new comment is too similar to agent's recent comments
 * Looks at last N comments by the agent and compares word overlap
 *
 * @param agentId - Agent ID
 * @param newComment - New comment text to check
 * @param db - Database instance
 * @param threshold - Similarity threshold (default: 0.7 = 70% similar)
 * @param lookback - How many recent comments to check (default: 10)
 * @returns true if too similar (should skip), false if unique enough
 */
export function isTooSimilarToRecent(
  agentId: string,
  newComment: string,
  db: RuntimeDatabase,
  threshold: number = 0.7,
  lookback: number = 10
): boolean {
  // Get agent's recent comments from audit log
  const recentComments = db.getRecentCommentsByAgent(agentId, lookback);

  for (const comment of recentComments) {
    const similarity = calculateSimilarity(newComment, comment.body);

    if (similarity > threshold) {
      return true;  // Too similar!
    }
  }

  return false;  // Unique enough
}

/**
 * Calculate content diversity score for an agent
 * Higher score = more diverse comments
 *
 * @param agentId - Agent ID
 * @param db - Database instance
 * @param sampleSize - How many recent comments to analyze
 * @returns Diversity score 0.0-1.0 (1.0 = most diverse)
 */
export function calculateDiversityScore(
  agentId: string,
  db: RuntimeDatabase,
  sampleSize: number = 20
): number {
  const comments = db.getRecentCommentsByAgent(agentId, sampleSize);

  if (comments.length < 2) {
    return 1.0;  // Not enough data, assume diverse
  }

  let totalSimilarity = 0;
  let comparisons = 0;

  // Compare each pair of comments
  for (let i = 0; i < comments.length - 1; i++) {
    for (let j = i + 1; j < comments.length; j++) {
      totalSimilarity += calculateSimilarity(comments[i].body, comments[j].body);
      comparisons++;
    }
  }

  const avgSimilarity = totalSimilarity / comparisons;

  // Diversity = 1 - average similarity
  return 1.0 - avgSimilarity;
}
