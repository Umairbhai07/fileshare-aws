// S3 ObjectCreated -> SQS (with DLQ) -> Lambda: marks uploads ready and records the real size.
import { getService, metric } from './shared.js';

export async function handler(event) {
  const service = getService();
  const batchItemFailures = [];
  for (const record of event.Records || []) {
    try {
      const s3Event = JSON.parse(record.body);
      if (s3Event.Event === 's3:TestEvent') continue;
      for (const r of s3Event.Records || []) {
        const key = decodeURIComponent(r.s3.object.key.replace(/\+/g, ' '));
        const result = await service.onObjectCreated(key, r.s3.object.size);
        if (result.status === 'ready') {
          metric('FilesUploaded', 1);
          metric('BytesUploaded', result.size, 'Bytes');
        }
      }
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', messageId: record.messageId, message: err.message }));
      // Partial batch response: only failed messages are retried (and land in the DLQ after 3 tries).
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
