-- Cagematch: written permission received from Philip (Cagematch) on 2026-10-02.
-- Terms: non-commercial use only; read the HTML pages as described (gentle bot, descriptive User-Agent,
-- about one request every 5+ seconds, a few dozen per day). The site uses a Sucuri firewall that may
-- rate-limit an overzealous bot, so the runner pauses Cagematch for 24 hours at the first sign of blocking.
INSERT OR REPLACE INTO config(key, value) VALUES
  ('cagematch_permission_confirmed', 'true'),
  ('cagematch_permission_note', 'Written permission from Philip (Cagematch), received 2026-10-02: non-commercial use, read HTML pages, stay gentle (Sucuri firewall).'),
  ('source.cagematch.enabled', 'true'),
  -- With Cagematch on, it supplies all show results (weekly TV and events). Wikipedia keeps checking
  -- championship holders but no longer adds events, so shows are never counted twice.
  ('source.wikipedia.events', 'false'),
  ('cagematch.daily_budget', '40'),
  ('cagematch.min_gap_ms', '6000'),
  ('cagematch.recheck_days', '2'),
  -- Promotions to follow. "match" is checked against the promotion name Cagematch shows (it decides);
  -- "nr" is only used when a page shows no name. Verify both against the first capture run.
  ('cagematch.promotions', '[{"code":"WWE","nr":1,"match":"^(World Wrestling Entertainment|WWE)\\b"},{"code":"AEW","nr":2287,"match":"All Elite Wrestling|^AEW\\b"},{"code":"TNA","nr":5,"match":"Total Nonstop Action|^TNA\\b|Impact Wrestling"}]');
