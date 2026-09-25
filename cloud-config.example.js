// Copy/rename to cloud-config.js only when the Supabase project exists.
// The anon/publishable key is a browser credential; security MUST rely on RLS.
export const CLOUD_CONFIG = {
  enabled: false,
  provider: 'supabase',
  url: '',
  anonKey: ''
};
