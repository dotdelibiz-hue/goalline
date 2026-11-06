CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  hook_key TEXT NOT NULL UNIQUE,
  line_secret TEXT,
  line_token TEXT,
  friend_url TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE scenarios (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  plan JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  rich_menu_id TEXT,
  created_at BIGINT NOT NULL,
  published_at BIGINT
);
CREATE INDEX scenarios_account ON scenarios (account_id, status);
CREATE TABLE friends (
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  scenario_id BIGINT,
  joined_at BIGINT NOT NULL,
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  goal_at BIGINT,
  PRIMARY KEY (account_id, user_id)
);
CREATE TABLE tags (
  account_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (account_id, user_id, tag),
  FOREIGN KEY (account_id, user_id) REFERENCES friends(account_id, user_id) ON DELETE CASCADE
);
CREATE TABLE queue (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  scenario_id BIGINT NOT NULL,
  step_id TEXT NOT NULL,
  due_at BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'wait',
  done_at BIGINT,
  UNIQUE (account_id, user_id, scenario_id, step_id)
);
CREATE INDEX queue_due ON queue (state, due_at);
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scenario_id BIGINT,
  user_id TEXT,
  kind TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX events_scenario ON events (scenario_id, kind);
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  n INT NOT NULL,
  reset_at BIGINT NOT NULL
);
