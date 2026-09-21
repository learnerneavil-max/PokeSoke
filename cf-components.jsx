> **One dependency to add.** `AIChat.tsx` imports `xpProgressClient` from `@/lib/types`. Append this to `lib/types.ts` (the XP curve lives in `lib/game/engine.ts`, but that module is server-facing — mirroring the formula as a tiny pure helper keeps it out of the client bundle):
>
> ```ts
> /** Client-safe mirror of lib/game/engine.ts → xpProgress(). Keep in lockstep. */
> export function xpProgressClient(xp: number) {
>   const level = Math.min(100, Math.max(1, 1 + Math.floor(Math.sqrt(Math.max(xp, 0) / 50))));
>   const currentFloor = Math.pow(level - 1, 2) * 50;
>   const nextLevelAt = Math.pow(level, 2) * 50;
>   const span = Math.max(1, nextLevelAt - currentFloor);
>   const intoLevel = Math.max(0, xp - currentFloor);
>   return { level, intoLevel, nextLevelAt, pct: Math.min(100, Math.round((intoLevel / span) * 100)) };
> }
> ```

```tsx
// ═══════════════════════════════════════════════════════════════════════════
//  components/CharacterCreator.tsx
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, Plus, Wand2 } from 'lucide-react';

const SUGGESTIONS = [
  'A burnt-out night-shift paramedic who jokes to cope and never talks about the calls',
  'An elegant art thief who treats theft as a craft and resents being underestimated',
  'A shipboard AI fragment that thinks it is the last of its kind and is not sure it minds',
  'A teenage skateboarder who acts fearless and is secretly terrified of being ordinary',
];

interface CharacterCreatorProps {
  busy: boolean;
  onCreate: (brief: string, name: string) => Promise<void> | void;
}

export default function CharacterCreator({ busy, onCreate }: CharacterCreatorProps) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [name, setName] = useState('');

  const ready = brief.trim().length >= 8 && !busy;

  const submit = async () => {
    if (!ready) return;
    await onCreate(brief.trim(), name.trim());
    setBrief('');
    setName('');
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 px-4 py-3 text-sm text-slate-300 transition hover:border-violet-400/40 hover:text-white"
      >
        <Plus className="h-4 w-4" /> Forge a new character
      </button>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="panel flex flex-col gap-3 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Wand2 className="h-4 w-4 text-violet-300" /> Character forge
        </h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-400 hover:text-white"
        >
          Cancel
        </button>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-slate-400">Who are they?</span>
        <textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          rows={3}
          maxLength={400}
          placeholder="Describe a personality, a job, a wound, an obsession — the forge fills in the rest."
          className="resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-violet-400/40"
        />
        <span className="text-right text-[10px] text-slate-500">{brief.length}/400</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-slate-400">
          Name <span className="text-slate-500">(optional — let the forge choose)</span>
        </span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={40}
          placeholder="Leave blank to let the model name them"
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-violet-400/40"
        />
      </label>

      <details className="text-[11px] text-slate-400">
        <summary className="cursor-pointer select-none hover:text-slate-300">
          Need inspiration?
        </summary>
        <ul className="mt-2 flex flex-col gap-1.5">
          {SUGGESTIONS.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => setBrief(suggestion)}
                className="w-full rounded-md bg-white/[0.03] px-2.5 py-1.5 text-left transition hover:bg-white/[0.07] hover:text-slate-200"
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      </details>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!ready}
        className="flex items-center justify-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Forging…
          </>
        ) : (
          <>
            <Wand2 className="h-4 w-4" /> Summon
          </>
        )}
      </button>
    </motion.div>
  );
}
```

```tsx
// ═══════════════════════════════════════════════════════════════════════════
//  components/BattleArena.tsx
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, Play, Swords, Trophy } from 'lucide-react';
import { xpProgressClient, type Battle, type BattleOutcome, type BattleTurn, type Character } from '@/lib/types';

interface BattleArenaProps {
  challenger: Character;
  opponents: Character[];
  battles: Battle[];
  onResolved: (outcome: BattleOutcome) => void;
}

const KIND_STYLES: Record<BattleTurn['kind'], string> = {
  attack: 'text-slate-300',
  special: 'text-orange-300',
  crit: 'text-red-300',
  dodge: 'text-sky-300',
  heal: 'text-emerald-300',
};

export default function BattleArena({
  challenger, opponents, battles, onResolved,
}: BattleArenaProps) {
  const [defenderId, setDefenderId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BattleOutcome | null>(null);
  const [playing, setPlaying] = useState(false);
  const [visibleTurns, setVisibleTurns] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const tickRef = useRef<number | null>(null);

  const defender = useMemo(
    () => opponents.find((o) => o.id === defenderId) ?? null,
    [opponents, defenderId],
  );

  /** Replays the server's turn log one beat at a time — pure presentation. */
  useEffect(() => {
    if (!playing || !outcome) return;

    tickRef.current = window.setInterval(() => {
      setVisibleTurns((count) => {
        if (count >= outcome.battle.turns.length) {
          if (tickRef.current !== null) window.clearInterval(tickRef.current);
          tickRef.current = null;
          setPlaying(false);
          return count;
        }
        return count + 1;
      });
    }, 380);

    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [playing, outcome]);

  const fight = useCallback(async () => {
    if (!defenderId) return;

    setError(null);
    setOutcome(null);
    setVisibleTurns(0);

    try {
      const response = await fetch('/api/battle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengerId: challenger.id, defenderId }),
      });

      const data = (await response.json()) as BattleOutcome & { error?: string };

      if (!response.ok || data.error) {
        setError(data.error ?? 'The arena rejected that match.');
        return;
      }

      setOutcome(data);
      onResolved(data);
      setPlaying(true);
    } catch (cause) {
      console.error('[BattleArena] fight failed', cause);
      setError('Network problem reaching the arena.');
    }
  }, [challenger.id, defenderId, onResolved]);

  const revealedTurns = outcome ? outcome.battle.turns.slice(0, visibleTurns) : [];
  const finishedReplay = outcome !== null && visibleTurns >= outcome.battle.turns.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Swords className="h-4 w-4 text-orange-300" /> Arena
        </h2>
        <span className="text-xs text-slate-400">
          All outcomes are calculated server-side
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 scroll-thin">
        {/* ── Match setup ─────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <article className="panel p-4">
            <p className="mb-3 text-[10px] uppercase tracking-wider text-slate-400">Your fighter</p>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-100">{challenger.name}</p>
                <p className="text-xs text-slate-400">
                  Lv {challenger.level} · {challenger.archetype} · {challenger.wins}W-{challenger.losses}L
                </p>
              </div>
              <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] uppercase text-violet-300 ring-1 ring-violet-400/25">
                {challenger.mood}
              </span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-violet-400"
                style={{ width: `${xpProgressClient(challenger.xp).pct}%` }}
              />
            </div>
          </article>

          <article className="panel p-4">
            <p className="mb-3 text-[10px] uppercase tracking-wider text-slate-400">Opponent</p>
            {defender ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-100">{defender.name}</p>
                    <p className="text-xs text-slate-400">
                      Lv {defender.level} · {defender.archetype} · {defender.wins}W-{defender.losses}L
                    </p>
                  </div>
                  <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] uppercase text-orange-300 ring-1 ring-orange-400/25">
                    {defender.mood}
                  </span>
                </div>
                <p className="mt-3 text-xs text-slate-400">{defender.tagline ?? 'Unknown.'}</p>
              </>
            ) : (
              <select
                value={defenderId ?? ''}
                onChange={(event) => setDefenderId(event.target.value || null)}
                className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-100 outline-none focus:border-orange-400/40"
              >
                <option value="">Choose an opponent…</option>
                {opponents.map((opponent) => (
                  <option key={opponent.id} value={opponent.id}>
                    {opponent.name} — Lv {opponent.level} {opponent.archetype}
                  </option>
                ))}
              </select>
            )}
          </article>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void fight()}
            disabled={!defenderId || playing}
            className="flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {playing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {playing ? 'Resolving…' : 'Fight'}
          </button>
          {defender && (
            <button
              type="button"
              onClick={() => { setDefenderId(null); setOutcome(null); }}
              className="text-xs text-slate-400 hover:text-white"
            >
              Change opponent
            </button>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {/* ── Replay ──────────────────────────────────────────────── */}
        <AnimatePresence>
          {outcome && (
            <motion.section
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-6"
            >
              <div className="panel p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Trophy className="h-4 w-4 text-amber-300" />
                    <p className="text-sm font-semibold text-slate-100">
                      {outcome.battle.winner_id === challenger.id
                        ? `${challenger.name} wins`
                        : `${outcome.defender.name} wins`}
                    </p>
                  </div>
                  <p className="text-xs text-slate-400">
                    {outcome.battle.rounds} rounds · +{outcome.xpAwarded} XP to the winner · seed{' '}
                    {String(outcome.battle.rng_seed)}
                  </p>
                </div>

                {outcome.levelUps.length > 0 && (
                  <p className="mt-2 text-xs text-amber-300">
                    {outcome.levelUps
                      .map((l) => `${l.name} reached level ${l.to}`)
                      .join(' · ')}
                  </p>
                )}

                <ul className="mt-4 flex flex-col gap-2">
                  {revealedTurns.map((turn, index) => (
                    <motion.li
                      key={`${turn.turn}-${index}`}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-start gap-3 text-xs"
                    >
                      <span className="mt-0.5 w-8 shrink-0 text-right text-[10px] text-slate-500">
                        R{turn.round}
                      </span>
                      <span className={KIND_STYLES[turn.kind]}>
                        {turn.narration}
                      </span>
                      <span className="ml-auto shrink-0 tabular-nums text-[10px] text-slate-500">
                        {challenger.name.slice(0, 3)} {turn.hpAfter[challenger.id] ?? '–'} ·{' '}
                        {outcome.defender.name.slice(0, 3)} {turn.hpAfter[outcome.defender.id] ?? '–'}
                      </span>
                    </motion.li>
                  ))}
                </ul>

                {finishedReplay && (
                  <p className="mt-4 border-t border-white/10 pt-3 text-[10px] text-slate-500">
                    Replay complete. The seed above reproduces this exact fight.
                  </p>
                )}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* ── History ─────────────────────────────────────────────── */}
        {battles.length > 0 && (
          <section className="mt-8">
            <h3 className="mb-3 text-[10px] uppercase tracking-wider text-slate-400">
              Recent fights
            </h3>
            <ul className="flex flex-col gap-2">
              {battles.slice(0, 8).map((battle) => (
                <li
                  key={battle.id}
                  className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-slate-300"
                >
                  <span>
                    {battle.challenger_id === challenger.id
                      ? `${challenger.name} challenged`
                      : `${challenger.name} was challenged`}
                  </span>
                  <span className={battle.winner_id === challenger.id ? 'text-emerald-300' : 'text-red-300'}>
                    {battle.winner_id === challenger.id ? 'win' : 'loss'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
```

```tsx
// ═══════════════════════════════════════════════════════════════════════════
//  components/CharacterCard.tsx
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { motion } from 'framer-motion';
import { xpProgressClient, type Character } from '@/lib/types';

const MOOD_DOT: Record<string, string> = {
  curious: 'bg-sky-400',
  playful: 'bg-emerald-400',
  smug: 'bg-violet-400',
  tender: 'bg-rose-400',
  inspired: 'bg-amber-400',
  fierce: 'bg-orange-400',
  furious: 'bg-red-400',
  melancholic: 'bg-slate-400',
  determined: 'bg-lime-400',
};

interface CharacterCardProps {
  character: Character;
  selected: boolean;
  onSelect: () => void;
}

export default function CharacterCard({ character, selected, onSelect }: CharacterCardProps) {
  const progress = xpProgressClient(character.xp);
  const dot = MOOD_DOT[character.mood] ?? MOOD_DOT.curious;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
        selected
          ? 'border-violet-400/40 bg-violet-500/10'
          : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.05]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="truncate text-sm font-medium text-slate-100">{character.name}</span>
        </div>
        <span className="shrink-0 text-[10px] text-slate-400">Lv {progress.level}</span>
      </div>

      <p className="mt-1 truncate text-[11px] text-slate-500">
        {character.archetype} · {character.mood} · {character.energy}% energy
      </p>

      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-violet-400 to-orange-400"
          initial={false}
          animate={{ width: `${progress.pct}%` }}
          transition={{ type: 'spring', stiffness: 140, damping: 22 }}
        />
      </div>
    </button>
  );
}
```

```tsx
// ═══════════════════════════════════════════════════════════════════════════
//  components/AuthPanel.tsx  —  email magic-link sign-in
//  Also works unchanged if you enable GitHub/Google in Supabase Auth; the
//  redirect lands on /auth/callback either way.
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, Mail, Sparkles } from 'lucide-react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

interface AuthPanelProps {
  onAuthenticated: () => void;
}

export default function AuthPanel({ onAuthenticated }: AuthPanelProps) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supabase = createSupabaseBrowserClient();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.includes('@')) {
      setError('That does not look like an email address.');
      return;
    }

    setBusy(true);
    setError(null);

    const siteUrl =
      typeof window !== 'undefined' ? window.location.origin : process.env.NEXT_PUBLIC_SITE_URL!;

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${siteUrl}/auth/callback` },
    });

    setBusy(false);

    if (otpError) {
      setError(otpError.message);
      return;
    }
    setSent(true);
  };

  return (
    <div className="grid flex-1 place-items-center py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="panel w-full max-w-md p-7"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-500/20 text-violet-300 ring-1 ring-violet-400/30">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-100">Enter the forge</h2>
            <p className="text-xs text-slate-400">
              Characters persist across sessions, and so does everything they learn about you.
            </p>
          </div>
        </div>

        {sent ? (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-4 text-sm text-emerald-200">
            Check <span className="font-medium">{email}</span> for a sign-in link.
            <button
              type="button"
              onClick={() => { setSent(false); void onAuthenticated(); }}
              className="mt-3 block text-xs text-emerald-300 underline underline-offset-2"
            >
              I have already confirmed — reload
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-slate-400">Email</span>
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 focus-within:border-violet-400/40">
                <Mail className="h-4 w-4 shrink-0 text-slate-500" />
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full bg-transparent py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                />
              </div>
            </label>

            {error && <p className="text-xs text-red-300">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-400 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {busy ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        )}
      </motion.div>
    </div>
  );
}
```