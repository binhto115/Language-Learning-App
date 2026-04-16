# Habla — Cascaded Real-Time Pipeline Architecture

## Overview

Habla's voice pipeline uses a **cascaded streaming architecture** where every stage produces partial output before receiving full input. The core insight: by overlapping STT, LLM reasoning, and TTS synthesis in a streaming chain, we collapse what would be 1.5–2+ seconds of sequential latency into a **perceived response time of ~680ms** — comparable to a human pausing to think before responding.

This document describes what happens, in precise detail, from the moment the learner stops speaking to the moment they hear Sofía's first syllable — and everything that continues happening after that.

---

## Why Cascaded, Not Speech-to-Speech

End-to-end speech-to-speech models like Hume EVI 3 and OpenAI's gpt-realtime process audio natively — audio in, audio out, one system. They're simpler, potentially faster for basic conversation, and EVI 3 in particular offers built-in emotional intelligence that detects learner frustration and adapts tone.

We chose the cascaded pipeline (STT → LLM → TTS as separate stages) for one reason: **we need full control over the text layer.**

A language tutor isn't just a conversational agent. Every response must satisfy simultaneous constraints: maintain a specific bilingual ratio (e.g., 50% Spanish / 50% English for an A2 learner), weave in FSRS-scheduled vocabulary items that are due for review, apply the correction strategy the tutor core has learned works for this specific learner (inline recasts for grammar, end-of-turn feedback for pronunciation), and stay within CEFR-appropriate vocabulary and grammar complexity without drifting over multi-turn conversations.

These constraints require inspecting and controlling the text that becomes speech. A speech-to-speech model gives you audio — you can't enforce "use the word empinado because FSRS says it's due" or "this response must contain no more than 45% English words" on an audio stream. The cascaded pipeline gives us a text stage where all of this logic lives, at the cost of slightly more engineering complexity.

The latency penalty for cascading is real but manageable. Our target is sub-800ms perceived latency; the cascaded pipeline achieves ~680ms through streaming overlap. A speech-to-speech model might achieve ~300ms, but the instructional quality difference justifies the additional 380ms.

---

## The Naive Sequential Problem

If each pipeline stage waited for the previous stage to fully complete before starting, the latency budget would look like this:

| Stage | Duration | Cumulative |
|-------|----------|------------|
| VAD confirms end-of-turn | 30ms | 30ms |
| Deepgram finalizes transcript | 300ms | 330ms |
| LLM generates full response | 800–1,500ms | 1,130–1,830ms |
| Cartesia synthesizes full audio | 500–1,200ms | 1,630–3,030ms |
| WebRTC transports audio | 40ms | 1,670–3,070ms |

At best, the user waits 1.7 seconds. At worst, over 3 seconds. Both are unacceptable for fluid conversation — they feel laggy, robotic, and nothing like talking to a real tutor.

The solution is that Deepgram, GPT-4o-mini, and Cartesia Sonic all support **streaming** — they begin producing output from partial input. By chaining these streams together, we pay only the *latency to first output* at each stage, not the full processing time.

---

## Stage-by-Stage Architecture

### Stage 1 — Voice Activity Detection (On-Device)

**Components:** Silero VAD v6, SmartTurn, Deepgram Flux

**Latency contribution:** ~30ms (on-device, not network-dependent)

Silero VAD v6 runs entirely on the learner's phone. It's a 260K-parameter model, under 1MB, processing 30ms audio chunks in approximately 1ms via ONNX Runtime Mobile. Its job is simple: detect when speech stops.

But "speech stopped" isn't the same as "the learner is done talking." This distinction is critical for language learners, who pause 2–4× longer than native speakers while formulating sentences in their target language. A standard 500ms silence threshold — the default in most voice assistants — would cut off a learner mid-thought constantly.

Three mechanisms prevent premature cutoff:

**Dynamic silence thresholds from the Learner Core.** The compaction system tracks each learner's pause patterns across sessions. If this learner typically pauses 1.8 seconds before verb conjugations, the endpointing threshold adapts accordingly. The Tutor Core stores this as `endpointing_ms: 1800`. This value evolves — early sessions might use 6 seconds (extremely conservative), tightening to 1.5 seconds as the learner gains fluency over weeks.

**SmartTurn for semantic end-of-turn prediction.** SmartTurn is a 135M-parameter transformer (from LiveKit) that looks at the conversational context — what was said, not just how long the silence is — to predict whether the user is done. If the learner says "Cociné con..." and pauses, SmartTurn recognizes the syntactic incompleteness (a preposition without its object) and holds. If they say "Cociné con Lakshmi" and pause, that's a plausible complete sentence, so the confidence that the turn is complete rises.

**Deepgram Flux for fused ASR + turn detection.** Deepgram's Flux model integrates end-of-turn prediction directly into the ASR pipeline, using both acoustic and linguistic signals. It supplements SmartTurn — the two systems vote, and the turn is only committed when both agree with sufficient confidence.

**Push-to-talk fallback.** For A1 beginners who find the automatic turn detection unreliable or anxiety-inducing, a push-to-talk mode is available. The learner holds a button while speaking and releases when done. This eliminates turn detection entirely and gives the learner explicit control. As confidence grows, the system suggests transitioning to automatic mode.

**Fatigue adaptation.** Within a single session, the system monitors whether pause durations are increasing (a signal of cognitive fatigue). If so, endpointing thresholds widen dynamically — the system becomes more patient as the learner tires. The compaction note in the Week 1 conversation demo shows this: "Endpointing adjusted 5.5s → 6.2s (fatigue detected)."

### Stage 2 — Speech-to-Text, Streaming (Cloud)

**Primary:** Deepgram Nova-3 via WebSocket

**Fallback:** WhisperKit on-device (0.6GB, 2.2% WER, CoreML/ANE)

**Latency contribution:** ~150ms to first partial, ~300ms to final transcript

The moment VAD detects speech onset (not speech end — this is important), the phone opens a WebSocket to Deepgram Nova-3 and begins streaming raw audio. Deepgram processes audio in real-time and emits partial transcript hypotheses as they form.

For a typical learner utterance like "Cociné con Lakshmi, hicimos pasta casera," the WebSocket might emit:

```
  +100ms  interim: "Coci"
  +200ms  interim: "Cociné con"
  +350ms  interim: "Cociné con Lakshmi"
  +400ms  interim: "Cociné con Lakshmi hicimos"
  +500ms  final:   "Cociné con Lakshmi. Hicimos pasta casera."
```

**Code-switching is the critical differentiator.** The learner freely mixes Spanish and English within a single utterance — "Sí, muy rica. Pero... how do you say pasta from scratch?" Deepgram Nova-3 handles English-Spanish code-switching natively over a single WebSocket connection, at 5.26% WER in batch mode and approximately 300ms median streaming latency. No language detection step is needed; both languages are recognized simultaneously.

**Partial transcripts serve two purposes.** First, they enable LLM context pre-loading (described in the overlap section below). Second, they power the real-time transcript UI on the learner's screen, showing their words appearing as they speak — a feature that helps learners see their Spanish output and builds confidence.

**Offline fallback.** When the phone detects poor connectivity (high packet loss, >500ms RTT), it falls back to WhisperKit running on-device. WhisperKit compresses Whisper Large V3 Turbo (809M parameters) to 0.6GB with only ~1% WER degradation, achieving 2.2% WER and 0.46-second hypothesis latency on iPhone via CoreML and Apple Neural Engine. The tradeoff: WhisperKit doesn't support real-time code-switching as cleanly as Deepgram, and latency is higher. But it keeps the app functional on airplanes, in rural areas, and in developing markets with unreliable connectivity.

### Stage 3a — Pronunciation Assessment, Async (Cloud, Parallel)

**Primary:** SpeechAce API (es-MX, es-ES, en-US)

**Supplementary:** Azure Pronunciation Assessment (phoneme-level IPA)

**Latency contribution:** ~400ms, but **non-blocking** — does not add to perceived latency

This stage runs in parallel with Stage 3b (LLM reasoning). The moment the final transcript and corresponding audio chunk are available, the audio is sent to SpeechAce for phoneme-level scoring. The transcript goes to the LLM simultaneously. Neither waits for the other.

SpeechAce returns:

- **Phoneme-level scores** for each word (e.g., "casera" → /k/ 92%, /a/ 88%, /s/ 95%, /e/ 91%, /ɾ/ 71%, /a/ 89%)
- **Fluency metrics:** speech rate (words per minute), pause frequency, pause duration distribution
- **Intonation analysis:** pitch contour compared to native reference
- **CEFR-aligned composite score** calibrated against their specific model for non-native speakers

SpeechAce supports both Castilian (es-ES) and Latin American (es-MX) Spanish with models specifically trained for non-native speaker evaluation, claiming 0.9 Pearson correlation with human raters.

Azure Pronunciation Assessment provides supplementary data — its Hierarchical Transformer with ordinal regression (PCC 0.842 on SpeechOcean762) gives more granular phoneme-level IPA feedback and error classification (omission, insertion, mispronunciation). However, its prosody assessment (stress, intonation, rhythm) is currently only available for en-US, which limits its value for Spanish pronunciation coaching. We use it primarily for English pronunciation feedback when the learner is practicing English phonemes.

**How pronunciation results enter the conversation.** SpeechAce scores typically arrive ~400ms after the audio is sent — by which point the LLM has already begun generating its response. The scores are handled in one of three ways:

1. **Immediate injection.** If the LLM's response hasn't addressed pronunciation yet and the scores reveal a notable issue, the orchestration layer appends the feedback to the LLM's context mid-generation. The LLM's next sentence can then reference it naturally: "By the way, your /ɾ/ in casera was much better than last week."

2. **Deferred to conversationally appropriate moment.** The Tutor Core specifies this learner's preferred correction style. If the learner prefers end-of-turn pronunciation feedback (not mid-conversation interruptions), the scores are stored and surfaced at the next natural pause — after the current conversational thread resolves.

3. **Silent logging.** If the scores show no notable issues, they're logged to the session buffer for post-session compaction. The Learner Core's phoneme accuracy history updates without the learner ever seeing explicit feedback — they just experience the tutor organically choosing words that contain phonemes they need to practice.

### Stage 3b — LLM Reasoning, Streaming (Cloud)

**Model:** GPT-4o-mini

**Latency contribution:** ~200ms TTFT (time to first token), then streams continuously

**Compaction model (post-session):** Claude Sonnet

This is the brain of the pipeline. GPT-4o-mini receives a structured prompt containing:

- **Learner Core** (~400-600 tokens): CEFR level, bilingual ratio target, phoneme accuracy history, vocabulary comfort zones, grammar frontier, L1 transfer patterns, correction preferences, emotional baseline
- **Tutor Core** (~300-500 tokens): persona description, correction strategies (grammar: inline recast; pronunciation: end-of-turn; vocabulary: answer then reuse 2×), pacing model (current push, next horizon, topics to avoid), FSRS integration strategy, endpointing configuration, emotional approach
- **FSRS items due** (~50-100 tokens): vocabulary words scheduled for review this session, with stability scores and last-seen dates
- **Conversation history** (last 5 turns, ~200-400 tokens): recent context for coherent dialogue
- **Pronunciation scores** (when available, ~50 tokens): SpeechAce results from the current utterance

The system prompt enforces several constraints simultaneously:

**Bilingual ratio control.** The prompt specifies the target ratio (e.g., "Respond using approximately 50% Spanish and 50% English. Spanish should be used for vocabulary the learner has demonstrated comfort with. English should be used for new concepts, corrections, and scaffolding."). This ratio comes from the Learner Core and progresses from 80/20 EN/ES at A1 to 15/85 at B1+.

**CEFR drift prevention.** Research (Almasi et al., 2025) shows that LLMs prompted to stay at a specific CEFR level gradually drift toward their default difficulty over multi-turn conversations. Mitigation: the system prompt is reinforced every 5-10 turns with an explicit reminder of the target level, and output is periodically validated against vocabulary frequency lists. If drift is detected (vocabulary complexity exceeds the target CEFR band), the system triggers regeneration.

**FSRS vocabulary weaving.** Rather than explicit "let's review these words" prompts (which the Tutor Core has learned this learner dislikes), the system prompt instructs the LLM to naturally weave due vocabulary items into conversation. If "empinado" is due for review, the prompt says: "Find a natural way to surface the word 'empinado' in conversation — ask about their last hike, reference terrain, or use it in your own description." The learner experiences a natural conversation; the system ensures spaced repetition happens.

**Why GPT-4o-mini, not a larger model.** The real-time loop prioritizes latency over reasoning depth. GPT-4o-mini delivers ~200ms time-to-first-token with sufficient quality for conversational response generation, bilingual ratio management, and correction decisions. At ~$0.01/minute of conversation, it's cost-viable for a consumer subscription product. The *deeper* reasoning — analyzing session patterns, updating teaching strategies, restructuring the Learner and Tutor Cores — happens post-session via Claude Sonnet, where latency doesn't matter and reasoning quality is paramount.

**Streaming output.** GPT-4o-mini doesn't wait to generate the full response before sending tokens. It streams tokens as they're generated, typically at 50-100 tokens/second. The orchestration layer receives these tokens in real-time and forwards them to the TTS text buffer.

### Stage 4 — Text-to-Speech, Streaming (Cloud + On-Device)

**Primary:** Cartesia Sonic 3 (90ms TTFA) / Sonic Turbo (40ms TTFA)

**Pronunciation demos:** Google Cloud TTS with IPA `<phoneme>` tags

**Offline:** Piper TTS (20-60MB/voice, 35+ languages)

**Latency contribution:** ~60ms TTFA (time to first audio)

Cartesia Sonic receives LLM tokens through the text buffer (described in the next section) and begins synthesizing speech as soon as it has enough text to produce natural-sounding audio.

**Why Cartesia Sonic specifically.** At 40ms TTFA (Sonic Turbo) or 90ms (Sonic 3), Cartesia has the lowest time-to-first-audio of any production TTS service. It supports 40+ languages including Spanish and English via streaming WebSocket, with voice quality that rivals ElevenLabs at significantly lower latency. For a real-time conversational application where every millisecond of perceived delay matters, the TTFA advantage is decisive.

**Voice identity.** Cartesia supports custom voice design. Sofía's voice is configured as a warm, mid-pitch female voice with Mexican Spanish characteristics — the tutor persona described in the Tutor Core. The voice ID (`cartesia_sofia_mx_warm`) is stored in the Tutor Core and could theoretically be swapped for different tutor personas (a formal Castilian teacher, a casual Argentine conversation partner) as the product evolves.

**The pronunciation demo exception.** When the tutor needs to demonstrate exactly how a Spanish phoneme should sound — "the r in era should be a quick flap, like the t in American English butter: era, era" — Cartesia's standard synthesis isn't precise enough. For these moments, the system switches to **Google Cloud TTS with SSML phoneme tags**:

```xml
<speak>
  <phoneme alphabet="ipa" ph="ˈe.ɾa">era</phoneme>
</speak>
```

Google Cloud TTS is the only major TTS provider that supports full IPA phoneme specification in Spanish, enabling precise control over how each sound is produced. The demo audio is generated at adjustable speed (0.8× for new learners, 1.0× as they progress) and inserted into the audio stream at the appropriate moment. The latency penalty for switching to Google TTS is minimal for these short demo utterances.

**Offline fallback.** Piper TTS (VITS architecture, 20-60MB per voice, GPL-3.0) runs on-device for offline mode. It supports 35+ languages with dedicated Spanish voices (es-ES, es-MX, es-AR) and runs faster-than-real-time on mobile CPUs. The quality is noticeably lower than Cartesia — more robotic prosody, less natural intonation — but it keeps the app functional without connectivity.

### Stage 5 — Audio Transport (Cloud → Device)

**Protocol:** WebRTC via LiveKit

**Codec:** Opus

**Latency contribution:** ~40ms

WebRTC handles the last mile from server to the learner's phone. It includes built-in jitter buffering (smoothing out network irregularities), echo cancellation (preventing Sofía's voice from feeding back into the microphone), and adaptive bitrate (degrading gracefully on poor connections).

**Why WebRTC, not raw WebSocket audio.** WebSocket transport would be simpler but doesn't handle the realities of mobile networks — packet loss, jitter, NAT traversal, cellular handoffs. WebRTC was built for exactly this: real-time audio over unreliable networks. The Opus codec provides excellent quality at low bitrate (typically 24-48 kbps for voice), and WebRTC's built-in TURN/STUN servers handle NAT traversal that would otherwise block connections on many mobile networks.

**Orchestration.** LiveKit Agents provides the server-side framework, with Pipecat integration for the AI pipeline management. LiveKit handles room management, participant tracking, and media routing. Pipecat handles the AI-specific concerns: managing the STT → LLM → TTS pipeline, handling the text buffer between LLM and TTS, integrating Silero VAD, and coordinating the parallel SpeechAce calls.

### Stage 6 — Post-Session Compaction (Async)

**Model:** Claude Sonnet

**Latency:** ~8 seconds (async, non-blocking — runs after the session ends)

**Cost:** ~$0.04/session

After the learner ends their session, the compaction engine runs. Claude Sonnet receives:

- The full session transcript with timestamps
- The pronunciation score timeline (all SpeechAce results from the session)
- Emotion data (pause patterns, hesitation frequency, speech rate trends within the session)
- The current Learner Core
- The current Tutor Core

It produces:

- **Updated Learner Core** with new CEFR assessment, adjusted bilingual ratio, updated phoneme accuracy trajectories, new vocabulary entries, grammar frontier progression, and any new patterns observed (e.g., "learner began self-correcting gender agreement mid-sentence — metalinguistic awareness emerging")
- **Updated Tutor Core** with refined teaching strategies, updated topic engagement data, adjusted pacing model, and any course corrections (e.g., "cooking topics sustain engagement 2.3× better than textbook scenarios — prioritize accordingly")
- **FSRS card state updates** with difficulty ratings derived from session performance — words the learner used fluently get stability increases, words they struggled with get shorter review intervals
- **Compaction diff** showing what changed and what didn't — used for the Compaction tab in the vision doc and for debugging

The key design principle, borrowed from Continuous Claude research: **compaction must be lossy but intentional**. It preserves trajectories and patterns, not raw data. The Learner Core doesn't store "on March 15, the learner said 'empinado' correctly" — it stores "empinado: mastered after 8 exposures over 3 weeks, now at 45-day FSRS interval, first learned in the context of SLO hiking." The narrative form is what enables any future model instance to reconstruct the teaching relationship from the cores alone.

---

## The Streaming Overlap — How 680ms Actually Works

The critical architectural insight is that Stages 2, 3b, and 4 all operate as **streaming pipelines that overlap in time**. Here's the exact sequence of events:

```
TIME    EVENT
─────   ──────────────────────────────────────────────────────────────

  0ms   Learner stops speaking.
        Silero VAD detects silence onset on-device.

 30ms   SmartTurn + Deepgram Flux confirm: likely end-of-turn.
        System commits to processing this as a complete utterance.
        (If SmartTurn is uncertain, it waits — endpointing_ms from
        the Learner Core determines how long.)

        Meanwhile, Deepgram Nova-3 has been streaming partial
        transcripts throughout the learner's utterance. The LLM
        context (learner core + tutor core + FSRS items + history)
        was pre-loaded into the prompt buffer when speech began.

300ms   Deepgram emits the final transcript:
        "Cociné con Lakshmi. Hicimos pasta casera."

        TWO PARALLEL PATHS fork here:
        → Path A: transcript → GPT-4o-mini (Stage 3b)
        → Path B: raw audio → SpeechAce (Stage 3a)

        The LLM prompt is complete: pre-loaded context + new
        utterance. GPT-4o-mini begins inference.

500ms   LLM emits first tokens: "¡Muy"
        These go into the text buffer.

520ms   LLM continues: "¡Muy bien!"
        Text buffer recognizes a clause boundary (exclamation mark).

530ms   Text buffer flushes "¡Muy bien!" to Cartesia Sonic.
        Cartesia begins audio synthesis.

590ms   Cartesia emits first audio bytes for "¡Muy..."
        Audio bytes go to WebRTC transport layer.

630ms   Audio arrives at learner's phone speaker.

~680ms  LEARNER HEARS "¡Muy..."

        ─── Everything below happens while the learner listens ───

700ms   SpeechAce results arrive (Path B completes).
        Scores show /ɾ/ in "casera" at 58% (improved from 23%).
        Results are injected into the LLM's ongoing context.

        LLM is still generating: "That sounded really natural!
        Your /r/ flap in casera has gotten noticeably better..."

        Cartesia is synthesizing the previous chunk while receiving
        the next chunk from the LLM. Audio streams continuously
        to the learner's phone — no gaps, no buffering pauses.

~2500ms LLM finishes generating its full response.
        Final tokens are flushed to Cartesia.

~3200ms Cartesia finishes synthesizing the last audio chunk.
        WebRTC delivers the final audio bytes.

~3500ms Learner hears the end of Sofía's response.
```

**The learner's experience:** a ~680ms pause (natural, like a person thinking), followed by continuous, fluid speech. They have no awareness that the second half of the response hadn't been generated yet when they started hearing the first half.

### The Text Buffer Between LLM and TTS

The text buffer is a critical component managed by the orchestration layer (Pipecat). It solves a tension between two requirements:

**TTS needs enough text to produce natural speech.** If you feed Cartesia one word at a time, it can't plan prosody — it doesn't know if the sentence is a question or a statement, where emphasis should fall, or how the intonation should arc. The result sounds choppy and robotic.

**Latency requires starting TTS as early as possible.** Waiting for the full LLM response before starting TTS would add 800-1500ms of pure delay.

The text buffer resolves this by accumulating LLM tokens and flushing to TTS at **natural break points**:

- Sentence-ending punctuation (`.`, `!`, `?`)
- Clause-separating punctuation (`,`, `;`, `:`, `—`)
- After accumulating a minimum chunk size (~5-10 tokens) without hitting punctuation

The first flush typically happens 50-100ms after the LLM's first token — enough to accumulate a short clause like "¡Muy bien!" but not so long that we lose the latency advantage of streaming.

Subsequent flushes happen at every natural break point. Cartesia receives a stream of clauses, each large enough for natural prosody planning, delivered as fast as the LLM generates them. The result is continuous, natural-sounding speech with no perceptible gaps between chunks.

**Bilingual chunking.** An additional complexity: when the response contains both Spanish and English, the buffer must be aware of language boundaries. A chunk like "That's the preterite — cociné" should be flushed as a single unit so Cartesia can handle the language switch smoothly, rather than splitting at the dash and producing an awkward pause at the code-switch boundary.

---

## Latency Budget Summary

| Stage | Component | Contribution to Perceived Latency | Notes |
|-------|-----------|-----------------------------------|-------|
| 1 | Silero VAD + SmartTurn | ~30ms | On-device, fixed |
| 2 | Deepgram Nova-3 (final) | ~270ms | 300ms total minus 30ms overlap with VAD |
| 3a | SpeechAce | 0ms | Non-blocking parallel path |
| 3b | GPT-4o-mini TTFT | ~200ms | Time to first token only |
| — | Text buffer accumulation | ~50-100ms | Waiting for first clause boundary |
| 4 | Cartesia Sonic TTFA | ~60ms | Time to first audio byte |
| 5 | WebRTC transport | ~40ms | Server to device |
| **Total** | | **~650–700ms** | **Perceived time to first speech** |

The full response may take 2.5-3.5 seconds to generate and synthesize, but the learner starts hearing speech at ~680ms and experiences continuous audio from that point forward.

---

## Cost Model — 20 Minutes Per Day

Assuming a typical 20-minute daily session with approximately 40 learner utterances and 40 tutor responses:

| Service | Rate | Daily Cost |
|---------|------|------------|
| Deepgram Nova-3 (STT) | $0.0077/min × 20 min | $0.15 |
| GPT-4o-mini (real-time LLM) | ~$0.01/min × 20 min | $0.20 |
| Cartesia Sonic 3 (TTS) | ~$0.015/min × 10 min output | $0.15 |
| SpeechAce (pronunciation) | ~$0.008/req × ~40 utterances | $0.32 |
| Google Cloud TTS (IPA demos) | ~$0.016/1K chars × ~500 chars | $0.01 |
| Claude Sonnet (compaction) | ~1 call/session | $0.04 |
| LiveKit/WebRTC (transport) | ~$0.004/min × 20 min | $0.08 |
| **Total per active user** | | **~$0.95/day → $29/mo** |

**Subscription viability.** At a $15/month subscription price, the product requires a 2.5–3:1 registered-to-active ratio to break even on infrastructure (before engineering, marketing, and other costs). This ratio is typical for consumer subscription apps — not all subscribers use the product daily. The unit economics are directly competitive with Praktika ($8/mo) and Speak ($14/mo), while delivering capabilities neither currently offers: phoneme-level Spanish pronunciation scoring, FSRS adaptive reinforcement, narrative memory across sessions, and real bilingual code-switching.

**Cost optimization levers.** SpeechAce is the largest single cost item. Optimizations include: scoring only utterances that contain target phonemes or new vocabulary (rather than every utterance), batching short utterances into single API calls, and eventually moving to on-device pronunciation assessment (the Brainiall engine at 17MB achieves competitive phone-level scoring with sub-300ms CPU inference, though it requires ML engineering investment to integrate).

---

## Mobile Implementation

**Framework:** React Native with native modules for latency-critical audio paths.

The JavaScript layer handles UI, conversation state, FSRS card management, and orchestration logic. Native Swift (iOS) and Kotlin (Android) modules handle the audio pipeline: microphone capture, Silero VAD processing, WebRTC connection management, and audio playback.

**Sherpa-ONNX** (v1.12.34, March 2026) provides the on-device speech toolkit: Zipformer streaming ASR (RTF 0.05 on iPhone 15 Pro, 45MB RAM, <1% battery/hour), Piper TTS, and Silero VAD — all accessible through a single library supporting 12 programming languages.

**Key native modules:**

- `whisper.rn` — React Native bindings for WhisperKit (offline STT fallback)
- `LiveKit React Native SDK` — WebRTC transport with room management
- `ONNX Runtime Mobile` — Silero VAD and SmartTurn inference on-device
- Native audio session management — handling interruptions (phone calls, notifications), background audio, and Bluetooth device routing

---

## Open Questions and Future Work

**Emotion detection without Hume.** By choosing the cascaded pipeline over Hume EVI 3 as the orchestrating brain, we lose EVI 3's built-in emotional intelligence — the ability to detect frustration, confusion, and excitement from vocal prosody and adapt tone in response. Options for adding this back: integrating Hume's emotion API as a separate async call (similar to SpeechAce), using acoustic features from Deepgram (pause patterns, speech rate changes) as proxy emotion signals, or building a lightweight on-device classifier for basic affective state detection. The Tutor Core already tracks emotional baselines; the question is how to feed real-time emotion signals into the LLM's context.

**Gemini 2.5 Flash as a cost optimization.** Google's Gemini 2.5 Flash Native Audio offers speech-to-speech at ~$0.01-0.05/minute — potentially 2-5× cheaper than our cascaded pipeline. For high-volume users or a lower price tier, a hybrid architecture could route simpler conversational turns through Gemini (where full text control is less critical) and use the cascaded pipeline only for turns that require precise bilingual ratio enforcement, FSRS vocabulary weaving, or pronunciation feedback delivery.

**On-device LLM for offline mode.** The current offline fallback (WhisperKit STT + Piper TTS) has no LLM in the loop — it can transcribe and speak but can't reason. As on-device models improve (Qwen3-Omni at 30B parameters with 3B-active MoE shows promise), a full offline tutoring mode becomes feasible, with compaction syncing to cloud when connectivity returns.

**CEFR drift monitoring in production.** The Almasi et al. (2025) finding on alignment drift needs production-scale validation. Instrumenting the pipeline to measure actual CEFR level of LLM outputs (via vocabulary frequency analysis and grammar complexity scoring) against target levels will reveal how often drift occurs and whether 5-10 turn prompt reinforcement is sufficient or more aggressive intervention is needed.