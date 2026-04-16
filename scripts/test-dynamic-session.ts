/**
 * Live pipeline text-mode test.
 *
 * Tests the FULL LiveKit agent pipeline (system prompt → LLM → response) with
 * text input instead of audio. This catches bugs that unit tests miss:
 * - Does the LLM actually honor the built prompt?
 * - Does it reference the learner's interests?
 * - Does it weave FSRS vocabulary into responses?
 *
 * Uses session.run({ userInput }) which is specifically designed for testing
 * without a room connection.
 */
import 'dotenv/config';
import { voice, initializeLogger } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';

initializeLogger({ pretty: true, level: 'warn' });
import { buildSystemPrompt } from '../src/prompt-builder.js';
import { loadSessionContext } from '../src/session-context.js';
import { closePool } from '../src/db/index.js';

const TEST_LEARNER_ID = '00000000-0000-0000-0000-000000000002'; // same as evolution test — has cooking/hiking cores

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
    console.log(`         ${c.detail.slice(0, 200)}`);
    if (!c.pass) allPass = false;
  }
  return allPass;
}

class TestAgent extends voice.Agent {
  constructor(instructions: string) {
    super({ instructions });
  }
}

async function runTurn(
  session: voice.AgentSession,
  userInput: string,
): Promise<string> {
  const result = session.run({ userInput });
  await result.wait();

  // Extract the assistant's message text from events
  const events = result.events;
  for (const ev of events) {
    if (
      ev.type === 'message' &&
      'item' in ev &&
      ev.item?.role === 'assistant'
    ) {
      const item = ev.item as { content?: string[] | string; textContent?: string };
      if (typeof item.textContent === 'string') return item.textContent;
      if (typeof item.content === 'string') return item.content;
      if (Array.isArray(item.content)) return item.content.join(' ');
    }
  }
  return '';
}

async function main() {
  console.log('═══ DYNAMIC SESSION LIVE PIPELINE TEST ═══\n');
  console.log(
    'Loads evolved cores from DB (populated by test-evolution.ts), builds\n' +
      'a dynamic system prompt, and runs real LLM turns to verify the prompt\n' +
      'is honored in generated responses.\n',
  );

  console.log('Note: this test requires test-evolution.ts to have run first\n' +
    'so the test learner has evolved cores with hiking/cooking interests.\n');

  // 1. Load session context from DB — should have evolved cores if evolution test ran
  const ctx = await loadSessionContext(TEST_LEARNER_ID);

  console.log(
    `Loaded learner: version=${ctx.learnerCore.version}, ` +
      `interests=${JSON.stringify(ctx.learnerCore.learning_profile.interests)}, ` +
      `fsrs_due=${ctx.fsrsDueItems.length}`,
  );

  if (ctx.learnerCore.version === 0) {
    console.error(
      '\nERROR: Test learner has seed cores (version 0). Run test-evolution.ts first.\n',
    );
    await closePool();
    process.exit(1);
  }

  // 2. Build the system prompt from evolved cores
  const systemPrompt = buildSystemPrompt(ctx);
  console.log(`\n── System prompt (${systemPrompt.length} chars) ──`);
  console.log(systemPrompt.slice(0, 500) + '...\n');

  // 3. Create an AgentSession with just the LLM (no audio plugins needed for text mode)
  const agent = new TestAgent(systemPrompt);
  const session = new voice.AgentSession({
    llm: new openai.LLM({ model: 'gpt-4o' }),
    turnHandling: { turnDetection: 'manual' },
  });

  try {
    await session.start({ agent });
  } catch (err) {
    console.error('Failed to start session:', err);
    await closePool();
    process.exit(1);
  }

  const results: boolean[] = [];

  try {
    // 4. Run turn 1: greeting probe — Sofia should reference hiking/cooking
    console.log('── Turn 1: Probe for continuity ──');
    console.log('  [learner] Hi Sofia, what should we talk about today?');
    const response1 = await runTurn(
      session,
      "Hi Sofia, what should we talk about today?",
    );
    console.log(`  [sofia] ${response1}`);

    const lowerResp1 = response1.toLowerCase();
    results.push(
      runChecks('Turn 1: Continuity check', [
        {
          name: 'Response is non-empty',
          pass: response1.length > 10,
          detail: `${response1.length} chars`,
        },
        {
          name: 'References a known interest (hiking or cooking)',
          pass:
            lowerResp1.includes('hik') ||
            lowerResp1.includes('cook') ||
            lowerResp1.includes('sendero') ||
            lowerResp1.includes('cocinar') ||
            lowerResp1.includes('recipe'),
          detail: 'Should reference session history from evolved cores',
        },
        {
          name: 'No phonetic guides (no parens with syllables)',
          pass: !/\([A-Z][a-z]*-[A-Z]/.test(response1),
          detail: 'TTS rules should be honored',
        },
      ]),
    );

    // 5. Run turn 2: Ask about a hiking trail — Sofia should use hiking vocab
    console.log('\n── Turn 2: Hiking trail question ──');
    console.log("  [learner] Tell me about a hike you'd recommend.");
    const response2 = await runTurn(
      session,
      "Tell me about a hike you'd recommend.",
    );
    console.log(`  [sofia] ${response2}`);

    const lowerResp2 = response2.toLowerCase();
    results.push(
      runChecks('Turn 2: Vocabulary weaving', [
        {
          name: 'Response is non-empty',
          pass: response2.length > 10,
          detail: `${response2.length} chars`,
        },
        {
          name: 'Uses at least one FSRS-due word naturally',
          pass: ctx.fsrsDueItems.some((item) =>
            lowerResp2.includes(item.item_key.toLowerCase()),
          ),
          detail: `Due items: ${ctx.fsrsDueItems.map((i) => i.item_key).join(', ')}`,
        },
      ]),
    );

    // 6. Summary
    const passed = results.filter(Boolean).length;
    const total = results.length;
    console.log(`\n═══ ${passed}/${total} TURN CHECKS PASSED ═══\n`);

    if (passed < total) process.exit(1);
  } finally {
    await session.close();
    await closePool();
  }
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await closePool().catch(() => {});
  process.exit(1);
});
