export function assembleContext(
  rankedItems: any[],
  graphRelations: any[] = [],
  maxWords: number = 2000,
  scoreThreshold: number = 0.15
) {
  // 1. Sort descending by score
  const sorted = [...rankedItems].sort((a, b) => b.finalScore - a.finalScore);

  // 2. Drop low value
  const filtered = sorted.filter(item => item.finalScore >= scoreThreshold);

  // 3. Deduplicate
  const uniqueItems: any[] = [];
  const seenHashes = new Set<string>();
  const seenText = new Set<string>();

  for (const item of filtered) {
    if (item.source_hash && seenHashes.has(item.source_hash)) continue;
    
    // Fallback text deduplication
    const textContent = item.content || item.subject || item.title || '';
    const textSnippet = textContent.substring(0, 50).toLowerCase();
    
    if (textSnippet.length > 10 && seenText.has(textSnippet)) continue;

    if (item.source_hash) seenHashes.add(item.source_hash);
    if (textSnippet.length > 10) seenText.add(textSnippet);
    
    uniqueItems.push(item);
  }

  // 4. Enforce Token Limits (Words approximation)
  let currentWordCount = 0;
  const finalContext: any[] = [];

  // Helper to convert a relation to a natural language sentence
  const relationToText = (rel: any): string => {
    const { source_node: source, relationship_type: relType, target_node: target } = rel;
    // Map relationship types to more natural phrasing
    const map: Record<string, (s: string, t: string) => string> = {
      works_on: (s, t) => `${s} works on ${t}.`,
      blocked_by: (s, t) => `${s} is blocked by ${t}.`,
      depends_on: (s, t) => `${s} depends on ${t}.`,
      owns: (s, t) => `${s} owns ${t}.`,
      assigned_to: (s, t) => `${s} is assigned to ${t}.`,
      collaborates_on: (s, t) => `${s} collaborates on ${t}.`,
      part_of: (s, t) => `${s} is part of ${t}.`,
      signed: (s, t) => `${s} signed ${t}.`,
      mentions: (s, t) => `${s} mentions ${t}.`,
    };
    const formatter = map[relType] ?? ((s, t) => `${s} ${relType} ${t}.`);
    return formatter(source, target);
  };

  // Sort graph relations by score (descending) for better presentation
  const sortedRelations = [...graphRelations].sort((a, b) => (b.score || 0) - (a.score || 0));

  // Insert graph relations as natural language sentences
  for (const rel of sortedRelations) {
    const sentence = relationToText(rel);
    const wordCount = sentence.split(/\s+/).length;

    if (currentWordCount + wordCount <= maxWords || finalContext.length === 0) {
      finalContext.push({
        id: `graph-rel-${rel.source_node}-${rel.target_node}`,
        text: sentence,
        score: 0.0,
        source: 'graph',
      });
      currentWordCount += wordCount;
    } else {
      break;
    }
  }

  for (const item of uniqueItems) {
    let fullText = "";
    if (item.memory_key) {
      fullText = `[Memory - ${item.category}] ${item.content}`;
    } else if (item.subject) {
      fullText = `[Email] From: ${item.sender} | Subject: ${item.subject} | Snippet: ${item.snippet}`;
    } else if (item.title) {
      fullText = `[Event] Title: ${item.title} | Time: ${item.start_time} | Location: ${item.location}`;
    }

    const wordCount = fullText.split(/\s+/).length;

    if (currentWordCount + wordCount <= maxWords) {
      finalContext.push({
        id: item.id,
        text: fullText,
        score: parseFloat(item.finalScore.toFixed(3)),
        source: item.memory_key ? 'memory' : item.subject ? 'email' : 'event'
      });
      currentWordCount += wordCount;
    } else {
      break; 
    }
  }

  // Deduplicate graph relations rendered vs used (all inserted are used here)
  const renderedRelationsCount = finalContext.filter(c => c.source === 'graph').length;

  return {
    context: finalContext,
    metadata: {
      total_retrieved: rankedItems.length,
      above_threshold: filtered.length,
      included: finalContext.length,
      estimated_words: currentWordCount,
      graph_relations_rendered: graphRelations.length,
      graph_relations_used: renderedRelationsCount
    }
  };
}
