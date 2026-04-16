import {
  getOrCreateLearner,
  getDueCards,
  createSession,
} from './db/index.js';
import type { LearnerCore, TutorCore } from './types.js';

export interface TranscriptEntry {
  role: 'learner' | 'tutor';
  text: string;
  ts: Date;
}

export interface FsrsDueItem {
  item_key: string;
  item_context: string | null;
}

export interface SessionContext {
  learnerId: string;
  sessionId: string;
  learnerCore: LearnerCore;
  tutorCore: TutorCore;
  fsrsDueItems: FsrsDueItem[];

  fullTranscript: TranscriptEntry[];
  turnCount: number;
  sessionStartedAt: Date;
}

export async function loadSessionContext(
  learnerId: string,
): Promise<SessionContext> {
  // 1. Fetch learner (or create with seed cores if new)
  const learner = await getOrCreateLearner(learnerId);

  // 2. Query due FSRS cards
  const dueCards = await getDueCards(learnerId);
  const fsrsDueItems: FsrsDueItem[] = dueCards.map(
    (c: { item_key: string; item_context: string | null }) => ({
      item_key: c.item_key,
      item_context: c.item_context,
    }),
  );

  // 3. Create a new session row
  const sessionId = await createSession(learnerId);

  // 4. Assemble and return the session context
  return {
    learnerId,
    sessionId,
    learnerCore: learner.learner_core as LearnerCore,
    tutorCore: learner.tutor_core as TutorCore,
    fsrsDueItems,

    fullTranscript: [],
    turnCount: 0,
    sessionStartedAt: new Date(),
  };
}
