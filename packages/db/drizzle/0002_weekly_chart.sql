CREATE MATERIALIZED VIEW "weekly_chart" AS
SELECT
  r."id" AS "request_id",
  r."title",
  r."artist",
  r."artwork_url",
  r."user_id",
  r."played_at",
  count(v."user_id")::int AS "votes"
FROM "requests" r
LEFT JOIN "votes" v ON v."request_id" = r."id"
WHERE r."played_at" > now() - interval '7 days'
GROUP BY r."id"
ORDER BY "votes" DESC, r."played_at" DESC
LIMIT 100;
--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_chart_request_idx" ON "weekly_chart" ("request_id");
