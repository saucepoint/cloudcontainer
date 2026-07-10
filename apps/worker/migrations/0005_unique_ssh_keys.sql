-- Public-key registration is idempotent per account. Keep the oldest label and
-- timestamp if historical races inserted the same key more than once.
DELETE FROM ssh_keys
WHERE id NOT IN (
  SELECT MIN(id)
  FROM ssh_keys
  GROUP BY user_id, pubkey
);

CREATE UNIQUE INDEX idx_ssh_keys_user_pubkey ON ssh_keys(user_id, pubkey);
