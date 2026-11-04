// EventBridge Scheduler (every 15 min) -> Lambda: enforces expiry right on time, since DynamoDB TTL
// can take hours, and cleans uploads that never finished.
import { getService, metric } from './shared.js';

export async function handler() {
  const removed = await getService().sweep();
  metric('FilesSwept', removed);
  return { removed };
}
