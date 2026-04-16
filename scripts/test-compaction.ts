import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';
import type { CompactionResult } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const withDb = process.argv.includes('--with-db');

// ── Synthetic Week 1, Session 1 Transcript ──────────────────────────
// New learner "Alex" meets Sofía for the first time.
// Topics: interests (cooking, travel to Mexico), basic greetings, introductions.

const SYNTHETIC_TRANSCRIPT = `
[tutor] ¡Hola! Welcome! I'm Sofía, your Spanish tutor. I'm so glad you're here. So tell me — what made you want to learn Spanish?
[learner] Hi Sofía! Well, I'm planning a trip to Mexico next year, and I really want to be able to talk to people there, not just point at menus, you know?
[tutor] Oh, that's wonderful! Mexico is incredible. Where are you thinking of going?
[learner] I'm looking at Mexico City and maybe Oaxaca. I've heard the food there is amazing.
[tutor] ¡Sí! The food is incredible. Speaking of which — do you like cooking?
[learner] I love cooking! It's actually my main hobby. I cook almost every day.
[tutor] Perfecto! Then let's start with something useful. In Spanish, cooking is "cocinar." Can you try saying that? Co-ci-nar.
[learner] Co-ci-nar... cocinar?
[tutor] ¡Muy bien! That was great. Cocinar. And if something is delicious, we say "delicioso." De-li-cio-so.
[learner] Delicioso. I think I've heard that one before actually.
[tutor] You probably have! It's one of those words that sounds similar in English. Now, let me teach you how to introduce yourself. In Spanish, you say "Me llamo" followed by your name. So you would say "Me llamo Alex." Try it!
[learner] Me llamo Alex.
[tutor] ¡Perfecto! And to say hello, there are a couple of ways. "Hola" is the most common — like "hi." And in the morning you can say "buenos días," which means "good morning." Can you try both?
[learner] Hola... and buenos días?
[tutor] ¡Excelente! Your pronunciation is really good. Now, let me teach you one more useful word. A recipe is "receta" in Spanish. Re-ce-ta. Since you love cooking, this one will come in handy!
[learner] Receta. That's a nice word. So if I wanted to say I have a good recipe...
[tutor] Great thinking! You'd start with "Tengo una buena receta." But "tengo" means "I have" — that uses a verb form we'll learn more about soon. For now, just know that "tengo" is "I have."
[learner] Tengo una buena receta. Okay I think I can remember that.
[tutor] You're doing so well! Let me also share that numbers might come in handy for your trip — for prices, addresses, that sort of thing. Should we try some numbers? Uno, dos, tres...
[learner] Um, maybe. I think I'd rather focus on conversation stuff for now though, if that's okay? Like how to order food or ask for things.
[tutor] Absolutely! That's a great instinct. Let's keep it practical. So at a restaurant, you might hear the waiter say "¿Qué desea?" which means "What would you like?" You can answer "Quiero..." meaning "I want..." followed by the food.
[learner] Quiero... okay. So quiero tacos?
[tutor] ¡Sí! "Quiero tacos" — perfect! You're picking this up quickly. And to be extra polite, you can add "por favor" at the end — that means "please."
[learner] Quiero tacos por favor! Ha, I like that. This is fun.
[tutor] You're a natural! So let's review what we learned today. You can introduce yourself with "me llamo," say hello with "hola" or "buenos días," talk about cooking with "cocinar" and "receta," say something is "delicioso," order food with "quiero," and be polite with "por favor." That's a lot for your first session!
[learner] Wow yeah, that is a lot. I feel good about it though. The cooking words are definitely going to stick.
[tutor] I can tell you're going to do great. For our next session, we'll practice more restaurant and food vocabulary since that's what excites you. Maybe we'll even learn how to describe your favorite recipes in Spanish! ¡Hasta luego, Alex!
[learner] Hasta luego, Sofía! That means goodbye right?
[tutor] ¡Exacto! "Hasta luego" means "see you later." Great job today!
`.trim();

// ── Run Compaction ──────────────────────────────────────────────────

async function runCompaction(): Promise<CompactionResult> {
  const promptPath = join(__dirname, '..', 'src', 'prompts', 'compaction-prompt.txt');
  const compactionPrompt = readFileSync(promptPath, 'utf-8');

  const anthropic = new Anthropic();

  console.log('Calling Claude Sonnet for compaction...\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: compactionPrompt,
    messages: [
      {
        role: 'user',
        content: `
<existing_learner_core>
${JSON.stringify(SEED_LEARNER_CORE, null, 2)}
</existing_learner_core>

<existing_tutor_core>
${JSON.stringify(SEED_TUTOR_CORE, null, 2)}
</existing_tutor_core>

<session_transcript>
${SYNTHETIC_TRANSCRIPT}
</session_transcript>

<session_metrics>
Turn count: 26
Session duration: 14.5 minutes
</session_metrics>
        `.trim(),
      },
    ],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';

  // Strip markdown code fences if present
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();

  try {
    return JSON.parse(clean) as CompactionResult;
  } catch {
    console.error('Failed to parse compaction output as JSON.');
    console.error('Raw output:\n', text);
    process.exit(1);
  }
}

// ── Validation ──────────────────────────────────────────────────────

function validate(result: CompactionResult): boolean {
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  // 1. Structure check
  checks.push({
    name: 'Has all top-level keys',
    pass:
      'learner_core' in result &&
      'tutor_core' in result &&
      'fsrs_updates' in result &&
      'compaction_notes' in result,
    detail: `Keys: ${Object.keys(result).join(', ')}`,
  });

  // 2. Version increment
  checks.push({
    name: 'Learner core version = 1',
    pass: result.learner_core?.version === 1,
    detail: `Got: ${result.learner_core?.version}`,
  });
  checks.push({
    name: 'Tutor core version = 1',
    pass: result.tutor_core?.version === 1,
    detail: `Got: ${result.tutor_core?.version}`,
  });

  // 3. Interests populated
  const interests = result.learner_core?.learning_profile?.interests ?? [];
  checks.push({
    name: 'Interests include cooking',
    pass: interests.some(
      (i: string) => i.toLowerCase().includes('cook') || i.toLowerCase().includes('cocin'),
    ),
    detail: `Interests: ${JSON.stringify(interests)}`,
  });

  // 4. FSRS creates
  const creates = (result.fsrs_updates ?? []).filter(
    (u) => u.action === 'create',
  );
  checks.push({
    name: 'At least 3 FSRS create actions',
    pass: creates.length >= 3,
    detail: `Creates: ${creates.length} — ${creates.map((c) => c.item_key).join(', ')}`,
  });

  // 5. Session trajectory not empty/default
  const trajectory = result.learner_core?.session_trajectory ?? '';
  checks.push({
    name: 'Session trajectory updated',
    pass:
      trajectory.length > 0 &&
      !trajectory.includes('New learner. No sessions yet'),
    detail: `Trajectory: ${trajectory.slice(0, 80)}...`,
  });

  // 6. Teaching narrative updated
  const narrative = result.tutor_core?.teaching_narrative ?? '';
  checks.push({
    name: 'Teaching narrative updated',
    pass:
      narrative.length > 0 &&
      !narrative.includes('probe for interests, establish rapport'),
    detail: `Narrative: ${narrative.slice(0, 80)}...`,
  });

  // 7. Endpointing unchanged
  checks.push({
    name: 'Endpointing_ms unchanged (learner)',
    pass: result.learner_core?.learning_profile?.endpointing_ms === 6000,
    detail: `Got: ${result.learner_core?.learning_profile?.endpointing_ms}`,
  });
  checks.push({
    name: 'Endpointing_ms unchanged (tutor)',
    pass: result.tutor_core?.endpointing_ms === 6000,
    detail: `Got: ${result.tutor_core?.endpointing_ms}`,
  });

  // Print results
  console.log('\n═══ VALIDATION ═══\n');
  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${check.name}`);
    console.log(`         ${check.detail}`);
    if (!check.pass) allPass = false;
  }

  return allPass;
}

// ── Database Round-Trip (optional) ──────────────────────────────────

async function testDatabaseRoundTrip(result: CompactionResult) {
  const { createEmptyCard } = await import('ts-fsrs');
  const {
    getOrCreateLearner,
    saveCores,
    upsertCard,
    getDueCards,
    createSession,
    saveSession,
    closePool,
  } = await import('../src/db/index.js');

  const testLearnerId = '00000000-0000-0000-0000-000000000001';

  console.log('\n═══ DATABASE ROUND-TRIP ═══\n');

  try {
    // 1. Create learner
    const learner = await getOrCreateLearner(testLearnerId);
    console.log(
      `  [PASS] Learner created/retrieved: version=${learner.core_version}`,
    );

    // 2. Create session
    const sessionId = await createSession(testLearnerId);
    console.log(`  [PASS] Session created: ${sessionId}`);

    // 3. Save cores
    await saveCores(testLearnerId, result.learner_core, result.tutor_core);
    const updated = await getOrCreateLearner(testLearnerId);
    const coresMatch =
      updated.learner_core.version === 1 && updated.tutor_core.version === 1;
    console.log(
      `  [${coresMatch ? 'PASS' : 'FAIL'}] Cores saved and reloaded: learner v${updated.learner_core.version}, tutor v${updated.tutor_core.version}`,
    );

    // 4. Save session data
    await saveSession(sessionId, {
      ended_at: new Date(),
      transcript: SYNTHETIC_TRANSCRIPT.split('\n').map((line) => ({
        role: line.startsWith('[tutor]') ? 'tutor' : 'learner',
        text: line.replace(/^\[(tutor|learner)\]\s*/, ''),
        ts: new Date(),
      })),
      pre_cores: {
        learner: SEED_LEARNER_CORE,
        tutor: SEED_TUTOR_CORE,
      },
      post_cores: {
        learner: result.learner_core,
        tutor: result.tutor_core,
      },
      compaction_log: result.compaction_notes,
    });
    console.log(`  [PASS] Session data saved`);

    // 5. Upsert FSRS cards
    const creates = result.fsrs_updates.filter((u) => u.action === 'create');
    for (const update of creates) {
      const card = createEmptyCard(new Date());
      await upsertCard(testLearnerId, {
        item_type: update.item_type ?? 'vocabulary',
        item_key: update.item_key,
        item_context: update.context ?? null,
        due: card.due,
        stability: card.stability,
        difficulty: card.difficulty,
        elapsed_days: card.elapsed_days,
        scheduled_days: card.scheduled_days,
        reps: card.reps,
        lapses: card.lapses,
        state: card.state,
        last_review: card.last_review ?? null,
      });
    }
    console.log(`  [PASS] ${creates.length} FSRS cards upserted`);

    // 6. Query due cards
    const dueCards = await getDueCards(testLearnerId);
    console.log(
      `  [${dueCards.length > 0 ? 'PASS' : 'FAIL'}] Due cards: ${dueCards.length} — ${dueCards.map((c: { item_key: string }) => c.item_key).join(', ')}`,
    );
  } finally {
    await closePool();
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ HABLA COMPACTION TEST ═══\n');
  console.log('Scenario: Week 1, Session 1 — New learner Alex meets Sofía');
  console.log(
    'Topics: cooking, travel to Mexico, basic greetings/introductions\n',
  );

  const result = await runCompaction();

  // Print full result
  console.log('\n═══ COMPACTION OUTPUT ═══\n');
  console.log(JSON.stringify(result, null, 2));

  // Print summary
  console.log('\n═══ SUMMARY ═══\n');
  const creates = result.fsrs_updates.filter((u) => u.action === 'create');
  const rates = result.fsrs_updates.filter((u) => u.action === 'rate');
  console.log(`  FSRS creates: ${creates.length} — ${creates.map((c) => c.item_key).join(', ')}`);
  console.log(`  FSRS rates: ${rates.length}`);
  console.log(`  Session trajectory: ${result.learner_core.session_trajectory}`);
  console.log(`  Teaching narrative: ${result.tutor_core.teaching_narrative}`);
  console.log(`  Compaction notes: ${result.compaction_notes}`);

  // Run validation
  const allPass = validate(result);

  // Optional database test
  if (withDb) {
    await testDatabaseRoundTrip(result);
  }

  console.log(
    `\n═══ ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} ═══\n`,
  );

  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
