import * as fs from 'fs';

const JUNE23 = 1750636800000;
const DAY = 86400000;

const cases = [];
const rand = () => Math.random();
const shuffle = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
};

// 10 Mixed Cases
for(let i=0; i<3; i++) {
  // Case A: semantic champion (old, low imp) vs slightly weaker semantic (recent, high imp)
  const candidates = [];
  candidates.push({ id: "CHAMP_SEM", similarity_distance: 0.15, created_at: new Date(JUNE23 - 200 * DAY).toISOString(), llm_importance: 0.2 }); 
  candidates.push({ id: "TARGET_MIX_A", similarity_distance: 0.25, created_at: new Date(JUNE23 - 1 * DAY).toISOString(), llm_importance: 0.9, system_importance: 0.8 }); 
  for (let j = 0; j < 28; j++) candidates.push({ id: `NOISE_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
  shuffle(candidates);
  cases.push({
    id: `mixed-case-A-${i}`, kind: "ranking", query: "mixed A", nowMs: JUNE23,
    candidates, relevant: ["TARGET_MIX_A"]
  });
}

for(let i=0; i<3; i++) {
  // Case B: High semantic (deadline 20 days) vs lower semantic (deadline tomorrow)
  const candidates = [];
  candidates.push({ id: "CHAMP_SEM", similarity_distance: 0.15, deadline_at: new Date(JUNE23 + 20 * DAY).toISOString() }); 
  candidates.push({ id: "TARGET_MIX_B", similarity_distance: 0.40, deadline_at: new Date(JUNE23 + 1 * DAY).toISOString() }); 
  for (let j = 0; j < 28; j++) candidates.push({ id: `NOISE_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
  shuffle(candidates);
  cases.push({
    id: `mixed-case-B-${i}`, kind: "ranking", query: "mixed B", nowMs: JUNE23,
    candidates, relevant: ["TARGET_MIX_B"]
  });
}

for(let i=0; i<4; i++) {
  // Case C: reinforced memory (low sem) vs fresh memory (medium sem)
  const candidates = [];
  candidates.push({ id: "TARGET_MIX_C1", similarity_distance: 0.60, retrieval_count: 50 }); 
  candidates.push({ id: "TARGET_MIX_C2", similarity_distance: 0.40, retrieval_count: 0, created_at: new Date(JUNE23 - 1 * DAY).toISOString() }); 
  for (let j = 0; j < 28; j++) candidates.push({ id: `NOISE_${j}`, similarity_distance: 0.7 + rand() * 0.2 });
  shuffle(candidates);
  cases.push({
    id: `mixed-case-C-${i}`, kind: "ranking", query: "mixed C", nowMs: JUNE23,
    candidates, relevant: ["TARGET_MIX_C1", "TARGET_MIX_C2"]
  });
}

// 10 Retrieval Cases (50 candidates)
for(let i=0; i<10; i++) {
    const candidates = [];
    candidates.push({ id: `TARGET_RET`, similarity_distance: 0.2, llm_importance: 0.8 });
    for (let j = 0; j < 5; j++) candidates.push({ id: `NOISE_SEM_${j}`, similarity_distance: 0.25 + rand() * 0.1 });
    for (let j = 0; j < 44; j++) candidates.push({ id: `NOISE_RND_${j}`, similarity_distance: 0.6 + rand() * 0.3 });
    shuffle(candidates);
    cases.push({
        id: `retrieval-case-${i}`, kind: "retrieval", query: `retrieval query ${i}`, nowMs: JUNE23,
        candidates, relevant: ["TARGET_RET"]
    });
}

// 10 Urgency Cases (30 candidates)
// We use offsets that ensure TARGET_URG wins, since MRR relies on finding the relevant item.
const urgencyBuckets = [0, 1, 2, 3, 4, 5, -1, -2, -3, 2];
for(let i=0; i<10; i++) {
    const offset = urgencyBuckets[i];
    
    const candidates = [];
    candidates.push({ id: "TARGET_URG", similarity_distance: 0.55, deadline_at: new Date(JUNE23 + offset * DAY).toISOString() }); 
    for (let j = 0; j < 5; j++) candidates.push({ id: `NOISE_SEM_${j}`, similarity_distance: 0.18 + rand() * 0.05 }); 
    for (let j = 0; j < 24; j++) candidates.push({ id: `NOISE_RND_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
    shuffle(candidates);
    
    cases.push({
        id: `urgency-case-${i}`, kind: "urgency", query: `urgency query ${i}`, nowMs: JUNE23,
        candidates, relevant: ["TARGET_URG"]
    });
}

// 10 Ranking Cases (Importance beats semantic - 30 candidates)
for (let i = 0; i < 10; i++) {
  const candidates = [];
  candidates.push({ id: "TARGET_IMP", similarity_distance: 0.45, llm_importance: 0.9, system_importance: 0.9 });
  for (let j = 0; j < 5; j++) candidates.push({ id: `NOISE_SEM_${j}`, similarity_distance: 0.18 + rand() * 0.05 });
  for (let j = 0; j < 24; j++) candidates.push({ id: `NOISE_RND_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
  shuffle(candidates);
  cases.push({
    id: `ranking-imp-${i}`, kind: "ranking", query: "importance query", nowMs: JUNE23,
    candidates, relevant: ["TARGET_IMP"]
  });
}

// 10 Ranking Cases (Reinforcement beats semantic - 30 candidates)
for (let i = 0; i < 10; i++) {
  const candidates = [];
  // Candidate A: Semantic = 0.85, count = 0
  candidates.push({ id: "NOISE_SEM_CHAMP", similarity_distance: 0.15, retrieval_count: 0 });
  // Candidate B: Semantic = 0.77, count = 40 (0.5*0.77 = 0.385. Reinf = 0.05. Total = 0.435. Noise = 0.5*0.85 = 0.425. Target wins safely.)
  candidates.push({ id: "TARGET_REINF", similarity_distance: 0.23, retrieval_count: 40 });
  for (let j = 0; j < 28; j++) candidates.push({ id: `NOISE_RND_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
  shuffle(candidates);
  cases.push({
    id: `ranking-reinf-${i}`, kind: "ranking", query: "reinforcement query", nowMs: JUNE23,
    candidates, relevant: ["TARGET_REINF"]
  });
}

const dir = 'supabase/functions/retrieve-context/eval/fixtures';
if(!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(`${dir}/cases.json`, JSON.stringify(cases, null, 2));
console.log(`Generated ${cases.length} cases.`);
