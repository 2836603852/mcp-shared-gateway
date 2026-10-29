// Advance only the gateway clock, leaving the test and shim clocks unchanged. This deterministically
// covers the expired-lease ordering after sleep/resume without changing the host clock or suspending it.
import fs from 'node:fs';
const now = Date.now;
Date.now = () => {
  let offset = 0;
  try { offset = Number(fs.readFileSync(process.env.GW_TEST_CLOCK, 'utf8')) || 0; } catch {}
  return now() + offset;
};
