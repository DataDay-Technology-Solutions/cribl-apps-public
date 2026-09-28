// src/components/IncidentTakeover/chime.ts — the takeover's chime (P2-W19): off by default, turned on for the
// session with M on the stage (or `settings.presenter.chime`). A rising two-note sine when the red card lands
// (E5 → B5, 250 ms in all, peak gain 0.15) and one lower note when it turns green (B4). No audio file, no
// dependency: two oscillators through a gain envelope on one AudioContext.
//
// Browsers start audio only after a gesture: primeChime() runs from the M keypress (and from any key or click
// while the stage is up), creating or resuming the one AudioContext, so the chime can sound when an alert
// arrives later with no gesture of its own. Without Web Audio (or before any gesture) it stays silent.

export type ChimeKind = 'alert' | 'recovery';

/** E5 then B5 for an alert (a rising fifth); B4 for the recovery. Hz. */
export const CHIME_NOTES: Record<ChimeKind, readonly number[]> = {
  alert: [659.25, 987.77],
  recovery: [493.88],
};
export const CHIME_NOTE_SEC = 0.125;
export const CHIME_GAIN = 0.15;

type AudioCtor = new () => AudioContext;
let ctx: AudioContext | null = null;

function audioCtor(): AudioCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

/** Creates (or resumes) the one AudioContext; call it from a user gesture. */
export function primeChime(): void {
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  } catch {
    ctx = null;
  }
}

/** Plays the chime for a takeover; false when there is no audio to play it on. */
export function playChime(kind: ChimeKind): boolean {
  primeChime();
  const audio = ctx;
  if (!audio) return false;
  try {
    const start = audio.currentTime + 0.02;
    CHIME_NOTES[kind].forEach((hz, i) => {
      const at = start + i * CHIME_NOTE_SEC;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(CHIME_GAIN, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + CHIME_NOTE_SEC * 2);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(at);
      osc.stop(at + CHIME_NOTE_SEC * 2 + 0.02);
    });
    return true;
  } catch {
    return false;
  }
}
