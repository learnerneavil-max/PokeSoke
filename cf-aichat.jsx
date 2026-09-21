```tsx
// ═══════════════════════════════════════════════════════════════════════════
//  components/AIChat.tsx
//
//  Drives the SSE stream from /api/chat. Two details are load-bearing:
//
//  1. `abortRef` — every in-flight request is abortable. Without it, switching
//     characters mid-generation leaves a reader open with a controller still
//     enqueuing into an unmounted component.
//  2. Assistant text is written into a *single* message object as it arrives,
//     so React re-renders one node instead of appending to an array on every
//     token.
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Brain, Loader2, Send, Sparkles, Square } from 'lucide-react';
import { MOODS, xpProgressClient, type Character, type Memory, type Message } from '@/lib/types';

interface AIChatProps {
  character: Character;
  onCharacterUpdate?: (character: Partial<Character> & { id: string }) => void;
}

/** Parses one SSE frame ("event: x\ndata: {...}") into its parts. */
function parseFrame(frame: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

const MOOD_STYLES: Record<string, string> = {
  curious: 'text-sky-300 ring-sky-400/30 bg-sky-500/10',
  playful: 'text-emerald-300 ring-emerald-400/30 bg-emerald-500/10',
  smug: 'text-violet-300 ring-violet-400/30 bg-violet-500/10',
  tender: 'text-rose-300 ring-rose-400/30 bg-rose-500/10',
  inspired: 'text-amber-300 ring-amber-400/30 bg-amber-500/10',
  fierce: 'text-orange-300 ring-orange-400/30 bg-orange-500/10',
  furious: 'text-red-300 ring-red-400/30 bg-red-500/10',
  melancholic: 'text-slate-300 ring-slate-400/30 bg-slate-500/10',
  determined: 'text-lime-300 ring-lime-400/30 bg-lime-500/10',
};

export default function AIChat({ character, onCharacterUpdate }: AIChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [hydrating, setHydrating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showMemories, setShowMemories] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const progress = xpProgressClient(character.xp);
  const moodStyle = MOOD_STYLES[character.mood] ?? MOOD_STYLES.curious;

  // ── Hydrate history for the selected character ────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setHydrating(true);
      setError(null);
      try {
        const response = await fetch(`/api/chat?characterId=${character.id}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`history ${response.status}`);

        const data = (await response.json()) as { messages: Message[]; memories: Memory[] };
        if (cancelled) return;

        setMessages(data.messages);
        setMemories(data.memories);
      } catch (cause) {
        if (!cancelled) {
          console.error('[AIChat] hydrate failed', cause);
          setError('Could not load the transcript.');
        }
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [character.id]);

  // Pin to the newest message, including while tokens arrive.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, streamText]);

  // ── Send ──────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const optimisticUserMessage: Message = {
      id: `local-user-${crypto.randomUUID()}`,
      character_id: character.id,
      owner_id: character.owner_id,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    };

    setMessages((previous) => [...previous, optimisticUserMessage]);
    setInput('');
    setStreamText('');
    setStreaming(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: character.id, message: text }),
        signal: controller.signal,
      });

      // Non-streaming failure (401 / 429 / 400) comes back as JSON.
      if (!response.ok || !response.body) {
        const problem = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(problem.error ?? `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      let userMessageId = optimisticUserMessage.id;
      let assistantMessageId = `local-assistant-${crypto.randomUUID()}`;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. The final element may be an
        // incomplete frame — hold it back until more bytes arrive.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const parsed = parseFrame(frame);
          if (!parsed) continue;

          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(parsed.data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (parsed.event === 'meta') {
            userMessageId = String(payload.userMessageId ?? userMessageId);
            assistantMessageId = String(payload.assistantMessageId ?? assistantMessageId);

            // Swap the optimistic row for the real server id so later refetches
            // and Realtime messages de-duplicate correctly.
            setMessages((previous) =>
              previous.map((m) => (m.id === optimisticUserMessage.id ? { ...m, id: userMessageId } : m)),
            );
          } else if (parsed.event === 'delta') {
            assistantText += String(payload.t ?? '');
            setStreamText(assistantText);
          } else if (parsed.event === 'error') {
            throw new Error(String(payload.message ?? 'The stream failed.'));
          }
        }
      }

      // Promote the streamed text into a real message node.
      if (assistantText.trim().length > 0) {
        setMessages((previous) => [
          ...previous,
          {
            id: assistantMessageId,
            character_id: character.id,
            owner_id: character.owner_id,
            role: 'assistant',
            content: assistantText,
            created_at: new Date().toISOString(),
          },
        ]);

        // The background pass also moved XP and possibly the mood. Mirror it
        // optimistically; the postgres_changes subscription confirms it.
        const nextXp = character.xp + 6 + Math.min(6, Math.floor(text.length / 160));
        onCharacterUpdate?.({ id: character.id, xp: nextXp });
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        // User-initiated stop or character switch. Whatever text arrived is kept
        // by the server's after() block, so nothing is lost.
      } else {
        const message = cause instanceof Error ? cause.message : 'Something went wrong.';
        setError(message);
        // Drop the optimistic user row so the transcript does not show a message
        // the server never recorded.
        setMessages((previous) => previous.filter((m) => m.id !== optimisticUserMessage.id));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setStreamText('');
    }
  }, [character, input, onCharacterUpdate, streaming]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-3">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold ring-1 ring-white/15"
            style={{ background: 'linear-gradient(135deg, rgba(124,92,255,.35), rgba(255,122,69,.28))' }}
          >
            {character.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-slate-100">{character.name}</h2>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ${moodStyle}`}>
                {character.mood}
              </span>
            </div>
            <p className="truncate text-xs text-slate-400">
              Lv {progress.level} · {character.archetype} · {character.tagline ?? 'no known past'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden w-40 sm:block">
            <div className="mb-1 flex justify-between text-[10px] text-slate-400">
              <span>XP {character.xp}</span>
              <span>Next {progress.nextLevelAt}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-violet-400 to-orange-400"
                animate={{ width: `${progress.pct}%` }}
                transition={{ type: 'spring', stiffness: 120, damping: 20 }}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowMemories((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/20 hover:text-white"
          >
            <Brain className="h-3.5 w-3.5" />
            {memories.length}
          </button>
        </div>
      </header>

      {/* ── Memory drawer ──────────────────────────────────────────── */}
      <AnimatePresence>
        {showMemories && (
          <motion.aside
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-white/10 bg-white/[0.03]"
          >
            <div className="max-h-44 overflow-y-auto px-5 py-4 scroll-thin">
              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                <Sparkles className="h-3 w-3" /> Learned memories
              </p>
              {memories.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Nothing yet. Tell {character.name} something about yourself.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {memories.map((memory) => (
                    <li key={memory.id} className="flex items-start gap-2 text-xs text-slate-300">
                      <span className="mt-0.5 shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">
                        {memory.kind} · {memory.importance}
                      </span>
                      <span>{memory.content}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ── Transcript ─────────────────────────────────────────────── */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 scroll-thin">
        {hydrating ? (
          <div className="flex h-full items-center justify-center gap-2 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-xs">Loading history…</span>
          </div>
        ) : messages.length === 0 && !streaming ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-sm">
              <p className="text-sm text-slate-300">
                {character.name} is watching you, waiting for you to say something first.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Mention your name, your work, or something you love — {character.name} will remember it.
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {messages.map((message) => (
              <li
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    message.role === 'user'
                      ? 'bg-violet-500/20 text-violet-50 ring-1 ring-violet-400/25'
                      : 'bg-white/[0.06] text-slate-100 ring-1 ring-white/10'
                  }`}
                >
                  {message.content}
                </div>
              </li>
            ))}

            {/* Live streaming bubble */}
            {streaming && (
              <li className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl bg-white/[0.06] px-4 py-2.5 text-sm leading-relaxed text-slate-100 ring-1 ring-white/10">
                  {streamText || (
                    <span className="inline-flex items-center gap-2 text-slate-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {character.name} is thinking…
                    </span>
                  )}
                  {streamText && (
                    <motion.span
                      className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-violet-400"
                      animate={{ opacity: [1, 0.15, 1] }}
                      transition={{ duration: 1, repeat: Infinity }}
                    />
                  )}
                </div>
              </li>
            )}
          </ul>
        )}
      </div>

      {/* ── Error ──────────────────────────────────────────────────── */}
      {error && (
        <div className="border-t border-red-500/20 bg-red-500/5 px-5 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* ── Composer ───────────────────────────────────────────────── */}
      <form
        onSubmit={(event) => { event.preventDefault(); void send(); }}
        className="border-t border-white/10 px-4 py-4"
      >
        <div className="flex items-end gap-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={4000}
            placeholder={`Say something to ${character.name}…`}
            disabled={streaming}
            className="max-h-32 min-h-[44px] flex-1 resize-y rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-violet-400/40 disabled:opacity-50"
          />

          {streaming ? (
            <button
              type="button"
              onClick={stop}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-white/15 text-slate-300 transition hover:border-white/30 hover:text-white"
              aria-label="Stop generating"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={input.trim().length === 0}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-violet-500 text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mt-2 text-[10px] text-slate-500">
          Enter to send · Shift+Enter for a new line
        </p>
      </form>
    </div>
  );
}