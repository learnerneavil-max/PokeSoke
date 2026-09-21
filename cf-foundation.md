# CharForge — Vercel & GitHub Foundation

An AI character social game: users summon persistent AI companions (traits, XP, levels, moods), chat with them via streaming LLM inference, and throw them into server-authoritative PvP arena battles.

## 1. Directory structure

```
charforge/
├─ .env.example                 # copy → Vercel Dashboard env vars
├─ .gitignore
├─ .nvmrc                       # 20
├─ README.md
├─ middleware.ts                # Supabase session refresh (edge)
├─ next.config.ts
├─ package.json
├─ postcss.config.mjs           # Tailwind v4
├─ tsconfig.json
├─ app/
│  ├─ globals.css
│  ├─ layout.tsx
│  ├─ page.tsx                  # ← main dashboard (client island)
│  ├─ auth/
│  │  └─ callback/route.ts      # OAuth / magic-link PKCE exchange
│  └─ api/
│     ├─ bootstrap/route.ts     # GET one-shot hydrate for the dashboard
│     ├─ characters/route.ts    # GET roster · POST AI-generated character
│     ├─ chat/route.ts          # ← edge runtime, SSE token stream + memory extraction
│     └─ battle/route.ts        # ← edge runtime, combat engine + Realtime broadcast
├─ components/
│  ├─ AIChat.tsx                # ← streaming chat surface
│  ├─ AuthPanel.tsx
│  ├─ BattleArena.tsx
│  ├─ CharacterCard.tsx
│  └─ CharacterCreator.tsx
├─ lib/
│  ├─ types.ts                  # domain types + Database schema type for supabase-js
│  ├─ ai/
│  │  ├─ prompts.ts             # persona compiler, mood heuristics, extraction prompt
│  │  └─ memory.ts              # "Learned Memories" extractor
│  ├─ game/
│  │  └─ engine.ts              # deterministic seeded combat engine
│  └─ supabase/
│     ├─ client.ts              # browser (singleton)
│     └─ server.ts              # SSR client + token-scoped + secret-key clients
├─ public/favicon.ico
└─ supabase/
   ├─ config.toml
   └─ migrations/0001_init.sql  # schema + RLS + RPCs + Realtime
```

## 2. `package.json`

```json
{
  "name": "charforge",
  "version": "1.0.0",
  "private": true,
  "engines": { "node": ">=20.11.0" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@supabase/ssr": "^0.6.0",
    "@supabase/supabase-js": "^2.58.0",
    "framer-motion": "^12.0.0",
    "lucide-react": "^0.475.0",
    "next": "^15.5.0",
    "openai": "^5.0.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.1.0",
    "@types/node": "^22.10.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "tailwindcss": "^4.1.0",
    "typescript": "^5.7.0"
  }
}
```

> **Version hygiene:** caret ranges are a starting point. To bind to whatever is actually latest on the registry today, run this once and let npm rewrite the lockfile:
> ```bash
> npm i next@latest react@latest react-dom@latest @supabase/ssr@latest \
>       @supabase/supabase-js@latest openai@latest framer-motion@latest lucide-react@latest
> npm i -D tailwindcss@latest @tailwindcss/postcss@latest typescript@latest @types/react@latest
> ```

## 3. `.gitignore`

```gitignore
# dependencies
/node_modules
/.pnp
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/versions

# next.js / build output
/.next/
/out/
/build
next-env.d.ts
*.tsbuildinfo

# vercel
.vercel

# secrets — NEVER commit these
.env
.env.*
!.env.example

# supabase local dev
/supabase/.branches
/supabase/.temp

# misc
.DS_Store
*.pem
npm-debug.log*
yarn-debug.log*
yarn-error.log*
coverage
.idea
.vscode/*
!.vscode/extensions.json
```

The `.env` line matters most: `.env.*` is ignored but `.env.example` is re-included, so the template travels with the repo while the real values live only in the Vercel Dashboard and your local shell.

## 4. `.env.example`

```bash
# ── Supabase (Project Settings → API) ────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL="https://xxxxxxxxxxxxxxxx.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbGciOi..."
# Server-only. Used for privileged Realtime broadcasts and admin reads.
# Either the legacy service_role JWT or a new sb_secret_... key works.
SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOi..."

# ── OpenAI ───────────────────────────────────────────────────────────
OPENAI_API_KEY="sk-proj-..."

# ── App ──────────────────────────────────────────────────────────────
# Local: http://localhost:3000. Production: your Vercel domain.
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
```

Paste all five into **Vercel → Project → Settings → Environment Variables**, scoped to Production + Preview + Development. `NEXT_PUBLIC_*` values are inlined into the client bundle at build time; the other three are server-only and Vercel will not expose them.

## 5. `next.config.ts`

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Framer Motion needs no plugin or transpile step on Next 15 + React 19 —
  // it ships ESM and is tree-shaken from the client bundle automatically.
  // Lucide ships thousands of icon modules; this collapses them into one
  // barrel import so dev compiles and cold starts stay fast.
  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },

  images: {
    // remotePatterns replaces the old `domains` array (removed in Next 15).
    remotePatterns: [
      // Supabase Storage — where uploaded character portraits live.
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' },
      // OAuth profile pictures.
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      // Anything you generate character art on.
      { protocol: 'https', hostname: 'replicate.delivery' },
      { protocol: 'https', hostname: 'oaidalleapiprodscus.blob.core.windows.net' },
    ],
  },

  async headers() {
    return [
      {
        // Streaming routes must never be buffered by an intermediary CDN.
        source: '/api/chat',
        headers: [{ key: 'Cache-Control', value: 'no-store, no-transform' }],
      },
    ];
  },
};

export default nextConfig;
```

## 6. `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

## 7. `postcss.config.mjs`

```js
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
```

Tailwind v4 needs no `tailwind.config.js` — theme tokens live in `globals.css` under `@theme`.

## 8. `app/globals.css`

```css
@import "tailwindcss";

@theme {
  --color-void: #07070c;
  --color-ink: #0e0e18;
  --color-slate-line: #22223210;
  --color-neon: #7c5cff;
  --color-ember: #ff7a45;
  --color-mint: #35e0a1;
  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
}

@layer base {
  html,
  body {
    height: 100%;
  }

  body {
    background:
      radial-gradient(1100px 600px at 12% -10%, color-mix(in oklab, var(--color-neon) 22%, transparent), transparent 60%),
      radial-gradient(900px 520px at 92% 4%, color-mix(in oklab, var(--color-ember) 16%, transparent), transparent 62%),
      var(--color-void);
    background-attachment: fixed;
  }

  ::selection {
    background: color-mix(in oklab, var(--color-neon) 45%, transparent);
  }
}

@layer components {
  .panel {
    border-radius: 1rem;
    border: 1px solid rgb(255 255 255 / 0.08);
    background: rgb(14 14 24 / 0.72);
    backdrop-filter: blur(14px);
    box-shadow: 0 1px 0 0 rgb(255 255 255 / 0.04) inset, 0 24px 60px -30px rgb(0 0 0 / 0.9);
  }

  .scroll-thin {
    scrollbar-width: thin;
    scrollbar-color: rgb(255 255 255 / 0.16) transparent;
  }

  .scroll-thin::-webkit-scrollbar {
    width: 8px;
  }

  .scroll-thin::-webkit-scrollbar-thumb {
    background: rgb(255 255 255 / 0.16);
    border-radius: 999px;
  }
}
```

## 9. `app/layout.tsx`

```tsx
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'CharForge — Summon an AI character. Fight with it.',
  description:
    'Create AI companions with traits, XP, levels and moods. Chat with them, watch them remember, then send them into the arena.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
};

export const viewport: Viewport = {
  themeColor: '#07070c',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-full font-sans text-slate-100 antialiased">{children}</body>
    </html>
  );
}
```

## 10. GitHub → Vercel pipeline

```bash
# 1. scaffold locally
npx create-next-app@latest charforge --ts --app --tailwind --eslint --no-src-dir --import-alias "@/*"
cd charforge

# 2. drop in the files from this build, install pinned deps
npm install

# 3. verify locally before you ever touch Vercel
npm run typecheck && npm run build

# 4. first commit + push
git init -b main
git add .
git commit -m "feat: charforge — AI character social game"
gh repo create charforge --private --source=. --push   # or: git remote add origin ... && git push -u origin main
```

**Vercel import:** vercel.com → *Add New… → Project* → pick the `charforge` repo. Vercel detects Next.js automatically, so **leave Build Command and Output Directory at their defaults** (`next build` / `.next`) — that is exactly the "zero-config" contract. Add the five env vars from `.env.example`, then Deploy. Every subsequent `git push` to `main` is a production deploy; every PR gets an isolated preview URL.

**Post-deploy wiring (once):**

1. Run `supabase/migrations/0001_init.sql` in the Supabase SQL editor (or `supabase db push`).
2. Copy the production URL from Vercel and set `NEXT_PUBLIC_SITE_URL` to it, then redeploy.
3. In Supabase → *Authentication → URL Configuration*: set **Site URL** to the production domain and add redirect URLs `http://localhost:3000/auth/callback`, `https://charforge.vercel.app/auth/callback`, and `https://*-<your-team>.vercel.app/auth/callback` so preview deployments can complete OAuth.
4. Supabase → *Database → Replication* — the migration already adds `battles`, `messages`, `characters` to the `supabase_realtime` publication; confirm they are listed.

**Nothing in this project requires a `vercel.json`.** Runtime, region and duration behaviour are declared per-route through the framework (`export const runtime`, `export const maxDuration`), which is what keeps the pipeline config-free.