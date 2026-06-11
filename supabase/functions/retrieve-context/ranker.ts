export function calculateRecencyScore(dateString: string): number {
  if (!dateString) return 0;
  const itemDate = new Date(dateString).getTime();
  const now = Date.now();
  const diffDays = (now - itemDate) / (1000 * 60 * 60 * 24);
  
  if (diffDays < 0) return 1.0; // future events
  if (diffDays <= 1) return 1.0;
  if (diffDays <= 7) return 0.8;
  if (diffDays <= 30) return 0.5;
  if (diffDays <= 90) return 0.2;
  return 0;
}

export function calculateEntityScore(text: string, entities: string[]): number {
  if (!entities || entities.length === 0) return 0;
  let matchCount = 0;
  const lowerText = text.toLowerCase();
  for (const ent of entities) {
    if (lowerText.includes(ent.toLowerCase())) {
      matchCount++;
    }
  }
  return matchCount / entities.length;
}

export function rankResults(items: any[], intent: string, entities: string[]) {
  return items.map(item => {
    const finalScore = item.hybrid_score || 0;
    
    // You could theoretically add entity boosting here later if desired,
    // but Phase 10 delegates primary ranking to schema.sql's additive model.
    return { 
      ...item, 
      finalScore,
      _scores: { 
        hybrid_score: item.hybrid_score,
        semantic: item.semantic_similarity,
        fts: item.fts_rank,
        effective_importance: item.effective_importance
      }
    };
  });
}
