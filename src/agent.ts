import 'dotenv/config';
import {
  type JobContext,
  type JobProcess,
  defineAgent,
  cli,
  voice,
  llm,
  ServerOptions,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as silero from '@livekit/agents-plugin-silero';

import { loadSessionContext, type SessionContext } from './session-context.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { runCompaction } from './compaction.js';

const CARTESIA_VOICE_ID =
  process.env.CARTESIA_VOICE_ID || '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c';

// For the prototype, a single hardcoded learner. Phase 4+ handles real auth.
const LEARNER_ID =
  process.env.LEARNER_ID || '00000000-0000-0000-0000-000000000aaa';

class SofiaAgent extends voice.Agent {
  public ctx: SessionContext;

  constructor(sessionContext: SessionContext) {
    super({ instructions: buildSystemPrompt(sessionContext) });
    this.ctx = sessionContext;
  }

  override async onEnter() {
    const isNewLearner =
      this.ctx.learnerCore.version === 0 &&
      this.ctx.learnerCore.session_trajectory.includes('No sessions yet');

    const greetingInstructions = isNewLearner
      ? "Greet the learner warmly with '¡Hola!' and introduce yourself as Sofía. " +
        'Ask what made them want to learn Spanish. Keep it brief and friendly.'
      : "Greet the learner warmly with '¡Hola!' and welcome them back. Briefly reference " +
        'something from the session trajectory to show continuity, and ask what they want to focus on today.';

    this.session.generateReply({ instructions: greetingInstructions });
  }

  override async onUserTurnCompleted(
    _chatCtx: llm.ChatContext,
    newMessage: llm.ChatMessage,
  ) {
    const text =
      typeof newMessage.content === 'string'
        ? newMessage.content
        : JSON.stringify(newMessage.content);

    this.ctx.fullTranscript.push({
      role: 'learner',
      text,
      ts: new Date(),
    });
    this.ctx.turnCount++;

    console.log(`[learner turn ${this.ctx.turnCount}] ${text}`);
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();

    // Load session context from Postgres (seeds a new learner if needed)
    console.log(`[agent] Loading session context for learner ${LEARNER_ID}`);
    const sessionContext = await loadSessionContext(LEARNER_ID);
    console.log(
      `[agent] Learner loaded: core_version=${sessionContext.learnerCore.version}, ` +
        `tutor_version=${sessionContext.tutorCore.version}, ` +
        `fsrs_due=${sessionContext.fsrsDueItems.length}, ` +
        `session_id=${sessionContext.sessionId}`,
    );

    const agent = new SofiaAgent(sessionContext);

    const session = new voice.AgentSession<SessionContext>({
      stt: new deepgram.STT({ model: 'nova-3', language: 'multi' }),
      llm: new openai.LLM({ model: 'gpt-4o' }),
      tts: new cartesia.TTS({
        model: 'sonic-3',
        voice: CARTESIA_VOICE_ID,
        language: 'es',
      }),
      vad: ctx.proc.userData.vad as silero.VAD,
      userData: sessionContext,
      turnHandling: {
        turnDetection: 'manual',
        interruption: { enabled: false },
      },
    });

    // Disable audio input initially (push-to-talk)
    session.input.setAudioEnabled(false);

    // Register push-to-talk RPC methods
    ctx.room.localParticipant!.registerRpcMethod('ptt_start', async () => {
      session.interrupt();
      session.clearUserTurn();
      session.input.setAudioEnabled(true);
      return JSON.stringify({ ok: true });
    });

    ctx.room.localParticipant!.registerRpcMethod('ptt_end', async () => {
      session.input.setAudioEnabled(false);
      session.commitUserTurn();
      return JSON.stringify({ ok: true });
    });

    // Debug snapshot RPC — returns current session state for the web debug panel
    ctx.room.localParticipant!.registerRpcMethod(
      'debug_snapshot',
      async () => {
        return JSON.stringify({
          learnerId: sessionContext.learnerId,
          sessionId: sessionContext.sessionId,
          learnerCore: sessionContext.learnerCore,
          tutorCore: sessionContext.tutorCore,
          fsrsDueItems: sessionContext.fsrsDueItems,
          turnCount: sessionContext.turnCount,
          sessionStartedAt: sessionContext.sessionStartedAt.toISOString(),
          systemPrompt: buildSystemPrompt(sessionContext),
          transcriptLength: sessionContext.fullTranscript.length,
        });
      },
    );

    // End session RPC — triggers compaction and returns pre/post diff
    ctx.room.localParticipant!.registerRpcMethod(
      'end_session',
      async () => {
        console.log(
          `[agent] End session requested. Turns: ${sessionContext.turnCount}, transcript entries: ${sessionContext.fullTranscript.length}`,
        );

        // Stop listening during compaction
        session.input.setAudioEnabled(false);

        if (sessionContext.fullTranscript.length === 0) {
          return JSON.stringify({
            ok: false,
            error: 'Nothing to compact — no transcript entries yet',
          });
        }

        try {
          const outcome = await runCompaction(sessionContext);
          return JSON.stringify({
            ok: true,
            preCores: outcome.preCores,
            postCores: {
              learner: outcome.result.learner_core,
              tutor: outcome.result.tutor_core,
            },
            fsrsUpdates: outcome.result.fsrs_updates,
            compactionNotes: outcome.result.compaction_notes,
            fsrsCreated: outcome.fsrsCreated,
            fsrsRated: outcome.fsrsRated,
            durationMs: outcome.durationMs,
          });
        } catch (err) {
          console.error('[agent] Compaction failed:', err);
          return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    // Log state changes
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[agent] State: ${ev.newState}`);
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) {
        console.log(`[stt] Final: ${ev.transcript}`);
      }
    });

    // Log tutor (agent) speech for the full transcript
    session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      (ev: { item: { role: string; textContent?: string } }) => {
        if (ev.item.role === 'assistant' && ev.item.textContent) {
          sessionContext.fullTranscript.push({
            role: 'tutor',
            text: ev.item.textContent,
            ts: new Date(),
          });
        }
      },
    );

    await session.start({ agent, room: ctx.room });
    console.log('[agent] Sofia is ready and waiting for a learner.');
  },
});

cli.runApp(new ServerOptions({ agent: import.meta.filename }));
