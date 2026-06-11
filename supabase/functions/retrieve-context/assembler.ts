export function assembleContext(rankedItems: any[], maxWords: number = 2000, scoreThreshold: number = 0.3) {
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

    if (currentWordCount + wordCount <= maxWords || finalContext.length === 0) {
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

  return {
    context: finalContext,
    metadata: {
      total_retrieved: rankedItems.length,
      above_threshold: filtered.length,
      included: finalContext.length,
      estimated_words: currentWordCount
    }
  };
}
