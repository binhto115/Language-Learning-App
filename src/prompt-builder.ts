import type { SessionContext } from './session-context.js';

const TTS_OUTPUT_RULES = `
## CRITICAL: Your Output Is Spoken Aloud
Your responses are synthesized by a Spanish-configured text-to-speech engine. Observe these rules strictly:
- NEVER use parenthetical pronunciation guides like "hola (OH-lah)" — the TTS reads them literally.
- NEVER use phonetic respellings, IPA, or dashes between syllables ("co-ci-nar").
- NEVER use markdown, bullets, or asterisks. Speak in natural flowing sentences.
- Spanish words will sound authentic. English words will have a warm Mexican-Spanish accent.
- If you want the learner to focus on a word, just repeat it naturally: "The word is cocinar. Cocinar."
`.trim();

const DEFAULT_PERSONA = `You are Sofía, a warm, curious, and gently encouraging Spanish-English language tutor with a Mexican Spanish accent.
Your learner is at CEFR A1 level. Use approximately 70-80% English and 20-30% Spanish, weaving Spanish words naturally into English sentences.
Keep responses conversational and under 3 sentences. Praise genuine effort without being saccharine.
Do not correct grammar unless asked. Introduce new vocabulary in natural context.`;

const DEFAULT_LEARNER_PROFILE =
  'This is a new learner. Start by asking about their interests and why they want to learn Spanish.';

export interface PromptBuilderOptions {
  /** Include a turn-count-triggered CEFR drift reminder. */
  includeCefrReminder?: boolean;
}

/**
 * Build the system prompt for Sofía from the session context.
 *
 * The prompt has four sections, in order:
 *   1. TTS output rules (always present)
 *   2. Tutor persona and teaching narrative (from tutor core)
 *   3. About this learner (from learner core's session_trajectory)
 *   4. FSRS vocabulary to weave in (from due cards)
 *   5. Optional CEFR reminder (triggered every 7 turns)
 */
export function buildSystemPrompt(
  ctx: SessionContext,
  opts: PromptBuilderOptions = {},
): string {
  const sections: string[] = [];

  // 1. TTS output rules — always first, always present
  sections.push(TTS_OUTPUT_RULES);

  // 2. Tutor persona
  const teachingNarrative = ctx.tutorCore?.teaching_narrative?.trim();
  if (teachingNarrative && ctx.tutorCore.version > 0) {
    // Evolved tutor core — use the narrative as Sofía's game plan for this session
    sections.push(
      `You are Sofía, a warm Spanish-English language tutor with a Mexican Spanish accent.\n\n` +
        `## Your game plan for this session\n${teachingNarrative}`,
    );
  } else {
    sections.push(DEFAULT_PERSONA);
  }

  // 3. About this learner
  const trajectory = ctx.learnerCore?.session_trajectory?.trim();
  if (
    trajectory &&
    ctx.learnerCore.version > 0 &&
    !trajectory.includes('New learner. No sessions yet')
  ) {
    sections.push(`## About this learner\n${trajectory}`);

    // Surface key learner profile info that guides the interaction
    const profile = ctx.learnerCore.learning_profile;
    const profileBits: string[] = [];
    if (profile?.interests?.length) {
      profileBits.push(`Interests: ${profile.interests.join(', ')}`);
    }
    if (profile?.correction_preference) {
      profileBits.push(
        `Correction preference: ${profile.correction_preference}`,
      );
    }
    if (profile?.frustration_triggers?.length) {
      profileBits.push(
        `Avoid these frustration triggers: ${profile.frustration_triggers.join(', ')}`,
      );
    }
    if (profileBits.length > 0) {
      sections.push(`## Learner profile\n${profileBits.join('\n')}`);
    }
  } else {
    sections.push(`## About this learner\n${DEFAULT_LEARNER_PROFILE}`);
  }

  // 4. FSRS vocabulary to weave in
  if (ctx.fsrsDueItems.length > 0) {
    const items = ctx.fsrsDueItems
      .map((i) => {
        const ctxText = i.item_context ? ` — ${i.item_context}` : '';
        return `  - "${i.item_key}"${ctxText}`;
      })
      .join('\n');
    sections.push(
      `## Vocabulary due for review\n` +
        `Weave these Spanish words naturally into the conversation. Do NOT quiz the learner explicitly — let the words emerge in context. If a word doesn't fit naturally, skip it.\n${items}`,
    );
  }

  // 5. CEFR drift reminder (every 7 turns)
  const shouldRemind =
    opts.includeCefrReminder ??
    (ctx.turnCount > 0 && ctx.turnCount % 7 === 0);

  if (shouldRemind) {
    const cefrLevel = ctx.learnerCore?.proficiency?.cefr_level || 'A1';
    const ratio = ctx.tutorCore?.bilingual_ratio_target ?? 0.8;
    sections.push(
      `## Level reminder\n` +
        `Stay at CEFR ${cefrLevel}. Target bilingual ratio: ~${Math.round(ratio * 100)}% English, ${Math.round((1 - ratio) * 100)}% Spanish. ` +
        `Do not drift above the learner's level.`,
    );
  }

  return sections.join('\n\n');
}
