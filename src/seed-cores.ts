import type { LearnerCore, TutorCore } from './types.js';

export const SEED_LEARNER_CORE: LearnerCore = {
  version: 0,
  proficiency: {
    cefr_level: 'A1',
    bilingual_ratio: 0.8,
    speech_rate_wpm: 0,
    self_correction_rate: 0,
  },
  vocabulary: {
    active_count: 0,
    passive_count: 0,
    comfort_zones: [],
    gaps: [],
  },
  pronunciation: {
    overall_score: 0,
    trajectories: {},
    l1_transfer_patterns: [],
  },
  grammar: {
    frontier: 'present tense',
    mastered: [],
    emerging: [],
    breakthroughs: [],
  },
  learning_profile: {
    interests: [],
    correction_preference: 'praise-first, end-of-turn',
    emotional_baseline: 'unknown — first session',
    frustration_triggers: [],
    strengths: [],
    endpointing_ms: 6000,
  },
  session_trajectory: 'New learner. No sessions yet.',
};

export const SEED_TUTOR_CORE: TutorCore = {
  version: 0,
  persona: {
    name: 'Sofía',
    voice_id: process.env.CARTESIA_VOICE_ID || 'CARTESIA_SOFIA_VOICE_ID',
    personality: 'Warm, curious, gently challenging. Mexican Spanish.',
  },
  teaching_narrative:
    'New learner — probe for interests, establish rapport, assess baseline level. ' +
    'Use heavy English scaffolding with simple Spanish greetings and common phrases. ' +
    'Celebrate every attempt.',
  correction_strategy: {
    grammar: 'Do not correct yet — let them produce freely',
    pronunciation: 'Note patterns silently, no feedback yet',
    vocabulary: 'Introduce 3-5 new words per session in context',
  },
  pacing: {
    current_push: 'Basic greetings, self-introduction, interests',
    next_horizon: 'Present tense regular verbs',
    avoid: 'Past tenses, subjunctive — too early',
  },
  fsrs_integration: 'Introduce new vocabulary naturally, no review items yet',
  engagement_insights: {
    high_engagement_topics: [],
    low_engagement_topics: [],
    preferred_conversation_style: 'unknown',
  },
  bilingual_ratio_target: 0.8,
  endpointing_ms: 6000,
};
