export interface LearnerCore {
  version: number;
  proficiency: {
    cefr_level: string;
    bilingual_ratio: number;
    speech_rate_wpm: number;
    self_correction_rate: number;
  };
  vocabulary: {
    active_count: number;
    passive_count: number;
    comfort_zones: string[];
    gaps: string[];
  };
  pronunciation: {
    overall_score: number;
    trajectories: Record<string, unknown>;
    l1_transfer_patterns: string[];
  };
  grammar: {
    frontier: string;
    mastered: string[];
    emerging: string[];
    breakthroughs: string[];
  };
  learning_profile: {
    interests: string[];
    correction_preference: string;
    emotional_baseline: string;
    frustration_triggers: string[];
    strengths: string[];
    endpointing_ms: number;
  };
  session_trajectory: string;
}

export interface TutorCore {
  version: number;
  persona: {
    name: string;
    voice_id: string;
    personality: string;
  };
  teaching_narrative: string;
  correction_strategy: {
    grammar: string;
    pronunciation: string;
    vocabulary: string;
  };
  pacing: {
    current_push: string;
    next_horizon: string;
    avoid: string;
  };
  fsrs_integration: string;
  engagement_insights: {
    high_engagement_topics: string[];
    low_engagement_topics: string[];
    preferred_conversation_style: string;
  };
  bilingual_ratio_target: number;
  endpointing_ms: number;
}

export interface FsrsCardRow {
  id?: string;
  learner_id: string;
  item_type: string;
  item_key: string;
  item_context: string | null;
  due: Date;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: Date | null;
}

export interface FsrsUpdate {
  action: 'create' | 'rate';
  item_type?: string;
  item_key: string;
  context?: string;
  rating?: 'Again' | 'Hard' | 'Good' | 'Easy';
}

export interface CompactionResult {
  learner_core: LearnerCore;
  tutor_core: TutorCore;
  fsrs_updates: FsrsUpdate[];
  compaction_notes: string;
}

export interface SessionData {
  ended_at: Date;
  transcript: Array<{ role: string; text: string; ts: Date }>;
  pre_cores: { learner: LearnerCore; tutor: TutorCore };
  post_cores: { learner: LearnerCore; tutor: TutorCore };
  compaction_log: string;
}
