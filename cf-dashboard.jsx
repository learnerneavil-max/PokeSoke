```tsx
// ═══════════════════════════════════════════════════════════════════════════
//  app/page.tsx  —  the main dashboard
//
//  Architecture note: this is deliberately a CLIENT component. The dashboard is
//  a stateful cockpit — the selected character drives the chat panel, a finished
//  battle mutates three other panels, and Realtime pushes updates in. Server-
//  rendering that state graph would mean either prop-drilling server data into
//  client state anyway, or forcing a full `router.refresh()` after every
//  message, which would tear down the streaming response mid-flight.
//
//  So: one fetch to /api/bootstrap on mount, then Realtime keeps it honest.
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, RefreshCw, Shield, Swords, Zap } from 'lucide-react';
import AIChat from '@/components/AIChat';
import AuthPanel from '@/components/AuthPanel';
import BattleArena from '@/components/BattleArena';
import CharacterCard from '@/components/CharacterCard';
import CharacterCreator from '@/components/CharacterCreator';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import type { Battle, BattleOutcome, BootstrapPayload, Character, Profile } from '@/lib/types';

type Tab = 'chat' | 'arena';

export default function DashboardPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [opponents, setOpponents] = useState<Character[]>([]);
  const [battles, setBattles] = useState<Battle[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  // Realtime handlers are registered once, so they must not close over stale
  // state. A ref gives them a live pointer instead of a frozen snapshot.
  const charactersRef = useRef<Character[]>([]);
  charactersRef.current = characters;

  // ── Initial hydrate ───────────────────────────────────────────────────
  const bootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/bootstrap', { cache: 'no-store' });
      if (!response.ok) throw new Error(`bootstrap ${response.status}`);

      const data = (await response.json()) as BootstrapPayload;
      setProfile(data.profile);
      setCharacters(data.characters);
      setOpponents(data.opponents);
      setBattles(data.battles);

      setSelectedId((current) => {
        if (current && data.characters.some((c) => c.id === current)) return current;
        return data.characters[0]?.id ?? null;
      });
    } catch (error) {
      console.error('[dashboard] bootstrap failed', error);
      setNotice('Could not load your roster. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  // ── Realtime: battle results + live character stat changes ─────────────
  useEffect(() => {
    if (!profile) return;

    const channel = supabase
      .channel(`battle:${profile.id}`, { config: { private: true } })
      // Server-published broadcast (HTTP, from /api/battle).
      .on('broadcast', { event: 'battle.resolved' }, ({ payload }) => {
        const incoming = payload as { battleId: string; winnerId: string };

        setBattles((previous) =>
          previous.some((b) => b.id === incoming.battleId)
            ? previous
            : [{ id: incoming.battleId, winner_id: incoming.winnerId } as Battle, ...previous].slice(0, 20),
        );

        setNotice('A battle just resolved. Check the arena log.');
        // Pull the authoritative rows rather than reconstructing them locally.
        void refreshCharacters();
      })
      // Postgres Changes on the characters table: XP, level and mood updates
      // from the chat route's background work land here without a refetch.
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'characters' },
        ({ new: row }) => {
          const updated = row as Character;
          const isMine = charactersRef.current.some((c) => c.id === updated.id);
          if (!isMine) return;

          setCharacters((previous) =>
            previous.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
          );
        })
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, [profile, supabase]);

  const refreshCharacters = useCallback(async () => {
    try {
      const response = await fetch('/api/characters', { cache: 'no-store' });
      if (!response.ok) return;
      const data = (await response.json()) as { characters: Character[]; opponents: Character[] };
      setCharacters(data.characters);
      setOpponents(data.opponents);
    } catch (error) {
      console.error('[dashboard] character refresh failed', error);
    }
  }, []);

  // ── Mutations ─────────────────────────────────────────────────────────
  const handleCreate = useCallback(async (brief: string, name: string) => {
    setCreating(true);
    setNotice(null);
    try {
      const response = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, name: name || undefined }),
      });
      const data = (await response.json()) as { character?: Character; error?: string };

      if (!response.ok || !data.character) {
        setNotice(data.error ?? 'The forge refused that one.');
        return;
      }

      setCharacters((previous) => [...previous, data.character as Character]);
      setSelectedId(data.character.id);
      setTab('chat');
      setNotice(`${data.character.name} has been summoned.`);
    } catch (error) {
      console.error('[dashboard] create failed', error);
      setNotice('Network problem while forging that character.');
    } finally {
      setCreating(false);
    }
  }, []);

  const applyBattleOutcome = useCallback((outcome: BattleOutcome) => {
    setBattles((previous) => [outcome.battle, ...previous].slice(0, 20));

    setCharacters((previous) =>
      previous.map((c) => {
        if (c.id === outcome.challenger.id) return outcome.challenger;
        if (c.id === outcome.defender.id) return outcome.defender;
        return c;
      }),
    );

    const levelUp = outcome.levelUps[0];
    if (levelUp) {
      setNotice(`${levelUp.name} reached level ${levelUp.to}.`);
    }
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setCharacters([]);
    setOpponents([]);
    setBattles([]);
    setSelectedId(null);
  }, [supabase]);

  const selected = characters.find((c) => c.id === selectedId) ?? null;
  const record = profile ? `${profile.wins}W – ${profile.losses}L` : '—';

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-violet-500/20 text-violet-300 ring-1 ring-violet-400/30">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">CharForge</h1>
            <p className="text-xs text-slate-400">
              Summon a character. Talk to it. Send it into the arena.
            </p>
          </div>
        </div>

        {profile && (
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-4 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs sm:flex">
              <span className="text-slate-400">Record</span>
              <span className="font-medium text-slate-100">{record}</span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-400">Coins</span>
              <span className="font-medium text-amber-300">{profile.coins}</span>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-white/20 hover:text-white"
            >
              Sign out
            </button>
          </div>
        )}
      </header>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="panel px-4 py-3 text-sm text-slate-200"
          >
            <div className="flex items-center justify-between gap-4">
              <span>{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="text-xs text-slate-400 hover:text-white"
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <div className="grid flex-1 place-items-center py-24">
          <div className="flex items-center gap-3 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Waking the forge…</span>
          </div>
        </div>
      ) : !profile ? (
        <AuthPanel onAuthenticated={bootstrap} />
      ) : (
        <div className="grid flex-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* ── Left rail: roster + creator ────────────────────────────── */}
          <aside className="flex flex-col gap-4">
            <div className="panel p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-200">Your roster</h2>
                <button
                  type="button"
                  onClick={() => void refreshCharacters()}
                  className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
                  aria-label="Refresh roster"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>

              {characters.length === 0 ? (
                <p className="text-xs text-slate-400">
                  No characters yet. Describe one below and the forge will build it.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {characters.map((character) => (
                    <li key={character.id}>
                      <CharacterCard
                        character={character}
                        selected={character.id === selectedId}
                        onSelect={() => { setSelectedId(character.id); setTab('chat'); }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <CharacterCreator busy={creating} onCreate={handleCreate} />
          </aside>

          {/* ── Right: chat / arena ────────────────────────────────────── */}
          <section className="flex min-h-[70vh] flex-col gap-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTab('chat')}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition ${
                  tab === 'chat'
                    ? 'bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30'
                    : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Shield className="h-4 w-4" /> Converse
              </button>
              <button
                type="button"
                onClick={() => setTab('arena')}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition ${
                  tab === 'arena'
                    ? 'bg-orange-500/20 text-orange-200 ring-1 ring-orange-400/30'
                    : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Swords className="h-4 w-4" /> Arena
              </button>
            </div>

            <div className="panel flex flex-1 flex-col overflow-hidden">
              {tab === 'chat' ? (
                selected ? (
                  <AIChat
                    key={selected.id}
                    character={selected}
                    onCharacterUpdate={(updated) =>
                      setCharacters((previous) =>
                        previous.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
                      )
                    }
                  />
                ) : (
                  <div className="grid flex-1 place-items-center p-10 text-center">
                    <p className="text-sm text-slate-400">
                      Forge a character first — then you can talk to it.
                    </p>
                  </div>
                )
              ) : selected ? (
                <BattleArena
                  key={selected.id}
                  challenger={selected}
                  opponents={opponents}
                  battles={battles}
                  onResolved={applyBattleOutcome}
                />
              ) : (
                <div className="grid flex-1 place-items-center p-10 text-center">
                  <p className="text-sm text-slate-400">
                    Select a fighter from your roster to enter the arena.
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
```