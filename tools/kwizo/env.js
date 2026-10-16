// Environment of the demo backend (no real OAuth apps behind these values).
module.exports = {
  JWT_ACCESS_SECRET: 'kwizo-demo-access-secret',
  JWT_REFRESH_SECRET: 'kwizo-demo-refresh-secret',
  DATABASE_URL: 'postgresql://pglite/kwizo',
  BACK_URL: 'http://localhost',
  GOOGLE_CLIENT_ID: 'demo', GOOGLE_CLIENT_SECRET: 'demo', GOOGLE_CALLBACK_URL: 'http://localhost/api/oauth/google/callback',
  GITHUB_CLIENT_ID: 'demo', GITHUB_CLIENT_SECRET: 'demo', GITHUB_CALLBACK_URL: 'http://localhost/api/oauth/github/callback',
  FORTY_TWO_CLIENT_ID: 'demo', FORTY_TWO_CLIENT_SECRET: 'demo', FORTY_TWO_CALLBACK_URL: 'http://localhost/api/oauth/42/callback',
};
