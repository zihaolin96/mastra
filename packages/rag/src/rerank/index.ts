import type { MastraLanguageModel } from '@mastra/core/agent';
import type { RelevanceScoreProvider } from '@mastra/core/relevance';
import type { QueryResult } from '@mastra/core/vector';
import { Big } from 'big.js';
import { MastraAgentRelevanceScorer, CohereRelevanceScorer } from './relevance';

// Default weights for different scoring components (must add up to 1)
const DEFAULT_WEIGHTS = {
  semantic: 0.4,
  vector: 0.4,
  position: 0.2,
} as const;

type WeightConfig = {
  semantic?: number;
  vector?: number;
  position?: number;
};

interface ScoringDetails {
  semantic: number;
  vector: number;
  position: number;
  queryAnalysis?: {
    magnitude: number;
    dominantFeatures: number[];
  };
}

export interface RerankResult {
  result: QueryResult;
  score: number;
  details: ScoringDetails;
}

// For use in the vector store tool
export interface RerankerOptions {
  weights?: WeightConfig;
  topK?: number;
}

// For use in the rerank function
export interface RerankerFunctionOptions {
  weights?: WeightConfig;
  queryEmbedding?: number[];
  topK?: number;
}

export interface RerankConfig {
  options?: RerankerOptions;
  model: MastraLanguageModel | RelevanceScoreProvider;
}

// Calculate position score based on position in original list
function calculatePositionScore(position: number, totalChunks: number): number {
  return 1 - position / totalChunks;
}

// Analyze query embedding features if needed
function analyzeQueryEmbedding(embedding: number[]): {
  magnitude: number;
  dominantFeatures: number[];
} {
  // Calculate embedding magnitude
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));

  // Find dominant features (highest absolute values)
  const dominantFeatures = embedding
    .map((value, index) => ({ value: Math.abs(value), index }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map(item => item.index);

  return { magnitude, dominantFeatures };
}

// Adjust scores based on query characteristics
function adjustScores(score: number, queryAnalysis: { magnitude: number; dominantFeatures: number[] }): number {
  const magnitudeAdjustment = queryAnalysis.magnitude > 10 ? 1.1 : 1;

  const featureStrengthAdjustment = queryAnalysis.magnitude > 5 ? 1.05 : 1;

  return score * magnitudeAdjustment * featureStrengthAdjustment;
}

async function executeRerank({
  results,
  query,
  scorer,
  options,
}: {
  results: QueryResult[];
  query: string;
  scorer: RelevanceScoreProvider;
  options: RerankerFunctionOptions;
}) {
  const { queryEmbedding, topK = 3 } = options;
  const weights = {
    ...DEFAULT_WEIGHTS,
    ...options.weights,
  };

  //weights must add up to 1
  const sum = Object.values(weights).reduce((acc: Big, w: number) => acc.plus(w.toString()), new Big(0));
  if (!sum.eq(1)) {
    throw new Error(`Weights must add up to 1. Got ${sum} from ${weights}`);
  }

  const resultLength = results.length;

  const queryAnalysis = queryEmbedding ? analyzeQueryEmbedding(queryEmbedding) : null;

  // Get scores for each result
  const scoredResults = await Promise.all(
    results.map(async (result, index) => {
      // Get semantic score from chosen provider
      let semanticScore = 0;
      if (result?.metadata?.text) {
        semanticScore = await scorer.getRelevanceScore(query, result?.metadata?.text);
      }

      // Get existing vector score from result
      const vectorScore = result.score;

      // Get score of vector based on position in original list
      const positionScore = calculatePositionScore(index, resultLength);

      // Combine scores using weights for each component
      let finalScore =
        weights.semantic * semanticScore + weights.vector * vectorScore + weights.position * positionScore;

      if (queryAnalysis) {
        finalScore = adjustScores(finalScore, queryAnalysis);
      }

      return {
        result,
        score: finalScore,
        details: {
          semantic: semanticScore,
          vector: vectorScore,
          position: positionScore,
          ...(queryAnalysis && {
            queryAnalysis: {
              magnitude: queryAnalysis.magnitude,
              dominantFeatures: queryAnalysis.dominantFeatures,
            },
          }),
        },
      };
    }),
  );

  // Sort by score and take top K
  return scoredResults.sort((a, b) => b.score - a.score).slice(0, topK);
}

export async function rerankWithScorer({
  results,
  query,
  scorer,
  options,
}: {
  results: QueryResult[];
  query: string;
  scorer: RelevanceScoreProvider;
  options: RerankerFunctionOptions;
}): Promise<RerankResult[]> {
  return executeRerank({
    results,
    query,
    scorer,
    options,
  });
}

// Takes in a list of results from a vector store and reranks them based on semantic, vector, and position scores
export async function rerank(
  results: QueryResult[],
  query: string,
  model: MastraLanguageModel,
  options: RerankerFunctionOptions,
): Promise<RerankResult[]> {
  let semanticProvider: RelevanceScoreProvider;

  if (model.modelId === 'rerank-v3.5') {
    semanticProvider = new CohereRelevanceScorer(model.modelId);
  } else {
    semanticProvider = new MastraAgentRelevanceScorer(model.provider, model);
  }

  return executeRerank({
    results,
    query,
    scorer: semanticProvider,
    options,
  });
}
