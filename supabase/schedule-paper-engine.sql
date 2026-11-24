-- Run once as the project administrator, after enabling Cron and pg_net.
do $setup$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'paper_engine_cron_url'
      and decrypted_secret ~ '^https://[a-zA-Z0-9.-]+/api/cron/paper-engine$'
  ) or not exists (
    select 1 from vault.secrets where name = 'paper_engine_cron_secret'
  ) then
    raise exception 'Set the HTTPS paper_engine_cron_url and paper_engine_cron_secret in Vault first';
  end if;
end;
$setup$;

select cron.schedule('paper-engine-vercel', '* * * * *', $job$
  select net.http_post(
    url := endpoint.decrypted_secret,
    headers := jsonb_build_object('Authorization', 'Bearer ' || token.decrypted_secret),
    timeout_milliseconds := 65000
  )
  from vault.decrypted_secrets endpoint
  cross join vault.decrypted_secrets token
  where endpoint.name = 'paper_engine_cron_url'
    and endpoint.decrypted_secret ~ '^https://[a-zA-Z0-9.-]+/api/cron/paper-engine$'
    and token.name = 'paper_engine_cron_secret'
    and token.decrypted_secret <> '';
$job$);
