-- Preserve only a one-way hash of the client recovery secret after a trip
-- reaches a terminal state. This lets response-lost retries return the
-- original receipt without retaining the active-trip credential.
ALTER TABLE `trips` ADD COLUMN `idempotency_key_hash` text;
