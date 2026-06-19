# Toolbox

A personal utilities website. Each utility can save its configuration to your
user account, backed by Supabase (auth + Postgres).

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (or reuse one).
2. **Run the schema**: open the SQL Editor in the Supabase dashboard and run
   [supabase/schema.sql](supabase/schema.sql). This creates the `utility_configs`
   table with Row Level Security so users can only access their own configs.
3. **Configure credentials**: copy `.env.example` to `.env` and fill in your
   project URL and anon/publishable key (Dashboard → Project Settings → API).
4. **Email confirmation (optional)**: by default Supabase requires users to
   confirm their email before logging in. Toggle this under
   Authentication → Providers → Email → "Confirm email".

```sh
npm install
npm run dev
```

### Edge functions

Five utilities call Supabase edge functions (in [supabase/functions/](supabase/functions/)).
Deploy them with the Supabase CLI:

```sh
npx supabase functions deploy cors-proxy     # Shortest Route shared-list import
npx supabase functions deploy soccer         # Soccer Predictor fixtures + win %
npx supabase functions deploy alphavantage   # Stock Tracker (free provider)
npx supabase functions deploy fmp            # Stock Tracker (free provider)
npx supabase functions deploy morningstar    # Stock Tracker (paid provider)
```

The Stock Tracker has three interchangeable data providers, picked per user in
the utility. The functions need no secrets — each user brings their own key,
saved to their account config (RLS-protected) and forwarded to the function per
request. Each function normalizes responses to the same shapes, so the UI is
provider-agnostic.

- **`alphavantage` (free, default)** — backed by [Alpha Vantage](https://www.alphavantage.co/support/#api-key).
  A free key (no card, ≈25 requests/day, 1/sec) covers search, daily/weekly price
  history and ETF holdings (with a sector breakdown). Holdings come from the ETF
  profile and cover US funds/ETFs. The client throttles and caches calls to stay
  under the daily cap.
- **`fmp` (free)** — backed by
  [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs).
  A free key (no card, ≈250 requests/day, no per-second limit) covers search and
  EOD price history — more headroom than Alpha Vantage. FMP gates ETF/fund
  holdings behind a paid plan, so when FMP is selected the UI sources holdings
  from Alpha Vantage instead (requires a free Alpha Vantage key).
- **`morningstar` (paid)** — backed by
  [Morningstar Direct Web Services](https://developer.morningstar.com/direct-web-services/documentation/documentation/get-started/authentication).
  The user enters their API username/password; the function exchanges them for a
  short-lived (60-minute) MaaS bearer token server-side and caches it for its
  lifetime. Direct Web Services is a paid, entitled product — the securities,
  holdings view and data points available depend on the account's entitlement.

The `soccer` function needs no secrets — each user enters their own
[football-data.org](https://www.football-data.org/client/register) API token in
the utility, which is saved to their account config (RLS-protected) and
forwarded to the function per request. The free tier covers 12 major
competitions for the current season (10 requests/minute, no daily cap); it does
not include line-ups, so the win % and predicted scoreline are built from recent
goals and head-to-head only.

## How passwords are stored

Authentication is handled entirely by Supabase Auth. Passwords are hashed with
bcrypt before storage — they are never saved or transmitted in plain text, and
they never touch this app's database tables.

## Adding a new utility

1. Create a folder under `src/utilities/<your-utility>/` with a React component.
2. Register it in [src/utilities/index.ts](src/utilities/index.ts):

   ```ts
   registerUtility({
     id: 'my-utility',          // stable id — config storage key
     name: 'My Utility',
     description: 'What it does.',
     icon: '⚙️',
     component: MyUtility,
   })
   ```

That's it — routing (`/tools/my-utility`), the sidebar entry and the home-page
card are generated from the registry.

### Saving user config

Inside your component, use the `useUtilityConfig` hook with your utility id and
default values. Updates are debounced and upserted to the user's account:

```tsx
const { config, setConfig, loading, saving } = useUtilityConfig('my-utility', {
  favoriteFormat: 'json',
})

// later:
setConfig({ favoriteFormat: 'yaml' })
```

See [src/utilities/text-case/TextCaseConverter.tsx](src/utilities/text-case/TextCaseConverter.tsx)
for a complete example.
