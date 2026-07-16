import { LLMRouter } from "./llm-router.ts";

export interface ParsedQuery {
  intent: 'deadline' | 'person' | 'project' | 'general';
  entities: string[];
  isComplex: boolean;
}

export class QueryParser {
  private static rules = [
    {
      regex: /\b(deadlines?|due|schedule|timeline|commitments?)\b/i,
      intent: 'deadline' as const
    },
    {
      regex: /\b(project|phase|initiative)\s+([a-zA-Z0-9_-]+)\b/i,
      intent: 'project' as const
    },
    {
      regex: /\b(who|said|person|tell me about|sarah|john|alex|david)\s*([A-Z][a-z]+)?\b/i,
      intent: 'person' as const
    }
  ];

  public static async parse(query: string): Promise<ParsedQuery> {
    // 1. Rule-based Evaluation
    const wordCount = query.split(/\s+/).length;
    const isComplex = wordCount > 15 || query.includes(" that ") || query.includes(" which ") || query.includes(" related to ") || query.includes(" impact ");

    let detectedIntent: ParsedQuery['intent'] = 'general';
    let entities: string[] = [];

    // Simple rule extraction
    for (const rule of this.rules) {
      const match = query.match(rule.regex);
      if (match) {
        detectedIntent = rule.intent;
        if (rule.intent === 'project' && match[2]) {
          entities.push(`Project ${match[2]}`);
        } else if (rule.intent === 'person' && match[2]) {
          entities.push(match[2]);
        }
        break;
      }
    }

    if (!isComplex && detectedIntent !== 'general') {
      // Basic entity matching for capitalized words if simple
      const words = query.split(/[\s,!?.]+/);
      for (const word of words) {
        if (/^[A-Z][a-z]+$/.test(word) && !['What', 'How', 'Who', 'Where', 'When', 'Why', 'The', 'A', 'An', 'Project', 'I', 'Is', 'Are'].includes(word)) {
          if (!entities.includes(word)) entities.push(word);
        }
      }
      return { intent: detectedIntent, entities, isComplex: false };
    }

    // 2. LLM Fallback for complex queries
    const systemPrompt = `You are an NLP query parser. Analyze the user's query and output a JSON object with:
- "intent": One of "deadline", "person", "project", or "general".
- "entities": An array of important proper nouns, project names, or key subjects.
Output STRICTLY valid JSON, nothing else.`;

    const res = await LLMRouter.execute({
      systemPrompt,
      userPrompt: query,
      expectedFormat: 'json',
      capability: 'reasoning'
    });

    try {
      let content = res.content;
      const match = content.match(/\{.*\}/s);
      if (match) content = match[0];
      const parsed = JSON.parse(content);

      return {
        intent: ['deadline', 'person', 'project'].includes(parsed.intent?.toLowerCase()) ? parsed.intent?.toLowerCase() : 'general',
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        isComplex: true
      };
    } catch (e) {
      console.error("Failed to parse LLM intent, using generic", e);
      return { intent: detectedIntent, entities, isComplex };
    }
  }
}