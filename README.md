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
