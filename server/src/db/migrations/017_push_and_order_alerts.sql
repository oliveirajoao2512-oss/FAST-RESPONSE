-- Phone/tablet notifications (Web Push) and the reminders of orders nobody accepted.

CREATE TABLE push_subscriptions (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  device text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  failures integer NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- how far the reminder of an order that is still waiting for acceptance went (0 none, 1 team + leaders, 2 managers)
ALTER TABLE work_orders ADD COLUMN alert_level smallint NOT NULL DEFAULT 0;
CREATE INDEX work_orders_waiting_idx ON work_orders (opened_at) WHERE status = 'aberta' AND first_accepted_at IS NULL;
