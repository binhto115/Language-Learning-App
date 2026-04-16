/**
 * Multi-session evolution test.
 *
 * Proves that the core "memory" hypothesis works: cores grow across sessions,
 * FSRS items get scheduled, and the next session's system prompt reflects
 * everything that was learned.
 *
 * Flow:
 *   Session 1 (fresh) → synthetic hiking transcript → compact → verify evolution
 *   Session 2 → synthetic cooking transcript → compact → verify cumulative evolution
 *   Session 3 → verify both hiking and cooking show up, FSRS items due
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createEmptyCard } from 'ts-fsrs';
import { buildSystemPrompt } from '../src/prompt-builder.js';
import { loadSessionContext } from '../src/session-context.js';
import {
  saveCores,
  saveSession,
  upsertCard,
  closePool,
} from '../src/db/index.js';
import type { CompactionResult } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_LEARNER_ID = '00000000-0000-0000-0000-000000000002';

const HIKING_TRANSCRIPT = `
[tutor] ¡Hola! I'm Sofía, your Spanish tutor. What made you want to learn Spanish?
[learner] Hi Sofía! I love hiking and I want to visit national parks in Mexico and Spain someday.
[tutor] Oh, that's perfect! Hiking in Spanish-speaking countries is amazing. Do you have a favorite trail?
[learner] Yeah, I love steep trails. The more challenging, the better.
[tutor] Wonderful! Then let's learn some useful words. In Spanish, a trail is "sendero." And if it's steep, we say "empinado."
[learner] Sendero and empinado. Are there trails called sendero empinado?
[tutor] Exactly! You can say "un sendero empinado" — a steep trail. And a mountain is "montaña."
[learner] Montaña. That one sounds familiar, like "mountain."
[tutor] Yes! Many Spanish words have English cousins. What else do you like about hiking?
[learner] I love being in nature and seeing wildlife. Birds, deer, you know.
[tutor] Beautiful! Nature is "naturaleza" and wildlife is "vida silvestre." A bird is "pájaro."
[learner] Pájaro, sendero, empinado, montaña. That's a lot of new words!
[tutor] You're doing great! Let's stop there for today. Next time we can talk more about your hiking adventures.
[learner] Thanks Sofía! Hasta luego.
[tutor] ¡Hasta luego!
`.trim();

const COOKING_TRANSCRIPT = `
[tutor] ¡Hola! Welcome back. Last time we talked about your love of hiking — ready to keep going?
[learner] Yes! Though today I was thinking about food. I also love cooking.
[tutor] Perfecto! Food vocabulary is so useful. You remember sendero from last time, right?
[learner] Sí, sendero means trail. And empinado is steep.
[tutor] ¡Excelente! You remembered both. Let's get into cooking. The verb for "to cook" is "cocinar."
[learner] Cocinar. Easy to remember.
[tutor] Great! And a recipe is "receta." If something is delicious, we say "delicioso."
[learner] I want to learn how to say "I cooked dinner last night" — delicious dinner.
[tutor] Nice! That would be "Cociné una cena deliciosa anoche." For now, just focus on the words. Receta, cocinar, delicioso.
[learner] Receta, cocinar, delicioso. What's a good Mexican recipe to learn?
[tutor] Mole is a classic. Very complex flavors. We call that "complejo."
[learner] Complejo. Complex flavors. I like that.
[tutor] You're picking this up fast! Let's stop here. Great session today.
[learner] Gracias Sofía! See you next time.
`.trim();

// ── Compaction runner ──────────────────────────────────────────────

async function runCompaction(
  learnerCore: unknown,
  tutorCore: unknown,
  transcript: string,
  turnCount: number,
  durationMin: number,
): Promise<CompactionResult> {
  const promptPath = join(
    __dirname,
    '..',
    'src',
    'prompts',
    'compaction-prompt.txt',
  );
  const compactionPrompt = readFileSync(promptPath, 'utf-8');

  const anthropic = new Anthropic();

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: compactionPrompt,
    messages: [
      {
        role: 'user',
        content: `
<existing_learner_core>
${JSON.stringify(learnerCore, null, 2)}
</existing_learner_core>

<existing_tutor_core>
${JSON.stringify(tutorCore, null, 2)}
</existing_tutor_core>

<session_transcript>
${transcript}
</session_transcript>

<session_metrics>
Turn count: ${turnCount}
Session duration: ${durationMin} minutes
</session_metrics>
        `.trim(),
      },
    ],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  return JSON.parse(clean) as CompactionResult;
}

// ── Helper: persist compaction result to DB ────────────────────────

async function persistCompaction(
  learnerId: string,
  sessionId: string,
  result: CompactionResult,
  preCores: { learner: unknown; tutor: unknown },
  transcript: Array<{ role: string; text: string; ts: Date }>,
) {
  await saveCores(learnerId, result.learner_core, result.tutor_core);

  await saveSession(sessionId, {
    ended_at: new Date(),
    transcript,
    pre_cores: preCores as never,
    post_cores: {
      learner: result.learner_core,
      tutor: result.tutor_core,
    },
    compaction_log: result.compaction_notes,
  });

  const creates = result.fsrs_updates.filter((u) => u.action === 'create');
  for (const u of creates) {
    const card = createEmptyCard(new Date());
    await upsertCard(learnerId, {
      item_type: u.item_type ?? 'vocabulary',
      item_key: u.item_key,
      item_context: u.context ?? null,
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
}

// ── Helper: parse transcript into db-friendly format ───────────────

function parseTranscript(
  raw: string,
): Array<{ role: string; text: string; ts: Date }> {
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => ({
      role: line.startsWith('[tutor]') ? 'tutor' : 'learner',
      text: line.replace(/^\[(tutor|learner)\]\s*/, ''),
      ts: new Date(),
    }));
}

// ── Helper: reset test learner to fresh state ──────────────────────

async function resetTestLearner() {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  await pool.query('DELETE FROM fsrs_cards WHERE learner_id = $1', [
    TEST_LEARNER_ID,
  ]);
  await pool.query('DELETE FROM sessions WHERE learner_id = $1', [
    TEST_LEARNER_ID,
  ]);
  await pool.query('DELETE FROM learners WHERE id = $1', [TEST_LEARNER_ID]);
  await pool.end();
}

// ── Validation helpers ─────────────────────────────────────────────

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function runChecks(label: string, checks: Check[]): boolean {
  console.log(`\n── ${label} ──`);
  let allPass = true;
  for (const c of checks) {
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`         ${c.detail.slice(0, 160)}`);
    if (!c.pass) allPass = false;
  }
  return allPass;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ MULTI-SESSION EVOLUTION TEST ═══\n');

  console.log('Resetting test learner...');
  await resetTestLearner();

  const results: boolean[] = [];

  // ── SESSION 1 ────────────────────────────────────────────────────
  console.log('\n━━━ SESSION 1: Hiking ━━━');
  const ctx1 = await loadSessionContext(TEST_LEARNER_ID);

  results.push(
    runChecks('Session 1 initial state', [
      {
        name: 'Learner core version is 0 (fresh)',
        pass: ctx1.learnerCore.version === 0,
        detail: `Got version ${ctx1.learnerCore.version}`,
      },
      {
        name: 'No FSRS items due',
        pass: ctx1.fsrsDueItems.length === 0,
        detail: `${ctx1.fsrsDueItems.length} items due`,
      },
      {
        name: 'Session trajectory is default',
        pass: ctx1.learnerCore.session_trajectory.includes(
          'No sessions yet',
        ),
        detail: ctx1.learnerCore.session_trajectory,
      },
    ]),
  );

  const prompt1 = buildSystemPrompt(ctx1);
  results.push(
    runChecks('Session 1 system prompt (new learner)', [
      {
        name: 'Prompt shows new learner default',
        pass: prompt1.includes('new learner'),
        detail: 'Fallback section used',
      },
      {
        name: 'No vocabulary section yet',
        pass: !prompt1.includes('Vocabulary due for review'),
        detail: 'No FSRS items to weave in',
      },
    ]),
  );

  console.log('\nRunning compaction on hiking transcript...');
  const comp1 = await runCompaction(
    ctx1.learnerCore,
    ctx1.tutorCore,
    HIKING_TRANSCRIPT,
    14,
    12,
  );
  console.log(`  Compaction notes: ${comp1.compaction_notes}`);
  console.log(
    `  FSRS creates: ${comp1.fsrs_updates.filter((u) => u.action === 'create').map((u) => u.item_key).join(', ')}`,
  );

  await persistCompaction(
    TEST_LEARNER_ID,
    ctx1.sessionId,
    comp1,
    { learner: ctx1.learnerCore, tutor: ctx1.tutorCore },
    parseTranscript(HIKING_TRANSCRIPT),
  );

  // ── SESSION 2 ────────────────────────────────────────────────────
  console.log('\n━━━ SESSION 2: Cooking ━━━');
  const ctx2 = await loadSessionContext(TEST_LEARNER_ID);

  results.push(
    runChecks('Session 2 reflects session 1 evolution', [
      {
        name: 'Learner core version incremented to 1',
        pass: ctx2.learnerCore.version === 1,
        detail: `Got version ${ctx2.learnerCore.version}`,
      },
      {
        name: 'Tutor core version incremented to 1',
        pass: ctx2.tutorCore.version === 1,
        detail: `Got version ${ctx2.tutorCore.version}`,
      },
      {
        name: 'Session trajectory evolved',
        pass: !ctx2.learnerCore.session_trajectory.includes(
          'No sessions yet',
        ),
        detail: ctx2.learnerCore.session_trajectory,
      },
      {
        name: 'Hiking is now in interests',
        pass: ctx2.learnerCore.learning_profile.interests.some((i) =>
          i.toLowerCase().includes('hik'),
        ),
        detail: `Interests: ${JSON.stringify(ctx2.learnerCore.learning_profile.interests)}`,
      },
      {
        name: 'FSRS items now due (from session 1 vocab)',
        pass: ctx2.fsrsDueItems.length >= 3,
        detail: `${ctx2.fsrsDueItems.length} items — ${ctx2.fsrsDueItems.map((i) => i.item_key).join(', ')}`,
      },
    ]),
  );

  const prompt2 = buildSystemPrompt(ctx2);
  results.push(
    runChecks('Session 2 system prompt references session 1', [
      {
        name: 'Prompt mentions hiking',
        pass:
          prompt2.toLowerCase().includes('hik') ||
          prompt2.toLowerCase().includes('sendero') ||
          prompt2.toLowerCase().includes('empinado'),
        detail: 'Evidence of session 1 carrying forward',
      },
      {
        name: 'Prompt has vocabulary section',
        pass: prompt2.includes('Vocabulary due for review'),
        detail: 'FSRS items now surfaced in prompt',
      },
      {
        name: 'Prompt includes Interests line',
        pass: prompt2.includes('Interests:'),
        detail: 'Learner profile now populated',
      },
    ]),
  );

  console.log('\nRunning compaction on cooking transcript...');
  const comp2 = await runCompaction(
    ctx2.learnerCore,
    ctx2.tutorCore,
    COOKING_TRANSCRIPT,
    14,
    12,
  );
  console.log(`  Compaction notes: ${comp2.compaction_notes}`);
  console.log(
    `  FSRS creates: ${comp2.fsrs_updates.filter((u) => u.action === 'create').map((u) => u.item_key).join(', ')}`,
  );
  console.log(
    `  FSRS rates: ${comp2.fsrs_updates.filter((u) => u.action === 'rate').map((u) => `${u.item_key}(${u.rating})`).join(', ')}`,
  );

  await persistCompaction(
    TEST_LEARNER_ID,
    ctx2.sessionId,
    comp2,
    { learner: ctx2.learnerCore, tutor: ctx2.tutorCore },
    parseTranscript(COOKING_TRANSCRIPT),
  );

  // ── SESSION 3 ────────────────────────────────────────────────────
  console.log('\n━━━ SESSION 3: Verify cumulative evolution ━━━');
  const ctx3 = await loadSessionContext(TEST_LEARNER_ID);

  results.push(
    runChecks('Session 3 shows cumulative evolution', [
      {
        name: 'Learner core version now 2',
        pass: ctx3.learnerCore.version === 2,
        detail: `Got version ${ctx3.learnerCore.version}`,
      },
      {
        name: 'BOTH hiking AND cooking in interests',
        pass:
          ctx3.learnerCore.learning_profile.interests.some((i) =>
            i.toLowerCase().includes('hik'),
          ) &&
          ctx3.learnerCore.learning_profile.interests.some((i) =>
            i.toLowerCase().includes('cook'),
          ),
        detail: `Interests: ${JSON.stringify(ctx3.learnerCore.learning_profile.interests)}`,
      },
      {
        name: 'FSRS items from both sessions',
        pass: ctx3.fsrsDueItems.length >= 5,
        detail: `${ctx3.fsrsDueItems.length} total — ${ctx3.fsrsDueItems.map((i) => i.item_key).join(', ')}`,
      },
      {
        name: 'Session trajectory reflects both topics',
        pass:
          (ctx3.learnerCore.session_trajectory.toLowerCase().includes('hik') ||
            ctx3.learnerCore.session_trajectory.toLowerCase().includes('sendero')) &&
          ctx3.learnerCore.session_trajectory.toLowerCase().includes('cook') ||
          ctx3.learnerCore.session_trajectory.toLowerCase().includes('cocinar'),
        detail: ctx3.learnerCore.session_trajectory,
      },
    ]),
  );

  const prompt3 = buildSystemPrompt(ctx3);
  console.log('\n━━━ Final system prompt for session 3 ━━━');
  console.log(prompt3);

  // ── Summary ──────────────────────────────────────────────────────
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(
    `\n═══ ${passed}/${total} CHECK GROUPS PASSED ═══\n`,
  );

  await closePool();

  if (passed < total) process.exit(1);
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await closePool().catch(() => {});
  process.exit(1);
});
